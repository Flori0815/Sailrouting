import { calculateDistanceNm, calculateBearingDeg, projectPosition, isSegmentNavigable } from './geo.js';
import { getDehlerBoatSpeed, getLeewayAngle } from './polar.js';
import { fetchMetoceanData } from './metocean.js';
import { getWaveSpeedFactor } from './waves.js';
import { NO_GO_ANGLE_DEG } from './constants.js';

// Upper bound on isochrone steps regardless of settings. Sized generously
// so a fine time step on a long leg doesn't get silently truncated before
// reaching the goal — the loop still exits as soon as it arrives.
const MAX_ISOCHRONE_STEPS = 220;

// Finds the reference path entry (from a previous refinement pass) whose
// timeHours is closest to (and not after) the given time, so a later pass
// can bias its search fan toward where the earlier pass actually sailed.
function lookupReferenceHeading(referencePath, timeHours) {
  if (!referencePath || referencePath.length === 0) return null;
  let lo = 0, hi = referencePath.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (referencePath[mid].timeHours <= timeHours) lo = mid; else hi = mid - 1;
  }
  return referencePath[lo].heading;
}

// Wind pressure on the sails pushes the hull sideways, so the boat's
// actual through-water track differs from its steered compass heading by
// the leeway angle, toward whichever side is downwind of the bow.
function applyLeeway(heading, twd, leewayDeg) {
  if (leewayDeg <= 0) return heading;
  const relBearing = ((twd - heading + 540) % 360) - 180; // (-180, 180]: where the wind source sits relative to the bow
  const sign = relBearing > 0 ? -1 : 1; // wind from starboard -> pushed to port, and vice versa
  return (heading + sign * leewayDeg + 360) % 360;
}

