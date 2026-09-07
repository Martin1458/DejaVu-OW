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
// - onPlayerRecognized(livePlayer, priorRecord, lastResult, lastHero, matchStats, fullRecord, matchesAgo)
//     priorRecord: the player's stored record from BEFORE this match's sighting
//       was written (null if never seen before) — read once and cached per
//       match, so "times played together" stays stable across repeated emits.
//       Also carries last_seen (any tier) and hero_counts (Standard+, plan §11
//       C3) for the overlay to compute "most-played hero" from directly.
//     lastResult: { result, timestamp, was_teammate } from their most recent
//       *other* completed match, or null (never played together before, or
//       that history only exists under Basic tier, which records nothing here).
//     lastHero: hero name string from their most recent *other* match together
//       (plan §11 C2), or null — same Standard-tier-only caveat as lastResult.
//     matchStats: { kills, deaths } against this player from THIS match only
//       (Full tier only) — updated live as kill_feed events resolve, re-emitted
//       immediately rather than waiting for the next roster tick.
//     fullRecord: DejaVuStorage.getRecordAgainst(tag)'s summary (wins/losses,
//       split by teammate/enemy), or null — same Standard-tier-only caveat as
//       lastResult, read once and cached per match like everything else here.
//     lastSide: true if they were on your team the last time you shared a match,
//       false if they were against you, null if unknown (never met before, or
//       Basic tier, which records no per-match rows to read it from)
//     matchesAgo: how many matches since you last saw them (any tier), or null
//       if unknown (first-ever sighting, or a record from before this field
//       existed) — see DejaVuSettings.getTotalMatchesPlayed/incrementTotal...
// - onMatchReset()  fired on match_start, alongside the session's own reset
// - onMatchResult(result)  fired when the live match's own outcome resolves
// - onRosterSync(activeTags)  every roster tick, the full set of battlenet_tags
//     currently in the lobby — lets a consumer drop anyone who has left, which
//     a per-slot delta can't express (a departure is an absence, not an update)

