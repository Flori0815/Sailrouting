import { state } from './state.js';
import { updateHudDisplay } from './results.js';

export function initVoyageScrubber() {
  const slider = document.getElementById('voyageScrubber');
  const timeLabel = document.getElementById('simTimeLabel');
  const progressLabel = document.getElementById('simProgressPct');
  const playBtn = document.getElementById('btnPlayVoyage');

  const applyScrub = (pct) => {
    if (!state.calculatedRouteData || !state.calculatedRouteData.legs.length) return;
    const pts = state.calculatedRouteData.routePoints;
    const totalLegs = pts.length - 1;
    const exactIdx = (pct / 100) * totalLegs;
    const legIdx = Math.min(Math.floor(exactIdx), totalLegs - 1);
    const subFrac = exactIdx - legIdx;

    const p1 = pts[legIdx];
    const p2 = pts[legIdx + 1];

    const curLat = p1[0] + (p2[0] - p1[0]) * subFrac;
    const curLng = p1[1] + (p2[1] - p1[1]) * subFrac;

    if (state.boatMarker) {
      state.boatMarker.setLatLng([curLat, curLng]);
      const currentLeg = state.calculatedRouteData.legs[legIdx];
      const boatDiv = document.getElementById('boatIconDiv');
      if (boatDiv) {
        boatDiv.style.transform = `rotate(${currentLeg.heading}deg)`;
      }
      updateHudDisplay(currentLeg);
    }

    const totalHrs = state.calculatedRouteData.totalHours;
    const currentElapsedHrs = (pct / 100) * totalHrs;
    const elH = Math.floor(currentElapsedHrs);
    const elM = Math.round((currentElapsedHrs - elH) * 60);

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
