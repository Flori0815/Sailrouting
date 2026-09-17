import { state } from './state.js';
import { fetchMetoceanData } from './metocean.js';

// Windy-style animated flow field: a coarse grid of live wind/current/wave
// samples is bilinearly interpolated so a moderate number of particles can
// be advected smoothly across the visible map, redrawn every animation
// frame as fading streaks on a transparent canvas layered over the map.
const GRID_COLS = 6;
const GRID_ROWS = 5;
const REFRESH_DEBOUNCE_MS = 700;
const WIND_PARTICLE_COUNT = 220;
const CURRENT_PARTICLE_COUNT = 140;
const WAVE_PARTICLE_COUNT = 120;
// Kept visually distinct from the route polyline's emerald green and from
// each other so all three fields stay legible against the dark chart.
const WIND_COLOR = '56,189,248'; // sky-400
const CURRENT_COLOR = '45,212,191'; // teal-400
const WAVE_COLOR = '167,139,250'; // violet-400 — matches the wave-sensitivity UI elsewhere
const TRAIL_FADE_ALPHA = 0.05;
const MIN_PX_PER_FRAME = 0.6;
const MAX_PX_PER_FRAME = 5.5;
// Wave height (metres) doesn't map to a flow speed the way wind/current
// speeds do, so it gets its own, more generous scale factor — otherwise
// typical 0.5-2m seas would all clamp to the same near-minimum speed and
// the wave particles would look almost static next to wind and current.
const WAVE_SPEED_SCALE = 1.4;
const FLOW_SPEED_SCALE = 0.35;

// Windy-style colour-filled background: each enabled parameter is mapped
// through a fixed (not auto-scaled) domain so the legend stays meaningful
// as you pan — a given color always means the same wind speed, wherever
// you look. Rendered at coarse grid resolution into a tiny offscreen
// canvas, then drawn scaled-up onto the visible canvas each frame; the
// browser's own image smoothing does the bilinear interpolation for free,
// which is cheap and gives the same soft continuous look Windy has instead
// of a blocky per-cell fill.
const COLOR_DOMAINS = {
  wind: { max: 35, unit: 'kn', label: 'Wind' },
  current: { max: 4, unit: 'kn', label: 'Strömung' },
  wave: { max: 4, unit: 'm', label: 'Welle' }
};
// Blue (calm) -> cyan -> green -> yellow -> orange -> red (strong), the
// same family of stops used by Windy/earth.nullschool-style overlays.
const COLOR_STOPS = [
  [0.00, 30, 60, 114],
  [0.20, 34, 139, 180],
  [0.40, 46, 184, 138],
  [0.60, 190, 210, 60],
  [0.80, 235, 150, 40],
  [1.00, 214, 40, 40]
];

