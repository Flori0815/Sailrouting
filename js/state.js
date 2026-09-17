// Single mutable store shared across modules. Kept as a plain object (not
// classes/observables) because the app is a small single-page tool and a
// heavier state-management layer would be pure overhead here.
export const state = {
  map: null,
  openSeaMapLayer: null,
  isSeamarksVisible: true,
  isIsochroneLayersVisible: true,
  waypoints: [],
  avoidZones: [],
  isochroneLayers: [],
  routePolyline: null,
  boatMarker: null,
  vectorMarkers: [],
  calculatedRouteData: null,
  isAddingWaypointMode: false,
  isDrawingZoneMode: false,
  drawingZonePoints: [],
  drawingTempLine: null,
  isPlaying: false,
  playInterval: null,
  // Per-type animation visibility, replacing a single all-or-nothing flag so
  // wind/current/wave particle streams can be switched independently. Off
  // by default, matching the app's original single-toggle behavior (opt in
  // rather than showing animated overlays immediately on load).
  animLayers: { wind: false, current: false, wave: false },
  isColorFieldVisible: false,
  colorFieldParam: 'wind', // 'wind' | 'current' | 'wave'
  departureVariantLayerGroup: null,
  // Coarse, dependency-free German Bight/Wadden Sea tidal current heuristic
  // (see js/tidal.js) — pending a real BSH Gezeitenstromatlas integration.
  tidalHeuristicEnabled: true,
  tidalAmplificationFactor: 1.6,
  tidalPhaseOffsetHours: 0
};

// Backward-compatible getter: true whenever at least one animated layer is
// on, so code that only needs to know "is the canvas showing anything"
// doesn't need to know about the per-type breakdown.
Object.defineProperty(state, 'isWeatherOverlayVisible', {
  get() {
    return state.animLayers.wind || state.animLayers.current || state.animLayers.wave;
  }
});
