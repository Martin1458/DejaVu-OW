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

  var buffer = [];
  var filePath = null;
  var pendingFlush = null;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function timestampForFilename(date) {
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
      '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  }

  function init() {
    var now = new Date();
    filePath = overwolf.io.paths.documents + '\\DejaVu-OW\\logs\\gep-' + timestampForFilename(now) + '.txt';
    log('=== DejaVu GEP log started ' + now.toISOString() + ' ===');
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

  function scheduleFlush() {
    if (pendingFlush) return;
    pendingFlush = window.setTimeout(function () {
      pendingFlush = null;
      flush();
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

  function getPath() {
    return filePath;
  }

  return { init: init, log: log, flush: flush, getPath: getPath };
})();
