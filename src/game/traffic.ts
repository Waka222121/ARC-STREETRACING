import * as THREE from 'three';
import {
  FOUR_LANE_OFFSETS,
  HIGHWAY_SEGMENT_LENGTH,
} from './track';
import { RacerState, TrackId } from './types';

export type TrafficVehicleType = 'sedan' | 'suv' | 'truck';

export interface TrafficVehicle {
  id: string;
  type: TrafficVehicleType;
  /** Normalized progress along highway segment (0..1) */
  s: number;
  /** Lane index 0..3 across the 4 unified highway lanes */
  laneIndex: number;
  /** Lateral offset in meters from highway centerline */
  lateralOffset: number;
  /** Target lateral offset when changing lanes */
  targetLateralOffset: number;
  /** Forward speed in m/s */
  speedMs: number;
  /** Bounding box length in meters */
  length: number;
  /** Bounding box width in meters */
  width: number;
  /** Primary paint hex */
  color: string;
  /** Trailer / roof / trim hex */
  accentColor: string;
  /** World X coordinate */
  x: number;
  /** World Z coordinate (continuous along straight highway) */
  z: number;
  /** World heading in radians (0 = straight ahead along +Z) */
  heading: number;
  /** Cooldown to avoid double-counting near misses */
  nearMissCooldown: number;
}

export const HIGHWAY_LANES = FOUR_LANE_OFFSETS;

const SEDAN_COLORS = [
  '#e2e8f0',
  '#38bdf8',
  '#f43f5e',
  '#a855f7',
  '#10b981',
  '#fbbf24',
];

const TRUCK_CAB_COLORS = [
  '#f97316',
  '#ef4444',
  '#0284c7',
  '#eab308',
  '#14b8a6',
];

const TRUCK_TRAILER_COLORS = [
  '#cbd5e1',
  '#94a3b8',
  '#e2e8f0',
  '#64748b',
];

export interface TrafficIntensityMetrics {
  /** Normalized 0..1 intensity factor over elapsed race time */
  intensity: number;
  /** Forward highway window (meters ahead of player) into which all active traffic compresses */
  activeHorizonMeters: number;
  /** Longitudinal gap in meters between recycled traffic vehicles */
  waveGapMeters: number;
  /** Maximum lanes blocked in a single Z wave (2 early -> 3 at higher intensity, always leaving >=1 lane open) */
  maxLanesBlockedPerWave: number;
  /** Speed multiplier for highway traffic */
  paceEscalation: number;
}

/**
 * Computes progressive traffic intensity metrics as elapsed race time increases.
 */
export function computeTrafficIntensity(
  elapsedSec: number,
): TrafficIntensityMetrics {
  const intensity = Math.min(1, Math.max(0, elapsedSec / 45));
  const activeHorizonMeters = Math.round(920 - intensity * 560); // 920m -> 360m corridor
  const waveGapMeters = 34 - intensity * 22; // 34m -> 12m longitudinal spacing
  const maxLanesBlockedPerWave = elapsedSec >= 12 ? 3 : 2;
  const paceEscalation = 1 + intensity * 0.85; // 1.0x -> 1.85x traffic speed

  return {
    intensity,
    activeHorizonMeters,
    waveGapMeters,
    maxLanesBlockedPerWave,
    paceEscalation,
  };
}

export interface SurvivalGateSpec {
  gateIndex: number;
  blockedLanes: number[];
  openLanes: number[];
}

const TWO_LANE_GATE_PATTERNS: ReadonlyArray<{
  blocked: [number, number];
  open: [number, number];
}> = [
  { blocked: [0, 3], open: [1, 2] }, // Center dual corridor
  { blocked: [1, 2], open: [0, 3] }, // Outer split wings
  { blocked: [0, 1], open: [2, 3] }, // Right dual corridor
  { blocked: [2, 3], open: [0, 1] }, // Left dual corridor
  { blocked: [0, 2], open: [1, 3] }, // Alternating odd lanes open
  { blocked: [1, 3], open: [0, 2] }, // Alternating even lanes open
];

const THREE_LANE_GATE_PATTERNS: ReadonlyArray<{
  blocked: [number, number, number];
  open: [number];
}> = [
  { blocked: [0, 1, 3], open: [2] }, // Needle-eye corridor in lane 2
  { blocked: [0, 2, 3], open: [1] }, // Needle-eye corridor in lane 1
  { blocked: [1, 2, 3], open: [0] }, // Needle-eye corridor in lane 0
  { blocked: [0, 1, 2], open: [3] }, // Needle-eye corridor in lane 3
];

