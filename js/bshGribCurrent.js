// Real BSH current-forecast data — GRIB2 files (U/V vector components on
// a regional lat/lon grid, refreshed twice daily, 15-minute resolution),
// not the WMS map service js/bshWmsLayer.js used to reach for (removed:
// its own style(s) only ever rendered plain dots, not real vectors — see
// README). Endpoint and directory/filename structure per BSH's own
// documentation (shared directly for this integration, not independently
// verified since this project's sandbox can't reach filebox.bsh.de):
//
//   https://filebox.bsh.de/Stroemungsvorhersagen/grib2/fixname/Current_db_today.grb2
//
// "fixname" is BSH's own constant-filename directory (built for the
// Expedition nav-software's automated background updates) — the file at
// that exact URL is overwritten server-side with the latest forecast, so
// no date/hour has to be computed client-side. "db" = Deutsche Bucht
// (0.5nm grid, the region actually relevant to a Dehler 37 CR sailing
// the German Bight/Wadden Sea — the same area js/tidal.js's heuristic
// targets). Whether filebox.bsh.de allows cross-origin browser fetches
// (CORS) at all is unverified from this sandbox; if it doesn't, every
// call here fails cleanly and the app falls back to Open-Meteo's current
// + js/tidal.js's heuristic amplification, exactly as if BSH data were
// simply unreachable.
import { indexGrib2File, decodeGrib2Grid, messageValidTime } from './gribParser.js';

const FIXNAME_URL = 'https://filebox.bsh.de/Stroemungsvorhersagen/grib2/fixname/Current_db_today.grb2';
const FETCH_TIMEOUT_MS = 15000; // a multi-day regional GRIB file is a real download, not a small API call
const FILE_TTL_MS = 6 * 3600 * 1000; // BSH refreshes twice a day; re-fetching every 6h keeps this well within that
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
// GRIB2 discipline 10 = oceanographic products, category 1 = currents,
// parameter number 2 = U component, 3 = V component (WMO code tables
// 0.0 / 4.1-10 / 4.2-10-1) — matches BSH's own description of the file
// as holding separate U/V fields rather than pre-combined speed+direction.
const DISCIPLINE_OCEANOGRAPHIC = 10;
const PARAM_CATEGORY_CURRENTS = 1;
const PARAM_NUMBER_U = 2;
const PARAM_NUMBER_V = 3;
// Only sample a GRIB timestep if it's within this many minutes of the
// requested time — the file is 15-minute resolution, so anything closer
// than half a step is "the" answer; anything much further means the
// requested time genuinely falls in a gap (e.g. past the 3-day horizon).
const MAX_TIME_GAP_MINUTES = 20;
const DECODED_GRID_CACHE_SIZE = 16; // small LRU: a route computation only ever touches a handful of distinct timesteps