// Isochrone (wavefront) passage solver with loop-free spatial dominance:
// a 2D grid rejects any candidate that revisits a nautical cell already
// reached at an earlier or equal simulated time, which prevents the
// search from folding back on itself.
//
// `referencePath` (optional) is a previous pass's pathNodes reduced to
// {timeHours, heading} — when supplied, the reaching/running fan is
// centered toward the heading the previous pass actually sailed at the
// corresponding time instead of purely the live direct-to-goal bearing,
// letting a follow-up pass refine the wavefronts around an
// already-reasonable solution rather than resampling from scratch.
export async function solveIsochronePassage(fromCoord, toCoord, startTime, config, avoidZones, referencePath = null) {
  const legDist = calculateDistanceNm(fromCoord[0], fromCoord[1], toCoord[0], toCoord[1]);
  const dtHours = config.dtMinutes / 60;
  const legBearing = calculateBearingDeg(fromCoord[0], fromCoord[1], toCoord[0], toCoord[1]);
  const maxSteps = Math.min(MAX_ISOCHRONE_STEPS, Math.ceil((legDist / 3.5) / dtHours) + 12);

  const initialMet = await fetchMetoceanData(fromCoord[0], fromCoord[1], startTime);

  let frontier = [{
    id: 0,
    lat: fromCoord[0],
    lon: fromCoord[1],
    timeHours: 0,
    parent: null,
    stw: 0,
    sog: 0,
    heading: Math.round(legBearing),
    cog: Math.round(legBearing),
    tws: initialMet.tws,
    twd: initialMet.twd,
    twa: 90,
    curSpeed: initialMet.curSpeed,
    curDir: initialMet.curDir,
    waveHeight: initialMet.waveHeight,
    waveDir: initialMet.waveDir,
    leewayDeg: 0,
    distToGoal: legDist,
    stepIndex: 0
  }];

  // Cell size: ~0.8 nm
  const spatialGrid = new Map();
  function getCellKey(lat, lon) {
    const kLat = Math.floor(lat * 75);
    const kLon = Math.floor(lon * (75 * Math.cos(lat * Math.PI / 180)));
    return `${kLat}_${kLon}`;
  }
  // Deliberately not seeding the origin's own cell here. With a fine time
  // step (down to 2 min) a boat's first hop can easily be shorter than one
  // ~0.8nm cell, landing back inside the start's cell — a perfectly normal
  // small forward step, not a loop. Seeding it at time 0 would reject every
  // such candidate (the stored value 0 is always <= any positive arrival
  // time + 0.05), stalling the whole search on step one. The strict
  // forward-progression check below already rejects genuine backtracking
  // to the origin.

  const sampledRays = [];
  const cleanWavefronts = [];
  let arrivalNode = null;
  let nodeIdCounter = 1;

  for (let step = 0; step < maxSteps; step++) {
    const currentTime = new Date(startTime.getTime() + (step + 1) * dtHours * 3600 * 1000);
    const currentCandidates = [];

    const avgLat = frontier.reduce((acc, n) => acc + n.lat, 0) / frontier.length;
    const avgLon = frontier.reduce((acc, n) => acc + n.lon, 0) / frontier.length;
    const met = await fetchMetoceanData(avgLat, avgLon, currentTime);

    for (const node of frontier) {
      const directBearing = calculateBearingDeg(node.lat, node.lon, toCoord[0], toCoord[1]);
      const currentDistToGoal = node.distToGoal;

      if (currentDistToGoal <= Math.max(0.6, 3.8 * dtHours)) {
        arrivalNode = node;
        break;
      }

      let twaDirect = Math.abs(met.twd - directBearing) % 360;
      if (twaDirect > 180) twaDirect = 360 - twaDirect;

      const candidateHeadings = [];
      const halfFan = config.fanWidthDeg;

      if (twaDirect < 38) {
        // Close-hauled: explore port and starboard tack at optimal VMG (42°)
        const stbdTack = (met.twd - 42 + 360) % 360;
        const portTack = (met.twd + 42) % 360;
        candidateHeadings.push(stbdTack, portTack);
        candidateHeadings.push((stbdTack - 8 + 360) % 360, (stbdTack + 8) % 360);
        candidateHeadings.push((portTack - 8 + 360) % 360, (portTack + 8) % 360);
      } else {
        // Reaching / running: fan out around the direct bearing, biased
        // toward a previous pass's actual heading at this point in time
        // when one is available (see solveIsochronePassageRefined).
        let fanCenter = directBearing;
        const refHeading = lookupReferenceHeading(referencePath, node.timeHours);
        if (refHeading !== null) {
          const diff = ((refHeading - directBearing + 540) % 360) - 180;
          if (Math.abs(diff) < 90) {
            fanCenter = (directBearing + diff * 0.7 + 360) % 360;
          }
        }

        const stepDeg = (halfFan * 2) / Math.max(1, config.numRaysPerNode - 1);
        for (let r = 0; r < config.numRaysPerNode; r++) {
          const hdg = Math.round((fanCenter - halfFan + r * stepDeg + 360) % 360);
          candidateHeadings.push(hdg);
        }
      }

      for (const heading of candidateHeadings) {
        let twa = Math.abs(met.twd - heading) % 360;
        if (twa > 180) twa = 360 - twa;
        if (twa < NO_GO_ANGLE_DEG) continue;

        const waveFactor = getWaveSpeedFactor(met.waveHeight, met.waveDir, heading, config.waveSensitivity);
        const stw = +(getDehlerBoatSpeed(twa, met.tws) * waveFactor).toFixed(2);

        // Leeway: wind pressure on the sails slips the hull sideways, so
        // the track actually made through the water differs from the
        // steered heading — distinct from (and combined with) current set.
        const leewayDeg = getLeewayAngle(twa, met.tws, stw);
        const trackThroughWater = applyLeeway(heading, met.twd, leewayDeg);

        // Current triangle: V_ground = V_boat(through water) + V_current
        const hRad = trackThroughWater * Math.PI / 180;
        const cRad = met.curDir * Math.PI / 180;
        const vx = stw * Math.sin(hRad) + met.curSpeed * Math.sin(cRad);
        const vy = stw * Math.cos(hRad) + met.curSpeed * Math.cos(cRad);

        const sog = Math.hypot(vx, vy);
        if (sog <= 0.3) continue;

        const cog = (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360;
        const stepDistNm = sog * dtHours;

        const nextCoord = projectPosition(node.lat, node.lon, cog, stepDistNm);
        const nextDistToGoal = calculateDistanceNm(nextCoord[0], nextCoord[1], toCoord[0], toCoord[1]);

        // Strict forward progression: reject candidates that fall backwards
        // away from the goal. The allowed slack scales with this step's own
        // distance (a fixed 0.15nm was comparatively far tighter for a
        // large/fast step than a small/slow one) — without this, a larger
        // time step made legitimate close-hauled tacking geometry near the
        // goal (a tack that transiently increases straight-line distance
        // while still making real upwind progress, completely normal) fail
        // more often than the same geometry at a finer step, for no
        // physical reason, just tolerance-vs-stepsize mismatch.
        const progressionSlackNm = Math.max(0.15, 0.05 * stepDistNm);
        if (nextDistToGoal > currentDistToGoal + progressionSlackNm) continue;

        // Spatial grid dominance: reject already-visited coordinates
        const cellKey = getCellKey(nextCoord[0], nextCoord[1]);
        const arrivalTime = node.timeHours + dtHours;
        if (spatialGrid.has(cellKey) && spatialGrid.get(cellKey) <= arrivalTime + 0.05) continue;

        // Hazard and drying-shallows avoidance
        if (!isSegmentNavigable([node.lat, node.lon], nextCoord, avoidZones)) continue;

        spatialGrid.set(cellKey, arrivalTime);

        currentCandidates.push({
          id: nodeIdCounter++,
          lat: nextCoord[0],
          lon: nextCoord[1],
          timeHours: arrivalTime,
          parent: node,
          stw,
          sog: +sog.toFixed(2),
          heading,
          cog: Math.round(cog),
          tws: met.tws,
          twd: met.twd,
          twa: Math.round(twa),
          curSpeed: met.curSpeed,
          curDir: met.curDir,
          waveHeight: met.waveHeight,
          waveDir: met.waveDir,
          leewayDeg,
          distToGoal: nextDistToGoal,
          stepIndex: step + 1
        });
      }

      if (arrivalNode) break;
    }

    if (arrivalNode || currentCandidates.length === 0) break;

    const numSectors = config.numSectors;
    const bins = new Map();
    const halfFan = config.fanWidthDeg;

    for (const cand of currentCandidates) {
      const brngFromStart = calculateBearingDeg(fromCoord[0], fromCoord[1], cand.lat, cand.lon);
      const relAngle = (brngFromStart - legBearing + 540) % 360 - 180;

      if (Math.abs(relAngle) > halfFan + 15) continue;

      const sectorSpan = (halfFan * 2) / numSectors;
      const binIdx = Math.floor((relAngle + halfFan) / sectorSpan);

      let score = cand.distToGoal;
      if (config.strategy === 'comfort' && cand.twa < 44) {
        score *= 1.12;
      }

      // Keep only the node closest to goal within each angular sector bin
      if (!bins.has(binIdx) || score < bins.get(binIdx).score) {
        bins.set(binIdx, { candidate: cand, score });
      }
    }

    let newFrontier = Array.from(bins.values()).map(item => item.candidate);
    if (newFrontier.length === 0) {
      // Every candidate this step fell outside the sector-binning tolerance
      // window around the leg's original bearing — most often because
      // favorable wind/current genuinely pulled the search well off the
      // rhumb line for a while (correct isochrone behavior: sometimes a
      // longer path is faster), and the frontier's live position has
      // drifted far enough that its bearing-from-*start* now falls outside
      // a cone measured from the *original* bearing, even though the
      // search itself is still converging fine locally.
      //
      // This used to just stop advancing and keep the stale previous
      // frontier, which the post-loop fallback then accepted as "arrived"
      // — silently bridging the real (possibly huge) remaining gap with a
      // single straight-line "final connector" segment that ignores wind,
      // current, and hazards entirely. That produced exactly the "sails
      // way off, then snaps back in one bow" routes users were seeing:
      // confirmed via fuzzing — a 35nm leg with favorable-but-indirect
      // wind produced a 21nm/16h straight final segment this way (61% of
      // the leg length bridged as a straight line).
      //
      // Instead, keep going: fall back to the single best (closest to
      // goal) candidate from this step's full, unfiltered candidate set,
      // regardless of the original-bearing cone. This sacrifices some
      // wavefront breadth for one step (rebuilt again next step from
      // this new position) but keeps the search honestly stepping through
      // real wind/current/hazard checks all the way to the goal instead of
      // silently faking the rest of the route.
      const bestOverall = currentCandidates.reduce((min, c) => c.distToGoal < min.distToGoal ? c : min, currentCandidates[0]);
      newFrontier = [bestOverall];
    }
    frontier = newFrontier;

    frontier.forEach(n => {
      if (n.parent) {
        sampledRays.push([[n.parent.lat, n.parent.lon], [n.lat, n.lon]]);
      }
    });

    if (frontier.length >= 2) {
      const sortedFrontier = [...frontier].sort((a, b) => {
        const relA = (calculateBearingDeg(fromCoord[0], fromCoord[1], a.lat, a.lon) - legBearing + 540) % 360 - 180;
        const relB = (calculateBearingDeg(fromCoord[0], fromCoord[1], b.lat, b.lon) - legBearing + 540) % 360 - 180;
        return relA - relB;
      });

      // Break the wavefront into contiguous segments when points are too far apart
      // (prevents spurious lines spanning bays/headlands).
      let currentSegment = [];
      for (let i = 0; i < sortedFrontier.length; i++) {
        const pt = [sortedFrontier[i].lat, sortedFrontier[i].lon];
        if (currentSegment.length === 0) {
          currentSegment.push(pt);
        } else {
          const prev = currentSegment[currentSegment.length - 1];
          const distApart = calculateDistanceNm(prev[0], prev[1], pt[0], pt[1]);
          if (distApart < 4.0 * dtHours * 8.5) {
            currentSegment.push(pt);
          } else {
            if (currentSegment.length >= 2) cleanWavefronts.push(currentSegment);
            currentSegment = [pt];
          }
        }
      }
      if (currentSegment.length >= 2) cleanWavefronts.push(currentSegment);
    }

    const closest = frontier.reduce((min, n) => n.distToGoal < min.distToGoal ? n : min, frontier[0]);
    if (closest.distToGoal < Math.max(0.8, 3.8 * dtHours)) {
      arrivalNode = closest;
      break;
    }
  }

  if (!arrivalNode && frontier.length > 0) {
    // Only accept this as an arrival if the search actually advanced at
    // least one real step (every real candidate has a parent; the untouched
    // initial frontier's single placeholder node does not). Otherwise the
    // final-connector logic below would draw one straight line from start
    // directly to the target — ignoring wind, tacking, and hazards
    // entirely — and silently report that as a "successful" route. This is
    // exactly what a refinement pass's narrowed, reference-biased fan can
    // do when it fails to find any valid candidate on the very first step.
    const hasAdvanced = frontier.some(n => n.parent !== null);
    if (hasAdvanced) {
      arrivalNode = frontier.reduce((min, n) => n.distToGoal < min.distToGoal ? n : min, frontier[0]);
    }
  }

  if (!arrivalNode) return null;

  const pathNodes = [];
  let curr = arrivalNode;
  while (curr) {
    pathNodes.unshift(curr);
    curr = curr.parent;
  }

  const last = pathNodes[pathNodes.length - 1];
  const remainingDist = calculateDistanceNm(last.lat, last.lon, toCoord[0], toCoord[1]);

  if (remainingDist > 0.05) {
    // This final segment closes the gap left by the isochrone step size with
    // a straight line to the exact waypoint, which can point at any bearing
    // — including into the no-go zone. Recompute TWA/STW/SOG honestly for
    // that actual bearing rather than reusing the previous node's speed
    // (valid for a different heading): otherwise the route can claim full
    // cruising speed on a heading a boat couldn't actually sail.
    const finalBrg = calculateBearingDeg(last.lat, last.lon, toCoord[0], toCoord[1]);
    let finalTwa = Math.abs(last.twd - finalBrg) % 360;
    if (finalTwa > 180) finalTwa = 360 - finalTwa;
    const finalWaveFactor = getWaveSpeedFactor(last.waveHeight, last.waveDir, finalBrg, config.waveSensitivity);
    const finalStw = +(getDehlerBoatSpeed(finalTwa, last.tws) * finalWaveFactor).toFixed(2);

    const hRad = finalBrg * Math.PI / 180;
    const cRad = last.curDir * Math.PI / 180;
    const vx = finalStw * Math.sin(hRad) + last.curSpeed * Math.sin(cRad);
    const vy = finalStw * Math.cos(hRad) + last.curSpeed * Math.cos(cRad);
    const finalSog = Math.max(0.3, Math.hypot(vx, vy));
    const finalHrs = remainingDist / finalSog;

    // The final connector exists only to close a small residual gap left by
    // the isochrone step size — normally a fraction of one step's duration.
    // A gap that takes many step-widths to close means the step-by-step
    // search didn't actually reach the goal and fell through to the
    // "closest frontier node" fallback above instead (e.g. every candidate
    // briefly fell outside the sector-binning cone, or a step produced zero
    // valid candidates while the boat was still far off — both confirmed
    // via fuzzing). A pure distance cap alone doesn't catch this: a slow,
    // near-no-go final bearing can turn even a modest distance into a huge
    // time gap, which is what actually matters here — silently bridging
    // either with one straight line ignores wind, current, tacking, and
    // hazards for the rest of the leg, which is exactly what produced
    // routes that sail well off course then snap straight back in one bow.
    // Treat an implausibly long connector as a failed pass instead of
    // faking it.
    const maxPlausibleConnectorHrs = Math.max(1, 6 * dtHours);
    if (finalHrs > maxPlausibleConnectorHrs) return null;

    pathNodes.push({
      id: nodeIdCounter++,
      lat: toCoord[0],
      lon: toCoord[1],
      timeHours: last.timeHours + finalHrs,
      parent: last,
      stw: finalStw,
      sog: +finalSog.toFixed(2),
      heading: Math.round(finalBrg),
      cog: Math.round(finalBrg),
      tws: last.tws,
      twd: last.twd,
      twa: Math.round(finalTwa),
      curSpeed: last.curSpeed,
      curDir: last.curDir,
      waveHeight: last.waveHeight,
      waveDir: last.waveDir,
      // Not modeled here: this segment's cog/position are pinned to the
      // exact target waypoint regardless of heading (it just closes the
      // isochrone step-size gap), so there is no steering angle for leeway
      // to meaningfully act on the way there is in the main search.
      leewayDeg: 0,
      distToGoal: 0
    });
  }

  return {
    pathNodes,
    allRays: sampledRays,
    isochroneWavefronts: cleanWavefronts
  };
}

// Runs solveIsochronePassage for 1-3 passes, each subsequent pass narrowing
// the search fan and raising ray/sector resolution while biasing candidate
// headings toward where the previous pass actually sailed (see
// lookupReferenceHeading above) — a "next generation of wavefronts" that
// refines the route around an already-reasonable solution instead of
// resampling the whole search space from scratch every time.
export async function solveIsochronePassageRefined(fromCoord, toCoord, startTime, config, avoidZones, passes = 1) {
  const totalPasses = Math.max(1, Math.min(3, Math.round(passes)));
  let referencePath = null;
  let bestResult = null;

  for (let pass = 0; pass < totalPasses; pass++) {
    const passConfig = pass === 0
      ? config
      : {
          ...config,
          fanWidthDeg: Math.max(15, Math.round(config.fanWidthDeg * 0.5)),
          numRaysPerNode: Math.min(31, config.numRaysPerNode + 6),
          numSectors: Math.min(96, config.numSectors * 2)
        };

    const result = await solveIsochronePassage(fromCoord, toCoord, startTime, passConfig, avoidZones, referencePath);
    if (!result || !result.pathNodes || result.pathNodes.length < 2) {
      // This refinement pass's narrower, reference-biased fan failed to
      // find a path (e.g. it got biased toward a hazard) — keep whatever
      // the previous pass already found instead of discarding a working
      // route. A refinement pass must never make the result worse than
      // not refining at all.
      break;
    }

    bestResult = result;
    referencePath = result.pathNodes.map(n => ({ timeHours: n.timeHours, heading: n.heading }));
  }

  return bestResult;
}
