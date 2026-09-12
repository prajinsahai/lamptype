# LampType

A quiet typing test with a lava lamp behind it. The lamp drifts on its own and
answers your keystrokes; everything else on the page stays out of the way.

No build step, no dependencies, no network calls.

## Run it

Open `index.html` in a browser. That is the whole setup.

If you would rather serve it over http (needed only if you later switch to ES
modules):

```
python -m http.server 8000 --directory .
```

## What it does

- **Modes** - time (15 / 30 / 60 / 120s), words (10 / 25 / 50 / 100) and
  **1 word** (15 / 30 / 60 / 120s), with punctuation and numbers toggles.
- **1 word** - a timed run showing one word at a time. Finish the word and the
  next one appears on its own; you never see what is coming. See below.
- **Live feedback** - per-character colouring, a hairline caret, running WPM, and
  a three-line view that scrolls as you go.
- **Results** - WPM, raw, accuracy, consistency and a character breakdown, with a
  WPM-over-time chart that draws itself in and numbers that shuffle into place.
- **Racing** - a 1v1 against an AI opponent that calibrates to your speed.
- **The lava lamp** - the default backdrop, and it reacts to every keystroke.
  See below.
- **Themes** - lava lamp (default), paper, ink, linen, oxide, iris, and sakura
  blossoms.
- **Ad slot** - a reserved 728x90 leaderboard below the test (320x50 on narrow
  screens). See below.
- **History** - every completed test is kept in `localStorage`, with personal
  bests derived per mode. Nothing leaves the browser. The panel is a native
  `<dialog>`, so focus moves into it, stays inside it, and comes back out where
  it started without any of that being written by hand. **Clear history** asks
  once - the button becomes "click again to clear" for four seconds - because
  the wipe is irreversible and there is nowhere to undo it from.

### Colour and contrast

Two greys, not one. `--sub` is untyped text and stays dim - that recession is
the look of a typing test, and brightening it would flatten the distinction
between what you have typed and what you have not. `--label` is everything
else: the small tracked labels, the hints, the buttons, the ad furniture. It
clears WCAG AA (4.5:1) in all seven themes, sakura included.

They used to be the same variable, which is what made the chrome fail: the
labels inherited a colour chosen for untyped words, and three `opacity`
dimmers on `.hint`, `.ad-label` and `.ad-note` then pushed it further down, to
as low as 2.17:1. Those dimmers are gone - if something should be quieter now,
give it its own colour rather than fading a colour that was already at its
floor.

The automated tier (`@accesslint/core` against the live DOM) reports no
violations on the default theme. Untyped text is deliberately outside that:
it sits between 1.77:1 and 3.95:1 depending on the theme.

Every control is at least 24x24px, which is what WCAG 2.2 asks of a target. The
type is unchanged: the buttons here have no box to grow, so the hit area is
padded out around them and only the rule under the shortest lengths got wider.
The one exception is the link inside the sentence in the footer, which is
exempt as an inline target.

## Keys

| key | action |
| --- | --- |
| `tab` | restart / next test |
| `esc` | restart |
| `ctrl` + `backspace` | delete the current word |
| `space` | skip to the next word |

Backspace crosses back into the previous word only if that word still has a
mistake in it.

For **two seconds after a test ends**, the results screen ignores every keyboard
route to a new test. A test can finish mid-keystroke - especially in time mode -
and without this, carrying on typing throws the results away before they have
been read. Two things make it work:

- `tab` and `esc` are refused for the length of the window.
- Focus is not handed to the "next test" button until the window lifts. A
  focused button is activated by the space bar, so taking focus immediately is
  itself the fastest way to lose the results.

The restart control dims while the window is open. A **mouse click** is always
honoured, guard or not - it is unambiguous - as is changing mode from the mode
bar. Only the keyboard is held back.

## How the numbers are defined

```
wpm         = (correct characters / 5) / minutes
raw         = (all typed characters / 5) / minutes
accuracy    = correct keystrokes / all keystrokes
consistency = 100 * (1 - stdev / mean) over per-second raw wpm
```

