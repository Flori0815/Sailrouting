import { state } from './state.js';

// Coarse, dependency-free approximation of German Bight / Wadden Sea tidal
// current behavior — a stopgap pending a real BSH Gezeitenstromatlas
// integration (that requires downloading and preprocessing BSH's GIS
// dataset from gdi.bsh.de, which this project's dev sandbox cannot reach;
// see README). Two deliberately separate roles:
//
// 1. MAGNITUDE correction (`applyTidalAmplification`): Open-Meteo's ocean
//    current (js/metocean.js) comes from a ~9km global ocean model that
//    does carry a tidal contribution (FES2014 merged into the underlying
//    CMEMS product) but smears strong tidal-flat/channel currents together
//    with the near-still water over adjacent sandbanks. Within the German
//    Bight/Wadden Sea this scales the reported current speed up toward a
//    modeled tidal-stream peak — grounded in that known resolution
//    limitation, not a fabricated signal.
// 2. PHASE indicator (`getTidalPhaseEstimate`): a self-contained M2
//    (principal lunar semidiurnal, 12.4206h) + spring/neap (synodic-month
//    beat) harmonic estimate, computed from lunar-cycle astronomy alone —
//    no live tide data or network call. Deliberately does NOT invent a
//    flood/ebb current DIRECTION: without real bathymetry/atlas data, a
//    guessed tidal axis could be confidently wrong, whereas Open-Meteo's
//    own current direction, even coarse, is at least real model output.
//    The phase estimate only drives a "Flut/Ebbe/Stillstand" + spring/neap
//    badge for the sailor to cross-check against a real regional tide
//    table — `state.tidalPhaseOffsetHours` lets them calibrate the M2
//    clock against a known local high-water time.

// Roughly the German Bight / Wadden Sea / Elbe-Weser estuary — the region
// where tidal streams dominate and where Open-Meteo's ~9km ocean grid most
// clearly underestimates real channel current strength.
const REGION_BOUNDS = { latMin: 53.3, latMax: 55.5, lonMin: 6.3, lonMax: 9.6 };

const M2_PERIOD_HOURS = 12.4206012;
const SYNODIC_MONTH_DAYS = 29.530588853;
// A well-documented reference new moon (2000-01-06 18:14 UTC). Only its
// periodicity matters here, not this exact instant — what a sailor actually
// calibrates against a real tide table is the phase-offset slider.
const REF_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14, 0);
const NEAP_FLOOR = 0.35;

export function isWithinTidalHeuristicRegion(lat, lon) {
  return lat >= REGION_BOUNDS.latMin && lat <= REGION_BOUNDS.latMax &&
         lon >= REGION_BOUNDS.lonMin && lon <= REGION_BOUNDS.lonMax;
}

export function getTidalPhaseEstimate(date = new Date()) {
  const offsetHours = state.tidalPhaseOffsetHours || 0;
  const hoursSinceEpoch = (date.getTime() - REF_NEW_MOON_MS) / 3600000 + offsetHours;
  const phaseFraction = (((hoursSinceEpoch % M2_PERIOD_HOURS) + M2_PERIOD_HOURS) % M2_PERIOD_HOURS) / M2_PERIOD_HOURS;
  const sinPhase = Math.sin(2 * Math.PI * phaseFraction);

  const daysSinceEpoch = (date.getTime() - REF_NEW_MOON_MS) / 86400000;
  const moonAgeFraction = (((daysSinceEpoch % SYNODIC_MONTH_DAYS) + SYNODIC_MONTH_DAYS) % SYNODIC_MONTH_DAYS) / SYNODIC_MONTH_DAYS;
  // Springs at new & full moon (moonAgeFraction 0 and 0.5), neaps at the
  // quarters (0.25 and 0.75): cos(4π·moonAgeFraction) peaks at both.
  const springNeapFactor = NEAP_FLOOR + (1 - NEAP_FLOOR) * (0.5 + 0.5 * Math.cos(4 * Math.PI * moonAgeFraction));

  const strength = Math.abs(sinPhase); // 0 at slack, 1 at modeled mid-flood/ebb
  let stateLabel = 'Stillstand';
  if (strength > 0.15) stateLabel = sinPhase >= 0 ? 'Flut (zunehmend)' : 'Ebbe (abnehmend)';

  return {
    strength,
    springNeapFactor,
    isFlood: sinPhase >= 0,
    stateLabel,
    springNeapLabel: springNeapFactor > 0.75 ? 'Springtide' : springNeapFactor < 0.55 ? 'Nipptide' : 'mittlere Tide'
  };
}

// Scales a coarse ocean-model current speed up toward a modeled tidal-
// stream peak within the German Bight, fading back to 1x (never below the
// model's own value) toward slack water. Direction is left untouched.
export function applyTidalAmplification(lat, lon, curSpeedKn, date = new Date()) {
  if (!state.tidalHeuristicEnabled) return curSpeedKn;
  if (!isWithinTidalHeuristicRegion(lat, lon)) return curSpeedKn;

  const { strength, springNeapFactor } = getTidalPhaseEstimate(date);
  const amplitude = state.tidalAmplificationFactor ?? 1.6;
  const factor = 1 + (amplitude - 1) * strength * springNeapFactor;
  return +(curSpeedKn * factor).toFixed(2);
}
