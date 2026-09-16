import { state } from './state.js';
import { fetchMetoceanData } from './metocean.js';

// Windy-style animated flow field: a coarse grid of live wind/current
// samples is bilinearly interpolated so a moderate number of particles can
// be advected smoothly across the visible map, redrawn every animation
// frame as fading streaks on a transparent canvas layered over the map.
const GRID_COLS = 6;
const GRID_ROWS = 5;
const REFRESH_DEBOUNCE_MS = 700;
const WIND_PARTICLE_COUNT = 220;
const CURRENT_PARTICLE_COUNT = 140;
const WIND_COLOR = '125,211,252'; // sky-300
const CURRENT_COLOR = '52,211,153'; // emerald-400
const TRAIL_FADE_ALPHA = 0.06;
const MIN_PX_PER_FRAME = 0.6;
const MAX_PX_PER_FRAME = 5.5;

let canvas = null;
let ctx = null;
let animationHandle = null;
let field = null;
let particles = [];
let refreshDebounceTimer = null;
let fieldRequestToken = 0;

// Matches the app's existing "rotate(dirDeg)" visual convention (a
// south-pointing glyph rotated clockwise by the from-bearing) so animated
// particles flow the same direction the static HUD/leg arrows point.
function bearingToUnitVector(dirDeg) {
  const rad = ((180 + dirDeg) % 360) * Math.PI / 180;
  return { dx: Math.sin(rad), dy: Math.cos(rad) }; // dx: +east, dy: +north
}

async function rebuildField() {
  if (!state.map) return;
  const token = ++fieldRequestToken;
  const bounds = state.map.getBounds();
  const north = bounds.getNorth(), south = bounds.getSouth();
  const east = bounds.getEast(), west = bounds.getWest();

  const points = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const lat = south + (r / (GRID_ROWS - 1)) * (north - south);
    for (let c = 0; c < GRID_COLS; c++) {
      const lng = west + (c / (GRID_COLS - 1)) * (east - west);
      points.push([lat, lng]);
    }
  }

  const now = new Date();
  const samples = await Promise.all(points.map(([lat, lng]) => fetchMetoceanData(lat, lng, now)));
  if (token !== fieldRequestToken) return; // a newer refresh superseded this one

  const n = points.length;
  const windU = new Float32Array(n), windV = new Float32Array(n), windSpeed = new Float32Array(n);
  const curU = new Float32Array(n), curV = new Float32Array(n), curSpeed = new Float32Array(n);

  samples.forEach((met, i) => {
    const w = bearingToUnitVector(met.twd);
    windU[i] = w.dx; windV[i] = w.dy; windSpeed[i] = met.tws;
    const c = bearingToUnitVector(met.curDir);
    curU[i] = c.dx; curV[i] = c.dy; curSpeed[i] = met.curSpeed;
  });

  field = { bounds: { north, south, east, west }, cols: GRID_COLS, rows: GRID_ROWS, windU, windV, windSpeed, curU, curV, curSpeed };
}

function scheduleFieldRefresh() {
  clearTimeout(refreshDebounceTimer);
  refreshDebounceTimer = setTimeout(rebuildField, REFRESH_DEBOUNCE_MS);
}

function sampleField(lat, lng, kind) {
  if (!field) return null;
  const { bounds, cols, rows } = field;
  if (lat < bounds.south || lat > bounds.north || lng < bounds.west || lng > bounds.east) return null;

  const u = (lng - bounds.west) / (bounds.east - bounds.west);
  const v = (lat - bounds.south) / (bounds.north - bounds.south);
  const colF = u * (cols - 1);
  const rowF = v * (rows - 1);
  const c0 = Math.floor(colF), c1 = Math.min(c0 + 1, cols - 1), fc = colF - c0;
  const r0 = Math.floor(rowF), r1 = Math.min(r0 + 1, rows - 1), fr = rowF - r0;

  const idx = (r, c) => r * cols + c;
  const uField = kind === 'wind' ? field.windU : field.curU;
  const vField = kind === 'wind' ? field.windV : field.curV;
  const sField = kind === 'wind' ? field.windSpeed : field.curSpeed;

  const w00 = (1 - fc) * (1 - fr), w10 = fc * (1 - fr), w01 = (1 - fc) * fr, w11 = fc * fr;
  const i00 = idx(r0, c0), i10 = idx(r0, c1), i01 = idx(r1, c0), i11 = idx(r1, c1);

  return {
    dx: uField[i00] * w00 + uField[i10] * w10 + uField[i01] * w01 + uField[i11] * w11,
    dy: vField[i00] * w00 + vField[i10] * w10 + vField[i01] * w01 + vField[i11] * w11,
    speed: sField[i00] * w00 + sField[i10] * w10 + sField[i01] * w01 + sField[i11] * w11
  };
}

