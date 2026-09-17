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

function addTileLayer(caps, layerName, styleName) {
  const layer = caps.allLayers.find(l => l.name === layerName) || caps.layer;
  const style = styleName ?? (layer.styles[0]?.name ?? '');
  currentLayerName = layer.name;
  currentStyleName = style;

  if (wmsLeafletLayer) state.map.removeLayer(wmsLeafletLayer);
  wmsLeafletLayer = L.tileLayer.wms(caps.getMapUrl, {
    layers: layer.name,
    styles: style,
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 0.75,
    attribution: '© BSH Strömungen (bsh.de)'
  });
  wmsLeafletLayer.addTo(state.map);
  return layer;
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
  if (wmsLeafletLayer) {
    state.map.removeLayer(wmsLeafletLayer);
    wmsLeafletLayer = null;
  }
}
