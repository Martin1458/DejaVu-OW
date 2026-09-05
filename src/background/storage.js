// Storage Layer (see DEJAVU_OW_PLAN.md §4, §7) — thin wrapper over IndexedDB.
// Phase 2 scope: Basic-tier writes only (players store, aggregate counters).
// The encounters/encounter_participants stores are created now so the schema
// doesn't need a version bump when Standard/Full tiers (Phase 5) start writing
// per-match rows into them.

var DejaVuStorage = (function () {
  var DB_NAME = 'dejavu-ow';
  var DB_VERSION = 1;

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (event) {
        var db = event.target.result;

        if (!db.objectStoreNames.contains('players')) {
          db.createObjectStore('players', { keyPath: 'battlenet_tag' });
        }

        if (!db.objectStoreNames.contains('encounters')) {
          db.createObjectStore('encounters', { keyPath: 'encounter_id' });
        }

        if (!db.objectStoreNames.contains('encounter_participants')) {
          var participants = db.createObjectStore('encounter_participants', { autoIncrement: true });
          participants.createIndex('encounter_id', 'encounter_id', { unique: false });
          participants.createIndex('battlenet_tag', 'battlenet_tag', { unique: false });
        }
      };

      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });

    return dbPromise;
  }

  function getPlayer(tag) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('players', 'readonly').objectStore('players').get(tag);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getAllPlayers() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('players', 'readonly').objectStore('players').getAll();
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // Basic-tier write: upsert a player's aggregate record for one recognized
  // sighting this match. isTeammate may be undefined if GEP hasn't resolved
  // team info for this slot yet — the sighting is still recorded, just without
  // updating the teammate/enemy split.
  //
  // Also owns display-name history (plan §11 A5) and migrates older records
  // that predate notes/tags/name_history in place, rather than needing a DB
  // version bump — those fields are just plain properties IndexedDB doesn't
  // care about until something reads/writes them.
  function recordEncounter(tag, displayName, isTeammate) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('players', 'readwrite');
        var store = tx.objectStore('players');
        var now = Date.now();

        var getReq = store.get(tag);
        getReq.onsuccess = function () {
          var existing = getReq.result;
          var record = existing || {
            battlenet_tag: tag,
            display_name: null,
            name_history: [],
            notes: '',
            tags: [],
            first_seen: now,
            last_seen: now,
            encounter_count: 0,
            as_teammate_count: 0,
            as_enemy_count: 0,
            kills_on_them: 0,
            deaths_to_them: 0
          };

          if (record.notes === undefined) record.notes = '';
          if (record.tags === undefined) record.tags = [];
          if (record.kills_on_them === undefined) record.kills_on_them = 0;
          if (record.deaths_to_them === undefined) record.deaths_to_them = 0;
          if (!record.name_history) {
            record.name_history = record.display_name ?
              [{ name: record.display_name, timestamp: record.first_seen || now }] : [];
          }

          if (displayName && displayName !== record.display_name) {
            record.name_history.push({ name: displayName, timestamp: now });
            record.display_name = displayName;
          }

          record.last_seen = now;
          record.encounter_count += 1;
          if (isTeammate === true) record.as_teammate_count += 1;
          else if (isTeammate === false) record.as_enemy_count += 1;

          store.put(record);
        };

        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Merges arbitrary fields (notes, tags today) into an existing player record.
  // No-op if the player doesn't exist (e.g. deleted out from under an open panel).
  function updatePlayerFields(tag, fields) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('players', 'readwrite');
        var store = tx.objectStore('players');

        var getReq = store.get(tag);
        getReq.onsuccess = function () {
          var record = getReq.result;
          if (!record) return;
          Object.keys(fields).forEach(function (key) { record[key] = fields[key]; });
          store.put(record);
        };

        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Forgets one player entirely (plan §11 E3/G4): removes their aggregate
  // record and every encounter_participants row for them. Leaves the shared
  // `encounters` rows alone since other players may still reference them.
  function deletePlayer(tag) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(['players', 'encounter_participants'], 'readwrite');
        tx.objectStore('players').delete(tag);

        var idx = tx.objectStore('encounter_participants').index('battlenet_tag');
        var cursorReq = idx.openCursor(IDBKeyRange.only(tag));
        cursorReq.onsuccess = function (event) {
          var cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Standard tier (see DEJAVU_OW_PLAN.md §5): one row per match. Created at
  // match_start rather than match_end for the same reason recordEncounter fires
  // per-sighting instead of buffering — match_end/game_exit aren't guaranteed
  // to fire, so a match with no finalize step should still leave a usable row.
  function createEncounter(encounterId, timestamp) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('encounters', 'readwrite');
        tx.objectStore('encounters').put({
          encounter_id: encounterId,
          timestamp: timestamp,
          result: null,
          map: null
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Shallow-merges fields (e.g. result, map) into an existing encounters row.
  function updateEncounter(encounterId, fields) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('encounters', 'readwrite');
        var store = tx.objectStore('encounters');

        var getReq = store.get(encounterId);
        getReq.onsuccess = function () {
          var record = getReq.result;
          if (!record) return; // encounter row not created yet — caller can retry later
          Object.keys(fields).forEach(function (key) { record[key] = fields[key]; });
          store.put(record);
        };

        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Standard tier: links one recognized player to one match (§4.3). was_teammate
  // may be undefined if GEP hasn't resolved team info for this slot yet. heroName
  // (plan §11 C2) is whatever hero they were on at the moment we wrote this row —
  // written once per match same as everything else here, so it's their hero as of
  // the point in the match recognition happened, not necessarily their last hero
  // of the match if they swapped afterward.
  function addEncounterParticipant(encounterId, tag, wasTeammate, heroName) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('encounter_participants', 'readwrite');
        tx.objectStore('encounter_participants').add({
          encounter_id: encounterId,
          battlenet_tag: tag,
          was_teammate: wasTeammate,
          hero_name: heroName || null
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Every encounter_participants row for one player — the raw material for a
  // future "drill into this player's match history" view (plan §6.2).
  function getParticipantsForPlayer(tag) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var idx = db.transaction('encounter_participants', 'readonly')
          .objectStore('encounter_participants').index('battlenet_tag');
        var req = idx.getAll(tag);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // Most recent *completed* (non-null result) encounter this player was part of —
  // used for the overlay's "last time you played, you won/lost" badge. Only
  // Standard/Full-tier history produces any encounter_participants rows at all,
  // so this resolves to null for anyone only ever seen under Basic tier.
  function getLastResult(tag) {
    return getParticipantsForPlayer(tag).then(function (participantRows) {
      if (!participantRows.length) return null;

      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var store = db.transaction('encounters', 'readonly').objectStore('encounters');
          var best = null;
          var pending = participantRows.length;

          participantRows.forEach(function (p) {
            var req = store.get(p.encounter_id);
            req.onsuccess = function () {
              var enc = req.result;
              if (enc && enc.result && (!best || enc.timestamp > best.timestamp)) {
                best = { encounter_id: enc.encounter_id, result: enc.result, timestamp: enc.timestamp, was_teammate: p.was_teammate };
              }
              pending -= 1;
              if (pending === 0) resolve(best);
            };
            req.onerror = function () {
              pending -= 1;
              if (pending === 0) resolve(best);
            };
          });
        });
      });
    });
  }

  // Full tier (plan §11 D1/D2/D3): one `kill_feed` event resolved to a specific
  // known player, directly involving the local player. statField is
  // 'kills_on_them' (you killed them) or 'deaths_to_them' (they killed you) —
  // bumped as a lifetime total on the player record, plus the matching
  // per-match 'kills'/'deaths' field on their row in *this* encounter. If the
  // player doc doesn't exist yet (kill arrived before their first roster
  // sighting finished writing — realistically never happens, since kills only
  // start once a match is well underway) the lifetime bump is silently skipped
  // rather than guessed at; the per-match participant row still gets it once
  // that write lands, same write-once cache as everywhere else in this module.
  function recordKillEvent(encounterId, tag, statField) {
    var participantField = statField === 'kills_on_them' ? 'kills' : 'deaths';

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(['players', 'encounter_participants'], 'readwrite');

        var playerStore = tx.objectStore('players');
        var getPlayerReq = playerStore.get(tag);
        getPlayerReq.onsuccess = function () {
          var record = getPlayerReq.result;
          if (record) {
            record[statField] = (record[statField] || 0) + 1;
            playerStore.put(record);
          }
        };

        if (encounterId) {
          var idx = tx.objectStore('encounter_participants').index('encounter_id');
          var cursorReq = idx.openCursor(IDBKeyRange.only(encounterId));
          cursorReq.onsuccess = function (event) {
            var cursor = event.target.result;
            if (!cursor) return;
            if (cursor.value.battlenet_tag === tag) {
              var row = cursor.value;
              row[participantField] = (row[participantField] || 0) + 1;
              cursor.update(row);
            } else {
              cursor.continue();
            }
          };
        }

        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Hero they were on the most recent time you were in a match together (plan
  // §11 C2), regardless of that match's result — separate from getLastResult
  // because a match can have a hero on record without a resolved outcome yet.
  function getLastHero(tag) {
    return getParticipantsForPlayer(tag).then(function (participantRows) {
      var withHero = participantRows.filter(function (p) { return p.hero_name; });
      if (!withHero.length) return null;

      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var store = db.transaction('encounters', 'readonly').objectStore('encounters');
          var best = null;
          var pending = withHero.length;

          withHero.forEach(function (p) {
            var req = store.get(p.encounter_id);
            req.onsuccess = function () {
              var enc = req.result;
              if (enc && (!best || enc.timestamp > best.timestamp)) {
                best = { hero_name: p.hero_name, timestamp: enc.timestamp };
              }
              pending -= 1;
              if (pending === 0) resolve(best ? best.hero_name : null);
            };
            req.onerror = function () {
              pending -= 1;
              if (pending === 0) resolve(best ? best.hero_name : null);
            };
          });
        });
      });
    });
  }

  // Shared by getRecordAgainst (one player, on demand) and getAllRecords (every
  // player at once, for the History Browser table). `completed` is a list of
  // { result, timestamp, was_teammate } — only matches with a resolved result
  // belong in it. Streak looks at the most recent completed matches in a row
  // with the same outcome, teammate/enemy matches mixed together, and stops at
  // a draw rather than counting through it.
  function summarizeCompleted(completed) {
    if (!completed.length) return null;
    completed.sort(function (a, b) { return a.timestamp - b.timestamp; });

    var summary = {
      wins: 0, losses: 0, draws: 0,
      teammate_wins: 0, teammate_losses: 0, teammate_draws: 0,
      enemy_wins: 0, enemy_losses: 0, enemy_draws: 0,
      streak_type: null, streak_count: 0
    };

    completed.forEach(function (enc) {
      var bucket = enc.was_teammate ? 'teammate' : 'enemy';
      if (enc.result === 'victory') { summary.wins++; summary[bucket + '_wins']++; }
      else if (enc.result === 'defeat') { summary.losses++; summary[bucket + '_losses']++; }
      else if (enc.result === 'draw') { summary.draws++; summary[bucket + '_draws']++; }
    });

    for (var i = completed.length - 1; i >= 0; i--) {
      var r = completed[i].result;
      if (r === 'draw') break;
      if (summary.streak_type === null) { summary.streak_type = r; summary.streak_count = 1; }
      else if (r === summary.streak_type) { summary.streak_count++; }
      else break;
    }

    return summary;
  }

  // Full win/loss record together (plan §11 B3) plus current streak (§11 B4),
  // for one player — used by the History Browser's per-player detail panel.
  function getRecordAgainst(tag) {
    return getParticipantsForPlayer(tag).then(function (participantRows) {
      if (!participantRows.length) return null;

      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var store = db.transaction('encounters', 'readonly').objectStore('encounters');
          var completed = [];
          var pending = participantRows.length;

          participantRows.forEach(function (p) {
            var req = store.get(p.encounter_id);
            req.onsuccess = function () {
              var enc = req.result;
              if (enc && enc.result) {
                completed.push({ result: enc.result, timestamp: enc.timestamp, was_teammate: p.was_teammate });
              }
              pending -= 1;
              if (pending === 0) resolve(summarizeCompleted(completed));
            };
            req.onerror = function () {
              pending -= 1;
              if (pending === 0) resolve(summarizeCompleted(completed));
            };
          });
        });
      });
    });
  }

  // Same win/loss summary as getRecordAgainst, but for every known player at
  // once — one pass over the whole `encounters`/`encounter_participants` store
  // rather than N per-player queries. Used to populate the History Browser's
  // main table columns (W/L, teammate W/L, enemy W/L) without a query per row.
  // Returns a plain object keyed by battlenet_tag; a tag with no completed
  // matches together simply isn't a key in it.
  function getAllRecords() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(['encounters', 'encounter_participants'], 'readonly');
        var encounters = {};
        var participants = [];

        tx.objectStore('encounters').getAll().onsuccess = function (event) {
          event.target.result.forEach(function (enc) { encounters[enc.encounter_id] = enc; });
        };
        tx.objectStore('encounter_participants').getAll().onsuccess = function (event) {
          participants = event.target.result;
        };

        tx.oncomplete = function () {
          var completedByTag = {};
          participants.forEach(function (p) {
            var enc = encounters[p.encounter_id];
            if (!enc || !enc.result) return;
            if (!completedByTag[p.battlenet_tag]) completedByTag[p.battlenet_tag] = [];
            completedByTag[p.battlenet_tag].push({ result: enc.result, timestamp: enc.timestamp, was_teammate: p.was_teammate });
          });

          var byTag = {};
          Object.keys(completedByTag).forEach(function (tag) {
            byTag[tag] = summarizeCompleted(completedByTag[tag]);
          });

          resolve(byTag);
        };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // One-time backfill for `encounters` rows written before match-session.js
  // correctly renamed GEP's match_outcome field to this store's own `result`
  // field on write — a bug that left `result` null on every completed match
  // regardless of tier, silently breaking getLastResult/getRecordAgainst for
  // everyone. Safe to call unconditionally on every startup: rows already
  // migrated (or written after the fix) have no `match_outcome` left, so the
  // cursor just skips them.
  function migrateLegacyResults() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('encounters', 'readwrite');
        var store = tx.objectStore('encounters');
        var cursorReq = store.openCursor();
        var fixed = 0;

        cursorReq.onsuccess = function (event) {
          var cursor = event.target.result;
          if (!cursor) { return; }
          var record = cursor.value;
          if (!record.result && record.match_outcome) {
            record.result = record.match_outcome;
            delete record.match_outcome;
            cursor.update(record);
            fixed += 1;
          }
          cursor.continue();
        };

        tx.oncomplete = function () { resolve(fixed); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Wipes all known players AND their match-level history (encounters +
  // encounter_participants). Used by the History Browser's "clear history"
  // control. Clearing only `players` would leave orphaned rows behind that
  // getLastResult/getRecordAgainst/getLastHero would still find for anyone
  // re-recognized later under the same battlenet_tag — this clears all three
  // stores together so "clear history" actually means a clean slate.
  function clearAllPlayers() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(['players', 'encounters', 'encounter_participants'], 'readwrite');
        tx.objectStore('players').clear();
        tx.objectStore('encounters').clear();
        tx.objectStore('encounter_participants').clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Dev/test-only: fills the players store with plausible-looking fake records
  // so UI work (sorting, search, layout with real row counts) doesn't require
  // grinding actual matches. Not wired to anything a real user would trigger.
  function seedRandomPlayers(count) {
    count = count || 20;
    var SYLLABLES = ['Sha', 'Dow', 'Vex', 'Nyx', 'Kai', 'Zor', 'Ember', 'Frost', 'Rogue', 'Nova',
      'Pix', 'El', 'Ash', 'Storm', 'Grim', 'Luna', 'Byte', 'Rune', 'Cinder', 'Vor'];
    var DAY = 86400000;

    function randomName() {
      var parts = 1 + Math.floor(Math.random() * 2);
      var name = '';
      for (var i = 0; i < parts; i++) name += SYLLABLES[Math.floor(Math.random() * SYLLABLES.length)];
      return name;
    }

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('players', 'readwrite');
        var store = tx.objectStore('players');
        var now = Date.now();

        for (var i = 0; i < count; i++) {
          var name = randomName();
          var tag = name + '#' + (1000 + Math.floor(Math.random() * 90000));
          var encounterCount = 1 + Math.floor(Math.random() * 40);
          var teammateCount = Math.floor(Math.random() * (encounterCount + 1));
          var firstSeen = now - Math.floor(Math.random() * 120) * DAY;
          var lastSeen = firstSeen + Math.floor(Math.random() * (now - firstSeen));

          store.put({
            battlenet_tag: tag,
            display_name: name.toUpperCase(),
            name_history: [{ name: name.toUpperCase(), timestamp: firstSeen }],
            notes: '',
            tags: [],
            first_seen: firstSeen,
            last_seen: lastSeen,
            encounter_count: encounterCount,
            as_teammate_count: teammateCount,
            as_enemy_count: encounterCount - teammateCount,
            kills_on_them: Math.floor(Math.random() * encounterCount * 3),
            deaths_to_them: Math.floor(Math.random() * encounterCount * 3)
          });
        }

        tx.oncomplete = function () { resolve(count); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  return {
    getPlayer: getPlayer,
    getAllPlayers: getAllPlayers,
    recordEncounter: recordEncounter,
    updatePlayerFields: updatePlayerFields,
    deletePlayer: deletePlayer,
    migrateLegacyResults: migrateLegacyResults,
    createEncounter: createEncounter,
    updateEncounter: updateEncounter,
    addEncounterParticipant: addEncounterParticipant,
    recordKillEvent: recordKillEvent,
    getParticipantsForPlayer: getParticipantsForPlayer,
    getLastResult: getLastResult,
    getLastHero: getLastHero,
    getRecordAgainst: getRecordAgainst,
    getAllRecords: getAllRecords,
    clearAllPlayers: clearAllPlayers,
    seedRandomPlayers: seedRandomPlayers
  };
})();
