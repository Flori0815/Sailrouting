import { state } from './state.js';

export function addAvoidZone(name, points) {
  const polygon = L.polygon(points, {
    color: '#f43f5e',
    fillColor: '#f43f5e',
    fillOpacity: 0.25,
    weight: 2
  }).addTo(state.map);

  state.avoidZones.push({ id: Date.now() + Math.random(), name, points, polygon });
  renderAvoidZones();
}

export function removeAvoidZoneAt(idx) {
  const zone = state.avoidZones[idx];
  if (zone) {
    state.map.removeLayer(zone.polygon);
    state.avoidZones.splice(idx, 1);
    renderAvoidZones();
  }
}

export function clearAllAvoidZones() {
  state.avoidZones.forEach(z => state.map.removeLayer(z.polygon));
  state.avoidZones = [];
  renderAvoidZones();
}

export function renderAvoidZones() {
  const container = document.getElementById('zoneListContainer');
  document.getElementById('zoneCountBadge').textContent = `${state.avoidZones.length} Aktiv`;
  container.innerHTML = '';

  state.avoidZones.forEach((z, idx) => {
    const item = document.createElement('div');
    item.className = 'bg-marine-800/80 border border-slate-700/80 rounded-xl p-2 flex items-center justify-between text-xs';

    const left = document.createElement('div');
    left.className = 'flex items-center gap-2';
    left.innerHTML = '<i data-lucide="shield-alert" class="w-3.5 h-3.5 text-rose-400"></i>';

    const nameEl = document.createElement('span');
    nameEl.className = 'font-medium text-slate-200';
    nameEl.textContent = z.name;
    left.appendChild(nameEl);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'p-1 text-slate-500 hover:text-rose-400';
    removeBtn.setAttribute('aria-label', `${z.name} entfernen`);
    removeBtn.innerHTML = '<i data-lucide="trash" class="w-3.5 h-3.5"></i>';
    removeBtn.addEventListener('click', () => removeAvoidZoneAt(idx));

    item.append(left, removeBtn);
    container.appendChild(item);
  });

  window.lucide?.createIcons();
}
