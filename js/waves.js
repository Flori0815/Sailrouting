// Wave-resistance model: reduces boat speed by wave height and by the
// wave's angle relative to the boat's heading — head seas (waves hitting
// the bow) slow the boat more than following seas (waves from astern) —
// scaled by a user-configurable sensitivity setting (0-100%).

// Wave height at which the full configured penalty applies. Above this,
// the height component of the penalty is capped (it does not keep
// compounding for ever-larger seas).
const REFERENCE_WAVE_HEIGHT_M = 2.5;

// Speed is never reduced below this fraction of polar performance, so the
// search can't degrade into near-zero speeds everywhere in heavy seas.
const MIN_SPEED_FACTOR = 0.4;

// Directional weight range: 1.0 for waves dead ahead, this floor for waves
// dead astern (following seas still cause some drag/broaching risk, just
// markedly less than punching into head seas).
const FOLLOWING_SEA_WEIGHT_FLOOR = 0.25;

export function getWaveSpeedFactor(waveHeightM, waveDirDeg, headingDeg, sensitivityPct) {
  const sensitivity = Math.max(0, Math.min(100, sensitivityPct ?? 0)) / 100;
  if (sensitivity <= 0 || !waveHeightM) return 1;

  // 0 = head seas (waves from dead ahead), 180 = following seas (waves from dead astern)
  const relAngle = Math.abs(((waveDirDeg - headingDeg + 540) % 360) - 180);
  const directionalWeight = FOLLOWING_SEA_WEIGHT_FLOOR + (1 - FOLLOWING_SEA_WEIGHT_FLOOR) * (1 - relAngle / 180);

  const heightPenalty = Math.min(1, waveHeightM / REFERENCE_WAVE_HEIGHT_M);

  const factor = 1 - sensitivity * heightPenalty * directionalWeight;
  return Math.max(MIN_SPEED_FACTOR, factor);
}
