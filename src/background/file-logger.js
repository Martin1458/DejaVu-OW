// Writes the lines we log to a plain .txt file under Documents, so raw GEP
// output can be inspected without fighting the DevTools console. Overwolf's
// overwolf.io API has no append call — only whole-file overwrite — so we keep
// the session's lines in memory and flush the full buffer on a short debounce.

var DejaVuFileLog = (function () {
  var FLUSH_DELAY_MS = 1000;
  // Without a cap, a long play session's buffer grows unbounded (confirmed in
  // testing: 9-12MB after ~40 minutes with per-kill/per-roster-tick logging),
  // and flush() rewrites the WHOLE buffer to disk every second regardless of
  // size — that's sustained multi-MB/sec disk I/O for the entire session.
  // Keeping only the most recent lines bounds both the file size and the cost
  // of every flush.
  var MAX_LINES = 4000;
  // Lifecycle diagnostics (GEP register/unregister/setFeatures/watchdog, match
  // boundaries) are low-frequency by nature but were getting silently evicted
  // out of the main 4000-line ring buffer during any long/eventful session —
  // confirmed 2026-09-05 investigating a GEP-feed bug, where by the time the
  // log was read back every startup/registration line from earlier in the same
  // session was already gone, pushed out by roster-update spam. Written to a
  // separate file with its own much-larger cap so it survives long sessions.
  var MAX_IMPORTANT_LINES = 1000;

  var buffer = [];
  var importantBuffer = [];
  var filePath = null;
  var importantFilePath = null;
  var pendingFlush = null;
  var pendingImportantFlush = null;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function timestampForFilename(date) {
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
      '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  }

  function init() {
    var now = new Date();
    var stamp = timestampForFilename(now);
    filePath = overwolf.io.paths.documents + '\\DejaVu-OW\\logs\\gep-' + stamp + '.txt';
    importantFilePath = overwolf.io.paths.documents + '\\DejaVu-OW\\logs\\gep-' + stamp + '-lifecycle.txt';
    log('=== DejaVu GEP log started ' + now.toISOString() + ' ===');
    logImportant('=== DejaVu lifecycle log started ' + now.toISOString() + ' ===');
    console.log('[DejaVuFileLog] writing to', filePath);
    return filePath;
  }

  function log(line) {
    buffer.push('[' + new Date().toISOString() + '] ' + line);
    if (buffer.length > MAX_LINES) {
      buffer.splice(0, buffer.length - MAX_LINES);
    }
    scheduleFlush();
  }

  // For rare, high-value diagnostics that must survive a long session even if
  // the main log's ring buffer has long since rolled past them.
  function logImportant(line) {
    importantBuffer.push('[' + new Date().toISOString() + '] ' + line);
    if (importantBuffer.length > MAX_IMPORTANT_LINES) {
      importantBuffer.splice(0, importantBuffer.length - MAX_IMPORTANT_LINES);
    }
    scheduleImportantFlush();
  }

  function scheduleFlush() {
    if (pendingFlush) return;
    pendingFlush = window.setTimeout(function () {
      pendingFlush = null;
      flush();
    }, FLUSH_DELAY_MS);
  }

  function scheduleImportantFlush() {
    if (pendingImportantFlush) return;
    pendingImportantFlush = window.setTimeout(function () {
      pendingImportantFlush = null;
      flushImportant();
    }, FLUSH_DELAY_MS);
  }

  function flush() {
    if (!filePath) return;
    overwolf.io.writeFileContents(
      filePath,
      buffer.join('\r\n') + '\r\n',
      overwolf.io.enums.eEncoding.UTF8,
      false,
      function (result) {
        if (!result.success) {
          console.error('[DejaVuFileLog] write failed:', result.error);
        }
      }
    );
  }

  function flushImportant() {
    if (!importantFilePath) return;
    overwolf.io.writeFileContents(
      importantFilePath,
      importantBuffer.join('\r\n') + '\r\n',
      overwolf.io.enums.eEncoding.UTF8,
      false,
      function (result) {
        if (!result.success) {
          console.error('[DejaVuFileLog] important write failed:', result.error);
        }
      }
    );
  }

  function getPath() {
    return filePath;
  }

  return { init: init, log: log, logImportant: logImportant, flush: flush, getPath: getPath };
})();
