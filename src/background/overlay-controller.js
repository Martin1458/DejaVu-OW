// Overlay Controller (see DEJAVU_OW_PLAN.md §6.1, §7) — owns the overlay
// window's lifecycle and keeps a table of every player seen this match, pushed
// to the overlay window as a whole on any change. Storage stays out of this
// file entirely — DejaVuMatchSession already looked up each player's prior
// record before this runs.

var DejaVuOverlayController = (function () {
  var OVERLAY_WINDOW = 'overlay';

  // Whether the panel *should* be showing per the Alt+D toggle. Independent from
  // match state: hiding it mid-match via the hotkey sticks until either you press
  // it again or the next match starts (resetMatch always shows it back up, so a
  // "hidden" preference doesn't carry silently into a match you'd want to see it).
  var visible = true;

  var rowsByTag = {};      // battlenet_tag -> row currently shown for this match
  var lastMatchResult = null; // this match's own outcome, once resolved (or null)

  function logDiag(line) {
    console.log('[DejaVuOverlayController] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[overlay] ' + line);
  }

  function showOverlay() {
    DejaVuWindows.show(OVERLAY_WINDOW);
  }

  function hideOverlay() {
    DejaVuWindows.hide(OVERLAY_WINDOW);
  }

  // Confirmed in testing: toggling the overlay back on mid-match with just
  // show() left it stuck on its last-rendered state (often the empty "waiting
  // for players" from right when it was hidden) even though the background
  // window had gone on sending correct players-update messages the whole
  // time it was hidden — a hidden window apparently doesn't keep repainting
  // from messages it can't display. Resending the full current state on every
  // becomes-visible transition (not just at match start) fixes that instead of
  // relying on whatever the window happened to have queued.
  function toggleVisibility() {
    visible = !visible;
    if (visible) {
      showOverlay();
      resync();
    } else {
      hideOverlay();
    }
  }

  function resync() {
    sendPlayers();
    overwolf.windows.sendMessage(OVERLAY_WINDOW, 'match-result', { result: lastMatchResult }, function () {});
  }

  function resetMatch() {
    rowsByTag = {};
    lastMatchResult = null;
    visible = true;
    showOverlay();
    resync();
  }

  // priorRecord is the player's stored record from BEFORE this match's sighting
  // was written. Per the updated design, every player gets a row — a brand new
  // player just starts at 1 ("first time playing with them"), there's no more
  // staying silent on strangers. lastResult/lastHero (Standard tier+ only) are
  // from their most recent *other* completed match together (plan §11 B2/C2).
  function handlePlayerRecognized(livePlayer, priorRecord, lastResult, lastHero) {
    var tag = livePlayer.battlenet_tag;

    rowsByTag[tag] = {
      battlenet_tag: tag,
      display_name: livePlayer.player_name,
      hero_name: livePlayer.hero_name,
      is_teammate: livePlayer.is_teammate,
      times_played_together: (priorRecord ? priorRecord.encounter_count : 0) + 1,
      last_result: lastResult ? lastResult.result : null,
      last_hero: lastHero || null
    };

    sendPlayers();
  }

  // The live match's own outcome, once GEP resolves it (confirmed as the
  // strings "victory"/"defeat" against real matches).
  function handleMatchResult(result) {
    lastMatchResult = result;
    overwolf.windows.sendMessage(OVERLAY_WINDOW, 'match-result', { result: result }, function (res) {
      logDiag('sendMessage(match-result, ' + result + ') -> ' + JSON.stringify(res));
    });
  }

  function sendPlayers() {
    var players = Object.keys(rowsByTag).map(function (tag) { return rowsByTag[tag]; });
    players.sort(function (a, b) {
      if (a.is_teammate !== b.is_teammate) return a.is_teammate ? -1 : 1;
      return a.display_name.localeCompare(b.display_name);
    });

    overwolf.windows.sendMessage(OVERLAY_WINDOW, 'players-update', { players: players }, function (result) {
      logDiag('sendMessage(players-update, ' + players.length + ' player(s)) -> ' + JSON.stringify(result));
    });
  }

  function handleMatchEnd() {
    hideOverlay();
  }

  return {
    resetMatch: resetMatch,
    handlePlayerRecognized: handlePlayerRecognized,
    handleMatchResult: handleMatchResult,
    handleMatchEnd: handleMatchEnd,
    toggleVisibility: toggleVisibility
  };
})();
