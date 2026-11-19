import {
  CarConfig,
  CarStats,
  ChassisId,
  ChassisSpec,
  DynoPoint,
} from './types';

export const CHASSIS_CATALOG: Record<ChassisId, ChassisSpec> = {
  rx7: {
    id: 'rx7',
    name: 'Lancer Evo VIII MR',
    codename: 'CT9A 4G63T Sedan',
    drivetrain: 'RWD',
    baseHp: 280,
    baseTorqueNm: 355,
    baseWeightKg: 1410,
    baseTopSpeedKmh: 198,
    baseGrip: 68,
    baseDrift: 88,
    redlineRpm: 8000,
    description:
      '2000s Japanese turbo rally-bred 4-door sports sedan with front-mount intercooler, hood extractor vent, and high-mount wing.',
  },
  r34: {
    id: 'r34',
    name: 'Shinigami GT-R34',
    codename: 'BNR34 ATTESA AWD',
    drivetrain: 'AWD',
    baseHp: 320,
    baseTorqueNm: 392,
    baseWeightKg: 1540,
    baseTopSpeedKmh: 206,
    baseGrip: 86,
    baseDrift: 72,
    redlineRpm: 8200,
    description:
      'All-wheel-drive inline-six Godzilla built for relentless corner-exit traction and late-braking dominance.',
  },
  supra: {
    id: 'supra',
    name: 'Vortex MK-IV Aero',
    codename: 'JZA80 2JZ-GTE',
    drivetrain: 'RWD',
    baseHp: 330,
    baseTorqueNm: 440,
    baseWeightKg: 1490,
    baseTopSpeedKmh: 212,
    baseGrip: 74,
    baseDrift: 80,
    redlineRpm: 7800,
    description:
      'Bulletproof cast-iron straight-six highway monster capable of massive big-single turbo boost and top-end velocity.',
  },
};

export const DEFAULT_CAR_CONFIG: CarConfig = {
  chassis: 'rx7',
  paintColor: '#facc15',
  pearlColor: '#fde047',
  paintFinish: 'metallic',
  vinylStyle: 'none',
  vinylColor: '#0f172a',
  rimStyle: 'te37',
  rimColor: '#f8fafc',
  bodyKit: 'street',
  spoiler: 'gt_wing',
  underglowColor: '#f59e0b',
  underglowEnabled: true,
  headlightColor: '#f8fafc',
  windowTint: 0.55,
  rideHeight: -0.02,
  camberAngle: 1.8,
  engineStage: 1,
  turboStage: 1,
  transmissionStage: 1,
  suspensionStage: 1,
  tiresStage: 1,
  nitrousStage: 1,
  finalDriveRatio: 4.1,
  driftBias: 0.62,
  nitrousFlowRate: 1.0,
  aeroDownforce: 0.65,
};

export const PAINT_SWATCHES = [
  { name: 'Evo Lightning Yellow', hex: '#facc15' },
  { name: 'Midnight Bayside Blue', hex: '#1d4ed8' },
  { name: 'Ralliart Palma Red', hex: '#dc2626' },
  { name: 'Jade Touge Green', hex: '#10b981' },
  { name: 'Tarmac Black Pearl', hex: '#18181b' },
  { name: 'Scotia Racing White', hex: '#f8fafc' },
  { name: 'Electric Violet', hex: '#7c3aed' },
  { name: 'Titanium Gunmetal', hex: '#475569' },
];

export const UNDERGLOW_SWATCHES = [
  { name: 'Ice Cyan', hex: '#06b6d4' },
  { name: 'Nitro Amber', hex: '#f59e0b' },
  { name: 'Redline Crimson', hex: '#ef4444' },
  { name: 'Venom Emerald', hex: '#10b981' },
  { name: 'Ultraviolet Pulse', hex: '#a855f7' },
  { name: 'Pure Xenon White', hex: '#f8fafc' },
];

export const UPGRADE_STAGE_NAMES = [
  'Stock OEM',
  'Stage 1 Street',
  'Stage 2 Pro Spec',
  'Stage 3 Underground Extreme',
];

export const UPGRADE_PRICES = [0, 1800, 4200, 8500];

