// Geodesic math helpers (equirectangular approximation, adequate for coastal passages).

const EARTH_RADIUS_NM = 3440.065;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function calculateDistanceNm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return +(EARTH_RADIUS_NM * c).toFixed(2);
}

export function calculateBearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD);
  const x = Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD) -
            Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos((lon2 - lon1) * DEG_TO_RAD);
  const brng = Math.atan2(y, x) * RAD_TO_DEG;
  return (brng + 360) % 360;
}

export function projectPosition(lat, lon, bearingDeg, distNm) {
  const rad = bearingDeg * DEG_TO_RAD;
  const dLat = (distNm * Math.cos(rad)) / 60;
  const midLat = lat + dLat / 2;
  const cosM = Math.cos(midLat * DEG_TO_RAD);
  const dLon = (distNm * Math.sin(rad)) / (60 * (cosM || 1));
  return [+(lat + dLat).toFixed(5), +(lon + dLon).toFixed(5)];
}

export function pointInPolygon(point, polygonCoords) {
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = polygonCoords.length - 1; i < polygonCoords.length; j = i++) {
    const xi = polygonCoords[i][0], yi = polygonCoords[i][1];
    const xj = polygonCoords[j][0], yj = polygonCoords[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function segmentsIntersect(a, b, c, d) {
  const ccw = (p1, p2, p3) => (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
  return (ccw(a, c, d) !== ccw(b, c, d)) && (ccw(a, b, c) !== ccw(a, b, d));
}

export function isSegmentNavigable(p1, p2, zones) {
  if (!zones || zones.length === 0) return true;
  for (const zone of zones) {
    const poly = zone.points;
    if (!poly || poly.length < 3) continue;
    if (pointInPolygon(p1, poly) || pointInPolygon(p2, poly)) return false;
    for (let i = 0; i < poly.length; i++) {
      const v1 = poly[i];
      const v2 = poly[(i + 1) % poly.length];
      if (segmentsIntersect(p1, p2, v1, v2)) return false;
    }
  }
  return true;
}
