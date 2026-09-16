import { state } from './state.js';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from './constants.js';
import { calculateDistanceNm } from './geo.js';
import { showToast, toggleSidebar, switchTab } from './ui.js';
import { addWaypoint, clearAllWaypoints } from './waypoints.js';
import { addAvoidZone } from './zones.js';
import { loadPreset } from './presets.js';
import { drawIsochroneVisualsOnMap } from './mapLayers.js';
import { drawPolarDiagramCanvas } from './polarChart.js';
import { initVoyageScrubber } from './voyage.js';
import { exportGpxFile } from './gpx.js';
import { triggerIsochroneRouteOptimization } from './optimizer.js';
import { initParticleField, toggleWeatherOverlay } from './particleField.js';
import { findBestDepartureTime, toggleDepartureVariantsOnMap } from './departureWindow.js';

function initMap() {
  state.map = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    opacity: 0.88,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);

  state.openSeaMapLayer = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18,
    opacity: 1.0,
    attribution: '&copy; OpenSeaMap contributors'
  }).addTo(state.map);

  state.map.on('click', (e) => {
    if (state.isAddingWaypointMode) {
      addWaypoint(e.latlng.lat, e.latlng.lng);
      state.isAddingWaypointMode = false;
      document.getElementById('map').classList.remove('crosshair-cursor');
      showToast('Wegpunkt gesetzt!', 'emerald');
      toggleSidebar(true);
      return;
    }

    if (state.isDrawingZoneMode) {
      state.drawingZonePoints.push([e.latlng.lat, e.latlng.lng]);
      if (!state.drawingTempLine) {
        state.drawingTempLine = L.polyline(state.drawingZonePoints, { color: '#f43f5e', dashArray: '5, 5' }).addTo(state.map);
      } else {
        state.drawingTempLine.setLatLngs(state.drawingZonePoints);
      }

      if (state.drawingZonePoints.length >= 3) {
        const first = state.drawingZonePoints[0];
        const dist = calculateDistanceNm(e.latlng.lat, e.latlng.lng, first[0], first[1]);
        if (dist < 0.8 && state.drawingZonePoints.length > 3) {
          state.map.removeLayer(state.drawingTempLine);
          state.drawingTempLine = null;
          addAvoidZone(`Sperrgebiet ${state.avoidZones.length + 1}`, state.drawingZonePoints);
          state.drawingZonePoints = [];
          state.isDrawingZoneMode = false;
          document.getElementById('map').classList.remove('crosshair-cursor');
          showToast('Sperrgebiet gespeichert!', 'emerald');
          toggleSidebar(true);
          switchTab('hazardsTab');
        }
      }
    }
  });
}

