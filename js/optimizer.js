import { state } from './state.js';
import { calculateDistanceNm, calculateBearingDeg } from './geo.js';
import { solveIsochronePassage } from './routing.js';
import { clearIsochroneLayers, drawIsochroneVisualsOnMap } from './mapLayers.js';
import { renderRouteResults } from './results.js';
import { showToast, toggleSidebar, switchTab } from './ui.js';

export async function triggerIsochroneRouteOptimization() {
  if (state.waypoints.length < 2) {
    showToast('Bitte mindestens Start und Ziel setzen.', 'amber');
    toggleSidebar(true);
    return;
  }

  showToast('Berechne saubere Isochronen-Front...', 'sky');

  const depInput = document.getElementById('departureTime').value;
  const passageStartTime = depInput ? new Date(depInput) : new Date();

  const config = {
    dtMinutes: parseInt(document.getElementById('stepTimeSlider').value, 10) || 20,
    fanWidthDeg: parseInt(document.getElementById('fanWidthSlider').value, 10) || 55,
    numRaysPerNode: parseInt(document.getElementById('raysPerNodeSlider').value, 10) || 11,
    numSectors: parseInt(document.getElementById('sectorBinsSlider').value, 10) || 24,
    strategy: document.getElementById('routingStrategy').value
  };

  clearIsochroneLayers();

  const fullRoutePoints = [];
  const fullLegs = [];
  let currentDeparture = new Date(passageStartTime);
  let totalDist = 0;
  let totalDurationHrs = 0;
  const combinedWavefronts = [];
  const combinedRays = [];

  try {
    for (let w = 0; w < state.waypoints.length - 1; w++) {
      const p1 = [state.waypoints[w].lat, state.waypoints[w].lng];
      const p2 = [state.waypoints[w + 1].lat, state.waypoints[w + 1].lng];

      const sol = await solveIsochronePassage(p1, p2, currentDeparture, config, state.avoidZones);
      if (!sol || !sol.pathNodes || sol.pathNodes.length < 2) {
        showToast(`Kein sicherer Weg zwischen WP${w} und WP${w + 1}`, 'rose');
        continue;
      }

      combinedWavefronts.push(...sol.isochroneWavefronts);
      combinedRays.push(...sol.allRays);

      for (let i = 0; i < sol.pathNodes.length - 1; i++) {
        const nA = sol.pathNodes[i];
        const nB = sol.pathNodes[i + 1];
        const d = calculateDistanceNm(nA.lat, nA.lon, nB.lat, nB.lon);
        const cog = calculateBearingDeg(nA.lat, nA.lon, nB.lat, nB.lon);
        const legDur = nB.timeHours - nA.timeHours;

        let twa = Math.abs(nA.twd - cog) % 360;
        if (twa > 180) twa = 360 - twa;

        fullLegs.push({
          index: fullLegs.length + 1,
          fromCoord: [nA.lat, nA.lon],
          toCoord: [nB.lat, nB.lon],
          midCoord: [(nA.lat + nB.lat) / 2, (nA.lon + nB.lon) / 2],
          distance: +d.toFixed(2),
          cog: Math.round(cog),
          heading: nA.heading,
          tws: nA.tws,
          twd: nA.twd,
          twa: Math.round(twa),
          currentSpeed: nA.curSpeed,
          currentDir: nA.curDir,
          stw: nA.stw,
          sog: nA.sog,
          durationHours: legDur,
          isBeating: twa < 44,
          tackSide: (cog - nA.twd + 360) % 360 > 180 ? 'Steuerbordbug' : 'Backbordbug',
          depTime: new Date(currentDeparture)
        });

        fullRoutePoints.push([nA.lat, nA.lon]);
        totalDist += d;
        totalDurationHrs += legDur;
        currentDeparture = new Date(currentDeparture.getTime() + legDur * 3600 * 1000);
      }

      fullRoutePoints.push(p2);
    }
  } catch (err) {
    console.error('Route optimization failed', err);
    showToast('Fehler bei der Routenberechnung. Bitte erneut versuchen.', 'rose');
    return;
  }

  if (fullRoutePoints.length < 2) {
    showToast('Keine navigierbare Route gefunden.', 'rose');
    return;
  }

  state.calculatedRouteData = {
    routePoints: fullRoutePoints,
    legs: fullLegs,
    totalDistance: +totalDist.toFixed(1),
    totalHours: +totalDurationHrs.toFixed(2),
    departureTime: new Date(passageStartTime),
    arrivalTime: currentDeparture,
    isochroneWavefronts: combinedWavefronts,
    allRays: combinedRays
  };

  drawIsochroneVisualsOnMap(state.calculatedRouteData);
  renderRouteResults(state.calculatedRouteData);

  showToast(`Route optimiert: ${fullLegs.length} Abschnitte, ETA ${state.calculatedRouteData.arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'emerald');
  switchTab('resultsTab');
}
