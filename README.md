# Sailrouting — Dehler 37 CR Weather Router

A browser-only isochrone weather router for the Dehler 37 CR: plot waypoints
on a chart, pull live wind/current data, and get a VMG-optimized route with
ETA, leg-by-leg breakdown, and GPX export. An animated particle field
visualizes wind and current across the visible chart (Windy-style), and a
departure-window search compares routes across a range of start times —
optionally drawing every candidate route on the map — to help pick the best
one. There is no backend — every computation runs client-side, and
weather/current data comes straight from the free
[Open-Meteo](https://open-meteo.com/) APIs.

## Project structure

```
index.html          Entry point — markup + CDN script tags (Tailwind, Leaflet, Lucide)
css/styles.css       App-specific styles (Tailwind handles utility classes at runtime)
js/
  constants.js       Polar performance table, presets, map defaults
  geo.js             Geodesic math (distance, bearing, projection, polygon tests)
  polar.js           Boat-speed interpolation over the polar table
  metocean.js         Wind/current fetch (Open-Meteo) with timeout + fallback + cache
  routing.js          Isochrone (wavefront) passage solver
  state.js             Shared app state
  ui.js                 Toast, sidebar drawer, tab switching
  mapLayers.js           Route/wavefront/ray rendering on the Leaflet map
  waypoints.js            Waypoint CRUD + list rendering
  zones.js                 Avoid-zone (hazard/shallows) CRUD + list rendering
  presets.js                Sample voyage presets
  results.js                 Leg table, HUD, route summary rendering
  polarChart.js               Polar diagram canvas drawing
  voyage.js                    Timeline scrubber / playback
  gpx.js                        GPX export
  optimizer.js                  Pure route computation + orchestrates a run
  waves.js                       Directional wave-height speed-penalty model
  particleField.js                 Animated wind/current particle overlay
  departureWindow.js                Compares routes across a ±X hour window
  main.js                            Entry point: map init + event wiring
```

Everything is loaded as native ES modules (`<script type="module">`), so
there is **no build step** — open `index.html` directly, or serve the
folder with any static file server.

## Running locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Native ES modules require a real HTTP origin — opening `index.html` via
`file://` will fail with CORS errors on the module imports.)

## Deployment (GitHub Pages, no backend)

This repo ships a GitHub Actions workflow at
`.github/workflows/deploy-pages.yml` that publishes the site on every push
to `main` using GitHub's official Pages actions
(`actions/configure-pages`, `actions/upload-pages-artifact`,
`actions/deploy-pages`) — no build step, it just deploys the static files.

**One-time setup required in the GitHub UI** (Actions cannot do this for
you):

1. Go to the repository's **Settings → Pages**.
2. Under **Build and deployment → Source**, select **GitHub Actions**.
3. Push to `main` (or re-run the "Deploy static site to GitHub Pages"
   workflow from the **Actions** tab). The site will be published at
   `https://<org-or-user>.github.io/<repo>/`.

After that first setup, every merge to `main` redeploys automatically.

## Wind/current animation and departure-time search

- **Animated wind & current overlay** (header toggle, wind icon): samples
  a 6×5 grid of live wind/current across the current map view, bilinearly
  interpolates it into a continuous flow field, and animates ~350 small
  particles drifting along that field on a transparent canvas layered over
  the map — wind in sky blue, current in emerald, fading trails like
  Windy/earth.nullschool. Refreshes the sampled grid (debounced ~700ms) on
  pan/zoom; the animation itself runs via `requestAnimationFrame` and pans
  with the map every frame. Reuses the same cached `fetchMetoceanData` as
  routing, so it stays polite towards the free API.
- **Beste Abfahrtszeit** (Waypoints tab): given a departure time, a window
  (±1–6 h) and a step size, this runs the full isochrone solve for each
  candidate departure time and lists them sorted by total passage time,
  with the fastest highlighted. Click "Anwenden" on any row to apply that
  candidate as the active route. Check "Alle Varianten auf Karte anzeigen"
  to draw every candidate's route on the map at once as thin, color-coded,
  hoverable lines (cooler/blue = earlier departures, warmer/amber = later
  ones, solid emerald = fastest) so the spread between options is visible
  at a glance. Capped at 15 candidates per search since each one is a full
  route computation.
