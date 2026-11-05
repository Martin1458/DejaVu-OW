// Run: node tools/test-game-modes.js. Pure logic only, no IndexedDB or GEP.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
let excluded = [];
const context = { DejaVuSettings: { getExcludedModes: () => excluded } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'src/common/game-modes.js'), 'utf8'), context);
const M = context.DejaVuGameModes;

// classify
const types = { RANKED: 'competitive', UNRANKED: 'quickplay', ARCADE: 'arcade', DEATHMATCH: 'deathmatch',
  SKIRMISH: 'skirmish', CUSTOM_GAME: 'custom', PRACTICE: 'practice', VS_AI: 'practice', TUTORIAL: 'practice',
  HERO_MASTERY: 'practice', HERO_MASTERY_SOLO: 'practice', UNKNOWN: 'unknown' };
Object.keys(types).forEach(t => assert.equal(M.classify({ game_type: t }), types[t], t));
assert.equal(M.classify({ game_mode: '30' }), 'deathmatch', 'DM id without game_type');
assert.equal(M.classify({ game_mode: '0029' }), 'deathmatch', 'leading zeros');
assert.equal(M.classify({ game_type: 'ARCADE', game_mode: 89 }), 'deathmatch', 'snowball DM beats arcade');
assert.equal(M.classify({}), 'unknown');
assert.equal(M.classify(null), 'unknown');
assert.equal(M.label('quickplay'), 'Quick Play');
assert.equal(M.label('unknown'), '');

// isCounted
excluded = ['deathmatch'];
assert.equal(M.isCounted({ game_type: 'DEATHMATCH' }), false);
assert.equal(M.isCounted({ game_type: 'UNRANKED' }), true);
assert.equal(M.isCounted({}), true, 'legacy rows always count');
assert.equal(M.isCounted({ game_type: 'UNRANKED' }, ['quickplay']), false, 'explicit list wins');

// totals + applyExclusions
const t = M.emptyTotals();
M.addToTotals(t, { was_teammate: true, kills: 3, deaths: 1, hero_picks: { Tracer: 2 } }, { timestamp: 300 }, false);
M.addToTotals(t, { was_teammate: false }, { timestamp: 100 }, true);
assert.equal(t.encounters, 1);
assert.equal(t.last_excluded, 300);
assert.equal(t.last_counted, 100);
const player = { battlenet_tag: 'A#1', encounter_count: 2, as_teammate_count: 1, as_enemy_count: 1,
  kills_on_them: 5, deaths_to_them: 1, hero_counts: { Tracer: 2, Mercy: 1 }, last_seen: 300 };
const out = M.applyExclusions(player, t);
assert.equal(out.encounter_count, 1);
assert.equal(out.as_teammate_count, 0);
assert.equal(out.as_enemy_count, 1);
assert.equal(out.kills_on_them, 2);
assert.equal(out.deaths_to_them, 0, 'clamped at 0');
assert.deepEqual(Object.assign({}, out.hero_counts), { Mercy: 1 });
assert.equal(out.last_seen, 100, 'last seen falls back to last counted match');
assert.equal(out.only_excluded, false);
assert.equal(player.encounter_count, 2, 'input not mutated');

const onlyDm = M.emptyTotals();
M.addToTotals(onlyDm, { was_teammate: true }, { timestamp: 50 }, false);
const gone = M.applyExclusions({ encounter_count: 1, as_teammate_count: 1, last_seen: 50 }, onlyDm);
assert.equal(gone.only_excluded, true);
assert.equal(gone.last_seen, null);
assert.equal(M.applyExclusions(player, M.emptyTotals()), player, 'nothing excluded returns the row as-is');
assert.equal(M.applyExclusions(null, t), null);

console.log('PASS: classify (types, DM ids, legacy), labels, isCounted, totals, applyExclusions (subtract, clamp, heroes, last_seen, only_excluded).');