var DejaVuMatchSession = (function () {
  var recordedThisMatch = {}; // battlenet_tag -> true, write-once guard
  var priorRecordCache = {};  // battlenet_tag -> prior record (or null), cached per match
  var lastResultCache = {};   // battlenet_tag -> lastResult (or null), cached per match
  var lastHeroCache = {};     // battlenet_tag -> lastHero (or null), cached per match
  var fullRecordCache = {};   // battlenet_tag -> getRecordAgainst() summary (or null), cached per match
  var matchesAgoCache = {};   // battlenet_tag -> matches-since-last-seen (or null), cached per match
  var lastSideCache = {};     // battlenet_tag -> was_teammate last time you met (or null), cached per match
  var matchStatsByTag = {};   // battlenet_tag -> { kills, deaths } against them, this match only
  var lastLivePlayerByTag = {}; // battlenet_tag -> most recent live roster entry, for out-of-band re-emits
  var lastKnownHeroByTag = {}; // battlenet_tag -> hero_name last seen them on, this match only (for swap detection)
  var selfCleanupDoneForTag = null; // localTag already cleaned up this session, or null
  var handlers = {};

  var currentTier = 'basic';
  var currentEncounterId = null;
  var currentMatchNumber = null; // DejaVuSettings' running match counter, as of this match (plan §11, recency)
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
    fullRecordCache = {};
    matchesAgoCache = {};
    lastSideCache = {};
    matchStatsByTag = {};
    lastLivePlayerByTag = {};
    lastKnownHeroByTag = {};
    knownMatchInfo = {};
    localTag = null;
    nameToTag = {};
    currentTier = DejaVuSettings.getDetailLevel();
    currentEncounterId = null;
    // Bumped once per match_start regardless of tier — recency ("N matches
    // ago") works even at Basic, since it's just this counter's diff, not
    // anything read from the encounters/encounter_participants stores.
    currentMatchNumber = DejaVuSettings.incrementTotalMatchesPlayed();

    logDiag('resetMatch: detail level = ' + currentTier);
    if (window.DejaVuFileLog) DejaVuFileLog.logImportant('[match-session] resetMatch: detail level = ' + currentTier);

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
      bumpMatchStat(victimTag, 'kills');
      DejaVuStorage.recordKillEvent(currentEncounterId, victimTag, 'kills_on_them').catch(function (err) {
        logDiag('failed to record kill on ' + victimTag + ': ' + err);
      });
    } else if (victimTag === localTag && attackerTag !== localTag) {
      logDiag('kill_feed: ' + attackerTag + ' killed you');
      bumpMatchStat(attackerTag, 'deaths');
      DejaVuStorage.recordKillEvent(currentEncounterId, attackerTag, 'deaths_to_them').catch(function (err) {
        logDiag('failed to record death to ' + attackerTag + ': ' + err);
      });
    }
  }

  // Updates this match's own K/D-against-them counter and re-emits that
  // player's row right away, rather than waiting for the next roster tick —
  // roster ticks are frequent in practice but a kill should feel instant.
  function bumpMatchStat(tag, field) {
    if (!matchStatsByTag[tag]) matchStatsByTag[tag] = { kills: 0, deaths: 0 };
    matchStatsByTag[tag][field]++;

    var player = lastLivePlayerByTag[tag];
    if (player && priorRecordCache.hasOwnProperty(tag)) {
      emitRecognized(player, priorRecordCache[tag], lastResultCache[tag] || null,
        lastHeroCache[tag] || null, matchStatsByTag[tag], fullRecordCache[tag] || null,
        matchesAgoCache[tag], lastSideCache[tag]);
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

  function emitRecognized(player, priorRecord, lastResult, lastHero, matchStats, fullRecord, matchesAgo, lastSide) {
    if (handlers.onPlayerRecognized) {
      handlers.onPlayerRecognized(player, priorRecord, lastResult, lastHero,
        matchStats || { kills: 0, deaths: 0 }, fullRecord || null, matchesAgo != null ? matchesAgo : null,
        lastSide === true || lastSide === false ? lastSide : null);
    }
  }

  // Hero-swap tally (plan §11 C3, 2026-09-06): "most played" needs every hero
  // they've picked, not just whichever one they happened to be on when first
  // recognized. Counts per *pick* (a change in hero_name), not per roster
  // tick, so a whole match on one hero is +1, not hundreds — a proxy for "how
  // often picked" rather than time-weighted, but simple and immune to tick
  // frequency. UNKNOWN/null is the known end-of-match null-out (§10), not a
  // real pick. Callers must only invoke this once the tag's `players` row is
  // guaranteed to exist — see the two call sites in handleRoster below.
  //
  // Also backfills this match's own encounter_participants row (plan §11 C2).
  // That row is created at first sighting — a second or two after match_start,
  // when GEP still reports every hero as "UNKNOWN" — so writing it once and
  // never revisiting it meant the stored hero was a placeholder essentially
  // always (confirmed 2026-09-06: 96% of stored participant heroes were
  // UNKNOWN/null), and the overlay's last-played-hero icon had nothing real to
  // draw. Updating it here, on the same signal that already detects a real
  // hero, leaves the row holding the last hero they were actually seen on.
  function trackHeroPick(tag, heroName) {
    if (currentTier === 'basic' || !heroName || heroName === 'UNKNOWN') return;
    if (lastKnownHeroByTag[tag] === heroName) return;
    lastKnownHeroByTag[tag] = heroName;
    DejaVuStorage.bumpHeroPick(tag, heroName).catch(function (err) {
      logDiag('failed to record hero pick for ' + tag + ': ' + err);
    });
    if (currentEncounterId) {
      DejaVuStorage.updateParticipantHero(currentEncounterId, tag, heroName).catch(function (err) {
        logDiag('failed to update participant hero for ' + tag + ': ' + err);
      });
    }
  }

  function handleRoster(players, changed) {
    // rebuilt from the full roster (not just this call's changed slots) so it
    // stays complete even though roster updates arrive as partial per-slot
    // deltas (see gep-listener.js's rosterBySlot merge)
    nameToTag = {};
    var activeTags = [];
    players.forEach(function (player) {
      if (player.player_name && player.battlenet_tag) {
        nameToTag[player.player_name.toUpperCase()] = player.battlenet_tag;
      }
      if (player.battlenet_tag) {
        activeTags.push(player.battlenet_tag);
      }
      if (player.is_local && player.battlenet_tag) {
        localTag = player.battlenet_tag;
      }
    });

    // One-time cleanup for damage the is_local-flip bug above already did in
    // past sessions: if the local player somehow has their own `players` row
    // (and any encounter_participants rows under their own tag) from before
    // this fix, wipe it. Harmless/no-op if there was never one — deletePlayer
    // just won't find anything to delete. Runs at most once per local tag per
    // background-page lifetime, not every roster tick.
    if (localTag && selfCleanupDoneForTag !== localTag) {
      selfCleanupDoneForTag = localTag;
      DejaVuStorage.deletePlayer(localTag).then(function () {
        logDiag('self-record cleanup: removed any stray record for own tag ' + localTag);
      }).catch(function (err) {
        logDiag('self-record cleanup failed for ' + localTag + ': ' + err);
      });
    }

    // Told on every roster tick, not just when someone leaves — the consumer
    // diffs against what it's currently showing and only acts on a real
    // change. Passed the full roster rather than the changed slots, since a
    // departure shows up as an absence, which a delta can't express.
    if (handlers.onRosterSync) handlers.onRosterSync(activeTags);

    changed.forEach(function (player) {
      var tag = player.battlenet_tag;

      // Confirmed 2026-09-05/06: right around match_end, GEP sends one last
      // partial update for the LOCAL player's own slot with is_local flipped
      // to false (alongside the already-known null-out of hero/stat fields —
      // see §10) — a real payload seen in testing:
      // {"is_local":false,"hero_name":"UNKNOWN",...,"battlenet_tag":"Martin1458#2699"}
      // Trusting the per-tick is_local flag alone let the local player slip
      // through this guard once per match and get recorded as if they were an
      // opponent — encounter_count on their own tag was climbing by 1 every
      // match. localTag is only ever set from a *true* is_local sighting
      // (never reset by a later false one, see the players.forEach above), so
      // it's stable across this corruption and used as a second, reliable
      // check instead of trusting is_local alone.
      if (player.is_local || (tag && tag === localTag)) return;

      if (!tag) return; // identity not resolved for this slot yet — wait for a later update

      lastLivePlayerByTag[tag] = player;

      if (priorRecordCache.hasOwnProperty(tag)) {
        // already resolved their prior record this match — just re-emit with
        // whatever's fresh on the live roster entry (hero, team, etc.). Their
        // `players` row is guaranteed to already exist by this point (either
        // from a past match, or from this match's own first-sighting branch
        // below), so it's safe to tally a hero swap here directly.
        trackHeroPick(tag, player.hero_name);
        emitRecognized(player, priorRecordCache[tag], lastResultCache[tag] || null,
          lastHeroCache[tag] || null, matchStatsByTag[tag], fullRecordCache[tag] || null,
          matchesAgoCache[tag], lastSideCache[tag]);
        return;
      }

      Promise.all([
        DejaVuStorage.getPlayer(tag),
        DejaVuStorage.getLastResult(tag),
        DejaVuStorage.getLastHero(tag),
        DejaVuStorage.getRecordAgainst(tag),
        DejaVuStorage.getLastEncounter(tag)
      ]).then(function (results) {
        var priorRecord = results[0] || null;
        var lastResult = results[1] || null;
        var lastHero = results[2] || null;
        var fullRecord = results[3] || null;
        // the current match's own encounters row can already exist (created at
        // match_start) but shouldn't count as "last time" for itself
        if (lastResult && lastResult.encounter_id === currentEncounterId) lastResult = null;
        // Same self-exclusion as lastResult above: this match already has its own
        // encounter row by now, and "last time" must never mean "this time".
        var lastEncounter = results[4] || null;
        if (lastEncounter && lastEncounter.encounter_id === currentEncounterId) lastEncounter = null;
        var lastSide = (lastEncounter && typeof lastEncounter.was_teammate === 'boolean') ?
          lastEncounter.was_teammate : null;

        // "N matches ago" — the running match counter's value at their last
        // sighting vs. this match's own number. null (not 0) when unknown —
        // first-ever sighting, or a record predating this field — so the
        // overlay can tell "no data" apart from "0 matches ago" (impossible,
        // since a prior sighting can't be from the match happening right now).
        var matchesAgo = (priorRecord && priorRecord.last_seen_match_number != null) ?
          (currentMatchNumber - priorRecord.last_seen_match_number) : null;

        priorRecordCache[tag] = priorRecord;
        lastResultCache[tag] = lastResult;
        lastHeroCache[tag] = lastHero;
        fullRecordCache[tag] = fullRecord;
        matchesAgoCache[tag] = matchesAgo;
        lastSideCache[tag] = lastSide;
        // One-time-per-tag-per-match summary of what history the overlay row
        // will actually have to show — cheap (fires once per new player per
        // match, not per re-emit) and exactly the data needed to tell "no
        // history to show" apart from "have history but didn't render it".
        var recognizedLine = 'recognized ' + tag + ': priorRecord=' + (priorRecord ?
          ('encounters=' + priorRecord.encounter_count + ' kills_on_them=' + (priorRecord.kills_on_them || 0) +
            ' deaths_to_them=' + (priorRecord.deaths_to_them || 0) +
            ' hero_counts=' + JSON.stringify(priorRecord.hero_counts || {})) : 'none') +
          ' lastResult=' + (lastResult ? lastResult.result : 'none') +
          ' lastHero=' + (lastHero || 'none') +
          ' fullRecord=' + (fullRecord ? JSON.stringify(fullRecord) : 'none') +
          ' matchesAgo=' + (matchesAgo != null ? matchesAgo : 'none') +
          ' lastSide=' + (lastSide === null ? 'none' : (lastSide ? 'teammate' : 'enemy'));
        logDiag(recognizedLine);
        if (window.DejaVuFileLog) DejaVuFileLog.logImportant('[match-session] ' + recognizedLine);
        emitRecognized(player, priorRecord, lastResult, lastHero, matchStatsByTag[tag], fullRecord, matchesAgo, lastSide);

        var writes = [];
        if (!recordedThisMatch[tag]) {
          recordedThisMatch[tag] = true;
          // Queued first, deliberately: recordEncounter creates this tag's
          // `players` row if it doesn't exist yet. IndexedDB serializes
          // same-store transactions in the order they're *created*, not by
          // when they resolve, so calling this before trackHeroPick below
          // guarantees the row exists by the time bumpHeroPick's own
          // transaction actually runs — even for a player's very first-ever
          // sighting. Calling them in the other order silently dropped that
          // first pick (bumpHeroPick no-ops if the row isn't there yet).
          writes.push(DejaVuStorage.recordEncounter(tag, player.player_name, player.is_teammate, currentMatchNumber));
          if (currentTier !== 'basic' && currentEncounterId) {
            writes.push(DejaVuStorage.addEncounterParticipant(currentEncounterId, tag, player.is_teammate, player.hero_name));
          }
        }
        trackHeroPick(tag, player.hero_name);
        if (writes.length) return Promise.all(writes);
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
