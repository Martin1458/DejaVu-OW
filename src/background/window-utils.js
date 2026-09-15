// Small shared helper for showing/hiding a manifest-declared window by name,
// routing through obtainDeclaredWindow first so failures produce a loggable
// result instead of restore()/hide()'s silent no-op on a bad name. Logs to
// the same debug file as everything else so a failure here is inspectable
// after the fact, without needing devtools open at the right moment.

var DejaVuWindows = (function () {
  function logDiag(line) {
    console.log('[DejaVuWindows] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[windows] ' + line);
  }

  function withWindow(name, callback) {
    overwolf.windows.obtainDeclaredWindow(name, function (result) {
      logDiag('obtainDeclaredWindow(' + name + ') -> ' + JSON.stringify(result));
      if (!result.success) return;
      callback(result.window.id);
    });
  }

  function show(name, cb) {
    withWindow(name, function (id) {
      overwolf.windows.restore(id, function (result) {
        logDiag('restore(' + name + ') -> ' + JSON.stringify(result));
        if (cb) cb(result);
      });
    });
  }

  function hide(name, cb) {
    withWindow(name, function (id) {
      overwolf.windows.hide(id, function (result) {
        logDiag('hide(' + name + ') -> ' + JSON.stringify(result));
        if (cb) cb(result);
      });
    });
  }

  // Overwolf only uses the manifest's `size` when it FIRST creates a window.
  // After that the window keeps the bounds it already has, so editing the
  // manifest never resizes an existing install — confirmed 2026-09-06 the hard
  // way: the overlay reported logicalBounds 300x460, the original manifest
  // size, in a session running a manifest that had said 540x800, then 640x800,
  // then 640x900. Every one of those changes was verified by rendering and
  // none of them ever reached the actual window. changeSize is the only thing
  // that moves it.
  //
  // The units changeSize expects are NOT logical pixels, whatever
  // auto_dpi_resize is documented to do. Measured 2026-09-09 on a dpiScale 1.5
  // display: asking for 800x950 with auto_dpi_resize:true produced a window of
  // logical 533x633 — exactly 800/1.5 and 950/1.5 — so the values are treated
  // as physical and divided by the DPI scale on the way in. It reported
  // {"success":true} while doing it, so nothing about the response says the
  // size is wrong.
  //
  // Rather than hard-code the inverse (which would then break on a 1.0-scale
  // display, or if Overwolf changes the convention), this measures what
  // actually happened and corrects: if the resulting logical size is off by
  // some factor, re-request scaled by that factor. One correction converges for
  // any linear convention, and getting it wrong just costs another attempt.
  //
  // Idempotent: no-ops when the window is already the right size, so it's safe
  // to call on every show.
  var MAX_SIZE_ATTEMPTS = 6;

  // logicalBounds is absent until the window has actually been created, so fall
  // back to deriving it from the physical size and the DPI scale.
  function logicalSizeOf(win) {
    if (!win) return { width: 0, height: 0 };
    if (win.logicalBounds && win.logicalBounds.width) {
      return { width: win.logicalBounds.width, height: win.logicalBounds.height };
    }
    var scale = win.dpiScale || 1;
    if (win.width) return { width: Math.round(win.width / scale), height: Math.round(win.height / scale) };
    return { width: 0, height: 0 };
  }

  function noteSize(line) {
    logDiag(line);
    if (window.DejaVuFileLog) DejaVuFileLog.logImportant('[windows] ' + line);
  }

  // Leaves room for the window's own start_position offset (the overlay's is
  // Top: 100) plus slack, so a clamped window lands fully on-screen without
  // also having to be moved. MIN_SIZE stops a bogus monitor reading from
  // collapsing a window to nothing.
  var SCREEN_MARGIN = 120;
  var MIN_SIZE = 320;

  // Which monitor Overwatch is on, in the same scaled/logical pixels that
  // logicalBounds (and therefore applySize) works in. The overlay is an
  // in_game_only window sitting on top of the game, so the game's monitor is
  // the one that has to fit it — not necessarily the primary one.
  function monitorLogicalSize(cb) {
    if (!window.overwolf || !overwolf.utils || !overwolf.utils.getMonitorsList ||
        !overwolf.games || !overwolf.games.getRunningGameInfo) {
      cb(null);
      return;
    }

    overwolf.games.getRunningGameInfo(function (game) {
      var handle = game && game.monitorHandle && game.monitorHandle.value;

      overwolf.utils.getMonitorsList(function (res) {
        var list = (res && (res.displays || res.monitors)) || [];
        if (!list.length) {
          logDiag('monitorLogicalSize: no monitors reported -> ' + JSON.stringify(res));
          cb(null);
          return;
        }

        var target = null;
        var i;
        for (i = 0; i < list.length; i++) {
          if (handle != null && list[i].handle && list[i].handle.value === handle) {
            target = list[i];
            break;
          }
        }
        // Falling back to primary (then to whatever is first) rather than
        // giving up: a slightly wrong monitor still beats no clamp at all,
        // since the failure mode without one is a window partly off-screen on
        // a display the user cannot resize it back onto.
        if (!target) {
          for (i = 0; i < list.length; i++) {
            if (list[i].is_primary) { target = list[i]; break; }
          }
        }
        if (!target) target = list[0];

        // dpiX/dpiY are DPI values where 96 == 100% scaling, and width/height
        // are physical pixels; logicalBounds is in scaled pixels, so divide.
        var scaleX = (target.dpiX || 96) / 96;
        var scaleY = (target.dpiY || 96) / 96;
        var size = {
          width: Math.round((target.width || 0) / scaleX),
          height: Math.round((target.height || 0) / scaleY)
        };

        if (!size.width || !size.height) {
          logDiag('monitorLogicalSize: unusable monitor record -> ' + JSON.stringify(target));
          cb(null);
          return;
        }
        cb(size);
      });
    });
  }

  // A fixed 800x950 overlay fits a 1080p screen with room to spare, but runs
  // off the bottom of a 1600x900 or 1366x768 laptop panel — where the window
  // is `resizable: false`, so the player has no way to drag the lost part back
  // into view. Clamping here rather than at each call site means every window
  // that goes through ensureSize (overlay and onboarding both) gets it.
  function ensureSize(name, width, height, cb) {
    monitorLogicalSize(function (screen) {
      var w = width, h = height;

      if (screen) {
        var maxW = Math.max(MIN_SIZE, screen.width - SCREEN_MARGIN);
        var maxH = Math.max(MIN_SIZE, screen.height - SCREEN_MARGIN);
        w = Math.min(width, maxW);
        h = Math.min(height, maxH);
        if (w !== width || h !== height) {
          noteSize('ensureSize(' + name + '): clamped ' + width + 'x' + height + ' -> ' + w + 'x' + h +
            ' to fit the game monitor (' + screen.width + 'x' + screen.height + ' logical)');
        }
      }

      applySize(name, w, h, w, h, 1, cb);
    });
  }

  // wantW/wantH: the logical size we are aiming for.
  // reqW/reqH: what we actually hand changeSize on this attempt.
  function applySize(name, wantW, wantH, reqW, reqH, attempt, cb) {
    overwolf.windows.obtainDeclaredWindow(name, function (result) {
      if (!result.success || !result.window) {
        noteSize('ensureSize(' + name + '): could not obtain window -> ' + JSON.stringify(result));
        if (cb) cb(false);
        return;
      }

      var current = logicalSizeOf(result.window);
      if (current.width === wantW && current.height === wantH) {
        if (cb) cb(true);
        return;
      }

      noteSize('ensureSize(' + name + '): logical ' + current.width + 'x' + current.height +
        ' -> want ' + wantW + 'x' + wantH + ', requesting ' + reqW + 'x' + reqH +
        ' (attempt ' + attempt + '/' + MAX_SIZE_ATTEMPTS + ', dpiScale=' + result.window.dpiScale + ')');

      overwolf.windows.changeSize({
        window_id: result.window.id,
        width: reqW,
        height: reqH,
        auto_dpi_resize: true
      }, function (res) {
        overwolf.windows.obtainDeclaredWindow(name, function (after) {
          var got = logicalSizeOf(after && after.window);

          if (got.width === wantW && got.height === wantH) {
            noteSize('ensureSize(' + name + '): now logical ' + got.width + 'x' + got.height + ' — correct');
            if (cb) cb(true);
            return;
          }

          // Overwolf refuses to make a window smaller than its own minimum
          // (100 logical px tall, measured 2026-09-15). Without this the ratio
          // correction below reads that floor as a scaling factor and chases
          // it down through 13, 5, 2, 1, 0 — six pointless calls ending in a
          // "gave up" line that reads like a bug rather than a limit.
          if (got.width >= wantW && got.height >= wantH && reqW <= wantW && reqH <= wantH) {
            noteSize("ensureSize(" + name + "): window will not go below " + got.width + "x" + got.height +
              " (wanted " + wantW + "x" + wantH + ") — that is Overwolf’s minimum, using it as is");
            if (cb) cb(true);
            return;
          }

          if (attempt >= MAX_SIZE_ATTEMPTS || !got.width || !got.height) {
            noteSize('ensureSize(' + name + '): gave up after ' + attempt + ' attempt(s) — window is logical ' +
              got.width + 'x' + got.height + ', wanted ' + wantW + 'x' + wantH +
              ', last response ' + JSON.stringify(res));
            if (cb) cb(false);
            return;
          }

          // Correct by the observed ratio: if asking for reqW produced got.width
          // logical pixels, then wantW logical pixels needs reqW * wantW/got.width.
          var nextW = Math.round(reqW * wantW / got.width);
          var nextH = Math.round(reqH * wantH / got.height);
          if (nextW === reqW && nextH === reqH) {
            noteSize('ensureSize(' + name + '): stuck at logical ' + got.width + 'x' + got.height +
              ' — changeSize is not moving this window');
            if (cb) cb(false);
            return;
          }
          applySize(name, wantW, wantH, nextW, nextH, attempt + 1, cb);
        });
      });
    });
  }

  // Clickthrough, switched at runtime. The manifest declares the overlay
  // interactive (clickthrough: false) and this adds Overwolf's InputPassThrough
  // style on top to hand the mouse back to the game — which is the direction
  // the API supports, since setWindowStyle only ever *adds* the style and
  // removeWindowStyle takes it away again.
  function setInputPassThrough(name, passThrough, cb) {
    if (!overwolf.windows.setWindowStyle || !overwolf.windows.removeWindowStyle) {
      logDiag('setInputPassThrough(' + name + '): not supported by this Overwolf version, leaving the window as declared');
      if (cb) cb(false);
      return;
    }
    withWindow(name, function (id) {
      var apply = passThrough ? overwolf.windows.setWindowStyle : overwolf.windows.removeWindowStyle;
      apply(id, 'InputPassThrough', function (result) {
        logDiag((passThrough ? 'setWindowStyle' : 'removeWindowStyle') + '(' + name +
          ', InputPassThrough) -> ' + JSON.stringify(result));
        if (cb) cb(!!(result && result.success));
      });
    });
  }

  // changeSize turned out to take physical pixels while logicalBounds reports
  // logical ones (see applySize), and changePosition's docs only say it
  // "calculates DPI" without saying which way — getting that wrong by a 1.5x
  // scale factor parks a window far off-screen, where a clickthrough overlay
  // cannot be dragged back. So this measures rather than assumes: place it, see
  // where it landed, correct once by the observed ratio. That converges
  // whichever unit changePosition really wants, and costs one extra call when
  // the first guess was already right.
  var MAX_PLACE_ATTEMPTS = 3;

  function logicalPositionOf(win) {
    if (win && win.logicalBounds && win.logicalBounds.top != null) {
      return { left: win.logicalBounds.left, top: win.logicalBounds.top };
    }
    return null;
  }

  // want is in logical pixels, like logicalBounds and ensureSize.
  function placeAt(name, left, top, cb) {
    overwolf.windows.obtainDeclaredWindow(name, function (result) {
      if (!result.success || !result.window) {
        noteSize('placeAt(' + name + '): could not obtain window -> ' + JSON.stringify(result));
        if (cb) cb(false);
        return;
      }
      var want = { left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) };
      var scale = result.window.dpiScale || 1;
      applyPosition(name, want, { left: Math.round(want.left * scale), top: Math.round(want.top * scale) }, 1, cb);
    });
  }

  // Bottom-right of the monitor the game is on — the same one ensureSize
  // measures, since this positions an in-game window.
  var CORNER_MARGIN = 12;

  function placeBottomRight(name, cb) {
    monitorLogicalSize(function (screen) {
      if (!screen) {
        noteSize('placeBottomRight(' + name + '): no monitor info — leaving the window where it is');
        if (cb) cb(false);
        return;
      }
      overwolf.windows.obtainDeclaredWindow(name, function (result) {
        if (!result.success || !result.window) {
          noteSize('placeBottomRight(' + name + '): could not obtain window -> ' + JSON.stringify(result));
          if (cb) cb(false);
          return;
        }
        var size = logicalSizeOf(result.window);
        placeAt(name,
          Math.max(0, screen.width - size.width - CORNER_MARGIN),
          Math.max(0, screen.height - size.height - CORNER_MARGIN), cb);
      });
    });
  }

  function applyPosition(name, want, req, attempt, cb) {
    overwolf.windows.obtainDeclaredWindow(name, function (result) {
      if (!result.success || !result.window) {
        if (cb) cb(false);
        return;
      }
      overwolf.windows.changePosition(result.window.id, req.left, req.top, function (res) {
        overwolf.windows.obtainDeclaredWindow(name, function (after) {
          var got = logicalPositionOf(after && after.window);
          if (!got) {
            noteSize('placeAt(' + name + '): window reports no position, stopping after attempt ' + attempt);
            if (cb) cb(false);
            return;
          }
          if (Math.abs(got.top - want.top) <= 4 && Math.abs(got.left - want.left) <= 4) {
            noteSize('placeAt(' + name + '): now at logical ' + got.left + ',' + got.top + ' — correct');
            if (cb) cb(true);
            return;
          }
          if (attempt >= MAX_PLACE_ATTEMPTS) {
            noteSize('placeAt(' + name + '): gave up after ' + attempt + ' attempt(s) — at logical ' +
              got.left + ',' + got.top + ', wanted ' + want.left + ',' + want.top +
              ', last response ' + JSON.stringify(res));
            if (cb) cb(false);
            return;
          }
          // Same ratio correction as applySize. A got of 0 means the window
          // clamped rather than scaled, so fall back to the logical value.
          var next = {
            left: got.left > 0 ? Math.round(req.left * want.left / got.left) : want.left,
            top: got.top > 0 ? Math.round(req.top * want.top / got.top) : want.top
          };
          if (next.left === req.left && next.top === req.top) {
            noteSize('placeAt(' + name + '): stuck at logical ' + got.left + ',' + got.top);
            if (cb) cb(false);
            return;
          }
          applyPosition(name, want, next, attempt + 1, cb);
        });
      });
    });
  }

  return {
    show: show,
    hide: hide,
    ensureSize: ensureSize,
    setInputPassThrough: setInputPassThrough,
    placeAt: placeAt,
    placeBottomRight: placeBottomRight
  };
})();
