// The hotkey bindings actually in force, for any window that wants to tell the
// user which key to press. Overwolf persists a binding once it has registered
// it (see window-utils.js's ensureSize for the same rule about window bounds),
// so the manifest's `default` only ever seeds a binding that has never
// existed: a user who rebound the key would be told the wrong one by hardcoded
// copy. This was duplicated in overlay.js and onboarding.js before the History
// window wanted it too, which is where a third copy stopped being reasonable.

var DejaVuHotkeys = (function () {
  var GAME_ID = 10844;

  // Fallbacks for when the API is unavailable or fails — must match
  // manifest.json's `data.hotkeys.*.default`.
  var DEFAULTS = {
    toggle_overlay: 'Alt+J',
    open_history: 'Alt+H'
  };

  // Overwolf's own wording for a hotkey with no key assigned to it.
  var UNASSIGNED = 'Unassigned';

  function bindingFor(candidates, name) {
    for (var i = 0; i < candidates.length; i++) {
      var hk = candidates[i];
      if (!hk || hk.name !== name) continue;
      if (hk.IsUnassigned) return UNASSIGNED;
      if (hk.binding) return hk.binding;
    }
    return null;
  }

  // cb receives { toggle_overlay: <binding|'Unassigned'|null>, ... }, or null
  // if the bindings could not be read at all. A null per-key value means that
  // hotkey was not in the response — distinct from being explicitly unbound.
  function read(cb) {
    if (!window.overwolf || !overwolf.settings || !overwolf.settings.hotkeys) {
      cb(null);
      return;
    }
    overwolf.settings.hotkeys.get(function (result) {
      if (!result || !result.success) {
        cb(null);
        return;
      }
      // A hotkey lands in the per-game list or the global one depending on how
      // it was assigned, so check both rather than assuming which.
      var candidates = [];
      if (result.games && result.games[GAME_ID]) candidates = candidates.concat(result.games[GAME_ID]);
      if (result.globals) candidates = candidates.concat(result.globals);

      var out = {};
      for (var name in DEFAULTS) {
        if (DEFAULTS.hasOwnProperty(name)) out[name] = bindingFor(candidates, name);
      }
      cb(out);
    });
  }

  // Same as read(), but also re-reads whenever the user changes a binding in
  // Overwolf's settings, so a window that is already open updates itself
  // instead of showing a key that stopped working while it was on screen.
  function watch(cb) {
    read(cb);
    if (window.overwolf && overwolf.settings && overwolf.settings.hotkeys &&
        overwolf.settings.hotkeys.onChanged) {
      overwolf.settings.hotkeys.onChanged.addListener(function () { read(cb); });
    }
  }

  // What to actually print for one hotkey: its binding, or the manifest default
  // when it could not be read. Returns null when the user has deliberately left
  // it unbound, since there is no key to name and callers need to say something
  // else entirely.
  function label(keys, name) {
    var binding = keys ? keys[name] : null;
    if (binding === UNASSIGNED) return null;
    return binding || DEFAULTS[name] || null;
  }

  return { read: read, watch: watch, label: label, UNASSIGNED: UNASSIGNED };
})();
