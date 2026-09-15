// User settings (see DEJAVU_OW_PLAN.md §5) — persisted via localStorage, which
// (like IndexedDB) is per-origin and shared across every window of this app,
// so background.js and history.js both see the same value with no message
// passing needed. Reads are cheap/synchronous, so callers should just read
// fresh each time rather than caching — that's what lets a mid-match settings
// change be picked up cleanly at the next match boundary instead of needing
// its own sync mechanism.

var DejaVuSettings = (function () {
  var KEY_DETAIL_LEVEL = 'dejavu.detailLevel';
  var VALID_LEVELS = ['basic', 'standard', 'full'];
  var DEFAULT_LEVEL = 'basic';

  // Independent of detail level (which controls what's *saved*): these control
  // what the in-game overlay actually *shows* out of whatever history exists.
  // Keyed separately (one localStorage key per toggle, matching this file's
  // existing style) rather than one JSON blob, so each is trivial to inspect
  // or reset on its own. All default to true — existing behavior is unchanged
  // until someone opts out.
  var OVERLAY_TOGGLE_KEYS = {
    showLastHero: 'dejavu.overlay.showLastHero',     // faded last-played-hero icon (Standard+)
    showLifetimeKD: 'dejavu.overlay.showLifetimeKD', // "You – Them" lifetime kills/deaths line (Full)
    showMatchKD: 'dejavu.overlay.showMatchKD',       // this match's own K/D against them (Full)
    showRecord: 'dejavu.overlay.showRecord',         // contextual teammate/enemy W-L record (Standard+)
    showRecency: 'dejavu.overlay.showRecency',       // "N matches ago / X days ago" (any tier — uses last_seen + the match counter below)
    showMostPlayedHero: 'dejavu.overlay.showMostPlayedHero' // hero they've picked most often overall, not just last time (Standard+)
  };

  // Plan §11 ask (2026-09-06): "how many matches ago did I play them" needs
  // *some* running count of matches played, independent of any per-player
  // data — a simple incrementing counter, bumped once per match_start
  // regardless of detail level (so recency works even at Basic tier). Player
  // records snapshot this counter's value at their last sighting; the
  // difference is "N matches ago". See match-session.js's resetMatch/
  // recordEncounter and storage.js's recordEncounter.
  var KEY_TOTAL_MATCHES = 'dejavu.totalMatchesPlayed';

  // Plan §11 ask (2026-09-05): a first-run nudge so the user consciously picks
  // a detail level / overlay setup at least once, rather than silently
  // accumulating history under whatever the default happens to be. This does
  // NOT gate recording — Basic tier still applies immediately by default
  // (explicit user decision, not a privacy hard-stop) — it only gates whether
  // the onboarding popup keeps appearing. Marked complete either by touching
  // any setting below, or by dismissing the popup itself.
  var KEY_SETUP_COMPLETE = 'dejavu.setupComplete';

  function getDetailLevel() {
    var value = null;
    try {
      value = localStorage.getItem(KEY_DETAIL_LEVEL);
    } catch (e) {
      console.warn('[DejaVuSettings] localStorage read failed', e);
    }
    return VALID_LEVELS.indexOf(value) !== -1 ? value : DEFAULT_LEVEL;
  }

  function setDetailLevel(level) {
    if (VALID_LEVELS.indexOf(level) === -1) {
      console.warn('[DejaVuSettings] ignoring invalid detail level', level);
      return;
    }
    try {
      localStorage.setItem(KEY_DETAIL_LEVEL, level);
    } catch (e) {
      console.warn('[DejaVuSettings] localStorage write failed', e);
    }
    markSetupComplete();
  }

  function getOverlayToggle(key) {
    if (!OVERLAY_TOGGLE_KEYS.hasOwnProperty(key)) return true;
    try {
      var value = localStorage.getItem(OVERLAY_TOGGLE_KEYS[key]);
      return value === null ? true : value === 'true';
    } catch (e) {
      return true;
    }
  }

  function setOverlayToggle(key, enabled) {
    if (!OVERLAY_TOGGLE_KEYS.hasOwnProperty(key)) {
      console.warn('[DejaVuSettings] ignoring unknown overlay toggle', key);
      return;
    }
    try {
      localStorage.setItem(OVERLAY_TOGGLE_KEYS[key], enabled ? 'true' : 'false');
    } catch (e) {
      console.warn('[DejaVuSettings] localStorage write failed', e);
    }
    markSetupComplete();
  }

  function getTotalMatchesPlayed() {
    try {
      var value = parseInt(localStorage.getItem(KEY_TOTAL_MATCHES), 10);
      return isNaN(value) ? 0 : value;
    } catch (e) {
      return 0;
    }
  }

  // Called once per match_start; returns the new total so the caller doesn't
  // need a separate read-after-write.
  function incrementTotalMatchesPlayed() {
    var next = getTotalMatchesPlayed() + 1;
    try {
      localStorage.setItem(KEY_TOTAL_MATCHES, String(next));
    } catch (e) {
      console.warn('[DejaVuSettings] localStorage write failed', e);
    }
    return next;
  }

  // Whether the overlay takes the mouse in game. Off by default: an
  // interactive window swallows any click that lands on it, and the collapsed
  // badge cannot shrink below Overwolf's 100px minimum window height, so a
  // locked overlay is the safe resting state and dragging is something the user
  // switches on when they want to move it.
  var KEY_OVERLAY_MOVABLE = 'dejavu.overlayMovable';

  function isOverlayMovable() {
    try {
      return localStorage.getItem(KEY_OVERLAY_MOVABLE) === 'true';
    } catch (e) {
      return false;
    }
  }

  function setOverlayMovable(movable) {
    try {
      localStorage.setItem(KEY_OVERLAY_MOVABLE, movable ? 'true' : 'false');
    } catch (e) {
      console.warn('[DejaVuSettings] localStorage write failed', e);
    }
  }

  // Where the user has dragged the overlay, per mode — the table and the
  // badge are different shapes in different places, so a position that suits
  // one is wrong for the other. Absent until the window is actually dragged,
  // which is what lets overlay-controller.js fall back to its defaults rather
  // than having to seed a position up front.
  var OVERLAY_POSITION_KEYS = {
    expanded: 'dejavu.overlayPosition.expanded',
    collapsed: 'dejavu.overlayPosition.collapsed'
  };

  // Returns { left, top } in logical pixels, or null when never dragged.
  function getOverlayPosition(mode) {
    var key = OVERLAY_POSITION_KEYS[mode];
    if (!key) return null;
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      // A stored value that isn't two finite numbers would place the window
      // somewhere unrecoverable, so treat anything unexpected as unset.
      if (!parsed || !isFinite(parsed.left) || !isFinite(parsed.top)) return null;
      return { left: parsed.left, top: parsed.top };
    } catch (e) {
      console.warn('[DejaVuSettings] localStorage read failed', e);
      return null;
    }
  }

  function setOverlayPosition(mode, left, top) {
    var key = OVERLAY_POSITION_KEYS[mode];
    if (!key || !isFinite(left) || !isFinite(top)) return;
    try {
      localStorage.setItem(key, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
    } catch (e) {
      console.warn('[DejaVuSettings] localStorage write failed', e);
    }
  }

  function clearOverlayPositions() {
    try {
      localStorage.removeItem(OVERLAY_POSITION_KEYS.expanded);
      localStorage.removeItem(OVERLAY_POSITION_KEYS.collapsed);
    } catch (e) {
      console.warn('[DejaVuSettings] localStorage write failed', e);
    }
  }

  function isSetupComplete() {
    try {
      return localStorage.getItem(KEY_SETUP_COMPLETE) === 'true';
    } catch (e) {
      return false;
    }
  }

  function markSetupComplete() {
    try {
      localStorage.setItem(KEY_SETUP_COMPLETE, 'true');
    } catch (e) {
      console.warn('[DejaVuSettings] localStorage write failed', e);
    }
  }

  return {
    VALID_LEVELS: VALID_LEVELS,
    OVERLAY_TOGGLE_KEYS: Object.keys(OVERLAY_TOGGLE_KEYS),
    getDetailLevel: getDetailLevel,
    setDetailLevel: setDetailLevel,
    getOverlayToggle: getOverlayToggle,
    setOverlayToggle: setOverlayToggle,
    getTotalMatchesPlayed: getTotalMatchesPlayed,
    incrementTotalMatchesPlayed: incrementTotalMatchesPlayed,
    isOverlayMovable: isOverlayMovable,
    setOverlayMovable: setOverlayMovable,
    getOverlayPosition: getOverlayPosition,
    setOverlayPosition: setOverlayPosition,
    clearOverlayPositions: clearOverlayPositions,
    isSetupComplete: isSetupComplete,
    markSetupComplete: markSetupComplete
  };
})();