/**
 * Returns a deterministic "Survival Gate" lane configuration for the 4-player pack:
 * - When `maxLanesBlocked === 2`: blocks 2 lanes and leaves 2 open corridors.
 * - When `maxLanesBlocked >= 3`: blocks 3 lanes and leaves 1 narrow "needle-eye" survival corridor,
 *   requiring multiple players to hop into the same open lane and overlap via Ghost Pass-Through.
 */
export function getSurvivalGateSpec(
  gateIndex: number,
  maxLanesBlocked: number,
): SurvivalGateSpec {
  const safeIdx = Math.max(0, Math.floor(gateIndex));
  if (maxLanesBlocked >= 3) {
    const p =
      THREE_LANE_GATE_PATTERNS[safeIdx % THREE_LANE_GATE_PATTERNS.length];
    return {
      gateIndex: safeIdx,
      blockedLanes: [...p.blocked],
      openLanes: [...p.open],
    };
  }
  const p = TWO_LANE_GATE_PATTERNS[safeIdx % TWO_LANE_GATE_PATTERNS.length];
  return {
    gateIndex: safeIdx,
    blockedLanes: [...p.blocked],
    openLanes: [...p.open],
  };
}

export type SeededRng = () => number;

/**
 * Pure deterministic 32-bit mulberry32 PRNG shared between the authoritative Node.js server
 * and all connected browser clients so seeded traffic waves match identically.
 */
export function createSeededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates a deterministic wave of civilian passenger cars (sedans, SUVs) and heavy cargo trucks
 * organized into readable "Survival Gates" along the straight 4-lane highway ahead of the 4-player starting grid,
 * with progressive density along +Z and always leaving 1-2 open survival corridors per gate.
 * When `seed` is provided (online matches driven by Orion RandomnessHub v2), gate patterns and vehicle
 * archetypes vary deterministically per room while remaining 100% identical between server and clients.
 */
export function createInitialTraffic(
  _trackId: TrackId,
  count = 36,
  seed?: number,
): TrafficVehicle[] {
  const rng = seed !== undefined ? createSeededRng(seed) : null;
  const seedGateOffset = rng ? Math.floor(rng() * TWO_LANE_GATE_PATTERNS.length) : 0;
  const vehicles: TrafficVehicle[] = [];
  const startZ = 150; // Start ~86m ahead of the 4-player starting line (z = 64m)
  let cursorZ = startZ;

  for (let i = 0; i < count; i++) {
    const progressFrac = i / Math.max(1, count - 1);
    const waveIdx = Math.floor(i / 2);
    const inWavePos = i % 2;

    // Gates start wider apart (~46m) and progressively tighten (~22m) further down the highway;
    // vehicles within the same gate wave stay closely aligned in Z (0..2.5m stagger) to form a crisp horizontal gate.
    if (i > 0) {
      const jitter = rng ? rng() * 2.2 : 0;
      const stepZ =
        inWavePos === 1
          ? 1.5 + (waveIdx % 2) * 1.0 + jitter * 0.35
          : Math.max(22, 46 - progressFrac * 24 + jitter);
      cursorZ += stepZ;
    }
    const z = cursorZ;

    // Wave 0 & 1 occupy outer lanes (0 and 3) so the initial 4-lane start formation has a clean center corridor,
    // then subsequent waves cycle through all Survival Gate patterns (seeded when online).
    const gate =
      waveIdx < 2
        ? getSurvivalGateSpec(0, 2)
        : getSurvivalGateSpec(waveIdx - 1 + seedGateOffset, 2);
    const laneIndex = gate.blockedLanes[inWavePos % gate.blockedLanes.length];
    const lateralOffset = HIGHWAY_LANES[laneIndex];

    const roll = rng ? rng() : -1;
    const isTruck = rng ? roll < 0.32 : i % 3 === 0;
    const isSuv = rng ? !isTruck && roll < 0.66 : !isTruck && i % 2 === 1;
    const type: TrafficVehicleType = isTruck
      ? 'truck'
      : isSuv
        ? 'suv'
        : 'sedan';

    const length = isTruck ? 9.4 : isSuv ? 4.7 : 4.3;
    const width = isTruck ? 2.38 : isSuv ? 1.96 : 1.84;
    // Match base speed per gate wave so vehicles in the same survival gate move together as a cohesive formation
    const gateSpeedMs = 15.5 + ((waveIdx + seedGateOffset) % 5) * 1.4;
    const speedMs = isTruck
      ? Math.min(gateSpeedMs, 15.0 + ((waveIdx + seedGateOffset) % 3) * 1.1)
      : gateSpeedMs;

    const x = -lateralOffset; // nx = -1 along straight +Z highway
    const s = (((z / HIGHWAY_SEGMENT_LENGTH) % 1) + 1) % 1;

    const colorPick = rng ? Math.floor(rng() * 100) : i;
    vehicles.push({
      id: `traffic_${i}`,
      type,
      s,
      laneIndex,
      lateralOffset,
      targetLateralOffset: lateralOffset,
      speedMs,
      length,
      width,
      color: isTruck
        ? TRUCK_CAB_COLORS[colorPick % TRUCK_CAB_COLORS.length]
        : SEDAN_COLORS[colorPick % SEDAN_COLORS.length],
      accentColor: isTruck
        ? TRUCK_TRAILER_COLORS[colorPick % TRUCK_TRAILER_COLORS.length]
        : '#1e293b',
      x,
      z,
      heading: 0,
      nearMissCooldown: 0,
    });
  }

  enforcePassableCorridorGuarantee(vehicles, 2);
  return vehicles;
}

