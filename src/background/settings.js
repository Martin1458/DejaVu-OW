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
  }

  return {
    VALID_LEVELS: VALID_LEVELS,
    getDetailLevel: getDetailLevel,
    setDetailLevel: setDetailLevel
  };
})();
