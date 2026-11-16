// Middle-button autoscroll, like a desktop browser: press the wheel and move
// away from the mark - the further, the faster. Released quickly without
// moving, it stays on until the next click, Esc or wheel turn. Places that use
// the middle button themselves (tabs, graph, boards, links) are left alone.

const SKIP = "a, button, input, textarea, select, canvas, .tab, .sp-tab, .tg-chip, .tabs, .gx, .graph-wrap, .fv-board-host, .img-viewer, .cm-link, .cm-wikilink, .cm-url, [data-no-autoscroll]";
const DEAD = 10; // px around the mark that don't scroll

function scrollerOf(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (!(n instanceof Element)) continue;
    const cs = getComputedStyle(n);
    const y = /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
    const x = /(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1;
    if (y || x) return { el: n, x, y };
  }
  return null;
}

export function mountAutoscroll() {
  let on = null; // { el, x, y, ox, oy, mx, my, sticky, raf, mark, t0 }

  // Far from the mark means fast: gentle near it, then climbing steeply to a
  // top speed about five times the old one, so a long page passes quickly.
  const speed = (d) => {
    const a = Math.abs(d) - DEAD;
    if (a <= 0) return 0;
    // a long, slow climb: top speed (900 px a frame) only far out, at 800 px from the mark;
    // a short pull stays gentle (at 320 px: about 130)
    const t = Math.min(1, a / 800);
    return Math.sign(d) * (2 + Math.pow(t, 2.2) * 898);
  };

  function tick(now) {
    if (!on) return;
    const dt = Math.min(48, now - (on.last || now)) / 16.7;
    on.last = now;
    // the first moments are always slow, however far the pointer is
    const warm = Math.min(1, 0.35 + (now - on.t0) / 700);
    const vx = on.x ? speed(on.mx - on.ox) * warm : 0;
    const vy = on.y ? speed(on.my - on.oy) * warm : 0;
    if (vx) on.el.scrollLeft += vx * dt;
    if (vy) on.el.scrollTop += vy * dt;
    on.mark.dataset.dir = (vy < 0 ? "n" : vy > 0 ? "s" : "") + (vx < 0 ? "w" : vx > 0 ? "e" : "");
    on.raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (!on) return;
    cancelAnimationFrame(on.raf);
    on.mark.remove();
    document.body.classList.remove("is-autoscroll");
    on = null;
  }

  document.addEventListener("mousedown", (e) => {
    if (on) { e.preventDefault(); e.stopPropagation(); stop(); return; }
    if (e.button !== 1 || e.target.closest?.(SKIP)) return;
    const s = scrollerOf(e.target);
    if (!s) return;
    e.preventDefault();
    const mark = document.createElement("div");
    mark.className = "autoscroll-mark" + (s.x && s.y ? " is-both" : s.x ? " is-x" : "");
    mark.style.left = e.clientX + "px";
    mark.style.top = e.clientY + "px";
    document.body.append(mark);
    document.body.classList.add("is-autoscroll");
    on = { ...s, ox: e.clientX, oy: e.clientY, mx: e.clientX, my: e.clientY, sticky: false, mark, t0: performance.now(), last: 0 };
    on.raf = requestAnimationFrame(tick);
  }, true);

  document.addEventListener("mousemove", (e) => { if (on) { on.mx = e.clientX; on.my = e.clientY; } }, true);

  document.addEventListener("mouseup", (e) => {
    if (!on || e.button !== 1) return;
    e.preventDefault();
    // released without moving away - however long the press - it stays on until the next click, as a browser's does
    const still = Math.hypot(e.clientX - on.ox, e.clientY - on.oy) < 6;
    if (still && !on.sticky) on.sticky = true;
    else stop();
  }, true);
  // the middle click itself must not paste or open anything
  document.addEventListener("auxclick", (e) => { if (e.button === 1 && document.body.classList.contains("is-autoscroll")) e.preventDefault(); }, true);
  document.addEventListener("keydown", (e) => { if (on) { if (e.key === "Escape") e.preventDefault(); stop(); } }, true);
  // a wheel turn ends it once it is left on (sticky) - never while the button is held: a fast drag with the
  // wheel pressed rolls it a notch now and then, and that must not throw the scroll away
  document.addEventListener("wheel", (e) => { if (on && on.sticky && (e.deltaY || e.deltaX) && performance.now() - on.t0 > 250) stop(); }, { passive: true, capture: true });
  window.addEventListener("blur", stop);
}