/**
 * Enforces strict longitudinal bumper-to-bumper separation and car-following speed matching
 * among all highway traffic vehicles sharing the same lane (`laneIndex = 0..3`),
 * guaranteeing that traffic cars and cargo trucks never overlap or pass through each other.
 */
export function enforceTrafficLaneSeparation(
  traffic: TrafficVehicle[],
): void {
  const MIN_BUMPER_GAP_METERS = 5.2;
  const FOLLOW_BRAKE_BUFFER_METERS = 11.0;

  for (let lane = 0; lane < 4; lane++) {
    // Collect vehicles in this lane and sort from furthest ahead (+Z) to furthest behind
    const laneVehicles: TrafficVehicle[] = [];
    for (let i = 0; i < traffic.length; i++) {
      if (traffic[i].laneIndex === lane) {
        laneVehicles.push(traffic[i]);
      }
    }
    if (laneVehicles.length < 2) continue;

    laneVehicles.sort((a, b) => b.z - a.z);

    for (let k = 1; k < laneVehicles.length; k++) {
      const ahead = laneVehicles[k - 1];
      const behind = laneVehicles[k];
      const minCenterDist =
        (ahead.length + behind.length) * 0.5 + MIN_BUMPER_GAP_METERS;
      const currentDist = ahead.z - behind.z;

      // Match speed as soon as a faster traffic vehicle approaches a slower vehicle ahead in the same lane
      if (currentDist < minCenterDist + FOLLOW_BRAKE_BUFFER_METERS) {
        if (behind.speedMs > ahead.speedMs) {
          behind.speedMs = ahead.speedMs;
        }
      }

      // Hard non-penetration clamp so vehicles in the same lane can never overlap or pass through each other
      if (currentDist < minCenterDist) {
        behind.z = ahead.z - minCenterDist;
        if (behind.speedMs > ahead.speedMs) {
          behind.speedMs = ahead.speedMs;
        }
      }
    }
  }

  for (let i = 0; i < traffic.length; i++) {
    const v = traffic[i];
    v.lateralOffset = HIGHWAY_LANES[v.laneIndex];
    v.targetLateralOffset = v.lateralOffset;
    v.x = -v.lateralOffset;
    v.heading = 0;
    v.s = (((v.z / HIGHWAY_SEGMENT_LENGTH) % 1) + 1) % 1;
  }
}

/**
 * Hard per-frame Passable Corridor Validator (`Концепт 3: Гарант открытого коридора`):
 * Sweeps along +Z from lowest Z to highest Z and guarantees:
 * 1. Never all 4 lanes blocked in any `corridorWindowMeters` (24m) longitudinal slice
 *    (at most `Math.min(3, maxLanesBlockedPerWave)` lanes occupied in any 24m window).
 * 2. Connected Diagonal Hop Reachability: between any two consecutive gates within 42m,
 *    there is always an open corridor reachable within <= 1 adjacent lane hop (`|openNow - openPrev| <= 1`).
 * 3. Strict same-lane bumper-to-bumper non-overlapping separation (`>= 5.2m` bumper gap) and speed matching.
 */
