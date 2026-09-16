// Overlay Controller (see DEJAVU_OW_PLAN.md §6.1, §7) — owns the overlay
// window's lifecycle and keeps a table of every player seen this match, pushed
// to the overlay window as a whole on any change. Storage stays out of this
// file entirely — DejaVuMatchSession already looked up each player's prior
// record before this runs.

var DejaVuOverlayController = (function () {
  var OVERLAY_WINDOW = 'overlay';

  // The overlay window is up for the whole session now; what Alt+J changes is
  // whether it draws the table or shrinks to a badge. Collapsing mid-match
  // sticks until either you press it again or the next match starts
  // (resetMatch always expands, so a collapsed panel doesn't carry silently
  // into a match you'd want to see).
  var collapsed = true;

  var rowsByTag = {};      // battlenet_tag -> row currently shown for this match
  var lastMatchResult = null; // this match's own outcome, once resolved (or null)
  var feedFailed = false;  // GEP has given up; the panel says so instead of "waiting"

  function logDiag(line) {
    console.log('[DejaVuOverlayController] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[overlay] ' + line);
  }

  // Must match the overlay window's `size` in manifest.json. Duplicated on
  // purpose: the manifest value only ever seeds a brand-new window, so it is
  // not what an existing install is actually running at.
  //
  // Measured, not guessed (2026-09-06). The table's min-content width is 613px
  // and the panel adds 22px of padding/border, but width has to clear 660px for
  // a second reason that arithmetic on the table alone misses: below that the
  // name column squeezes the "203 matches ago, 12mo ago" and "Last time:
  // against you" sub-lines into wrapping, which pushes an 11-row 6v6 lobby from
  // 833px to 998px tall — too narrow overflows *vertically*.
  //
  // Widened again after the columns were given real breathing room: the "K/D
  // match", "K/D total" and "W/L against" headings were filling their cells to
  // within 0-1px, which is what read as the last column being clipped. Since
  // the table is width:100%, every extra pixel of window goes to the name
  // column rather than to the cramped ones, so those had to be widened in the
  // stylesheet as well as the window here.
  var OVERLAY_WIDTH = 800;
  var OVERLAY_HEIGHT = 950;

  // The badge's own shape. The window itself has to shrink and move, not just
  // its contents: an 800x950 window parked in the corner would put its
  // transparent area over the corner and draw the badge somewhere in the middle
  // of the screen.
  // 100 tall because that is Overwolf’s minimum window height, not because the
  // badge needs it — the badge is ~34 and sits pinned to the bottom-right
  // corner of this window (see body.collapsed in overlay.html). Asking for less
  // just makes ensureSize negotiate with a floor it cannot move.
  var COLLAPSED_WIDTH = 150;
  var COLLAPSED_HEIGHT = 100;

  // Where the table sits when expanded. Matches the manifest's start_position,
  // which only ever applies when the window is first created.
  var EXPANDED_LEFT = 20;
  var EXPANDED_TOP = 100;

  function showOverlay() {
    applyShape();
    DejaVuWindows.show(OVERLAY_WINDOW, function () {
      applyInputMode();
    });
  }

  // Size then position, in that order: placeBottomRight measures the window to
  // work out where its right edge should start, so it has to run after the
  // resize has actually landed. Both are enforced on every show rather than
  // once at startup — they no-op when nothing has changed, and a window
  // Overwolf recreated at a stale size or position gets corrected next time the
  // panel appears instead of staying wrong for the rest of the session.
  function applyShape() {
    var mode = collapsed ? 'collapsed' : 'expanded';
    // Once the window has been dragged, that position wins over the default
    // corner for good — otherwise the next toggle would snap it back and the
    // drag would look like it did nothing.
    var saved = DejaVuSettings.getOverlayPosition(mode);
    var width = collapsed ? COLLAPSED_WIDTH : OVERLAY_WIDTH;
    var height = collapsed ? COLLAPSED_HEIGHT : OVERLAY_HEIGHT;

    DejaVuWindows.ensureSize(OVERLAY_WINDOW, width, height, function () {
      if (saved) {
        DejaVuWindows.placeAt(OVERLAY_WINDOW, saved.left, saved.top);
      } else if (collapsed) {
        DejaVuWindows.placeBottomRight(OVERLAY_WINDOW);
      } else {
        DejaVuWindows.placeAt(OVERLAY_WINDOW, EXPANDED_LEFT, EXPANDED_TOP);
      }
    });
  }

  // Tells the window which of its two faces to draw. Sent on every change and
  // again on resync, so a window Overwolf recreated mid-session does not sit in
  // whatever state it loaded with.
  function sendDisplayMode() {
    overwolf.windows.sendMessage(OVERLAY_WINDOW, 'display-mode', {
      collapsed: collapsed,
      movable: DejaVuSettings.isOverlayMovable()
    }, function () {});
  }

  // Re-applied on every show rather than once: Overwolf can recreate the window
  // mid-session, and a recreated one comes back with the manifest's declared
  // clickthrough rather than whatever the user last chose.
  function applyInputMode() {
    var movable = DejaVuSettings.isOverlayMovable();
    DejaVuWindows.setInputPassThrough(OVERLAY_WINDOW, !movable);
  }

  // Shown collapsed as soon as the app starts, rather than waiting for a match:
  // this badge is what tells the player DejaVu is running and which key opens
  // the table. The window is in_game_only, so nothing appears on the desktop.
  function init() {
    collapsed = true;
    showOverlay();
    sendDisplayMode();
  }

  // Confirmed in testing: toggling the overlay back on mid-match with just
  // show() left it stuck on its last-rendered state (often the empty "waiting
  // for players" from right when it was hidden) even though the background
  // window had gone on sending correct players-update messages the whole
  // time it was hidden — a hidden window apparently doesn't keep repainting
  // from messages it can't display. Resending the full current state on every
  // becomes-visible transition (not just at match start) fixes that instead of
  // relying on whatever the window happened to have queued.
  function toggleCollapsed() {
    collapsed = !collapsed;
    logDiag('Alt+J pressed: panel is now ' + (collapsed ? 'collapsed to the badge' : 'showing the table'));
    // The window changes shape on the way, so this is showOverlay(), not just a
    // message to the window.
    showOverlay();
    sendDisplayMode();
    if (!collapsed) resync();
  }

  function resync() {
    sendDisplayMode();
    sendPlayers();
    overwolf.windows.sendMessage(OVERLAY_WINDOW, 'match-result', { result: lastMatchResult }, function () {});
    sendFeedState();
  }

  function sendFeedState() {
    overwolf.windows.sendMessage(OVERLAY_WINDOW, 'feed-state', { failed: feedFailed }, function () {});
  }

  // When GEP dies, match_start never fires, so resetMatch() never runs and the
  // overlay is never shown — meaning the one surface that could explain the
  // problem stays hidden and the user just sees nothing happen for a whole
  // session (both documented occurrences in §12 played out exactly that way).
  // So this shows the window as well as sending the state, unless the user has
  // deliberately hidden the panel, which is still their call to make.
  function handleFeedStateChanged(failed) {
    feedFailed = !!failed;
    logDiag('feed state changed: ' + (feedFailed ? 'FAILED' : 'recovered'));
    if (window.DejaVuFileLog) {
      DejaVuFileLog.logImportant('[overlay] feed state changed: ' + (feedFailed ? 'FAILED' : 'recovered'));
    }
    // Worth interrupting a collapsed panel for: this is the one state the
    // user has to act on, and the badge has no room to say so.
    if (feedFailed && collapsed) {
      collapsed = false;
      applyShape();
      sendDisplayMode();
    }
    if (feedFailed) showOverlay();
    sendFeedState();
  }

  // One lifecycle line per match recording which toggles are actually in
  // effect. Without it, "the overlay isn't showing X" can't be told apart from
  // "X is switched off" without reading the app's localStorage off disk — and
  // the toggles' default-on behaviour means a key that was never written still
  // reads as on, so absence from storage proves nothing either way.
  function logToggleState() {
    var state = DejaVuSettings.OVERLAY_TOGGLE_KEYS.map(function (key) {
      return key + '=' + (DejaVuSettings.getOverlayToggle(key) ? 'on' : 'off');
    }).join(' ');
    var line = 'overlay toggles: ' + state;
    logDiag(line);
    if (window.DejaVuFileLog) DejaVuFileLog.logImportant('[overlay] ' + line);
  }

  function resetMatch() {
    rowsByTag = {};
    lastMatchResult = null;
    collapsed = false;
    logToggleState();
    showOverlay();
    resync();
  }

  // priorRecord is the player's stored record from BEFORE this match's sighting
  // was written. Per the updated design, every player gets a row — a brand new
  // player just starts at 1 ("first time playing with them"), there's no more
  // staying silent on strangers. lastHero (Standard tier+ only) is from their
  // most recent *other* match together (plan §11 C2). matchStats/fullRecord
  // added 2026-09-05, matchesAgo added 2026-09-06 (see match-session.js); each
  // piece is independently gated by its own overlay toggle (DejaVuSettings) so
  // what's *saved* (detail level) and what's *shown* (these toggles) can
  // differ. lastResult is accepted for positional consistency with
  // match-session.js's callback but no longer used here — see the showRecord
  // block below for why.
  function handlePlayerRecognized(livePlayer, priorRecord, lastResult, lastHero, matchStats, fullRecord, matchesAgo, lastSide) {
    var tag = livePlayer.battlenet_tag;

    var row = {
      battlenet_tag: tag,
      display_name: livePlayer.player_name,
      hero_name: livePlayer.hero_name,
      is_teammate: livePlayer.is_teammate,
      times_played_together: (priorRecord ? priorRecord.encounter_count : 0) + 1,
      last_hero: null,
      kills_on_them: 0,
      deaths_to_them: 0,
      match_kills: 0,
      match_deaths: 0,
      record_with: null,
      record_against: null,
      recency: null,
      most_played_hero: null,
      last_side: null
    };

    // Which side they were on last time you met (2026-09-06 ask), shown under
    // the name where the most-played hero used to sit. Rides the same toggle as
    // the rest of the "last time you met" information rather than getting one
    // of its own: it answers the same question the last-played-hero icon does.
    if (DejaVuSettings.getOverlayToggle('showLastHero') && (lastSide === true || lastSide === false)) {
      row.last_side = lastSide;
    }

    if (DejaVuSettings.getOverlayToggle('showLastHero')) {
      row.last_hero = lastHero || null;
    }

    // Lifetime totals as of before this match (Full tier only — see §11
    // D1-D3; priorRecord is just DejaVuStorage.getPlayer's record, which
    // already carries these). §6.1's planned "You: X  Them: Y" line was
    // tracked in storage since Phase 3 but never actually surfaced until now.
    if (DejaVuSettings.getOverlayToggle('showLifetimeKD') && priorRecord) {
      row.kills_on_them = priorRecord.kills_on_them || 0;
      row.deaths_to_them = priorRecord.deaths_to_them || 0;
    }

    // This match's own K/D against them (Full tier), separate from the
    // lifetime totals above — updated live as kills happen.
    if (DejaVuSettings.getOverlayToggle('showMatchKD') && matchStats) {
      row.match_kills = matchStats.kills || 0;
      row.match_deaths = matchStats.deaths || 0;
    }

    // A bare combined win/loss record is ambiguous — "3W-1L" doesn't say
    // whether those were together or against each other, and the old single
    // "last time" badge had the same problem. That was first solved by picking
    // whichever split matched the current relationship, but a single column
    // can't be *labelled* under that scheme (its meaning changes row by row,
    // leaving the name colour as the only clue which one you're reading), so
    // 2026-09-06 it became two explicitly-titled columns instead — both are
    // sent for every player regardless of which side they're on today.
    // Draws are deliberately not surfaced at all: they're rare enough in
    // Overwatch to be noise, and a third number made the badge hard to parse
    // at a glance. lastResult is still not surfaced on its own — it's folded
    // into these.
    if (DejaVuSettings.getOverlayToggle('showRecord') && fullRecord) {
      if (fullRecord.teammate_wins || fullRecord.teammate_losses) {
        row.record_with = { wins: fullRecord.teammate_wins, losses: fullRecord.teammate_losses };
      }
      if (fullRecord.enemy_wins || fullRecord.enemy_losses) {
        row.record_against = { wins: fullRecord.enemy_wins, losses: fullRecord.enemy_losses };
      }
    }

    // "N matches ago" / "X days ago" (plan §11, 2026-09-06) — recency doesn't
    // need any particular tier (priorRecord.last_seen exists at every tier;
    // matchesAgo is null when unknown), unlike everything else in this
    // function. Nothing to show on someone's first-ever sighting.
    if (DejaVuSettings.getOverlayToggle('showRecency') && priorRecord) {
      row.recency = { matchesAgo: matchesAgo, lastSeen: priorRecord.last_seen || null };
    }

    // Most-played hero overall (plan §11 C3) — distinct from last_hero above:
    // that's whatever they were on their most recent *other* match; this is
    // whichever hero they've picked most often across every sighting,
    // including mid-match swaps (see match-session.js's per-pick tally).
    // Standard+ tier, same as the rest of the hero-history features.
    if (DejaVuSettings.getOverlayToggle('showMostPlayedHero') && priorRecord && priorRecord.hero_counts) {
      var topHero = null, topCount = 0;
      Object.keys(priorRecord.hero_counts).forEach(function (hero) {
        if (priorRecord.hero_counts[hero] > topCount) {
          topHero = hero;
          topCount = priorRecord.hero_counts[hero];
        }
      });
      if (topHero) row.most_played_hero = { name: topHero, count: topCount };
    }

    rowsByTag[tag] = row;

    sendPlayers();
  }

  // GEP reuses roster slots: when someone leaves and a backfill takes their
  // place, the new player arrives under the same roster_N key and the old tag
  // simply stops appearing. rowsByTag had no eviction at all — it only reset
  // at the next match_start — so every tag ever seen stayed on the panel for
  // the rest of the match, showing people who had already left and growing the
  // table without any bound. Confirmed 2026-09-06 from a real log: one match
  // (gep-20260903-225812.txt) accumulated 30 distinct tags through at most 12
  // simultaneous roster slots, and the panel was still being sent all 30 rows,
  // far past what the fixed-height overlay window can draw.
  //
  // activeTags is the full current roster from match-session.js, so anything
  // not in it is genuinely gone from the lobby. Only resends when something
  // actually changed — this runs on every roster tick, which is frequent.
  function syncRoster(activeTags) {
    // An empty roster means the slot cache was just wiped, not that the lobby
    // emptied — registerEvents() calls resetRosterCache(), so a re-registration
    // mid-match would hand us nothing and we'd clear a panel that should still
    // be full. The cache refills a slot at a time from subsequent updates, so
    // waiting for a non-empty roster costs nothing and removes the only way
    // this could blank the overlay outright.
    if (!activeTags || !activeTags.length) return;

    var present = {};
    activeTags.forEach(function (tag) { present[tag] = true; });

    var removed = [];
    Object.keys(rowsByTag).forEach(function (tag) {
      if (!present[tag]) {
        delete rowsByTag[tag];
        removed.push(tag);
      }
    });

    if (removed.length) {
      logDiag('roster sync: dropped ' + removed.length + ' player(s) no longer in the lobby (' + removed.join(', ') + ')');
      sendPlayers();
    }
  }

  // The live match's own outcome, once GEP resolves it (confirmed as the
  // strings "victory"/"defeat" against real matches).
  function handleMatchResult(result) {
    lastMatchResult = result;
    overwolf.windows.sendMessage(OVERLAY_WINDOW, 'match-result', { result: result }, function (res) {
      logDiag('sendMessage(match-result, ' + result + ') -> ' + JSON.stringify(res));
    });
  }

  // Which columns the overlay should draw at all. The per-row fields above
  // already go unpopulated when a toggle is off, but a row can't distinguish
  // "this toggle is off" from "this player has no data yet" — both leave the
  // field at 0/null. That was fine while these pieces were sub-lines that
  // simply didn't appear; now that each has its own column, the difference
  // matters: an off toggle should drop the whole column (header included),
  // while an on toggle with no data yet keeps the column and leaves the cell
  // blank. Sent alongside the rows rather than read in the overlay window,
  // which has no access to DejaVuSettings and stays a dumb renderer.
  function columnState() {
    return {
      lastHero: DejaVuSettings.getOverlayToggle('showLastHero'),
      matchKD: DejaVuSettings.getOverlayToggle('showMatchKD'),
      lifetimeKD: DejaVuSettings.getOverlayToggle('showLifetimeKD'),
      record: DejaVuSettings.getOverlayToggle('showRecord')
    };
  }

  function sendPlayers() {
    var players = Object.keys(rowsByTag).map(function (tag) { return rowsByTag[tag]; });
    players.sort(function (a, b) {
      if (a.is_teammate !== b.is_teammate) return a.is_teammate ? -1 : 1;
      return a.display_name.localeCompare(b.display_name);
    });

    var payload = { players: players, columns: columnState() };
    overwolf.windows.sendMessage(OVERLAY_WINDOW, 'players-update', payload, function (result) {
      logDiag('sendMessage(players-update, ' + players.length + ' player(s)) -> ' + JSON.stringify(result));
    });
  }

  // Back to the badge rather than gone: the window stays up between matches,
  // shrinking into the corner instead of disappearing.
  function handleMatchEnd() {
    collapsed = true;
    applyShape();
    sendDisplayMode();
  }

  function refreshShape() {
    logDiag('game resolution changed — re-sizing and re-placing the overlay');
    applyShape();
  }

  return {
    init: init,
    refreshShape: refreshShape,
    resetMatch: resetMatch,
    syncRoster: syncRoster,
    handleFeedStateChanged: handleFeedStateChanged,
    handlePlayerRecognized: handlePlayerRecognized,
    handleMatchResult: handleMatchResult,
    handleMatchEnd: handleMatchEnd,
    toggleCollapsed: toggleCollapsed
  };
})();
