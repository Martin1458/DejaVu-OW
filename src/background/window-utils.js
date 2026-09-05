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

  return { show: show, hide: hide };
})();