export function enforcePassableCorridorGuarantee(
  traffic: TrafficVehicle[],
  maxLanesBlockedPerWave = 3,
  corridorWindowMeters = 24.0,
): void {
  if (traffic.length === 0) return;

  const allowedBlocked = Math.max(1, Math.min(3, maxLanesBlockedPerWave));
  const MIN_BUMPER_GAP_METERS = 5.2;

  // Sort vehicles from lowest Z (closest to players) to highest Z (furthest down the highway)
  const sorted = [...traffic].sort((a, b) => a.z - b.z);
  const lastInLane: Array<TrafficVehicle | null> = [null, null, null, null];

  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    const lane = v.laneIndex;

    // 1. Enforce forward same-lane bumper-to-bumper separation from previous vehicle in this lane
    const prevSame = lastInLane[lane];
    if (prevSame) {
      const minSameDist =
        (prevSame.length + v.length) * 0.5 + MIN_BUMPER_GAP_METERS;
      if (v.z < prevSame.z + minSameDist) {
        v.z = prevSame.z + minSameDist;
      }
      if (
        v.z - prevSame.z < minSameDist + 12.0 &&
        prevSame.speedMs > v.speedMs
      ) {
        prevSame.speedMs = v.speedMs;
      }
    }

    // 2. Validate that adding `v` at `v.z` keeps >= (4 - allowedBlocked) open lanes in [v.z - window, v.z]
    //    AND maintains a connected <= 1-lane-hop path from the preceding gate window
    let guard = 0;
    while (guard < 16) {
      guard++;
      const windowOccupied = new Set<number>([v.laneIndex]);
      let earliestConflict: TrafficVehicle | null = null;

      // Preceding gate window [v.z - 42m, v.z - corridorWindowMeters] to verify reachable diagonal transition
      const prevWindowOccupied = new Set<number>();

      for (let j = i - 1; j >= 0; j--) {
        const u = sorted[j];
        const centerGap = v.z - u.z;
        const effectiveWindow =
          corridorWindowMeters + (u.length + v.length) * 0.35;

        if (centerGap <= effectiveWindow) {
          windowOccupied.add(u.laneIndex);
          if (!earliestConflict || u.z < earliestConflict.z) {
            earliestConflict = u;
          }
        } else if (centerGap <= effectiveWindow + 20.0) {
          prevWindowOccupied.add(u.laneIndex);
        } else {
          break;
        }
      }

      const tooManyLanesBlocked = windowOccupied.size > allowedBlocked;

      // Check connected hop reachability from preceding window if preceding window had constrained lanes
      let disconnectedCorridor = false;
      if (!tooManyLanesBlocked && prevWindowOccupied.size >= 2) {
        const openNow = [0, 1, 2, 3].filter((l) => !windowOccupied.has(l));
        const openPrev = [0, 1, 2, 3].filter((l) => !prevWindowOccupied.has(l));
        if (openNow.length > 0 && openPrev.length > 0) {
          let hasAdjacentLink = false;
          for (const lNow of openNow) {
            for (const lPrev of openPrev) {
              if (Math.abs(lNow - lPrev) <= 1) {
                hasAdjacentLink = true;
                break;
              }
            }
            if (hasAdjacentLink) break;
          }
          if (!hasAdjacentLink) {
            disconnectedCorridor = true;
          }
        }
      }

      if (!tooManyLanesBlocked && !disconnectedCorridor) {
        break;
      }

      // Push `v.z` forward past the conflicting window so the open corridor remains 100% passable
      const pushBaseZ = earliestConflict ? earliestConflict.z : v.z;
      const pushClearance = earliestConflict
        ? corridorWindowMeters + (earliestConflict.length + v.length) * 0.35 + 1.5
        : corridorWindowMeters + 4.0;
      v.z = Math.max(v.z + 8.0, pushBaseZ + pushClearance);

      // Re-verify same-lane clearance after pushing `v.z` forward
      const curPrevSame = lastInLane[v.laneIndex];
      if (curPrevSame) {
        const minSameDist =
          (curPrevSame.length + v.length) * 0.5 + MIN_BUMPER_GAP_METERS;
        if (v.z < curPrevSame.z + minSameDist) {
          v.z = curPrevSame.z + minSameDist;
        }
      }
    }

    // 3. Synchronize speed with nearby vehicles in adjacent lanes so trailing waves never creep into this corridor
    for (let j = i - 1; j >= 0; j--) {
      const u = sorted[j];
      if (v.z - u.z > 36.0) break;
      if (u.speedMs > v.speedMs) {
        u.speedMs = v.speedMs;
      } else if (v.speedMs > u.speedMs && v.z - u.z < 14.0) {
        v.speedMs = u.speedMs;
      }
    }

    lastInLane[v.laneIndex] = v;
  }

  for (let i = 0; i < traffic.length; i++) {
    const v = traffic[i];
    v.lateralOffset = HIGHWAY_LANES[v.laneIndex];
    v.targetLateralOffset = v.lateralOffset;
    v.x = -v.lateralOffset;
    v.heading = 0;
    v.s = (((v.z / HIGHWAY_SEGMENT_LENGTH) % 1) + 1) % 1;
  }
}

/**
 * Helper to pick a safe lane at `targetZ` that avoids overlapping existing vehicles in the same lane
 * and never blocks all 4 lanes simultaneously (respects `maxLanesBlockedPerWave`).
 */
