import {
  evaluateTrackSpline,
  getStartGridTransform,
  projectWorldToTrack,
  TRACK_CATALOG,
} from './track';
import { findSafeLaneForAi, TrafficVehicle } from './traffic';
import {
  CHASSIS_CATALOG,
  computeCarStats,
} from './tuning';
import {
  CarConfig,
  RacerState,
  RaceSummary,
  RivalArchetype,
  RivalDifficulty,
  RivalDifficultySpec,
  TrackId,
} from './types';

export const RIVAL_DIFFICULTY_CATALOG: Record<
  RivalDifficulty,
  RivalDifficultySpec
> = {
  rookie: {
    id: 'rookie',
    label: 'Rookie Street',
    shortLabel: 'Rookie',
    speedMultiplier: 0.82,
    accelMultiplier: 0.84,
    aggression: 0.35,
    prizeMultiplier: 0.85,
    upgradeStage: 0,
    description:
      'Cautious braking in corners, lower top speed (82%), and minimal lane blocking.',
  },
  pro: {
    id: 'pro',
    label: 'Underground Pro',
    shortLabel: 'Pro',
    speedMultiplier: 0.92,
    accelMultiplier: 0.94,
    aggression: 0.7,
    prizeMultiplier: 1.0,
    upgradeStage: 1,
    description:
      'Balanced street pace (92% speed), active apex hunting, and defensive positioning.',
  },
  underground_king: {
    id: 'underground_king',
    label: 'Blacklist King',
    shortLabel: 'King',
    speedMultiplier: 1.03,
    accelMultiplier: 1.06,
    aggression: 1.0,
    prizeMultiplier: 1.35,
    upgradeStage: 3,
    description:
      'Maximum aggression (100%), Stage 3 rival tuning (103% speed), late braking, and relentless N2O purges.',
  },
};

export interface PlayerInputState {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 (left) .. +1 (right)
  handbrake: boolean;
  nitrous: boolean;
  desiredLaneX?: number;
}

export interface StepPhysicsResult {
  wallImpactMagnitude: number;
  carCollisionMagnitude: number;
  gearShifted: boolean;
  driftBankedPoints: number;
  raceJustFinished: boolean;
}

const GEAR_RATIOS = [3.25, 2.15, 1.58, 1.24, 1.02, 0.86];
const WHEELBASE_METERS = 2.66;
const CG_HEIGHT_METERS = 0.48;

/**
 * World X coordinates of the 4 unified highway lanes ordered from screen-LEFT (lane 0) to screen-RIGHT (lane 3).
 * Since camera looks along +Z, +X is screen-left and -X is screen-right.
 */
export const HIGHWAY_WORLD_LANE_X = [5.7, 1.9, -1.9, -5.7] as const;

