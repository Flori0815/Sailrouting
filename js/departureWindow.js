import { state } from './state.js';
import { computeFullRoute, applyRouteResult, readOptimizerConfig } from './optimizer.js';
import { showToast, switchTab } from './ui.js';

// Hard cap on how many alternative departure times we'll ever solve in one
// go — each candidate is a full multi-leg isochrone solve, so this bounds
// both wait time and the number of requests sent to the weather/current API.
const MAX_CANDIDATES = 15;

function buildCandidateOffsets(windowHours, stepHours) {
  const offsets = [];
  for (let h = -windowHours; h <= windowHours + 1e-9; h += stepHours) {
    offsets.push(+h.toFixed(2));
  }
  return offsets;
}

function formatDuration(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

function formatOffset(h) {
  if (h === 0) return 'Geplant';
  const sign = h > 0 ? '+' : '−';
  return `${sign}${Math.abs(h)}h`;
}

function setBusy(busy) {
  const btn = document.getElementById('btnFindBestDeparture');
  btn.disabled = busy;
  btn.classList.toggle('opacity-60', busy);
  btn.classList.toggle('cursor-not-allowed', busy);
}

// Color-codes a candidate's route line by how far its offset sits from the
// planned time: cooler/bluer for earlier departures, warmer/amber for
// later ones, with the fastest candidate always drawn in solid emerald.
function colorForCandidate(offset, isBest) {
  if (isBest) return '#10b981';
  if (offset < 0) {
    const t = Math.min(1, Math.abs(offset) / 6);
    return `hsl(${210 + t * 40}, 75%, 62%)`;
  }
  if (offset > 0) {
    const t = Math.min(1, offset / 6);
    return `hsl(${45 - t * 25}, 90%, 58%)`;
  }
  return '#94a3b8';
}

export function clearDepartureVariants() {
  if (state.departureVariantLayerGroup) {
    state.departureVariantLayerGroup.clearLayers();
    state.map.removeLayer(state.departureVariantLayerGroup);
  }
}

function renderDepartureVariantsOnMap(candidates, bestOffset) {
  clearDepartureVariants();
  if (!state.departureVariantLayerGroup) {
    state.departureVariantLayerGroup = L.layerGroup();
  }
  state.departureVariantLayerGroup.addTo(state.map);

  candidates
    .filter(c => c.result)
    .forEach(({ offset, departureTime, result }) => {
      const isBest = offset === bestOffset;
      const line = L.polyline(result.routePoints, {
        color: colorForCandidate(offset, isBest),
        weight: isBest ? 3 : 2,
        opacity: isBest ? 0.9 : 0.55,
        dashArray: isBest ? null : '5, 6'
      });
      line.bindTooltip(
        `${formatOffset(offset)} · ${departureTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${formatDuration(result.totalHours)}, ETA ${result.arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        { sticky: true }
      );
      line.addTo(state.departureVariantLayerGroup);
    });
}

// Cache of the last search's candidates so the "show all variants" checkbox
// can be toggled on/off without re-running the (expensive) route search.
let lastCandidates = [];

export function toggleDepartureVariantsOnMap(show) {
  if (!show) {
    clearDepartureVariants();
    return;
  }
  const viable = lastCandidates.filter(c => c.result);
  if (viable.length === 0) return;
  const best = [...viable].sort((a, b) => a.result.totalHours - b.result.totalHours)[0];
  renderDepartureVariantsOnMap(lastCandidates, best.offset);
}

export async function findBestDepartureTime() {
  if (state.waypoints.length < 2) {
    showToast('Bitte mindestens Start und Ziel setzen.', 'amber');
    return;
  }

  const windowHours = Math.min(6, Math.max(1, parseFloat(document.getElementById('departureWindowHours').value) || 3));
  const stepHours = Math.max(0.5, parseFloat(document.getElementById('departureWindowStep').value) || 1);
  const depInput = document.getElementById('departureTime').value;
  const baseTime = depInput ? new Date(depInput) : new Date();

  let offsets = buildCandidateOffsets(windowHours, stepHours);
  if (offsets.length > MAX_CANDIDATES) {
    offsets = offsets.slice(0, MAX_CANDIDATES);
  }

  const config = readOptimizerConfig();
  const resultsContainer = document.getElementById('departureWindowResults');
  resultsContainer.innerHTML = '';
  clearDepartureVariants();
  setBusy(true);

  const candidates = [];
  try {
    for (let i = 0; i < offsets.length; i++) {
      const offset = offsets[i];
      showToast(`Prüfe Abfahrtszeiten... (${i + 1}/${offsets.length})`, 'sky');
      const departureTime = new Date(baseTime.getTime() + offset * 3600 * 1000);
      let result = null;
      try {
        result = await computeFullRoute(state.waypoints, departureTime, config, state.avoidZones);
      } catch (err) {
        console.error('Departure window candidate failed', err);
      }
      candidates.push({ offset, departureTime, result });
    }
  } finally {
    setBusy(false);
  }

  const viable = candidates.filter(c => c.result);
  if (viable.length === 0) {
    showToast('Keine navigierbare Route in diesem Zeitfenster gefunden.', 'rose');
    return;
  }

  viable.sort((a, b) => a.result.totalHours - b.result.totalHours);
  const best = viable[0];

  lastCandidates = candidates;
  renderDepartureWindowResults(candidates, best.offset);
  if (document.getElementById('checkShowAllDepartureVariants').checked) {
    renderDepartureVariantsOnMap(candidates, best.offset);
  }
  showToast(`Beste Abfahrt: ${formatOffset(best.offset)} (${formatDuration(best.result.totalHours)})`, 'emerald');
}

function renderDepartureWindowResults(candidates, bestOffset) {
  const container = document.getElementById('departureWindowResults');
  container.innerHTML = '';

  const sorted = [...candidates].sort((a, b) => a.offset - b.offset);

  sorted.forEach(({ offset, departureTime, result }) => {
    const isBest = result !== null && offset === bestOffset;

    const row = document.createElement('div');
    row.className = `flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border text-[11px] ${
      isBest ? 'bg-emerald-500/15 border-emerald-500/40' : 'bg-marine-900/80 border-slate-800'
    }`;

    const left = document.createElement('div');
    left.className = 'flex flex-col min-w-0';

    const timeLabel = document.createElement('span');
    timeLabel.className = `font-mono font-bold ${isBest ? 'text-emerald-300' : 'text-slate-200'}`;
    timeLabel.textContent = `${formatOffset(offset)} · ${departureTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    left.appendChild(timeLabel);

    const detail = document.createElement('span');
    detail.className = 'text-slate-400 text-[10px] truncate';
    detail.textContent = result
      ? `${formatDuration(result.totalHours)} · ${result.totalDistance} nm · ETA ${result.arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Keine Route gefunden';
    left.appendChild(detail);

    row.appendChild(left);

    if (result) {
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = `shrink-0 px-2 py-1 rounded-lg text-[10px] font-semibold ${isBest ? 'bg-emerald-500 text-slate-950' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'}`;
      applyBtn.textContent = isBest ? '★ Anwenden' : 'Anwenden';
      applyBtn.addEventListener('click', () => {
        applyRouteResult(result);
        showToast(`Route für ${formatOffset(offset)} angewendet`, 'emerald');
        switchTab('resultsTab');
      });
      row.appendChild(applyBtn);
    }

    container.appendChild(row);
  });
}
