import { state } from './state.js';

// Real BSH current data as a map overlay — a standard, public OGC WMS (Web
// Map Service) tile layer, not scraped or reverse-engineered: WMS is a
// documented protocol explicitly meant for exactly this (letting
// third-party map clients like this app request rendered map tiles), and
// BSH exposes several of these anonymously for public use.
//
// The exact capabilities endpoint can't be verified from this project's
// dev sandbox (its network egress can't reach bsh.de/gdi.bsh.de to inspect
// a real response), so this tries several documented-looking candidate
// URLs in order — a first attempt (geoseaportal.de/wss/service/...)
// shipped and 404'd in the field; these are different URL patterns found
// via a second, more careful search, most notably the one BSH's own site
// links directly as a "GetCapabilities" URL for this exact service
// (gdi.bsh.de/en/mapservice/Tidal-Current-Data-WMS). Layer name and any
// dimensions are still discovered at runtime from whichever candidate's
// capabilities response actually parses, rather than hardcoding a guess.
// If none of them work, the toggle just reports that and leaves the rest
// of the app untouched — this is still a best-effort, field-unverified
// integration.
const CAPABILITIES_URL_CANDIDATES = [
  'https://gdi.bsh.de/en/mapservice/Tidal-Current-Data-WMS?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0',
  'https://gdi.bsh.de/mapservice_gs/Gezeitenstrom_Daten/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0',
  'https://www.geoseaportal.de/wss/service/Gezeitenstrom_Daten/guest?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0'
];
const FETCH_TIMEOUT_MS = 8000;

let capabilitiesPromise = null;
let wmsLeafletLayer = null;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function xlinkHref(el) {
  return el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || el.getAttribute('xlink:href') || el.getAttribute('href');
}

function parseCapabilities(capabilitiesUrl, text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('WMS capabilities XML did not parse');

  // Only Layer elements with their own direct <Name> are actually
  // requestable via GetMap — WMS uses nested <Layer> purely for grouping,
  // and those group layers have no <Name> child of their own.
  const layers = [];
  xml.querySelectorAll('Layer').forEach((layerEl) => {
    const nameEl = layerEl.querySelector(':scope > Name');
    if (!nameEl) return;
    const titleEl = layerEl.querySelector(':scope > Title');
    const dimensions = Array.from(layerEl.querySelectorAll(':scope > Dimension')).map((d) => ({
      name: d.getAttribute('name'),
      default: d.getAttribute('default'),
      values: d.textContent.trim()
    }));
    // A layer can offer multiple rendering styles (e.g. a plain dot/point
    // symbol vs. a direction-and-magnitude arrow/vector style) — exposed
    // so the UI can let a sailor pick one instead of being stuck with
    // whatever the server defaults to (its first/only style).
    const styles = Array.from(layerEl.querySelectorAll(':scope > Style')).map((s) => {
      const sName = s.querySelector(':scope > Name');
      const sTitle = s.querySelector(':scope > Title');
      return {
        name: sName ? sName.textContent.trim() : '',
        title: sTitle ? sTitle.textContent.trim() : (sName ? sName.textContent.trim() : 'Standard')
      };
    }).filter(s => s.name);
    layers.push({
      name: nameEl.textContent.trim(),
      title: titleEl ? titleEl.textContent.trim() : nameEl.textContent.trim(),
      dimensions,
      styles
    });
  });
  if (layers.length === 0) throw new Error('WMS capabilities listed no requestable layers');

  let getMapUrl = capabilitiesUrl.split('?')[0];
  const onlineResource = xml.querySelector('Capability > Request > GetMap DCPType HTTP Get OnlineResource');
  if (onlineResource) {
    const href = xlinkHref(onlineResource);
    if (href) getMapUrl = href;
  }

  const preferred = layers.find((l) => /gezeiten|tidal|strom|current/i.test(l.title) || /gezeiten|tidal|strom|current/i.test(l.name)) || layers[0];

  return { getMapUrl, layer: preferred, allLayers: layers };
}

async function discoverCapabilities() {
  const errors = [];
  for (const url of CAPABILITIES_URL_CANDIDATES) {
    try {
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) { errors.push(`${url} -> HTTP ${res.status}`); continue; }
      const text = await res.text();
      return parseCapabilities(url, text);
    } catch (err) {
      errors.push(`${url} -> ${err.message || err}`);
    }
  }
  throw new Error(`All WMS capabilities candidates failed: ${errors.join('; ')}`);
}

// Cached — a failed attempt is retried on the next call (not cached as a
// permanent failure), since a transient network hiccup shouldn't
// permanently disable the toggle for the rest of the session.
export function getWmsCapabilities() {
  if (!capabilitiesPromise) {
    capabilitiesPromise = discoverCapabilities().catch((err) => {
      capabilitiesPromise = null;
      throw err;
    });
  }
  return capabilitiesPromise;
}

export function isBshWmsLayerVisible() {
  return wmsLeafletLayer !== null;
}

// Which layer/style is currently (or was last) selected — lets the UI
// build a "change layer/style" control after the first successful
// discovery, defaulting to whatever was auto-picked.
let currentLayerName = null;
let currentStyleName = null;

