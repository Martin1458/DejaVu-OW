var logFilePath = DejaVuFileLog.init();
DejaVuFileLog.log('background controller (re)started');

DejaVuStorage.getAllPlayers().then(function (players) {
  var line = 'storage ready — ' + players.length + ' known player(s)';
  console.log('[DejaVu] ' + line);
  DejaVuFileLog.log(line);
});

DejaVuStorage.migrateLegacyResults().then(function (fixed) {
  var line = 'migrateLegacyResults: fixed ' + fixed + ' encounter row(s)';
  console.log('[DejaVu] ' + line);
  DejaVuFileLog.log(line);
});

DejaVuMatchSession.init({
  onPlayerRecognized: DejaVuOverlayController.handlePlayerRecognized,
  onMatchReset: DejaVuOverlayController.resetMatch,
  onMatchResult: DejaVuOverlayController.handleMatchResult
});

overwolf.settings.hotkeys.onPressed.addListener(function (event) {
  if (event.name === 'toggle_overlay') {
    DejaVuOverlayController.toggleVisibility();
  }
  if (event.name === 'open_history') {
    DejaVuWindows.show('history');
  }
});

// Dock icon click while in-game turned out to just toggle the in_game_only
// overlay window directly (confirmed via the debug log — clicking it produced
// overlay restore()/hide() calls, never this event), so it's not a reliable way
// to open History in-game. Alt+H (above) is the real path; this stays wired for
// whatever other launch origins (Library, etc.) actually do fire it.
overwolf.extensions.onAppLaunchTriggered.addListener(function (event) {
  var line = 'onAppLaunchTriggered fired, origin=' + (event && event.origin);
  console.log('[DejaVu] ' + line);
  DejaVuFileLog.log(line);
  DejaVuWindows.show('history');
});

DejaVuGep.init({
  // players: full current roster (merged) — not logged in full every tick, since
  // that's what made the debug log balloon to 12MB in one match. changed: just the
  // slot(s) this update touched, which is what's actually worth reading.
  onRoster: function (players, changed) {
    var line = 'roster update — ' + players.length + ' total, ' + changed.length + ' changed: ' + JSON.stringify(changed);
    console.log('[DejaVu] ' + line);
    DejaVuFileLog.log(line);
    DejaVuMatchSession.handleRoster(players, changed);
  },

  onMatchEvent: function (name, data) {
    var line = 'match event: ' + name + ' ' + JSON.stringify(data);
    console.log('[DejaVu] ' + line);
    DejaVuFileLog.log(line);
    DejaVuMatchSession.handleMatchEvent(name, data);
    if (name === 'match_end') {
      DejaVuOverlayController.handleMatchEnd();
    }
  },

  // match_info's own fields (map, match_outcome, etc.) — confirmed against real
  // matches: match_outcome is "victory"/"defeat"/null, map is a bare internal id
  // (not a name).
  onMatchInfo: function (fields) {
    var line = 'match info: ' + JSON.stringify(fields);
    console.log('[DejaVu] ' + line);
    DejaVuFileLog.log(line);
    DejaVuMatchSession.handleMatchInfo(fields);
  }
});

console.log('[DejaVu] background controller started, waiting for Overwatch... (logging to ' + logFilePath + ')');
