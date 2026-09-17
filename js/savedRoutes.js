import { state } from './state.js';
import { showToast } from './ui.js';
import { addWaypoint, clearAllWaypoints } from './waypoints.js';
import { addAvoidZone, clearAllAvoidZones } from './zones.js';

// Saved voyage plans (waypoints + hazard zones + solver settings) in the
// browser's own localStorage — no backend, no account, matches the rest
// of this app. Deliberately does NOT save the departure time or a
// computed route result: a saved plan is meant to be reusable later, and
// both weather and a stale departure time would just be wrong by then —
// the user re-runs "Route berechnen" after loading, same as with a preset.
const STORAGE_KEY = 'sailrouting_saved_routes_v1';
const MAX_SAVED = 30;

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // Corrupt data, or storage unavailable (private browsing, disabled) —
    // degrade to "no saved routes" rather than breaking the app.
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    return false;
  }
}

export function listSavedRoutes() {
  return readAll().sort((a, b) => b.savedAt - a.savedAt);
}

// Rebuilds the "Gespeicherte Routen" list DOM — same createElement/
// textContent pattern waypoints.js/zones.js use for their own lists
// (avoids innerHTML string interpolation of a user-supplied route name).
export function renderSavedRoutesList(onLoad) {
  const container = document.getElementById('savedRoutesList');
  if (!container) return;
  container.innerHTML = '';

  const routes = listSavedRoutes();
  if (routes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'text-[10px] text-slate-500 text-center py-1';
    empty.textContent = 'Noch keine Routen gespeichert.';
    container.appendChild(empty);
    return;
  }

  routes.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'bg-marine-900/80 border border-slate-700/80 rounded-lg p-1.5 flex items-center justify-between gap-1.5';

    const info = document.createElement('div');
    info.className = 'min-w-0';
    const nameEl = document.createElement('div');
    nameEl.className = 'font-semibold text-white truncate text-[11px]';
    nameEl.textContent = entry.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'text-[9.5px] text-slate-500';
    metaEl.textContent = `${entry.waypoints.length} WP · ${new Date(entry.savedAt).toLocaleDateString('de-DE')}`;
    info.append(nameEl, metaEl);

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1 shrink-0';

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'p-1 text-sky-400 hover:text-sky-300';
    loadBtn.setAttribute('aria-label', `${entry.name} laden`);
    loadBtn.innerHTML = '<i data-lucide="upload" class="w-3.5 h-3.5"></i>';
    loadBtn.addEventListener('click', () => {
      const config = loadSavedRoute(entry.id);
      onLoad?.(config);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'p-1 text-slate-500 hover:text-rose-400';
    deleteBtn.setAttribute('aria-label', `${entry.name} löschen`);
    deleteBtn.innerHTML = '<i data-lucide="trash" class="w-3.5 h-3.5"></i>';
    deleteBtn.addEventListener('click', () => {
      deleteSavedRoute(entry.id);
      renderSavedRoutesList(onLoad);
      showToast(`Route "${entry.name}" gelöscht`, 'slate');
    });

    actions.append(loadBtn, deleteBtn);
    item.append(info, actions);
    container.appendChild(item);
  });

  window.lucide?.createIcons();
}

export function saveCurrentRoute(name, config) {
  if (state.waypoints.length < 2) {
    showToast('Mindestens Start und Ziel nötig zum Speichern', 'amber');
    return false;
  }

  const entry = {
    id: Date.now() + Math.random(),
    name: (name || '').trim() || `Route ${new Date().toLocaleDateString('de-DE')}`,
    savedAt: Date.now(),
    waypoints: state.waypoints.map(w => ({ lat: w.lat, lng: w.lng, name: w.name })),
    avoidZones: state.avoidZones.map(z => ({ name: z.name, points: z.points })),
    config
  };

  const list = readAll();
  list.push(entry);
  while (list.length > MAX_SAVED) list.shift(); // drop the oldest if over the cap

  if (writeAll(list)) {
    showToast(`Route "${entry.name}" gespeichert`, 'emerald');
    return true;
  }
  showToast('Speichern fehlgeschlagen (Speicher voll oder deaktiviert?)', 'rose');
  return false;
}

export function deleteSavedRoute(id) {
  const list = readAll().filter(r => r.id !== id);
  writeAll(list);
}

// Replaces the current waypoints/hazard zones with a saved plan's, and
// restores the solver settings that were active when it was saved — same
// clear-then-rebuild pattern presets.js already uses. Returns the entry's
// config so the caller can push it into the slider/select UI.
export function loadSavedRoute(id) {
  const entry = readAll().find(r => r.id === id);
  if (!entry) return null;

  clearAllWaypoints();
  clearAllAvoidZones();
  entry.waypoints.forEach(wp => addWaypoint(wp.lat, wp.lng, wp.name));
  entry.avoidZones.forEach(zone => addAvoidZone(zone.name, zone.points));

  if (entry.waypoints.length > 0 && state.map) {
    const lats = entry.waypoints.map(w => w.lat);
    const lngs = entry.waypoints.map(w => w.lng);
    state.map.fitBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { padding: [40, 40] });
  }

  showToast(`Route "${entry.name}" geladen`, 'emerald');
  return entry.config || null;
}