Accuracy is a running tally of keystrokes, not a re-reading of the final text, so
a mistake you go back and fix still costs you. Tests shorter than one second are
shown but not recorded, since their WPM is arithmetic noise.

## The look

Set like a printed page rather than an app: one centred measure, hairline rules
instead of boxes, and no cards, shadows or filled buttons anywhere. The words are
set in a serif; every label is a small tracked uppercase sans. Colour appears
only where it carries meaning - the active setting, the caret, your speed, an
error. The lamp is the only thing on the page allowed to move on its own, and it
lives entirely behind the text.

Fonts are OS stacks, not webfonts, so the page still works offline and off a
`file://` URL.

The motion is deliberately small: the active setting is marked by a rule that
slides between the choices, a new passage lifts into place, the caret slides and
breathes rather than blinking hard, a new word in 1-word mode rises as the last
is committed, the test and results screens crossfade into each other, and on the
results screen the graph paints itself left to right while the numbers shuffle
out of random digits. Everything is under 350ms except the results reveal, which
finishes inside 650ms. `prefers-reduced-motion` turns all of it off.

Two of those are worth knowing about:

- **The rule under the active setting slides**, rather than one rule per button
  fading in while another fades out. Mode and length are single-select, so there
  is one rule per group and it travels; the include toggles keep a rule each,
  because both can be lit at once. This is also why `renderModeBar` reuses its
  buttons instead of rebuilding the row: a button born with `.active` already on
  it has no state to animate from, and replacing a focused button drops keyboard
  focus to `<body>`.
- **The test and results views crossfade** through
  `document.startViewTransition()`, sharing one `view-transition-name` so the
  swap is a single element changing size. Only the entering view used to be
  animated - the outgoing one went to `display:none` on the spot, which no CSS
  transition can reach across, so the page collapsed and the new panel lifted
  into the gap. The `view-in` keyframes are still there for browsers without
  view transitions, and are switched off by `@supports` where they exist. The
  swap is skipped entirely under `prefers-reduced-motion`, which the `*` rule in
  `style.css` cannot reach on its own.

## Layout

```
index.html      the test itself; scripts load in dependency order
about.html      what it is and how the numbers work
privacy.html    privacy policy
terms.html      terms of use
support.html    help, FAQ, bug reports
404.html        not found
tests.html      self tests - open it, everything should say PASS
css/themes.css  one CSS-variable block per theme
css/page.css    the prose pages (privacy, terms, support, about, 404)
css/sakura.css  the sakura blossoms theme (a full skin, see below)
css/style.css   layout and components
js/words.js     word pool and text generation
js/stats.js     the arithmetic, as pure functions
js/storage.js   settings, history, derived personal bests
js/chart.js     the canvas graph, static and animating in
js/reveal.js    the results-screen number shuffle
js/lamp.js      the lava lamp canvas (lamp theme only)
js/petals.js    the falling-petal canvas (sakura only)
js/race.js      the AI opponent: speed model and position
js/engine.js    typing state machine (no DOM)
js/render.js    word painting, caret, line scroll
js/ui.js        mode bar, results screen, history modal
js/main.js      wiring, keyboard and focus handling

robots.txt              crawl policy, points at the sitemap
sitemap.xml             the five public pages
ads.txt                 AdSense authorised sellers - REVENUE DEPENDS ON THIS
site.webmanifest        installable-app metadata
.well-known/security.txt  who to tell about a vulnerability
_headers                security + caching headers (Netlify, Cloudflare Pages)
vercel.json             the same policy for Vercel
LICENSE                 MIT, plus third-party provenance
favicon.ico/.svg, apple-touch-icon.png, icon-*.png, og-image.png
```

`js/engine.js` and `js/stats.js` never touch the DOM, which is what lets
`tests.html` drive them directly.

## Racing

Hit **start race** for a 1v1 against an AI opponent. Two hairlines above the
passage show how far each of you has got; yours is the accent colour, the
opponent's is deliberately quieter.

A race needs a finish line, so it always runs over a fixed number of words -
starting one switches the mode bar to `words` rather than letting it show
something other than what is running. Time mode has nothing to race toward, and
selecting it leaves race mode.

