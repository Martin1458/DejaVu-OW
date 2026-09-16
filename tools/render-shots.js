// Regenerates the window screenshots used by the website, by running the real
// app windows with stubbed Overwolf/storage rather than rebuilding their markup
// by hand — so what lands in docs/assets is what the app actually draws.
//
// Harnesses are written next to the real files (relative paths to ../../images,
// ../background/... must resolve) under the _preview_ prefix that
// tools/package.js refuses to ship, and are deleted again at the end.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, "..");
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('Edge not found'); process.exit(1); }

const DAY = 86400000;
const now = Date.now();

// Invented players, matching the names already used in the current store art so
// the site stays visually continuous. No real battle tags anywhere.
const PEOPLE = [
  ['NovaSpark', 2118, 7, 5, 2, 9, 4, 'Mercy', 60, 2],
  ['VantaBlue', 2231, 5, 1, 4, 6, 9, 'Widowmaker', 400, 1],
  ['DuskRunner', 1420, 4, 2, 2, 4, 4, 'Reinhardt', 120, 0.04],
  ['ToastyOwl', 2750, 3, 1, 2, 3, 2, 'Kiriko', 200, 7],
  ['Marrow', 1109, 12, 3, 9, 11, 14, 'Reaper', 300, 21],
  ['Quillfeather', 1802, 2, 2, 0, 1, 0, 'Juno', 45, 3],
  ['Pebble', 2415, 1, 0, 1, 0, 1, 'Dva', 12, 0.5],
  ['Gloam', 1337, 6, 2, 4, 5, 7, 'Moira', 150, 12],
  ['Kestrel', 2904, 9, 6, 3, 8, 5, 'Ashe', 210, 4],
  ['LanternFish', 2890, 9, 9, 0, 6, 3, 'Lucio', 190, 1.5],
  ['Hollowpoint', 2045, 6, 0, 6, 2, 8, 'Hanzo', 280, 6],
  ['Juniper', 11602, 5, 5, 0, 3, 2, 'Brigitte', 95, 9],
  ['CinderMoth', 2419, 5, 2, 3, 4, 4, 'Sombra', 175, 15],
  ['Tidewatch', 1788, 4, 0, 4, 1, 5, 'Sigma', 260, 2.5],
  ['Brightwater', 1377, 8, 3, 5, 7, 6, 'Baptiste', 240, 30],
  ['Parallax', 2562, 5, 4, 1, 5, 1, 'Genji', 110, 5],
  ['Saltmarsh', 1931, 2, 1, 1, 1, 1, 'Zarya', 70, 40],
  ['Ironleaf', 2704, 3, 0, 3, 1, 2, 'Orisa', 160, 11],
  ['Wavelength', 1159, 3, 3, 0, 2, 1, 'Ana', 130, 18],
  ['Starling', 2336, 4, 2, 2, 3, 3, 'Tracer', 100, 8]
];

const players = PEOPLE.map(([name, tagNum, enc, mate, enemy, kills, deaths, hero, firstAgo, lastAgo]) => ({
  battlenet_tag: name + '#' + tagNum,
  display_name: name,
  encounter_count: enc,
  as_teammate_count: mate,
  as_enemy_count: enemy,
  kills_on_them: kills,
  deaths_to_them: deaths,
  first_seen: now - firstAgo * DAY,
  last_seen: now - lastAgo * DAY,
  hero_counts: { [hero.toUpperCase()]: Math.max(2, Math.round(enc * 0.6)) },
  notes: name === 'NovaSpark' ? 'Great Mercy. Always pockets the Pharah, watch for the rez.' : '',
  tags: name === 'NovaSpark' ? ['Friend', 'Good healer'] : [],
  name_history: name === 'NovaSpark'
    ? [{ name: 'SparkNova', timestamp: now - 55 * DAY }, { name: 'NovaSpark', timestamp: now - 9 * DAY }]
    : []
}));

const records = {};
players.forEach((p) => {
  const tw = Math.round(p.as_teammate_count * 0.6), tl = p.as_teammate_count - tw;
  const ew = Math.round(p.as_enemy_count * 0.45), el = p.as_enemy_count - ew;
  records[p.battlenet_tag] = {
    wins: tw + ew, losses: tl + el, draws: 0,
    teammate_wins: tw, teammate_losses: tl, teammate_draws: 0,
    enemy_wins: ew, enemy_losses: el, enemy_draws: 0,
    streak_type: p.display_name === 'NovaSpark' ? 'victory' : 'defeat',
    streak_count: p.display_name === 'NovaSpark' ? 3 : 1
  };
});

// One lobby for the overlay: five per side, the shape a real match produces.
const lobby = [
  ['NovaSpark', true, 'MERCY', 'ANA'], ['LanternFish', true, 'LUCIO', 'LUCIO'],
  ['DuskRunner', true, 'REINHARDT', 'ORISA'], ['Juniper', true, 'BRIGITTE', null],
  ['Parallax', true, 'GENJI', 'TRACER'],
  ['VantaBlue', false, 'WIDOWMAKER', 'ASHE'], ['Hollowpoint', false, 'HANZO', 'HANZO'],
  ['Marrow', false, 'REAPER', 'SOMBRA'], ['Tidewatch', false, 'SIGMA', null],
  ['CinderMoth', false, 'SOMBRA', 'MOIRA']
];

