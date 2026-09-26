// Real BSH current-forecast data — GRIB2 files (U/V vector components on
// a regional lat/lon grid, refreshed twice daily, 15-minute resolution),
// not the WMS map service js/bshWmsLayer.js used to reach for (removed:
// its own style(s) only ever rendered plain dots, not real vectors — see
// README).
//
// BSH publishes several regional GRIB2 files side by side, not just one:
// coarse "macro" circulation models covering a whole sea area (0.5nm
// grid) and much finer "micro" models for individual river/estuary
// stretches (90m grid, where the macro grid is too coarse to resolve a
// fairway channel). This module tracks each region's file independently
// and, given a query point, prefers whichever *micro* region's real grid
// actually covers it, falling back to the macro Deutsche-Bucht model
// otherwise — checked fresh on every call, so a single route computation
// naturally switches models as it moves between regions (e.g. open
// German Bight -> the Elbe fairway -> open German Bight again).
//
// URL pattern per BSH's own documentation (shared directly for this
// integration) and a working reference client (shared directly), which
// disagree on one detail — a "fixname" subdirectory vs. not — so both
// are tried, newest-first:
//
//   https://filebox.bsh.de/Stroemungsvorhersagen/grib2/Current_{code}_today.grb2
//   https://filebox.bsh.de/Stroemungsvorhersagen/grib2/fixname/Current_{code}_today.grb2
//
// The file at either URL is overwritten server-side with the latest
// forecast (no date/hour has to be computed client-side). Whether
// filebox.bsh.de allows cross-origin browser fetches (CORS) at all is
// unverified from this sandbox; if it doesn't, every call here fails
// cleanly and the app falls back to Open-Meteo's current +
// js/tidal.js's heuristic amplification, exactly as if BSH were simply
// unreachable.
import { indexGrib2File, decodeGrib2Grid, messageValidTime } from './gribParser.js';

const FETCH_TIMEOUT_MS = 15000; // a multi-day regional GRIB file is a real download, not a small API call
const FILE_TTL_MS = 6 * 3600 * 1000; // BSH refreshes twice a day; re-fetching every 6h keeps this well within that
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const MAX_TIME_GAP_MINUTES = 20; // 15-minute grid; further than this means a genuine gap (e.g. past the forecast horizon)
const DECODED_GRID_CACHE_SIZE = 16; // per-region small LRU: a route computation only ever touches a handful of distinct timesteps

// GRIB2 discipline 10 = oceanographic products, category 1 = currents,
// parameter number 2 = U component, 3 = V component (WMO code tables
// 0.0 / 4.1-10 / 4.2-10-1) — matches BSH's own description of the file
// as holding separate U/V fields rather than pre-combined speed+direction.
const DISCIPLINE_OCEANOGRAPHIC = 10;
const PARAM_CATEGORY_CURRENTS = 1;
const PARAM_NUMBER_U = 2;
const PARAM_NUMBER_V = 3;

// A generous bounding box around the whole Elbe fairway corridor (mouth
// at the German Bight through Cuxhaven, Brunsbüttel, Glückstadt to
// Hamburg) — used only to decide "is it worth trying the fine Elbe
// grids for this point", not as the grids' real bounds (those come from
// each file's own Grid Definition Section once it's actually loaded).
// The four segments are expected to be non-overlapping stretches along
// the river, so sharing one coarse hint box and letting each file's own
// real bounds do the fine-grained selection is simpler and more robust
// than guessing four precise sub-boxes with no way to verify them.
const ELBE_HINT = { latMin: 53.3, latMax: 54.05, lonMin: 8.0, lonMax: 10.2 };
const WESTERN_BALTIC_HINT = { latMin: 53.7, latMax: 55.0, lonMin: 9.4, lonMax: 13.0 };

// Ordered: micro (fine, region-specific) regions first, macro (coarse,
// wide-area) last — peekBshCurrent checks them in this order and returns
// the first real match, so a micro region takes priority over the macro
// default whenever both happen to cover the same point. `hint: null`
// means "always eligible" (only `db` uses this — the macro default).
const REGION_DEFS = [
  { code: 'AusAlt', kind: 'micro', label: 'Außenelbe – Altenbruch (90 m)', hint: ELBE_HINT },
  { code: 'CuxBru', kind: 'micro', label: 'Cuxhaven – Brunsbüttel (90 m)', hint: ELBE_HINT },
  { code: 'BruPag', kind: 'micro', label: 'Brunsbüttel – Pagensand (90 m)', hint: ELBE_HINT },
  { code: 'PagHam', kind: 'micro', label: 'Pagensand – Hamburg (90 m)', hint: ELBE_HINT },
  { code: 'wb', kind: 'macro', label: 'Westliche Ostsee (0.5 sm)', hint: WESTERN_BALTIC_HINT },
  { code: 'db', kind: 'macro', label: 'Deutsche Bucht (0.5 sm)', hint: null }
];
const DEFAULT_REGION_CODE = 'db';

