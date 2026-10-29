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

  // Every background start used to open a new timestamped file pair, and so
  // did every History/onboarding window open — nothing ever removed them
  // (overwolf.io has no delete), and they lived under Documents, which
  // OneDrive syncs. Measured 2026-10-29: 199 files, 91MB. Now the background
  // page rotates through a fixed set of session slots and every other window
  // owns one file it overwrites, so the folder can never hold more than
  // BACKGROUND_SLOTS * 2 + one per window.
  var BACKGROUND_SLOTS = 5;
  var KEY_LOG_SLOT = 'dejavu.logSlot';

  function logDir() {
    var base = (overwolf.io.paths && overwolf.io.paths.localAppData) || overwolf.io.paths.documents;
    return base + '\\DejaVu-OW\\logs';
  }

  // Read straight from localStorage rather than via DejaVuSettings, which the
  // background page loads after this file.
  function nextBackgroundSlot() {
    var slot = 1;
    try {
      var last = parseInt(localStorage.getItem(KEY_LOG_SLOT), 10);
      slot = (isNaN(last) ? 0 : last) % BACKGROUND_SLOTS + 1;
      localStorage.setItem(KEY_LOG_SLOT, String(slot));
    } catch (e) {
      console.warn('[DejaVuFileLog] localStorage unavailable, reusing slot 1', e);
    }
    return slot;
  }

  // windowName: 'background' (the default) rotates through session slots;
  // anything else ('history', 'onboarding') gets a single file of its own.
  function init(windowName) {
    var now = new Date();
    var name = windowName || 'background';
    var base = logDir() + '\\' + (name === 'background' ? name + '-' + nextBackgroundSlot() : name);
    filePath = base + '.txt';
    importantFilePath = base + '-lifecycle.txt';
    log('=== DejaVu ' + name + ' log started ' + now.toISOString() + ' ===');
    // Queued without a flush: windows that never log anything important
    // shouldn't leave an empty lifecycle file behind. The first real
    // logImportant() writes this header along with it.
    importantBuffer.push('[' + now.toISOString() + '] === DejaVu ' + name + ' lifecycle log started ===');
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