**The opponent starts on your first keystroke**, not when you press the button.
Otherwise it is already moving while you are still reading and the race is lost
to reaction time rather than typing.

Race mode is sticky: `tab` from the results lines up a fresh opponent, so you
can go again without reaching for the mouse. Press the button again to leave.

### How fast the opponent is

| races behind you | opponent speed |
| --- | --- |
| 1-5 | a random draw from 32-78 wpm |
| 6 | your recent average - a dead heat |
| 7+ | your average, +2% per race |
| 15+ | your average +20%, and it stays there |

The first few races are random because there is not enough of a picture of you
yet, and guessing badly early is what makes an opponent feel unfair. After that
it tracks the mean of your last 10 results, so it follows you up as you improve
and eases off if you have a bad run. Every race also gets +/-8% of jitter so no
two feel identical.

The ramp is capped on purpose. An opponent that keeps getting faster forever
stops being a competition and becomes a wall. Only races longer than a second
count toward the tally, so a string of instant finishes cannot inflate it.

### One clock, two racers

The opponent's position is a closed-form function of elapsed race time, not an
accumulation of per-frame movement:

```
speed(t)    = cps * (1 + 0.10*sin(2*pi*t/P + phase))
position(t) = cps * (t - (0.10*P/2pi) * (cos(2*pi*t/P + phase) - cos(phase)))
```

That matters for fairness rather than tidiness. Your wpm is measured against the
wall clock, so an opponent built from frame deltas falls behind whenever the
browser drops frames - a stalled tab, a slow machine, a background window - and
you would win races you had not earned. Sharing one clock keeps both racers on
the same footing, makes the outcome independent of frame rate, and lets the
opponent be tested exactly. The winner is likewise decided by reading the clock
at the finish, not by trusting a flag the render loop may never have set.

The sine term is what stops the opponent reading as a metronome: it drifts
around its target speed the way a person does.


## The lava lamp

Seven soft blobs on a canvas behind the page, drawn at half resolution and
blurred in CSS - cheaper than painting those edges by hand, and softer. Additive
blending is what makes two blobs read as one mass where they overlap instead of
as two discs with a seam.

Each blob rises and sinks on a **sine of elapsed time**. That is where the
lamp's character comes from: slowest at the turn, quickest through the middle.
It also means position is a closed form rather than an accumulation of
per-frame steps, so a dropped frame changes nothing about where a blob is.

### How it answers a keystroke

Three things happen, all of them continuous:

- **A kick on a spring.** Every keystroke gives the four blobs nearest the
  centre of the screen a velocity impulse on a spring tethered to their own
  path. One keystroke swings a blob about 24px. A correct key lifts, a wrong one settles - same size either way, so a
  mistake reads as a hesitation rather than a flash. The spring is damped just
  under critical, so a blob swings, overshoots once, and comes to rest. Offset
  and velocity are both clamped, so no amount of typing can fling one across
  the screen.
- **A swell.** The same blobs grow by a few percent, up to 28%, and shrink back.
  This is the part you notice first, because it lands on the frame you type.
- **Heat.** A rolling two-second keystroke rate eases a single global multiplier
  between 1.0x and 1.7x, over about a second. It scales how fast the lamp's
  clock runs, so the whole field speeds up smoothly - there is no position to
  jump. The cap is the point: a lamp, never a lava flow.

Nothing a keystroke does moves a blob's path, only borrows it for a moment.

### Keeping it smooth

- Half-resolution canvas: the result is blurred anyway, so the pixels are free.
- Seven blobs, three of them reacting - the whole frame is a handful of radial
  gradients.
- `dt` is clamped, so a stalled tab cannot jump the phase when it wakes.
- The loop stops entirely on a hidden tab, and on any theme but this one.
- `prefers-reduced-motion` holds a single still frame at 60% brightness.

The canvas carries a 17px CSS blur - enough that the blobs stay soft shapes
behind the words rather than anything the eye tries to focus on, but low enough
to keep their form. Typed text still measures **9.24:1 against the brightest
point the backdrop ever reaches**, past AAA, so the lamp never costs you
readability.

## 1 word mode