// Per-region runtime state, created lazily on first reference.
const regionState = new Map(); // code -> { fileCache, fileFailedAt, fetchInFlight, decodedCache }

function getRegionState(code) {
  let rs = regionState.get(code);
  if (!rs) {
    rs = { fileCache: null, fileFailedAt: null, fetchInFlight: null, decodedCache: new Map() };
    regionState.set(code, rs);
  }
  return rs;
}

function pointInHint(lat, lon, hint) {
  if (!hint) return true;
  return lat >= hint.latMin && lat <= hint.latMax && lon >= hint.lonMin && lon <= hint.lonMax;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function candidateUrlsFor(code) {
  return [
    `https://filebox.bsh.de/Stroemungsvorhersagen/grib2/Current_${code}_today.grb2`,
    `https://filebox.bsh.de/Stroemungsvorhersagen/grib2/fixname/Current_${code}_today.grb2`
  ];
}

async function fetchAndIndexRegion(code) {
  const errors = [];
  for (const url of candidateUrlsFor(code)) {
    try {
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) { errors.push(`${url} -> HTTP ${res.status}`); continue; }
      const buffer = await res.arrayBuffer();

      // Indexing can legitimately fail on individual unsupported messages
      // (see gribParser.js's module doc on why it throws rather than
      // guesses) — a file dominated by an unsupported encoding is a hard
      // failure for that candidate, not a partial success, since a
      // silently-truncated message list could make interpolation between
      // "adjacent" timesteps secretly span a much bigger real time gap
      // than MAX_TIME_GAP_MINUTES would otherwise catch.
      const messages = indexGrib2File(buffer);
      const uMessages = messages.filter(m => m.discipline === DISCIPLINE_OCEANOGRAPHIC && m.paramCategory === PARAM_CATEGORY_CURRENTS && m.paramNumber === PARAM_NUMBER_U);
      const vMessages = messages.filter(m => m.discipline === DISCIPLINE_OCEANOGRAPHIC && m.paramCategory === PARAM_CATEGORY_CURRENTS && m.paramNumber === PARAM_NUMBER_V);
      if (uMessages.length === 0 || vMessages.length === 0) {
        errors.push(`${url} -> parsed but contained no current U/V messages (${messages.length} total messages)`);
        continue;
      }
      return { fetchedAt: Date.now(), buffer, uMessages, vMessages };
    } catch (err) {
      errors.push(`${url} -> ${err.message || err}`);
    }
  }
  throw new Error(`All GRIB candidates failed for region "${code}": ${errors.join('; ')}`);
}

// Fire-and-forget cache warm-up for one region, mirroring js/bshTides.js's
// warmTideCache: kicks off the fetch+index chain if it isn't already in
// flight or recently failed, so a *later* peek call can find it ready.
// Never throws, never needs awaiting.
export function warmBshGribRegion(code) {
  const rs = getRegionState(code);
  if (rs.fetchInFlight) return;
  if (rs.fileCache && Date.now() - rs.fileCache.fetchedAt < FILE_TTL_MS) return;
  if (rs.fileFailedAt && Date.now() - rs.fileFailedAt < FAILURE_BACKOFF_MS) return;

  rs.fetchInFlight = fetchAndIndexRegion(code)
    .then((result) => { rs.fileCache = result; rs.fileFailedAt = null; rs.decodedCache.clear(); })
    .catch(() => { rs.fileFailedAt = Date.now(); })
    .finally(() => { rs.fetchInFlight = null; });
}

function decodeCached(rs, message) {
  const key = `${message.paramNumber}_${message.forecastMinutes}`;
  let grid = rs.decodedCache.get(key);
  if (grid) { rs.decodedCache.delete(key); rs.decodedCache.set(key, grid); return grid; } // refresh LRU order
  grid = decodeGrib2Grid(rs.fileCache.buffer, message);
  rs.decodedCache.set(key, grid);
  if (rs.decodedCache.size > DECODED_GRID_CACHE_SIZE) {
    rs.decodedCache.delete(rs.decodedCache.keys().next().value);
  }
  return grid;
}