let fileCache = null; // { fetchedAt, buffer, uMessages: [...], vMessages: [...] }
let fileFailedAt = null;
let fetchInFlight = null;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAndIndex() {
  const res = await fetchWithTimeout(FIXNAME_URL, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`BSH GRIB fetch HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();

  // Indexing can legitimately fail on individual unsupported messages
  // (see gribParser.js's module doc on why it throws rather than
  // guesses) — a file dominated by an unsupported encoding is treated
  // as a hard failure, not partially used, since a silently-truncated
  // message list could make interpolation between "adjacent" timesteps
  // secretly span a much bigger real time gap than MAX_TIME_GAP_MINUTES
  // would otherwise catch.
  const messages = indexGrib2File(buffer);
  const uMessages = messages.filter(m => m.discipline === DISCIPLINE_OCEANOGRAPHIC && m.paramCategory === PARAM_CATEGORY_CURRENTS && m.paramNumber === PARAM_NUMBER_U);
  const vMessages = messages.filter(m => m.discipline === DISCIPLINE_OCEANOGRAPHIC && m.paramCategory === PARAM_CATEGORY_CURRENTS && m.paramNumber === PARAM_NUMBER_V);
  if (uMessages.length === 0 || vMessages.length === 0) {
    throw new Error(`BSH GRIB file parsed but contained no current U/V messages (found ${messages.length} total messages)`);
  }

  return { fetchedAt: Date.now(), buffer, uMessages, vMessages };
}

// Fire-and-forget cache warm-up, mirroring js/bshTides.js's
// warmTideCache: kicks off the fetch+index chain if it isn't already in
// flight or recently failed, so a *later* peek call can find it ready.
// Never throws, never needs awaiting.
export function warmBshGribCache() {
  if (fetchInFlight) return;
  if (fileCache && Date.now() - fileCache.fetchedAt < FILE_TTL_MS) return;
  if (fileFailedAt && Date.now() - fileFailedAt < FAILURE_BACKOFF_MS) return;

  fetchInFlight = fetchAndIndex()
    .then((result) => { fileCache = result; fileFailedAt = null; })
    .catch(() => { fileFailedAt = Date.now(); })
    .finally(() => { fetchInFlight = null; });
}

// Small LRU of decoded (unpacked) grids — decoding is CPU-only (the file
// bytes are already in memory) but still real work for a full regional
// grid, and a single route computation would otherwise redecode the same
// timestep's U and V grids on nearly every solver step that lands near
// the same time.
const decodedCache = new Map(); // key: `${paramNumber}_${forecastMinutes}` -> Float32Array

function decodeCached(message) {
  const key = `${message.paramNumber}_${message.forecastMinutes}`;
  let grid = decodedCache.get(key);
  if (grid) { decodedCache.delete(key); decodedCache.set(key, grid); return grid; } // refresh LRU order
  grid = decodeGrib2Grid(fileCache.buffer, message);
  decodedCache.set(key, grid);
  if (decodedCache.size > DECODED_GRID_CACHE_SIZE) {
    decodedCache.delete(decodedCache.keys().next().value);
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
  // the grid (a very real case: the grid is centered on this app's own
  // German Bight operating area) can land a hair outside [0, n-1] purely
  // from that rounding, not because it's genuinely off the grid. A tenth
  // of a cell of tolerance is physically meaningless (grid spacing is
  // 0.5nm) but avoids spuriously rejecting a legitimate edge point.
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

// Synchronous, network-free cache read — the routing solver's hot-path
// entry point (see js/tidal.js's peekTidePhase for the identical
// pattern this mirrors). Returns {curSpeed (kn), curDir (deg true)} or
// null whenever real data isn't usable for this place/time: no file
// cached yet, the point falls outside the grid, or the nearest available
// timestep is too far from the requested time. Never triggers a fetch
// itself.
export function peekBshCurrent(lat, lon, date = new Date()) {
  if (!fileCache) return null;
  const uMsg = findNearestMessage(fileCache.uMessages, date);
  const vMsg = findNearestMessage(fileCache.vMessages, date);
  if (!uMsg || !vMsg) return null;

  const uGrid = decodeCached(uMsg);
  const vGrid = decodeCached(vMsg);
  const u = sampleGrid(uGrid, uMsg, lat, lon); // m/s, +east
  const v = sampleGrid(vGrid, vMsg, lat, lon); // m/s, +north
  if (u === null || v === null) return null;

  const speedMs = Math.hypot(u, v);
  const curSpeed = +(speedMs * 1.94384).toFixed(2); // m/s -> kn
  const curDir = Math.round((Math.atan2(u, v) * 180 / Math.PI + 360) % 360); // true bearing current flows TOWARD
  return { curSpeed, curDir };
}

export function isBshGribCurrentLoaded() {
  return !!fileCache;
}

// Awaited variant for an explicit "load/refresh now" UI action — unlike
// warmBshGribCache (fire-and-forget, silent failure), this lets the
// caller show a real result. Returns {ok: true, timestepCount, gridBounds}
// or {ok: false, error}, never throws.
export async function loadBshGribCurrentNow() {
  try {
    fileCache = await fetchAndIndex();
    fileFailedAt = null;
    decodedCache.clear();
    const sample = fileCache.uMessages[0];
    return {
      ok: true,
      timestepCount: fileCache.uMessages.length,
      gridBounds: sample ? { lat1: sample.lat1, lon1: sample.lon1, lat2: sample.lat2, lon2: sample.lon2 } : null
    };
  } catch (err) {
    fileFailedAt = Date.now();
    return { ok: false, error: err.message || String(err) };
  }
}
