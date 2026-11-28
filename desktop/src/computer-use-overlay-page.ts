/**
 * The page of the ghost pointer: a transparent sheet over the primary display that draws the agent's
 * pointer, its name, the path it just took, a halo on each click and a frame on the accessibility
 * element an action touched. Fixed text, no Electron: the window lives in `computer-use-overlay.ts`.
 */
import type { PointerEvent } from './computer-use-pointer.js';

/** Distinct from the red of the stop bar: this one says "the agent is here", not "you can stop it". */
const ACCENT = '#3d6bff';

/**
 * Fixed text. Its only input is `window.timonPointer(event)`, called with a JSON literal of numbers
 * and the agent's name; the name is set with `textContent`, never parsed as markup.
 */
export const GHOST_POINTER_PAGE = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none;user-select:none}
svg.trail{position:fixed;inset:0;width:100%;height:100%;overflow:visible}
svg.trail polyline{fill:none;stroke:${ACCENT};stroke-width:3;stroke-linecap:round;stroke-linejoin:round;opacity:.55;transition:opacity .6s ease .3s}
svg.trail polyline.gone{opacity:0}
#pointer{position:fixed;left:0;top:0;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
#pointer[hidden]{display:none}
#pointer svg{display:block}
#label{position:absolute;left:18px;top:20px;max-width:240px;padding:2px 8px;border-radius:10px;background:${ACCENT};color:#fff;font:600 12px/18px system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#label:empty{display:none}
.halo{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid ${ACCENT};box-sizing:border-box;animation:halo .5s ease-out forwards}
@keyframes halo{from{transform:scale(.3);opacity:.9}to{transform:scale(1.4);opacity:0}}
#frame{position:fixed;box-sizing:border-box;border:2px solid ${ACCENT};border-radius:6px;box-shadow:0 0 0 4px rgba(61,107,255,.25);opacity:0;transition:opacity .4s ease}
#frame.on{opacity:1;transition:none}
</style>
<body>
<svg class="trail" aria-hidden="true"><polyline id="trail" class="gone" points=""/></svg>
<div id="frame"></div>
<div id="pointer" hidden><svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true"><path d="M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.6 15.2 L17.5 15.2 Z" fill="${ACCENT}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div id="label"></div></div>
<script>
(function () {
  var pointer = document.getElementById('pointer');
  var label = document.getElementById('label');
  var trail = document.getElementById('trail');
  var frame = document.getElementById('frame');
  var glide = 0, frameTimer = 0;
  var at = { x: 0, y: 0 };
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function place(x, y) {
    at = { x: x, y: y };
    // The arrow's tip is 2 px inside its box.
    pointer.style.transform = 'translate(' + (x - 2) + 'px,' + (y - 2) + 'px)';
  }
  function move(e) {
    cancelAnimationFrame(glide);
    var fx = num(e.fromX), fy = num(e.fromY), x = num(e.x), y = num(e.y), ms = Math.max(0, num(e.ms));
    var points = [fx + ',' + fy];
    pointer.hidden = false;
    trail.classList.remove('gone');
    var start = performance.now();
    function step(now) {
      var t = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
      var k = 1 - Math.pow(1 - t, 3);
      var px = fx + (x - fx) * k, py = fy + (y - fy) * k;
      place(px, py);
      points.push(px + ',' + py);
      trail.setAttribute('points', points.join(' '));
      if (t < 1) glide = requestAnimationFrame(step);
      else trail.classList.add('gone');
    }
    step(start);
  }
  function halo(x, y, delay) {
    setTimeout(function () {
      var ring = document.createElement('div');
      ring.className = 'halo';
      ring.style.left = x + 'px';
      ring.style.top = y + 'px';
      ring.addEventListener('animationend', function () { ring.remove(); });
      document.body.appendChild(ring);
    }, delay);
  }
  function click(e) {
    var n = Math.min(3, Math.max(1, Math.round(num(e.n))));
    for (var i = 0; i < n; i++) halo(num(e.x), num(e.y), i * 120);
  }
  function box(e) {
    clearTimeout(frameTimer);
    frame.style.left = num(e.x) + 'px';
    frame.style.top = num(e.y) + 'px';
    frame.style.width = Math.max(0, num(e.w)) + 'px';
    frame.style.height = Math.max(0, num(e.h)) + 'px';
    frame.classList.add('on');
    frameTimer = setTimeout(function () { frame.classList.remove('on'); }, 1600);
  }
  window.timonPointer = function (e) {
    if (!e || typeof e !== 'object') return;
    label.textContent = typeof e.agent === 'string' ? e.agent : '';
    if (e.t === 'move') move(e);
    else if (e.t === 'click') click(e);
    else if (e.t === 'frame') box(e);
  };
  window.timonPointerState = function () {
    return { x: at.x, y: at.y, visible: !pointer.hidden, label: label.textContent, halos: document.querySelectorAll('.halo').length,
      frame: frame.classList.contains('on') ? { x: frame.offsetLeft, y: frame.offsetTop, w: frame.offsetWidth, h: frame.offsetHeight } : null };
  };
})();
</script>
</body>`;

/**
 * The one call the main process runs in the page. `JSON.stringify` of numbers and a string is a
 * valid JavaScript literal: the agent's name cannot leave it.
 */
export function ghostPointerCall(event: PointerEvent, agent: string | undefined): string {
  return `window.timonPointer(${JSON.stringify({ ...event, ...(agent ? { agent } : {}) })})`;
}
