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
import { initParticleField, setLayerVisible, isLayerVisible, setColorFieldVisible, setColorFieldParam, colorScaleCss } from './particleField.js';
import { findBestDepartureTime, toggleDepartureVariantsOnMap } from './departureWindow.js';
import { updateTidalPhaseBadge, renderDataSourcesPanel } from './results.js';

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

  const LAYER_ACCENTS = { wind: 'text-sky-300 border-sky-400/50 bg-sky-500/10', current: 'text-teal-300 border-teal-400/50 bg-teal-500/10', wave: 'text-violet-300 border-violet-400/50 bg-violet-500/10' };
  const INACTIVE_LAYER_CLASS = 'text-slate-500 bg-marine-900/60 border-slate-800';

  function refreshWeatherIndicator() {
    const anyOn = state.animLayers.wind || state.animLayers.current || state.animLayers.wave;
    document.getElementById('weatherOverlayIndicator').className = `w-1.5 h-1.5 rounded-full ${anyOn ? 'bg-sky-400' : 'bg-slate-500'}`;
  }

  function refreshLayerButtonStyle(kind) {
    const btn = document.getElementById(`btnLayer${kind.charAt(0).toUpperCase()}${kind.slice(1)}`);
    const on = state.animLayers[kind];
    btn.setAttribute('aria-pressed', String(on));
    btn.className = `anim-layer-btn flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-[9px] font-medium border active:scale-95 transition-transform ${on ? LAYER_ACCENTS[kind] : INACTIVE_LAYER_CLASS}`;
  }

  ['wind', 'current', 'wave'].forEach((kind) => {
    refreshLayerButtonStyle(kind);
    document.getElementById(`btnLayer${kind.charAt(0).toUpperCase()}${kind.slice(1)}`).addEventListener('click', () => {
      setLayerVisible(kind, !isLayerVisible(kind));
      refreshLayerButtonStyle(kind);
      refreshWeatherIndicator();
    });
  });

  // Header button: quick all-layers toggle (turns everything on if any
  // layer is currently off, or everything off if all three are on),
  // leaving the fine-grained per-layer buttons in the HUD for individual
  // control.
  document.getElementById('btnToggleWeatherOverlay').addEventListener('click', () => {
    const anyOn = state.animLayers.wind || state.animLayers.current || state.animLayers.wave;
    const next = !anyOn;
    ['wind', 'current', 'wave'].forEach((kind) => {
      setLayerVisible(kind, next);
      refreshLayerButtonStyle(kind);
    });
    refreshWeatherIndicator();
    showToast(next ? 'Wetter-Animation: Sichtbar' : 'Wetter-Animation: Ausgeblendet', next ? 'sky' : 'slate');
  });

  const colorFieldBtn = document.getElementById('btnLayerColorField');
  const colorFieldControls = document.getElementById('colorFieldControls');
  function refreshColorFieldUI() {
    const on = state.isColorFieldVisible;
    colorFieldBtn.setAttribute('aria-pressed', String(on));
    colorFieldBtn.className = `flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-[9px] font-medium border active:scale-95 transition-transform ${on ? 'text-amber-300 border-amber-400/50 bg-amber-500/10' : INACTIVE_LAYER_CLASS}`;
    colorFieldControls.classList.toggle('hidden', !on);
    if (on) {
      const scale = colorScaleCss(state.colorFieldParam);
      document.getElementById('colorFieldGradientBar').style.background = scale.css;
      document.getElementById('colorFieldLegendLabel').textContent = scale.label;
      document.getElementById('colorFieldLegendMax').textContent = `${scale.max} ${scale.unit}`;
    }
  }
  colorFieldBtn.addEventListener('click', () => {
    setColorFieldVisible(!state.isColorFieldVisible);
    refreshColorFieldUI();
  });
  document.getElementById('colorFieldParamSelect').addEventListener('change', (e) => {
    setColorFieldParam(e.target.value);
    refreshColorFieldUI();
  });
  refreshColorFieldUI();

  const dataSourcesPanel = document.getElementById('dataSourcesPanel');
  const dataSourcesToggle = document.getElementById('btnToggleDataSources');
  dataSourcesToggle.addEventListener('click', () => {
    const isHidden = dataSourcesPanel.classList.toggle('hidden');
    dataSourcesToggle.setAttribute('aria-expanded', String(!isHidden));
    document.getElementById('dataSourcesChevron').setAttribute('data-lucide', isHidden ? 'chevron-down' : 'chevron-up');
    window.lucide?.createIcons();
    if (!isHidden) renderDataSourcesPanel();
  });

  document.getElementById('checkTidalHeuristicEnabled').addEventListener('change', (e) => {
    state.tidalHeuristicEnabled = e.target.checked;
  });
  document.getElementById('tidalAmplitudeSlider').addEventListener('input', (e) => {
    state.tidalAmplificationFactor = parseFloat(e.target.value);
    document.getElementById('tidalAmplitudeLabel').textContent = `${state.tidalAmplificationFactor.toFixed(1)}×`;
  });
  document.getElementById('tidalPhaseOffsetSlider').addEventListener('input', (e) => {
    state.tidalPhaseOffsetHours = parseFloat(e.target.value);
    const label = document.getElementById('tidalPhaseOffsetLabel');
    label.textContent = `${state.tidalPhaseOffsetHours >= 0 ? '+' : ''}${state.tidalPhaseOffsetHours.toFixed(1)} h`;
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
    updateTidalPhaseBadge(DEFAULT_MAP_CENTER[0], DEFAULT_MAP_CENTER[1], new Date());
  } catch (err) {
    console.error('Initialization failed', err);
    showToast('Initialisierung fehlgeschlagen. Bitte Seite neu laden.', 'rose');
  }
}

window.addEventListener('DOMContentLoaded', init);
