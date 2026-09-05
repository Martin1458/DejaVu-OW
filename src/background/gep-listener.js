// GEP Listener — subscribes to Overwolf's Game Events Provider for Overwatch
// (roster + match_info, which carries kill_feed/match_start/match_end) and
// normalizes the raw payloads into plain JS objects for the rest of the app.
//
// Usage: DejaVuGep.init({ onRoster, onMatchEvent, onMatchInfo, onRaw })
// - onRoster(players, changed, rawInfo)  players: full current roster (merged);
//                                         changed: just the slot(s) this call touched
// - onMatchEvent(name, data, raw)  name: 'kill_feed' | 'match_start' | 'match_end' | ...
// - onMatchInfo(fields, rawInfo)   fields straight from the match_info info-update
//                                  category (map, match_outcome, etc.) — unparsed,
//                                  since we haven't yet confirmed real key names/casing
//                                  against a live match; log it and see.
// - onRaw(kind, payload)           optional firehose for debugging: kind is 'info' | 'event' | 'error'

var DejaVuGep = (function () {
  var OVERWATCH_CLASS_ID = 10844;
  var REQUIRED_FEATURES = ['roster', 'match_info', 'kill_feed'];
  var MATCH_EVENT_NAMES = ['kill_feed', 'match_start', 'match_end', 'round_start', 'round_end', 'game_exit'];

  var handlers = {};
  var onErrorListener, onInfoUpdatesListener, onNewEventsListener;
  var registered = false;

  function logDiag(line) {
    console.log('[DejaVuGep] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[gep] ' + line);
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
    if (!registered) return;
    registered = false;
    logDiag('unregisterEvents: game no longer running/detected');

    overwolf.games.events.onError.removeListener(onErrorListener);
    overwolf.games.events.onInfoUpdates2.removeListener(onInfoUpdatesListener);
    overwolf.games.events.onNewEvents.removeListener(onNewEventsListener);
  }

  function setFeatures(attemptsLeft) {
    if (attemptsLeft === undefined) attemptsLeft = 10;
    overwolf.games.events.setRequiredFeatures(REQUIRED_FEATURES, function (info) {
      if (info.status === 'error') {
        logDiag('setRequiredFeatures error (attemptsLeft=' + attemptsLeft + '): ' + JSON.stringify(info));
        if (attemptsLeft <= 1) {
          logDiag('giving up on setRequiredFeatures');
          return;
        }
        window.setTimeout(function () { setFeatures(attemptsLeft - 1); }, 2000);
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
        window.setTimeout(function () { setFeatures(); }, 1000);
      } else if (res && res.gameInfo && !res.gameInfo.isRunning) {
        unregisterEvents();
      }
    });

    overwolf.games.getRunningGameInfo(function (res) {
      logDiag('getRunningGameInfo: ' + JSON.stringify(res));

      if (isOverwatch(res)) {
        registerEvents();
        window.setTimeout(function () { setFeatures(); }, 1000);
      }
    });
  }

  return { init: init };
})();
