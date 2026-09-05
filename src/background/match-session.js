// Match Session Manager (see DEJAVU_OW_PLAN.md §7) — decides which roster
// sightings are worth committing to storage, and hands the overlay a look at
// each player's PRIOR record so it can compute "times played together", plus
// their most recent completed match's result for a "last time: W/L" badge.
//
// Standard tier (§5, Phase 5): also creates one `encounters` row per match and
// one `encounter_participants` row per recognized player. The detail level is
// read fresh at each match_start (not cached across matches), so a setting
// change picked up mid-session takes effect at the next match boundary rather
// than needing its own change-notification plumbing.
//
// Two write-timing concerns carried over from Basic tier's design, both driven
// by the same lesson: GEP's match_end/game_exit aren't guaranteed to fire.
// - The `encounters` row is created at match_start, not finalized at match_end,
//   so a match with no clean ending still leaves a usable row.
// - `encounter_participants` rows are written per-sighting (write-once per tag
//   per match), same as Basic tier's player counters.
//
// handleMatchInfo has its own related lesson: GEP nulls out match_info fields
// right around match_end (we saw the same thing happen to roster stats) — only
// non-null/changed values are accepted, so a late null can't erase a map/result
// value already captured earlier in the match. match_outcome specifically also
// drives onMatchResult, confirmed against real matches to arrive as the strings
// "victory"/"defeat" (and presumably "draw"), not a boolean.
//
// Usage: DejaVuMatchSession.init({ onPlayerRecognized, onMatchReset, onMatchResult })
// - onPlayerRecognized(livePlayer, priorRecord, lastResult, lastHero)
//     priorRecord: the player's stored record from BEFORE this match's sighting
//       was written (null if never seen before) — read once and cached per
//       match, so "times played together" stays stable across repeated emits.
//     lastResult: { result, timestamp, was_teammate } from their most recent
//       *other* completed match, or null (never played together before, or
//       that history only exists under Basic tier, which records nothing here).
//     lastHero: hero name string from their most recent *other* match together
//       (plan §11 C2), or null — same Standard-tier-only caveat as lastResult.
// - onMatchReset()  fired on match_start, alongside the session's own reset
// - onMatchResult(result)  fired when the live match's own outcome resolves

