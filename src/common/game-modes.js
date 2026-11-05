// Game modes (2026-11-05) — which kind of match an `encounters` row was, and
// whether the user wants that kind counted in stats. Everything is still
// saved regardless; exclusion happens at read time only, so ticking a mode
// back on restores its history instantly.
//
// GEP sends two relevant fields (Overwolf's Overwatch GEP docs): `game_type`
// (match_info category, but only with the `game_info` feature enabled) — e.g.
// UNRANKED, RANKED, ARCADE, DEATHMATCH — and `game_mode` (game_info
// category), a numeric id with leading zeros dropped. game_mode is checked for
// the deathmatch ids too, in case game_type hasn't arrived for a match.
//
// Rows from before this existed have neither field and classify as 'unknown',
// which always counts — so old history keeps behaving exactly as before.

var DejaVuGameModes = (function () {
  var DEATHMATCH_MODE_IDS = ['29', '30', '89']; // Team DM, DM, Snowball DM

  var TYPE_TO_KEY = {
    RANKED: 'competitive',
    UNRANKED: 'quickplay',
    ARCADE: 'arcade',
    DEATHMATCH: 'deathmatch',
    SKIRMISH: 'skirmish',
    CUSTOM_GAME: 'custom',
    PRACTICE: 'practice',
    VS_AI: 'practice',
    TUTORIAL: 'practice',
    HERO_MASTERY: 'practice',
    HERO_MASTERY_SOLO: 'practice'
  };

  // Order here is the order the Settings checkboxes appear in.
  var LABELS = {
    competitive: 'Competitive',
    quickplay: 'Quick Play',
    arcade: 'Arcade',
    deathmatch: 'Deathmatch',
    skirmish: 'Skirmish',
    custom: 'Custom Game',
    practice: 'Practice / vs AI'
  };
  var KEYS = Object.keys(LABELS);

  // For the overlay's recency sub-line, which already sits close to wrapping
  // (see overlay-controller.js's window-width notes).
  var SHORT_LABELS = {
    competitive: 'Comp', quickplay: 'QP', arcade: 'Arcade', deathmatch: 'DM',
    skirmish: 'Skirmish', custom: 'Custom', practice: 'Practice'
  };

  function shortLabel(key) {
    return SHORT_LABELS[key] || '';
  }

  function classify(enc) {
    if (!enc) return 'unknown';
    var type = enc.game_type ? String(enc.game_type).toUpperCase() : null;
    var mode = enc.game_mode != null ? String(enc.game_mode).replace(/^0+/, '') : null;
    if (type === 'DEATHMATCH' || (mode && DEATHMATCH_MODE_IDS.indexOf(mode) !== -1)) return 'deathmatch';
    return (type && TYPE_TO_KEY[type]) || 'unknown';
  }

  function label(key) {
    return LABELS[key] || '';
  }

  function excludedModes() {
    return typeof DejaVuSettings !== 'undefined' ? DejaVuSettings.getExcludedModes() : [];
  }

  // `excluded` is optional — pass it when checking many rows in one pass, so
  // settings aren't re-read (and re-parsed) per row.
  function isCounted(enc, excluded) {
    var key = classify(enc);
    if (key === 'unknown') return true;
    return (excluded || excludedModes()).indexOf(key) === -1;
  }

  function emptyTotals() {
    return {
      encounters: 0, teammate: 0, enemy: 0, kills: 0, deaths: 0,
      hero_counts: {}, last_excluded: 0, last_counted: 0
    };
  }

  // Folds one participant row (plus its encounter) into a per-player totals
  // object: excluded rows add to the amounts to subtract, counted rows only
  // track the newest counted timestamp for last_seen.
  function addToTotals(totals, participant, enc, counted) {
    if (counted) {
      if (enc.timestamp > totals.last_counted) totals.last_counted = enc.timestamp;
      return;
    }
    totals.encounters++;
    if (participant.was_teammate === true) totals.teammate++;
    else if (participant.was_teammate === false) totals.enemy++;
    totals.kills += participant.kills || 0;
    totals.deaths += participant.deaths || 0;
    var picks = participant.hero_picks || {};
    Object.keys(picks).forEach(function (hero) {
      totals.hero_counts[hero] = (totals.hero_counts[hero] || 0) + picks[hero];
    });
    if (enc.timestamp > totals.last_excluded) totals.last_excluded = enc.timestamp;
  }

  // A copy of a `players` row with excluded matches taken back out of its
  // running totals. Those totals are written live, before a match's mode is
  // known, so subtracting at read time is what keeps "still saves everything"
  // true. Clamped at 0: a player's counters can predate their participant
  // rows (Basic tier, or rows lost to old bugs), never the other way round.
  function applyExclusions(player, totals) {
    if (!player || !totals || !totals.encounters) return player;
    var copy = {};
    Object.keys(player).forEach(function (key) { copy[key] = player[key]; });
    function minus(field, amount) {
      copy[field] = Math.max(0, (player[field] || 0) - amount);
    }
    minus('encounter_count', totals.encounters);
    minus('as_teammate_count', totals.teammate);
    minus('as_enemy_count', totals.enemy);
    minus('kills_on_them', totals.kills);
    minus('deaths_to_them', totals.deaths);
    if (player.hero_counts) {
      copy.hero_counts = {};
      Object.keys(player.hero_counts).forEach(function (hero) {
        var left = player.hero_counts[hero] - (totals.hero_counts[hero] || 0);
        if (left > 0) copy.hero_counts[hero] = left;
      });
    }
    // The newest sighting was an excluded match: last seen falls back to the
    // newest counted one, or to nothing if every match together was excluded.
    if (totals.last_excluded >= totals.last_counted) {
      copy.last_seen = totals.last_counted || (copy.encounter_count ? player.last_seen : null);
    }
    copy.only_excluded = copy.encounter_count === 0;
    return copy;
  }

  return {
    KEYS: KEYS,
    classify: classify,
    label: label,
    shortLabel: shortLabel,
    isCounted: isCounted,
    excludedModes: excludedModes,
    emptyTotals: emptyTotals,
    addToTotals: addToTotals,
    applyExclusions: applyExclusions
  };
})();
