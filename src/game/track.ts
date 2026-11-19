import { TrackId, TrackSpec } from './types';

export const HIGHWAY_SEGMENT_LENGTH = 2000;
export const HIGHWAY_TOTAL_WIDTH = 21.4;
export const FOUR_LANE_OFFSETS = [-5.7, -1.9, 1.9, 5.7] as const;

export const TRACK_CATALOG: Record<TrackId, TrackSpec> = {
  olympic_circuit: {
    id: 'olympic_circuit',
    name: 'Sector 01 // 4-Lane Expressway',
    district: 'Unified 4-Lane Straight Highway',
    laps: 3,
    lengthMeters: HIGHWAY_SEGMENT_LENGTH,
    difficulty: 'Street',
    prizeFirst: 3500,
    ambientColor: '#0b0f17',
    accentColor: '#ff4d00',
    description:
      'Continuous straight 4-lane highway corridor with passenger sedans, SUVs, and heavy cargo trucks.',
    waypoints: [
      { x: 0, z: 0, width: HIGHWAY_TOTAL_WIDTH },
      { x: 0, z: 500, width: HIGHWAY_TOTAL_WIDTH },
      { x: 0, z: 1000, width: HIGHWAY_TOTAL_WIDTH },
      { x: 0, z: 1500, width: HIGHWAY_TOTAL_WIDTH },
    ],
  },
  chinatown_sprint: {
    id: 'chinatown_sprint',
    name: 'Sector 02 // Midnight Autobahn',
    district: 'High-Speed 4-Lane Corridor',
    laps: 3,
    lengthMeters: HIGHWAY_SEGMENT_LENGTH,
    difficulty: 'Pro',
    prizeFirst: 5200,
    ambientColor: '#090d16',
    accentColor: '#38bdf8',
    description:
      'High-speed straight 4-lane expressway with dense mid-lane commuter traffic and long-haul freight trucks.',
    waypoints: [
      { x: 0, z: 0, width: HIGHWAY_TOTAL_WIDTH },
      { x: 0, z: 500, width: HIGHWAY_TOTAL_WIDTH },
      { x: 0, z: 1000, width: HIGHWAY_TOTAL_WIDTH },
      { x: 0, z: 1500, width: HIGHWAY_TOTAL_WIDTH },
    ],
  },
  harbor_drift: {
    id: 'harbor_drift',
    name: 'Sector 03 // Industrial Causeway',
    district: 'Heavy Freight 4-Lane Highway',
    laps: 3,
    lengthMeters: HIGHWAY_SEGMENT_LENGTH,
    difficulty: 'Underground King',
    prizeFirst: 7800,
    ambientColor: '#081014',
    accentColor: '#10b981',
    description:
      'Endless straight 4-lane causeway packed with 18-wheeler cargo convoys and rapid lane-weaving survival.',
    waypoints: [
      { x: 0, z: 0, width: HIGHWAY_TOTAL_WIDTH },
      { x: 0, z: 500, width: HIGHWAY_TOTAL_WIDTH },
      { x: 0, z: 1000, width: HIGHWAY_TOTAL_WIDTH },
      { x: 0, z: 1500, width: HIGHWAY_TOTAL_WIDTH },
    ],
  },
};

export interface SplineSample {
  x: number;
  z: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  width: number;
  s: number; // normalized 0..1
  curvature?: number;
  bankingRad?: number;
}

const SAMPLE_COUNT = 200;
const trackSampleCache: Partial<Record<TrackId, SplineSample[]>> = {};

/**
 * Evaluates a point along the continuous straight 4-lane highway (x = 0, z = u * 2000).
 * Zero turns, zero curvature, constant 4-lane unified width.
 */
export function evaluateTrackRaw(
  _trackId: TrackId,
  u: number,
): { x: number; z: number; width: number } {
  const wrappedU = ((u % 1) + 1) % 1;
  return {
    x: 0,
    z: wrappedU * HIGHWAY_SEGMENT_LENGTH,
    width: HIGHWAY_TOTAL_WIDTH,
  };
}

export function getTrackSamples(trackId: TrackId): SplineSample[] {
  const cached = trackSampleCache[trackId];
  if (cached) return cached;

  const samples: SplineSample[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const s = i / SAMPLE_COUNT;
    samples.push({
      x: 0,
      z: s * HIGHWAY_SEGMENT_LENGTH,
      tx: 0,
      tz: 1,
      nx: -1,
      nz: 0,
      width: HIGHWAY_TOTAL_WIDTH,
      s,
      curvature: 0,
      bankingRad: 0,
    });
  }

  trackSampleCache[trackId] = samples;
  return samples;
}

export function evaluateTrackSpline(_trackId: TrackId, s: number): SplineSample {
  const wrapped = ((s % 1) + 1) % 1;
  return {
    x: 0,
    z: wrapped * HIGHWAY_SEGMENT_LENGTH,
    tx: 0,
    tz: 1,
    nx: -1,
    nz: 0,
    width: HIGHWAY_TOTAL_WIDTH,
    s: wrapped,
    curvature: 0,
    bankingRad: 0,
  };
}

export interface TrackProjection {
  s: number;
  centerX: number;
  centerZ: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  lateralOffset: number; // signed distance from centerline (+ right, - left)
  halfWidth: number;
  trackHeading: number;
  curvature?: number;
  bankingRad?: number;
}

/**
 * Analytic projection onto the continuous straight 4-lane highway along the +Z axis.
 * Because the highway is perfectly straight (x = 0, heading = 0 along +Z),
 * projection is exact and continuous for any Z coordinate from -Infinity to +Infinity.
 */
export function projectWorldToTrack(
  _trackId: TrackId,
  x: number,
  z: number,
): TrackProjection {
  const continuousS =
    (((z / HIGHWAY_SEGMENT_LENGTH) % 1) + 1) % 1;
  // With forward tangent (tx = 0, tz = 1), right-hand normal is (nx = -1, nz = 0)
  const lateralOffset = -x;

  return {
    s: continuousS,
    centerX: 0,
    centerZ: z,
    tx: 0,
    tz: 1,
    nx: -1,
    nz: 0,
    lateralOffset,
    halfWidth: HIGHWAY_TOTAL_WIDTH * 0.5,
    trackHeading: 0,
    curvature: 0,
    bankingRad: 0,
  };
}

export function getStartGridTransform(
  _trackId: TrackId,
  slotIndex: number,
): { x: number; z: number; heading: number; s: number } {
  // Spawn all 4 racers side-by-side across the 4 distinct highway lanes (world X: 1.9, -1.9, 5.7, -5.7)
  const laneOrder = [-1.9, 1.9, -5.7, 5.7];
  const lateral = laneOrder[slotIndex % laneOrder.length];
  const baseZ = 64;
  const baseS = baseZ / HIGHWAY_SEGMENT_LENGTH;

  return {
    x: -lateral, // nx = -1 -> world x = -lateral
    z: baseZ,
    heading: 0,
    s: baseS,
  };
}
