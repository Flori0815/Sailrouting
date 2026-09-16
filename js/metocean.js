// Live wind and current data from Open-Meteo's free, no-key-required public APIs.
// Called directly from the browser — no backend involved.

const FALLBACK = { tws: 14.0, twd: 240, curSpeed: 0.8, curDir: 120 };
const FETCH_TIMEOUT_MS = 8000;

const metoceanCache = new Map();

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
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latFmt}&longitude=${lngFmt}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=3`;
    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${latFmt}&longitude=${lngFmt}&hourly=ocean_current_velocity,ocean_current_direction&forecast_days=3`;

    const [wRes, mRes] = await Promise.allSettled([
      fetchWithTimeout(weatherUrl, FETCH_TIMEOUT_MS),
      fetchWithTimeout(marineUrl, FETCH_TIMEOUT_MS)
    ]);

    let { tws, twd, curSpeed, curDir } = FALLBACK;

    if (wRes.status === 'fulfilled' && wRes.value.ok) {
      const wJson = await wRes.value.json();
      if (wJson.hourly && wJson.hourly.time) {
        const nowIso = targetDate.toISOString().slice(0, 13) + ':00';
        let idx = wJson.hourly.time.indexOf(nowIso);
        if (idx === -1) idx = 0;
        tws = wJson.hourly.wind_speed_10m[idx] ?? FALLBACK.tws;
        twd = wJson.hourly.wind_direction_10m[idx] ?? FALLBACK.twd;
      }
    }

    if (mRes.status === 'fulfilled' && mRes.value.ok) {
      const mJson = await mRes.value.json();
      if (mJson.hourly && mJson.hourly.ocean_current_velocity) {
        const nowIso = targetDate.toISOString().slice(0, 13) + ':00';
        let idx = mJson.hourly.time.indexOf(nowIso);
        if (idx === -1) idx = 0;
        const ms = mJson.hourly.ocean_current_velocity[idx];
        if (ms !== null && ms !== undefined) {
          curSpeed = +(ms * 1.94384).toFixed(1);
          curDir = mJson.hourly.ocean_current_direction[idx] ?? FALLBACK.curDir;
        }
      }
    }

    const res = { tws: +tws.toFixed(1), twd: Math.round(twd), curSpeed: +curSpeed.toFixed(1), curDir: Math.round(curDir) };
    metoceanCache.set(key, res);
    return res;
  } catch (err) {
    metoceanCache.set(key, FALLBACK);
    return FALLBACK;
  }
}
