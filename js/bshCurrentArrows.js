// Draws real BSH GRIB current data directly on the map as a vector grid
// — a directional arrow plus its speed at each actual grid node, colored
// by speed — the same way BSH's own reference tooling shows tidal
// current data, rather than the smoothed animated-particle approximation
// js/particleField.js draws for the (non-authoritative) Open-Meteo-based
// current everywhere else. This activates automatically once any BSH
// GRIB region is loaded (js/bshGribCurrent.js) and the layer is switched
// on; it draws whichever loaded region(s) — macro or micro — actually
// cover the visible map area, so panning from open water into a fine
// river/estuary grid changes what's drawn without any extra wiring here.
//
// Deliberately simpler than the reference tool it's modeled on in one
// respect: no separate fairway/channel-centerline overlay, since that's
// a different kind of geodata (navigational channel geometry) this
// project has no source for — this only draws the current vectors
// themselves, which is the actual data this feature is about.
import { state } from './state.js';
import { getArrowGridSamples } from './bshGribCurrent.js';

const REFRESH_DEBOUNCE_MS = 400;
const POLL_MS = 4000; // catches a background GRIB region finishing load without needing an event bus
const MAX_POINTS_PER_REGION = 350;
const SPEED_DOMAIN_MAX_KN = 3.5; // matches the reference tool's own legend scale
const LABEL_MIN_ZOOM = 11; // below this, per-arrow speed labels would just be clutter

// Same blue -> cyan -> green -> yellow -> red family used by
// particleField.js's colour field, kept as an independent small copy
// here rather than importing its internals (this module's arrows are a
// fundamentally different rendering: real vectors at real grid nodes,
// not a smoothed smoothed/animated approximation).
const COLOR_STOPS = [
  [0.00, 5, 60, 122],
  [0.25, 0, 153, 255],
  [0.50, 0, 229, 163],
  [0.75, 250, 204, 21],
  [1.00, 239, 68, 68]
];

function colorForSpeed(kn) {
  const t = Math.max(0, Math.min(1, kn / SPEED_DOMAIN_MAX_KN));
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [t0, r0, g0, b0] = COLOR_STOPS[i];
    const [t1, r1, g1, b1] = COLOR_STOPS[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return `rgb(${Math.round(r0 + (r1 - r0) * f)},${Math.round(g0 + (g1 - g0) * f)},${Math.round(b0 + (b1 - b0) * f)})`;
    }
  }
  const [, r, g, b] = COLOR_STOPS[COLOR_STOPS.length - 1];
  return `rgb(${r},${g},${b})`;
}

let canvas = null, ctx = null;
let cssWidth = 0, cssHeight = 0;
let visible = false;
let refreshTimer = null;
let pollHandle = null;
let fieldTimeOverride = null;
let samples = [];

function resizeCanvas() {
  if (!canvas || !state.map) return;
  const size = state.map.getSize();
  const dpr = window.devicePixelRatio || 1;
  cssWidth = size.x;
  cssHeight = size.y;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function refreshSamples() {
  if (!state.map) return;
  const b = state.map.getBounds();
  samples = getArrowGridSamples(
    { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() },
    fieldTimeOverride || new Date(),
    MAX_POINTS_PER_REGION
  );
  draw();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshSamples, REFRESH_DEBOUNCE_MS);
}

function draw() {
  if (!ctx) return;
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  if (!visible || !state.map) return;

  const zoom = state.map.getZoom();
  const showLabels = zoom >= LABEL_MIN_ZOOM;
  ctx.lineCap = 'round';
  ctx.font = '10px monospace';

  for (const s of samples) {
    const pt = state.map.latLngToContainerPoint([s.lat, s.lon]);
    if (pt.x < -10 || pt.x > cssWidth + 10 || pt.y < -10 || pt.y > cssHeight + 10) continue;
    if (s.curSpeed < 0.05) continue; // near-still: a dot would just be visual noise

    const color = colorForSpeed(s.curSpeed);
    const len = 7 + Math.min(16, s.curSpeed * 7);
    // curDir is a true compass bearing (0=N, clockwise) the current
    // flows TOWARD; canvas x grows east (matches sin), y grows south
    // (north is up, so the y term is negated).
    const rad = s.curDir * Math.PI / 180;
    const dx = Math.sin(rad), dy = Math.cos(rad);
    const tipX = pt.x + dx * len, tipY = pt.y - dy * len;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // Small arrowhead: two short strokes back from the tip.
    const headLen = 4.5;
    const headAngle = 0.5; // radians
    for (const sign of [-1, 1]) {
      const a = rad + Math.PI + sign * headAngle;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.sin(a) * headLen, tipY - Math.cos(a) * headLen);
      ctx.stroke();
    }

    if (showLabels) {
      ctx.fillStyle = 'rgba(226,232,240,0.95)';
      ctx.fillText(s.curSpeed.toFixed(1), tipX + 3, tipY + 3);
    }
  }
}

export function initBshCurrentArrows() {
  canvas = document.createElement('canvas');
  canvas.className = 'bsh-current-arrows-canvas';
  canvas.style.cssText = 'position:absolute; top:0; left:0; pointer-events:none; z-index:445; display:none;';
  state.map.getContainer().appendChild(canvas);
  ctx = canvas.getContext('2d');
  resizeCanvas();

  state.map.on('moveend', () => {
    if (visible) { resizeCanvas(); scheduleRefresh(); }
  });
  window.addEventListener('resize', () => {
    if (visible) resizeCanvas();
  });
}

export function setBshCurrentArrowsVisible(v) {
  visible = v;
  if (canvas) canvas.style.display = v ? 'block' : 'none';
  if (v) {
    resizeCanvas();
    refreshSamples();
    if (!pollHandle) pollHandle = setInterval(() => { if (visible) refreshSamples(); }, POLL_MS);
  } else if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  return v;
}

export function isBshCurrentArrowsVisible() {
  return visible;
}

// Forces an immediate redraw with fresh samples — used right after an
// explicit "load now" action so the arrows don't wait for the next poll
// tick or map move to reflect newly-loaded data.
export function refreshBshCurrentArrowsNow() {
  if (visible) refreshSamples();
}

// Lets the voyage playback scrubber drive which point in time the arrows
// represent, mirroring js/particleField.js#setFieldTime.
export function setBshCurrentArrowsTime(date) {
  fieldTimeOverride = date instanceof Date ? date : new Date(date);
  if (visible) scheduleRefresh();
}