- The voyage playback scrubber drives the particle field's simulated time
  (`setFieldTime` in `particleField.js`), so the animation reflects
  conditions at the boat's current point in the voyage rather than always
  showing live "now" weather. Position interpolation for both the scrubber
  and the animated boat is done by real elapsed sailing time
  (`routePointTimes`/`elapsedStart` in `optimizer.js`), not by point index —
  a multi-waypoint route inserts a zero-duration point at every interior
  waypoint, so index-based interpolation made the boat appear to stall
  there.
- Each isochrone node's `heading`/`stw`/`sog`/`tws`/`twd` describe the hop
  that *arrived* at it. `computeFullRoute`'s leg-building loop pairs a leg's
  geometry (`nA` → `nB`) with `nB`'s stored fields (the node the hop
  actually arrives at), not `nA`'s (the previous hop) — otherwise a leg
  could display an earlier segment's heading/speed against the current
  segment's true wind angle, which could show an implausible combination
  such as near-full cruising speed at a heading inside the no-go zone,
  especially right at a tack. The isochrone solver's own final "connect to
  the exact waypoint" segment (`routing.js`) similarly recomputes its
  speed honestly for its actual bearing instead of reusing the previous
  node's speed, so a leg pointed into the wind now correctly shows the
  boat crawling at its no-go-zone speed rather than cruising normally.

## Solver quality, multi-pass refinement, and waves

- **Higher-resolution search settings** (Isochronen tab): the time-step,
  fan-width, rays-per-node, and wavefront-sector sliders now go
  meaningfully higher (down to a 2-minute step, up to 31 rays and 96
  sectors) for a finer, more accurate search at the cost of more
  computation. `routing.js`'s internal step cap was also raised (65 → 220)
  so a fine time step on a long leg no longer gets silently truncated
  before reaching the goal.
- **Verfeinerungs-Durchläufe (refinement passes)**: `solveIsochronePassage`
  can take an optional reference path (a previous pass's node headings by
  elapsed time) and biases its reaching/running search fan toward it.
  `solveIsochronePassageRefined` in `routing.js` uses this to run 1-3
  passes, each one narrowing the fan and raising ray/sector resolution
  while seeding from the previous pass's actual route — a "next
  generation" of wavefronts refined around an already-reasonable solution
  instead of resampling from scratch. Defaults to 1 (off, matching prior
  behavior); in one measured case a dead-upwind leg went from 7.07h
  (single pass) to 3.18h (3 passes) — close to the theoretical optimal
  tacking VMG time — by escaping suboptimal choices baked in by the
  single-pass sector-binning search. A later pass's narrower, reference-biased
  fan can fail to find any path at all (e.g. biased toward a hazard); when
  that happens `solveIsochronePassageRefined` falls back to the last
  successful pass instead of discarding it — a refinement pass must never
  make the result worse than not refining. The sector-binning step itself
  filters candidates by their angle from the leg's original bearing, using
  the *current* pass's (possibly narrowed) fan width; when a later pass's
  bias pushes every candidate in a step outside that tolerance window, the
  search now stops advancing and keeps the previous frontier instead of
  continuing with an empty one (which previously crashed reading
  `.distToGoal` off `undefined` — reproduced in ~12% of randomized
  fuzz trials with 2-3 refinement passes before the fix, 0% after).