export function computeCarStats(config: CarConfig): CarStats {
  const spec = CHASSIS_CATALOG[config.chassis];

  // Horsepower & Torque scaling from Engine + Turbo tuning
  const engineHpBonus = config.engineStage * 64;
  const turboHpBonus = config.turboStage * 86;
  const bodyAeroWeightDelta =
    config.bodyKit === 'widebody' ? -32 : config.bodyKit === 'street' ? -15 : 0;
  const stageWeightReduction =
    (config.suspensionStage + config.transmissionStage) * 18;

  const weightKg = Math.max(
    1020,
    Math.round(spec.baseWeightKg + bodyAeroWeightDelta - stageWeightReduction),
  );

  const hp = Math.round(spec.baseHp + engineHpBonus + turboHpBonus);
  const torqueNm = Math.round(
    spec.baseTorqueNm + config.engineStage * 58 + config.turboStage * 104,
  );

  // Final drive, ride height & aero strongly trade top speed vs cornering/launch acceleration
  const gearTopSpeedFactor = (4.1 - config.finalDriveRatio) * 32;
  const spoilerDragPenalty =
    config.spoiler === 'twin_deck'
      ? 6
      : config.spoiler === 'gt_wing'
        ? 4
        : config.spoiler === 'ducktail'
          ? 1.5
          : 0;
  const rideHeightDragDelta = (config.rideHeight + 0.02) * 75;
  const aeroDragPenalty =
    (config.aeroDownforce - 0.5) * 18 + spoilerDragPenalty + rideHeightDragDelta;
  const spoilerDownforceBonus =
    config.spoiler === 'twin_deck'
      ? 12
      : config.spoiler === 'gt_wing'
        ? 9
        : config.spoiler === 'ducktail'
          ? 4
          : 0;

  // Realistic street & NFSU2 top speed ceiling:
  // Stock OEM: ~198-212 km/h | Stage 3 + Tall Final Drive (3.30) + Low Drag: up to 315 km/h
  const topSpeedKmh = Math.round(
    Math.min(
      315,
      Math.max(
        172,
        spec.baseTopSpeedKmh +
          (hp - spec.baseHp) * 0.14 +
          config.transmissionStage * 9 +
          gearTopSpeedFactor -
          aeroDragPenalty,
      ),
    ),
  );

  // 0-100 km/h in seconds
  const powerToWeight = hp / (weightKg / 1000);
  const tireLaunchBonus = config.tiresStage * 0.28;
  const transShiftBonus = config.transmissionStage * 0.14;
  const gearLaunchBonus = (config.finalDriveRatio - 3.8) * 0.45;
  const awdLaunchBonus = spec.drivetrain === 'AWD' ? 0.38 : 0;
  const raw0to100 =
    5.85 -
    (powerToWeight - 210) * 0.0072 -
    tireLaunchBonus -
    transShiftBonus -
    gearLaunchBonus -
    awdLaunchBonus;
  const accel0to100Sec = Number(Math.max(1.95, Math.min(6.4, raw0to100)).toFixed(2));

  // Grip score (0..100)
  const bodyKitGripBonus =
    config.bodyKit === 'widebody' ? 8 : config.bodyKit === 'street' ? 4 : 0;
  const stanceGripBonus = Math.round(-config.rideHeight * 85 + config.camberAngle * 1.2);
  const rawGrip =
    spec.baseGrip +
    config.tiresStage * 7 +
    config.suspensionStage * 6 +
    bodyKitGripBonus +
    stanceGripBonus +
    spoilerDownforceBonus +
    Math.round(config.aeroDownforce * 14) -
    Math.round(config.driftBias * 16);
  const gripScore = Math.max(25, Math.min(100, rawGrip));

  // Drift Control score (0..100)
  const rawDrift =
    spec.baseDrift +
    config.suspensionStage * 4 +
    Math.round(config.driftBias * 24) +
    Math.round(config.camberAngle * 2.2) +
    (config.bodyKit === 'widebody' ? 7 : config.bodyKit === 'street' ? 3 : 0);
  const driftControlScore = Math.max(30, Math.min(100, rawDrift));

  // Style / Underground Reputation rating
  const bodyStylePts =
    config.bodyKit === 'widebody' ? 160 : config.bodyKit === 'street' ? 85 : 20;
  const spoilerPts =
    config.spoiler === 'twin_deck'
      ? 110
      : config.spoiler === 'gt_wing'
        ? 95
        : config.spoiler === 'ducktail'
          ? 60
          : 0;
  const finishPts =
    config.paintFinish === 'pearlescent' || config.paintFinish === 'chrome'
      ? 90
      : 55;
  const vinylPts = config.vinylStyle !== 'none' ? 75 : 0;
  const underglowPts = config.underglowEnabled ? 85 : 0;
  const stancePts =
    Math.round(Math.abs(config.rideHeight) * 600) +
    Math.round(config.camberAngle * 8);
  const perfStylePts =
    (config.engineStage +
      config.turboStage +
      config.nitrousStage +
      config.suspensionStage +
      config.tiresStage +
      config.transmissionStage) *
    22;

  const styleReputationPoints = Math.min(
    1000,
    150 +
      bodyStylePts +
      spoilerPts +
      finishPts +
      vinylPts +
      underglowPts +
      stancePts +
      perfStylePts,
  );

  return {
    hp,
    torqueNm,
    topSpeedKmh,
    accel0to100Sec,
    gripScore,
    driftControlScore,
    styleReputationPoints,
    weightKg,
    redlineRpm: spec.redlineRpm + config.engineStage * 250,
  };
}

