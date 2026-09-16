import { state } from './state.js';
import { calculateDistanceNm, calculateBearingDeg } from './geo.js';
import { solveIsochronePassage } from './routing.js';
import { clearIsochroneLayers, drawIsochroneVisualsOnMap } from './mapLayers.js';
import { renderRouteResults } from './results.js';
import { showToast, toggleSidebar, switchTab } from './ui.js';

export function readOptimizerConfig() {
  return {
    dtMinutes: parseInt(document.getElementById('stepTimeSlider').value, 10) || 20,
    fanWidthDeg: parseInt(document.getElementById('fanWidthSlider').value, 10) || 55,
    numRaysPerNode: parseInt(document.getElementById('raysPerNodeSlider').value, 10) || 11,
    numSectors: parseInt(document.getElementById('sectorBinsSlider').value, 10) || 24,
    strategy: document.getElementById('routingStrategy').value
  };
}

export function getDepartureTimeFromInput() {
  const depInput = document.getElementById('departureTime').value;
  return depInput ? new Date(depInput) : new Date();
}

/**
 * Chains isochrone solves across every waypoint leg for one departure time.
 * Pure computation — no map/DOM side effects — so it can be reused both for
 * the live "optimize" action and for evaluating alternative departure times.
 * Returns null if no navigable route could be built.
 */
export async function computeFullRoute(waypoints, departureTime, config, avoidZones, onWarning) {
  const fullRoutePoints = [];
  const fullLegs = [];
  let currentDeparture = new Date(departureTime);
  let totalDist = 0;
  let totalDurationHrs = 0;
  const combinedWavefronts = [];
  const combinedRays = [];

  for (let w = 0; w < waypoints.length - 1; w++) {
    const p1 = [waypoints[w].lat, waypoints[w].lng];
    const p2 = [waypoints[w + 1].lat, waypoints[w + 1].lng];

    const sol = await solveIsochronePassage(p1, p2, currentDeparture, config, avoidZones);
    if (!sol || !sol.pathNodes || sol.pathNodes.length < 2) {
      onWarning?.(`Kein sicherer Weg zwischen WP${w} und WP${w + 1}`);
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

  if (fullRoutePoints.length < 2) return null;

  return {
    routePoints: fullRoutePoints,
    legs: fullLegs,
    totalDistance: +totalDist.toFixed(1),
    totalHours: +totalDurationHrs.toFixed(2),
    departureTime: new Date(departureTime),
    arrivalTime: currentDeparture,
    isochroneWavefronts: combinedWavefronts,
    allRays: combinedRays
  };
}

// Applies an already-computed route to the map and results panel — shared by
// the live optimize action and by "apply this candidate" in the departure
// time window comparison.
export function applyRouteResult(result) {
  state.calculatedRouteData = result;
  drawIsochroneVisualsOnMap(result);
  renderRouteResults(result);
}

export async function triggerIsochroneRouteOptimization() {
  if (state.waypoints.length < 2) {
    showToast('Bitte mindestens Start und Ziel setzen.', 'amber');
    toggleSidebar(true);
    return;
  }

  showToast('Berechne saubere Isochronen-Front...', 'sky');

  const passageStartTime = getDepartureTimeFromInput();
  const config = readOptimizerConfig();

  clearIsochroneLayers();

  let result;
  try {
    result = await computeFullRoute(state.waypoints, passageStartTime, config, state.avoidZones, (msg) => showToast(msg, 'rose'));
  } catch (err) {
    console.error('Route optimization failed', err);
    showToast('Fehler bei der Routenberechnung. Bitte erneut versuchen.', 'rose');
    return;
  }

  if (!result) {
    showToast('Keine navigierbare Route gefunden.', 'rose');
    return;
  }

  applyRouteResult(result);

  showToast(`Route optimiert: ${result.legs.length} Abschnitte, ETA ${result.arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'emerald');
  switchTab('resultsTab');
}
