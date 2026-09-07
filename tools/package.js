// Builds a distributable .opk and refuses to do it if the package would be
// broken. An .opk is just a zip with manifest.json at the root, which makes it
// easy to produce one that installs and then fails at runtime because a file
// the manifest names was never included — that is exactly what happened with
// src/onboarding/ (declared in the manifest, never committed, see plan §12).
// So this verifies first and only packs if everything resolves.
//
// Usage:  node tools/package.js            -> dist/DejaVu-OW-<version>.opk
//         node tools/package.js --verify   -> checks only, writes nothing
//
// Deliberately has no dependencies at all: plain Node, including the zip
// container itself, so it works on a clean checkout with nothing installed.

const fs = require('fs');
const path = require('path');


const ROOT = path.resolve(__dirname, '..');
const norm = (p) => p.split(path.sep).join('/');
const rel = (p) => norm(path.relative(ROOT, p));

// Everything the app needs at runtime. Anything not under these paths is dev
// material (docs, the plan, this script, git, render harnesses) and is left out.
const INCLUDE_DIRS = ['src', 'images', 'icons'];
const INCLUDE_FILES = ['manifest.json'];

const problems = [];
const included = new Set();

function addFile(p) {
  if (!fs.existsSync(p)) { problems.push('missing file: ' + rel(p)); return; }
  included.add(rel(p));
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    // Render harnesses are generated next to the real files and deleted after;
    // a crashed run could leave one behind, and it must never ship.
    if (/^_(preview|pv_)/.test(entry.name)) {
      problems.push('stray render harness, delete it: ' + rel(full));
      continue;
    }
    included.add(rel(full));
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

for (const f of INCLUDE_FILES) addFile(path.join(ROOT, f));
for (const d of INCLUDE_DIRS) {
  const full = path.join(ROOT, d);
  if (!fs.existsSync(full)) { problems.push('missing directory: ' + d); continue; }
  walk(full);
}

// --- verify every path the manifest and its HTML actually reference ---------
function requireFile(label, relPath) {
  const p = norm(relPath);
  if (!included.has(p)) problems.push(label + ' -> ' + p + ' (not in package)');
  return p;
}

requireFile('meta.icon', manifest.meta.icon);
requireFile('meta.icon_gray', manifest.meta.icon_gray);

for (const [name, win] of Object.entries(manifest.data.windows)) {
  const winFile = requireFile('window "' + name + '"', win.file);
  const full = path.join(ROOT, winFile);
  if (!fs.existsSync(full)) continue;
  const html = fs.readFileSync(full, 'utf8');
  const dir = path.dirname(winFile);
  for (const m of html.matchAll(/<script\s+src="([^"]+)"/g)) {
    requireFile('window "' + name + '" loads', norm(path.posix.join(dir, m[1])));
  }
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    if (/^https?:/.test(m[1])) continue;
    requireFile('window "' + name + '" stylesheet', norm(path.posix.join(dir, m[1])));
  }
}

// Hero portraits are looked up by filename at runtime, so a missing one is a
// silent "?" placeholder rather than an error. Check them here instead.
const heroIcons = path.join(ROOT, 'src/overlay/hero-icons.js');
if (fs.existsSync(heroIcons)) {
  const js = fs.readFileSync(heroIcons, 'utf8');
  for (const m of js.matchAll(/'([A-Za-z0-9_]+_Hero\.png)'/g)) {
    requireFile('hero icon', 'images/' + m[1]);
  }
}

// --- report ----------------------------------------------------------------
const files = [...included].sort();
const totalBytes = files.reduce((n, f) => n + fs.statSync(path.join(ROOT, f)).size, 0);

console.log('DejaVu - OW  v' + manifest.meta.version);
console.log('  files: ' + files.length + '   size: ' + (totalBytes / 1048576).toFixed(2) + ' MB');

if (problems.length) {
  console.error('\nPACKAGE IS BROKEN — not writing an .opk:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('  all manifest-referenced files resolve');

if (process.argv.includes('--verify')) {
  console.log('\nverify only, nothing written');
  process.exit(0);
}

// --- zip -------------------------------------------------------------------
// Written by hand rather than shelled out to PowerShell. Both of Windows'
// built-in options get this wrong: Compress-Archive mangles nested directories,
// and .NET Framework's ZipFile.CreateFromDirectory writes entry names with
// BACKSLASHES (verified 2026-09-07 — the first .opk this script produced had
// "src\background\background.js" inside it). The ZIP spec requires forward
// slashes, and an archive with backslash names installs and then cannot resolve
// its own files. Node's zlib gives us deflate, so the container is the only
// part left to build, and doing it here makes the output deterministic and
// removes the dependency on which PowerShell happens to be installed.
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// DOS timestamp. Fixed rather than "now" so the same input produces a
// byte-identical .opk, which makes it obvious when a build actually changed.
const DOS_TIME = 0x6000;  // 12:00:00
const DOS_DATE = 0x5A21;  // 2025-01-01

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Never let "compression" make a file bigger.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    locals.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0, 8);              // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra
    cd.writeUInt16LE(0, 32);             // comment
    cd.writeUInt16LE(0, 34);             // disk number
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);        // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
const opk = path.join(dist, 'DejaVu-OW-' + manifest.meta.version + '.opk');

// manifest.json first: Overwolf reads it out of the archive root, and some
// readers are happier when it is the first entry.
const ordered = ['manifest.json', ...files.filter((f) => f !== 'manifest.json')];
const zip = buildZip(ordered.map((f) => ({ name: f, data: fs.readFileSync(path.join(ROOT, f)) })));
fs.writeFileSync(opk, zip);

// Read the archive back and assert the thing that was actually wrong the first
// time, rather than trusting that it came out right.
const names = [];
{
  let p = zip.length - 22;
  while (p >= 0 && zip.readUInt32LE(p) !== 0x06054b50) p--;
  const count = zip.readUInt16LE(p + 10);
  let cp = zip.readUInt32LE(p + 16);
  for (let i = 0; i < count; i++) {
    const nlen = zip.readUInt16LE(cp + 28);
    names.push(zip.slice(cp + 46, cp + 46 + nlen).toString('utf8'));
    cp += 46 + nlen + zip.readUInt16LE(cp + 30) + zip.readUInt16LE(cp + 32);
  }
}
const backslashed = names.filter((n) => n.includes('\\'));
if (backslashed.length) {
  console.error('\nBROKEN ARCHIVE: ' + backslashed.length + ' entries use backslashes, e.g. ' + backslashed[0]);
  process.exit(1);
}
if (!names.includes('manifest.json')) {
  console.error('\nBROKEN ARCHIVE: manifest.json is not at the archive root');
  process.exit(1);
}
const missing = files.filter((f) => !names.includes(f));
if (missing.length) {
  console.error('\nBROKEN ARCHIVE: missing ' + missing.length + ' entries, e.g. ' + missing[0]);
  process.exit(1);
}

console.log('  archive verified: ' + names.length + ' entries, manifest at root, all paths forward-slashed');
console.log('\nwrote ' + rel(opk) + '  (' + (fs.statSync(opk).size / 1048576).toFixed(2) + ' MB)');
