/* =================================================================
   lamp.js - the lava lamp backdrop.

   A full-viewport canvas behind everything, running while the lamp
   theme is active. Blobs rise and sink on sine paths, which is what
   gives a real lamp its character: slow at the turn, quickest through
   the middle, and never a hard edge anywhere.

   Two things keep it smooth under fast typing:

   - The base motion is a closed form of elapsed time, not an
     accumulation of per-frame steps, so a dropped frame changes
     nothing about where a blob is.
   - Every reaction to a keystroke lands in a separate offset that
     decays back to zero. Nothing a keystroke does can move a blob's
     path, only borrow it for a moment.

   Colours come from CSS variables, so the palette drives the canvas
   without any JS branching on theme.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  const BLOB_COUNT = 7;        // few and large: this is ambience, not a display
  const MIN_R = 0.13;          // radius as a fraction of the smaller viewport side
  const MAX_R = 0.26;
  const RISE_MIN = 26;         // seconds for a full rise-and-sink cycle
  const RISE_MAX = 44;
  const SWAY_MIN = 14;         // seconds per horizontal drift cycle
  const SWAY_MAX = 26;
  const SWAY_X = 0.06;         // horizontal travel, as a fraction of width
  const BREATH_MIN = 9;        // seconds per size-breathing cycle
  const BREATH_MAX = 15;
  const BREATH = 0.05;         // +/- 5% of radius

  const HEAT_IDLE = 1.0;
  const HEAT_MAX = 1.7;        // hard cap - the lamp must never look agitated
  const HEAT_EASE = 1.0;       // seconds to ease between idle and max
  const SPEED_WINDOW = 2.0;    // seconds of keystrokes treated as "now"
  const SPEED_FOR_MAX = 8;     // keystrokes/sec that reaches the cap

  /* Each keystroke kicks a blob on a spring tethered to its own path.
     A spring is what keeps this readable as one continuous motion: the
     blob swings, overshoots once, and settles - it never snaps to a new
     position and never stops dead. */
  const IMPULSE = 95;          // px/sec of velocity per keystroke
  const STIFFNESS = 3.2;       // pull back toward the path
  const DAMPING = 2.4;         // zeta ~ 0.67: one soft overshoot, then still
  const MAX_OFFSET = 110;      // px a blob may ever be displaced from its path
  const MAX_VELOCITY = 380;    // px/sec, so held keys cannot wind it up
  const BLOOM = 0.07;          // radius swell per keystroke, as a fraction
  const BLOOM_DECAY = 1.3;
  const MAX_BLOOM = 0.28;
  const NEAREST = 4;           // blobs nudged per keystroke

  /* The result is soft and blurred, so half-resolution is free quality. */
  const RENDER_SCALE = 0.5;
  const MAX_DT = 0.1;          // clamp so a stalled tab cannot jump the phase

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* A blob's position on one axis: closed form, so it is identical at a
     given time no matter how many frames were drawn to get there. */
  function wave(t, period, phase, amplitude) {
    return Math.sin((2 * Math.PI * t) / period + phase) * amplitude;
  }

  /* Rolling typing speed to a global heat multiplier, hard-capped. */
  function heatTarget(keysPerSecond) {
    const t = clamp(keysPerSecond / SPEED_FOR_MAX, 0, 1);
    return HEAT_IDLE + (HEAT_MAX - HEAT_IDLE) * t;
  }

  /* One step of a damped spring pulling a blob back onto its path.
     Semi-implicit Euler, which stays stable at any frame time this
     loop can hand it. Both the offset and the velocity are clamped, so
     no amount of typing can fling a blob across the screen. */
  function springStep(offset, velocity, dt) {
    const v = clamp(
      velocity + (-STIFFNESS * offset - DAMPING * velocity) * dt,
      -MAX_VELOCITY, MAX_VELOCITY
    );
    return {
      offset: clamp(offset + v * dt, -MAX_OFFSET, MAX_OFFSET),
      velocity: v
    };
  }

  function kick(velocity, impulse) {
    return clamp(velocity + impulse, -MAX_VELOCITY, MAX_VELOCITY);
  }

  /* Exponential decay toward zero, expressed per second so it is the
     same fall-off at any frame rate. */
  function decay(value, rate, dt) {
    return value - value * Math.min(1, rate * dt);
  }

  function createLamp(canvas) {
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let blobs = [];
    let width = 0;
    let height = 0;
    let rafId = null;
    let lastTime = 0;
    let clock = 0;          // heat-scaled time; the only thing heat touches
    let running = false;
    let heat = HEAT_IDLE;
    let keyTimes = [];
    let palette = { colors: ['#ff8a3d', '#e2495f'], alphaMin: 0.10, alphaMax: 0.22 };

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;

      width = w;
      height = h;
      canvas.width = Math.max(1, Math.round(w * RENDER_SCALE));
      canvas.height = Math.max(1, Math.round(h * RENDER_SCALE));
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
    }

    function readPalette() {
      const cs = getComputedStyle(document.documentElement);
      const a = cs.getPropertyValue('--lamp-a').trim() || '#ff8a3d';
      const b = cs.getPropertyValue('--lamp-b').trim() || a;
      const lo = parseFloat(cs.getPropertyValue('--lamp-alpha-min')) || 0.10;
      const hi = parseFloat(cs.getPropertyValue('--lamp-alpha-max')) || 0.22;

      palette = { colors: [a, b], alphaMin: lo, alphaMax: hi };
      for (let i = 0; i < blobs.length; i++) {
        blobs[i].color = palette.colors[i % palette.colors.length];
        blobs[i].alpha = rand(lo, hi);
      }
    }

    function makeBlob(index) {
      return {
        /* Spread horizontally rather than randomly, so the blobs never
           all pile into one half of the screen. */
        home: (index + 0.5) / BLOB_COUNT + rand(-0.06, 0.06),
        radius: rand(MIN_R, MAX_R),
        risePeriod: rand(RISE_MIN, RISE_MAX),
        risePhase: rand(0, Math.PI * 2),
        swayPeriod: rand(SWAY_MIN, SWAY_MAX),
        swayPhase: rand(0, Math.PI * 2),
        breathPeriod: rand(BREATH_MIN, BREATH_MAX),
        breathPhase: rand(0, Math.PI * 2),
        offsetY: 0,
        velocityY: 0,
        bloom: 0,
        color: palette.colors[index % palette.colors.length],
        alpha: rand(palette.alphaMin, palette.alphaMax)
      };
    }

    /* Where a blob is right now, in CSS pixels. The sine on the vertical
       axis is what makes it linger at the top and bottom of its travel
       the way wax does. */
    function placeOf(b) {
      const shorter = Math.min(width, height);
      const radius = shorter * b.radius * (1 + wave(clock, b.breathPeriod, b.breathPhase, BREATH) + b.bloom);
      /* Travel spans the viewport plus a radius at each end, so a blob
         leaves the frame at the turn instead of parking on the edge. */
      const span = (height + radius * 2) / 2;
      return {
        x: b.home * width + wave(clock, b.swayPeriod, b.swayPhase, width * SWAY_X),
        y: height / 2 + wave(clock, b.risePeriod, b.risePhase, span) + b.offsetY,
        r: Math.max(1, radius)
      };
    }

    function step(dt) {
      /* Rolling keystroke rate drives one global multiplier, eased over
         HEAT_EASE seconds so the lamp never changes pace abruptly. */
      const now = performance.now() / 1000;
      while (keyTimes.length && now - keyTimes[0] > SPEED_WINDOW) keyTimes.shift();
      const target = heatTarget(keyTimes.length / SPEED_WINDOW);
      heat += (target - heat) * Math.min(1, dt / HEAT_EASE);

      /* Heat scales how fast the clock runs, so it speeds the whole
         lamp up continuously - there is no position to jump. */
      clock += dt * heat;

      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i];
        const next = springStep(b.offsetY, b.velocityY, dt);
        b.offsetY = next.offset;
        b.velocityY = next.velocity;
        b.bloom = decay(b.bloom, BLOOM_DECAY, dt);
      }
    }

    function drawBlob(b, dim) {
      const p = placeOf(b);
      /* Off screen by more than its own radius: nothing to paint. */
      if (p.y + p.r < 0 || p.y - p.r > height) return;

      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      grad.addColorStop(0, b.color);
      grad.addColorStop(0.55, b.color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.globalAlpha = b.alpha * dim;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    function render(dim) {
      ctx.clearRect(0, 0, width, height);
      /* Additive blending is what makes two blobs read as one mass where
         they overlap, rather than as two discs with a seam. */
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < blobs.length; i++) drawBlob(blobs[i], dim);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    function frame(now) {
      rafId = requestAnimationFrame(frame);
      const t = now / 1000;
      const dt = lastTime ? Math.min(MAX_DT, t - lastTime) : 1 / 60;
      lastTime = t;
      step(dt);
      render(1);
    }

    function loop() {
      if (rafId !== null) return;
      lastTime = 0;
      rafId = requestAnimationFrame(frame);
    }

    function halt() {
      if (rafId === null) return;
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    function start() {
      if (running) return;
      running = true;
      canvas.hidden = false;

      resize();
      if (blobs.length === 0) {
        for (let i = 0; i < BLOB_COUNT; i++) blobs.push(makeBlob(i));
        /* Start mid-cycle so the lamp is never caught all in one place. */
        clock = rand(0, RISE_MAX);
      }
      readPalette();

      /* prefers-reduced-motion: the lamp holds one still frame, dimmer. */
      if (reduceMotion.matches) render(0.6);
      else loop();
    }

    function stop() {
      if (!running) return;
      running = false;
      halt();
      ctx.clearRect(0, 0, width, height);
      canvas.hidden = true;
    }

    function onKeystroke(isError) {
      if (!running) return;
      keyTimes.push(performance.now() / 1000);

      /* Only the blobs nearest the middle of the screen answer, and only
         by a few pixels: at a glance the lamp simply looks alive, and it
         is the rhythm of your typing you notice rather than the hits. */
      const cx = width / 2;
      const cy = height / 2;
      const order = blobs
        .map((b, i) => { const p = placeOf(b); return { i, d: Math.hypot(p.x - cx, p.y - cy) }; })
        .sort((a, b) => a.d - b.d)
        .slice(0, NEAREST);

      for (let n = 0; n < order.length; n++) {
        const b = blobs[order[n].i];
        /* A correct key lifts, a wrong one settles. Same size either
           way, so a mistake reads as a hesitation, not a flash. */
        b.velocityY = kick(b.velocityY, isError ? IMPULSE : -IMPULSE);
        b.bloom = Math.min(MAX_BLOOM, b.bloom + BLOOM);
      }
    }

    /* A hidden tab must not burn frames. */
    document.addEventListener('visibilitychange', () => {
      if (!running || reduceMotion.matches) return;
      if (document.hidden) halt();
      else loop();
    });

    window.addEventListener('resize', () => {
      if (!running) return;
      resize();
      if (reduceMotion.matches) render(0.6);
    });

    /* If the motion preference flips mid-session, honour it immediately. */
    const onMotionChange = () => {
      if (!running) return;
      if (reduceMotion.matches) {
        halt();
        render(0.6);
      } else {
        loop();
      }
    };
    if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionChange);
    else if (reduceMotion.addListener) reduceMotion.addListener(onMotionChange);

    return {
      start,
      stop,
      onKeystroke,
      refreshPalette: () => {
        readPalette();
        if (running && reduceMotion.matches) render(0.6);
      },
      isRunning: () => running,
      count: () => blobs.length
    };
  }

  TT.createLamp = createLamp;
  /* Exported for tests. */
  TT.lampMath = {
    wave, heatTarget, springStep, kick, decay,
    HEAT_IDLE, HEAT_MAX, BLOB_COUNT, MAX_OFFSET, MAX_VELOCITY,
    IMPULSE, MAX_BLOOM, RENDER_SCALE
  };
})(window.TT);
