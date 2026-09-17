import { state } from './state.js';
import { getRealTidePhase, peekTidePhase, warmTideCache } from './bshTides.js';

// German Bight / Wadden Sea tidal current modeling, in two layers:
//
// 1. MAGNITUDE correction (`applyTidalAmplification`): Open-Meteo's ocean
//    current (js/metocean.js) comes from a ~9km global ocean model that
//    does carry a tidal contribution (FES2014 merged into the underlying
//    CMEMS product) but smears strong tidal-flat/channel currents together
//    with the near-still water over adjacent sandbanks. Within the German
//    Bight/Wadden Sea this scales the reported current speed up toward a
//    modeled tidal-stream peak — grounded in that known resolution
//    limitation, not a fabricated signal.
// 2. PHASE indicator (`getTidalPhaseEstimateAsync`): tries BSH's real,
//    official Water Level Forecast API first (js/bshTides.js — a
//    documented OGC API Features service, CC BY 4.0), which gives genuine
//    high/low-water timing for actual gauge stations and anchors the
//    flood/ebb/slack shape to real local tide timing rather than a generic
//    lunar phase. Falls back to a self-contained M2 (principal lunar
//    semidiurnal, 12.4206h) + spring/neap (synodic-month beat) harmonic
//    estimate — computed from lunar-cycle astronomy alone, no network
//    needed — whenever the real API is unreachable, times out, or doesn't
//    cover the requested place/time. Neither path invents a flood/ebb
//    current DIRECTION: without real current-vector data (BSH's tidal
//    current atlas gives current, not water level, and isn't wired in as
//    numeric data — see README), a guessed axis could be confidently
//    wrong, whereas Open-Meteo's own current direction, even coarse, is at
//    least real model output. `state.tidalPhaseOffsetHours` still lets a
//    sailor nudge the *fallback* astronomical clock against a known local
//    high-water time; it has no effect once real BSH data is in use.

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

// Astronomical fallback — no network, always available, but generic (not
// anchored to any real station's actual tide timing). See
// getTidalPhaseEstimateAsync for the real-data path this backs up.
export function getTidalPhaseEstimateHeuristic(date = new Date()) {
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
    springNeapLabel: springNeapFactor > 0.75 ? 'Springtide' : springNeapFactor < 0.55 ? 'Nipptide' : 'mittlere Tide',
    source: 'Astronomische Näherung (M2)'
  };
}

// Tries BSH's real water-level forecast first (see js/bshTides.js), falling
// back to the astronomical estimate on any failure or lack of coverage.
// Always resolves — never throws — so callers never need their own
// try/catch around this.
export async function getTidalPhaseEstimateAsync(lat, lon, date = new Date()) {
  try {
    const real = await getRealTidePhase(lat, lon, date);
    if (real) return real;
  } catch (err) {
    // Network/CORS/shape failure — fall through to the heuristic below.
  }
  return getTidalPhaseEstimateHeuristic(date);
}

// Scales a coarse ocean-model current speed up toward a modeled tidal-
// stream peak within the German Bight, fading back to 1x (never below the
// model's own value) toward slack water. Direction is left untouched.
//
// Deliberately synchronous and network-free: this runs inside
// metocean.js#fetchMetoceanData, on the isochrone solver's hot path
// (called on every search step). Awaiting a live BSH fetch here would
// stack its latency on top of Open-Meteo's own, potentially stalling route
// computation whenever BSH is slow or unreachable — for a refinement that
// only nudges a multiplier, that's a bad trade. Instead this reads
// whatever's already cached (peekTidePhase, instant, never blocks) and
// separately fires a non-blocking cache warm-up so real data becomes
// available for *future* calls without ever costing this one anything.
export function applyTidalAmplification(lat, lon, curSpeedKn, date = new Date()) {
  if (!state.tidalHeuristicEnabled) return curSpeedKn;
  if (!isWithinTidalHeuristicRegion(lat, lon)) return curSpeedKn;

  const real = peekTidePhase(lat, lon, date);
  const { strength, springNeapFactor } = real || (warmTideCache(lat, lon), getTidalPhaseEstimateHeuristic(date));
  const amplitude = state.tidalAmplificationFactor ?? 1.6;
  const factor = 1 + (amplitude - 1) * strength * springNeapFactor;
  return +(curSpeedKn * factor).toFixed(2);
}