function pickSafeRecycleLane(
  traffic: TrafficVehicle[],
  selfIdx: number,
  targetZ: number,
  preferredLane: number,
  maxLanesBlockedPerWave: number,
): number {
  const selfVehicle = traffic[selfIdx];
  const selfLen = selfVehicle ? selfVehicle.length : 5.0;
  const waveOccupiedLanes = new Set<number>();
  const laneConflict = [false, false, false, false];

  for (let j = 0; j < traffic.length; j++) {
    if (j === selfIdx) continue;
    const other = traffic[j];
    const dz = Math.abs(other.z - targetZ);
    if (dz < 26.0) {
      waveOccupiedLanes.add(other.laneIndex);
    }
    const minSameLaneClearance = (other.length + selfLen) * 0.5 + 8.0;
    if (dz < minSameLaneClearance) {
      laneConflict[other.laneIndex] = true;
    }
  }

  // If this Z-slice already has maxLanesBlockedPerWave vehicles, return -1 so caller advances Z
  if (waveOccupiedLanes.size >= maxLanesBlockedPerWave) {
    return -1;
  }

  for (let offset = 0; offset < 4; offset++) {
    const candidate = (preferredLane + offset) % 4;
    if (!waveOccupiedLanes.has(candidate) && !laneConflict[candidate]) {
      return candidate;
    }
  }
  return -1;
}

/**
 * Advances all civilian passenger cars and cargo trucks along the continuous straight 4-lane highway (+Z),
 * progressively intensifying traffic density, wave compactness, multi-lane bottlenecks, and speed over time.
 */
export function stepTrafficVehicles(
  traffic: TrafficVehicle[],
  racers: RacerState[],
  _trackId: TrackId,
  dt: number,
  elapsedSec: number,
  seed?: number,
): void {
  const seedShift = seed !== undefined ? Math.abs(seed >>> 0) % 13 : 0;
  const {
    intensity,
    activeHorizonMeters,
    waveGapMeters,
    maxLanesBlockedPerWave,
    paceEscalation,
  } = computeTrafficIntensity(elapsedSec);

  const activeRacer = racers.find((r) => !r.eliminated) || racers[0];
  const refZ = activeRacer ? activeRacer.z : 64;
  const minAheadZ = refZ + Math.round(145 - intensity * 55); // 145m -> 90m ahead
  const maxAheadZ = refZ + activeHorizonMeters;

  // Find furthest traffic Z inside the active horizon so recycled vehicles pack tightly
  let packTailZ = minAheadZ;
  for (let i = 0; i < traffic.length; i++) {
    const tz = traffic[i].z;
    if (tz >= refZ && tz <= maxAheadZ && tz > packTailZ) {
      packTailZ = tz;
    }
  }

  for (let i = 0; i < traffic.length; i++) {
    const v = traffic[i];
    if (v.nearMissCooldown > 0) {
      v.nearMissCooldown = Math.max(0, v.nearMissCooldown - dt);
    }

    v.z += v.speedMs * paceEscalation * dt;
    v.lateralOffset = HIGHWAY_LANES[v.laneIndex];
    v.targetLateralOffset = v.lateralOffset;
    v.x = -v.lateralOffset;

    // Prevent traffic vehicles from driving into the back of any active racer ahead in the same lane
    for (let rIdx = 0; rIdx < racers.length; rIdx++) {
      const r = racers[rIdx];
      if (r.eliminated) continue;
      if (Math.abs(v.x - r.x) < v.width * 0.5 + 0.95) {
        const gapAhead = r.z - v.z;
        const minSafeRearGap = v.length * 0.5 + 2.25;
        if (gapAhead > 0 && gapAhead < minSafeRearGap) {
          v.z = r.z - minSafeRearGap;
        }
      }
    }

    // Recycle any traffic vehicle that falls > 48m behind the player OR is stranded beyond the tightening active horizon
    if (v.z < refZ - 48 || v.z > maxAheadZ + 65) {
      const minCorridorStepZ = Math.max(28, waveGapMeters);
      let candidateZ = Math.min(
        maxAheadZ,
        Math.max(
          minAheadZ + ((i * 19 + seedShift * 7) % Math.max(40, activeHorizonMeters - 95)),
          packTailZ + minCorridorStepZ * (0.65 + ((i + seedShift) % 3) * 0.25),
        ),
      );

      // Select preferred lane from the Survival Gate pattern at this Z slice
      const gateIdx = Math.floor(candidateZ / minCorridorStepZ) + seedShift;
      const gateSpec = getSurvivalGateSpec(gateIdx, maxLanesBlockedPerWave);
      const preferredLane =
        gateSpec.blockedLanes[(i + seedShift) % gateSpec.blockedLanes.length] ??
        (v.laneIndex + 1 + (i % 3)) % 4;
      let chosenLane = pickSafeRecycleLane(
        traffic,
        i,
        candidateZ,
        preferredLane,
        maxLanesBlockedPerWave,
      );

      // If the slice already has maxLanesBlockedPerWave vehicles, step forward to the next wave slot
      let attempts = 0;
      while (chosenLane === -1 && attempts < 14) {
        candidateZ += minCorridorStepZ;
        const nextGate = getSurvivalGateSpec(
          gateIdx + attempts + 1,
          maxLanesBlockedPerWave,
        );
        const nextPrefLane =
          nextGate.blockedLanes[
            (i + attempts + seedShift) % nextGate.blockedLanes.length
          ] ?? (preferredLane + attempts) % 4;
        chosenLane = pickSafeRecycleLane(
          traffic,
          i,
          candidateZ,
          nextPrefLane,
          maxLanesBlockedPerWave,
        );
        attempts++;
      }

      if (chosenLane === -1) {
        chosenLane = preferredLane;
        candidateZ = packTailZ + minCorridorStepZ;
      }

      v.z = candidateZ;
      v.laneIndex = chosenLane;
      v.lateralOffset = HIGHWAY_LANES[chosenLane];
      v.targetLateralOffset = HIGHWAY_LANES[chosenLane];
      if (candidateZ > packTailZ) {
        packTailZ = candidateZ;
      }
    }
  }

  // Strictly enforce same-lane separation AND the per-frame Passable Corridor Guarantee (Concept 3)
  enforceTrafficLaneSeparation(traffic);
  enforcePassableCorridorGuarantee(traffic, maxLanesBlockedPerWave, 24.0);
}