const overlayRows = lobby.map(([name, mate, hero, lastHero], i) => {
  const p = players.find((x) => x.display_name === name);
  const rec = records[p.battlenet_tag];
  return {
    battlenet_tag: p.battlenet_tag,
    display_name: name,
    hero_name: hero,
    is_teammate: mate,
    times_played_together: p.encounter_count,
    last_hero: lastHero,
    kills_on_them: p.kills_on_them,
    deaths_to_them: p.deaths_to_them,
    match_kills: [2, 1, 0, 3, 1, 0, 2, 1, 0, 1][i],
    match_deaths: [1, 0, 2, 1, 1, 3, 0, 1, 2, 0][i],
    record_with: rec.teammate_wins || rec.teammate_losses ? { wins: rec.teammate_wins, losses: rec.teammate_losses } : null,
    record_against: rec.enemy_wins || rec.enemy_losses ? { wins: rec.enemy_wins, losses: rec.enemy_losses } : null,
    recency: { matchesAgo: [3, 1, 12, 5, 2, 40, 7, 1, 22, 9][i], lastSeen: p.last_seen },
    most_played_hero: { name: Object.keys(p.hero_counts)[0], count: p.hero_counts[Object.keys(p.hero_counts)[0]] },
    last_side: i % 3 === 0 ? mate : !mate
  };
});

const STUB = `<script>
(function () {
  window.DejaVuFileLog = { init: function(){}, log: function(){}, logImportant: function(){} };
  window.overwolf = {
    windows: {
      onMessageReceived: { addListener: function (f) { window.__onMessage = f; } },
      getCurrentWindow: function (cb) { cb({ success: true, window: { id: 'preview', logicalBounds: { left: 0, top: 0, width: 800, height: 600 } } }); },
      obtainDeclaredWindow: function (n, cb) { cb({ success: false }); },
      sendMessage: function () {}, dragMove: function () {}, restore: function () {},
      hide: function () {}, close: function () {}, minimize: function () {}, changeSize: function () {}, changePosition: function () {}
    },
    settings: {},
    io: { paths: { documents: 'C:\\\\Documents' }, enums: { eEncoding: { UTF8: 'UTF8' } } },
    utils: {}, games: {}, extensions: { onAppLaunchTriggered: { addListener: function () {} } }
  };
  var PLAYERS = __PLAYERS__, RECORDS = __RECORDS__;
  window.DejaVuStorage = {
    getAllPlayers: function () { return Promise.resolve(PLAYERS.slice()); },
    getAllRecords: function () { return Promise.resolve(RECORDS); },
    getRecordAgainst: function (tag) { return Promise.resolve(RECORDS[tag]); },
    updatePlayerFields: function () { return Promise.resolve(); },
    deletePlayer: function () { return Promise.resolve(); },
    clearAllPlayers: function () { return Promise.resolve(); },
    importPlayers: function () { return Promise.resolve({ imported: 0 }); }
  };
  try {
    localStorage.setItem('dejavu.detailLevel', 'full');
    localStorage.setItem('dejavu.setupComplete', 'true');
    ['showLastHero','showLifetimeKD','showMatchKD','showRecord','showRecency','showMostPlayedHero']
      .forEach(function (k) { localStorage.setItem('dejavu.overlay.' + k, 'true'); });
    localStorage.setItem('dejavu.overlayMovable', 'false');
  } catch (e) {}
})();
<\/script>`;

function harness(srcRel, outRel, tailScript) {
  const src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  // The app loads its own file-logger.js and storage.js AFTER this stub, and
  // both redefine the globals it provides — so the harness drops those two
  // script tags and lets the stub stand. Everything else (settings, hotkeys,
  // and each window's own logic) stays real.
  let out = src
    .replace(/[ \t]*<script src="[^"]*(?:file-logger|storage)\.js"><\/script>\r?\n/g, '')
    .replace('<body>', '<body>\n' + STUB
      .replace('__PLAYERS__', JSON.stringify(players))
      .replace('__RECORDS__', JSON.stringify(records)));
  out = out.replace('</body>', (tailScript ? '<script>' + tailScript + '<\/script>\n' : '') + '</body>');
  const outPath = path.join(ROOT, outRel);
  fs.writeFileSync(outPath, out);
  return outPath;
}

// How Edge actually behaves here, measured 2026-09-16 — each point cost a
// broken render before it was understood:
//  - headless Edge writes the screenshot and then does NOT exit, so waiting
//    for the process hangs forever;
//  - while any Edge is still running on a profile, a new call on that profile
//    hands its URL over and returns in ~50 ms having drawn nothing. That is how
//    every website image once came out as Edge's "File not found" page: the
//    capture happened later, after the harnesses had been deleted;
//  - a --user-data-dir written with backslashes behaved the same way, so paths
//    are passed with forward slashes.
// So each shot gets its own fresh profile, the script waits for the file to
// appear and stop growing, then kills that Edge's whole process tree itself.
const os = require('os');
const { spawn } = require('child_process');

