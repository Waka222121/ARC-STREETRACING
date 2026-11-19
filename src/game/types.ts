export type ChassisId = 'rx7' | 'r34' | 'supra';

export type PaintFinish = 'metallic' | 'matte' | 'pearlescent' | 'chrome';
export type BodyKitType = 'stock' | 'street' | 'widebody';
export type SpoilerType = 'none' | 'ducktail' | 'gt_wing' | 'twin_deck';
export type RimStyle = 'te37' | 'bbs' | 'aero';
export type VinylStyle = 'none' | 'twin_stripes' | 'side_slash' | 'carbon_hood';
export type CameraPreset = 'overview' | 'front' | 'rear' | 'wheels' | 'dyno';
export type RaceCameraMode = 'top_down' | 'chase' | 'hood' | 'far';
export type TrackId = 'olympic_circuit' | 'chinatown_sprint' | 'harbor_drift';
export type GameState = 'title' | 'playing' | 'paused' | 'gameover';

export interface CarConfig {
  chassis: ChassisId;
  // Visual Styling
  paintColor: string;
  pearlColor: string;
  paintFinish: PaintFinish;
  vinylStyle: VinylStyle;
  vinylColor: string;
  rimStyle: RimStyle;
  rimColor: string;
  bodyKit: BodyKitType;
  spoiler: SpoilerType;
  underglowColor: string;
  underglowEnabled: boolean;
  headlightColor: string;
  windowTint: number; // 0.2 to 0.9
  // Stance
  rideHeight: number; // -0.08 to +0.04
  camberAngle: number; // 0 to 10 degrees negative camber
  // Performance Stages (0 = Stock, 1 = Street, 2 = Pro, 3 = Extreme Underground)
  engineStage: number;
  turboStage: number;
  transmissionStage: number;
  suspensionStage: number;
  tiresStage: number;
  nitrousStage: number;
  // Dyno Fine Tuning
  finalDriveRatio: number; // 3.2 to 4.8 (Lower = Top Speed, Higher = Acceleration)
  driftBias: number; // 0.2 to 0.9 (Higher = Easier Rear Slip Angle)
  nitrousFlowRate: number; // 0.6 to 1.4 (Duration vs Power burst)
  aeroDownforce: number; // 0.3 to 1.0 (Cornering grip vs top speed drag)
}

export interface CarStats {
  hp: number;
  torqueNm: number;
  topSpeedKmh: number;
  accel0to100Sec: number;
  gripScore: number; // 0 - 100
  driftControlScore: number; // 0 - 100
  styleReputationPoints: number; // 100 - 1000
  weightKg: number;
  redlineRpm: number;
}

export interface DynoPoint {
  rpm: number;
  hp: number;
  torqueNm: number;
}

export interface ChassisSpec {
  id: ChassisId;
  name: string;
  codename: string;
  drivetrain: 'RWD' | 'AWD';
  baseHp: number;
  baseTorqueNm: number;
  baseWeightKg: number;
  baseTopSpeedKmh: number;
  baseGrip: number;
  baseDrift: number;
  redlineRpm: number;
  description: string;
}

export interface TrackSpec {
  id: TrackId;
  name: string;
  district: string;
  laps: number;
  lengthMeters: number;
  difficulty: 'Street' | 'Pro' | 'Underground King';
  prizeFirst: number;
  ambientColor: string;
  accentColor: string;
  description: string;
  waypoints: Array<{ x: number; z: number; width: number }>;
}

export type RivalArchetype = 'grip_runner' | 'drift_king' | 'nitro_interceptor';
export type RivalDifficulty = 'rookie' | 'pro' | 'underground_king';

export interface RivalDifficultySpec {
  id: RivalDifficulty;
  label: string;
  shortLabel: string;
  speedMultiplier: number;
  accelMultiplier: number;
  aggression: number; // 0..1
  prizeMultiplier: number;
  upgradeStage: number; // 0..3
  description: string;
}

export interface RacerState {
  id: string;
  name: string;
  crew: string;
  isPlayer: boolean;
  archetype?: RivalArchetype;
  chassis: ChassisId;
  paintColor: string;
  underglowColor: string;
  // World coordinates & kinematics
  x: number;
  z: number;
  heading: number; // radians, 0 = +Z
  vx: number;
  vz: number;
  speedMs: number;
  speedKmh: number;
  lateralVelocity: number;
  angularVelocity: number;
  steerAngle: number;
  slipAngleRad: number;
  isDrifting: boolean;
  isBraking: boolean;
  isBoosting: boolean;
  // Drivetrain
  rpm: number;
  gear: number; // 1..6
  turboBoostBar: number; // -0.5 to +1.5 bar
  nitrousRemaining: number; // 0..100
  // Track progress
  trackProgress: number; // 0..1 along spline
  totalProgress: number; // lap + trackProgress
  lap: number;
  finished: boolean;
  finishTimeSec: number;
  // Drift scoring (player)
  currentDriftScore: number;
  totalDriftScore: number;
  driftMultiplier: number;
  driftComboTimer: number;
  // Visual & physical dynamics telemetry
  hitFlashTimer: number;
  exhaustFlameIntensity: number;
  longitudinalG?: number;
  lateralG?: number;
  wheelspinIntensity?: number;
  curbRumbleIntensity?: number;
  shiftTimer?: number;
  brakeHeat?: number;
  driftAngleDeg?: number;
  // Top-Down Traffic Survival & Ghost Pass-Through State
  eliminated?: boolean;
  eliminatedAtSec?: number;
  trafficNearMisses?: number;
  ghostOverlap?: number;
  lastTrafficCrashId?: string;
  // Linear Lane-Hop & Non-Cardboard Suspension Articulation State
  hopStartX?: number;
  hopTargetX?: number;
  hopProgress?: number;
  hopDirection?: number;
  hopHeightY?: number;
  hopPitchRad?: number;
  hopRollRad?: number;
  hopYawRad?: number;
  hopLandingCompressionY?: number;
  hopLandingTimer?: number;
  hopJustTookOff?: boolean;
  hopJustLanded?: boolean;
}

export interface RaceSummary {
  placement: number;
  totalRacers: number;
  finishTimeSec: number;
  bestLapSec: number;
  topSpeedReachedKmh: number;
  totalDriftScore: number;
  cashEarned: number;
  reputationEarned: number;
  trackName: string;
  isVictory: boolean;
  aliveCount?: number;
  eliminatedByTraffic?: boolean;
  trafficNearMisses?: number;
}

export interface RecentRaceSession {
  id: string;
  trackId: TrackId;
  trackName: string;
  placement: number;
  totalRacers: number;
  earningsUsdc: string;
  cashEarned: number;
  isVictory: boolean;
  finishedAtMs: number;
}

