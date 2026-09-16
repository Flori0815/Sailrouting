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
  playInterval: null
};
