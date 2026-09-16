// Onboarding screen (plan §11, 2026-09-05 ask; rebuilt 2026-09-11 for the
// store release) — shown by background.js the first time Overwatch is detected
// running while DejaVuSettings.isSetupComplete() is still false.
//
// This is the whole first-run experience on one screen: pick how much DejaVu
// remembers, pick what the overlay shows, and learn where the settings live.
// It does NOT gate recording — Basic tier already applies by default — but
// unlike the old two-button popup it lets the user actually make the choice
// here instead of sending them off to another window to make it.

(function () {
  var GAME_ID = 10844;

  // Measured against the real record shapes in storage.js (2026-09-11), not
  // guessed: a players row serializes to ~378 bytes, an encounters row to
  // ~102, an encounter_participants row to ~120, times ~1.8 for IndexedDB's
  // structured-clone and index overhead, over a 12-slot lobby.
  //
  // The number that matters for the recommendation is that Full costs the
  // SAME as Standard: handleKillFeed only bumps counters on players rows that
  // Standard already writes (match-session.js line ~144), so raising Standard
  // to Full adds no rows at all. Showing the two identical figures side by
  // side is the honest version of "go for Full".
  var SIZE_PER_100_MATCHES = {
    basic: '~0.6 MB per 100 matches',
    standard: '~0.9 MB per 100 matches',
    full: '~0.9 MB per 100 matches'
  };

  // What the radios are showing right now, which is deliberately NOT the same
  // as what's stored. Full is pre-selected as the recommendation, but nothing
  // is written until the user actually acts (picks a tier, or presses Start) —
  // closing this window with the X must not silently leave them recording at
  // the most detailed tier they never agreed to. Storage stays at its Basic
  // default in that case and this screen comes back next launch, since
  // isSetupComplete() is still false.
  var selectedTier = null;

  function logDiag(line) {
    console.log('[DejaVuOnboarding] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[onboarding] ' + line);
  }

  // The bindings actually in force (see src/common/hotkeys.js) — the manifest
  // defaults printed in the HTML are only a seed for a fresh install.
  function applyLiveHotkeys() {
    DejaVuHotkeys.watch(function (keys) {
      var history = DejaVuHotkeys.label(keys, 'open_history');
      var overlay = DejaVuHotkeys.label(keys, 'toggle_overlay');
      logDiag('live hotkeys: open_history=' + history + ' toggle_overlay=' + overlay);
      document.getElementById('kbd-history').textContent = history || DejaVuHotkeys.UNASSIGNED;
      document.getElementById('kbd-overlay').textContent = overlay || DejaVuHotkeys.UNASSIGNED;
    });
  }

  // Mirrors refreshOverlayToggleAvailability() in history.js: a toggle whose
  // data isn't tracked at the chosen tier is disabled rather than hidden, so
  // the preference survives raising the tier later. Kept as a copy rather than
  // shared because history.js is a window script, not a module — the two must
  // be changed together if the tier rules ever move.
  function refreshOverlayToggleAvailability() {
    // Reads the on-screen selection, not the stored level, so the rows enable
    // and grey out as the user moves between tier cards — before any of it has
    // been committed.
    var tier = selectedTier || DejaVuSettings.getDetailLevel();
    document.querySelectorAll('[data-toggle-row]').forEach(function (rowEl) {
      var requires = rowEl.getAttribute('data-requires'); // absent, 'standard', or 'full'
      var available = !requires ? true : (requires === 'full' ? tier === 'full' : tier !== 'basic');
      rowEl.classList.toggle('disabled', !available);
      var cb = rowEl.querySelector('input[data-toggle]');
      if (cb) cb.disabled = !available;
    });
  }

  function refreshSelectedCard() {
    document.querySelectorAll('.tier-card').forEach(function (card) {
      card.classList.toggle('selected', card.getAttribute('data-tier') === selectedTier);
    });
  }

  function initTierPicker() {
    document.querySelectorAll('.tier-size').forEach(function (el) {
      el.textContent = SIZE_PER_100_MATCHES[el.getAttribute('data-size')] || '';
    });

    // Pre-select Full as the recommendation. This screen only ever runs while
    // setup is incomplete, so there is no earlier choice to overwrite — but
    // see selectedTier above for why this is not persisted here.
    selectedTier = DejaVuSettings.isSetupComplete() ? DejaVuSettings.getDetailLevel() : 'full';

    document.querySelectorAll('input[name="tier"]').forEach(function (radio) {
      radio.checked = radio.value === selectedTier;
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        // An explicit pick is an action, so this one does commit immediately.
        logDiag('detail level chosen: ' + radio.value);
        selectedTier = radio.value;
        DejaVuSettings.setDetailLevel(radio.value);
        refreshSelectedCard();
        refreshOverlayToggleAvailability();
      });
    });

    refreshSelectedCard();
  }

  function initOverlayTogglePicker() {
    document.querySelectorAll('input[data-toggle]').forEach(function (cb) {
      var key = cb.getAttribute('data-toggle');
      cb.checked = DejaVuSettings.getOverlayToggle(key);
      cb.addEventListener('change', function () {
        logDiag('overlay toggle ' + key + ' -> ' + cb.checked);
        DejaVuSettings.setOverlayToggle(key, cb.checked);
      });
    });
    refreshOverlayToggleAvailability();
  }

  // The same setting as the toggle in History -> Settings, offered up front:
  // where the overlay sits is one of the first things a new player may want
  // to change. Unlike the tier, it commits the moment it is flipped — it is
  // off by default, so leaving the screen untouched changes nothing.
  function initMovableToggle() {
    var el = document.getElementById('overlay-movable');
    el.checked = DejaVuSettings.isOverlayMovable();
    el.addEventListener('change', function () {
      logDiag('overlay movable -> ' + el.checked);
      DejaVuSettings.setOverlayMovable(el.checked);
      DejaVuWindows.applyOverlayMovable(el.checked);
    });
  }

  function init() {
    DejaVuFileLog.init();
    logDiag('onboarding window shown');

    initTierPicker();
    initOverlayTogglePicker();
    initMovableToggle();
    applyLiveHotkeys();

    document.getElementById('start-btn').addEventListener('click', function () {
      // Pressing Start is the user accepting whatever is on screen, including
      // the pre-selected Full they may never have clicked — so commit it here
      // rather than at load. setDetailLevel marks setup complete itself, but
      // call it explicitly too so the intent survives if that ever changes.
      if (selectedTier) DejaVuSettings.setDetailLevel(selectedTier);
      DejaVuSettings.markSetupComplete();
      logDiag('start clicked, setup complete at level ' + DejaVuSettings.getDetailLevel());
      DejaVuWindows.hide('onboarding');
    });
  }

  init();
})();