export function computeDynoCurve(config: CarConfig): DynoPoint[] {
  const stats = computeCarStats(config);
  const points: DynoPoint[] = [];
  const minRpm = 1500;
  const maxRpm = stats.redlineRpm;
  const steps = 14;

  // Turbo spool peak shifts based on turboStage
  const spoolRpm = 3400 + config.turboStage * 250;

  for (let i = 0; i <= steps; i++) {
    const rpm = Math.round(minRpm + (i / steps) * (maxRpm - minRpm));
    const normRpm = (rpm - minRpm) / (maxRpm - minRpm);

    // Torque bell curve + turbo boost surge
    const baseCurve = Math.sin(normRpm * Math.PI * 0.88 + 0.15);
    const turboSurge =
      config.turboStage > 0
        ? 1 / (1 + Math.exp(-(rpm - spoolRpm) / 550))
        : 0.35;

    const torqueFactor =
      0.52 + 0.32 * baseCurve + 0.24 * turboSurge * (1 - normRpm * 0.22);
    const torqueNm = Math.round(stats.torqueNm * Math.min(1.04, torqueFactor));

    // Power (HP) = Torque (Nm) * RPM / 7127, scaled to peak at stats.hp
    const rawHp = (torqueNm * rpm) / 7127;
    const peakNormalizer = stats.hp / ((stats.torqueNm * 0.94 * (maxRpm * 0.86)) / 7127);
    const hp = Math.min(
      stats.hp,
      Math.max(45, Math.round(rawHp * peakNormalizer)),
    );

    points.push({ rpm, hp, torqueNm });
  }

  return points;
}

export const PRESET_BUILDS: Array<{
  name: string;
  tag: string;
  config: Partial<CarConfig>;
}> = [
  {
    name: 'Yellow Evo VIII MR',
    tag: '4G63T Street Rally Spec',
    config: {
      chassis: 'rx7',
      paintColor: '#facc15',
      pearlColor: '#fde047',
      paintFinish: 'metallic',
      bodyKit: 'street',
      spoiler: 'gt_wing',
      rimStyle: 'te37',
      rimColor: '#f8fafc',
      underglowColor: '#f59e0b',
      underglowEnabled: true,
      vinylStyle: 'none',
      camberAngle: 1.8,
      rideHeight: -0.02,
      driftBias: 0.62,
      finalDriveRatio: 4.1,
    },
  },
  {
    name: 'Midnight Wangan R34',
    tag: 'AWD Grip & Track Assassin',
    config: {
      chassis: 'r34',
      paintColor: '#1d4ed8',
      pearlColor: '#06b6d4',
      paintFinish: 'metallic',
      bodyKit: 'widebody',
      spoiler: 'twin_deck',
      rimStyle: 'bbs',
      underglowColor: '#06b6d4',
      underglowEnabled: true,
      vinylStyle: 'twin_stripes',
      camberAngle: 3.0,
      rideHeight: -0.04,
      driftBias: 0.38,
      finalDriveRatio: 3.7,
      aeroDownforce: 0.85,
    },
  },
  {
    name: 'Blacklist Highway Supra',
    tag: 'Top-Speed Nitrous Monster',
    config: {
      chassis: 'supra',
      paintColor: '#18181b',
      pearlColor: '#10b981',
      paintFinish: 'chrome',
      bodyKit: 'widebody',
      spoiler: 'gt_wing',
      rimStyle: 'aero',
      underglowColor: '#10b981',
      underglowEnabled: true,
      vinylStyle: 'carbon_hood',
      camberAngle: 2.5,
      rideHeight: -0.04,
      driftBias: 0.52,
      finalDriveRatio: 3.45,
      nitrousFlowRate: 1.3,
    },
  },
];
