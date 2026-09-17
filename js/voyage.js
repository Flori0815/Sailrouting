import { state } from './state.js';
import { updateHudDisplay } from './results.js';
import { setFieldTime } from './particleField.js';

// Finds the largest index i such that times[i] <= target, clamped to
// [0, times.length - 2] so callers can always safely read times[i + 1].
function findSegmentIndex(times, target) {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= target) lo = mid; else hi = mid - 1;
  }
  return Math.min(lo, times.length - 2);
}

// Caches the per-point/per-leg elapsed-time lookup tables for the active
// route so repeated scrub/playback ticks (up to ~60/s) don't rebuild them.
let cachedRouteData = null;
let cachedPointTimes = null;
let cachedLegBoundaries = null;

function ensureTimeCache(data) {
  if (cachedRouteData === data) return;
  cachedRouteData = data;
  cachedPointTimes = data.routePointTimes;
  cachedLegBoundaries = [...data.legs.map(l => l.elapsedStart), data.totalHours];
}

export function initVoyageScrubber() {
  const slider = document.getElementById('voyageScrubber');
  const timeLabel = document.getElementById('simTimeLabel');
  const progressLabel = document.getElementById('simProgressPct');
  const playBtn = document.getElementById('btnPlayVoyage');

  const applyScrub = (pct) => {
    const data = state.calculatedRouteData;
    if (!data || !data.legs.length) return;
    ensureTimeCache(data);

    // Interpolate by real elapsed sailing time, not by point index: a
    // multi-waypoint route has an extra "arrived at waypoint" point at
    // every interior waypoint (zero distance, zero duration), so equal
    // steps in point index do NOT correspond to equal steps in time —
    // that mismatch is what made the boat appear to stall at waypoints.
    const targetHours = (pct / 100) * data.totalHours;

    const ptIdx = findSegmentIndex(cachedPointTimes, targetHours);
    const segStart = cachedPointTimes[ptIdx];
    const segEnd = cachedPointTimes[ptIdx + 1];
    const subFrac = Math.min(1, Math.max(0, (targetHours - segStart) / Math.max(1e-9, segEnd - segStart)));

    const pts = data.routePoints;
    const p1 = pts[ptIdx];
    const p2 = pts[ptIdx + 1];
    const curLat = p1[0] + (p2[0] - p1[0]) * subFrac;
    const curLng = p1[1] + (p2[1] - p1[1]) * subFrac;

    if (state.boatMarker) {
      state.boatMarker.setLatLng([curLat, curLng]);
      const legIdx = Math.min(findSegmentIndex(cachedLegBoundaries, targetHours), data.legs.length - 1);
      const currentLeg = data.legs[legIdx];
      const boatDiv = document.getElementById('boatIconDiv');
      if (boatDiv) {
        boatDiv.style.transform = `rotate(${currentLeg.heading}deg)`;
      }
      updateHudDisplay(currentLeg);
    }

    // Keep the animated wind/current field in sync with where the boat is
    // in the voyage timeline, instead of it always showing live "now"
    // conditions regardless of how far the scrubber has been moved.
    const scrubTime = new Date(data.departureTime.getTime() + targetHours * 3600 * 1000);
    setFieldTime(scrubTime);

    const elH = Math.floor(targetHours);
    const elM = Math.round((targetHours - elH) * 60);

    timeLabel.textContent = `+${elH}h ${elM}m (${pct.toFixed(0)}%)`;
    progressLabel.textContent = `${pct.toFixed(0)}% absolviert`;
  };

  slider.addEventListener('input', (e) => applyScrub(parseFloat(e.target.value)));

  playBtn.addEventListener('click', () => {
    state.isPlaying = !state.isPlaying;
    playBtn.innerHTML = state.isPlaying ? '<i data-lucide="pause" class="w-3.5 h-3.5"></i>' : '<i data-lucide="play" class="w-3.5 h-3.5"></i>';
    window.lucide?.createIcons();

    if (state.isPlaying) {
      state.playInterval = setInterval(() => {
        let val = parseFloat(slider.value) + 0.8;
        if (val >= 100) {
          val = 0;
          state.isPlaying = false;
          clearInterval(state.playInterval);
          playBtn.innerHTML = '<i data-lucide="play" class="w-3.5 h-3.5"></i>';
          window.lucide?.createIcons();
        }
        slider.value = val;
        applyScrub(val);
      }, 60);
    } else {
      clearInterval(state.playInterval);
    }
  });
}