function findNearestMessage(messages, date) {
  let best = null, bestGapMs = Infinity;
  for (const m of messages) {
    const gap = Math.abs(messageValidTime(m).getTime() - date.getTime());
    if (gap < bestGapMs) { bestGapMs = gap; best = m; }
  }
  if (!best || bestGapMs > MAX_TIME_GAP_MINUTES * 60000) return null;
  return best;
}

// Bilinear-interpolates one decoded grid at (lat, lon). Returns null if
// the point falls outside the grid's own declared bounds — never
// extrapolates. Assumes the row-major, north-to-south, west-to-east
// layout gribParser.js's decodeGrib2Grid guarantees (it refuses to
// decode anything else).
function sampleGrid(grid, meta, lat, lon) {
  const { nx, ny, lat1, lon1, di, dj } = meta;
  // lat1 is the northernmost row (row 0); latitude decreases with dj per row.
  let fi = (lon - lon1) / di;
  let fj = (lat1 - lat) / dj;
  // GRIB grid bounds are quantized to integer microdegrees, so lat1/lon1/
  // di/dj each carry independent rounding — a query at the exact edge of
  // a grid can land a hair outside [0, n-1] purely from that rounding,
  // not because it's genuinely off the grid. A tenth of a cell of
  // tolerance is physically meaningless (grid spacing is 90m-0.5nm) but
  // avoids spuriously rejecting a legitimate edge point.
  const EPS = 0.1;
  if (fi < -EPS || fi > nx - 1 + EPS || fj < -EPS || fj > ny - 1 + EPS) return null;
  fi = Math.min(Math.max(fi, 0), nx - 1);
  fj = Math.min(Math.max(fj, 0), ny - 1);

  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, ny - 1);
  const ti = fi - i0, tj = fj - j0;

  const v00 = grid[j0 * nx + i0], v10 = grid[j0 * nx + i1];
  const v01 = grid[j1 * nx + i0], v11 = grid[j1 * nx + i1];
  if ([v00, v10, v01, v11].some(v => Number.isNaN(v))) return null; // inside a bitmap-masked (land) cell

  const top = v00 + (v10 - v00) * ti;
  const bottom = v01 + (v11 - v01) * ti;
  return top + (bottom - top) * tj;
}

function sampleRegion(code, lat, lon, date) {
  const rs = regionState.get(code);
  if (!rs || !rs.fileCache) return null;
  const uMsg = findNearestMessage(rs.fileCache.uMessages, date);
  const vMsg = findNearestMessage(rs.fileCache.vMessages, date);
  if (!uMsg || !vMsg) return null;

  const uGrid = decodeCached(rs, uMsg);
  const vGrid = decodeCached(rs, vMsg);
  const u = sampleGrid(uGrid, uMsg, lat, lon); // m/s, +east
  const v = sampleGrid(vGrid, vMsg, lat, lon); // m/s, +north
  if (u === null || v === null) return null;

  const speedMs = Math.hypot(u, v);
  const curSpeed = +(speedMs * 1.94384).toFixed(2); // m/s -> kn
  const curDir = Math.round((Math.atan2(u, v) * 180 / Math.PI + 360) % 360); // true bearing current flows TOWARD
  return { curSpeed, curDir };
}

// Synchronous, network-free cache read — the routing solver's hot-path
// entry point (see js/tidal.js's peekTidePhase for the identical
// pattern this mirrors). Checks micro regions whose coarse hint box
// contains the point first, then falls back to the macro Deutsche Bucht
// default — so the *model actually used* can change from call to call
// within the same route computation as the query point moves between
// regions, with no separate "mode" to switch. Returns
// {curSpeed (kn), curDir (deg true), regionCode, regionKind} or null
// whenever no loaded region's real grid covers this place/time. Also
// fires background warm-ups (never blocking) for the default region and
// any region whose hint box matches, so a later call can find them ready.
export function peekBshCurrent(lat, lon, date = new Date()) {
  warmBshGribRegion(DEFAULT_REGION_CODE);

  for (const def of REGION_DEFS) {
    if (def.code === DEFAULT_REGION_CODE) continue;
    if (!pointInHint(lat, lon, def.hint)) continue;
    warmBshGribRegion(def.code);
    const result = sampleRegion(def.code, lat, lon, date);
    if (result) return { ...result, regionCode: def.code, regionKind: def.kind, regionLabel: def.label };
  }

  const macroDef = regionDef(DEFAULT_REGION_CODE);
  const macroResult = sampleRegion(DEFAULT_REGION_CODE, lat, lon, date);
  if (macroResult) return { ...macroResult, regionCode: DEFAULT_REGION_CODE, regionKind: 'macro', regionLabel: macroDef.label };
  return null;
}