var DejaVuMatchSession = (function () {
  var recordedThisMatch = {}; // battlenet_tag -> true, write-once guard
  var priorRecordCache = {};  // battlenet_tag -> prior record (or null), cached per match
  var lastResultCache = {};   // battlenet_tag -> lastResult (or null), cached per match
  var lastHeroCache = {};     // battlenet_tag -> lastHero (or null), cached per match
  var handlers = {};

  var currentTier = 'basic';
  var currentEncounterId = null;
  var knownMatchInfo = {}; // last known-good match_info fields this match
  var localTag = null;     // the local player's own battlenet_tag this match
  var nameToTag = {};      // player_name -> battlenet_tag, rebuilt from the full roster each update

  function logDiag(line) {
    console.log('[DejaVuMatchSession] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[match-session] ' + line);
  }

  function init(customHandlers) {
    handlers = customHandlers || {};
  }

  function resetMatch() {
    recordedThisMatch = {};
    priorRecordCache = {};
    lastResultCache = {};
    lastHeroCache = {};
    knownMatchInfo = {};
    localTag = null;
    nameToTag = {};
    currentTier = DejaVuSettings.getDetailLevel();
    currentEncounterId = null;

    logDiag('resetMatch: detail level = ' + currentTier);

    if (currentTier !== 'basic') {
      currentEncounterId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      DejaVuStorage.createEncounter(currentEncounterId, Date.now()).catch(function (err) {
        logDiag('failed to create encounter row: ' + err);
      });
    }

    if (handlers.onMatchReset) handlers.onMatchReset();
  }

  function handleMatchEvent(name, data) {
    if (name === 'match_start') {
      resetMatch();
    }
    if (name === 'kill_feed') {
      handleKillFeed(data);
    }
  }

  // kill_feed's own field names, per plan §2/§10: attacker/victim are display
  // names, not battlenet_tag — resolved against the live roster's name->tag map
  // built in handleRoster. A name that doesn't resolve (turret pseudo-kills,
  // hero-swap-UNKNOWN-victim quirks already seen in testing, environmental
  // deaths, etc.) is skipped rather than attributed to the wrong player. Only
  // kills/deaths directly involving the local player count here — that's the
  // scope of D1/D2/D3 (plan §11); third-party kills between two other players
  // aren't tracked.
  //
  // Confirmed against real matches: roster's player_name always comes back
  // ALL CAPS (e.g. "PEARLRAVEN"), but kill_feed's attacker/victim use the
  // name's normal display casing (e.g. "PearlRaven") — a case-sensitive
  // lookup against nameToTag silently failed on every single kill. Both sides
  // are upper-cased before lookup/storage to match reliably.
  function handleKillFeed(data) {
    if (currentTier !== 'full' || !data) return;

    var attackerName = data.attacker || data.attacker_name;
    var victimName = data.victim || data.victim_name;
    if (!attackerName || !victimName) return;

    var attackerTag = nameToTag[attackerName.toUpperCase()];
    var victimTag = nameToTag[victimName.toUpperCase()];
    if (!attackerTag || !victimTag) {
      logDiag('kill_feed unresolved: attacker="' + attackerName + '" (' + (attackerTag || 'no match') +
        ') victim="' + victimName + '" (' + (victimTag || 'no match') + ')');
      return;
    }

    if (attackerTag === localTag && victimTag !== localTag) {
      logDiag('kill_feed: you killed ' + victimTag);
      DejaVuStorage.recordKillEvent(currentEncounterId, victimTag, 'kills_on_them').catch(function (err) {
        logDiag('failed to record kill on ' + victimTag + ': ' + err);
      });
    } else if (victimTag === localTag && attackerTag !== localTag) {
      logDiag('kill_feed: ' + attackerTag + ' killed you');
      DejaVuStorage.recordKillEvent(currentEncounterId, attackerTag, 'deaths_to_them').catch(function (err) {
        logDiag('failed to record death to ' + attackerTag + ': ' + err);
      });
    }
  }

  function handleMatchInfo(fields) {
    if (fields && fields.match_outcome && handlers.onMatchResult) {
      handlers.onMatchResult(fields.match_outcome);
    }

    if (currentTier === 'basic' || !currentEncounterId || !fields) return;

    // GEP's own field is called match_outcome; the `encounters` row's field is
    // called `result` (see createEncounter). These are the same value under two
    // different names — a long-standing bug wrote match_outcome verbatim, which
    // meant `result` never got set and every completed match looked unfinished
    // to getLastResult/getRecordAgainst. Renamed here at the point of writing so
    // the stored schema stays internally consistent.
    var updates = {};
    Object.keys(fields).forEach(function (key) {
      var value = fields[key];
      if (value === null || value === undefined || value === '') return;
      if (knownMatchInfo[key] === value) return;
      knownMatchInfo[key] = value;
      var storageKey = key === 'match_outcome' ? 'result' : key;
      updates[storageKey] = value;
    });

    if (Object.keys(updates).length) {
      DejaVuStorage.updateEncounter(currentEncounterId, updates).catch(function (err) {
        logDiag('failed to update encounter row: ' + err);
      });
    }
  }

  function emitRecognized(player, priorRecord, lastResult, lastHero) {
    if (handlers.onPlayerRecognized) {
      handlers.onPlayerRecognized(player, priorRecord, lastResult, lastHero);
    }
  }

  function handleRoster(players, changed) {
    // rebuilt from the full roster (not just this call's changed slots) so it
    // stays complete even though roster updates arrive as partial per-slot
    // deltas (see gep-listener.js's rosterBySlot merge)
    nameToTag = {};
    players.forEach(function (player) {
      if (player.player_name && player.battlenet_tag) {
        nameToTag[player.player_name.toUpperCase()] = player.battlenet_tag;
      }
      if (player.is_local && player.battlenet_tag) {
        localTag = player.battlenet_tag;
      }
    });

    changed.forEach(function (player) {
      if (player.is_local) return; // never track the local player as a "known" opponent/teammate

      var tag = player.battlenet_tag;
      if (!tag) return; // identity not resolved for this slot yet — wait for a later update

      if (priorRecordCache.hasOwnProperty(tag)) {
        // already resolved their prior record this match — just re-emit with
        // whatever's fresh on the live roster entry (hero, team, etc.)
        emitRecognized(player, priorRecordCache[tag], lastResultCache[tag] || null, lastHeroCache[tag] || null);
        return;
      }

      Promise.all([
        DejaVuStorage.getPlayer(tag),
        DejaVuStorage.getLastResult(tag),
        DejaVuStorage.getLastHero(tag)
      ]).then(function (results) {
        var priorRecord = results[0] || null;
        var lastResult = results[1] || null;
        var lastHero = results[2] || null;
        // the current match's own encounters row can already exist (created at
        // match_start) but shouldn't count as "last time" for itself
        if (lastResult && lastResult.encounter_id === currentEncounterId) lastResult = null;

        priorRecordCache[tag] = priorRecord;
        lastResultCache[tag] = lastResult;
        lastHeroCache[tag] = lastHero;
        emitRecognized(player, priorRecord, lastResult, lastHero);

        if (!recordedThisMatch[tag]) {
          recordedThisMatch[tag] = true;

          var writes = [DejaVuStorage.recordEncounter(tag, player.player_name, player.is_teammate)];
          if (currentTier !== 'basic' && currentEncounterId) {
            writes.push(DejaVuStorage.addEncounterParticipant(currentEncounterId, tag, player.is_teammate, player.hero_name));
          }
          return Promise.all(writes);
        }
      }).catch(function (err) {
        logDiag('failed to process sighting for ' + tag + ': ' + err);
      });
    });
  }

  return {
    init: init,
    handleMatchEvent: handleMatchEvent,
    handleMatchInfo: handleMatchInfo,
    handleRoster: handleRoster
  };
})();