const fwd = (p) => p.split('\\').join('/');

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
}

function shot(file, outPng, w, h, transparent) {
  const profile = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'dejavu-render-')));
  const scratchDir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'dejavu-shot-')));
  // Captured to a scratch file and copied over only once it is complete, so a
  // failed capture errors out instead of leaving a stale image looking fine.
  const scratch = scratchDir + '/' + path.basename(outPng);
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--user-data-dir=' + profile,
    '--virtual-time-budget=4000', '--window-size=' + w + ',' + h,
    '--screenshot=' + scratch, 'file:///' + fwd(file)];
  if (transparent) args.splice(3, 0, '--default-background-color=00000000');

  const child = spawn(EDGE, args, { stdio: 'ignore' });
  const deadline = Date.now() + 60000;
  let lastSize = -1;
  let done = false;
  while (Date.now() < deadline) {
    sleep(250);
    if (!fs.existsSync(scratch)) continue;
    const size = fs.statSync(scratch).size;
    if (size > 0 && size === lastSize) { done = true; break; }  // unchanged across two polls
    lastSize = size;
  }
  killTree(child.pid);

  if (!done) throw new Error('Edge wrote no screenshot for ' + path.basename(outPng) + ' within 60s');
  fs.copyFileSync(scratch, outPng);
  // Edge can hold its profile for a moment after being killed; a leftover
  // temp folder is harmless, so never fail the run over it.
  sleep(300);
  for (const dir of [scratchDir, profile]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  const size = fs.statSync(outPng).size;
  console.log('  ' + path.basename(outPng) + '  ' + w + 'x' + h + '  ' + Math.round(size / 1024) + 'KB');
}

const made = [];
try {
  // --- overlay: the real renderer, fed one lobby --------------------------
  const overlayTail = `
    window.__onMessage({ id: 'display-mode', content: { collapsed: false, movable: false } });
    window.__onMessage({ id: 'players-update', content: { players: ${JSON.stringify(overlayRows)},
      columns: { lastHero: true, matchKD: true, lifetimeKD: true, record: true } } });
    window.__onMessage({ id: 'match-result', content: { result: 'victory' } });
  `;
  const overlayFile = harness('src/overlay/overlay.html', 'src/overlay/_preview_shot.html', overlayTail);
  made.push(overlayFile);

  // --- collapsed badge, for the new "always on screen" story --------------
  const badgeFile = harness('src/overlay/overlay.html', 'src/overlay/_preview_badge.html',
    `window.__onMessage({ id: 'display-mode', content: { collapsed: true, movable: false } });`);
  made.push(badgeFile);

  // --- history: table + leaderboards ---------------------------------------
  const historyFile = harness('src/history/history.html', 'src/history/_preview_shot.html', null);
  made.push(historyFile);

  const notesFile = harness('src/history/history.html', 'src/history/_preview_notes.html',
    // NovaSpark specifically: the notes, tags and name-history fields only have
    // content for that player, and an empty modal is a poor advert for them.
    `setTimeout(function () {
      var rows = document.getElementById('rows').children;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].textContent.indexOf('NovaSpark') === 0) { rows[i].click(); return; }
      }
    }, 400);`);
  made.push(notesFile);

  const settingsFile = harness('src/history/history.html', 'src/history/_preview_settings.html',
    `setTimeout(function () { document.getElementById('settings-gear-btn').click(); }, 400);`);
  made.push(settingsFile);

  const onboardingFile = harness('src/onboarding/onboarding.html', 'src/onboarding/_preview_shot.html', null);
  made.push(onboardingFile);

  console.log('rendering:');
  const D = path.join(ROOT, 'docs/assets');
  const W = path.join(ROOT, 'store-assets/windows');

  shot(overlayFile, path.join(D, 'overlay.png'), 800, 760, true);
  shot(historyFile, path.join(D, 'history.png'), 958, 680, false);
  shot(notesFile, path.join(D, 'player-notes.png'), 958, 680, false);
  shot(settingsFile, path.join(D, 'settings.png'), 958, 820, false);
  shot(onboardingFile, path.join(D, 'onboarding.png'), 560, 660, false);

  // store-assets/windows carries the same renders under its own names
  for (const [from, to] of [['overlay.png', 'overlay.png'], ['history.png', 'history.png'],
    ['player-notes.png', 'history-player.png'], ['settings.png', 'history-settings.png'],
    ['onboarding.png', 'onboarding.png']]) {
    fs.copyFileSync(path.join(D, from), path.join(W, to));
  }
  console.log('  copied 5 renders into store-assets/windows/');
} finally {
  made.forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  console.log('harnesses removed');
}
