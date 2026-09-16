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
  particleField.js                Animated wind/current particle overlay
  departureWindow.js               Compares routes across a ±X hour window
  main.js                           Entry point: map init + event wiring
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