A timed run - it ends on the clock, not on a word count - but only one word is on
screen at a time. **There is no space to press:** typing the last letter of the
word is what commits it, and the next word appears immediately. You cannot read
ahead, so there is no rhythm to settle into - every word is a cold start.

What follows from that, and is deliberate:

- **Only an exact match advances.** A word with a mistake in it stays where it
  is until you backspace and fix it. A side effect worth knowing: a correct word
  is gone before another character can land on it, so it can never be overtyped.
- **A space out of habit is ignored.** After a word commits itself, a stray space
  would arrive on the fresh word and skip it unseen, so on an untouched word
  space does nothing at all.
- **Space still gives up on a word you have started.** If you have mistyped a
  word and would rather move on than fix it, space skips it and the rest of it
  counts as missed - the same as in every other mode.
- **Backspace stops at the word boundary.** In the other modes it will cross back
  into a word you got wrong. Here that word is off the screen, so crossing back
  would be a trap rather than a correction.
- **The separator is still counted.** WPM credits the space you did not have to
  press, so a 1-word run is directly comparable to a time or words run rather
  than reading about 15% slow.
- **The pool refills as you go**, exactly as in time mode, so a fast run can
  never exhaust it.

Each mode remembers its own length, so switching between them does not clobber
the setting of the one you left.

## The ad slot

`.ad-slot` near the bottom of `index.html` reserves a 728x90 leaderboard, falling
back to 320x50 under 720px. The box keeps its height whether or not anything
fills it, so nothing on the page moves when an ad arrives. To use it, drop the ad
tag inside `#ad-leaderboard` and delete the placeholder `<span>`.

## Sakura Blossoms

The one theme that is more than a palette, so it lives in its own file
(`css/sakura.css`) and its own module (`js/petals.js`) rather than in
`themes.css` with the others. Selecting it also changes:

- **Typography** - a light serif wordmark ("Cherry Blossoms"), 25px monospace
  typing text at 1.9 line-height, and 13px uppercase tracked labels.
- **Layout** - a 720px column with the stats row moved below the typing area.
- **Stats** - the running wpm readout is dropped entirely and the stats row
  fades to 40% while typing, so no number competes with the line being typed.
  The countdown stays, because it is the test's clock rather than a score.
- **Caret** - eases between characters and breathes on a 1.1s cycle instead of
  blinking on and off.
- **Errors** - wrong characters take a hairline underline; the word-level
  underline used by the other themes is suppressed so they do not double up.
- **Petals** - 18 petals drift down over 22-40 seconds, capped at 24. Each one
  is a sakura petal with a cleft tip, filled with a gradient that lightens
  toward that tip, and it **tumbles**: a per-petal cycle narrows it to a sliver
  and opens it back out, so it reads as turning in three dimensions rather than
  sliding flat. A floor on that width keeps it from blinking out at the
  crossing.
- **Petals, while you type** - each keystroke is a gust. The five petals
  nearest the centre are pushed outward, briefly held up against their fall,
  and set spinning, with the effect falling off across the group so it reads as
  one movement of air rather than five separate hits. A rolling keystroke rate
  eases a global drift multiplier up to a ceiling of 1.8x. An error releases
  one extra petal. Everything is lerped; nothing snaps.

  The lift is a display offset only - the fall keeps its own clock - so a gust
  can never stall a petal or break its fade in and out.

  > The original brief for this theme asked for barely-perceptible motion:
  > 14-18 petals at 8-16px, nudged by a fraction of a pixel, capped at 1.35x.
  > The petal count, size, gust strength and drift ceiling were all raised
  > later, on request, for a livelier and more visible response.

It ships light (default) and dark ("night hanami") variants. Dark follows
`prefers-color-scheme` unless the day/night control pins it, which sets
`data-mode` on `<html>`.

`prefers-reduced-motion: reduce` freezes the petals in place at lower opacity
and starts no animation loop at all. The canvas also stops when the tab is
hidden and when you switch to any other theme.

### Fonts

