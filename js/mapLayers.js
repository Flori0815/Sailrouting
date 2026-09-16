import { state } from './state.js';

export function clearIsochroneLayers() {
  state.isochroneLayers.forEach(l => state.map.removeLayer(l));
  state.isochroneLayers = [];
  if (state.routePolyline) {
    state.map.removeLayer(state.routePolyline);
    state.routePolyline = null;
  }
  state.vectorMarkers.forEach(m => state.map.removeLayer(m));
  state.vectorMarkers = [];
}

function drawVectorArrowsOnMap(data) {
  state.vectorMarkers.forEach(m => state.map.removeLayer(m));
  state.vectorMarkers = [];

  // Avoid clutter: sample at most 5 evenly spaced labels along the route
  const stride = Math.max(1, Math.floor(data.legs.length / 5));
  for (let i = 0; i < data.legs.length; i += stride) {
    const leg = data.legs[i];
    const arrowIcon = L.divIcon({
      className: 'vector-arrow',
      html: `<div class="flex items-center gap-1 text-[9px] font-mono text-sky-300 bg-marine-950/90 px-1.5 py-0.5 rounded border border-slate-700 pointer-events-none whitespace-nowrap shadow-md">
              <span style="transform: rotate(${leg.heading}deg)" class="inline-block text-sky-400 font-bold">↑</span>
              <span>${leg.stw}k STW</span>
              <span class="text-emerald-400">🌊${leg.currentSpeed}k</span>
             </div>`,
      iconSize: [85, 20],
      iconAnchor: [42, 10]
    });
    const m = L.marker(leg.midCoord, { icon: arrowIcon }).addTo(state.map);
    state.vectorMarkers.push(m);
  }
}

export function drawIsochroneVisualsOnMap(data) {
  clearIsochroneLayers();

  const showWavefronts = document.getElementById('checkShowWavefronts').checked && state.isIsochroneLayersVisible;
  const showRays = document.getElementById('checkShowRays').checked && state.isIsochroneLayersVisible;

  if (showRays && data.allRays) {
    const stepInc = Math.max(1, Math.floor(data.allRays.length / 90));
    for (let i = 0; i < data.allRays.length; i += stepInc) {
      const ray = data.allRays[i];
      const line = L.polyline(ray, {
        color: '#38bdf8',
        weight: 1.0,
        opacity: 0.22,
        dashArray: '2, 5'
      }).addTo(state.map);
      state.isochroneLayers.push(line);
    }
  }

  if (showWavefronts && data.isochroneWavefronts) {
    data.isochroneWavefronts.forEach((wavePts, idx) => {
      if (wavePts.length >= 2) {
        const hue = 185 + (idx * 6) % 65;
        const wave = L.polyline(wavePts, {
          color: `hsl(${hue}, 95%, 62%)`,
          weight: 2.0,
          opacity: 0.65
        }).addTo(state.map);
        state.isochroneLayers.push(wave);
      }
    });
  }

  state.routePolyline = L.polyline(data.routePoints, {
    color: '#10b981',
    weight: 4.5,
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round'
  }).addTo(state.map);

  if (!state.boatMarker) {
    const boatIcon = L.divIcon({
      className: 'boat-marker',
      html: `<div id="boatIconDiv" class="text-sky-400 transform transition-transform duration-300 drop-shadow-[0_0_10px_rgba(56,189,248,0.9)]">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polygon points="12 2 19 21 12 17 5 21 12 2" fill="#38bdf8" fill-opacity="0.4"></polygon>
              </svg>
             </div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    state.boatMarker = L.marker(data.routePoints[0], { icon: boatIcon, zIndexOffset: 1000 }).addTo(state.map);
  } else {
    state.boatMarker.setLatLng(data.routePoints[0]);
  }

  drawVectorArrowsOnMap(data);
}