export interface TrafficCollisionResult {
  collided: boolean;
  hitVehicle: TrafficVehicle | null;
  nearMiss: boolean;
}

/**
 * Checks Oriented Bounding Box (OBB) collision between a racer and all highway traffic vehicles
 * (passenger sedans, SUVs, and heavy cargo trucks).
 * If a racer collides with a traffic vehicle on the track, the game immediately ends for that racer (`racer.eliminated = true`).
 */
export function checkRacerTrafficCollision(
  racer: RacerState,
  traffic: TrafficVehicle[],
): TrafficCollisionResult {
  if (racer.eliminated) {
    return { collided: false, hitVehicle: null, nearMiss: false };
  }

  const racerHalfLen = 2.15;
  const racerHalfWid = 0.98;
  let triggeredNearMiss = false;

  for (let i = 0; i < traffic.length; i++) {
    const v = traffic[i];
    const signedDx = racer.x - v.x;
    const signedDz = racer.z - v.z;
    const dx = Math.abs(signedDx);
    const dz = Math.abs(signedDz);

    if (dz > 14 || dx > 6) continue;

    const hitForwardThreshold = v.length * 0.5 + racerHalfLen;
    const hitLateralThreshold = v.width * 0.5 + racerHalfWid;

    if (dz < hitForwardThreshold && dx < hitLateralThreshold) {
      // Clamp racer outside the traffic vehicle's bounding box and end the game for this racer
      const overlapX = hitLateralThreshold - dx;
      const overlapZ = hitForwardThreshold - dz;
      if (overlapX < overlapZ) {
        const signX = signedDx >= 0 ? 1 : -1;
        racer.x = v.x + signX * (hitLateralThreshold + 0.1);
        racer.x = Math.max(-7.2, Math.min(7.2, racer.x));
      } else {
        const signZ = signedDz >= 0 ? 1 : -1;
        racer.z = v.z + signZ * (hitForwardThreshold + 0.12);
      }
      racer.eliminated = true;
      racer.vx = 0;
      racer.vz = 0;
      racer.speedMs = 0;
      racer.speedKmh = 0;
      racer.angularVelocity = 0;
      racer.isBoosting = false;
      racer.isDrifting = false;
      racer.hitFlashTimer = Math.max(racer.hitFlashTimer, 0.65);

      return {
        collided: true,
        hitVehicle: v,
        nearMiss: false,
      };
    }

    if (
      racer.speedKmh > 95 &&
      v.nearMissCooldown <= 0 &&
      dz < hitForwardThreshold + 1.2 &&
      dx < hitLateralThreshold + 1.1
    ) {
      v.nearMissCooldown = 2.5;
      triggeredNearMiss = true;
    }
  }

  return {
    collided: false,
    hitVehicle: null,
    nearMiss: triggeredNearMiss,
  };
}