- **Fixed: refinement producing a bare straight line ("no real routing")**.
  Two independent bugs combined to make this possible, both found by fuzzing
  (random wind/current/wave/geometry/config combinations, replaying the
  exact failing trial to pin down the cause): (1) `polar.js#getDehlerBoatSpeed`
  divided by zero — and silently returned `NaN` — for any wind speed between
  3kn and the polar table's lowest tabulated entry (6kn), since neither
  bracket-matching loop covers that gap; that `NaN` then survived every
  downstream rejection check in the solver, because a `NaN` always makes
  `<`/`<=`/`>`/`>=` comparisons evaluate `false`, so guards written as
  `if (x <= limit) continue;` never catch it. Fixed by ramping linearly from
  the near-calm floor up to the 6kn column instead of falling through to the
  (non-matching) bracket search. (2) The loop-prevention spatial-dominance
  grid pre-seeded the start point's own ~0.8nm cell at time 0; with a fine
  time step (now down to 2 min) a boat's very first hop can be shorter than
  one cell and land back inside it — a perfectly normal small step, not a
  loop — but the check (`storedTime <= arrivalTime + 0.05`) always rejected
  it, since the stored `0` is `<=` any positive arrival time. That could
  silently fail every candidate on step one, killing the whole leg (the
  existing "did the search actually advance" guard then correctly reported
  no route rather than faking a straight line, but a real, findable route
  was lost). Fixed by not seeding the origin's own cell — genuine
  backtracking to the start is already rejected by the strict
  forward-progression check. Verified with 300-trial fuzzing runs (two
  seeds) at 0 thrown exceptions and 0 degenerate 2-node results, both
  before and after, plus a real-browser check confirming a previously
  no-route leg (Cuxhaven → Elbe 1 under a light, non-tabulated wind speed)
  now returns a proper multi-node route.
- **Wave height & direction**: `metocean.js`'s existing marine-API call
  also requests `wave_height`/`wave_direction` (no extra request — bundled
  into the current/wave fetch), threaded through every isochrone node and
  leg alongside wind/current, and shown in the weather HUD and each leg
  card. The animated overlay (`particleField.js`) also drives a third
  violet particle stream from this same live data, alongside the existing
  wind and current streams — visual confirmation, not just numbers, that
  wave conditions are genuinely live and feeding the solver.
- **Wellenempfindlichkeit (wave sensitivity)**: a 0-100% slider (Isochronen
  tab, default 50%) controls `waves.js#getWaveSpeedFactor`, which reduces
  boat speed by wave height (scaled up to a 2.5m reference height) and by
  the wave's angle relative to the boat's heading — head seas cut speed
  the most, following seas the least — floored so speed never drops below
  40% of polar performance. Applied everywhere `getDehlerBoatSpeed` is
  used in the solver, including the final "connect to the exact waypoint"
  segment.
- **Leeway (Abtrift)**: distinct from current set/drift (which was already
  modeled via vector addition of boat velocity + current velocity) —
  leeway is the sideways slip of the hull through the water caused by wind
  pressure on the sails. `polar.js#getLeewayAngle` estimates it with the
  standard small-craft rule of thumb (`K × TWS / STW²`, tapering to zero
  past ~100° TWA since leeway matters close-hauled/reaching and is
  negligible running), and `routing.js` rotates the boat's through-water
  track toward whichever side is downwind of the bow by that angle
  *before* combining it with current — so the reported COG/SOG reflect
  both effects together, while the reported heading stays the steered
  compass heading. Shown per leg as "Abtrift". Not user-configurable (it's
  a physical boat characteristic, not a preference) and not applied to the
  final "connect to the exact waypoint" segment, whose position is pinned
  to the target regardless of heading.

## Notes on production readiness

- Tailwind is loaded via its CDN script (JIT-compiled in the browser).
  This keeps the project buildless, which fits a static, no-backend
  GitHub Pages deployment; if a stricter production setup is ever wanted,
  swap it for a compiled Tailwind CSS file via the Tailwind CLI.
- Weather/current requests use an `AbortController` timeout and fall back
  to sane defaults if the API is slow or unavailable, so the router never
  hangs waiting on a third-party service.
- Dynamic UI (waypoint list, hazard list, leg table) is built with
  `createElement`/`textContent` rather than `innerHTML` string
  interpolation, avoiding injection risk from any future user-editable
  text fields.
