/* =================================================================
   petals.js - the falling sakura petals.

   A full-viewport canvas behind everything, running only while the
   sakura theme is active. The brief here is restraint: the motion
   should be barely perceptible at a glance and clearly present if you
   watch for three seconds.

   Colours are read from CSS variables, so the light and "night hanami"
   palettes drive the canvas without any JS branching on theme.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  /* The original brief asked for 14-18 petals at 8-16px, tuned to be
     barely perceptible. Both were raised on request: at 16px the cleft
     tip and the tumble are too small to see, which is the part worth
     looking at. Still a background, still a hard ceiling. */
  const BASE_COUNT = 18;      // steady-state petals on screen
  const MAX_COUNT = 24;       // hard ceiling, never exceeded
  const MIN_FALL = 22;        // seconds from top of viewport to bottom
  const MAX_FALL = 40;
  const MIN_SIZE = 13;        // px
  const MAX_SIZE = 26;
  const SWAY_MIN = 20;        // px of horizontal sway
  const SWAY_MAX = 50;
  const PERIOD_MIN = 6;       // seconds per sway cycle
  const PERIOD_MAX = 10;
  const ROT_MIN = 0.05;       // degrees per frame at 60fps
  const ROT_MAX = 0.15;
  const FADE_IN = 0.10;       // fade in over the first 10% of travel
  const FADE_OUT = 0.20;      // fade out over the last 20%
  const FLUTTER_MIN = 1.6;    // seconds per tumble, edge-on and back
  const FLUTTER_MAX = 3.4;
  const MIN_SCALE = 0.14;     // a petal turned edge-on stays a visible sliver
  const TIP_LIGHTEN = 0.32;   // how far the tip is mixed toward white

  const DRIFT_IDLE = 1.0;
  const DRIFT_MAX = 1.8;      // cap - a breeze through the blossom, not a storm
  const DRIFT_EASE = 1.1;     // seconds to ease between idle and max
  const IMPULSE = 1.1;        // px per frame at 60fps
  const IMPULSE_DECAY = 1.5;  // per second
  const DRIFT_LIMIT = 120;    // px a petal may wander from its sway path
  const LIFT_IMPULSE = 0.5;   // px per frame at 60fps, while the gust lasts
  const LIFT_DECAY = 1.6;     // per second, for both the impulse and the lift
  const LIFT_LIMIT = 60;      // px a petal may ever be held off its fall
  const SPIN_KICK = 0.9;      // extra degrees per frame, decaying
  const SPIN_DECAY = 1.4;
  const SPIN_LIMIT = 2.2;
  const SPEED_WINDOW = 2.0;   // seconds of keystrokes treated as "now"
  const SPEED_FOR_MAX = 8;    // keystrokes/sec that reaches the cap
  const NEAREST = 5;          // petals caught by each keystroke
  const MAX_DT = 0.1;         // clamp so a stalled tab cannot teleport petals

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* Opacity envelope across a petal's fall: in over the first tenth,
     out over the last fifth, never popping at either end. */
  function envelope(progress) {
    if (progress <= 0 || progress >= 1) return 0;
    if (progress < FADE_IN) return progress / FADE_IN;
    if (progress > 1 - FADE_OUT) return (1 - progress) / FADE_OUT;
    return 1;
  }

  /* Rolling typing speed to a global drift multiplier, hard-capped. */
  function driftTarget(keysPerSecond) {
    const t = clamp(keysPerSecond / SPEED_FOR_MAX, 0, 1);
    return DRIFT_IDLE + (DRIFT_MAX - DRIFT_IDLE) * t;
  }

  /* How wide a petal reads as it tumbles. A real petal turns edge-on
     twice a cycle; holding a floor keeps it from blinking out entirely
     at the crossing. */
  function flutterScale(phase) {
    const c = Math.cos(phase);
    return c < 0 ? Math.min(c, -MIN_SCALE) : Math.max(c, MIN_SCALE);
  }

  /* Mix a hex colour toward white, for the lighter tip of the petal. */
  function lighten(hex, amount) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const mix = (c) => Math.round(c + (255 - c) * clamp(amount, 0, 1));
    const r = mix((n >> 16) & 255);
    const g = mix((n >> 8) & 255);
    const b = mix(n & 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function createPetals(canvas) {
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let petals = [];
    let width = 0;
    let height = 0;
    let rafId = null;
    let lastTime = 0;
    let running = false;
    let drift = DRIFT_IDLE;
    let keyTimes = [];
    let palette = { colors: ['#F8C8D4', '#FFDDE4'], alphaMin: 0.15, alphaMax: 0.35 };

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      const previousHeight = height;

      width = w;
      height = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      /* Keep petals at the same relative height so a resize does not
         make them jump or all recycle at once. */
      if (previousHeight > 0 && h > 0) {
        const ratio = h / previousHeight;
        for (let i = 0; i < petals.length; i++) {
          petals[i].y *= ratio;
          petals[i].baseX = Math.min(petals[i].baseX, w);
        }
      }
    }

    function readPalette() {
      const cs = getComputedStyle(document.documentElement);
      const a = cs.getPropertyValue('--petal-a').trim() || '#F8C8D4';
      const b = cs.getPropertyValue('--petal-b').trim() || a;
      const lo = parseFloat(cs.getPropertyValue('--petal-alpha-min')) || 0.15;
      const hi = parseFloat(cs.getPropertyValue('--petal-alpha-max')) || 0.35;

      palette = { colors: [a, b], alphaMin: lo, alphaMax: hi };
      for (let i = 0; i < petals.length; i++) {
        petals[i].color = pick(palette.colors);
        petals[i].alpha = rand(lo, hi);
        petals[i].fill = null;   // rebuilt on the next draw, in the new colour
      }
    }

    /* atTop: released from just above the viewport. Otherwise the petal
       starts mid-fall, so the screen is never empty on load. */
    function makePetal(atTop) {
      const size = rand(MIN_SIZE, MAX_SIZE);
      return {
        baseX: rand(0, width),
        y: atTop ? -size * 2 : rand(0, height),
        size,
        fall: rand(MIN_FALL, MAX_FALL),
        swayAmp: rand(SWAY_MIN, SWAY_MAX),
        swayPeriod: rand(PERIOD_MIN, PERIOD_MAX),
        swayPhase: rand(0, Math.PI * 2),
        angle: rand(0, Math.PI * 2),
        spin: rand(ROT_MIN, ROT_MAX) * (Math.random() < 0.5 ? -1 : 1),
        color: pick(palette.colors),
        alpha: rand(palette.alphaMin, palette.alphaMax),
        impulse: 0,
        wander: 0,
        lift: 0,
        liftImpulse: 0,
        spinKick: 0,
        flutterPeriod: rand(FLUTTER_MIN, FLUTTER_MAX),
        flutterPhase: rand(0, Math.PI * 2),
        fill: null,
        t: rand(0, PERIOD_MAX)
      };
    }

    /* The gradient is in the petal's own rotated space, so it can be
       built once and reused every frame. */
    function fillFor(p) {
      if (p.fill) return p.fill;
      const r = p.size / 2;
      const grad = ctx.createLinearGradient(0, -r, 0, r);
      grad.addColorStop(0, lighten(p.color, TIP_LIGHTEN));
      grad.addColorStop(1, p.color);
      p.fill = grad;
      return grad;
    }

    function petalX(p) {
      const sway = Math.sin((p.t / p.swayPeriod) * Math.PI * 2 + p.swayPhase) * p.swayAmp;
      return p.baseX + sway + p.wander;
    }

    function drawPetal(p, x, opacity) {
      const r = p.size / 2;
      const scale = flutterScale((p.t / p.flutterPeriod) * Math.PI * 2 + p.flutterPhase);

      ctx.save();
      ctx.translate(x, p.y + p.lift);
      ctx.rotate(p.angle);
      /* Narrowing the petal as it turns is what sells the tumble: the
         same silhouette, seen edge-on and back again. */
      ctx.scale(scale, 1);
      ctx.globalAlpha = opacity;
      ctx.fillStyle = fillFor(p);

      /* A sakura petal: full at the base, tapering to a cleft tip. */
      ctx.beginPath();
      ctx.moveTo(0, r);
      ctx.bezierCurveTo(r * 0.78, r * 0.62, r * 0.98, -r * 0.36, r * 0.30, -r * 0.92);
      ctx.quadraticCurveTo(r * 0.14, -r * 0.62, 0, -r * 0.74);
      ctx.quadraticCurveTo(-r * 0.14, -r * 0.62, -r * 0.30, -r * 0.92);
      ctx.bezierCurveTo(-r * 0.98, -r * 0.36, -r * 0.78, r * 0.62, 0, r);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function step(dt) {
      /* Rolling keystroke rate drives a global drift multiplier, eased
         over DRIFT_EASE seconds so nothing changes abruptly. */
      const now = performance.now() / 1000;
      while (keyTimes.length && now - keyTimes[0] > SPEED_WINDOW) keyTimes.shift();
      const target = driftTarget(keyTimes.length / SPEED_WINDOW);
      drift += (target - drift) * Math.min(1, dt / DRIFT_EASE);

      for (let i = petals.length - 1; i >= 0; i--) {
        const p = petals[i];

        p.t += dt;
        p.y += (height / p.fall) * drift * dt;
        /* spin is degrees per frame at 60fps; convert to radians per second.
           The kick rides on top and fades, so a gust sets petals turning. */
        p.angle += (p.spin + p.spinKick) * 60 * (Math.PI / 180) * dt;
        p.spinKick -= p.spinKick * Math.min(1, SPIN_DECAY * dt);

        p.wander = clamp(p.wander + p.impulse * 60 * dt, -DRIFT_LIMIT, DRIFT_LIMIT);
        p.impulse -= p.impulse * Math.min(1, IMPULSE_DECAY * dt);

        /* Lift is a display offset only: the fall itself keeps its own
           clock, so a gust cannot stall a petal or break its fade. */
        p.lift = clamp(p.lift + p.liftImpulse * 60 * dt, -LIFT_LIMIT, LIFT_LIMIT);
        p.liftImpulse -= p.liftImpulse * Math.min(1, LIFT_DECAY * dt);
        p.lift -= p.lift * Math.min(1, LIFT_DECAY * dt);

        if (p.y - p.size > height) {
          /* Extras released by errors are retired rather than recycled,
             so density breathes back down to the steady state. */
          if (petals.length > BASE_COUNT) petals.splice(i, 1);
          else petals[i] = makePetal(true);
        }
      }
    }

    function render() {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < petals.length; i++) {
        const p = petals[i];
        const opacity = envelope(p.y / height) * p.alpha;
        if (opacity <= 0.001) continue;
        drawPetal(p, petalX(p), opacity);
      }
    }

    /* prefers-reduced-motion: petals stay exactly where they are, dimmer. */
    function renderFrozen() {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < petals.length; i++) {
        const p = petals[i];
        drawPetal(p, petalX(p), p.alpha * 0.6);
      }
    }

    function frame(now) {
      rafId = requestAnimationFrame(frame);
      const t = now / 1000;
      const dt = lastTime ? Math.min(MAX_DT, t - lastTime) : 1 / 60;
      lastTime = t;
      step(dt);
      render();
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
      readPalette();
      if (petals.length === 0) {
        for (let i = 0; i < BASE_COUNT; i++) petals.push(makePetal(false));
      }

      if (reduceMotion.matches) renderFrozen();
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

      /* A gust, centred on where you are looking. The petals nearest the
         middle are pushed outward and briefly held up, and set turning;
         the ones further out feel less of it, so the air reads as one
         movement through the whole field rather than five separate hits. */
      const cx = width / 2;
      const cy = height / 2;
      const order = petals
        .map((p, i) => ({ i, d: Math.hypot(petalX(p) - cx, p.y - cy) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, NEAREST);

      for (let n = 0; n < order.length; n++) {
        const p = petals[order[n].i];
        /* Falls off across the group, so the nearest petal moves most. */
        const share = 1 - (n / NEAREST) * 0.55;
        const away = petalX(p) < cx ? -1 : 1;

        p.impulse = clamp(p.impulse + IMPULSE * away * share, -IMPULSE, IMPULSE);
        p.liftImpulse = clamp(
          p.liftImpulse - LIFT_IMPULSE * share, -LIFT_IMPULSE, LIFT_IMPULSE
        );
        p.spinKick = clamp(p.spinKick + SPIN_KICK * away * share, -SPIN_LIMIT, SPIN_LIMIT);
      }

      /* An error releases one more petal. No shake, no flash. */
      if (isError && petals.length < MAX_COUNT) petals.push(makePetal(true));
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
      if (reduceMotion.matches) renderFrozen();
    });

    /* If the motion preference flips mid-session, honour it immediately. */
    const onMotionChange = () => {
      if (!running) return;
      if (reduceMotion.matches) {
        halt();
        renderFrozen();
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
        if (running && reduceMotion.matches) renderFrozen();
      },
      isRunning: () => running,
      count: () => petals.length
    };
  }

  TT.createPetals = createPetals;
  /* Exported for tests. */
  TT.petalMath = {
    envelope, driftTarget, flutterScale, lighten,
    DRIFT_IDLE, DRIFT_MAX, BASE_COUNT, MAX_COUNT, MIN_SCALE
  };
})(window.TT);
