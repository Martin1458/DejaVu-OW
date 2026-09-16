// Regression test for overlay sizing and placement: replays the real
// window-utils.js against a mocked Overwolf that behaves the way the logs
// showed — changeSize/changePosition take physical pixels, logicalBounds
// reports physical / the window’s dpiScale, and windows cannot be shorter
// than 100 logical px.
//
// The cases that matter are the ones where the monitor’s scale and the
// window’s scale disagree: exclusive fullscreen at a lowered resolution
// switches the display mode to 100% while the overlay keeps the desktop’s
// 150% (see DEJAVU_OW_PLAN.md, 2026-09-16).
//
// Usage: node tools/test-placement.js
const fs = require('fs');
const vm = require('vm');

const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src/background/window-utils.js'), 'utf8');

function run(label, monitor, windowScale, startLogical, action, expect) {
  return new Promise((resolve) => {
    const win = {
      id: 'overlay', dpiScale: windowScale,
      logicalBounds: { left: 0, top: 0, width: startLogical.w, height: startLogical.h }
    };
    const notes = [];
    const ctx = {
      console: { log: () => {} },
      window: {},
      overwolf: {
        games: { getRunningGameInfo: (cb) => cb({ monitorHandle: { value: 1 } }) },
        utils: { getMonitorsList: (cb) => cb({ displays: [{ handle: { value: 1 }, is_primary: true,
          width: monitor.w, height: monitor.h, dpiX: monitor.dpi, dpiY: monitor.dpi }] }) },
        windows: {
          obtainDeclaredWindow: (n, cb) => cb({ success: true, window: JSON.parse(JSON.stringify(win)) }),
          changeSize: (o, cb) => {
            // Overwolf's minimum window height, as measured
            win.logicalBounds.width = Math.round(o.width / windowScale);
            win.logicalBounds.height = Math.max(100, Math.round(o.height / windowScale));
            cb({ success: true });
          },
          changePosition: (id, l, t, cb) => {
            win.logicalBounds.left = Math.round(l / windowScale);
            win.logicalBounds.top = Math.round(t / windowScale);
            cb({ success: true });
          },
          restore: (id, cb) => cb({ success: true })
        }
      }
    };
    ctx.window = ctx;
    ctx.window.DejaVuFileLog = { log: () => {}, logImportant: (l) => notes.push(l) };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.DejaVuWindows = DejaVuWindows;', ctx);

    action(ctx.DejaVuWindows, () => {
      const b = win.logicalBounds;
      const physRight = Math.round((b.left + b.width) * windowScale);
      const physBottom = Math.round((b.top + b.height) * windowScale);
      const onScreen = physRight <= monitor.w && physBottom <= monitor.h && b.left >= 0 && b.top >= 0;
      const ok = onScreen && (!expect || (b.left === expect.left && b.top === expect.top));
      console.log((ok ? 'PASS ' : 'FAIL ') + label);
      console.log('     window logical ' + b.width + 'x' + b.height + ' at ' + b.left + ',' + b.top +
        ' -> physical right/bottom edge ' + physRight + ',' + physBottom + ' on a ' + monitor.w + 'x' + monitor.h + ' screen');
      notes.filter((n) => /clamped/.test(n)).forEach((n) => console.log('     note: ' + n.replace('[windows] ', '')));
      resolve(ok);
    });
  });
}

const badge = (W, done) => W.ensureSize('overlay', 150, 100, () => W.placeBottomRight('overlay', done));
const table = (W, done) => W.ensureSize('overlay', 800, 950, () => W.placeAt('overlay', 20, 100, done));

(async () => {
  const results = [];
  // The reported bug: exclusive fullscreen at 1366x768, desktop at 150%.
  results.push(await run('1366x768 fullscreen, window at 1.5x — badge', { w: 1366, h: 768, dpi: 96 }, 1.5,
    { w: 800, h: 648 }, badge, { left: 748, top: 400 }));
  results.push(await run('1366x768 fullscreen, window at 1.5x — table', { w: 1366, h: 768, dpi: 96 }, 1.5,
    { w: 150, h: 100 }, table));
  // A position dragged at 1440p, replayed after dropping to 1366x768.
  results.push(await run('1366x768, saved badge position from 1440p', { w: 1366, h: 768, dpi: 96 }, 1.5,
    { w: 150, h: 100 }, (W, d) => W.placeAt('overlay', 2398, 1328, d), { left: 760, top: 412 }));
  // Must not regress the cases that already worked.
  results.push(await run('4K desktop at 150% — badge (unchanged)', { w: 3840, h: 2160, dpi: 144 }, 1.5,
    { w: 800, h: 950 }, badge, { left: 2398, top: 1328 }));
  results.push(await run('1080p fullscreen, window at 1.0x — badge (unchanged)', { w: 1920, h: 1080, dpi: 96 }, 1,
    { w: 800, h: 950 }, badge, { left: 1758, top: 968 }));
  results.push(await run('1366x720 fullscreen, window at 1.5x — badge', { w: 1366, h: 720, dpi: 96 }, 1.5,
    { w: 800, h: 648 }, badge));
  results.push(await run('1366x720 fullscreen, window at 1.5x — table', { w: 1366, h: 720, dpi: 96 }, 1.5,
    { w: 150, h: 100 }, table));
  console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' passed');
  process.exit(results.every(Boolean) ? 0 : 1);
})();
