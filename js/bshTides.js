// Client for BSH's official Water Level Forecast API — a documented OGC API
// Features (ldproxy) service, CC BY 4.0, no auth, plain JSON over CORS-
// friendly GET requests. Confirmed against a real, working open-source
// client (github.com/EnlightningMan/ha-bsh_tides) rather than guessed, since
// this project's dev sandbox can't reach gdi.bsh.de directly to verify the
// response shape itself.
//
// This gives REAL high/low-water timing for German coastal (and Baltic)
// gauge stations — genuinely authoritative, unlike js/tidal.js's
// astronomical M2 approximation. It does not give current vectors directly
// (that's water level, not current), but real local HW/NW timing anchors
// the same flood/ebb/slack sinusoidal shape tidal.js already uses far more
// accurately than a generic lunar-epoch phase can. Used as an optional
// enhancement: every call here is wrapped in a timeout + try/catch by the
// caller (js/tidal.js), falling back to the astronomical estimate on any
// failure (unreachable, CORS, unexpected shape) — the same defensive
// pattern js/metocean.js already uses for Open-Meteo.

const API_BASE = 'https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast/collections/waterlevelforecastdata/items';
const FETCH_TIMEOUT_MS = 6000;
const STATION_LIST_TTL_MS = 6 * 3600 * 1000;
const FORECAST_TTL_MS = 30 * 60 * 1000;
// A real route computation can call applyTidalAmplification dozens of times
// per leg, and each uncached call fires a background warm-up attempt (see
// tidal.js). Without a short cooldown on FAILURES specifically, a station
// that's genuinely unreachable (or the whole API being down) would get
// re-hit on nearly every one of those calls instead of just once.
const FAILURE_BACKOFF_MS = 3 * 60 * 1000;

let stationListCache = null; // { fetchedAt, stations: [{slug, name, area, lat, lon}] }
let stationListFailedAt = null;
const forecastCache = new Map(); // slug -> { fetchedAt, data }
const forecastFailedAt = new Map(); // slug -> timestamp

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStationList() {
  if (stationListCache && Date.now() - stationListCache.fetchedAt < STATION_LIST_TTL_MS) {
    return stationListCache.stations;
  }
  if (stationListFailedAt && Date.now() - stationListFailedAt < FAILURE_BACKOFF_MS) {
    throw new Error('BSH station list recently failed, backing off');
  }

  try {
    const stations = [];
    let url = `${API_BASE}?f=json&limit=1000`;
    for (let page = 0; page < 20 && url; page++) {
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) break;
      const payload = await res.json();
      const features = Array.isArray(payload.features) ? payload.features : [];

      for (const feat of features) {
        const props = feat.properties || {};
        const slug = feat.id;
        const name = props.gauge_label;
        const area = props.area;
        if (!slug || !name) continue;
        // GeoJSON Point coordinates are [lon, lat]. Defensive: the upstream
        // OGC API Features spec guarantees a geometry field, but this app's
        // dev sandbox can't hit the live API to confirm it — nearest-station
        // selection below falls back gracefully if this is ever absent.
        const coords = feat.geometry && Array.isArray(feat.geometry.coordinates) ? feat.geometry.coordinates : null;
        stations.push({
          slug, name, area,
          lon: coords ? coords[0] : null,
          lat: coords ? coords[1] : null
        });
      }

      url = null;
      for (const link of payload.links || []) {
        if (link.rel === 'next' && link.href) { url = link.href; break; }
      }
    }

    if (stations.length === 0) throw new Error('BSH station list empty or unreachable');
    stationListCache = { fetchedAt: Date.now(), stations };
    stationListFailedAt = null;
    return stations;
  } catch (err) {
    stationListFailedAt = Date.now();
    throw err;
  }
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // nm
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Picks the closest station with usable coordinates; if none of the
// fetched stations carry geometry (see the defensive note above), falls
// back to a well-known German Bight reference station by name so the
// integration degrades to "a real station, just not the nearest one"
// rather than failing outright.
function pickStation(lat, lon, stations) {
  const withCoords = stations.filter(s => s.lat !== null && s.lon !== null);
  if (withCoords.length > 0) {
    return withCoords.reduce((best, s) => {
      const d = haversineNm(lat, lon, s.lat, s.lon);
      return !best || d < best.dist ? { station: s, dist: d } : best;
    }, null).station;
  }
  return stations.find(s => /cuxhaven/i.test(s.name)) || stations[0] || null;
}

// Parses the two forecast shapes the API can return for a station (see
// bsh_api.py's feature_to_legacy for the reference implementation this
// mirrors) into a flat list of {timestamp: Date, event: 'HW'|'NW', value}.
// Only the explicit peak-forecast shape is used — stations that only offer
// the 10-minute curve (no explicit HW/NW list) are treated as unsupported
// here and the caller falls back to the astronomical estimate, rather than
// re-implementing the curve's extrema-finding for a secondary data path.
function parseHwNwEvents(props) {
  const hwnw = props.high_water_low_water;
  if (!Array.isArray(hwnw) || hwnw.length === 0) return null;

  const events = hwnw
    .map(ev => ({
      timestamp: new Date(ev.event_timestamp),
      event: ev.event,
      value: Number(ev.forecast_value ?? ev.tidal_prediction_value)
    }))
    .filter(ev => !isNaN(ev.timestamp.getTime()) && (ev.event === 'HW' || ev.event === 'NW') && !isNaN(ev.value))
    .sort((a, b) => a.timestamp - b.timestamp);

  return events.length >= 2 ? events : null;
}

