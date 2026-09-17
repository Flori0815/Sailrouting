// Live wind and current data from Open-Meteo's free, no-key-required public
// APIs. Called directly from the browser — no backend involved.
//
// Wind is pinned to `models=icon_seamless` (DWD's ICON-D2 → ICON-EU →
// ICON-Global nest, ~2km out to 48h) instead of the default `best_match`
// — best_match already resolves to this same blend for Northern European
// coastal waters, but pinning it explicitly makes the behavior stable and
// documented rather than depending on Open-Meteo's own undocumented region
// routing. The marine endpoint (waves + current) is left on `best_match`:
// it already routes wave to DWD's regional EWAM model and current to
// Météo-France/CMEMS's merged surface-current product (the only current
// source Open-Meteo has), and there's no single `models=` value that
// selects the right model for both variables at once.
import { applyTidalAmplification } from './tidal.js';
import { peekBshCurrent, warmBshGribCache } from './bshGribCurrent.js';

const FALLBACK = { tws: 14.0, twd: 240, curSpeed: 0.8, curDir: 120, waveHeight: 0.4, waveDir: 240 };
const FETCH_TIMEOUT_MS = 8000;

const metoceanCache = new Map();

// Static source labels (see comment above) plus the time window of the
// most recently fetched hourly data, so the UI can show the sailor exactly
// what's backing the numbers and how far forecast coverage actually
// extends — see js/results.js#renderDataSourcePanel.
const lastCoverage = { wind: null, marine: null, fetchedAt: null, bshGribActive: false };

export function getDataSourceInfo() {
  return {
    wind: {
      label: 'ICON-D2 / ICON-EU / ICON-Global (DWD)',
      resolution: '~2 km (D2, 48h) → ~7 km (EU, 5d) → ~13 km (Global, 7.5d)',
      coverage: lastCoverage.wind
    },
    wave: {
      label: 'DWD EWAM (European Wave Model)',
      resolution: '~5×7 km, Nordsee/Europa',
      coverage: lastCoverage.marine
    },
    current: lastCoverage.bshGribActive
      ? {
          label: 'BSH Strömungsvorhersage (GRIB, real U/V)',
          resolution: '0.5 sm, Deutsche Bucht',
          coverage: lastCoverage.marine
        }
      : {
          label: 'Météo-France / Copernicus Marine (SMOC, global)',
          resolution: '~9 km, inkl. grobem Gezeiten-Anteil (FES2014)',
          coverage: lastCoverage.marine
        },
    fetchedAt: lastCoverage.fetchedAt
  };
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

export async function fetchMetoceanData(lat, lng, targetDate = new Date()) {
  const key = `${lat.toFixed(2)}_${lng.toFixed(2)}_${targetDate.getHours()}`;
  if (metoceanCache.has(key)) return metoceanCache.get(key);

  try {
    const latFmt = lat.toFixed(4);
    const lngFmt = lng.toFixed(4);
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latFmt}&longitude=${lngFmt}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&models=icon_seamless&forecast_days=3`;
    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${latFmt}&longitude=${lngFmt}&hourly=ocean_current_velocity,ocean_current_direction,wave_height,wave_direction&forecast_days=3`;

    const [wRes, mRes] = await Promise.allSettled([
      fetchWithTimeout(weatherUrl, FETCH_TIMEOUT_MS),
      fetchWithTimeout(marineUrl, FETCH_TIMEOUT_MS)
    ]);

    let { tws, twd, curSpeed, curDir, waveHeight, waveDir } = FALLBACK;

    if (wRes.status === 'fulfilled' && wRes.value.ok) {
      const wJson = await wRes.value.json();
      if (wJson.hourly && wJson.hourly.time) {
        const nowIso = targetDate.toISOString().slice(0, 13) + ':00';
        let idx = wJson.hourly.time.indexOf(nowIso);
        if (idx === -1) idx = 0;
        tws = wJson.hourly.wind_speed_10m[idx] ?? FALLBACK.tws;
        twd = wJson.hourly.wind_direction_10m[idx] ?? FALLBACK.twd;
        lastCoverage.wind = { start: wJson.hourly.time[0], end: wJson.hourly.time[wJson.hourly.time.length - 1] };
      }
    }

    if (mRes.status === 'fulfilled' && mRes.value.ok) {
      const mJson = await mRes.value.json();
      if (mJson.hourly && mJson.hourly.time) {
        const nowIso = targetDate.toISOString().slice(0, 13) + ':00';
        let idx = mJson.hourly.time.indexOf(nowIso);
        if (idx === -1) idx = 0;

        const ms = mJson.hourly.ocean_current_velocity?.[idx];
        if (ms !== null && ms !== undefined) {
          curSpeed = +(ms * 1.94384).toFixed(1);
          curDir = mJson.hourly.ocean_current_direction?.[idx] ?? FALLBACK.curDir;
        }

        const wh = mJson.hourly.wave_height?.[idx];
        if (wh !== null && wh !== undefined) {
          waveHeight = wh;
          waveDir = mJson.hourly.wave_direction?.[idx] ?? FALLBACK.waveDir;
        }
        lastCoverage.marine = { start: mJson.hourly.time[0], end: mJson.hourly.time[mJson.hourly.time.length - 1] };
      }
    }

    lastCoverage.fetchedAt = new Date();

    // Prefer BSH's own real current-vector GRIB data (js/bshGribCurrent.js)
    // over Open-Meteo's coarse global current model whenever it's already
    // cached and covers this point/time: it's real modeled U/V, not a
    // magnitude-only heuristic nudge, so it replaces both the Open-Meteo
    // current AND the tidal-amplification heuristic below rather than
    // stacking with either. Synchronous cache peek only (see
    // js/tidal.js's peekTidePhase for the identical hot-path-safe
    // pattern) — never blocks this call on a live GRIB fetch/parse; if
    // nothing is cached yet, this also fires a non-blocking warm-up so a
    // *later* call can benefit.
    const bshCurrent = peekBshCurrent(lat, lng, targetDate);
    lastCoverage.bshGribActive = !!bshCurrent;
    if (!bshCurrent) warmBshGribCache();

    // German Bight/Wadden Sea tidal-stream amplification heuristic — see
    // js/tidal.js for why this exists and what it deliberately does not do
    // (it never touches direction, only magnitude, and only inside the
    // region it's calibrated for). Skipped entirely when real BSH vector
    // data is already in use above.
    const tidalAmplifiedCurSpeed = bshCurrent ? bshCurrent.curSpeed : applyTidalAmplification(lat, lng, curSpeed, targetDate);

    const res = {
      tws: +tws.toFixed(1),
      twd: Math.round(twd),
      curSpeed: +tidalAmplifiedCurSpeed.toFixed(1),
      curDir: Math.round(bshCurrent ? bshCurrent.curDir : curDir),
      waveHeight: +waveHeight.toFixed(1),
      waveDir: Math.round(waveDir)
    };
    metoceanCache.set(key, res);
    return res;
  } catch (err) {
    metoceanCache.set(key, FALLBACK);
    return FALLBACK;
  }
}
