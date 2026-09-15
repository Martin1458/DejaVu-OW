var logFilePath = DejaVuFileLog.init();
DejaVuFileLog.log('background controller (re)started');
DejaVuFileLog.logImportant('background controller (re)started');

DejaVuStorage.getAllPlayers().then(function (players) {
  var line = 'storage ready — ' + players.length + ' known player(s)';
  console.log('[DejaVu] ' + line);
  DejaVuFileLog.log(line);
  DejaVuFileLog.logImportant(line);
});

DejaVuStorage.migrateLegacyResults().then(function (fixed) {
  var line = 'migrateLegacyResults: fixed ' + fixed + ' encounter row(s)';
  console.log('[DejaVu] ' + line);
  DejaVuFileLog.log(line);
  DejaVuFileLog.logImportant(line);
});

DejaVuMatchSession.init({
  onPlayerRecognized: DejaVuOverlayController.handlePlayerRecognized,
  onMatchReset: DejaVuOverlayController.resetMatch,
  onMatchResult: DejaVuOverlayController.handleMatchResult,
  onRosterSync: DejaVuOverlayController.syncRoster
});

// Overwolf persists a hotkey assignment once it has registered it, exactly the
// way it persists window bounds (see window-utils.js's ensureSize) — so the
// manifest's `default` only seeds a binding that has never existed, and
// changing it does not rebind an existing install. Logged at startup so the
// binding actually in force is a one-line grep instead of guesswork; changing
// it for real is done in Overwolf's own settings, not here, since overwriting
// it programmatically would trample a binding the user may have chosen.
overwolf.settings.hotkeys.get(function (result) {
  var line = 'hotkeys in force: ' + JSON.stringify(result && result.games) + ' global=' + JSON.stringify(result && result.globals);
  console.log('[DejaVu] ' + line);
  DejaVuFileLog.log(line);
  DejaVuFileLog.logImportant(line);
});

// Put the overlay up straight away, collapsed to its badge. It is in_game_only
// so this shows nothing on the desktop; in game it is what tells the player
// DejaVu is running and which key opens the table.
DejaVuOverlayController.init();

overwolf.settings.hotkeys.onPressed.addListener(function (event) {
  DejaVuFileLog.log('hotkey pressed: ' + (event && event.name));
  if (event.name === 'toggle_overlay') {
    DejaVuOverlayController.toggleCollapsed();
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
    // match_start/match_end are rare, high-value boundary markers — worth
    // keeping in the durable lifecycle log alongside GEP registration events,
    // unlike the rest of match-event traffic (kill_feed etc.).
    if (name === 'match_start' || name === 'match_end') {
      DejaVuFileLog.logImportant(line);
    }
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
  },

  // First-run nudge (plan §11, 2026-09-05): doesn't gate recording — Basic
  // tier already applies by default regardless — just invites the user to
  // consciously look at detail level / overlay toggles at least once. Fires
  // on every detection while setup is still incomplete (not just the very
  // first), so dismissing the popup without touching settings brings it back
  // next launch rather than silently going away.
  onGameDetected: function () {
    if (!DejaVuSettings.isSetupComplete()) {
      DejaVuFileLog.log('setup not complete — showing onboarding popup');
      // Same reason showOverlay() does this (see window-utils.js): the
      // manifest's `size` only ever seeds a brand-new window, so an install
      // that already created the onboarding window at the old 380x320 would
      // otherwise render the rebuilt screen into a box less than half its
      // height. Idempotent, so it costs nothing when the size is already right.
      DejaVuWindows.ensureSize('onboarding', 560, 660);
      DejaVuWindows.show('onboarding');
    }
  },

  // A dead GEP feed used to be completely silent from the user's side (§12):
  // the overlay showed the same "waiting for players" it shows before any
  // normal match, for the whole session. Route the state through to the panel
  // so it can say what's actually wrong and what to do about it.
  onFeedStateChanged: DejaVuOverlayController.handleFeedStateChanged
});

console.log('[DejaVu] background controller started, waiting for Overwatch... (logging to ' + logFilePath + ')');