function colorRamp(value, max) {
  const t = Math.max(0, Math.min(1, value / max));
  let lo = COLOR_STOPS[0], hi = COLOR_STOPS[COLOR_STOPS.length - 1];
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    if (t >= COLOR_STOPS[i][0] && t <= COLOR_STOPS[i + 1][0]) {
      lo = COLOR_STOPS[i]; hi = COLOR_STOPS[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0];
  const f = span > 0 ? (t - lo[0]) / span : 0;
  return [
    Math.round(lo[1] + f * (hi[1] - lo[1])),
    Math.round(lo[2] + f * (hi[2] - lo[2])),
    Math.round(lo[3] + f * (hi[3] - lo[3]))
  ];
}

export function colorScaleCss(param) {
  const domain = COLOR_DOMAINS[param];
  const stops = COLOR_STOPS.map(([t, r, g, b]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(0)}%`);
  return { css: `linear-gradient(90deg, ${stops.join(', ')})`, max: domain.max, unit: domain.unit, label: domain.label };
}

let canvas = null;
let ctx = null;
let colorCanvas = null;
let colorCtx = null;
let colorGridCanvas = null;
let colorGridCtx = null;
let cssWidth = 0;
let cssHeight = 0;
let animationHandle = null;
let field = null;
let particles = [];
let refreshDebounceTimer = null;
let fieldRequestToken = 0;
let fieldTimeOverride = null;

// Matches the app's existing "rotate(dirDeg)" visual convention (a
// south-pointing glyph rotated clockwise by the from-bearing) so animated
// particles flow the same direction the static HUD/leg arrows point.
function bearingToUnitVector(dirDeg) {
  const rad = ((180 + dirDeg) % 360) * Math.PI / 180;
  return { dx: Math.sin(rad), dy: Math.cos(rad) }; // dx: +east, dy: +north
}

// Lets other modules (the voyage playback scrubber, applying a route) drive
// which point in time the animated field represents, instead of it always
// showing live "now" conditions regardless of a simulated voyage clock.
export function setFieldTime(date) {
  fieldTimeOverride = date instanceof Date ? date : new Date(date);
  if (isAnyLayerActive()) scheduleFieldRefresh();
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

  const sampleTime = fieldTimeOverride || new Date();
  const samples = await Promise.all(points.map(([lat, lng]) => fetchMetoceanData(lat, lng, sampleTime)));
  if (token !== fieldRequestToken) return; // a newer refresh superseded this one

  const n = points.length;
  const windU = new Float32Array(n), windV = new Float32Array(n), windSpeed = new Float32Array(n);
  const curU = new Float32Array(n), curV = new Float32Array(n), curSpeed = new Float32Array(n);
  const waveU = new Float32Array(n), waveV = new Float32Array(n), waveHeight = new Float32Array(n);

  samples.forEach((met, i) => {
    const w = bearingToUnitVector(met.twd);
    windU[i] = w.dx; windV[i] = w.dy; windSpeed[i] = met.tws;
    const c = bearingToUnitVector(met.curDir);
    curU[i] = c.dx; curV[i] = c.dy; curSpeed[i] = met.curSpeed;
    const wv = bearingToUnitVector(met.waveDir);
    waveU[i] = wv.dx; waveV[i] = wv.dy; waveHeight[i] = met.waveHeight;
  });

  field = {
    bounds: { north, south, east, west },
    cols: GRID_COLS,
    rows: GRID_ROWS,
    windU, windV, windSpeed,
    curU, curV, curSpeed,
    waveU, waveV, waveHeight
  };

  rebuildColorGrid();
}

// Paints the coarse sample grid into a tiny offscreen canvas, one pixel per
// grid cell — the visible canvas then draws this scaled way up each frame
// (see stepAndDraw), letting the browser's own bilinear image scaling do
// the smoothing instead of computing it by hand every frame.
function rebuildColorGrid() {
  if (!field || !colorGridCtx) return;
  const { cols, rows, windSpeed, curSpeed, waveHeight } = field;
  const sField = state.colorFieldParam === 'wind' ? windSpeed : state.colorFieldParam === 'current' ? curSpeed : waveHeight;
  const domain = COLOR_DOMAINS[state.colorFieldParam];

  const img = colorGridCtx.createImageData(cols, rows);
  // field rows run south (0) -> north (rows-1), but image rows run top (0)
  // -> bottom, and north is up on screen — flip vertically when writing.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const srcIdx = row * cols + col;
      const dstIdx = (rows - 1 - row) * cols + col;
      const [r, g, b] = colorRamp(sField[srcIdx], domain.max);
      img.data[dstIdx * 4] = r;
      img.data[dstIdx * 4 + 1] = g;
      img.data[dstIdx * 4 + 2] = b;
      img.data[dstIdx * 4 + 3] = 150;
    }
  }
  colorGridCtx.putImageData(img, 0, 0);
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
  const uField = kind === 'wind' ? field.windU : kind === 'current' ? field.curU : field.waveU;
  const vField = kind === 'wind' ? field.windV : kind === 'current' ? field.curV : field.waveV;
  const sField = kind === 'wind' ? field.windSpeed : kind === 'current' ? field.curSpeed : field.waveHeight;

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
  const dpr = window.devicePixelRatio || 1;
  cssWidth = size.x;
  cssHeight = size.y;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  // Render at native pixel density — without this the canvas is upscaled by
  // the browser on high-DPI screens, which is what made the particle
  // streaks look soft/washed-out against the map underneath.
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  colorCanvas.style.width = `${cssWidth}px`;
  colorCanvas.style.height = `${cssHeight}px`;
  colorCanvas.width = cssWidth * dpr;
  colorCanvas.height = cssHeight * dpr;
  colorCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Draws the coarse color grid, scaled up to cover its sampled lat/lng
// bounds projected to current screen coordinates — recomputed every frame
// (cheap: one drawImage call) so it tracks pan/zoom exactly like the
// particles do, without waiting for a 'moveend' data refresh.
function drawColorField() {
  colorCtx.clearRect(0, 0, cssWidth, cssHeight);
  if (!state.isColorFieldVisible || !field) return;

  const { bounds } = field;
  const topLeft = state.map.latLngToContainerPoint([bounds.north, bounds.west]);
  const bottomRight = state.map.latLngToContainerPoint([bounds.south, bounds.east]);

  colorCtx.imageSmoothingEnabled = true;
  colorCtx.drawImage(
    colorGridCanvas,
    topLeft.x, topLeft.y,
    bottomRight.x - topLeft.x, bottomRight.y - topLeft.y
  );
}

function stepAndDraw() {
  if (!ctx || !state.map || !field) {
    animationHandle = requestAnimationFrame(stepAndDraw);
    return;
  }

  drawColorField();

  // Fade previous strokes by reducing the canvas's own alpha (does not tint
  // the map underneath), leaving short motion trails behind each particle.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0,0,0,${TRAIL_FADE_ALPHA})`;
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';

  for (const p of particles) {
    if (!state.animLayers[p.kind]) continue;
    if (!p.initialized) respawnParticle(p);
    if (!field) break;

    const sample = sampleField(p.lat, p.lng, p.kind);
    if (!sample || sample.speed <= 0.05) {
      respawnParticle(p);
      continue;
    }

    const before = state.map.latLngToContainerPoint([p.lat, p.lng]);
    if (before.x < -20 || before.x > cssWidth + 20 || before.y < -20 || before.y > cssHeight + 20) {
      respawnParticle(p);
      continue;
    }

    const speedScale = p.kind === 'wave' ? WAVE_SPEED_SCALE : FLOW_SPEED_SCALE;
    const pxPerFrame = Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, sample.speed * speedScale));
    const afterX = before.x + sample.dx * pxPerFrame;
    const afterY = before.y - sample.dy * pxPerFrame; // canvas y grows downward, north is up
    const afterLatLng = state.map.containerPointToLatLng([afterX, afterY]);

    const color = p.kind === 'wind' ? WIND_COLOR : p.kind === 'current' ? CURRENT_COLOR : WAVE_COLOR;
    const coreWidth = p.kind === 'wind' ? 2.0 : p.kind === 'current' ? 1.7 : 1.5;

    // Cheap glow: a wide, faint halo stroke under a thin, bright core —
    // reads as a soft neon streak without the cost of real shadow blur at
    // this particle count.
    ctx.strokeStyle = `rgba(${color}, 0.22)`;
    ctx.lineWidth = coreWidth * 2.6;
    ctx.beginPath();
    ctx.moveTo(before.x, before.y);
    ctx.lineTo(afterX, afterY);
    ctx.stroke();

    ctx.strokeStyle = `rgba(${color}, 0.95)`;
    ctx.lineWidth = coreWidth;
    ctx.beginPath();
    ctx.moveTo(before.x, before.y);
    ctx.lineTo(afterX, afterY);
    ctx.stroke();

    p.lat = afterLatLng.lat;
    p.lng = afterLatLng.lng;
  }

  animationHandle = requestAnimationFrame(stepAndDraw);
}

