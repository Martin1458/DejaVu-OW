// Small shared helper for showing/hiding a manifest-declared window by name,
// routing through obtainDeclaredWindow first so failures produce a loggable
// result instead of restore()/hide()'s silent no-op on a bad name. Logs to
// the same debug file as everything else so a failure here is inspectable
// after the fact, without needing devtools open at the right moment.

var DejaVuWindows = (function () {
  function logDiag(line) {
    console.log('[DejaVuWindows] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[windows] ' + line);
  }

  function withWindow(name, callback) {
    overwolf.windows.obtainDeclaredWindow(name, function (result) {
      logDiag('obtainDeclaredWindow(' + name + ') -> ' + JSON.stringify(result));
      if (!result.success) return;
      callback(result.window.id);
    });
  }

  function show(name, cb) {
    withWindow(name, function (id) {
      overwolf.windows.restore(id, function (result) {
        logDiag('restore(' + name + ') -> ' + JSON.stringify(result));
        if (cb) cb(result);
      });
    });
  }

  function hide(name, cb) {
    withWindow(name, function (id) {
      overwolf.windows.hide(id, function (result) {
        logDiag('hide(' + name + ') -> ' + JSON.stringify(result));
        if (cb) cb(result);
      });
    });
  }

  // Overwolf only uses the manifest's `size` when it FIRST creates a window.
  // After that the window keeps the bounds it already has, so editing the
  // manifest never resizes an existing install — confirmed 2026-09-06 the hard
  // way: the overlay reported logicalBounds 300x460, the original manifest
  // size, in a session running a manifest that had said 540x800, then 640x800,
  // then 640x900. Every one of those changes was verified by rendering and
  // none of them ever reached the actual window. changeSize is the only thing
  // that moves it.
  //
  // Sizes here are logical/DIP pixels, the same units the manifest uses and
  // the same ones the page sees as CSS pixels (confirmed against a real
  // dpiScale of 1.5: manifest 300x460 -> logicalBounds 300x460 -> physical
  // 450x690), which is why auto_dpi_resize is left on.
  //
  // Idempotent: no-ops when the window is already the right size, so it's safe
  // to call on every show. Re-reads the window afterwards and logs what it
  // actually became rather than what was asked for, because a changeSize that
  // silently does nothing is exactly the failure this is here to fix.
  function ensureSize(name, width, height, cb) {
    overwolf.windows.obtainDeclaredWindow(name, function (result) {
      if (!result.success || !result.window) {
        logDiag('ensureSize(' + name + '): could not obtain window -> ' + JSON.stringify(result));
        if (cb) cb(false);
        return;
      }

      var bounds = result.window.logicalBounds || {};
      if (bounds.width === width && bounds.height === height) {
        if (cb) cb(true);
        return;
      }

      var line = 'ensureSize(' + name + '): logical ' + bounds.width + 'x' + bounds.height +
        ' -> ' + width + 'x' + height + ' (dpiScale=' + result.window.dpiScale + ')';
      logDiag(line);
      if (window.DejaVuFileLog) DejaVuFileLog.logImportant('[windows] ' + line);

      overwolf.windows.changeSize({
        window_id: result.window.id,
        width: width,
        height: height,
        auto_dpi_resize: true
      }, function (res) {
        overwolf.windows.obtainDeclaredWindow(name, function (after) {
          var got = (after.success && after.window && after.window.logicalBounds) || {};
          var done = 'ensureSize(' + name + ') result: ' + JSON.stringify(res) +
            ' — window is now logical ' + got.width + 'x' + got.height;
          logDiag(done);
          if (window.DejaVuFileLog) DejaVuFileLog.logImportant('[windows] ' + done);
          if (cb) cb(got.width === width && got.height === height);
        });
      });
    });
  }

  return { show: show, hide: hide, ensureSize: ensureSize };
})();