function wireControls() {
  document.getElementById('btnToggleSidebar').addEventListener('click', () => toggleSidebar());
  document.getElementById('btnCloseSidebar').addEventListener('click', () => toggleSidebar(false));
  document.getElementById('sidebarBackdrop').addEventListener('click', () => toggleSidebar(false));

  document.getElementById('btnQuickOptimize').addEventListener('click', triggerIsochroneRouteOptimization);
  document.getElementById('btnRunOptimizer').addEventListener('click', () => {
    toggleSidebar(false);
    triggerIsochroneRouteOptimization();
  });

  document.getElementById('btnToggleIsochrones').addEventListener('click', () => {
    state.isIsochroneLayersVisible = !state.isIsochroneLayersVisible;
    const ind = document.getElementById('isochroneIndicator');
    if (state.isIsochroneLayersVisible) {
      ind.className = 'w-2 h-2 rounded-full bg-sky-400';
      showToast('Isochronen: Sichtbar', 'sky');
    } else {
      ind.className = 'w-2 h-2 rounded-full bg-slate-500';
      showToast('Isochronen: Ausgeblendet', 'slate');
    }
    if (state.calculatedRouteData) drawIsochroneVisualsOnMap(state.calculatedRouteData);
  });

  document.getElementById('btnToggleSeamarks').addEventListener('click', () => {
    state.isSeamarksVisible = !state.isSeamarksVisible;
    if (state.isSeamarksVisible) {
      state.map.addLayer(state.openSeaMapLayer);
      document.getElementById('seamarksIndicator').className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
      showToast('OpenSeaMap Betonnung: EIN', 'sky');
    } else {
      state.map.removeLayer(state.openSeaMapLayer);
      document.getElementById('seamarksIndicator').className = 'w-1.5 h-1.5 rounded-full bg-slate-500';
      showToast('OpenSeaMap Betonnung: AUS', 'slate');
    }
  });

  document.getElementById('btnToggleWeatherOverlay').addEventListener('click', () => {
    const isVisible = toggleWeatherOverlay();
    const ind = document.getElementById('weatherOverlayIndicator');
    if (isVisible) {
      ind.className = 'w-1.5 h-1.5 rounded-full bg-sky-400';
      showToast('Wind- & Strom-Overlay: Sichtbar', 'sky');
    } else {
      ind.className = 'w-1.5 h-1.5 rounded-full bg-slate-500';
      showToast('Wind- & Strom-Overlay: Ausgeblendet', 'slate');
    }
  });

  document.getElementById('btnFindBestDeparture').addEventListener('click', findBestDepartureTime);
  document.getElementById('checkShowAllDepartureVariants').addEventListener('change', (e) => {
    toggleDepartureVariantsOnMap(e.target.checked);
  });

  document.getElementById('quickPresetSelector').addEventListener('change', (e) => {
    loadPreset(e.target.value);
  });

  document.getElementById('btnAddWpMode').addEventListener('click', () => {
    state.isAddingWaypointMode = true;
    document.getElementById('map').classList.add('crosshair-cursor');
    toggleSidebar(false);
    showToast('Auf die Seekarte tippen, um Punkt zu setzen', 'sky');
  });

  document.getElementById('btnClearWps').addEventListener('click', clearAllWaypoints);

  document.getElementById('btnStartDrawZone').addEventListener('click', () => {
    state.isDrawingZoneMode = true;
    state.drawingZonePoints = [];
    document.getElementById('map').classList.add('crosshair-cursor');
    toggleSidebar(false);
    showToast('Punkte um Hindernis tippen. Startpunkt antippen zum Schließen.', 'rose');
  });

  document.getElementById('tabBtnWaypoints').addEventListener('click', () => switchTab('waypointsTab'));
  document.getElementById('tabBtnIsochrone').addEventListener('click', () => switchTab('isochroneTab'));
  document.getElementById('tabBtnPolars').addEventListener('click', () => switchTab('polarsTab', () => {
    const val = parseInt(document.getElementById('polarTwsSlider').value, 10);
    drawPolarDiagramCanvas(val);
  }));
  document.getElementById('tabBtnHazards').addEventListener('click', () => switchTab('hazardsTab'));
  document.getElementById('tabBtnResults').addEventListener('click', () => switchTab('resultsTab'));

  let isHudMinimized = false;
  document.getElementById('btnMinimizeHud').addEventListener('click', () => {
    isHudMinimized = !isHudMinimized;
    const hudBody = document.getElementById('hudBody');
    const icon = document.getElementById('btnMinimizeHud');
    if (isHudMinimized) {
      hudBody.classList.add('hidden');
      icon.innerHTML = '<i data-lucide="chevron-down" class="w-3.5 h-3.5"></i>';
    } else {
      hudBody.classList.remove('hidden');
      icon.innerHTML = '<i data-lucide="chevron-up" class="w-3.5 h-3.5"></i>';
    }
    window.lucide?.createIcons();
  });

  const polarSlider = document.getElementById('polarTwsSlider');
  polarSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    document.getElementById('polarTwsLabel').textContent = `${val} kn Wind`;
    document.getElementById('polarTwsSliderVal').textContent = `${val} kn`;
    drawPolarDiagramCanvas(val);
  });

  document.getElementById('stepTimeSlider').addEventListener('input', (e) => {
    document.getElementById('stepTimeLabel').textContent = `${e.target.value} min`;
  });
  document.getElementById('fanWidthSlider').addEventListener('input', (e) => {
    document.getElementById('fanWidthLabel').textContent = `±${e.target.value}°`;
  });
  document.getElementById('raysPerNodeSlider').addEventListener('input', (e) => {
    document.getElementById('raysPerNodeLabel').textContent = `${e.target.value} Strahlen`;
  });
  document.getElementById('sectorBinsSlider').addEventListener('input', (e) => {
    document.getElementById('sectorBinsLabel').textContent = `${e.target.value} Sektoren`;
  });
  document.getElementById('refinementPassesSlider').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    document.getElementById('refinementPassesLabel').textContent = val === 1 ? '1 (aus)' : `${val}`;
  });
  document.getElementById('waveSensitivitySlider').addEventListener('input', (e) => {
    document.getElementById('waveSensitivityLabel').textContent = `${e.target.value}%`;
  });

  document.getElementById('btnExportGpx').addEventListener('click', exportGpxFile);
}

function init() {
  try {
    initMap();
    initParticleField();
    wireControls();

    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById('departureTime').value = now.toISOString().slice(0, 16);

    window.lucide?.createIcons();
    initVoyageScrubber();
    drawPolarDiagramCanvas(16);
    loadPreset('helgoland');
  } catch (err) {
    console.error('Initialization failed', err);
    showToast('Initialisierung fehlgeschlagen. Bitte Seite neu laden.', 'rose');
  }
}

window.addEventListener('DOMContentLoaded', init);
