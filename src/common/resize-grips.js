// Edge and corner handles that resize whichever window loads this script.
//
// A standard (transparent: false) window gets resizable edges from the OS on
// the desktop, but the History window also opens over the game on Alt+H, and
// drawn in game it has none — dragging its frame did nothing (found at
// 1366x768, 2026-09-16, where the default size is cramped enough to want
// changing). overwolf.windows.dragResize is the documented way to hand the
// resize to Overwolf; its own reference describes the parameter as being for
// "the ingame drawing resizing white area". The window's manifest min_size
// still applies.
//
// Injected rather than written into each page's markup, so a window opts in
// with one script tag. The handles are invisible and a few pixels thick, and
// sit above the page's own modal backdrops so they keep working with one open.

(function () {
  var EDGE = 5;     // thickness of the side handles
  var CORNER = 12;  // corners are bigger: they are the easier target to hit

  var HANDLES = [
    ['Top', 'top:0;left:' + CORNER + 'px;right:' + CORNER + 'px;height:' + EDGE + 'px;cursor:ns-resize'],
    ['Bottom', 'bottom:0;left:' + CORNER + 'px;right:' + CORNER + 'px;height:' + EDGE + 'px;cursor:ns-resize'],
    ['Left', 'left:0;top:' + CORNER + 'px;bottom:' + CORNER + 'px;width:' + EDGE + 'px;cursor:ew-resize'],
    ['Right', 'right:0;top:' + CORNER + 'px;bottom:' + CORNER + 'px;width:' + EDGE + 'px;cursor:ew-resize'],
    ['TopLeft', 'top:0;left:0;width:' + CORNER + 'px;height:' + CORNER + 'px;cursor:nwse-resize'],
    ['TopRight', 'top:0;right:0;width:' + CORNER + 'px;height:' + CORNER + 'px;cursor:nesw-resize'],
    ['BottomLeft', 'bottom:0;left:0;width:' + CORNER + 'px;height:' + CORNER + 'px;cursor:nesw-resize'],
    ['BottomRight', 'bottom:0;right:0;width:' + CORNER + 'px;height:' + CORNER + 'px;cursor:nwse-resize']
  ];

  function edgeValue(name) {
    var enums = overwolf.windows.enums;
    return (enums && enums.WindowDragEdge && enums.WindowDragEdge[name]) || name;
  }

  function init() {
    if (!window.overwolf || !overwolf.windows || !overwolf.windows.dragResize) return;

    HANDLES.forEach(function (handle) {
      var el = document.createElement('div');
      el.className = 'resize-grip';
      el.style.cssText = 'position:fixed;z-index:50;' + handle[1];
      el.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        // Otherwise the browser starts a text selection under the cursor.
        e.preventDefault();
        overwolf.windows.getCurrentWindow(function (result) {
          if (!result || !result.success || !result.window) return;
          overwolf.windows.dragResize(result.window.id, edgeValue(handle[0]));
        });
      });
      document.body.appendChild(el);
    });
  }

  init();
})();
