import { state } from './state.js';

// Real BSH tidal current data as a map overlay — a standard, public OGC
// WMS (Web Map Service) tile layer, not scraped or reverse-engineered:
// WMS is a documented protocol explicitly meant for exactly this (letting
// third-party map clients like this app request rendered map tiles), and
// BSH exposes this one anonymously ("guest") for public use. This is a
// genuinely different situation from pulling a proprietary vendor's
// internal, undocumented tile format — see the project history for that
// discussion.
//
// The exact layer name and any time/tidal-hour dimension can't be verified
// from this project's dev sandbox (its network egress can't reach
// geoseaportal.de to inspect the real GetCapabilities response), so this
// discovers them at runtime from the live capabilities document instead of
// hardcoding a guess. If that ever fails (the service is down, CORS
// blocks the browser, or the response shape isn't what's expected here),
// the layer toggle just reports it's unavailable rather than breaking
// anything else in the app.
const CAPABILITIES_URL = 'https://www.geoseaportal.de/wss/service/Gezeitenstrom_Daten/guest?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0';
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

async function discoverCapabilities() {
  const res = await fetchWithTimeout(CAPABILITIES_URL, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`WMS GetCapabilities HTTP ${res.status}`);
  const text = await res.text();
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
    layers.push({
      name: nameEl.textContent.trim(),
      title: titleEl ? titleEl.textContent.trim() : nameEl.textContent.trim(),
      dimensions
    });
  });
  if (layers.length === 0) throw new Error('WMS capabilities listed no requestable layers');

  let getMapUrl = CAPABILITIES_URL.split('?')[0];
  const onlineResource = xml.querySelector('Capability > Request > GetMap DCPType HTTP Get OnlineResource');
  if (onlineResource) {
    const href = xlinkHref(onlineResource);
    if (href) getMapUrl = href;
  }

  const preferred = layers.find((l) => /gezeiten|tidal|strom|current/i.test(l.title) || /gezeiten|tidal|strom|current/i.test(l.name)) || layers[0];

  return { getMapUrl, layer: preferred, allLayers: layers };
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

// Adds the layer, discovering capabilities first if needed. Returns
// {ok: true, layerTitle} on success or {ok: false, error} on failure —
// never throws, so callers can drive a toast/UI state directly off the
// result instead of needing their own try/catch.
export async function showBshWmsLayer() {
  if (wmsLeafletLayer) return { ok: true };
  try {
    const caps = await getWmsCapabilities();
    wmsLeafletLayer = L.tileLayer.wms(caps.getMapUrl, {
      layers: caps.layer.name,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      opacity: 0.75,
      attribution: '© BSH Gezeitenstrom (geoseaportal.de)'
    });
    wmsLeafletLayer.addTo(state.map);
    return { ok: true, layerTitle: caps.layer.title };
  } catch (err) {
    wmsLeafletLayer = null;
    return { ok: false, error: err.message || String(err) };
  }
}

export function hideBshWmsLayer() {
  if (wmsLeafletLayer) {
    state.map.removeLayer(wmsLeafletLayer);
    wmsLeafletLayer = null;
  }
}
