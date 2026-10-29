// Automatic backups (0.4.0). Overwolf deletes an app's IndexedDB and
// localStorage when it is uninstalled — that is how a 1,461-player history was
// lost on 2026-10-29 — but it leaves files the app wrote to disk alone. So the
// background page writes a full backup to Documents after every match, and an
// empty history on startup offers to restore the newest one.
//
// Same format as the History window's manual export, so a backup file can
// also be imported by hand. Shared by every window that touches backups
// (background, history, onboarding); each is its own JS context, so state that
// must survive between them lives on disk or in localStorage, never here.
//
// Three rotating slots. A wiped install would otherwise overwrite the last
// good backup within three matches of playing on without restoring, so the
// slot holding that backup is protected (see protectNewestIfEmpty) until the
// user either restores it or chooses to start fresh.

var DejaVuBackup = (function () {
  var FORMAT = 'dejavu-ow-backup';
  var VERSION = 2;
  var SLOTS = 3;
  var KEY_NEXT_SLOT = 'dejavu.backup.nextSlot';
  var KEY_PROTECTED_SLOT = 'dejavu.backup.protectedSlot';
  // Let the last sightings and kill writes of a match land before reading.
  var WRITE_DELAY_MS = 5000;

  var pendingWrite = null;

  function logDiag(line) {
    console.log('[DejaVuBackup] ' + line);
    if (window.DejaVuFileLog) {
      DejaVuFileLog.log('[backup] ' + line);
      DejaVuFileLog.logImportant('[backup] ' + line);
    }
  }

  function folder() {
    return overwolf.io.paths.documents + '\\DejaVu-OW\\backups';
  }

  function slotPath(slot) {
    return folder() + '\\backup-' + slot + '.json';
  }

  function readNumber(key) {
    try {
      var n = parseInt(localStorage.getItem(key), 10);
      return isNaN(n) ? null : n;
    } catch (e) {
      return null;
    }
  }

  function writeNumber(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch (e) {
      console.warn('[DejaVuBackup] localStorage write failed', e);
    }
  }

  // The whole database as one export object — used for automatic backups and
  // for the History window's manual export alike.
  function build() {
    return DejaVuStorage.getBackupData().then(function (data) {
      return {
        format: FORMAT,
        version: VERSION,
        exported_at: new Date().toISOString(),
        players: data.players,
        encounters: data.encounters,
        encounter_participants: data.encounter_participants
      };
    });
  }

  // Accepts either a full backup object or a bare players array (every export
  // before 0.4.0). Returns the three lists, or null for anything else.
  function parse(value) {
    if (Array.isArray(value)) {
      return { players: value, encounters: [], encounter_participants: [] };
    }
    if (value && value.format === FORMAT && Array.isArray(value.players)) {
      return {
        players: value.players,
        encounters: value.encounters || [],
        encounter_participants: value.encounter_participants || []
      };
    }
    return null;
  }

  // Merges a parsed backup into the store (see DejaVuStorage.importPlayers /
  // importMatchHistory for the rules). Resolves with
  // { added, replaced, kept, skipped, matches }.
  function restore(parsed) {
    var summary;
    return DejaVuStorage.importPlayers(parsed.players).then(function (result) {
      summary = result;
      return DejaVuStorage.importMatchHistory(parsed.encounters, parsed.encounter_participants);
    }).then(function (matchSummary) {
      summary.matches = matchSummary.encounters;
      return summary;
    });
  }

  function nextSlot() {
    var protectedSlot = readNumber(KEY_PROTECTED_SLOT);
    var slot = readNumber(KEY_NEXT_SLOT) || 1;
    for (var i = 0; i < SLOTS; i++) {
      if (slot !== protectedSlot) break;
      slot = slot % SLOTS + 1;
    }
    writeNumber(KEY_NEXT_SLOT, slot % SLOTS + 1);
    return slot;
  }

  // Writes one backup now. Never writes an empty history: an empty store is
  // exactly the state a backup exists to recover from, and writing it would
  // rotate a good backup out.
  function writeNow(reason, cb) {
    build().then(function (backup) {
      if (!backup.players.length) {
        logDiag('skipped (' + reason + '): history is empty');
        if (cb) cb(null);
        return;
      }
      var slot = nextSlot();
      var path = slotPath(slot);
      overwolf.io.writeFileContents(path, JSON.stringify(backup), overwolf.io.enums.eEncoding.UTF8, false, function (result) {
        if (result && result.success) {
          logDiag('wrote ' + path + ' (' + reason + '): ' + backup.players.length + ' player(s), ' + backup.encounters.length + ' match(es)');
          if (cb) cb({ slot: slot, path: path, at: backup.exported_at, players: backup.players.length });
        } else {
          logDiag('write failed (' + reason + '): ' + JSON.stringify(result));
          if (cb) cb(null);
        }
      });
    }).catch(function (err) {
      logDiag('failed to read the database (' + reason + '): ' + err);
      if (cb) cb(null);
    });
  }

  // Coalesces bursts (match_end followed quickly by something else) into one
  // write, and gives the match's last writes time to land.
  function scheduleWrite(reason) {
    if (pendingWrite) window.clearTimeout(pendingWrite);
    pendingWrite = window.setTimeout(function () {
      pendingWrite = null;
      writeNow(reason);
    }, WRITE_DELAY_MS);
  }

  function readSlot(slot, cb) {
    var path = slotPath(slot);
    overwolf.io.fileExists(path, function (exists) {
      if (!exists || !exists.found) { cb(null); return; }
      overwolf.io.readFileContents(path, overwolf.io.enums.eEncoding.UTF8, function (result) {
        if (!result || !result.success) { cb(null); return; }
        try {
          var value = JSON.parse(result.content);
          var parsed = parse(value);
          if (!parsed || !parsed.players.length) { cb(null); return; }
          cb({
            slot: slot,
            path: path,
            at: value.exported_at || null,
            players: parsed.players.length,
            matches: parsed.encounters.length,
            data: parsed
          });
        } catch (e) {
          logDiag('unreadable backup ' + path + ': ' + e);
          cb(null);
        }
      });
    });
  }

  // The most recent readable, non-empty backup on disk, or null.
  function findLatest(cb) {
    var found = [];
    var pending = SLOTS;
    for (var slot = 1; slot <= SLOTS; slot++) {
      readSlot(slot, function (backup) {
        if (backup) found.push(backup);
        pending -= 1;
        if (pending > 0) return;
        found.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
        cb(found[0] || null);
      });
    }
  }

  // Background startup: if the history is empty but a backup exists, this is
  // almost certainly a reinstall or a wipe — keep that backup from being
  // rotated out until the user decides what to do with it.
  function protectNewestIfEmpty() {
    DejaVuStorage.getAllPlayers().then(function (players) {
      if (players.length) return;
      findLatest(function (backup) {
        if (!backup) return;
        writeNumber(KEY_PROTECTED_SLOT, backup.slot);
        logDiag('history is empty, protecting ' + backup.path + ' (' + backup.players + ' players, ' + backup.at + ') until restored or dismissed');
      });
    });
  }

  // Called once the user has restored, or chosen to start fresh.
  function releaseProtection() {
    writeNumber(KEY_PROTECTED_SLOT, null);
  }

  // What a window should offer on load: the newest backup, but only while the
  // history is empty — otherwise there is nothing to recover.
  function findRestoreOffer(cb) {
    DejaVuStorage.getAllPlayers().then(function (players) {
      if (players.length) { cb(null); return; }
      findLatest(cb);
    }).catch(function () { cb(null); });
  }

  function openFolder() {
    if (overwolf.utils && overwolf.utils.openWindowsExplorer) {
      overwolf.utils.openWindowsExplorer(folder(), function () {});
    }
  }

  return {
    FORMAT: FORMAT,
    build: build,
    parse: parse,
    restore: restore,
    writeNow: writeNow,
    scheduleWrite: scheduleWrite,
    findLatest: findLatest,
    findRestoreOffer: findRestoreOffer,
    protectNewestIfEmpty: protectNewestIfEmpty,
    releaseProtection: releaseProtection,
    folder: folder,
    openFolder: openFolder
  };
})();