function isAnyLayerActive() {
  return state.isWeatherOverlayVisible || state.isColorFieldVisible;
}

// Starts/stops the shared render loop and shows/hides both canvases based
// on the combined state of the three particle toggles and the colour
// field toggle, so e.g. turning off every particle layer but leaving the
// colour field on keeps the loop running (and vice versa).
function syncActiveState() {
  const active = isAnyLayerActive();
  if (active) {
    canvas.style.display = 'block';
    colorCanvas.style.display = 'block';
    if (!animationHandle) {
      resizeCanvas();
      particles.forEach(p => { p.initialized = false; });
      rebuildField();
      animationHandle = requestAnimationFrame(stepAndDraw);
    }
  } else {
    canvas.style.display = 'none';
    colorCanvas.style.display = 'none';
    if (animationHandle) {
      cancelAnimationFrame(animationHandle);
      animationHandle = null;
    }
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (colorCtx) colorCtx.clearRect(0, 0, colorCanvas.width, colorCanvas.height);
  }
}

export function initParticleField() {
  // Colour field sits below the particle canvas (lower z-index) so
  // particle streaks stay legible drawn on top of it.
  colorCanvas = document.createElement('canvas');
  colorCanvas.className = 'weather-color-canvas';
  colorCanvas.style.cssText = 'position:absolute; top:0; left:0; pointer-events:none; z-index:440; display:none;';
  state.map.getContainer().appendChild(colorCanvas);
  colorCtx = colorCanvas.getContext('2d');

  canvas = document.createElement('canvas');
  canvas.className = 'weather-particle-canvas';
  canvas.style.cssText = 'position:absolute; top:0; left:0; pointer-events:none; z-index:450; display:none;';
  state.map.getContainer().appendChild(canvas);
  ctx = canvas.getContext('2d');
  resizeCanvas();

  colorGridCanvas = document.createElement('canvas');
  colorGridCanvas.width = GRID_COLS;
  colorGridCanvas.height = GRID_ROWS;
  colorGridCtx = colorGridCanvas.getContext('2d');

  particles = [
    ...Array.from({ length: WIND_PARTICLE_COUNT }, () => makeParticle('wind')),
    ...Array.from({ length: CURRENT_PARTICLE_COUNT }, () => makeParticle('current')),
    ...Array.from({ length: WAVE_PARTICLE_COUNT }, () => makeParticle('wave'))
  ];

  state.map.on('moveend', () => {
    if (isAnyLayerActive()) scheduleFieldRefresh();
  });
  window.addEventListener('resize', () => {
    if (isAnyLayerActive()) resizeCanvas();
  });
}

// Sets one particle layer's (wind/current/wave) visibility independently
// of the other two. Returns the new value.
export function setLayerVisible(kind, visible) {
  state.animLayers[kind] = visible;
  syncActiveState();
  return visible;
}

export function isLayerVisible(kind) {
  return state.animLayers[kind];
}

export function setColorFieldVisible(visible) {
  state.isColorFieldVisible = visible;
  syncActiveState();
  return visible;
}

export function setColorFieldParam(param) {
  state.colorFieldParam = param;
  rebuildColorGrid();
}