async function fetchStationForecast(slug) {
  const cached = forecastCache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < FORECAST_TTL_MS) return cached.data;
  const failedAt = forecastFailedAt.get(slug);
  if (failedAt && Date.now() - failedAt < FAILURE_BACKOFF_MS) {
    throw new Error(`BSH forecast for ${slug} recently failed, backing off`);
  }

  try {
    const res = await fetchWithTimeout(`${API_BASE}/${slug}?f=json`, FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`BSH station forecast HTTP ${res.status}`);
    const feature = await res.json();
    if (!feature || feature.type !== 'Feature' || !feature.properties) {
      throw new Error('Unexpected BSH station forecast shape');
    }

    const props = feature.properties;
    const data = {
      stationName: props.gauge_label,
      area: props.area,
      mhw: Number(props.mean_high_water),
      mnw: Number(props.mean_low_water),
      events: parseHwNwEvents(props)
    };
    forecastCache.set(slug, { fetchedAt: Date.now(), data });
    forecastFailedAt.delete(slug);
    return data;
  } catch (err) {
    forecastFailedAt.set(slug, Date.now());
    throw err;
  }
}

// Shared by the async fetcher and the sync cache-peek below so both
// compute the exact same thing from a station's forecast data.
function computePhaseFromForecast(forecast, date) {
  if (!forecast.events) return null;

  const events = forecast.events;
  let prev = null, next = null;
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].timestamp <= date && events[i + 1].timestamp >= date) {
      prev = events[i]; next = events[i + 1];
      break;
    }
  }
  if (!prev || !next) return null; // date outside the forecast window

  const span = next.timestamp - prev.timestamp;
  const phaseFraction = span > 0 ? (date - prev.timestamp) / span : 0;
  const strength = Math.abs(Math.sin(Math.PI * phaseFraction)); // 0 at each HW/NW, 1 at the mid-tide between them
  const isFlood = prev.event === 'NW'; // rising from low water toward high water

  // Real tidal-range-derived spring/neap factor: how big is *this* cycle's
  // range compared to the station's mean range, instead of a generic
  // lunar-cycle approximation.
  const meanRange = forecast.mhw - forecast.mnw;
  const thisRange = Math.abs(next.value - prev.value);
  const springNeapFactor = meanRange > 0 ? Math.max(0.35, Math.min(1.3, thisRange / meanRange)) : 1;

  let stateLabel = 'Stillstand';
  if (strength > 0.15) stateLabel = isFlood ? 'Flut (zunehmend)' : 'Ebbe (abnehmend)';

  return {
    strength,
    springNeapFactor,
    isFlood,
    stateLabel,
    springNeapLabel: springNeapFactor > 1.05 ? 'Springtide' : springNeapFactor < 0.8 ? 'Nipptide' : 'mittlere Tide',
    stationName: forecast.stationName,
    source: 'BSH Wasserstandsvorhersage (real)'
  };
}

// Real-data replacement for js/tidal.js's astronomical phase estimate.
// Returns null (caller falls back to the heuristic) whenever real data
// isn't usable for this place/time: no nearby station, the station only
// offers the curve forecast, or `date` falls outside the fetched forecast
// window (BSH's forecast horizon is a few days, not indefinite). Does real
// network I/O (cached, but the first call per station is a live round
// trip) — only call this from places where that latency is acceptable
// (a UI readout), never from the routing solver's hot path. See
// `peekTidePhase`/`warmTideCache` for the latency-safe alternative.
export async function getRealTidePhase(lat, lon, date = new Date()) {
  const stations = await fetchStationList();
  const station = pickStation(lat, lon, stations);
  if (!station) return null;

  const forecast = await fetchStationForecast(station.slug);
  return computePhaseFromForecast(forecast, date);
}

// Synchronous, network-free cache read: returns real tide-phase data only
// if it's already cached and fresh, or null otherwise — never triggers a
// fetch itself. This is what the routing solver's hot path uses, so a
// slow or unreachable BSH API can never add latency to route computation.
export function peekTidePhase(lat, lon, date = new Date()) {
  if (!stationListCache || Date.now() - stationListCache.fetchedAt >= STATION_LIST_TTL_MS) return null;
  const station = pickStation(lat, lon, stationListCache.stations);
  if (!station) return null;
  const cached = forecastCache.get(station.slug);
  if (!cached || Date.now() - cached.fetchedAt >= FORECAST_TTL_MS) return null;
  return computePhaseFromForecast(cached.data, date);
}

// Fire-and-forget cache warm-up: kicks off the real fetch chain (station
// list + forecast) if it isn't already in flight, so a *later* call to
// peekTidePhase can find it cached. Never throws, never needs awaiting.
let warmInFlight = false;
export function warmTideCache(lat, lon) {
  if (warmInFlight) return;
  warmInFlight = true;
  getRealTidePhase(lat, lon).catch(() => {}).finally(() => { warmInFlight = false; });
}