/**
 * Evaluates upcoming traffic in all 4 unified lanes ahead of a racer along +Z and returns
 * the safest open survival gate corridor to hop into.
 */
export function findSafeLaneForAi(
  rival: RacerState,
  traffic: TrafficVehicle[],
  preferredLateralOffset: number,
  mistakeFactor = 0,
): { targetOffset: number; trafficThreatAhead: boolean } {
  const laneScores = [0, 0, 0, 0];
  let trafficThreatAhead = false;
  const lookAheadMeters = Math.max(38, 56 - mistakeFactor * 14);
  const currentLateralOffset = -rival.x;

  for (let i = 0; i < traffic.length; i++) {
    const v = traffic[i];
    const dz = v.z - rival.z;

    if (dz > -7 && dz < lookAheadMeters) {
      const proximityWeight = Math.pow(
        1 - Math.max(0, dz) / lookAheadMeters,
        1.35,
      );
      for (let laneIdx = 0; laneIdx < 4; laneIdx++) {
        const lanePos = HIGHWAY_LANES[laneIdx];
        const latDist = Math.abs(v.lateralOffset - lanePos);
        const safeClearance = v.width * 0.5 + 1.25;
        if (latDist < safeClearance) {
          // Heavily penalize immediate obstacles (< 26m) so the racer always clears the nearest gate first
          const immediatePenalty = dz < 26 ? 260 : 120;
          laneScores[laneIdx] -= immediatePenalty + proximityWeight * 320;
          if (dz > -4 && dz < 42) {
            trafficThreatAhead = true;
          }
        }
      }
    }
  }

  let bestLaneIdx = 0;
  let bestScore = -Infinity;
  for (let laneIdx = 0; laneIdx < 4; laneIdx++) {
    const lanePos = HIGHWAY_LANES[laneIdx];
    const distFromPreferred = Math.abs(lanePos - preferredLateralOffset);
    const distFromCurrent = Math.abs(lanePos - currentLateralOffset);
    // Prefer remaining in the player's home lane when clear, or hopping into the closest open survival corridor when blocked
    const score =
      laneScores[laneIdx] - distFromPreferred * 8.5 - distFromCurrent * 4.5;
    if (score > bestScore) {
      bestScore = score;
      bestLaneIdx = laneIdx;
    }
  }

  return {
    targetOffset: HIGHWAY_LANES[bestLaneIdx],
    trafficThreatAhead,
  };
}

/**
 * Builds a clean, distinctive 3D procedural mesh for civilian passenger cars, SUVs, and heavy cargo trucks.
 */
