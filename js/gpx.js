import { state } from './state.js';
import { showToast } from './ui.js';

export function exportGpxFile() {
  if (!state.calculatedRouteData || !state.calculatedRouteData.routePoints) {
    showToast('Zuerst Route berechnen.', 'amber');
    return;
  }

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Dehler 37 CR Weather Router" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Dehler 37 CR Isochrone Route</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <rte>
    <name>Optimierte Route</name>
`;
  state.calculatedRouteData.routePoints.forEach((pt, i) => {
    gpx += `    <rtept lat="${pt[0]}" lon="${pt[1]}"><name>WP${i}</name></rtept>\n`;
  });
  gpx += `  </rte>
</gpx>`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Dehler37_Route_${new Date().toISOString().slice(0, 10)}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('GPX-Datei heruntergeladen!', 'emerald');
}
