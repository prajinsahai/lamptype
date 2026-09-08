/* =================================================================
   chart.js - the words-per-minute-over-time graph.

   Hand-drawn on a canvas: no charting library, no network. Colors are
   pulled from the live CSS variables so the chart re-themes with the
   rest of the page, and the backing store is scaled by devicePixelRatio
   so lines stay crisp on high-DPI screens.

   draw() takes a `progress` in [0,1] so the same code paints both the
   static chart (progress 1) and every frame of the reveal in animate().

   Sample shape: { t, raw, wpm, errors }  (t = second, 1-based)
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  const PAD = { top: 14, right: 14, bottom: 26, left: 40 };
  const FONT = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';

  const REVEAL_MS = 640;

  /* The grid has to be there before the line arrives, so it fades in
     over the first slice of the run and the sweep uses the rest. */
  const GRID_IN = 0.22;

  const clamp01 = (n) => Math.min(1, Math.max(0, n));

  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);

  function themeColor(name, fallback) {
    try {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      return value || fallback;
    } catch (err) {
      return fallback;
    }
  }

  const TICKS = 5;

  /* A ladder of step sizes that read well as axis labels. The axis top is
     the first step that covers the peak in TICKS intervals, so every
     gridline lands on a round number rather than on 62.5. */
  const STEPS = [2, 5, 10, 20, 25, 50, 100, 200, 250, 500];

  function niceMax(value) {
    if (!(value > 0)) return TICKS * 2;
    for (let i = 0; i < STEPS.length; i++) {
      if (STEPS[i] * TICKS >= value) return STEPS[i] * TICKS;
    }
    /* Beyond the ladder, fall back to whole hundreds per interval. */
    return Math.ceil(value / TICKS / 100) * 100 * TICKS;
  }

  /**
   * The first `frac` of a polyline, cut mid-segment rather than at the
   * nearest vertex - that is what keeps the sweep smooth instead of
   * stepping from sample to sample.
   */
  function partialPoints(points, frac) {
    const f = clamp01(frac);
    if (points.length === 0) return [];
    if (f >= 1) return points.slice();
    if (points.length === 1) return f > 0 ? points.slice() : [];

    const span = (points.length - 1) * f;
    const last = Math.floor(span);
    const t = span - last;
    const out = points.slice(0, last + 1);

    if (t > 0 && last + 1 < points.length) {
      const a = points[last];
      const b = points[last + 1];
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }

    return out;
  }

  function polyline(ctx, points, color, width) {
    if (points.length === 0) return;

    if (points.length === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, width + 1, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  function drawCross(ctx, x, y, size, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - size, y - size);
    ctx.lineTo(x + size, y + size);
    ctx.moveTo(x + size, y - size);
    ctx.lineTo(x - size, y + size);
    ctx.stroke();
  }

  function draw(canvas, samples, options) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const opts = options || {};
    const progress = opts.progress === undefined ? 1 : clamp01(opts.progress);

    /* Match the backing store to the CSS box at the current DPR. */
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 300));
    const h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 200));
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const colors = {
      main: themeColor('--main', '#e2b714'),
      sub: themeColor('--sub', '#646669'),
      subAlt: themeColor('--sub-alt', '#2c2e31'),
      error: themeColor('--error', '#ca4754')
    };

    const data = (samples || []).filter((s) => s && isFinite(s.wpm) && isFinite(s.raw));

    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    if (data.length === 0) {
      ctx.fillStyle = colors.sub;
      ctx.textAlign = 'center';
      ctx.fillText('not enough data for a graph', w / 2, h / 2);
      return;
    }

    const gridAlpha = clamp01(progress / GRID_IN);
    const sweep = easeOutCubic(clamp01((progress - GRID_IN) / (1 - GRID_IN)));

    const plotW = Math.max(1, w - PAD.left - PAD.right);
    const plotH = Math.max(1, h - PAD.top - PAD.bottom);

    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, data[i].raw, data[i].wpm);
    const yMax = niceMax(peak);

    const lastT = data[data.length - 1].t || data.length;
    const span = Math.max(1, lastT - 1);
    const xAt = (t) => PAD.left + (data.length === 1 ? plotW / 2 : ((t - 1) / span) * plotW);
    const yAt = (v) => PAD.top + plotH - (Math.min(v, yMax) / yMax) * plotH;

    /* --- grid + y axis --- */
    ctx.globalAlpha = gridAlpha;
    ctx.textAlign = 'right';
    for (let i = 0; i <= TICKS; i++) {
      const value = (yMax / TICKS) * i;
      const y = yAt(value);

      ctx.strokeStyle = colors.subAlt;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y + 0.5);
      ctx.lineTo(PAD.left + plotW, y + 0.5);
      ctx.stroke();

      ctx.fillStyle = colors.sub;
      ctx.fillText(String(Math.round(value)), PAD.left - 8, y);
    }

    /* --- x axis labels --- */
    ctx.textAlign = 'center';
    ctx.fillStyle = colors.sub;
    const stride = Math.max(1, Math.ceil(data.length / 8));
    for (let i = 0; i < data.length; i += stride) {
      ctx.fillText(String(data[i].t), xAt(data[i].t), PAD.top + plotH + 13);
    }
    ctx.globalAlpha = 1;

    /* --- series, drawn only as far as the sweep has reached --- */
    const rawPoints = partialPoints(data.map((s) => ({ x: xAt(s.t), y: yAt(s.raw) })), sweep);
    const wpmPoints = partialPoints(data.map((s) => ({ x: xAt(s.t), y: yAt(s.wpm) })), sweep);

    ctx.globalAlpha = 0.65;
    polyline(ctx, rawPoints, colors.sub, 1);
    ctx.globalAlpha = 1;
    polyline(ctx, wpmPoints, colors.main, 1.75);

    /* --- error markers, popping in as the sweep passes them --- */
    const reach = data.length === 1 ? 1 : sweep * (data.length - 1);
    for (let i = 0; i < data.length; i++) {
      if (!data[i].errors) continue;
      const grown = clamp01((reach - i) / 0.6);
      if (grown <= 0) continue;
      drawCross(ctx, xAt(data[i].t), yAt(data[i].raw), 3.5 * grown, colors.error);
    }

    /* --- legend --- */
    /* Right-aligned: the left edge belongs to the y-axis labels. */
    ctx.globalAlpha = clamp01((progress - 0.55) / 0.35);
    ctx.textAlign = 'right';
    ctx.fillStyle = colors.sub;
    ctx.fillText('raw', PAD.left + plotW, PAD.top + 6);
    ctx.fillStyle = colors.main;
    ctx.fillText('wpm', PAD.left + plotW - 30, PAD.top + 6);
    ctx.globalAlpha = 1;
  }

  /**
   * Paint the chart in, left to right. Returns a cancel function that
   * leaves the finished chart on screen, so a resize or theme change
   * mid-reveal ends up with the same picture as a completed one.
   */
  function animate(canvas, samples, options) {
    const opts = options || {};
    const duration = opts.duration === undefined ? REVEAL_MS : opts.duration;
    const noop = function () {};
    if (!canvas) return noop;

    const finish = () => draw(canvas, samples, { progress: 1 });

    if (!(duration > 0) || (TT.reveal && TT.reveal.reducedMotion())) {
      finish();
      return noop;
    }

    const start = performance.now();
    let raf = 0;

    function step(now) {
      const p = (now - start) / duration;
      if (p >= 1) {
        finish();
        raf = 0;
        return;
      }
      draw(canvas, samples, { progress: p });
      raf = requestAnimationFrame(step);
    }

    raf = requestAnimationFrame(step);

    return function cancel() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      finish();
    };
  }

  TT.chart = { draw, animate };
  TT.chartMath = { partialPoints, easeOutCubic, REVEAL_MS, GRID_IN };
})(window.TT);