export function buildTrafficVehicleMesh(vehicle: TrafficVehicle): THREE.Group {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(vehicle.color),
    roughness: 0.35,
    metalness: 0.55,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0b1120,
    roughness: 0.12,
    metalness: 0.85,
  });
  const darkTrimMat = new THREE.MeshStandardMaterial({
    color: 0x111827,
    roughness: 0.7,
    metalness: 0.3,
  });
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x090d16,
    roughness: 0.85,
    metalness: 0.15,
  });
  const headLightMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
  const tailLightMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
  const amberMarkerMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });

  if (vehicle.type === 'truck') {
    // 1. Forward Cab (Tractor unit)
    const cabGeo = new THREE.BoxGeometry(2.3, 2.35, 2.5);
    const cabMesh = new THREE.Mesh(cabGeo, bodyMat);
    cabMesh.position.set(0, 1.52, 3.05);
    group.add(cabMesh);

    // Cab roof wind deflector
    const deflectorGeo = new THREE.BoxGeometry(2.2, 0.55, 1.4);
    const deflectorMesh = new THREE.Mesh(deflectorGeo, bodyMat);
    deflectorMesh.position.set(0, 2.9, 2.8);
    deflectorMesh.rotation.x = 0.25;
    group.add(deflectorMesh);

    // Cab windshield
    const windshieldGeo = new THREE.BoxGeometry(2.12, 0.85, 0.15);
    const windshieldMesh = new THREE.Mesh(windshieldGeo, glassMat);
    windshieldMesh.position.set(0, 2.0, 4.26);
    group.add(windshieldMesh);

    // Front radiator grille
    const grilleGeo = new THREE.BoxGeometry(1.6, 0.95, 0.14);
    const grilleMesh = new THREE.Mesh(grilleGeo, darkTrimMat);
    grilleMesh.position.set(0, 1.05, 4.27);
    group.add(grilleMesh);

    // 2. Long Cargo Container Trailer
    const trailerMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(vehicle.accentColor),
      roughness: 0.48,
      metalness: 0.4,
    });
    const trailerGeo = new THREE.BoxGeometry(2.36, 2.95, 6.4);
    const trailerMesh = new THREE.Mesh(trailerGeo, trailerMat);
    trailerMesh.position.set(0, 1.92, -1.45);
    group.add(trailerMesh);

    // High-visibility amber clearance marker strip along top of trailer
    const stripeGeo = new THREE.BoxGeometry(2.4, 0.12, 6.44);
    const stripeMesh = new THREE.Mesh(stripeGeo, amberMarkerMat);
    stripeMesh.position.set(0, 3.38, -1.45);
    group.add(stripeMesh);

    // Chassis lower frame rail
    const frameGeo = new THREE.BoxGeometry(1.5, 0.35, 8.8);
    const frameMesh = new THREE.Mesh(frameGeo, darkTrimMat);
    frameMesh.position.set(0, 0.52, -0.1);
    group.add(frameMesh);

    // 6 heavy truck wheel pairs
    const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.36, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const zPos of [3.2, 0.8, -2.4, -3.5]) {
      for (const xSide of [-1.1, 1.1]) {
        const w = new THREE.Mesh(wheelGeo, wheelMat);
        w.position.set(xSide, 0.46, zPos);
        group.add(w);
      }
    }

    // Truck headlights & bright rear brake bar
    const hlGeo = new THREE.BoxGeometry(0.42, 0.22, 0.1);
    for (const xSide of [-0.82, 0.82]) {
      const hl = new THREE.Mesh(hlGeo, headLightMat);
      hl.position.set(xSide, 0.85, 4.31);
      group.add(hl);
    }
    const tlGeo = new THREE.BoxGeometry(2.15, 0.24, 0.12);
    const tl = new THREE.Mesh(tlGeo, tailLightMat);
    tl.position.set(0, 0.75, -4.66);
    group.add(tl);
  } else {
    const isSuv = vehicle.type === 'suv';
    const len = vehicle.length;
    const wid = vehicle.width;
    const hullH = isSuv ? 0.68 : 0.54;
    const cabinH = isSuv ? 0.62 : 0.48;
    const cabinLen = isSuv ? len * 0.6 : len * 0.5;

    // Lower body hull
    const hullGeo = new THREE.BoxGeometry(wid, hullH, len);
    const hullMesh = new THREE.Mesh(hullGeo, bodyMat);
    hullMesh.position.set(0, 0.34 + hullH * 0.5, 0);
    group.add(hullMesh);

    // Cabin / greenhouse
    const cabinGeo = new THREE.BoxGeometry(wid * 0.86, cabinH, cabinLen);
    const cabinMesh = new THREE.Mesh(cabinGeo, glassMat);
    cabinMesh.position.set(
      0,
      0.34 + hullH + cabinH * 0.46,
      isSuv ? -0.18 : -0.12,
    );
    group.add(cabinMesh);

    // Roof cap
    const roofGeo = new THREE.BoxGeometry(wid * 0.82, 0.08, cabinLen * 0.84);
    const roofMesh = new THREE.Mesh(roofGeo, bodyMat);
    roofMesh.position.set(
      0,
      0.34 + hullH + cabinH * 0.9,
      isSuv ? -0.18 : -0.12,
    );
    group.add(roofMesh);

    if (isSuv) {
      // Subtle amber utility roof beacon on SUVs for clear top-down readability
      const beaconGeo = new THREE.BoxGeometry(0.75, 0.12, 0.25);
      const beaconMesh = new THREE.Mesh(beaconGeo, amberMarkerMat);
      beaconMesh.position.set(0, 0.34 + hullH + cabinH + 0.04, 0.1);
      group.add(beaconMesh);
    }

    // 4 wheels
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const zWheel = len * 0.31;
    const xWheel = wid * 0.48;
    for (const zPos of [zWheel, -zWheel]) {
      for (const xSide of [-xWheel, xWheel]) {
        const w = new THREE.Mesh(wheelGeo, wheelMat);
        w.position.set(xSide, 0.34, zPos);
        group.add(w);
      }
    }

    // Headlights & bright rear tail-light strip
    const hlGeo = new THREE.BoxGeometry(0.36, 0.15, 0.1);
    for (const xSide of [-wid * 0.32, wid * 0.32]) {
      const hl = new THREE.Mesh(hlGeo, headLightMat);
      hl.position.set(xSide, 0.62, len * 0.5 + 0.01);
      group.add(hl);
    }
    const tlGeo = new THREE.BoxGeometry(wid * 0.84, 0.16, 0.1);
    const tl = new THREE.Mesh(tlGeo, tailLightMat);
    tl.position.set(0, 0.66, -len * 0.5 - 0.01);
    group.add(tl);
  }

  return group;
}
