// GEP Listener — subscribes to Overwolf's Game Events Provider for Overwatch
// (roster + match_info, which carries kill_feed/match_start/match_end) and
// normalizes the raw payloads into plain JS objects for the rest of the app.
//
// Usage: DejaVuGep.init({ onRoster, onMatchEvent, onMatchInfo, onGameDetected, onRaw })
// - onRoster(players, changed, rawInfo)  players: full current roster (merged);
//                                         changed: just the slot(s) this call touched
// - onMatchEvent(name, data, raw)  name: 'kill_feed' | 'match_start' | 'match_end' | ...
// - onMatchInfo(fields, rawInfo)   fields straight from the match_info info-update
//                                  category (map, match_outcome, etc.) — unparsed,
//                                  since we haven't yet confirmed real key names/casing
//                                  against a live match; log it and see.
// - onRaw(kind, payload)           optional firehose for debugging: kind is 'info' | 'event' | 'error'
// - onGameDetected()               fired each time Overwatch is (re)detected running
//                                   (game launch, or already running at background start)
// - onFeedStateChanged(failed)     true once this module has exhausted its own
//                                   recovery and the feed is dead, false again if
//                                   events later start arriving. Fired only on a
//                                   change, so it's safe to act on directly.

var DejaVuGep = (function () {
  var OVERWATCH_CLASS_ID = 10844;
  var REQUIRED_FEATURES = ['roster', 'match_info', 'kill_feed'];
  var MATCH_EVENT_NAMES = ['kill_feed', 'match_start', 'match_end', 'round_start', 'round_end', 'game_exit'];

  var handlers = {};
  var onErrorListener, onInfoUpdatesListener, onNewEventsListener;
  var registered = false;

  // Confirmed in testing (2026-09-05): setRequiredFeatures reporting success is
  // NOT proof the event feed is actually live. In a working session, the feed
  // only started flowing after an onGameInfoUpdated with reason
  // "gameRendererDetected" triggered a second unregister/register cycle; in a
  // broken session (Overwolf reloaded while already deep into a running game,
  // so the renderer was already detected and that transition never fired
  // again) setRequiredFeatures succeeded immediately but zero events arrived
  // for an entire live match. This watchdog detects that silently-dead state
  // and forces the same recovery cycle that fixed it by accident before.
  var eventWatchdogTimer = null;
  var eventWatchdogAttempts = 0;
  var WATCHDOG_INTERVAL_MS = 7000;
  var MAX_WATCHDOG_ATTEMPTS = 3;

  // Both known feed failures (§12, 2026-09-05 and 2026-09-06) looked identical
  // from the user's side: the overlay sat on "Waiting for players..." for a
  // whole session, which is exactly what it says before a normal match too. The
  // app knew perfectly well it had given up — it logged as much — it just never
  // told anyone, so a dead feed was indistinguishable from sitting in the menu.
  // feedFailed tracks that state so it can be reported once on the way in and
  // once on the way out, rather than on every callback.
  var feedFailed = false;

  function reportFeedState(failed) {
    if (feedFailed === failed) return;
    feedFailed = failed;
    if (handlers.onFeedStateChanged) handlers.onFeedStateChanged(failed);
  }

  function logDiag(line) {
    console.log('[DejaVuGep] ' + line);
    if (window.DejaVuFileLog) {
      DejaVuFileLog.log('[gep] ' + line);
      // GEP lifecycle lines are low-frequency but critical for diagnosing feed
      // dropouts, and were getting evicted from the main log by roster spam
      // during any real match — see file-logger.js. Duplicated into the
      // separate lifecycle file so they survive regardless of session length.
      DejaVuFileLog.logImportant('[gep] ' + line);
    }
  }

  // GEP only sends *changed* roster_N entries per onInfoUpdates2 call, not a full
  // snapshot each time — confirmed in testing (each call arrives with exactly one
  // player). Keyed by slot index and merged so consumers always get the complete,
  // up-to-date lobby rather than whichever single player just changed.
  var rosterBySlot = {};

  function classIdOf(gameId) {
    return Math.floor(gameId / 10);
  }

  function isOverwatch(gameInfo) {
    return !!gameInfo && !!gameInfo.isRunning && classIdOf(gameInfo.id) === OVERWATCH_CLASS_ID;
  }

  function resetRosterCache() {
    rosterBySlot = {};
  }

  function clearEventWatchdog() {
    if (eventWatchdogTimer) {
      window.clearTimeout(eventWatchdogTimer);
      eventWatchdogTimer = null;
    }
  }

  // Call on every actual GEP callback invocation — proves the feed is alive.
  function noteEventReceived() {
    if (eventWatchdogTimer) logDiag('GEP feed confirmed live — clearing recovery watchdog');
    clearEventWatchdog();
    eventWatchdogAttempts = 0;
    // A feed that starts flowing after we'd given up (typically because the
    // user restarted Overwatch, which is the documented workaround) should
    // clear the warning without needing anything else to happen.
    reportFeedState(false);
  }

  function armEventWatchdog() {
    clearEventWatchdog();
    eventWatchdogTimer = window.setTimeout(function () {
      eventWatchdogAttempts++;
      logDiag('no GEP events received ' + (WATCHDOG_INTERVAL_MS / 1000) +
        's after (re)registering (attempt ' + eventWatchdogAttempts + '/' + MAX_WATCHDOG_ATTEMPTS +
        ') — forcing unregister/register cycle to recover a possibly-stale feed');
      unregisterEvents();
      registerEvents();
      window.setTimeout(function () { setFeatures(); }, 1000);
      if (eventWatchdogAttempts < MAX_WATCHDOG_ATTEMPTS) {
        armEventWatchdog();
      } else {
        logDiag('giving up on GEP feed recovery after ' + MAX_WATCHDOG_ATTEMPTS +
          ' attempts — no events yet, which is normal outside a match');
        // Deliberately does NOT report a failed feed. Measured 2026-09-09
        // across every healthy session on record: GEP sends nothing at all
        // until a match actually starts, and the gap between registering and
        // the first event was 13, 19, 34 and 40 minutes. This watchdog gives up
        // after ~21 seconds, so "gave up" was true in 4 of 5 sessions that then
        // went on to deliver 2,000+ payloads each. Wiring a user-facing warning
        // to it made the app cry wolf in most normal sessions. The recovery
        // cycles themselves are cheap and invisible, so they stay; only the
        // verdict is wrong, and it is withdrawn.
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  // roster arrives as an object like { roster_0: '{"player_name":...}', roster_1: '...' },
  // each value a JSON-encoded string covering only the fields that changed for that
  // slot. Merge into the running cache; return both the full roster and just the
  // slot(s) this particular call touched (the latter is what's worth logging —
  // logging the full roster on every tick is what blew the debug log up to 12MB
  // for one long match).
  function mergeRosterUpdate(rosterCategory) {
    var changed = [];
    if (!rosterCategory) return { full: rosterValues(), changed: changed };
    Object.keys(rosterCategory).forEach(function (key) {
      var match = /^roster_(\d+)$/.exec(key);
      if (!match) return;
      var slot = match[1];
      try {
        var parsed = JSON.parse(rosterCategory[key]);
        rosterBySlot[slot] = Object.assign({}, rosterBySlot[slot], parsed);
        changed.push(rosterBySlot[slot]);
      } catch (e) {
        console.warn('[DejaVuGep] failed to parse roster entry', key, rosterCategory[key], e);
      }
    });
    return { full: rosterValues(), changed: changed };
  }

  function rosterValues() {
    return Object.keys(rosterBySlot)
      .sort(function (a, b) { return Number(a) - Number(b); })
      .map(function (slot) { return rosterBySlot[slot]; });
  }

  function handleInfoUpdate(info) {
    noteEventReceived();
    if (handlers.onRaw) handlers.onRaw('info', info);

    var body = info && (info.info || info);
    if (!body) return;

    if (body.roster && handlers.onRoster) {
      var result = mergeRosterUpdate(body.roster);
      handlers.onRoster(result.full, result.changed, info);
    }

    if (body.match_info && handlers.onMatchInfo) {
      handlers.onMatchInfo(body.match_info, info);
    }
  }

  function handleNewEvents(info) {
    noteEventReceived();
    if (handlers.onRaw) handlers.onRaw('event', info);

    var events = info && info.events;
    if (!events || !events.length) return;

    events.forEach(function (ev) {
      var data = ev.data;
      try {
        data = JSON.parse(ev.data);
      } catch (e) {
        // some events carry plain (non-JSON) string data — pass through as-is
      }
      if (ev.name === 'match_start') {
        resetRosterCache();
      }
      if (MATCH_EVENT_NAMES.indexOf(ev.name) !== -1 && handlers.onMatchEvent) {
        handlers.onMatchEvent(ev.name, data, ev);
      }
    });
  }

  function registerEvents() {
    if (registered) {
      logDiag('registerEvents skipped, already registered');
      return;
    }
    registered = true;
    resetRosterCache();
    logDiag('registerEvents: subscribing to GEP listeners');

    onErrorListener = function (info) {
      if (handlers.onRaw) handlers.onRaw('error', info);
      console.warn('[DejaVuGep] GEP error', info);
    };
    onInfoUpdatesListener = handleInfoUpdate;
    onNewEventsListener = handleNewEvents;

    overwolf.games.events.onError.addListener(onErrorListener);
    overwolf.games.events.onInfoUpdates2.addListener(onInfoUpdatesListener);
    overwolf.games.events.onNewEvents.addListener(onNewEventsListener);
  }

  function unregisterEvents() {
    clearEventWatchdog();
    if (!registered) return;
    registered = false;
    logDiag('unregisterEvents: game no longer running/detected');

    overwolf.games.events.onError.removeListener(onErrorListener);
    overwolf.games.events.onInfoUpdates2.removeListener(onInfoUpdatesListener);
    overwolf.games.events.onNewEvents.removeListener(onNewEventsListener);
  }

  // Confirmed 2026-09-06: every registerEvents cycle (including the
  // watchdog's own recovery attempts) starts a fresh 10-attempt setFeatures
  // retry chain, but never cancelled whichever chain was already running from
  // an earlier cycle — a real session's lifecycle log showed up to 3
  // independent chains ticking down in parallel, each hammering
  // setRequiredFeatures roughly every 2s, so combined the API was getting
  // called several times a second instead of the intended once/2s. A
  // generation token fixes it: only the most recently *started* chain (an
  // undefined-attemptsLeft call, i.e. one triggered by a real registration
  // event, not a recursive retry) is allowed to keep retrying — any older
  // chain's in-flight response is silently dropped once superseded.
  var setFeaturesGeneration = 0;

  function setFeatures(attemptsLeft, generation) {
    if (attemptsLeft === undefined) {
      attemptsLeft = 10;
      generation = ++setFeaturesGeneration;
    }
    overwolf.games.events.setRequiredFeatures(REQUIRED_FEATURES, function (info) {
      if (generation !== setFeaturesGeneration) return; // superseded by a newer registration cycle
      if (info.status === 'error') {
        logDiag('setRequiredFeatures error (attemptsLeft=' + attemptsLeft + '): ' + JSON.stringify(info));
        if (attemptsLeft <= 1) {
          logDiag('giving up on setRequiredFeatures');
          // The 2026-09-06 failure mode: setRequiredFeatures returned
          // "Provider is not ready." on every attempt of every cycle. Nothing
          // in this app can fix that, so the least it can do is say so.
          reportFeedState(true);
          return;
        }
        window.setTimeout(function () { setFeatures(attemptsLeft - 1, generation); }, 2000);
        return;
      }
      logDiag('setRequiredFeatures succeeded: ' + JSON.stringify(info));
    });
  }

  function init(customHandlers) {
    handlers = customHandlers || {};

    overwolf.games.onGameInfoUpdated.addListener(function (res) {
      // This fires constantly for minor stuff (focus, cursor visibility) — only
      // log when running/game state actually changed, and just a compact summary
      // even then, to avoid repeating the 12MB-log mistake now that the
      // diagnosis this was added for is done.
      if (res && (res.runningChanged || res.gameChanged)) {
        logDiag('onGameInfoUpdated: isRunning=' + (res.gameInfo && res.gameInfo.isRunning) +
          ' runningChanged=' + res.runningChanged + ' gameChanged=' + res.gameChanged +
          ' reason=' + JSON.stringify(res.reason));
      }

      var launchedIntoOverwatch =
        res && res.gameInfo && res.gameInfo.isRunning &&
        (res.runningChanged || res.gameChanged) &&
        isOverwatch(res.gameInfo);

      if (launchedIntoOverwatch) {
        unregisterEvents();
        registerEvents();
        eventWatchdogAttempts = 0;
        armEventWatchdog();
        if (handlers.onGameDetected) handlers.onGameDetected();
        window.setTimeout(function () { setFeatures(); }, 1000);
      } else if (res && res.gameInfo && !res.gameInfo.isRunning) {
        unregisterEvents();
      }
    });

    overwolf.games.getRunningGameInfo(function (res) {
      logDiag('getRunningGameInfo: ' + JSON.stringify(res));

      if (isOverwatch(res)) {
        registerEvents();
        eventWatchdogAttempts = 0;
        armEventWatchdog();
        if (handlers.onGameDetected) handlers.onGameDetected();
        window.setTimeout(function () { setFeatures(); }, 1000);
      }
    });
  }

  return { init: init };
})();