export function findNearestHighwayLaneIndex(worldX: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < HIGHWAY_WORLD_LANE_X.length; i++) {
    const d = Math.abs(worldX - HIGHWAY_WORLD_LANE_X[i]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Computes critically-damped, speed-adaptive highway steering control:
 * Scales lane-change heading angle inversely with forward speed and applies derivative
 * damping on angular velocity so lane changes at any speed (60..300+ km/h) never wobble or overshoot.
 */
export function computeHighwaySteerControl(
  worldX: number,
  headingRad: number,
  rawSteerInput: number,
  targetLaneX: number | null,
  handbrake = false,
  forwardSpeedMs = 32,
  angularVelocity = 0,
): number {
  const effSpeed = Math.max(18, Math.abs(forwardSpeedMs));
  const maxWeaveRad = handbrake
    ? 0.48
    : Math.min(0.18, 7.6 / effSpeed);
  const maxSteerOut = handbrake ? 1.0 : 0.62;

  // Active manual steering (if used without a target lane)
  if (Math.abs(rawSteerInput) > 0.08 && targetLaneX === null) {
    if (
      (rawSteerInput < 0 && worldX >= 5.85) ||
      (rawSteerInput > 0 && worldX <= -5.85)
    ) {
      const edgeTargetX = rawSteerInput < 0 ? 5.7 : -5.7;
      const edgeErr = edgeTargetX - worldX;
      const desiredEdgeHeading = Math.max(
        -0.08,
        Math.min(0.08, (edgeErr * 4.0) / effSpeed),
      );
      return Math.max(
        -maxSteerOut,
        Math.min(maxSteerOut, -(desiredEdgeHeading - headingRad) * 3.2),
      );
    }
    const desiredHeading = -rawSteerInput * maxWeaveRad;
    const headingError = desiredHeading - headingRad;
    return Math.max(
      -maxSteerOut,
      Math.min(maxSteerOut, -headingError * 3.2),
    );
  }

  // Critically-damped lane-centering & automatic nose-straightening (heading -> 0)
  const laneErrorX = targetLaneX !== null ? targetLaneX - worldX : 0;
  if (
    Math.abs(laneErrorX) < 0.015 &&
    Math.abs(headingRad) < 0.005 &&
    Math.abs(angularVelocity) < 0.02
  ) {
    return 0;
  }

  // Target lateral velocity proportional to remaining lane distance, capped at 7.4 m/s
  const desiredLateralVx = Math.max(
    -7.4,
    Math.min(7.4, laneErrorX * 5.8),
  );
  const desiredHeadingFromLane = Math.max(
    -maxWeaveRad,
    Math.min(maxWeaveRad, desiredLateralVx / effSpeed),
  );
  const headingError = desiredHeadingFromLane - headingRad;
  const steerCmd = -headingError * 4.2;
  if (Math.abs(steerCmd) < 0.004) return 0;
  return Math.max(-maxSteerOut, Math.min(maxSteerOut, steerCmd));
}

export interface ProgressiveHighwayPace {
  /** Target highway speed in m/s at the current elapsed race time */
  targetSpeedMs: number;
  /** Target highway speed in km/h at the current elapsed race time */
  targetSpeedKmh: number;
  /** Regulated throttle command (0..1) so the car gradually builds speed along the progressive ramp */
  throttle: number;
  /** Regulated brake command (0..1) */
  brake: number;
}

/**
 * Computes the uniform progressive highway speed-up and acceleration curve shared identically by all 4 players:
 * - Braking is completely disabled (`brake: 0`).
 * - All 4 players start at ~97 km/h (27.0 m/s) and accelerate with the exact same linear rate (1.45 m/s²)
 *   and the exact same top speed limit (82.0 m/s = 295 km/h).
 */
export function computeProgressiveHighwayPace(
  currentSpeedMs: number,
  elapsedSec: number,
  _isAcceleratingManually = false,
  _brakeInput = 0,
): ProgressiveHighwayPace {
  const baseStartMs = 27.0; // ~97 km/h brisk highway rolling start for all 4 players
  const rampRateMs2 = 1.45; // Uniform ~5.2 km/h/s acceleration rate for all 4 players
  const maxCeilingMs = 82.0; // Uniform ~295 km/h speed limit for all 4 players
  const rawTargetSpeedMs = Math.min(
    maxCeilingMs,
    baseStartMs + Math.max(0, elapsedSec) * rampRateMs2,
  );
  const targetSpeedMs = Math.min(rawTargetSpeedMs, currentSpeedMs + 2.2);
  const targetSpeedKmh = Math.round(targetSpeedMs * 3.6);

  const speedDiff = targetSpeedMs - currentSpeedMs;
  const throttle =
    speedDiff <= -0.35
      ? 0.04
      : Math.max(
          0.18,
          Math.min(0.96, 0.24 + speedDiff * 0.24 + (elapsedSec / 35) * 0.48),
        );

  return {
    targetSpeedMs,
    targetSpeedKmh,
    throttle,
    brake: 0,
  };
}

/**
 * Steps linear, physical (non-cardboard) lane-hop kinematics for a highway racer:
 * - Moves `racer.x` directly from `hopStartX` to `desiredLaneX` along a responsive linear-eased profile
 *   while keeping `racer.heading = 0` so forward motion along +Z remains strictly linear.
 * - Computes a parabolic vertical jump arc (`hopHeightY`), dynamic takeoff nose-up pitch & descent tuck (`hopPitchRad`),
 *   lateral banking roll (`hopRollRad`), subtle mid-air nose yaw tuck (`hopYawRad`), and damped landing shock compression
 *   (`hopLandingCompressionY`) so the lane jump looks weighty, articulated, and alive.
 */
export function stepLaneHopKinematics(
  racer: RacerState,
  desiredLaneX: number,
  dt: number,
): void {
  racer.hopJustTookOff = false;
  racer.hopJustLanded = false;

  if (racer.eliminated) {
    racer.hopHeightY = 0;
    racer.hopPitchRad = 0;
    racer.hopRollRad = 0;
    racer.hopYawRad = 0;
    racer.hopLandingCompressionY = 0;
    racer.hopLandingTimer = 0;
    return;
  }

  if (
    racer.hopTargetX === undefined ||
    racer.hopStartX === undefined ||
    racer.hopProgress === undefined
  ) {
    racer.hopStartX = racer.x;
    racer.hopTargetX = desiredLaneX;
    racer.hopProgress = Math.abs(desiredLaneX - racer.x) > 0.05 ? 0 : 1;
    racer.hopDirection = Math.sign(desiredLaneX - racer.x);
    racer.hopHeightY = 0;
    racer.hopPitchRad = 0;
    racer.hopRollRad = 0;
    racer.hopYawRad = 0;
    racer.hopLandingCompressionY = 0;
    racer.hopLandingTimer = 0;
    if (racer.hopProgress === 0) {
      racer.hopJustTookOff = true;
    }
  }

  // Trigger a new lane hop (or mid-air chain hop) whenever the target lane changes
  if (Math.abs(desiredLaneX - racer.hopTargetX) > 0.05) {
    racer.hopStartX = racer.x;
    racer.hopTargetX = desiredLaneX;
    racer.hopProgress = 0;
    racer.hopDirection = Math.sign(desiredLaneX - racer.x);
    racer.hopLandingTimer = 0;
    racer.hopLandingCompressionY = 0;
    racer.hopJustTookOff = true;
  }

  if (racer.hopProgress < 1) {
    const spanDist = Math.abs(racer.hopTargetX - racer.hopStartX);
    // Crisp ~0.20s hop across a 3.8m lane (scales slightly if hopping across multiple lanes)
    const hopDurationSec = Math.max(
      0.15,
      Math.min(0.27, 0.20 * Math.max(0.8, spanDist / 3.8)),
    );
    const nextProgress = Math.min(1, racer.hopProgress + dt / hopDurationSec);
    racer.hopProgress = nextProgress;

    // Responsive linear-sine blend: immediate linear authority off the line + smooth zero-overshoot landing
    const easeX =
      0.42 * nextProgress + 0.58 * Math.sin(nextProgress * Math.PI * 0.5);
    const prevX = racer.x;
    racer.x = racer.hopStartX + (racer.hopTargetX - racer.hopStartX) * easeX;
    racer.vx = dt > 0.0001 ? (racer.x - prevX) / dt : 0;
    racer.heading = 0;
    racer.angularVelocity = 0;
    racer.steerAngle = 0;
    racer.slipAngleRad = 0;
    racer.isDrifting = false;

    const dir = racer.hopDirection ?? 1;
    const sinArc = Math.sin(nextProgress * Math.PI);
    const spanScale = Math.min(1.25, Math.max(0.75, spanDist / 3.8));

    // Parabolic vertical hop arc (~0.52m peak height)
    racer.hopHeightY = sinArc * 0.52 * spanScale;
    // Takeoff nose-up pitch -> mid-air level -> descent nose tuck
    racer.hopPitchRad =
      -Math.sin(nextProgress * Math.PI * 2) * 0.058 * spanScale;
    // Dynamic chassis roll banking into the jump direction + subtle S-rebound in air
    racer.hopRollRad =
      (-dir * sinArc * 0.148 -
        dir * Math.sin(nextProgress * Math.PI * 2) * 0.04) *
      spanScale;
    // Subtle nose tuck into the target lane that straightens before touchdown
    racer.hopYawRad = dir * sinArc * 0.052 * spanScale;
    racer.hopLandingCompressionY = 0;

    if (nextProgress >= 1) {
      racer.x = racer.hopTargetX;
      racer.vx = 0;
      racer.hopHeightY = 0;
      racer.hopYawRad = 0;
      racer.hopJustLanded = true;
      racer.hopLandingTimer = 0.18;
    }
    return;
  }

  // Grounded in target lane: keep X locked linearly to hopTargetX and run damped landing shock compression
  racer.x = racer.hopTargetX;
  racer.vx = 0;
  racer.heading = 0;
  racer.angularVelocity = 0;
  racer.steerAngle = 0;
  racer.hopHeightY = 0;
  racer.hopYawRad = 0;

  if ((racer.hopLandingTimer ?? 0) > 0) {
    racer.hopLandingTimer = Math.max(0, (racer.hopLandingTimer ?? 0) - dt);
    const u = 1 - (racer.hopLandingTimer ?? 0) / 0.18; // 0 -> 1 over 180ms
    const dir = racer.hopDirection ?? 1;
    // Shocks compress downward on touchdown (-0.072m) and rebound smoothly
    racer.hopLandingCompressionY =
      -Math.sin(u * Math.PI) * Math.exp(-u * 2.0) * 0.072;
    racer.hopPitchRad = Math.sin(u * Math.PI * 1.5) * (1 - u) * 0.032;
    racer.hopRollRad = dir * Math.sin(u * Math.PI) * (1 - u) * 0.062;
  } else {
    racer.hopLandingCompressionY = 0;
    racer.hopPitchRad = 0;
    racer.hopRollRad = 0;
  }
}

export interface FourPlayerCameraFrame {
  camX: number;
  camY: number;
  camZ: number;
  lookAtX: number;
  lookAtY: number;
  lookAtZ: number;
  minZ: number;
  maxZ: number;
  packSpreadZ: number;
  aliveCount: number;
}

/**
 * Synchronizes all 4 active human players on the highway so they share the exact same
 * acceleration time, speed limit, longitudinal speed (`vz`), and longitudinal position (`z`).
 */
export function syncFourPlayerHighwayPack(
  racers: RacerState[],
  _elapsedSec: number,
  _dt: number,
): void {
  const aliveRacers = racers.filter((r) => !r.eliminated);
  if (aliveRacers.length === 0) return;

  const leader = aliveRacers[0];
  const anchorZ = leader.z;
  const anchorVz = leader.vz;
  const anchorRpm = leader.rpm;
  const anchorGear = leader.gear;

  for (let i = 0; i < racers.length; i++) {
    const r = racers[i];
    if (r.eliminated) continue;

    r.z = anchorZ;
    r.vz = anchorVz;
    r.gear = anchorGear;
    r.rpm = anchorRpm;
    r.speedMs = Math.hypot(r.vx, r.vz);
    r.speedKmh = Math.round(r.speedMs * 3.6);
  }
}

/**
 * Computes a camera target and look-at position that constantly frames all 4 active racers
 * across the 4-lane highway while maintaining clear forward visibility for incoming traffic.
 */
export function computeFourPlayerCameraFrame(
  racers: RacerState[],
): FourPlayerCameraFrame {
  const alive = racers.filter((r) => !r.eliminated);
  const activeSet = alive.length > 0 ? alive : racers.slice(0, 1);
  const player = racers[0];

  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxSpeedKmh = 95;
  for (const r of activeSet) {
    if (r.z < minZ) minZ = r.z;
    if (r.z > maxZ) maxZ = r.z;
    if (r.speedKmh > maxSpeedKmh) maxSpeedKmh = r.speedKmh;
  }
  if (!Number.isFinite(minZ)) {
    minZ = 64;
    maxZ = 64;
  }

  const packSpreadZ = Math.max(0, maxZ - minZ);
  // Anchor Z smoothly to the player (or pack center if player is eliminated) so the camera never jumps between minZ/maxZ on brake release
  const anchorZ =
    player && !player.eliminated ? player.z : (minZ + maxZ) * 0.5;
  const speedAltitudeBonus = Math.min(6.5, (maxSpeedKmh / 260) * 6.5);
  const spreadAltitudeBonus = Math.min(8.0, packSpreadZ * 0.55);

  // Camera X is strictly locked to 0 (center of the 4-lane highway) so all 4 lanes stay symmetrically framed
  const camX = 0;
  const camY = 34.5 + speedAltitudeBonus + spreadAltitudeBonus;
  const camZ = Math.min(anchorZ - 5.6, minZ - 4.8);

  const lookAtX = 0;
  const lookAtY = 0.4;
  const lookAtZ = Math.max(
    anchorZ + 14.5 + Math.min(3.5, (maxSpeedKmh / 260) * 3.5),
    maxZ + 11.5,
  );

  return {
    camX,
    camY,
    camZ,
    lookAtX,
    lookAtY,
    lookAtZ,
    minZ,
    maxZ,
    packSpreadZ,
    aliveCount: alive.length,
  };
}

export interface FourPlayerSessionStatus {
  /** Number of non-eliminated human players still racing on the highway (0..4) */
  aliveCount: number;
  /** Number of eliminated players who have crashed into traffic (0..4) */
  eliminatedCount: number;
  /**
   * True ONLY when the Last Player Standing has been decided (`aliveCount <= 1` in a 4-player session).
   * If Player 1 (`racers[0]`) crashes first while 2 or 3 other players remain alive (`aliveCount >= 2`),
   * `isSessionOver` remains `false` so the surviving human players finish their round!
   */
  isSessionOver: boolean;
  /** The Last Player Standing winner when `isSessionOver === true`, or `null` while `aliveCount >= 2` */
  winner: RacerState | null;
  /** Active surviving racer used to anchor the highway, camera, and audio when `racers[0]` crashes early */
  activeAnchorRacer: RacerState;
}

/**
 * Evaluates the 4-real-player "Last Player Standing" session lifecycle:
 * - Does NOT end the round early if `racers[0]` crashes first while 2+ other players are still alive.
 * - Ends the round only when `aliveCount <= 1` (either 1 sole surviving winner remains or all 4 crashed).
 */
export function evaluateFourPlayerSessionStatus(
  racers: RacerState[],
): FourPlayerSessionStatus {
  const alive = racers.filter((r) => !r.eliminated);
  const aliveCount = alive.length;
  const eliminatedCount = racers.length - aliveCount;
  const isSessionOver = racers.length > 1 ? aliveCount <= 1 : aliveCount === 0;

  let winner: RacerState | null = null;
  if (isSessionOver) {
    if (aliveCount === 1) {
      winner = alive[0];
    } else if (racers.length > 0) {
      winner = [...racers].sort(
        (a, b) => (b.eliminatedAtSec ?? 0) - (a.eliminatedAtSec ?? 0),
      )[0];
    }
  }

  return {
    aliveCount,
    eliminatedCount,
    isSessionOver,
    winner,
    activeAnchorRacer: alive[0] ?? racers[0],
  };
}

export interface PlayerSlotVisualSignature {
  slot: number;
  label: string;
  hex: string;
  /** Normalized RGB [0..1] for lane-hop tire burst particles */
  hopDustRgb: [number, number, number];
  /** Normalized RGB [0..1] for mid-air slipstream and ghost-overlap phase sparks */
  sparkRgb: [number, number, number];
}

const FOUR_PLAYER_SIGNATURES: ReadonlyArray<PlayerSlotVisualSignature> = [
  {
    slot: 0,
    label: 'Gold',
    hex: '#fbbf24',
    hopDustRgb: [1.0, 0.78, 0.14],
    sparkRgb: [1.0, 0.88, 0.35],
  },
  {
    slot: 1,
    label: 'Cyan',
    hex: '#06b6d4',
    hopDustRgb: [0.04, 0.82, 0.96],
    sparkRgb: [0.38, 0.94, 1.0],
  },
  {
    slot: 2,
    label: 'Crimson',
    hex: '#f43f5e',
    hopDustRgb: [0.98, 0.24, 0.38],
    sparkRgb: [1.0, 0.48, 0.58],
  },
  {
    slot: 3,
    label: 'Emerald',
    hex: '#10b981',
    hopDustRgb: [0.08, 0.88, 0.56],
    sparkRgb: [0.36, 0.98, 0.72],
  },
];

/**
 * Returns the distinct visual neon & hop-trail signature for each of the 4 human players (Slots 0..3)
 * so every player can identify their car and jump arc without any HUD overlay.
 */
export function getPlayerSlotSignature(
  slotIndex: number,
): PlayerSlotVisualSignature {
  const idx = ((Math.floor(slotIndex) % 4) + 4) % 4;
  return FOUR_PLAYER_SIGNATURES[idx];
}

export interface PaintSwatchSpec {
  name: string;
  hex: string;
}

export const LOBBY_PAINT_SWATCHES: ReadonlyArray<PaintSwatchSpec> = [
  { name: 'Blue', hex: '#2563eb' },
  { name: 'Gold', hex: '#fbb124' },
  { name: 'Cyan', hex: '#06b6d4' },
  { name: 'Crimson', hex: '#f43f5e' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Violet', hex: '#a855f7' },
];

/**
 * Normalizes any paint hex into a canonical lowercase hex from `LOBBY_PAINT_SWATCHES`
 * (mapping legacy aliases like #facc15/#fbbf24 -> #fbb124, #1d4ed8 -> #2563eb, #dc2626 -> #f43f5e).
 */
export function normalizePaintHex(hex: string): string {
  const clean = (hex || '').trim().toLowerCase();
  if (clean === '#facc15' || clean === '#fbbf24' || clean === '#f59e0b') {
    return '#fbb124';
  }
  if (clean === '#1d4ed8' || clean === '#3b82f6') {
    return '#2563eb';
  }
  if (clean === '#dc2626' || clean === '#ef4444') {
    return '#f43f5e';
  }
  if (clean === '#7c3aed') {
    return '#a855f7';
  }
  const match = LOBBY_PAINT_SWATCHES.find(
    (sw) => sw.hex.toLowerCase() === clean,
  );
  return match
    ? match.hex.toLowerCase()
    : LOBBY_PAINT_SWATCHES[0].hex.toLowerCase();
}

export function getPaintSwatchName(hex: string): string {
  const norm = normalizePaintHex(hex);
  const found = LOBBY_PAINT_SWATCHES.find(
    (sw) => sw.hex.toLowerCase() === norm,
  );
  return found ? found.name : 'Custom';
}

/**
 * Resolves 4 strictly unique paint colors for the 4 highway lanes `[lane0, lane1 (Player), lane2, lane3]`.
 * - Lane 1 (`P1 • YOU`) always keeps `normalizePaintHex(playerColorHex)`.
 * - Lanes 0 (`P2`), 2 (`P3`), and 3 (`P4`) preserve their preferred paint color if and only if
 *   it is not already occupied by `P1` or an earlier lane; otherwise they are assigned the first
 *   available unoccupied color from `LOBBY_PAINT_SWATCHES`.
 */
export function resolveUniqueLanePaintColors(
  playerColorHex: string,
  preferredRemoteColors?: Partial<Record<0 | 2 | 3, string>>,
): [string, string, string, string] {
  const p1Color = normalizePaintHex(playerColorHex);
  const taken = new Set<string>([p1Color]);

  const defaults: Record<0 | 2 | 3, string> = {
    0: '#2563eb',
    2: '#06b6d4',
    3: '#f43f5e',
  };

  const assignForLane = (lane: 0 | 2 | 3): string => {
    const rawPref = preferredRemoteColors?.[lane] ?? defaults[lane];
    const normPref = normalizePaintHex(rawPref);
    if (!taken.has(normPref)) {
      taken.add(normPref);
      return normPref;
    }
    for (const sw of LOBBY_PAINT_SWATCHES) {
      const candidate = sw.hex.toLowerCase();
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
    return normPref;
  };

  const lane0Color = assignForLane(0);
  const lane2Color = assignForLane(2);
  const lane3Color = assignForLane(3);

  return [lane0Color, p1Color, lane2Color, lane3Color];
}

export interface RemoteSlotColorOccupancy {
  laneIndex: 0 | 2 | 3;
  slotCode: string;
  nickname: string;
  paintColor: string;
  occupied: boolean;
}

/**
 * Checks whether a candidate paint color (`targetHex`) is currently occupied by another active player in the lobby.
 * Waiting/empty slots (`occupied === false`) do not lock a color.
 */
export function getPaintColorOccupancy(
  targetHex: string,
  remoteSlots: ReadonlyArray<RemoteSlotColorOccupancy>,
): { taken: boolean; holderSlotCode?: string; holderNickname?: string } {
  const normTarget = normalizePaintHex(targetHex);
  for (const slot of remoteSlots) {
    if (!slot.occupied) continue;
    if (normalizePaintHex(slot.paintColor) === normTarget) {
      return {
        taken: true,
        holderSlotCode: slot.slotCode,
        holderNickname: slot.nickname,
      };
    }
  }
  return { taken: false };
}

/**
 * Pacejka-inspired non-linear tire lateral force curve:
 * Rises sharply for small slip angles (high cornering stiffness),
 * peaks around ~7-9 degrees, and plateaus smoothly in a controllable drift slide.
 */
export function evaluatePacejkaTireGrip(
  slipAngleRad: number,
  peakSlipRad: number,
  slideRatio: number,
): number {
  const absSlip = Math.abs(slipAngleRad);
  const sign = Math.sign(slipAngleRad);
  if (absSlip < 0.0001) return 0;

  const x = absSlip / Math.max(0.04, peakSlipRad);
  // Magic Formula style bell + plateau
  const B = 1.45;
  const C = 1.38;
  const D = 1.0;
  const E = 0.35;
  const bx = B * x;
  const raw =
    D *
    Math.sin(
      C * Math.atan(bx - E * (bx - Math.atan(bx))),
    );
  // Ensure plateau doesn't drop below slideRatio at extreme drift angles
  const clampedMag =
    x <= 1.0 ? raw : Math.max(slideRatio, raw);
  return sign * clampedMag;
}

export interface EngineTorqueAndLimiterState {
  /** Normalized engine torque output from RPM bell curve & turbo boost (0..1.25) */
  engineTorqueFactor: number;
  /** Normalized quadratic aerodynamic drag (v^2) + rolling resistance opposition (0..1.5+) */
  dragOppositionFactor: number;
  /** ECU rev-limiter fuel-cut multiplier (1.0 normal, oscillates in soft cut, 0.0 at hard cut) */
  revLimiterFactor: number;
  /** Net drive thrust multiplier combining torque curve, drag opposition, and ECU rev limiter */
  netDriveFactor: number;
  /** True when the engine is hitting the ECU rev limiter near peak RPM / top speed threshold */
  isHittingRevLimiter: boolean;
}

/**
 * Calculates the engine torque curve across the RPM powerband, quadratic aerodynamic drag (v^2)
 * opposition, and the ECU redline rev-limiter cut near the peak performance threshold.
 */
export function evaluateEngineTorqueAndLimiter(
  forwardSpeedMs: number,
  effectiveMaxSpeedMs: number,
  rpm: number,
  redlineRpm: number,
  turboBoostBar: number,
  totalDownforceCoeff: number,
  elapsedSec = 0,
): EngineTorqueAndLimiterState {
  const safeMaxSpeed = Math.max(1, effectiveMaxSpeedMs);
  const speedRatio = Math.max(0, forwardSpeedMs / safeMaxSpeed);
  const rpmRatio = Math.max(
    0.15,
    Math.min(1.05, rpm / Math.max(4000, redlineRpm)),
  );

  // 1. Engine Torque Curve across RPM powerband + Turbocharger Spool
  // Builds from low-RPM into a strong mid-range turbo plateau (0.50..0.86 redline),
  // then tapers slightly near peak horsepower before the redline fuel cut.
  const rpmBellCurve =
    0.78 +
    0.26 * Math.sin(Math.min(1, Math.max(0, (rpmRatio - 0.12) / 0.88)) * Math.PI * 0.86);
  const turboSpoolBonus =
    turboBoostBar > 0 ? 1 + turboBoostBar * 0.28 : 0.94;
  const engineTorqueFactor = rpmBellCurve * turboSpoolBonus;

  // 2. Quadratic Aerodynamic Drag (v^2) + Rolling Resistance Curve
  const aeroWeight = 0.76 + Math.min(0.1, totalDownforceCoeff * 0.05);
  const rollingWeight = 1 - aeroWeight;
  const dragOppositionFactor =
    aeroWeight * (speedRatio * speedRatio) + rollingWeight * speedRatio;

  // 3. ECU Redline Rev-Limiter near peak performance threshold
  const isHittingRevLimiter =
    speedRatio >= 0.985 || (rpmRatio >= 0.982 && speedRatio >= 0.9);

  let revLimiterFactor = 1.0;
  if (speedRatio >= 1.0) {
    // Hard ECU fuel cut at peak speed threshold
    revLimiterFactor = 0.0;
  } else if (isHittingRevLimiter) {
    // Rapid ECU rev-limiter fuel-cut flutter near redline (98.5%..100% peak threshold)
    const limiterDepth = Math.max(
      0,
      Math.min(1, (1.0 - speedRatio) / 0.015),
    );
    const flutterPulse = 0.55 + 0.45 * Math.sin(elapsedSec * 90);
    revLimiterFactor = Math.max(0.18, limiterDepth * flutterPulse);
  }

  // 4. Net Drive Multiplier (ensures positive top-gear pull up to the rev-limiter threshold, then cuts at cap)
  const rawAeroHeadroom =
    speedRatio < 1.0
      ? Math.max(0.095, Math.pow(1 - Math.min(1, dragOppositionFactor), 0.92))
      : 0;
  const netDriveFactor =
    speedRatio >= 1.0
      ? 0
      : rawAeroHeadroom * engineTorqueFactor * revLimiterFactor;

  return {
    engineTorqueFactor,
    dragOppositionFactor,
    revLimiterFactor,
    netDriveFactor,
    isHittingRevLimiter,
  };
}


export function createInitialRacers(
  trackId: TrackId,
  playerConfig: CarConfig,
  lanePaintColors?: [string, string, string, string],
): RacerState[] {
  const playerSpawn = getStartGridTransform(trackId, 0);
  const [lane0Color, lane1Color, lane2Color, lane3Color] =
    resolveUniqueLanePaintColors(
      playerConfig.paintColor,
      lanePaintColors
        ? {
            0: lanePaintColors[0],
            2: lanePaintColors[2],
            3: lanePaintColors[3],
          }
        : undefined,
    );

  // slot 1 spawns on Lane 2 (x = -1.9, P3), slot 2 spawns on Lane 0 (x = 5.7, P2), slot 3 spawns on Lane 3 (x = -5.7, P4)
  const rivalsMeta: Array<{
    id: string;
    name: string;
    crew: string;
    archetype: RivalArchetype;
    chassis: CarConfig['chassis'];
    paintColor: string;
    underglowColor: string;
    slot: number;
  }> = [
    {
      id: 'rival_kuro',
      name: 'Kenshin_01',
      crew: 'Midnight Wangan',
      archetype: 'grip_runner',
      chassis: 'rx7',
      paintColor: lane2Color,
      underglowColor: lane2Color,
      slot: 1,
    },
    {
      id: 'rival_takumi',
      name: 'Vortex_02',
      crew: 'RedSuns East',
      archetype: 'drift_king',
      chassis: 'rx7',
      paintColor: lane0Color,
      underglowColor: lane0Color,
      slot: 2,
    },
    {
      id: 'rival_razor',
      name: 'Apex_03',
      crew: 'Bayview Kings',
      archetype: 'nitro_interceptor',
      chassis: 'rx7',
      paintColor: lane3Color,
      underglowColor: lane3Color,
      slot: 3,
    },
  ];

  const playerState: RacerState = {
    id: 'player',
    name: 'YOU // Underground Challenger',
    crew: 'ARC STREETRACING',
    isPlayer: true,
    chassis: playerConfig.chassis,
    paintColor: lane1Color,
    underglowColor: lane1Color,
    x: playerSpawn.x,
    z: playerSpawn.z,
    heading: playerSpawn.heading,
    vx: 0,
    vz: 0,
    speedMs: 0,
    speedKmh: 0,
    lateralVelocity: 0,
    angularVelocity: 0,
    steerAngle: 0,
    slipAngleRad: 0,
    isDrifting: false,
    isBraking: false,
    isBoosting: false,
    rpm: 1100,
    gear: 1,
    turboBoostBar: -0.3,
    nitrousRemaining: 100,
    trackProgress: playerSpawn.s,
    totalProgress: playerSpawn.s,
    lap: 1,
    finished: false,
    finishTimeSec: 0,
    currentDriftScore: 0,
    totalDriftScore: 0,
    driftMultiplier: 1,
    driftComboTimer: 0,
    hitFlashTimer: 0,
    exhaustFlameIntensity: 0,
    longitudinalG: 0,
    lateralG: 0,
    wheelspinIntensity: 0,
    curbRumbleIntensity: 0,
    shiftTimer: 0,
    brakeHeat: 0,
  };

  const rivals: RacerState[] = rivalsMeta.map((r) => {
    const sp = getStartGridTransform(trackId, r.slot);
    return {
      id: r.id,
      name: r.name,
      crew: r.crew,
      isPlayer: false,
      archetype: r.archetype,
      chassis: r.chassis,
      paintColor: r.paintColor,
      underglowColor: r.underglowColor,
      x: sp.x,
      z: sp.z,
      heading: sp.heading,
      vx: 0,
      vz: 0,
      speedMs: 0,
      speedKmh: 0,
      lateralVelocity: 0,
      angularVelocity: 0,
      steerAngle: 0,
      slipAngleRad: 0,
      isDrifting: false,
      isBraking: false,
      isBoosting: false,
      rpm: 1200,
      gear: 1,
      turboBoostBar: 0,
      nitrousRemaining: 100,
      trackProgress: sp.s,
      totalProgress: sp.s,
      lap: 1,
      finished: false,
      finishTimeSec: 0,
      currentDriftScore: 0,
      totalDriftScore: 0,
      driftMultiplier: 1,
      driftComboTimer: 0,
      hitFlashTimer: 0,
      exhaustFlameIntensity: 0,
      longitudinalG: 0,
      lateralG: 0,
      wheelspinIntensity: 0,
      curbRumbleIntensity: 0,
      shiftTimer: 0,
      brakeHeat: 0,
    };
  });

  return [playerState, ...rivals];
}

export interface ActiveOnlineSlotConfig {
  playerId: string;
  displayName: string;
  laneIndex: 0 | 1 | 2 | 3;
  paintColor: string;
  isLocalPlayer: boolean;
  chassis?: CarConfig['chassis'];
}

/**
 * Spawns strictly the `2..4` live human players participating in an online multiplayer room (zero AI bots).
 * Places each human player on their assigned lane (`HIGHWAY_WORLD_LANE_X[slot.laneIndex]`) with their
 * server-reserved unique paint color and uniform brisk rolling start (95 km/h).
 */
export function createOnlineHumanRacers(
  trackId: TrackId,
  activeSlots: ReadonlyArray<ActiveOnlineSlotConfig>,
): RacerState[] {
  const baseSpawn = getStartGridTransform(trackId, 0);
  const ordered = [...activeSlots].sort((a, b) => {
    if (a.isLocalPlayer && !b.isLocalPlayer) return -1;
    if (!a.isLocalPlayer && b.isLocalPlayer) return 1;
    return a.laneIndex - b.laneIndex;
  });

  return ordered.map((slot) => {
    const laneX = HIGHWAY_WORLD_LANE_X[slot.laneIndex] ?? 1.9;
    const color = normalizePaintHex(slot.paintColor);
    return {
      id: slot.playerId,
      name: slot.displayName,
      crew: 'Arc Online',
      isPlayer: slot.isLocalPlayer,
      chassis: slot.chassis ?? 'rx7',
      paintColor: color,
      underglowColor: color,
      x: laneX,
      z: baseSpawn.z,
      heading: 0,
      vx: 0,
      vz: 26.5,
      speedMs: 26.5,
      speedKmh: 95,
      lateralVelocity: 0,
      angularVelocity: 0,
      steerAngle: 0,
      slipAngleRad: 0,
      isDrifting: false,
      isBraking: false,
      isBoosting: false,
      rpm: 4200,
      gear: 3,
      turboBoostBar: 0,
      nitrousRemaining: 100,
      trackProgress: baseSpawn.s,
      totalProgress: baseSpawn.s,
      lap: 1,
      finished: false,
      finishTimeSec: 0,
      currentDriftScore: 0,
      totalDriftScore: 0,
      driftMultiplier: 1,
      driftComboTimer: 0,
      hitFlashTimer: 0,
      exhaustFlameIntensity: 0,
      longitudinalG: 0,
      lateralG: 0,
      wheelspinIntensity: 0,
      curbRumbleIntensity: 0,
      shiftTimer: 0,
      brakeHeat: 0,
      eliminated: false,
      eliminatedAtSec: undefined,
      trafficNearMisses: 0,
      ghostOverlap: 0,
      hopStartX: laneX,
      hopTargetX: laneX,
      hopProgress: 1,
      hopDirection: 0,
      hopHeightY: 0,
      hopPitchRad: 0,
      hopRollRad: 0,
      hopYawRad: 0,
      hopLandingCompressionY: 0,
      hopLandingTimer: 0,
      hopJustTookOff: false,
      hopJustLanded: false,
    };
  });
}

function normalizeAngleDiff(a: number): number {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function computeRivalControls(
  rival: RacerState,
  player: RacerState,
  trackId: TrackId,
  elapsedSec: number,
  difficulty: RivalDifficulty = 'pro',
  traffic: TrafficVehicle[] = [],
): PlayerInputState {
  if (rival.eliminated) {
    return { throttle: 0, brake: 1, steer: 0, handbrake: true, nitrous: false };
  }

  const diffSpec = RIVAL_DIFFICULTY_CATALOG[difficulty];
  const aggr = diffSpec.aggression;

  // Dynamic speed-scaled lookahead distance along spline so rivals apex smoothly at high speed
  const speedLookAheadBonus = Math.min(0.025, (rival.speedMs / 85) * 0.022);
  const baseLookAheadS =
    rival.archetype === 'grip_runner'
      ? 0.034
      : rival.archetype === 'drift_king'
        ? 0.042
        : 0.031;
  const lookAheadS = baseLookAheadS + speedLookAheadBonus;

  const farLookAheadS = lookAheadS * 2.15;
  const targetSample = evaluateTrackSpline(
    trackId,
    rival.trackProgress + lookAheadS,
  );
  const farSample = evaluateTrackSpline(
    trackId,
    rival.trackProgress + farLookAheadS,
  );

  // Measure upcoming corner curvature & direction
  const nearHeading = Math.atan2(targetSample.tx, targetSample.tz);
  const farHeading = Math.atan2(farSample.tx, farSample.tz);
  const cornerDelta = normalizeAngleDiff(farHeading - nearHeading);
  const cornerSharpness = Math.abs(cornerDelta);
  const turnDir = Math.sign(cornerDelta);

  // Distinct home highway lane per rival archetype across the 4 unified lanes (-5.7, -1.9, 1.9, 5.7)
  let laneOffset = 1.9;
  if (rival.archetype === 'grip_runner') {
    laneOffset = 1.9;
  } else if (rival.archetype === 'drift_king') {
    laneOffset = -5.7;
  } else if (rival.archetype === 'nitro_interceptor') {
    laneOffset = 5.7;
  }

  // Scan ahead for civilian passenger cars & heavy cargo trucks and weave into an open lane (after initial 4-lane start formation)
  if (traffic.length > 0 && elapsedSec > 1.2) {
    const mistakeFactor = Math.max(
      0,
      Math.min(0.95, (1.1 - aggr) * 0.45 + (elapsedSec / 65) * 0.45),
    );
    const safeCheck = findSafeLaneForAi(
      rival,
      traffic,
      laneOffset,
      mistakeFactor,
    );
    laneOffset = safeCheck.targetOffset;
  }

  const maxLane = targetSample.width * 0.5 - 2.1;
  laneOffset = Math.max(-maxLane, Math.min(maxLane, laneOffset));

  const aimX = targetSample.x + targetSample.nx * laneOffset;
  const aimZ = targetSample.z + targetSample.nz * laneOffset;
  const desiredHeading = Math.atan2(aimX - rival.x, aimZ - rival.z);
  const headingErr = normalizeAngleDiff(desiredHeading - rival.heading);

  // Counter-steer blend if rival's rear is sliding so AI stabilizes drifts like a real driver
  const slipCorrection = rival.slipAngleRad * 0.55;
  const maxAiSteer = cornerSharpness < 0.1 ? 0.65 : 1.0;
  const steer =
    traffic.length > 0 && cornerSharpness < 0.05
      ? computeHighwaySteerControl(
          rival.x,
          rival.heading,
          0,
          -laneOffset,
          false,
          rival.speedMs,
          rival.angularVelocity,
        )
      : Math.max(
          -maxAiSteer,
          Math.min(
            maxAiSteer,
            -headingErr * (2.25 + aggr * 0.55) + slipCorrection,
          ),
        );

  // Speed & braking policy per archetype & difficulty aggression
  let throttle = 0.84 + aggr * 0.15;
  let brake = 0;
  let handbrake = false;
  let nitrous = false;

  const cornerSpeedBias = (aggr - 0.5) * 36;

  if (rival.archetype === 'grip_runner') {
    if (cornerSharpness > 0.42 && rival.speedKmh > 140 + cornerSpeedBias) {
      throttle = 0.32 + aggr * 0.18;
      brake = Math.max(0.2, 0.65 - aggr * 0.25);
    }
  } else if (rival.archetype === 'drift_king') {
    if (cornerSharpness > 0.35 && rival.speedKmh > 120 + cornerSpeedBias) {
      handbrake = Math.abs(headingErr) > 0.22;
      throttle = 0.82 + aggr * 0.14;
    }
  } else if (rival.archetype === 'nitro_interceptor') {
    const nitroThreshold = 45 - aggr * 30;
    if (
      cornerSharpness < 0.22 &&
      rival.speedKmh > 95 &&
      rival.nitrousRemaining > nitroThreshold
    ) {
      nitrous = true;
    }
    if (cornerSharpness > 0.5 && rival.speedKmh > 160 + cornerSpeedBias) {
      throttle = 0.25 + aggr * 0.2;
      brake = Math.max(0.25, 0.7 - aggr * 0.25);
    }
  }

  // All rivals use N2O on straightaways when aggression is high
  if (
    aggr >= 0.7 &&
    cornerSharpness < 0.14 &&
    rival.speedKmh > 125 &&
    rival.nitrousRemaining > 50
  ) {
    nitrous = true;
  }

  // Rubber-banding scaled by difficulty
  const gapToPlayer = player.totalProgress - rival.totalProgress;
  if (gapToPlayer > 0.06) {
    throttle = Math.min(1, throttle + 0.06 + aggr * 0.08);
    if (aggr >= 0.7 && cornerSharpness < 0.25 && rival.nitrousRemaining > 20) {
      nitrous = true;
    }
  } else if (gapToPlayer < -0.1) {
    const slowDown =
      difficulty === 'underground_king'
        ? 0.95
        : difficulty === 'pro'
          ? 0.88
          : 0.78;
    throttle *= slowDown;
  }

  if (traffic.length > 0) {
    const rivalPace = computeProgressiveHighwayPace(
      rival.speedMs,
      elapsedSec,
      aggr >= 0.7,
      0,
    );
    return {
      throttle: rivalPace.throttle,
      brake: rivalPace.brake,
      steer,
      handbrake: false,
      nitrous: false,
      desiredLaneX: -laneOffset,
    };
  }

  return { throttle, brake, steer, handbrake, nitrous };
}

export function stepSingleRacerPhysics(
  racer: RacerState,
  input: PlayerInputState,
  config: CarConfig,
  trackId: TrackId,
  dt: number,
  elapsedSec: number,
  difficulty: RivalDifficulty = 'pro',
): StepPhysicsResult {
  if (racer.eliminated) {
    const decel = Math.max(0, 1 - 14.0 * dt);
    racer.vx *= decel;
    racer.vz *= decel;
    racer.x += racer.vx * dt;
    racer.z += racer.vz * dt;
    racer.speedMs = Math.hypot(racer.vx, racer.vz);
    racer.speedKmh = Math.round(racer.speedMs * 3.6);
    racer.isBoosting = false;
    racer.isDrifting = false;
    racer.rpm = 0;
    return {
      wallImpactMagnitude: 0,
      carCollisionMagnitude: 0,
      gearShifted: false,
      driftBankedPoints: 0,
      raceJustFinished: false,
    };
  }

  const stats = computeCarStats(config);
  const chassisSpec = CHASSIS_CATALOG[config.chassis];
  const isAWD = chassisSpec.drivetrain === 'AWD';
  const track = TRACK_CATALOG[trackId];
  const diffSpec = RIVAL_DIFFICULTY_CATALOG[difficulty];

  let wallImpactMagnitude = 0;
  let gearShifted = false;
  let driftBankedPoints = 0;
  let raceJustFinished = false;

  if (racer.hitFlashTimer > 0) {
    racer.hitFlashTimer = Math.max(0, racer.hitFlashTimer - dt);
  }
  if ((racer.shiftTimer ?? 0) > 0) {
    racer.shiftTimer = Math.max(0, (racer.shiftTimer ?? 0) - dt);
  }

  // Forward unit vector in world XZ (+Z is 0 rad, +X is +PI/2 rad)
  const sinH = Math.sin(racer.heading);
  const cosH = Math.cos(racer.heading);
  // Right unit vector
  const rightX = -cosH;
  const rightZ = sinH;

  // Decompose current world velocity into vehicle-local forward and lateral components
  const prevForwardSpeed = racer.vx * sinH + racer.vz * cosH;
  let forwardSpeed = prevForwardSpeed;
  let lateralSpeed = racer.vx * rightX + racer.vz * rightZ;

  // 1. Nitrous Oxide (N2O) System
  const canBoost =
    input.nitrous &&
    racer.nitrousRemaining > 1 &&
    input.throttle > 0.2 &&
    forwardSpeed > 8;
  racer.isBoosting = canBoost;

  if (canBoost) {
    // Higher nitrousStage increases bottle capacity efficiency; nitrousFlowRate scales burn vs thrust
    const drainRate =
      (13.2 - config.nitrousStage * 1.45) *
      Math.pow(config.nitrousFlowRate, 1.2);
    racer.nitrousRemaining = Math.max(
      0,
      racer.nitrousRemaining - drainRate * dt,
    );
    racer.exhaustFlameIntensity = Math.min(
      1,
      racer.exhaustFlameIntensity + dt * 9,
    );
  } else {
    const driftRegen =
      (racer.isDrifting ? 6.8 + config.nitrousStage * 0.8 : 1.2 + config.nitrousStage * 0.25) *
      dt;
    racer.nitrousRemaining = Math.min(
      100,
      racer.nitrousRemaining + driftRegen,
    );
    racer.exhaustFlameIntensity = Math.max(
      0,
      racer.exhaustFlameIntensity - dt * 5,
    );
  }

  // 2. Engine Torque Curve, Gear Ratios, Weight & Drivetrain Traction
  const spoilerAero =
    config.spoiler === 'twin_deck'
      ? 0.24
      : config.spoiler === 'gt_wing'
        ? 0.18
        : config.spoiler === 'ducktail'
          ? 0.08
          : 0;
  const bodyKitAero =
    config.bodyKit === 'widebody'
      ? 0.12
      : config.bodyKit === 'street'
        ? 0.05
        : 0;
  const totalDownforceCoeff = config.aeroDownforce + spoilerAero + bodyKitAero;

  const isEqualFourPlayerSession = input.desiredLaneX !== undefined;
  const maxSpeedMs =
    (stats.topSpeedKmh / 3.6) *
    (racer.isPlayer || isEqualFourPlayerSession ? 1.0 : diffSpec.speedMultiplier);
  // N2O temporarily raises the top-speed ceiling by ~17-52 km/h depending on stage & flow rate
  const nitroBonusSpeedMs = canBoost
    ? (4.8 + config.nitrousStage * 1.65) * config.nitrousFlowRate
    : 0;
  const effectiveMaxSpeedMs = maxSpeedMs + nitroBonusSpeedMs;

  // Power-to-weight scaling & tire launch traction
  const weightFactor = 1410 / Math.max(1020, stats.weightKg);
  const awdLaunchFactor =
    isAWD && forwardSpeed < 24 ? 1.18 - (forwardSpeed / 24) * 0.14 : 1.0;
  const tireTractionMult =
    forwardSpeed < 28
      ? 0.88 + config.tiresStage * 0.11
      : 0.96 + config.tiresStage * 0.04;

  // Realistic 6-speed mechanical torque multiplication + Final Drive Ratio scaling:
  // Short finalDriveRatio (4.70) multiplies low/mid-gear launch & corner-exit punch;
  // Tall finalDriveRatio (3.30) stretches gears for high-speed highway pulls
  const GEAR_TORQUE_MULTS = [1.28, 1.08, 0.91, 0.76, 0.64, 0.54];
  const currentGearIdx = Math.max(0, Math.min(5, (racer.gear || 1) - 1));
  const gearTorqueMult = GEAR_TORQUE_MULTS[currentGearIdx];
  const rawFinalDriveMult = 1 + (config.finalDriveRatio - 4.1) * 0.42;
  const highGearBlend = currentGearIdx >= 4 ? 0.35 : 1.0;
  const effectiveFinalDriveMult = Math.max(
    0.72,
    1 + (rawFinalDriveMult - 1) * highGearBlend,
  );
  // Transmission stage reduces shift torque drop (Stage 0 synchro drop vs Stage 3 dog-box sequential)
  const shiftClutchFactor =
    (racer.shiftTimer ?? 0) > 0
      ? 0.22 + config.transmissionStage * 0.23
      : 1.0;

  const rawBaseAccel =
    (9.8 +
      (stats.hp - 260) * 0.036 +
      config.transmissionStage * 0.9) *
    weightFactor *
    awdLaunchFactor *
    tireTractionMult *
    gearTorqueMult *
    effectiveFinalDriveMult *
    shiftClutchFactor;

  const baseAccel =
    racer.isPlayer || isEqualFourPlayerSession
      ? rawBaseAccel
      : rawBaseAccel * diffSpec.accelMultiplier;
  const nitroAccelBoost = canBoost
    ? (7.8 + config.nitrousStage * 3.8) * config.nitrousFlowRate * weightFactor
    : 0;

  const engineLimiter = evaluateEngineTorqueAndLimiter(
    forwardSpeed,
    effectiveMaxSpeedMs,
    racer.rpm,
    stats.redlineRpm,
    racer.turboBoostBar,
    totalDownforceCoeff,
    elapsedSec,
  );

  if (input.throttle > 0) {
    const prevSpeedBeforeThrottle = forwardSpeed;
    forwardSpeed +=
      input.throttle *
      (baseAccel * engineLimiter.netDriveFactor + nitroAccelBoost) *
      dt;
    // ECU Redline / 6th-Gear Top-Speed Limiter: hard fuel cut caps speed at effectiveMaxSpeedMs
    if (
      prevSpeedBeforeThrottle <= effectiveMaxSpeedMs &&
      forwardSpeed > effectiveMaxSpeedMs
    ) {
      forwardSpeed = effectiveMaxSpeedMs;
    }
    if (engineLimiter.isHittingRevLimiter && input.throttle > 0.6) {
      racer.exhaustFlameIntensity = Math.max(
        racer.exhaustFlameIntensity,
        0.42,
      );
    }
  } else if (forwardSpeed > 2.0 && input.brake === 0) {
    // Realistic engine compression braking when lifting off throttle in gear (stronger with short final drive)
    const engineBrakeDecel =
      (1.5 + GEAR_RATIOS[currentGearIdx] * 0.85 * effectiveFinalDriveMult) * dt;
    forwardSpeed = Math.max(0, forwardSpeed - engineBrakeDecel);
  }

  // 3. Braking, Brake Heat & Reverse Gear
  racer.isBraking = input.brake > 0.1 || input.handbrake;
  if (input.brake > 0) {
    if (forwardSpeed > 1.5) {
      // Downforce + tire stage + suspension stage + weight strongly improve high-speed braking bite
      const aeroBrakeBonus =
        totalDownforceCoeff * Math.min(1, forwardSpeed / 48) * 8.5;
      const camberBrakeFactor =
        1 - Math.max(0, config.camberAngle - 3.5) * 0.016;
      const brakeDecel =
        (29.5 +
          config.tiresStage * 5.6 +
          config.suspensionStage * 2.2 +
          aeroBrakeBonus) *
        weightFactor *
        camberBrakeFactor;
      forwardSpeed = Math.max(0, forwardSpeed - input.brake * brakeDecel * dt);
      racer.brakeHeat = Math.min(
        1,
        (racer.brakeHeat ?? 0) +
          input.brake * Math.min(1, forwardSpeed / 35) * dt * 2.4,
      );
    } else {
      // Reverse gear
      forwardSpeed = Math.max(-16, forwardSpeed - input.brake * 12 * dt);
    }
  } else {
    // Convective brake rotor cooling proportional to airflow speed
    const coolRate = 0.65 + (Math.abs(forwardSpeed) / 50) * 1.4;
    racer.brakeHeat = Math.max(0, (racer.brakeHeat ?? 0) - coolRate * dt);
  }

  // Handbrake locks rear wheels: when combined with throttle (clutch-kick drift entry),
  // it breaks rear traction with minimal speed loss so the car powers through the drift arc!
  if (input.handbrake && forwardSpeed > 0) {
    const hbDrag = input.throttle > 0.4 ? 3.8 : 10.5;
    forwardSpeed = Math.max(0, forwardSpeed - hbDrag * dt);
  }

  // 4. Aerodynamic Drag (v^2), Over-Speed Decay & Rolling Resistance
  const passiveDragWeight =
    forwardSpeed > effectiveMaxSpeedMs
      ? 1.45
      : Math.max(0, 1 - input.throttle * 0.94);
  const rideHeightAeroFactor = 1 + (config.rideHeight + 0.02) * 1.2;
  const aeroDragCoeff =
    (0.00054 + totalDownforceCoeff * 0.00022) * rideHeightAeroFactor;
  forwardSpeed -=
    forwardSpeed *
    Math.abs(forwardSpeed) *
    aeroDragCoeff *
    passiveDragWeight *
    dt;
  forwardSpeed *= 1 - 0.025 * passiveDragWeight * dt;

  // Compute longitudinal acceleration & G-force (positive = acceleration squat, negative = brake dive)
  const rawLongAccelMs2 = (forwardSpeed - prevForwardSpeed) / Math.max(dt, 0.001);
  const targetLongG = Math.max(-1.8, Math.min(1.8, rawLongAccelMs2 / 9.81));
  racer.longitudinalG =
    (racer.longitudinalG ?? 0) +
    (targetLongG - (racer.longitudinalG ?? 0)) * Math.min(1, dt * 14);

  // Dynamic Longitudinal Weight Transfer between Front & Rear Axles
  // Lowering coilover rideHeight lowers Center of Gravity (CG), reducing pitch/roll load transfer
  const dynamicCgHeight = Math.max(
    0.32,
    CG_HEIGHT_METERS + config.rideHeight * 1.9,
  );
  const weightShift =
    (dynamicCgHeight / WHEELBASE_METERS) * (racer.longitudinalG ?? 0) * 0.44;
  const aeroLoadBonus =
    totalDownforceCoeff *
    Math.pow(Math.min(1.25, Math.abs(forwardSpeed) / 48), 2) *
    0.46;
  const frontAxleGripMult = Math.max(
    0.72,
    Math.min(1.48, 1.0 - weightShift + aeroLoadBonus * 0.85),
  );
  const rearAxleGripMult = Math.max(
    0.65,
    Math.min(1.52, 1.0 + weightShift + aeroLoadBonus * 1.15),
  );

  // 5. NFS: Underground 2 (EA Black Box EAGL) Asymmetric Steering & Dual-Regime Drift Physics
  const currentSlip =
    Math.abs(forwardSpeed) > 3.0
      ? Math.atan2(lateralSpeed, Math.abs(forwardSpeed))
      : 0;

  const isPlantedHighwayLaneChange =
    !input.handbrake &&
    Math.abs(input.steer) <= 0.65 &&
    Math.abs(racer.heading) < 0.35;

  // Pneumatic trail self-aligning torque: when the rear swings out, releasing the wheel
  // naturally counter-steers into the slide like NFSU2's assisted drift rack
  const selfAlignTorque =
    !isPlantedHighwayLaneChange &&
    Math.abs(input.steer) < 0.15 &&
    Math.abs(currentSlip) > 0.035
      ? Math.max(-0.56, Math.min(0.56, -currentSlip * 0.78))
      : 0;
  const desiredSteer = Math.max(
    -1,
    Math.min(1, -input.steer + selfAlignTorque),
  );

  // Asymmetric keyboard steering filter:
  // Track coilovers (suspensionStage) & lowered rideHeight make turn-in much crisper
  const isReturningOrCountering =
    Math.abs(desiredSteer) < Math.abs(racer.steerAngle) ||
    desiredSteer * racer.steerAngle < -0.01;
  const stanceResponseBonus = Math.max(0, -config.rideHeight * 35);
  const steerResponse = isReturningOrCountering
    ? 22.0 + config.suspensionStage * 2.8 + stanceResponseBonus
    : 8.8 + config.suspensionStage * 2.1 + stanceResponseBonus;

  if (isPlantedHighwayLaneChange) {
    // Eliminate steering-rack phase lag during highway lane changes so high-speed lane switches never oscillate
    racer.steerAngle = desiredSteer;
  } else {
    racer.steerAngle +=
      (desiredSteer - racer.steerAngle) * Math.min(1, steerResponse * dt);
  }

  const speedFactor = Math.min(1, Math.abs(forwardSpeed) / 14.5);
  const highSpeedDamp = Math.max(
    0.42,
    1 / (1 + Math.pow(Math.abs(forwardSpeed) / 68, 1.45)),
  );

  // Lift-off / trail-brake front nose tuck-in bonus
  const liftOffTuckBonus =
    input.throttle < 0.25 && Math.abs(forwardSpeed) > 15
      ? 1.14
      : input.brake > 0.15
        ? 1.18
        : 1.0;

  // High driftBias (>= 0.65) unlocks throttle-on powerslides on both RWD and AWD (with RWD kicking out wider)
  const isHighDriftBiasBuild = config.driftBias >= 0.65;
  const drivetrainOversteerScale = isAWD ? 0.68 : 1.05;
  const rwdPowerOversteer =
    !isPlantedHighwayLaneChange &&
    input.throttle > 0.5 &&
    Math.abs(racer.steerAngle) > 0.24 &&
    (isHighDriftBiasBuild || input.handbrake || racer.isDrifting)
      ? input.throttle *
        drivetrainOversteerScale *
        (0.32 + config.driftBias * 0.58) *
        (stats.hp / 320)
      : 0;
  const tireSpinReduction = Math.max(0.35, 1 - config.tiresStage * 0.2);
  const launchWheelspin =
    input.throttle > 0.75 && forwardSpeed < 16
      ? (1 - forwardSpeed / 16) *
        (isAWD ? 0.22 : 0.68) *
        (stats.hp / 320) *
        tireSpinReduction
      : 0;
  racer.wheelspinIntensity = Math.min(1, rwdPowerOversteer + launchWheelspin);

  // Stance (rideHeight + camberAngle) and BodyKit directly increase front-end turn-in authority
  const stanceTurnBonus =
    1 + Math.max(-0.04, -config.rideHeight * 2.2) + config.camberAngle * 0.022;
  const bodyKitTurnBonus =
    config.bodyKit === 'widebody'
      ? 1.14
      : config.bodyKit === 'street'
        ? 1.06
        : 1.0;

  const turnAuthority =
    (2.52 + config.suspensionStage * 0.32 + config.tiresStage * 0.14) *
    stanceTurnBonus *
    bodyKitTurnBonus *
    speedFactor *
    (isPlantedHighwayLaneChange ? 1.0 : highSpeedDamp) *
    liftOffTuckBonus *
    (0.88 + frontAxleGripMult * 0.24);

  const handbrakeYawBoost = input.handbrake ? 1.56 : 1.0;
  const oversteerYawBoost =
    1.0 + rwdPowerOversteer * 0.34 + Math.max(0, 1.0 - rearAxleGripMult) * 0.35;

  // Weathervane restoring torque prevents spinouts and lets counter-steering catch any slide cleanly
  const weathervaneRestore = isPlantedHighwayLaneChange
    ? 0
    : -Math.sin(currentSlip) * (1.42 + (stats.gripScore / 100) * 1.05);

  const dirSign = forwardSpeed >= -0.2 ? 1 : -1;
  const targetAngularVel =
    (racer.steerAngle * turnAuthority * handbrakeYawBoost * oversteerYawBoost +
      weathervaneRestore * speedFactor) *
    dirSign;

  // Snappy EAGL rotational inertia response scaled by suspensionStage & weight
  if (isPlantedHighwayLaneChange) {
    racer.angularVelocity = targetAngularVel;
  } else {
    const yawInertiaResponse = (15.5 + config.suspensionStage * 2.8) * weightFactor;
    racer.angularVelocity +=
      (targetAngularVel - racer.angularVelocity) *
      Math.min(1, yawInertiaResponse * dt);
  }

  const yawChange = racer.angularVelocity * dt;
  racer.heading += yawChange;

  // 6. Dual-Regime EAGL Trajectory Authority (Planted High-Speed Grip vs. On-Command Powerslide)
  const isSteeringIntoSlide =
    Math.abs(lateralSpeed) < 0.25 || racer.steerAngle * lateralSpeed >= -0.02;
  const isCounterSteering =
    (racer.steerAngle * lateralSpeed < -0.02 && Math.abs(input.steer) > 0.12) ||
    Math.abs(input.steer) < 0.12;

  const isDriftInitiated =
    input.handbrake ||
    (input.brake > 0.2 && Math.abs(racer.steerAngle) > 0.36) ||
    (isHighDriftBiasBuild &&
      input.throttle > 0.55 &&
      Math.abs(racer.steerAngle) > 0.32) ||
    ((Math.abs(currentSlip) > 0.085 || racer.isDrifting) &&
      isSteeringIntoSlide &&
      input.throttle > 0.35 &&
      Math.abs(input.steer) > 0.2);

  // Continuous driftBias & gripScore scaling:
  // Low driftBias (0.25) + Stage 3 Tires = 0.95 rail-like grip authority;
  // High driftBias (0.90) drops grip authority so the tail steps out effortlessly into deep drifts
  const baseGripAuthority = Math.max(
    0.58,
    Math.min(
      0.95,
      0.88 +
        (stats.gripScore / 100) * 0.14 -
        Math.max(0, config.driftBias - 0.35) * 0.45 +
        (isAWD ? 0.04 : 0),
    ),
  );
  const driftAuthorityFactor = Math.max(
    0.24,
    0.46 - (config.driftBias - 0.45) * 0.38,
  );
  const tireTrajectoryAuthority = input.handbrake
    ? 0.12
    : isDriftInitiated
      ? baseGripAuthority * driftAuthorityFactor
      : baseGripAuthority;

  // Only the un-gripped fraction of yawChange becomes local slip angle
  const effectiveSlipYaw = yawChange * (1 - tireTrajectoryAuthority);
  const cosYaw = Math.cos(effectiveSlipYaw);
  const sinYaw = Math.sin(effectiveSlipYaw);
  const rotatedForward = forwardSpeed * cosYaw - lateralSpeed * sinYaw;
  const rotatedLateral = forwardSpeed * sinYaw + lateralSpeed * cosYaw;
  forwardSpeed = rotatedForward;
  lateralSpeed = rotatedLateral;

  // Outward rear slip kick when pulling handbrake, trail-braking, or cornering with medium/high driftBias
  const progressiveSlipBias = Math.max(0, config.driftBias - 0.48) * 0.55;
  const outwardSlipKick =
    isCounterSteering ||
    (!isDriftInitiated && !isHighDriftBiasBuild && progressiveSlipBias <= 0.01)
      ? 0
      : racer.steerAngle *
        Math.max(0, forwardSpeed - 4.5) *
        (config.driftBias * 0.48 +
          rwdPowerOversteer * 0.62 +
          progressiveSlipBias +
          (input.handbrake ? 2.6 : isDriftInitiated ? 0.58 : 0.12)) *
        (1.12 / rearAxleGripMult);

  lateralSpeed += outwardSlipKick * dt * 2.75;

  // Non-linear Pacejka tire lateral restoration force + Counter-Steer Catch
  const newSlipRad =
    Math.abs(forwardSpeed) > 2.5
      ? Math.atan2(lateralSpeed, Math.abs(forwardSpeed))
      : 0;
  const camberGripBonus = 1 + config.camberAngle * 0.032;
  const bodyKitLateralBonus =
    config.bodyKit === 'widebody'
      ? 1.16
      : config.bodyKit === 'street'
        ? 1.07
        : 1.0;
  const peakSlipRad = 0.13 + (1 - config.driftBias) * 0.07;
  const slideRatio = input.handbrake ? 0.18 : 0.56 - config.driftBias * 0.28;
  const pacejkaCoeff = Math.abs(
    evaluatePacejkaTireGrip(newSlipRad, peakSlipRad, slideRatio),
  );

  // When drifting on throttle while steering into the turn, rear tires stay in a controllable kinetic slide plateau
  const isSliding = Math.abs(newSlipRad) > 0.085 || input.handbrake;
  const throttleDriftHold =
    isSliding &&
    isSteeringIntoSlide &&
    input.throttle > 0.35 &&
    Math.abs(input.steer) > 0.18
      ? Math.max(0.24, (isAWD ? 0.54 : 0.44) - config.driftBias * 0.26)
      : 1.0;

  // Counter-steer / wheel-centering snap recovery (NFSU2 signature pendulum catch)
  const counterSteerCatch =
    isCounterSteering && !input.handbrake
      ? 2.35 + config.suspensionStage * 0.25
      : 1.0;

  const baseLateralGrip = input.handbrake
    ? 0.72
    : (4.8 +
        config.tiresStage * 1.25 +
        config.suspensionStage * 0.75 +
        (stats.gripScore / 100) * 3.8 -
        config.driftBias * 2.35) *
      rearAxleGripMult *
      camberGripBonus *
      bodyKitLateralBonus *
      (0.7 + pacejkaCoeff * 0.48) *
      throttleDriftHold *
      counterSteerCatch;

  const prevLatMag = Math.abs(lateralSpeed);
  lateralSpeed *= Math.max(0, 1 - baseLateralGrip * dt);
  const recoveredLatMag = prevLatMag - Math.abs(lateralSpeed);

  // Redirect recovered lateral tire force into forward corner-exit drive when on throttle
  if (input.throttle > 0.2 && forwardSpeed > 4 && recoveredLatMag > 0) {
    const gripExitBonus = (1 - config.driftBias) * 0.12 + config.tiresStage * 0.025;
    const cornerDriveTransfer = isDriftInitiated
      ? (isAWD ? 0.58 : 0.48) + config.tiresStage * 0.03
      : Math.min(0.97, (isAWD ? 0.90 : 0.84) + gripExitBonus);
    forwardSpeed = Math.min(
      effectiveMaxSpeedMs,
      forwardSpeed + recoveredLatMag * cornerDriveTransfer * input.throttle,
    );
  }

  // ATTESA E-TS AWD Front-Axle Torque Vectoring (Evo VIII / R34 pull nose out of slides rapidly when counter-steering)
  if (isAWD && input.throttle > 0.25 && Math.abs(lateralSpeed) > 0.5) {
    const awdVectorMult = isCounterSteering
      ? 1.05
      : Math.max(0.12, 0.36 - config.driftBias * 0.25);
    const awdRecovery = Math.min(1, input.throttle * 2.8 * awdVectorMult * dt);
    lateralSpeed *= 1 - awdRecovery * 0.52;
    forwardSpeed = Math.min(
      effectiveMaxSpeedMs,
      forwardSpeed + Math.abs(lateralSpeed) * awdRecovery * 0.18,
    );
  }

  // Maximum controllable drift angle scales with Negative Camber & Drift Bias (38 deg grip up to 54 deg Touge angle)
  const maxDriftDeg = 38 + config.camberAngle * 1.2 + config.driftBias * 7.5;
  const maxSlipTan = Math.tan((maxDriftDeg * Math.PI) / 180);
  const maxLatSpeed = Math.max(2, Math.abs(forwardSpeed) * maxSlipTan);
  if (Math.abs(lateralSpeed) > maxLatSpeed) {
    lateralSpeed = Math.sign(lateralSpeed) * maxLatSpeed;
  }

  // Compute lateral G-force for 3D suspension roll & camera banking (zeroed during highway lane changes to prevent chassis wobble)
  const centripetalAccel = forwardSpeed * racer.angularVelocity;
  const rawTargetLatG = Math.max(-2.2, Math.min(2.2, centripetalAccel / 9.81));
  const targetLatG = isPlantedHighwayLaneChange ? 0 : rawTargetLatG;
  racer.lateralG = isPlantedHighwayLaneChange
    ? 0
    : (racer.lateralG ?? 0) +
      (targetLatG - (racer.lateralG ?? 0)) * Math.min(1, dt * 14);

  if (isPlantedHighwayLaneChange) {
    lateralSpeed = 0;
    racer.wheelspinIntensity = 0;
  }

  // 7. Reconstruct World Velocity & Integrate Position
  const newSinH = Math.sin(racer.heading);
  const newCosH = Math.cos(racer.heading);
  const newRightX = -newCosH;
  const newRightZ = newSinH;

  racer.vx = newSinH * forwardSpeed + newRightX * lateralSpeed;
  racer.vz = newCosH * forwardSpeed + newRightZ * lateralSpeed;

  const prevX = racer.x;
  const prevZ = racer.z;
  racer.x += racer.vx * dt;
  racer.z += racer.vz * dt;

  racer.speedMs = Math.hypot(racer.vx, racer.vz);
  racer.speedKmh = Math.round(racer.speedMs * 3.6);
  racer.lateralVelocity = lateralSpeed;
  racer.slipAngleRad =
    !isPlantedHighwayLaneChange && racer.speedMs > 3.5
      ? Math.atan2(lateralSpeed, Math.abs(forwardSpeed))
      : 0;
  racer.driftAngleDeg = Number(
    ((racer.slipAngleRad * 180) / Math.PI).toFixed(1),
  );

  // 8. Drift State & Multiplier Scoring (scaled by driftControlScore)
  const absSlipDeg = Math.abs(racer.driftAngleDeg);
  const isNowDrifting =
    !isPlantedHighwayLaneChange &&
    (absSlipDeg > 6.5 ||
      (input.handbrake && Math.abs(racer.steerAngle) > 0.2)) &&
    racer.speedKmh > 35;
  racer.isDrifting = isNowDrifting;

  if (isNowDrifting) {
    racer.driftComboTimer = 1.75 + (stats.driftControlScore / 100) * 0.45;
    const driftBonusMult = 0.85 + (stats.driftControlScore / 100) * 0.35;
    const ptsPerSec =
      (Math.max(10, absSlipDeg) * 18.0 + racer.speedKmh * 2.35) *
      racer.driftMultiplier *
      driftBonusMult;
    racer.currentDriftScore += ptsPerSec * dt;
    if (
      racer.currentDriftScore > racer.driftMultiplier * 420 &&
      racer.driftMultiplier < 5
    ) {
      racer.driftMultiplier += 1;
    }
  } else if (racer.driftComboTimer > 0) {
    racer.driftComboTimer -= dt;
    if (racer.driftComboTimer <= 0 && racer.currentDriftScore > 0) {
      driftBankedPoints = Math.round(racer.currentDriftScore);
      racer.totalDriftScore += driftBankedPoints;
      racer.currentDriftScore = 0;
      racer.driftMultiplier = 1;
    }
  }

  // 9. Realistic 6-Speed Close-Ratio Sequential Gearbox, Shift Jolt & ECU Redline Limiter
  const prevGear = racer.gear;
  // Final Drive Ratio adjusts 1st-5th gear spacing while 6th gear always spans to 1.0 (maxSpeedMs)
  const bandScale = Math.max(
    0.84,
    Math.min(1.12, 1 - (config.finalDriveRatio - 4.1) * 0.16),
  );
  const gearBands = [
    0.0,
    0.18 * bandScale,
    0.35 * bandScale,
    0.52 * bandScale,
    0.69 * bandScale,
    Math.min(0.92, 0.85 * bandScale),
    1.0,
  ];
  const normSpeed = Math.min(1.12, Math.max(0, forwardSpeed / maxSpeedMs));
  let targetGear = 1;
  for (let g = 1; g <= 6; g++) {
    if (normSpeed >= gearBands[g - 1]) {
      targetGear = g;
    }
  }
  // Downshift hysteresis so the gearbox doesn't hunt on the shift boundary
  if (
    targetGear < prevGear &&
    normSpeed > gearBands[prevGear - 1] - 0.035 &&
    forwardSpeed > 8
  ) {
    targetGear = prevGear;
  }

  if (targetGear !== prevGear) {
    racer.gear = targetGear;
    gearShifted = true;
    // Transmission stage shortens shift time from 140ms (Stock) down to 35ms (Stage 3 Sequential Dog-Box)
    racer.shiftTimer = Math.max(0.035, 0.14 - config.transmissionStage * 0.035);
    racer.exhaustFlameIntensity = Math.max(racer.exhaustFlameIntensity, 0.92);
  }

  const gearBandMin = gearBands[racer.gear - 1];
  const gearBandMax = gearBands[racer.gear];
  const inGearFraction = Math.max(
    0,
    Math.min(
      1.05,
      (normSpeed - gearBandMin) / Math.max(0.08, gearBandMax - gearBandMin),
    ),
  );
  const wheelspinRpmBump =
    (racer.wheelspinIntensity ?? 0) * 1150 +
    (racer.isDrifting && input.throttle > 0.4 ? 750 : 0);
  // Close-ratio transmission stages keep shift RPM drops tighter in the turbo powerband
  const closeRatioRetention = config.transmissionStage * 0.025;
  const gearEntryRpm =
    racer.gear === 1
      ? 1150
      : stats.redlineRpm * (0.54 + closeRatioRetention + racer.gear * 0.015);
  const isAtTopSpeedLimiter =
    input.throttle > 0.5 &&
    (engineLimiter.isHittingRevLimiter ||
      forwardSpeed >= effectiveMaxSpeedMs * 0.985);
  const revLimiterFlutter = isAtTopSpeedLimiter
    ? Math.sin(elapsedSec * 90) * 110 - 55
    : 0;
  const baseTargetRpm =
    gearEntryRpm +
    inGearFraction * (stats.redlineRpm - gearEntryRpm - 180) +
    input.throttle * 260 +
    wheelspinRpmBump;
  const targetRpm = isAtTopSpeedLimiter
    ? stats.redlineRpm + revLimiterFlutter
    : baseTargetRpm;
  racer.rpm = Math.round(
    Math.min(
      stats.redlineRpm,
      Math.max(
        950,
        racer.rpm + (targetRpm - racer.rpm) * Math.min(1, dt * 18),
      ),
    ),
  );

  // Turbo boost bar (-0.4 to +1.55 bar, spools faster and higher with turboStage)
  const isBlowOff = (racer.shiftTimer ?? 0) > 0.03;
  const spoolThresholdRpm = Math.max(2200, 3100 - config.turboStage * 220);
  const targetBoost = isBlowOff
    ? -0.15
    : input.throttle > 0.3 && racer.rpm > spoolThresholdRpm
      ? (0.45 + config.turboStage * 0.36) * (racer.rpm / stats.redlineRpm)
      : -0.35;
  const spoolRate = 8.5 + config.turboStage * 2.5;
  racer.turboBoostBar = Number(
    (
      racer.turboBoostBar +
      (targetBoost - racer.turboBoostBar) * Math.min(1, dt * spoolRate)
    ).toFixed(2),
  );

  // 10. Track Projection, Curb Rumble Strips & NFSU2 Forgiving Wall-Ride / Barrier Bounce
  const prevS = racer.trackProgress;
  let proj = projectWorldToTrack(trackId, racer.x, racer.z);

  const absLat = Math.abs(proj.lateralOffset);
  const curbStartLat = proj.halfWidth - 2.15;
  const maxAllowedLateral = proj.halfWidth - 1.32;

  // Curb Rumble detection when riding the red/white apex curbs (higher rideHeight absorbs curbs smoother)
  if (absLat > curbStartLat && racer.speedMs > 4) {
    const curbDepth = Math.min(
      1,
      (absLat - curbStartLat) / Math.max(0.2, maxAllowedLateral - curbStartLat),
    );
    const rideHeightCurbDamp = Math.max(0.55, 1 - (config.rideHeight + 0.04) * 5.5);
    racer.curbRumbleIntensity =
      curbDepth * Math.min(1, racer.speedMs / 28) * rideHeightCurbDamp;
  } else {
    racer.curbRumbleIntensity = Math.max(
      0,
      (racer.curbRumbleIntensity ?? 0) - dt * 8,
    );
  }

  if (absLat > maxAllowedLateral) {
    const sign = Math.sign(proj.lateralOffset) || 1;
    // Outward unit normal (into the barrier) and inward unit normal (toward centerline)
    const wallOutX = proj.nx * sign;
    const wallOutZ = proj.nz * sign;
    const wallInX = -wallOutX;
    const wallInZ = -wallOutZ;

    // Decompose velocity into outward-normal and track-tangent components
    const incomingSpeed = Math.hypot(racer.vx, racer.vz);
    const vOutward = Math.max(0, racer.vx * wallOutX + racer.vz * wallOutZ);
    const vTang = racer.vx * proj.tx + racer.vz * proj.tz;

    // Distinguish initial barrier crash from sustained wall-grinding along the barrier
    const prevProj = projectWorldToTrack(trackId, prevX, prevZ);
    const wasAlreadyOnWall =
      Math.abs(prevProj.lateralOffset) > prevProj.halfWidth - 1.72;
    wallImpactMagnitude = wasAlreadyOnWall
      ? Math.min(0.28, 0.04 + vOutward / 36)
      : Math.min(1, 0.04 + vOutward / 18);

    // Redirect incoming speed forward along the barrier tangent with angle-proportional friction
    const impactSin = Math.min(1, vOutward / Math.max(5, incomingSpeed));
    const wallFriction = Math.max(0.94, 1 - (0.06 + impactSin * 0.28) * dt);
    const isReversingIntentionally =
      input.brake > 0.1 &&
      input.throttle === 0 &&
      vTang < -0.5 &&
      incomingSpeed < 10;
    const tangDir = isReversingIntentionally ? -1 : 1;
    const redirectedSpeed = incomingSpeed * wallFriction;
    const minThrottleSlide =
      tangDir > 0 && input.throttle > 0.1 ? input.throttle * 13.5 : 0;
    const minReverseEscape =
      isReversingIntentionally ? Math.max(4.5, input.brake * 8.0) : 0;
    const finalForwardSpeed = Math.max(
      redirectedSpeed,
      minThrottleSlide,
      minReverseEscape,
    );

    // Compute exact slide unit vector along the barrier with a 2.75-degree inward separation bias
    const rawSlideX = proj.tx * tangDir + wallInX * 0.048;
    const rawSlideZ = proj.tz * tangDir + wallInZ * 0.048;
    const slideLen = Math.hypot(rawSlideX, rawSlideZ) || 1;
    const slideDirX = rawSlideX / slideLen;
    const slideDirZ = rawSlideZ / slideLen;

    // Push position inward away from the barrier (3cm clearance) and advance along slide vector
    const penetration = Math.max(0, absLat - (maxAllowedLateral - 0.03));
    const currentSlideVel = racer.vx * slideDirX + racer.vz * slideDirZ;
    const slideAdvance = Math.max(0, finalForwardSpeed - currentSlideVel) * dt;
    racer.x += wallInX * penetration + slideDirX * slideAdvance;
    racer.z += wallInZ * penetration + slideDirZ * slideAdvance;

    // Deflect heading using exact world-space dot products whenever nose points into the wall or > 32 deg off-tangent
    const fwdX = Math.sin(racer.heading);
    const fwdZ = Math.cos(racer.heading);
    const noseOutwardDot = fwdX * wallOutX + fwdZ * wallOutZ;
    const noseTangDot = fwdX * (proj.tx * tangDir) + fwdZ * (proj.tz * tangDir);
    if (noseOutwardDot > -0.025 || noseTangDot < 0.85) {
      racer.heading =
        tangDir > 0
          ? Math.atan2(slideDirX, slideDirZ)
          : Math.atan2(-slideDirX, -slideDirZ);
    }

    racer.angularVelocity = 0;
    if (racer.steerAngle * sign < 0) {
      racer.steerAngle = 0;
    }

    // Reconstruct world velocity along the inward-biased barrier slide vector
    const alignedSinH = Math.sin(racer.heading);
    const alignedCosH = Math.cos(racer.heading);
    const velDirX = tangDir > 0 ? alignedSinH : slideDirX;
    const velDirZ = tangDir > 0 ? alignedCosH : slideDirZ;
    racer.vx = velDirX * finalForwardSpeed;
    racer.vz = velDirZ * finalForwardSpeed;
    racer.speedMs = finalForwardSpeed;
    racer.speedKmh = Math.round(racer.speedMs * 3.6);
    racer.lateralVelocity = 0;
    racer.slipAngleRad = 0;
    if (vOutward > 6.5) {
      racer.hitFlashTimer = 0.04;
    }

    proj = projectWorldToTrack(trackId, racer.x, racer.z);
  }

  // Detect lap crossing across s = 0
  const deltaS = proj.s - prevS;
  if (deltaS < -0.5) {
    racer.lap += 1;
    if (racer.lap > track.laps && !racer.finished) {
      racer.finished = true;
      racer.finishTimeSec = elapsedSec;
      raceJustFinished = true;
      if (racer.currentDriftScore > 0) {
        racer.totalDriftScore += Math.round(racer.currentDriftScore);
        racer.currentDriftScore = 0;
      }
    }
  } else if (deltaS > 0.5 && racer.lap > 1) {
    racer.lap -= 1;
  }

  racer.trackProgress = proj.s;
  racer.totalProgress = racer.lap - 1 + proj.s;

  return {
    wallImpactMagnitude,
    carCollisionMagnitude: 0,
    gearShifted,
    driftBankedPoints,
    raceJustFinished,
  };
}

/**
 * Ghost Pass-Through Resolver between Racers:
 * Player and rival cars are completely transparent to each other (zero physical impulse,
 * zero position pushing, and zero speed loss), updating `ghostOverlap` (0..1) for visual translucency.
 */
export function resolveRacerCollisions(
  racers: RacerState[],
  _trackId: TrackId = 'olympic_circuit',
): number {
  const ghostLatRadius = 2.4;
  const ghostLongRadius = 5.2;

  for (let i = 0; i < racers.length; i++) {
    racers[i].ghostOverlap = 0;
  }

  for (let i = 0; i < racers.length; i++) {
    const a = racers[i];
    if (a.eliminated) continue;
    for (let j = i + 1; j < racers.length; j++) {
      const b = racers[j];
      if (b.eliminated) continue;

      const absDx = Math.abs(b.x - a.x);
      const absDz = Math.abs(b.z - a.z);

      if (absDx < ghostLatRadius && absDz < ghostLongRadius) {
        const latFactor = 1 - absDx / ghostLatRadius;
        const longFactor = 1 - absDz / ghostLongRadius;
        const overlap = Math.min(1, Math.max(0.25, latFactor * longFactor * 1.8));
        a.ghostOverlap = Math.max(a.ghostOverlap ?? 0, overlap);
        b.ghostOverlap = Math.max(b.ghostOverlap ?? 0, overlap);
      }
    }
  }

  return 0;
}

export function getSortedStandings(racers: RacerState[]): RacerState[] {
  return [...racers].sort((a, b) => {
    const aElim = Boolean(a.eliminated);
    const bElim = Boolean(b.eliminated);
    if (aElim !== bElim) {
      return aElim ? 1 : -1;
    }
    if (aElim && bElim) {
      return (b.eliminatedAtSec ?? 0) - (a.eliminatedAtSec ?? 0);
    }
    if (a.finished && b.finished) {
      return a.finishTimeSec - b.finishTimeSec;
    }
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.totalProgress - a.totalProgress;
  });
}

export function buildRaceSummary(
  racers: RacerState[],
  trackId: TrackId,
  topSpeedKmh: number,
  elapsedSec: number,
  difficulty: RivalDifficulty = 'pro',
): RaceSummary {
  const standings = getSortedStandings(racers);
  const player = racers.find((r) => r.isPlayer) || racers[0];
  const aliveRacers = racers.filter((r) => !r.eliminated);
  const allRivalsEliminated = racers
    .filter((r) => !r.isPlayer)
    .every((r) => Boolean(r.eliminated));

  let placement = standings.findIndex((r) => r.isPlayer) + 1;
  if (placement <= 0) placement = 4;

  // In Last-Car-Standing survival: if player is alive and all rivals crashed into traffic, player is #1!
  // If player crashed into traffic, placement is 1 + number of surviving rivals.
  if (!player.eliminated && allRivalsEliminated) {
    placement = 1;
  } else if (player.eliminated) {
    const survivingRivals = racers.filter(
      (r) => !r.isPlayer && !r.eliminated,
    ).length;
    placement = Math.min(racers.length, survivingRivals + 1);
  }

  const track = TRACK_CATALOG[trackId];
  const diffSpec = RIVAL_DIFFICULTY_CATALOG[difficulty];

  const finishTimeSec =
    player.finishTimeSec > 0 ? player.finishTimeSec : Math.max(5, elapsedSec);
  const bestLapSec = Number((finishTimeSec / track.laps).toFixed(2));
  const totalDriftScore = Math.round(
    player.totalDriftScore + player.currentDriftScore,
  );

  const placementMultipliers = [1.0, 0.6, 0.35, 0.15];
  const basePrize = Math.round(
    track.prizeFirst *
      diffSpec.prizeMultiplier *
      (placementMultipliers[placement - 1] ?? 0.15),
  );
  const driftBonusCash = Math.round(totalDriftScore * 0.35);
  const cashEarned = basePrize + driftBonusCash;
  const reputationEarned =
    (5 - placement) * 180 + Math.round(totalDriftScore * 0.15);

  return {
    placement,
    totalRacers: racers.length,
    finishTimeSec: Number(finishTimeSec.toFixed(2)),
    bestLapSec,
    topSpeedReachedKmh: Math.max(topSpeedKmh, player.speedKmh),
    totalDriftScore,
    cashEarned,
    reputationEarned,
    trackName: track.name,
    isVictory: placement === 1 && !player.eliminated,
    aliveCount: aliveRacers.length,
    eliminatedByTraffic: Boolean(player.eliminated),
    trafficNearMisses: player.trafficNearMisses ?? 0,
  };
}
