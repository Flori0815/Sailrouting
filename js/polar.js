import { POLAR_TWS, POLAR_TWA, DEHLER37_POLAR, NO_GO_ANGLE_DEG } from './constants.js';

// Bilinear interpolation over the Dehler 37 CR polar performance matrix.
// Returns boat speed through water (STW, in knots) for a given true wind angle and speed.
export function getDehlerBoatSpeed(twa, tws) {
  const angle = Math.min(180, Math.max(0, Math.abs(twa)));
  const wind = Math.max(0, tws);

  if (angle < NO_GO_ANGLE_DEG) return 0.2;
  if (wind < 3) return 0.5;

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
