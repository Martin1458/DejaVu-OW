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
  // updating the teammate/enemy split. matchNumber (plan §11, 2026-09-06) is
  // DejaVuSettings' running total-matches-played counter as of *this* match —
  // stashed as last_seen_match_number so a later sighting can compute "N
  // matches ago" by diffing against the counter's value at that later time,
  // without needing per-player match logs. Optional/nullable so callers that
  // don't have it yet (or legacy records from before this field existed)
  // degrade to "unknown" rather than a wrong number.
  //
  // Also owns display-name history (plan §11 A5) and migrates older records
  // that predate notes/tags/name_history/hero_counts in place, rather than
  // needing a DB version bump — those fields are just plain properties
  // IndexedDB doesn't care about until something reads/writes them.
  function recordEncounter(tag, displayName, isTeammate, matchNumber) {
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
            last_seen_match_number: null,
            encounter_count: 0,
            as_teammate_count: 0,
            as_enemy_count: 0,
            kills_on_them: 0,
            deaths_to_them: 0,
            hero_counts: {}
          };

          if (record.notes === undefined) record.notes = '';
          if (record.tags === undefined) record.tags = [];
          if (record.kills_on_them === undefined) record.kills_on_them = 0;
          if (record.deaths_to_them === undefined) record.deaths_to_them = 0;
          if (record.last_seen_match_number === undefined) record.last_seen_match_number = null;
          if (!record.hero_counts) record.hero_counts = {};
          if (!record.name_history) {
            record.name_history = record.display_name ?
              [{ name: record.display_name, timestamp: record.first_seen || now }] : [];
          }

          if (displayName && displayName !== record.display_name) {
            record.name_history.push({ name: displayName, timestamp: now });
            record.display_name = displayName;
          }

          record.last_seen = now;
          if (matchNumber != null) record.last_seen_match_number = matchNumber;
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

  // "UNKNOWN" is GEP's own placeholder for a hero it hasn't resolved (or has
  // just nulled out at match_end, §10) — not a hero. Storing it verbatim made
  // it indistinguishable from a real pick on read, so it's normalized to null
  // at every write/read boundary here.
  function realHeroName(heroName) {
    return (heroName && heroName !== 'UNKNOWN') ? heroName : null;
  }

  // Standard tier: links one recognized player to one match (§4.3). was_teammate
  // may be undefined if GEP hasn't resolved team info for this slot yet. heroName
  // (plan §11 C2) is whatever hero they were on at the moment we wrote this row —
  // in practice almost always "UNKNOWN"/null, since recognition happens within a
  // second or two of match_start and GEP resolves heroes well after that. The row
  // is created here and its hero filled in later by updateParticipantHero once a
  // real one arrives, rather than being written once and left as a placeholder.
  function addEncounterParticipant(encounterId, tag, wasTeammate, heroName) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('encounter_participants', 'readwrite');
        tx.objectStore('encounter_participants').add({
          encounter_id: encounterId,
          battlenet_tag: tag,
          was_teammate: wasTeammate,
          hero_name: realHeroName(heroName)
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Fills in (or replaces) the hero on this match's participant row for one
  // player — called from match-session.js's hero-change tracking, so the row
  // ends up holding the last real hero they were seen on this match instead of
  // whatever placeholder was current at first sighting. Silently no-ops if the
  // row isn't there yet; the next hero change will catch it.
  function updateParticipantHero(encounterId, tag, heroName) {
    var hero = realHeroName(heroName);
    if (!encounterId || !hero) return Promise.resolve();

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('encounter_participants', 'readwrite');
        var idx = tx.objectStore('encounter_participants').index('encounter_id');
        var cursorReq = idx.openCursor(IDBKeyRange.only(encounterId));
        cursorReq.onsuccess = function (event) {
          var cursor = event.target.result;
          if (!cursor) return;
          if (cursor.value.battlenet_tag === tag) {
            var row = cursor.value;
            row.hero_name = hero;
            cursor.update(row);
          } else {
            cursor.continue();
          }
        };

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

  // Plan §11 ask (2026-09-06): "what character they play the most", not just
  // the last one — people swap heroes mid-match, so a single `hero_name` per
  // match (encounter_participants, used by getLastHero) can't answer that.
  // match-session.js calls this once per detected hero *change* (including
  // the first sighting), not per roster tick, so a full match on one hero is
  // one increment, not hundreds — a rough "how often picked" proxy rather
  // than time-weighted, but simple and avoids inflating by tick frequency.
  // Standard+ tier only, same as the rest of the hero-history features (C2).
  function bumpHeroPick(tag, heroName) {
    if (!heroName) return Promise.resolve();
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('players', 'readwrite');
        var store = tx.objectStore('players');

        var getReq = store.get(tag);
        getReq.onsuccess = function () {
          var record = getReq.result;
          if (!record) return; // sighting write should always precede this — nothing to bump onto
          if (!record.hero_counts) record.hero_counts = {};
          record.hero_counts[heroName] = (record.hero_counts[heroName] || 0) + 1;
          store.put(record);
        };

        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Hero they were on the most recent time you were in a match together (plan
  // §11 C2), regardless of that match's result — separate from getLastResult
  // because a match can have a hero on record without a resolved outcome yet.
  // Rows written before updateParticipantHero existed overwhelmingly hold the
  // literal string "UNKNOWN" (GEP's unresolved-hero placeholder, captured at
  // first sighting), which a bare truthiness filter happily treated as a real
  // hero — the overlay then drew a "?" placeholder for every repeat player
  // instead of an icon. realHeroName drops those the same way the write path
  // now does, so legacy rows read as "no hero on record" rather than garbage.
  function getLastHero(tag) {
    return getParticipantsForPlayer(tag).then(function (participantRows) {
      var withHero = participantRows.filter(function (p) { return realHeroName(p.hero_name); });
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

  // Which side they were on the most recent time you shared a match (plan §11,
  // 2026-09-06 ask: "did I play with or against them last time"). Deliberately
  // separate from getLastHero even though both walk the same rows: getLastHero
  // wants the most recent match that has a *real hero* on record, whereas this
  // wants the most recent match full stop, since the relationship is known for
  // every row (was_teammate comes from identity fields, which §10 confirms GEP
  // never nulls out) while the hero often isn't. Standard+ tier only, same as
  // everything else backed by encounter_participants.
  function getLastEncounter(tag) {
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
              if (enc && (!best || enc.timestamp > best.timestamp)) {
                best = {
                  encounter_id: enc.encounter_id,
                  timestamp: enc.timestamp,
                  was_teammate: p.was_teammate,
                  hero_name: realHeroName(p.hero_name)
                };
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

  // Import is the only path where records enter the store without this app
  // having written them — a hand-edited, corrupted or hostile export can carry
  // any type in any field. That matters because the History Browser
  // interpolates several of these fields straight into innerHTML: a record
  // whose encounter_count is the string "<img src=x onerror=...>" executed as
  // markup when the table drew it (reproduced 2026-09-06 against the real
  // history.html). Coercing every field to its schema type on the way in means
  // a bad file can't put markup — or an object where a number belongs — into
  // the store at all, instead of every present and future read path having to
  // re-check. Returns null for a record with no usable battlenet_tag, which
  // the caller counts as skipped.
  function asText(value) {
    return typeof value === 'string' ? value : null;
  }

  function asCount(value) {
    var n = Number(value);
    return (isFinite(n) && n > 0) ? Math.floor(n) : 0;
  }

  function asTimestamp(value) {
    var n = Number(value);
    return (isFinite(n) && n > 0) ? n : null;
  }

  function sanitizeImportedPlayer(incoming) {
    if (!incoming || typeof incoming !== 'object') return null;
    var tag = asText(incoming.battlenet_tag);
    if (!tag) return null;

    var nameHistory = [];
    if (Array.isArray(incoming.name_history)) {
      incoming.name_history.forEach(function (entry) {
        if (!entry || typeof entry !== 'object') return;
        var name = asText(entry.name);
        if (name) nameHistory.push({ name: name, timestamp: asTimestamp(entry.timestamp) });
      });
    }

    var tags = [];
    if (Array.isArray(incoming.tags)) {
      incoming.tags.forEach(function (t) {
        var text = asText(t);
        if (text) tags.push(text);
      });
    }

    var heroCounts = {};
    if (incoming.hero_counts && typeof incoming.hero_counts === 'object' && !Array.isArray(incoming.hero_counts)) {
      Object.keys(incoming.hero_counts).forEach(function (hero) {
        var count = asCount(incoming.hero_counts[hero]);
        if (count > 0) heroCounts[hero] = count;
      });
    }

    return {
      battlenet_tag: tag,
      display_name: asText(incoming.display_name),
      name_history: nameHistory,
      notes: asText(incoming.notes) || '',
      tags: tags,
      first_seen: asTimestamp(incoming.first_seen),
      last_seen: asTimestamp(incoming.last_seen),
      last_seen_match_number: asCount(incoming.last_seen_match_number) || null,
      encounter_count: asCount(incoming.encounter_count),
      as_teammate_count: asCount(incoming.as_teammate_count),
      as_enemy_count: asCount(incoming.as_enemy_count),
      kills_on_them: asCount(incoming.kills_on_them),
      deaths_to_them: asCount(incoming.deaths_to_them),
      hero_counts: heroCounts
    };
  }

  // Plan §11 G3: restore/merge a previously-exported `players` array (see
  // history.js's exportJson — export only ever wrote the `players` store, not
  // encounters/encounter_participants, so that's all import can restore too;
  // match-level detail from an old install is simply not part of what export
  // ever captured). Per tag: a player not already known locally is inserted
  // as-is; a tag that already exists keeps whichever record has the higher
  // encounter_count (treated as a proxy for "more complete/more recent"),
  // replacing entirely rather than field-merging so a kept record's notes/tags
  // aren't left inconsistent with the rest of it. Returns counts rather than
  // silently succeeding so the caller can tell the user what actually happened.
  function importPlayers(records) {
    if (!Array.isArray(records)) return Promise.reject(new Error('import expects an array of player records'));
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('players', 'readwrite');
        var store = tx.objectStore('players');
        var added = 0, replaced = 0, kept = 0, skipped = 0;

        records.forEach(function (raw) {
          var incoming = sanitizeImportedPlayer(raw);
          if (!incoming) { skipped++; return; }

          var getReq = store.get(incoming.battlenet_tag);
          getReq.onsuccess = function () {
            var existing = getReq.result;
            if (!existing) {
              store.put(incoming);
              added++;
            } else if ((incoming.encounter_count || 0) > (existing.encounter_count || 0)) {
              store.put(incoming);
              replaced++;
            } else {
              kept++;
            }
          };
        });

        tx.oncomplete = function () { resolve({ added: added, replaced: replaced, kept: kept, skipped: skipped }); };
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
    updateParticipantHero: updateParticipantHero,
    recordKillEvent: recordKillEvent,
    bumpHeroPick: bumpHeroPick,
    getParticipantsForPlayer: getParticipantsForPlayer,
    getLastResult: getLastResult,
    getLastHero: getLastHero,
    getLastEncounter: getLastEncounter,
    getRecordAgainst: getRecordAgainst,
    getAllRecords: getAllRecords,
    importPlayers: importPlayers,
    clearAllPlayers: clearAllPlayers,
  };
})();