function makeParticle(kind) {
  return { kind, lat: 0, lng: 0, initialized: false };
}

function respawnParticle(p) {
  if (!field) return;
  const { bounds } = field;
  p.lat = bounds.south + Math.random() * (bounds.north - bounds.south);
  p.lng = bounds.west + Math.random() * (bounds.east - bounds.west);
  p.initialized = true;
}

function resizeCanvas() {
  if (!canvas || !state.map) return;
  const size = state.map.getSize();
  canvas.width = size.x;
  canvas.height = size.y;
}

function stepAndDraw() {
  if (!ctx || !state.map || !field) {
    animationHandle = requestAnimationFrame(stepAndDraw);
    return;
  }

  const w = canvas.width, h = canvas.height;

  // Fade previous strokes by reducing the canvas's own alpha (does not tint
  // the map underneath), leaving short motion trails behind each particle.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0,0,0,${TRAIL_FADE_ALPHA})`;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';

  for (const p of particles) {
    if (!p.initialized) respawnParticle(p);
    if (!field) break;

    const sample = sampleField(p.lat, p.lng, p.kind);
    if (!sample || sample.speed <= 0.05) {
      respawnParticle(p);
      continue;
    }

    const before = state.map.latLngToContainerPoint([p.lat, p.lng]);
    if (before.x < -20 || before.x > w + 20 || before.y < -20 || before.y > h + 20) {
      respawnParticle(p);
      continue;
    }

    const pxPerFrame = Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, sample.speed * 0.35));
    const afterX = before.x + sample.dx * pxPerFrame;
    const afterY = before.y - sample.dy * pxPerFrame; // canvas y grows downward, north is up
    const afterLatLng = state.map.containerPointToLatLng([afterX, afterY]);

    ctx.strokeStyle = `rgba(${p.kind === 'wind' ? WIND_COLOR : CURRENT_COLOR}, 0.85)`;
    ctx.lineWidth = p.kind === 'wind' ? 1.3 : 1.1;
    ctx.beginPath();
    ctx.moveTo(before.x, before.y);
    ctx.lineTo(afterX, afterY);
    ctx.stroke();

    p.lat = afterLatLng.lat;
    p.lng = afterLatLng.lng;
  }

  animationHandle = requestAnimationFrame(stepAndDraw);
}

export function initParticleField() {
  canvas = document.createElement('canvas');
  canvas.className = 'weather-particle-canvas';
  canvas.style.cssText = 'position:absolute; inset:0; pointer-events:none; z-index:450; display:none;';
  state.map.getContainer().appendChild(canvas);
  ctx = canvas.getContext('2d');
  resizeCanvas();

  particles = [
    ...Array.from({ length: WIND_PARTICLE_COUNT }, () => makeParticle('wind')),
    ...Array.from({ length: CURRENT_PARTICLE_COUNT }, () => makeParticle('current'))
  ];

  state.map.on('moveend', () => {
    if (state.isWeatherOverlayVisible) scheduleFieldRefresh();
  });
  window.addEventListener('resize', () => {
    if (state.isWeatherOverlayVisible) resizeCanvas();
  });
}

export function toggleWeatherOverlay() {
  state.isWeatherOverlayVisible = !state.isWeatherOverlayVisible;

  if (state.isWeatherOverlayVisible) {
    canvas.style.display = 'block';
    resizeCanvas();
    particles.forEach(p => { p.initialized = false; });
    rebuildField();
    if (!animationHandle) animationHandle = requestAnimationFrame(stepAndDraw);
  } else {
    canvas.style.display = 'none';
    if (animationHandle) {
      cancelAnimationFrame(animationHandle);
      animationHandle = null;
    }
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return state.isWeatherOverlayVisible;
}
