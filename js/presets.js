import { state } from './state.js';
import { PRESETS } from './constants.js';
import { addWaypoint, clearAllWaypoints } from './waypoints.js';
import { addAvoidZone, clearAllAvoidZones } from './zones.js';
import { showToast } from './ui.js';

export function loadPreset(presetKey) {
  const preset = PRESETS[presetKey];
  if (!preset) return;

  clearAllWaypoints();
  clearAllAvoidZones();

  state.map.setView(preset.view.center, preset.view.zoom);
  preset.waypoints.forEach(wp => addWaypoint(wp.lat, wp.lng, wp.name));
  preset.avoidZones.forEach(zone => addAvoidZone(zone.name, zone.points));

  showToast(`Preset ${presetKey.toUpperCase()} geladen`, 'emerald');
}