The brief asks for Cormorant Garamond / Zen Old Mincho and JetBrains Mono /
IBM Plex Mono. Those are named first in the font stacks but are **not** loaded
over the network, because a hard rule of this project is that it works offline
and from `file://`. If you have them installed they are used; otherwise it falls
back to a system serif and the system monospace. To fetch them instead, add a
Google Fonts `<link>` to `index.html` - at the cost of offline use.

### Contrast

Typed text is 12.07:1 (light) and 15.58:1 (dark) against its background, well
past WCAG AA. Untyped text uses the palette's specified `#CDB8BE` / `#4C4250`,
which is 1.77:1 and 1.94:1 - deliberately recessive, and below any WCAG
threshold. That is the brief's intent, but it is worth knowing.

## Deploying

### 1. Fill in every placeholder

Nothing here is guesswork on your behalf. Find them all with:

```
grep -rn "TODO-\|lamptype.example\|pub-0000000000000000" .
```

| Placeholder | Where | What it needs |
|---|---|---|
| `lamptype.example` | every page's canonical/OG tags, `sitemap.xml`, `robots.txt`, `security.txt` | Your real domain |
| `TODO-SUPPORT-EMAIL` | `support.html`, `privacy.html`, `security.txt` | An address that reaches you |
| `TODO-PUBLISHER-NAME` | `privacy.html`, `terms.html`, `LICENSE` | Who operates the site |
| `TODO-EFFECTIVE-DATE` | `privacy.html`, `terms.html` | The date you publish |
| `TODO-COUNTRY` / `TODO-GOVERNING-LAW` | `privacy.html`, `terms.html` | Where you are, whose law applies |
| `pub-0000000000000000` | `ads.txt` | Your AdSense publisher ID |

Also set `<lastmod>` in `sitemap.xml` and push `Expires` in `security.txt` about a
year out - a past date makes scanners treat the file as stale.

### 2. Headers

`_headers` covers Netlify and Cloudflare Pages; `vercel.json` covers Vercel. Both
carry the same policy. For nginx:

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=()" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
# Keep the CSP on one line. Copy the value from _headers so the two cannot drift.
add_header Content-Security-Policy "default-src 'self'; ..." always;
```

**GitHub Pages cannot set custom headers at all.** If you host there you lose the
whole set except what a `<meta http-equiv="Content-Security-Policy">` tag can do,
which is CSP only and not HSTS or Permissions-Policy. Prefer one of the others.

**On the CSP:** AdSense injects inline script and loads from several Google hosts,
so `'unsafe-inline'` is unavoidable. That is a genuine weakening. It is tolerable
here only because this site renders no user-supplied content as HTML - every
string reaching the DOM goes in through `textContent`. Re-audit if that changes.
Ship it as `Content-Security-Policy-Report-Only` first if you want to watch for
breakage before enforcing it.

### 3. AdSense

1. Add the site in AdSense and paste your `ads.txt` line. Revenue depends on this
   and it fails silently.
2. Turn on **Privacy & messaging -> GDPR** in AdSense. That is Google's own
   certified CMP, and since 16 January 2024 a certified CMP integrated with IAB
   TCF v2.2 is **required** to serve personalised ads in the EEA and UK (and in
   Switzerland since 31 July 2024). Without it you get limited ads only there.
   Do not build your own banner - a self-built one cannot satisfy a requirement
   that is specifically for a *certified* CMP.
3. Paste the ad unit inside `#ad-leaderboard` in `index.html` and delete the
   placeholder `<span class="ad-note">`. Leave the `<p class="ad-label">` alone:
   advertising has to stay visibly identifiable.
4. Because school-age visitors are likely, consider Google's age-treatment tag so
   ad requests carry no personalised targeting where age is unknown.

Approval note: AdSense rejects thin sites. `about.html` exists partly for this.

### 4. Before you announce it

- Ship over HTTPS, and check `sitemap.xml`, `robots.txt` and `ads.txt` all load.
- Post the sitemap in Google Search Console.
- Check the link preview renders (`og-image.png` is 1200x630).
- Open `tests.html` on the live site; everything should still say PASS.

## Tests

Open `tests.html`. It runs 73 assertions against the pure functions and the
engine and prints a pass/fail row for each. No npm, no runner.