function regionDef(code) {
  return REGION_DEFS.find(d => d.code === code);
}

// Real (not interpolated) grid nodes from every loaded region that
// overlap the given lat/lon bounds, decimated to roughly
// `maxPointsPerRegion` per region — for js/bshCurrentArrows.js to draw
// an actual vector grid on the map (arrows + speed), the same way BSH's
// own reference tools show it, rather than the smoothed particle-
// animation approximation js/particleField.js uses elsewhere. A region
// with no loaded file, or whose real bounds don't intersect the given
// viewport at all, contributes nothing.
export function getArrowGridSamples(bounds, date = new Date(), maxPointsPerRegion = 400) {
  const out = [];
  for (const def of REGION_DEFS) {
    const rs = regionState.get(def.code);
    if (!rs || !rs.fileCache) continue;
    const uMsg = findNearestMessage(rs.fileCache.uMessages, date);
    const vMsg = findNearestMessage(rs.fileCache.vMessages, date);
    if (!uMsg || !vMsg) continue;

    const { nx, ny, lat1, lon1, di, dj } = uMsg;
    const gridLatMin = lat1 - (ny - 1) * dj, gridLatMax = lat1;
    const gridLonMin = lon1, gridLonMax = lon1 + (nx - 1) * di;
    if (gridLatMax < bounds.south || gridLatMin > bounds.north || gridLonMax < bounds.west || gridLonMin > bounds.east) continue;

    const uGrid = decodeCached(rs, uMsg);
    const vGrid = decodeCached(rs, vMsg);
    const stride = Math.max(1, Math.round(Math.sqrt((nx * ny) / maxPointsPerRegion)));

    for (let j = 0; j < ny; j += stride) {
      const lat = lat1 - j * dj;
      if (lat < bounds.south || lat > bounds.north) continue;
      for (let i = 0; i < nx; i += stride) {
        const lon = lon1 + i * di;
        if (lon < bounds.west || lon > bounds.east) continue;
        const idx = j * nx + i;
        const u = uGrid[idx], v = vGrid[idx];
        if (Number.isNaN(u) || Number.isNaN(v)) continue; // bitmap-masked (land) cell
        const speedMs = Math.hypot(u, v);
        out.push({
          lat, lon,
          curSpeed: +(speedMs * 1.94384).toFixed(2),
          curDir: Math.round((Math.atan2(u, v) * 180 / Math.PI + 360) % 360),
          regionCode: def.code,
          regionKind: def.kind
        });
      }
    }
  }
  return out;
}

export function isAnyBshGribRegionLoaded() {
  for (const rs of regionState.values()) {
    if (rs.fileCache) return true;
  }
  return false;
}

// Per-region load status, for a UI summary — see js/main.js's "BSH
// Strömung" panel.
export function getBshGribRegionStatus() {
  return REGION_DEFS.map((def) => {
    const rs = regionState.get(def.code);
    return {
      code: def.code,
      label: def.label,
      kind: def.kind,
      loaded: !!(rs && rs.fileCache),
      timestepCount: rs && rs.fileCache ? rs.fileCache.uMessages.length : 0,
      recentlyFailed: !!(rs && rs.fileFailedAt && !rs.fileCache)
    };
  });
}

// Awaited variant for an explicit "load/refresh now" UI action — unlike
// warmBshGribRegion (fire-and-forget, silent failure), this loads every
// defined region in parallel and lets the caller show the real, per-
// region outcome. Never throws.
export async function loadBshGribCurrentNow() {
  const regions = await Promise.all(REGION_DEFS.map(async (def) => {
    try {
      const result = await fetchAndIndexRegion(def.code);
      const rs = getRegionState(def.code);
      rs.fileCache = result;
      rs.fileFailedAt = null;
      rs.decodedCache.clear();
      return { code: def.code, label: def.label, kind: def.kind, ok: true, timestepCount: result.uMessages.length };
    } catch (err) {
      const rs = getRegionState(def.code);
      rs.fileFailedAt = Date.now();
      return { code: def.code, label: def.label, kind: def.kind, ok: false, error: err.message || String(err) };
    }
  }));
  return { ok: regions.some(r => r.ok), regions };
}
