import { state } from './state.js';
import { fetchMetoceanData } from './metocean.js';

// A modest grid keeps this to ~20 API calls per refresh (cached per
// lat/lng/hour in metocean.js), which stays polite towards the free
// Open-Meteo endpoints even on a live map that gets panned/zoomed a lot.
const GRID_COLS = 5;
const GRID_ROWS = 4;
const REFRESH_DEBOUNCE_MS = 700;

let refreshDebounceTimer = null;
let refreshToken = 0;

function computeGridPoints(map) {
  const bounds = map.getBounds();
  const north = bounds.getNorth();
  const south = bounds.getSouth();
  const east = bounds.getEast();
  const west = bounds.getWest();

  const points = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const lat = south + ((r + 0.5) / GRID_ROWS) * (north - south);
      const lng = west + ((c + 0.5) / GRID_COLS) * (east - west);
      points.push([lat, lng]);
    }
  }
  return points;
}

function buildOverlayIcon(met) {
  return L.divIcon({
    className: 'weather-overlay-marker',
    html: `<div class="flex flex-col gap-0.5 bg-marine-950/80 border border-slate-700/60 rounded-md px-1 py-0.5 shadow">
            <div class="flex items-center gap-1 leading-none">
              <span style="display:inline-block; transform: rotate(${met.twd}deg);" class="text-sky-400 text-xs">↓</span>
              <span class="text-[8px] font-mono text-sky-300">${met.tws}k</span>
            </div>
            <div class="flex items-center gap-1 leading-none">
              <span style="display:inline-block; transform: rotate(${met.curDir}deg);" class="text-emerald-400 text-xs">↓</span>
              <span class="text-[8px] font-mono text-emerald-300">${met.curSpeed}k</span>
            </div>
           </div>`,
    iconSize: [46, 34],
    iconAnchor: [23, 17]
  });
}

async function renderOverlay() {
  if (!state.isWeatherOverlayVisible || !state.map) return;

  // Guard against a slower, earlier refresh overwriting a newer one once
  // the map has since moved again.
  const token = ++refreshToken;
  const points = computeGridPoints(state.map);
  const now = new Date();

  const metocean = await Promise.all(points.map(([lat, lng]) => fetchMetoceanData(lat, lng, now)));

  if (token !== refreshToken || !state.isWeatherOverlayVisible) return;

  state.weatherOverlayLayer.clearLayers();
  points.forEach(([lat, lng], i) => {
    L.marker([lat, lng], { icon: buildOverlayIcon(metocean[i]), interactive: false }).addTo(state.weatherOverlayLayer);
  });
}

function scheduleRefresh() {
  clearTimeout(refreshDebounceTimer);
  refreshDebounceTimer = setTimeout(renderOverlay, REFRESH_DEBOUNCE_MS);
}

export function initWeatherOverlay() {
  state.weatherOverlayLayer = L.layerGroup();
  state.map.on('moveend', () => {
    if (state.isWeatherOverlayVisible) scheduleRefresh();
  });
}

export function toggleWeatherOverlay() {
  state.isWeatherOverlayVisible = !state.isWeatherOverlayVisible;

  if (state.isWeatherOverlayVisible) {
    state.weatherOverlayLayer.addTo(state.map);
    renderOverlay();
  } else {
    state.map.removeLayer(state.weatherOverlayLayer);
  }

  return state.isWeatherOverlayVisible;
}
