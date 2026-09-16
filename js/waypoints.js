import { state } from './state.js';
import { showToast } from './ui.js';
import { clearIsochroneLayers } from './mapLayers.js';

function buildWaypointIcon(label, isStart) {
  return L.divIcon({
    className: 'custom-wp-pin',
    html: `<div class="flex flex-col items-center">
            <div class="w-4 h-4 rounded-full ${isStart ? 'bg-emerald-400' : 'bg-sky-400'} border-2 border-slate-900 shadow-md"></div>
            <div class="text-[9px] font-bold text-white bg-slate-900/90 px-1 rounded shadow whitespace-nowrap"></div>
           </div>`,
    iconSize: [20, 30],
    iconAnchor: [10, 15]
  });
}

export function addWaypoint(lat, lng, name = null) {
  const id = Date.now() + Math.random();
  const idx = state.waypoints.length;
  const isStart = idx === 0;
  const defaultName = name || (isStart ? 'Start' : `Wegpunkt ${idx}`);

  const icon = buildWaypointIcon(defaultName, isStart);
  const marker = L.marker([lat, lng], { icon, draggable: true }).addTo(state.map);
  // Set the label text safely after building the divIcon markup (avoids
  // interpolating a possibly user-influenced name into an HTML string).
  const labelEl = marker.getElement()?.querySelector('div > div:last-child');
  if (labelEl) labelEl.textContent = defaultName;

  const wpObj = { id, lat, lng, name: defaultName, marker };

  marker.on('dragend', (e) => {
    const pos = e.target.getLatLng();
    wpObj.lat = pos.lat;
    wpObj.lng = pos.lng;
    renderWaypointList();
  });

  state.waypoints.push(wpObj);
  renderWaypointList();
}

export function removeWaypointAt(idx) {
  const wp = state.waypoints[idx];
  if (wp) {
    state.map.removeLayer(wp.marker);
    state.waypoints.splice(idx, 1);
    renderWaypointList();
  }
}

export function clearAllWaypoints() {
  state.waypoints.forEach(w => state.map.removeLayer(w.marker));
  state.waypoints = [];
  clearIsochroneLayers();
  renderWaypointList();
  showToast('Alle Wegpunkte gelöscht', 'sky');
}

export function renderWaypointList() {
  const container = document.getElementById('waypointList');
  container.innerHTML = '';

  state.waypoints.forEach((wp, idx) => {
    const isStart = idx === 0;
    const isFinish = idx === state.waypoints.length - 1 && state.waypoints.length > 1;
    const badgeColor = isStart ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
                       isFinish ? 'bg-rose-500/20 text-rose-400 border-rose-500/30' :
                       'bg-sky-500/20 text-sky-400 border-sky-500/30';
    const label = isStart ? 'Start' : (isFinish ? 'Ziel' : `WP ${idx}`);

    const item = document.createElement('div');
    item.className = 'bg-marine-800/80 border border-slate-700/80 rounded-xl p-2 flex items-center justify-between text-xs';

    const left = document.createElement('div');
    left.className = 'flex items-center gap-2';

    const badge = document.createElement('span');
    badge.className = `text-[10px] font-bold px-1.5 py-0.5 rounded border ${badgeColor}`;
    badge.textContent = label;

    const info = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'font-semibold text-white';
    nameEl.textContent = wp.name;
    const coordEl = document.createElement('div');
    coordEl.className = 'font-mono text-[10px] text-slate-400';
    coordEl.textContent = `${wp.lat.toFixed(4)}°, ${wp.lng.toFixed(4)}°`;
    info.append(nameEl, coordEl);

    left.append(badge, info);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'p-1 text-slate-500 hover:text-rose-400';
    removeBtn.setAttribute('aria-label', `${wp.name} entfernen`);
    removeBtn.innerHTML = '<i data-lucide="trash" class="w-3.5 h-3.5"></i>';
    removeBtn.addEventListener('click', () => removeWaypointAt(idx));

    item.append(left, removeBtn);
    container.appendChild(item);
  });

  window.lucide?.createIcons();
}
