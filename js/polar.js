import { POLAR_TWS, POLAR_TWA, DEHLER37_POLAR, NO_GO_ANGLE_DEG } from './constants.js';

// Leeway coefficient for the standard small-craft rule-of-thumb estimate
// leeway ≈ K × TWS / STW², tuned so a typical close-hauled case (15kn
// wind, ~6kn boat speed) lands around 4-6°, in line with published
// cruising-monohull leeway figures.
const LEEWAY_COEFFICIENT = 15;
const MAX_LEEWAY_DEG = 12;
// Leeway (heeling-driven sideways slip) matters close-hauled/reaching and
// is negligible once the sail force is mostly driving the boat forward
// rather than pressing it sideways — tapers to zero by this TWA.
const LEEWAY_TAPER_TWA = 100;

// Estimates leeway — the sideways slip of the hull through the water
// caused by wind pressure on the sails, distinct from current set/drift.
// Returns a positive angle in degrees; the caller applies it toward the
// leeward side of the boat's steered heading.
export function getLeewayAngle(twa, tws, stw) {
  const angle = Math.min(180, Math.max(0, Math.abs(twa)));
  if (angle >= LEEWAY_TAPER_TWA || stw <= 0) return 0;

  const raw = (LEEWAY_COEFFICIENT * Math.max(0, tws)) / (stw * stw);
  const pointOfSailFactor = 1 - angle / LEEWAY_TAPER_TWA;
  return +Math.min(MAX_LEEWAY_DEG, raw * pointOfSailFactor).toFixed(1);
}

// Bilinear interpolation over the Dehler 37 CR polar performance matrix.
// Returns boat speed through water (STW, in knots) for a given true wind angle and speed.
export function getDehlerBoatSpeed(twa, tws) {
  const angle = Math.min(180, Math.max(0, Math.abs(twa)));
  const wind = Math.max(0, tws);

  if (angle < NO_GO_ANGLE_DEG) return 0.2;
  if (wind < 3) return 0.5;

  // Below the table's lowest tabulated wind speed: ramp linearly from the
  // near-calm floor up to the 6kn-column performance, rather than falling
  // through to the bracket search below with no matching bracket (both
  // indices would resolve to entry 0, dividing by zero and producing NaN).
  if (wind < POLAR_TWS[0]) {
    const speedAtMin = getDehlerBoatSpeed(twa, POLAR_TWS[0]);
    const factor = (wind - 3) / (POLAR_TWS[0] - 3);
    return +(0.5 + factor * (speedAtMin - 0.5)).toFixed(2);
  }

  let s0 = 0, s1 = 0;
  for (let i = 0; i < POLAR_TWS.length - 1; i++) {
    if (wind >= POLAR_TWS[i] && wind <= POLAR_TWS[i + 1]) {
      s0 = i; s1 = i + 1; break;
    }
  }
  if (wind > POLAR_TWS[POLAR_TWS.length - 1]) {
    s0 = POLAR_TWS.length - 2; s1 = POLAR_TWS.length - 1;
  }

  if (angle <= POLAR_TWA[0]) {
    const factor = Math.max(0, (angle - 32) / (POLAR_TWA[0] - 32));
    const speedAt35 = DEHLER37_POLAR[0][s0] + (wind - POLAR_TWS[s0]) / (POLAR_TWS[s1] - POLAR_TWS[s0]) * (DEHLER37_POLAR[0][s1] - DEHLER37_POLAR[0][s0]);
    return +(speedAt35 * factor).toFixed(2);
  }

  let a0 = 0, a1 = 0;
  for (let j = 0; j < POLAR_TWA.length - 1; j++) {
    if (angle >= POLAR_TWA[j] && angle <= POLAR_TWA[j + 1]) {
      a0 = j; a1 = j + 1; break;
    }
  }
  if (angle >= POLAR_TWA[POLAR_TWA.length - 1]) {
    a0 = POLAR_TWA.length - 2; a1 = POLAR_TWA.length - 1;
  }

  const q11 = DEHLER37_POLAR[a0][s0], q12 = DEHLER37_POLAR[a0][s1];
  const q21 = DEHLER37_POLAR[a1][s0], q22 = DEHLER37_POLAR[a1][s1];
  const tSpeed = (wind - POLAR_TWS[s0]) / (POLAR_TWS[s1] - POLAR_TWS[s0]);
  const tAngle = (angle - POLAR_TWA[a0]) / (POLAR_TWA[a1] - POLAR_TWA[a0]);

  const r1 = q11 + tSpeed * (q12 - q11);
  const r2 = q21 + tSpeed * (q22 - q21);
  const result = r1 + tAngle * (r2 - r1);
  return +Math.max(0.2, result).toFixed(2);
}