// A tidal current field is inherently time-varying (it reverses with the
// tide), so a WMS layer for it almost always declares a "time" Dimension.
// A GetMap request that omits a *required* dimension isn't reliably an
// error — servers commonly fall back to some default/empty rendering
// instead (e.g. a bare station-location marker with no vector drawn),
// which would look exactly like the "just dots, values are missing"
// symptom reported regardless of which Style is picked. This tracks the
// simulated time the map should reflect (synced from the voyage scrubber
// when a route is loaded; live "now" otherwise) so every dimension the
// server actually declares gets a real value instead of being left out.
let desiredTime = new Date();
let appliedDimensionParams = null;

// WMS 1.3.0 KVP: the two standard dimensions ("time", "elevation") are
// sent as bare TIME=/ELEVATION=; any other, custom dimension a server
// declares must be prefixed DIM_ per the spec.
function dimensionParamKey(name) {
  const lower = name.toLowerCase();
  if (lower === 'time' || lower === 'elevation') return lower.toUpperCase();
  return `DIM_${name.toUpperCase()}`;
}

// Resolves one dimension's value for a GetMap request. The <Dimension>
// element's text content is either a comma-separated list of discrete
// values or a min/max/period interval (e.g.
// "2024-01-01T00:00:00Z/2024-01-02T00:00:00Z/PT1H"); for an interval we
// just hand the server an ISO instant in range (servers snap to the
// nearest valid step per the WMS spec) — for a discrete list we snap to
// the closest entry ourselves so the value we send is one the server
// actually advertised, not one we guessed.
function resolveDimensionValue(dim, forDate) {
  const raw = (dim.values || '').trim();
  if (dim.name.toLowerCase() !== 'time') {
    return dim.default || raw.split(',')[0]?.trim() || raw.split('/')[0]?.trim() || null;
  }
  if (raw.includes('/')) return forDate.toISOString();
  const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (entries.length === 0) return dim.default || null;
  let best = entries[0];
  let bestDelta = Infinity;
  for (const entry of entries) {
    const t = Date.parse(entry);
    if (Number.isNaN(t)) continue;
    const delta = Math.abs(t - forDate.getTime());
    if (delta < bestDelta) { bestDelta = delta; best = entry; }
  }
  return best;
}

function buildDimensionParams(layer, forDate) {
  const params = {};
  for (const dim of layer.dimensions || []) {
    const value = resolveDimensionValue(dim, forDate);
    if (value) params[dimensionParamKey(dim.name)] = value;
  }
  return params;
}

function addTileLayer(caps, layerName, styleName) {
  const layer = caps.allLayers.find(l => l.name === layerName) || caps.layer;
  const style = styleName ?? (layer.styles[0]?.name ?? '');
  currentLayerName = layer.name;
  currentStyleName = style;
  appliedDimensionParams = buildDimensionParams(layer, desiredTime);

  if (wmsLeafletLayer) state.map.removeLayer(wmsLeafletLayer);
  wmsLeafletLayer = L.tileLayer.wms(caps.getMapUrl, {
    layers: layer.name,
    styles: style,
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 0.75,
    attribution: '© BSH Strömungen (bsh.de)',
    ...appliedDimensionParams
  });
  wmsLeafletLayer.addTo(state.map);
  return layer;
}

// Keeps the WMS layer's time-varying dimension(s) synced to wherever the
// voyage scrubber currently is (mirrors particleField.js#setFieldTime,
// which does the same for the animated particle overlay) — live "now"
// when no route is being scrubbed. No-op if the layer isn't shown or
// doesn't declare a time dimension; cheap no-op if the snapped value
// hasn't actually changed, so frequent scrubber ticks don't spam the WMS
// server with a fresh tile request every frame.
export async function setBshWmsTime(date) {
  desiredTime = date instanceof Date ? date : new Date(date);
  if (!wmsLeafletLayer) return;
  const caps = await getWmsCapabilities().catch(() => null);
  if (!caps) return;
  const layer = caps.allLayers.find(l => l.name === currentLayerName) || caps.layer;
  const nextParams = buildDimensionParams(layer, desiredTime);
  const changed = Object.keys(nextParams).some(k => nextParams[k] !== appliedDimensionParams?.[k]);
  if (!changed) return;
  appliedDimensionParams = nextParams;
  wmsLeafletLayer.setParams(nextParams);
}

// Adds the layer, discovering capabilities first if needed. Returns
// {ok: true, layerTitle, allLayers, currentLayerName, currentStyleName}
// on success (allLayers/styles let the caller build a picker) or
// {ok: false, error} on failure — never throws, so callers can drive a
// toast/UI state directly off the result instead of needing their own
// try/catch.
export async function showBshWmsLayer() {
  try {
    const caps = await getWmsCapabilities();
    if (!wmsLeafletLayer) addTileLayer(caps, caps.layer.name, null);
    return {
      ok: true,
      layerTitle: caps.layer.title,
      allLayers: caps.allLayers,
      currentLayerName,
      currentStyleName
    };
  } catch (err) {
    wmsLeafletLayer = null;
    return { ok: false, error: err.message || String(err) };
  }
}

// Switches the visible layer/style without re-fetching capabilities
// (already cached from showBshWmsLayer). No-op if the WMS layer isn't
// currently shown.
export async function setBshWmsSelection(layerName, styleName) {
  if (!wmsLeafletLayer) return null;
  const caps = await getWmsCapabilities();
  return addTileLayer(caps, layerName, styleName);
}

export function hideBshWmsLayer() {
  appliedDimensionParams = null;
  if (wmsLeafletLayer) {
    state.map.removeLayer(wmsLeafletLayer);
    wmsLeafletLayer = null;
  }
}
