import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCarStats,
  computeDynoCurve,
  DEFAULT_CAR_CONFIG,
} from './tuning';
import {
  evaluateTrackSpline,
  getStartGridTransform,
  projectWorldToTrack,
} from './track';
import {
  buildRaceSummary,
  computeFourPlayerCameraFrame,
  computeHighwaySteerControl,
  computeProgressiveHighwayPace,
  computeRivalControls,
  createInitialRacers,
  evaluateEngineTorqueAndLimiter,
  evaluateFourPlayerSessionStatus,
  evaluatePacejkaTireGrip,
  findNearestHighwayLaneIndex,
  getPaintColorOccupancy,
  getPaintSwatchName,
  getPlayerSlotSignature,
  getSortedStandings,
  HIGHWAY_WORLD_LANE_X,
  LOBBY_PAINT_SWATCHES,
  normalizePaintHex,
  resolveRacerCollisions,
  resolveUniqueLanePaintColors,
  RIVAL_DIFFICULTY_CATALOG,
  stepLaneHopKinematics,
  stepSingleRacerPhysics,
  syncFourPlayerHighwayPack,
} from './physics';
import {
  checkRacerTrafficCollision,
  computeTrafficIntensity,
  createInitialTraffic,
  enforcePassableCorridorGuarantee,
  getSurvivalGateSpec,
  stepTrafficVehicles,
} from './traffic';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARC_TESTNET_CHAIN_ID,
  buildAddressExplorerUrl,
  buildTxExplorerUrl,
  calculateOrionRoundAt,
  calculateTargetRoundForRequest,
  computeWagerBreakdown,
  deriveWinnerLaneFromRandomness,
  DRAND_GENESIS_TIME,
  fetchOrionHubTelemetry,
  ORION_DEMO_ROLL_SELECTOR,
  ORION_DEMO_V2_ADDRESS,
  ORION_HUB_NEXT_REQUEST_ID_SELECTOR,
  ORION_HUB_V2_ADDRESS,
  resolveOrionBeaconRandomness,
} from './arcOrionClient';
import {
  Amount,
  AmountError,
  gasTokenToUsdc,
  parseAmount,
  usdcToGasToken,
} from '../onchain-money';
import {
  getChain,
  getUsdc,
  requireChain,
  requireChainByScpBlockchain,
} from '../onchain-facts';
import {
  appendRecentRaceSession,
  DEFAULT_RECENT_RACES,
  MAX_RECENT_RACES,
} from '../components/RecentRacesDashboard';
import { ArcEscrowLedger } from '../server/arcEscrowLedger';
import { MultiplayerRoomManager } from '../server/multiplayerRoomManager';
import { ServerToClientMessage } from '../shared/multiplayerProtocol';

test('computeCarStats scales horsepower, top speed, and style points when upgrading stages', () => {
  const stockStats = computeCarStats({
    ...DEFAULT_CAR_CONFIG,
    engineStage: 0,
    turboStage: 0,
    tiresStage: 0,
    suspensionStage: 0,
    transmissionStage: 0,
    nitrousStage: 0,
    bodyKit: 'stock',
    spoiler: 'none',
  });

  const stage3Stats = computeCarStats({
    ...DEFAULT_CAR_CONFIG,
    engineStage: 3,
    turboStage: 3,
    tiresStage: 3,
    suspensionStage: 3,
    transmissionStage: 3,
    nitrousStage: 3,
    bodyKit: 'widebody',
    spoiler: 'twin_deck',
  });

  assert.ok(
    stage3Stats.hp > stockStats.hp + 300,
    'Stage 3 engine + turbo should add over 300 HP',
  );
  assert.ok(
    stage3Stats.topSpeedKmh > stockStats.topSpeedKmh,
    'Stage 3 build should have higher top speed than stock',
  );
  assert.ok(
    stage3Stats.accel0to100Sec < stockStats.accel0to100Sec,
    'Stage 3 build should accelerate 0-100 km/h faster',
  );
  assert.ok(
    stage3Stats.styleReputationPoints > stockStats.styleReputationPoints,
    'Widebody + Twin Deck spoiler should increase underground style score',
  );
});

test('computeDynoCurve generates monotonically increasing RPM points with valid torque and HP', () => {
  const curve = computeDynoCurve(DEFAULT_CAR_CONFIG);
  assert.ok(curve.length >= 10, 'Dyno curve should have at least 10 sample points');
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i].rpm > curve[i - 1].rpm, 'RPM must increase strictly');
    assert.ok(curve[i].hp > 0 && curve[i].torqueNm > 0, 'HP and Torque must be positive');
  }
});

test('track spline evaluation and world-to-track projection stay consistent', () => {
  const sample = evaluateTrackSpline('olympic_circuit', 0.25);
  const proj = projectWorldToTrack('olympic_circuit', sample.x, sample.z);
  assert.ok(
    Math.abs(proj.lateralOffset) < 1.5,
    'Point on track centerline should have near-zero lateral offset',
  );
  const spawn0 = getStartGridTransform('olympic_circuit', 0);
  const spawnProj = projectWorldToTrack('olympic_circuit', spawn0.x, spawn0.z);
  assert.ok(
    Math.abs(spawnProj.lateralOffset) < spawnProj.halfWidth,
    'Start grid position must lie well inside road boundaries',
  );
});

test('vehicle physics accelerates under throttle, activates N2O boost, and banks drift score', () => {
  const racers = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG);
  const player = racers[0];

  // Accelerate straight for 2 seconds
  for (let i = 0; i < 40; i++) {
    stepSingleRacerPhysics(
      player,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: true },
      DEFAULT_CAR_CONFIG,
      'olympic_circuit',
      0.05,
      i * 0.05,
    );
  }

  assert.ok(player.speedKmh > 90, `Expected speed > 90 km/h, got ${player.speedKmh}`);
  assert.ok(
    player.nitrousRemaining < 100,
    'Using nitrous while accelerating should consume N2O tank',
  );

  // Initiate handbrake drift
  for (let i = 0; i < 20; i++) {
    stepSingleRacerPhysics(
      player,
      { throttle: 1, brake: 0, steer: 1, handbrake: true, nitrous: false },
      DEFAULT_CAR_CONFIG,
      'olympic_circuit',
      0.05,
      2 + i * 0.05,
    );
  }

  assert.ok(
    player.currentDriftScore > 0 || player.totalDriftScore > 0,
    'High-speed handbrake turn should accumulate drift points',
  );
});

test('standings and race summary reward 1st place and drift bonus accurately', () => {
  const racers = createInitialRacers('chinatown_sprint', DEFAULT_CAR_CONFIG);
  racers[0].totalProgress = 3.05;
  racers[0].finished = true;
  racers[0].finishTimeSec = 78.4;
  racers[0].totalDriftScore = 2000;

  const standings = getSortedStandings(racers);
  assert.equal(standings[0].id, 'player');

  const summary = buildRaceSummary(racers, 'chinatown_sprint', 264, 78.4);
  assert.equal(summary.placement, 1);
  assert.equal(summary.isVictory, true);
  assert.ok(summary.cashEarned > 5200, 'Cash earned should include 1st prize + drift bonus');
});

test('AI rival difficulty modifies speed, throttle aggression, and prize payouts', () => {
  const rookieGroup = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG);
  const kingGroup = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG);

  const rookieRival = rookieGroup[1];
  const kingRival = kingGroup[1];

  const rookieCtrl = computeRivalControls(
    rookieRival,
    rookieGroup[0],
    'olympic_circuit',
    1.0,
    'rookie',
  );
  const kingCtrl = computeRivalControls(
    kingRival,
    kingGroup[0],
    'olympic_circuit',
    1.0,
    'underground_king',
  );

  assert.ok(
    kingCtrl.throttle > rookieCtrl.throttle,
    'Blacklist King AI should command higher base throttle than Rookie AI',
  );
  assert.ok(
    RIVAL_DIFFICULTY_CATALOG.underground_king.aggression >
      RIVAL_DIFFICULTY_CATALOG.rookie.aggression,
    'Blacklist King aggression parameter must exceed Rookie',
  );

  // Step both rivals for 2 seconds with per-frame AI control updates and verify Blacklist King reaches higher speed
  for (let i = 0; i < 40; i++) {
    const rCtrl = computeRivalControls(
      rookieRival,
      rookieGroup[0],
      'olympic_circuit',
      i * 0.05,
      'rookie',
    );
    const kCtrl = computeRivalControls(
      kingRival,
      kingGroup[0],
      'olympic_circuit',
      i * 0.05,
      'underground_king',
    );
    stepSingleRacerPhysics(
      rookieRival,
      rCtrl,
      DEFAULT_CAR_CONFIG,
      'olympic_circuit',
      0.05,
      i * 0.05,
      'rookie',
    );
    stepSingleRacerPhysics(
      kingRival,
      kCtrl,
      DEFAULT_CAR_CONFIG,
      'olympic_circuit',
      0.05,
      i * 0.05,
      'underground_king',
    );
  }

  assert.ok(
    kingRival.speedMs > rookieRival.speedMs,
    `Expected King AI speed (${kingRival.speedMs.toFixed(1)}) > Rookie AI speed (${rookieRival.speedMs.toFixed(1)})`,
  );

  const rookieSummary = buildRaceSummary(
    rookieGroup,
    'olympic_circuit',
    240,
    80,
    'rookie',
  );
  const kingSummary = buildRaceSummary(
    kingGroup,
    'olympic_circuit',
    240,
    80,
    'underground_king',
  );
  assert.ok(
    kingSummary.cashEarned > rookieSummary.cashEarned,
    'Winning on Blacklist King difficulty should award higher prize cash than Rookie',
  );
});

test('Pacejka tire curve, dynamic G-force weight transfer, brake heat, and AWD vs RWD traction behave realistically', () => {
  // 1. Pacejka curve rises with small slip angle and maintains slide plateau
  const smallGrip = evaluatePacejkaTireGrip(0.04, 0.16, 0.5);
  const peakGrip = evaluatePacejkaTireGrip(0.16, 0.16, 0.5);
  const slideGrip = evaluatePacejkaTireGrip(0.55, 0.16, 0.5);
  assert.ok(peakGrip > smallGrip, 'Tire lateral force should peak near peakSlipRad');
  assert.ok(slideGrip >= 0.5, 'Tire lateral force in deep drift should respect slideRatio plateau');

  // 2. Longitudinal G-force squat on launch & nose-dive + brake heat on hard braking
  const racers = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG);
  const player = racers[0];
  for (let i = 0; i < 20; i++) {
    stepSingleRacerPhysics(
      player,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: false },
      DEFAULT_CAR_CONFIG,
      'olympic_circuit',
      0.05,
      i * 0.05,
    );
  }
  assert.ok(
    (player.longitudinalG ?? 0) > 0.1,
    `Expected positive longitudinalG under acceleration, got ${player.longitudinalG}`,
  );

  for (let i = 0; i < 5; i++) {
    stepSingleRacerPhysics(
      player,
      { throttle: 0, brake: 1, steer: 0.75, handbrake: false, nitrous: false },
      DEFAULT_CAR_CONFIG,
      'olympic_circuit',
      0.05,
      1.0 + i * 0.05,
    );
  }
  assert.ok(
    (player.longitudinalG ?? 0) < -0.1,
    `Expected negative longitudinalG under heavy braking, got ${player.longitudinalG}`,
  );
  assert.ok(
    (player.brakeHeat ?? 0) > 0.1,
    'Heavy braking from speed should build up rotor brakeHeat',
  );
  assert.ok(
    Math.abs(player.lateralG ?? 0) > 0.15,
    `Cornering at speed should induce non-zero lateralG for chassis roll, got ${player.lateralG}`,
  );

  // 3. RWD (RX-7) induces higher rear wheelspin & drift angle under full-throttle turn than AWD (R34)
  const rx7Config = { ...DEFAULT_CAR_CONFIG, chassis: 'rx7' as const, driftBias: 0.75 };
  const r34Config = { ...DEFAULT_CAR_CONFIG, chassis: 'r34' as const, driftBias: 0.4 };
  const rx7State = createInitialRacers('olympic_circuit', rx7Config)[0];
  const r34State = createInitialRacers('olympic_circuit', r34Config)[0];

  for (let i = 0; i < 21; i++) {
    const steer = i >= 15 ? 0.85 : 0;
    stepSingleRacerPhysics(
      rx7State,
      { throttle: 1, brake: 0, steer, handbrake: false, nitrous: false },
      rx7Config,
      'olympic_circuit',
      0.05,
      i * 0.05,
    );
    stepSingleRacerPhysics(
      r34State,
      { throttle: 1, brake: 0, steer, handbrake: false, nitrous: false },
      r34Config,
      'olympic_circuit',
      0.05,
      i * 0.05,
    );
  }

  assert.ok(
    Math.abs(rx7State.slipAngleRad) > Math.abs(r34State.slipAngleRad),
    `Expected RWD RX-7 slip angle (${Math.abs(rx7State.slipAngleRad).toFixed(3)}) > AWD R34 slip angle (${Math.abs(r34State.slipAngleRad).toFixed(3)})`,
  );
  // Verify that steering right (steer > 0 -> yaw < 0) swings the rear outward (slipAngleRad < 0) rather than crab-walking inward
  assert.ok(
    rx7State.slipAngleRad < 0 && (rx7State.driftAngleDeg ?? 0) < 0,
    `Expected outward rear slip (slipAngleRad < 0) when turning right, got ${rx7State.slipAngleRad}`,
  );
});

test('NFS: Underground 2 EAGL dual-regime physics keeps normal steering planted in Grip mode while Handbrake unlocks deep controllable Drift and fast counter-steer catch', () => {
  const gripConfig = { ...DEFAULT_CAR_CONFIG, chassis: 'r34' as const, driftBias: 0.45 };
  const gripCar = createInitialRacers('olympic_circuit', gripConfig)[0];
  const driftCar = createInitialRacers('olympic_circuit', gripConfig)[0];

  // Bring both cars up to ~145 km/h on the straight
  for (let i = 0; i < 35; i++) {
    stepSingleRacerPhysics(
      gripCar,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: false },
      gripConfig,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
    stepSingleRacerPhysics(
      driftCar,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: false },
      gripConfig,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
  }

  // Turn right for 0.48s: gripCar uses normal steering, driftCar taps handbrake to initiate EAGL powerslide
  for (let i = 0; i < 12; i++) {
    stepSingleRacerPhysics(
      gripCar,
      { throttle: 1, brake: 0, steer: 0.75, handbrake: false, nitrous: false },
      gripConfig,
      'olympic_circuit',
      0.04,
      1.4 + i * 0.04,
    );
    stepSingleRacerPhysics(
      driftCar,
      { throttle: 1, brake: 0, steer: 0.75, handbrake: i < 6, nitrous: false },
      gripConfig,
      'olympic_circuit',
      0.04,
      1.4 + i * 0.04,
    );
  }

  // 1. Grip regime keeps slip angle tight and planted while carving the turn
  assert.ok(
    Math.abs(gripCar.slipAngleRad) < Math.abs(driftCar.slipAngleRad) * 0.55,
    `Expected Grip car slip (${Math.abs(gripCar.slipAngleRad).toFixed(3)}) to stay much tighter than Handbrake Drift car slip (${Math.abs(driftCar.slipAngleRad).toFixed(3)})`,
  );
  assert.ok(
    driftCar.isDrifting || driftCar.currentDriftScore > 0,
    'Handbrake flick should enter active drift state',
  );

  // 2. Counter-steering opposite to the slide snaps the drift car back inline quickly without spinning out
  const peakSlideAngle = Math.abs(driftCar.slipAngleRad);
  for (let i = 0; i < 10; i++) {
    stepSingleRacerPhysics(
      driftCar,
      { throttle: 1, brake: 0, steer: -0.75, handbrake: false, nitrous: false },
      gripConfig,
      'olympic_circuit',
      0.04,
      1.88 + i * 0.04,
    );
  }
  assert.ok(
    Math.abs(driftCar.slipAngleRad) < peakSlideAngle * 0.5,
    `Counter-steer catch should rapidly reduce slip angle from ${peakSlideAngle.toFixed(3)} to ${Math.abs(driftCar.slipAngleRad).toFixed(3)}`,
  );
});

test('Realistic 6-speed top speed limiter reaches rated topSpeedKmh in 6th gear and respects ECU rev-limiter and N2O overboost', () => {
  const stockConfig = {
    ...DEFAULT_CAR_CONFIG,
    engineStage: 0 as const,
    turboStage: 0 as const,
    transmissionStage: 0 as const,
    finalDriveRatio: 4.1,
    spoiler: 'none' as const,
    aeroDownforce: 0.2,
  };
  const stockStats = computeCarStats(stockConfig);
  const car = createInitialRacers('olympic_circuit', stockConfig)[0];
  const spawn = getStartGridTransform('olympic_circuit', 0);

  // Keep car on the start/finish straightaway while preserving forward velocity
  for (let i = 0; i < 650; i++) {
    car.x = spawn.x;
    car.z = spawn.z;
    car.heading = spawn.heading;
    const speed = Math.hypot(car.vx, car.vz);
    car.vx = Math.sin(spawn.heading) * speed;
    car.vz = Math.cos(spawn.heading) * speed;
    stepSingleRacerPhysics(
      car,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: false },
      stockConfig,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
  }

  assert.equal(car.gear, 6, 'Car should shift all the way into 6th gear at top speed');
  assert.ok(
    Math.abs(car.speedKmh - stockStats.topSpeedKmh) <= 3,
    `Expected top speed (${car.speedKmh} km/h) to match rated topSpeedKmh (${stockStats.topSpeedKmh} km/h) within 3 km/h`,
  );
  assert.ok(
    car.speedKmh <= stockStats.topSpeedKmh + 1,
    `ECU rev-limiter must prevent exceeding rated topSpeedKmh (${stockStats.topSpeedKmh} km/h) without N2O, got ${car.speedKmh}`,
  );

  // Verify evaluateEngineTorqueAndLimiter directly across mid-range vs peak rev-limiter threshold
  const maxSpeedMs = stockStats.topSpeedKmh / 3.6;
  const midState = evaluateEngineTorqueAndLimiter(
    maxSpeedMs * 0.5,
    maxSpeedMs,
    5600,
    stockStats.redlineRpm,
    0.8,
    0.2,
    1.0,
  );
  const limiterState = evaluateEngineTorqueAndLimiter(
    maxSpeedMs * 0.992,
    maxSpeedMs,
    stockStats.redlineRpm - 40,
    stockStats.redlineRpm,
    0.8,
    0.2,
    1.0,
  );
  const cappedState = evaluateEngineTorqueAndLimiter(
    maxSpeedMs * 1.005,
    maxSpeedMs,
    stockStats.redlineRpm,
    stockStats.redlineRpm,
    0.8,
    0.2,
    1.0,
  );

  assert.equal(midState.isHittingRevLimiter, false);
  assert.equal(
    limiterState.isHittingRevLimiter,
    true,
    'Engine must enter rev-limiter state near peak performance threshold',
  );
  assert.ok(
    limiterState.dragOppositionFactor > midState.dragOppositionFactor * 2.5,
    'Quadratic aerodynamic drag opposition must increase steeply near top speed',
  );
  assert.equal(
    cappedState.netDriveFactor,
    0,
    'Hard ECU rev limiter must cut net drive thrust to 0 at or above peak speed threshold',
  );

  // Engaging N2O at top speed temporarily pushes past the natural redline ceiling
  for (let i = 0; i < 45; i++) {
    car.x = spawn.x;
    car.z = spawn.z;
    car.heading = spawn.heading;
    const speed = Math.hypot(car.vx, car.vz);
    car.vx = Math.sin(spawn.heading) * speed;
    car.vz = Math.cos(spawn.heading) * speed;
    stepSingleRacerPhysics(
      car,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: true },
      stockConfig,
      'olympic_circuit',
      0.04,
      26 + i * 0.04,
    );
  }
  assert.ok(
    car.speedKmh > stockStats.topSpeedKmh + 12,
    `Expected N2O overboost speed (${car.speedKmh} km/h) to exceed natural top speed (${stockStats.topSpeedKmh} km/h)`,
  );
});

test('Car colliding with outer track barrier slides forward continuously without sticking to discrete spline sample points', () => {
  // 1. Right barrier sustained wall-grind (sign = +1)
  const carRight = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG)[0];
  const initialProgressRight = carRight.totalProgress;
  let rightWallHits = 0;

  for (let i = 0; i < 75; i++) {
    const prevProgress = carRight.totalProgress;
    const res = stepSingleRacerPhysics(
      carRight,
      { throttle: 1, brake: 0, steer: 1, handbrake: false, nitrous: false },
      DEFAULT_CAR_CONFIG,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
    if (res.wallImpactMagnitude > 0) {
      rightWallHits++;
      assert.ok(
        carRight.totalProgress > prevProgress,
        `Right-wall progress must keep advancing on step ${i}, prev=${prevProgress}, curr=${carRight.totalProgress}`,
      );
    }
  }

  assert.ok(rightWallHits > 5, 'Car should have contacted the right wall multiple times');
  assert.ok(
    carRight.totalProgress > initialProgressRight + 0.025,
    `Car must slide forward along the right barrier instead of sticking (progress gained: ${(carRight.totalProgress - initialProgressRight).toFixed(4)})`,
  );
  assert.ok(
    carRight.speedKmh > 60,
    `Car should maintain forward sliding speed along the right wall, got ${carRight.speedKmh} km/h`,
  );

  // 2. Left barrier sustained wall-grind (sign = -1) + peeling away from wall
  const carLeft = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG)[0];
  const initialProgressLeft = carLeft.totalProgress;
  let leftWallHits = 0;

  for (let i = 0; i < 65; i++) {
    const prevProgress = carLeft.totalProgress;
    const res = stepSingleRacerPhysics(
      carLeft,
      { throttle: 1, brake: 0, steer: -1, handbrake: false, nitrous: false },
      DEFAULT_CAR_CONFIG,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
    if (res.wallImpactMagnitude > 0) {
      leftWallHits++;
      assert.ok(
        carLeft.totalProgress > prevProgress,
        `Left-wall progress must keep advancing on step ${i}, prev=${prevProgress}, curr=${carLeft.totalProgress}`,
      );
    }
  }

  assert.ok(leftWallHits > 5, 'Car should have contacted the left wall multiple times');
  assert.ok(
    carLeft.totalProgress > initialProgressLeft + 0.025,
    `Car must slide forward along the left barrier instead of sticking`,
  );
  assert.ok(
    carLeft.speedKmh > 60,
    `Car should maintain forward sliding speed along the left wall, got ${carLeft.speedKmh} km/h`,
  );

  // Steer right (away from the left wall) and verify the car detaches cleanly
  let detachedSteps = 0;
  for (let i = 0; i < 20; i++) {
    const res = stepSingleRacerPhysics(
      carLeft,
      { throttle: 1, brake: 0, steer: 0.7, handbrake: false, nitrous: false },
      DEFAULT_CAR_CONFIG,
      'olympic_circuit',
      0.04,
      (65 + i) * 0.04,
    );
    if (res.wallImpactMagnitude === 0) {
      detachedSteps++;
    }
  }
  assert.ok(detachedSteps >= 15, `Car should detach cleanly when steering away from the barrier (detachedSteps=${detachedSteps})`);

  // 3. Steep-angle (80-90 deg head-on) barrier crash deflection and tight corner wall-grind across all 3 tracks
  for (const trackId of ['olympic_circuit', 'chinatown_sprint', 'harbor_drift'] as const) {
    for (const wallSide of [-1, 1] as const) {
      const carCrash = createInitialRacers(trackId, DEFAULT_CAR_CONFIG)[0];
      // Place car at a sharp corner entry (s = 0.22) angled 82 degrees directly into the barrier at 145 km/h
      const cornerSample = evaluateTrackSpline(trackId, 0.22);
      const maxLat = cornerSample.width * 0.5 - 1.32;
      carCrash.x = cornerSample.x + cornerSample.nx * wallSide * (maxLat + 0.35);
      carCrash.z = cornerSample.z + cornerSample.nz * wallSide * (maxLat + 0.35);
      const wallOutX = cornerSample.nx * wallSide;
      const wallOutZ = cornerSample.nz * wallSide;
      const crashDirX = cornerSample.tx * 0.14 + wallOutX * 0.99;
      const crashDirZ = cornerSample.tz * 0.14 + wallOutZ * 0.99;
      carCrash.heading = Math.atan2(crashDirX, crashDirZ);
      carCrash.vx = crashDirX * 40;
      carCrash.vz = crashDirZ * 40;
      carCrash.trackProgress = 0.22;
      carCrash.totalProgress = 0.22;

      const startProgress = carCrash.totalProgress;
      for (let step = 0; step < 120; step++) {
        const prevProg = carCrash.totalProgress;
        const stepRes = stepSingleRacerPhysics(
          carCrash,
          { throttle: 1, brake: 0, steer: wallSide, handbrake: false, nitrous: false },
          DEFAULT_CAR_CONFIG,
          trackId,
          0.025,
          step * 0.025,
        );
        assert.ok(
          carCrash.totalProgress >= prevProg - 1e-4,
          `Track ${trackId} side ${wallSide} step ${step}: progress must never jump backward (${prevProg} -> ${carCrash.totalProgress})`,
        );
        if (step > 5 && stepRes.wallImpactMagnitude > 0) {
          assert.ok(
            stepRes.wallImpactMagnitude < 0.42,
            `Sustained wall slide on ${trackId} must keep wallImpactMagnitude below heavy-crash threshold 0.42, got ${stepRes.wallImpactMagnitude}`,
          );
        }
      }
      assert.ok(
        carCrash.totalProgress > startProgress + 0.04,
        `Car hitting ${trackId} barrier (side=${wallSide}) at 82 deg must deflect and advance around the corner without sticking`,
      );
      assert.ok(
        carCrash.speedKmh > 55,
        `Car should maintain > 55 km/h after barrier deflection on ${trackId}, got ${carCrash.speedKmh} km/h`,
      );
    }
  }
});

test('Garage tuning parameters (Stage upgrades, Final Drive, Drift Bias, Tires/Aero Braking, Stance/BodyKit, N2O Flow) strongly transform real-time driving physics', () => {
  // 1. Stage 3 Engine + Turbo + Transmission + Tires accelerates much faster than Stock OEM
  const stockCfg = {
    ...DEFAULT_CAR_CONFIG,
    engineStage: 0 as const,
    turboStage: 0 as const,
    transmissionStage: 0 as const,
    tiresStage: 0 as const,
    suspensionStage: 0 as const,
  };
  const stage3Cfg = {
    ...DEFAULT_CAR_CONFIG,
    engineStage: 3 as const,
    turboStage: 3 as const,
    transmissionStage: 3 as const,
    tiresStage: 3 as const,
    suspensionStage: 3 as const,
  };
  const stockCar = createInitialRacers('olympic_circuit', stockCfg)[0];
  const stage3Car = createInitialRacers('olympic_circuit', stage3Cfg)[0];

  for (let i = 0; i < 45; i++) {
    stepSingleRacerPhysics(
      stockCar,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: false },
      stockCfg,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
    stepSingleRacerPhysics(
      stage3Car,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: false },
      stage3Cfg,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
  }
  assert.ok(
    stage3Car.speedKmh >= stockCar.speedKmh + 40,
    `Expected Stage 3 build (${stage3Car.speedKmh} km/h) to out-accelerate Stock build (${stockCar.speedKmh} km/h) by >= 40 km/h in 1.8s`,
  );

  // 2. Short Final Drive (4.70 Quick Launch) launches harder in 0-1.2s while Tall Final Drive (3.30 Top Speed) has higher top speed ceiling
  const shortGearCfg = { ...DEFAULT_CAR_CONFIG, finalDriveRatio: 4.7 };
  const tallGearCfg = { ...DEFAULT_CAR_CONFIG, finalDriveRatio: 3.3 };
  const shortGearStats = computeCarStats(shortGearCfg);
  const tallGearStats = computeCarStats(tallGearCfg);
  assert.ok(
    tallGearStats.topSpeedKmh >= shortGearStats.topSpeedKmh + 35,
    `Tall 3.30 final drive top speed (${tallGearStats.topSpeedKmh}) should exceed short 4.70 final drive (${shortGearStats.topSpeedKmh}) by >= 35 km/h`,
  );

  const shortCar = createInitialRacers('olympic_circuit', shortGearCfg)[0];
  const tallCar = createInitialRacers('olympic_circuit', tallGearCfg)[0];
  for (let i = 0; i < 25; i++) {
    stepSingleRacerPhysics(
      shortCar,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: false },
      shortGearCfg,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
    stepSingleRacerPhysics(
      tallCar,
      { throttle: 1, brake: 0, steer: 0, handbrake: false, nitrous: false },
      tallGearCfg,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
  }
  assert.ok(
    shortCar.speedMs > tallCar.speedMs + 2.5,
    `Short 4.70 final drive (${shortCar.speedMs.toFixed(1)} m/s) should launch noticeably faster than tall 3.30 final drive (${tallCar.speedMs.toFixed(1)} m/s)`,
  );

  // 3. Diff Drift Bias (0.90 Touge Drift vs 0.25 Time-Attack Grip) + Stance/Camber transforms cornering slip angle on ANY chassis (including AWD R34)
  const gripBuildCfg = {
    ...DEFAULT_CAR_CONFIG,
    chassis: 'r34' as const,
    driftBias: 0.25,
    tiresStage: 3 as const,
    bodyKit: 'widebody' as const,
  };
  const tougeBuildCfg = {
    ...DEFAULT_CAR_CONFIG,
    chassis: 'r34' as const,
    driftBias: 0.9,
    tiresStage: 0 as const,
    camberAngle: 7.5,
  };
  const gripBuildCar = createInitialRacers('olympic_circuit', gripBuildCfg)[0];
  const tougeBuildCar = createInitialRacers('olympic_circuit', tougeBuildCfg)[0];

  for (let i = 0; i < 32; i++) {
    const steer = i >= 20 ? 0.85 : 0;
    stepSingleRacerPhysics(
      gripBuildCar,
      { throttle: 1, brake: 0, steer, handbrake: false, nitrous: false },
      gripBuildCfg,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
    stepSingleRacerPhysics(
      tougeBuildCar,
      { throttle: 1, brake: 0, steer, handbrake: false, nitrous: false },
      tougeBuildCfg,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
  }
  assert.ok(
    Math.abs(tougeBuildCar.driftAngleDeg ?? 0) >
      Math.abs(gripBuildCar.driftAngleDeg ?? 0) * 2.2,
    `Expected Touge Drift setup angle (${Math.abs(tougeBuildCar.driftAngleDeg ?? 0)} deg) > 2.2x Grip setup angle (${Math.abs(gripBuildCar.driftAngleDeg ?? 0)} deg)`,
  );

  // 4. Stage 3 Semi-Slick Tires + Twin-Deck Aero Downforce stops much shorter from 200 km/h than Stock Tires + Wingless
  const weakBrakeCfg = {
    ...DEFAULT_CAR_CONFIG,
    tiresStage: 0 as const,
    suspensionStage: 0 as const,
    spoiler: 'none' as const,
    aeroDownforce: 0.3,
  };
  const proBrakeCfg = {
    ...DEFAULT_CAR_CONFIG,
    tiresStage: 3 as const,
    suspensionStage: 3 as const,
    spoiler: 'twin_deck' as const,
    aeroDownforce: 1.0,
  };
  const weakBrakeCar = createInitialRacers('olympic_circuit', weakBrakeCfg)[0];
  const proBrakeCar = createInitialRacers('olympic_circuit', proBrakeCfg)[0];
  weakBrakeCar.vx = Math.sin(weakBrakeCar.heading) * 55;
  weakBrakeCar.vz = Math.cos(weakBrakeCar.heading) * 55;
  proBrakeCar.vx = Math.sin(proBrakeCar.heading) * 55;
  proBrakeCar.vz = Math.cos(proBrakeCar.heading) * 55;

  for (let i = 0; i < 20; i++) {
    stepSingleRacerPhysics(
      weakBrakeCar,
      { throttle: 0, brake: 1, steer: 0, handbrake: false, nitrous: false },
      weakBrakeCfg,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
    stepSingleRacerPhysics(
      proBrakeCar,
      { throttle: 0, brake: 1, steer: 0, handbrake: false, nitrous: false },
      proBrakeCfg,
      'olympic_circuit',
      0.04,
      i * 0.04,
    );
  }
  assert.ok(
    proBrakeCar.speedKmh <= weakBrakeCar.speedKmh - 35,
    `Stage 3 Tires + Twin-Deck Aero (${proBrakeCar.speedKmh} km/h) must brake >= 35 km/h harder in 0.8s than Stock Wingless (${weakBrakeCar.speedKmh} km/h)`,
  );
});

test('4-Player Top-Down Traffic Survival: side-by-side 4-lane grid, ghost pass-through between racers, civilian car & truck collisions, and Last Car Standing victory', () => {
  const racers = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG);
  assert.equal(racers.length, 4, 'Should spawn 4 racers on the track');

  // 1. Verify all 4 racers spawn across distinct lateral highway lanes
  const lateralOffsets = racers.map(
    (r) => projectWorldToTrack('olympic_circuit', r.x, r.z).lateralOffset,
  );
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      assert.ok(
        Math.abs(lateralOffsets[i] - lateralOffsets[j]) > 2.2,
        `Racers ${i} and ${j} should spawn in distinct highway lanes (${lateralOffsets[i].toFixed(2)} vs ${lateralOffsets[j].toFixed(2)})`,
      );
    }
  }

  // 2. Verify Ghost Pass-Through: overlapping racers never collide physically, push, or slow each other down
  const startX0 = racers[0].x;
  const startZ0 = racers[0].z;
  racers[1].x = startX0 + 0.3;
  racers[1].z = startZ0 + 0.3;
  racers[0].vx = 12;
  racers[1].vx = -12;
  const hitImpact = resolveRacerCollisions(racers, 'olympic_circuit');
  assert.equal(
    hitImpact,
    0,
    'Overlapping racers must be transparent to each other with zero physical collision impact',
  );
  assert.equal(racers[0].x, startX0, 'Ghost pass-through must not push racer 0 laterally');
  assert.equal(racers[0].z, startZ0, 'Ghost pass-through must not push racer 0 longitudinally');
  assert.ok(
    (racers[0].ghostOverlap ?? 0) > 0 && (racers[1].ghostOverlap ?? 0) > 0,
    'Overlapping racers must set positive ghostOverlap for visual translucency',
  );

  // 3. Verify Highway Traffic spawns passenger sedans, SUVs, and heavy cargo trucks and eliminates any racer upon collision
  const traffic = createInitialTraffic('olympic_circuit', 24);
  assert.equal(traffic.length, 24);
  assert.ok(
    traffic.some((v) => v.type === 'sedan') &&
      traffic.some((v) => v.type === 'suv') &&
      traffic.some((v) => v.type === 'truck'),
    'Traffic wave must include civilian passenger sedans, SUVs, and heavy cargo trucks',
  );

  const prevS = traffic[0].s;
  stepTrafficVehicles(traffic, racers, 'olympic_circuit', 0.5, 5.0);
  assert.notEqual(traffic[0].s, prevS, 'Traffic vehicles must advance along the highway');

  // Place rival #1 directly inside a heavy cargo truck's bounding box -> collision detected and game ends for rival #1
  const targetTruck = traffic.find((v) => v.type === 'truck')!;
  racers[1].x = targetTruck.x;
  racers[1].z = targetTruck.z;
  racers[1].heading = targetTruck.heading;
  racers[1].speedMs = 35;
  racers[1].speedKmh = 126;
  const crashCheck = checkRacerTrafficCollision(racers[1], traffic);
  assert.equal(
    crashCheck.collided,
    true,
    'Colliding with a highway cargo truck must trigger elimination',
  );
  assert.equal(crashCheck.hitVehicle?.id, targetTruck.id);
  assert.equal(
    racers[1].eliminated,
    true,
    'Colliding with a traffic vehicle must immediately end the game for that racer (eliminated = true)',
  );
  assert.equal(
    racers[1].speedMs,
    0,
    'Eliminated racer must immediately stop on the track',
  );

  // 4. Verify Last Car Standing victory when all 3 AI rivals crash into traffic
  racers[1].eliminated = true;
  racers[1].eliminatedAtSec = 12.4;
  racers[2].eliminated = true;
  racers[2].eliminatedAtSec = 19.8;
  racers[3].eliminated = true;
  racers[3].eliminatedAtSec = 27.1;

  const winSummary = buildRaceSummary(
    racers,
    'olympic_circuit',
    215,
    27.1,
    'pro',
  );
  assert.equal(winSummary.placement, 1, 'Last surviving racer must win 1st place');
  assert.equal(winSummary.isVictory, true);
  assert.equal(winSummary.aliveCount, 1);
  assert.equal(winSummary.eliminatedByTraffic, false);

  // If the player crashes into traffic first while 2 rivals survive, player finishes #3 and isVictory is false
  racers[0].eliminated = true;
  racers[0].eliminatedAtSec = 15.0;
  racers[2].eliminated = false;
  racers[3].eliminated = false;
  const lossSummary = buildRaceSummary(
    racers,
    'olympic_circuit',
    190,
    15.0,
    'pro',
  );
  assert.equal(lossSummary.placement, 3);
  assert.equal(lossSummary.isVictory, false);
  assert.equal(lossSummary.eliminatedByTraffic, true);

  // 5. Verify traffic progressively intensifies over time (tighter wave spacing, compressed horizon, higher speed)
  const earlyMetrics = computeTrafficIntensity(2);
  const lateMetrics = computeTrafficIntensity(42);
  assert.ok(
    lateMetrics.intensity > earlyMetrics.intensity + 0.75,
    'Traffic intensity should scale up significantly over elapsed time',
  );
  assert.ok(
    lateMetrics.activeHorizonMeters < earlyMetrics.activeHorizonMeters * 0.5,
    `Active traffic corridor should compress over time (${earlyMetrics.activeHorizonMeters}m -> ${lateMetrics.activeHorizonMeters}m)`,
  );
  assert.ok(
    lateMetrics.waveGapMeters < earlyMetrics.waveGapMeters * 0.5,
    `Wave gap should tighten over time (${earlyMetrics.waveGapMeters.toFixed(1)}m -> ${lateMetrics.waveGapMeters.toFixed(1)}m)`,
  );
  assert.equal(earlyMetrics.maxLanesBlockedPerWave, 2);
  assert.equal(lateMetrics.maxLanesBlockedPerWave, 3);

  // 6. Verify traffic vehicles in the same lane NEVER pass through or overlap each other
  const laneTestTraffic = createInitialTraffic('olympic_circuit', 16);
  // Place a fast sedan (26 m/s) directly behind a slow cargo truck (14 m/s) in lane 0
  laneTestTraffic[0].laneIndex = 0;
  laneTestTraffic[0].type = 'truck';
  laneTestTraffic[0].length = 9.4;
  laneTestTraffic[0].speedMs = 14.0;
  laneTestTraffic[0].z = 220;

  laneTestTraffic[1].laneIndex = 0;
  laneTestTraffic[1].type = 'sedan';
  laneTestTraffic[1].length = 4.3;
  laneTestTraffic[1].speedMs = 26.0;
  laneTestTraffic[1].z = 212; // initially too close behind truck

  for (let step = 0; step < 80; step++) {
    stepTrafficVehicles(laneTestTraffic, racers, 'olympic_circuit', 0.1, step * 0.1);
    for (let a = 0; a < laneTestTraffic.length; a++) {
      for (let b = a + 1; b < laneTestTraffic.length; b++) {
        if (laneTestTraffic[a].laneIndex === laneTestTraffic[b].laneIndex) {
          const centerDist = Math.abs(laneTestTraffic[a].z - laneTestTraffic[b].z);
          const minRequired =
            (laneTestTraffic[a].length + laneTestTraffic[b].length) * 0.5 + 4.5;
          assert.ok(
            centerDist >= minRequired,
            `Same-lane traffic vehicles ${a} and ${b} must never overlap (dist=${centerDist.toFixed(2)}m, min=${minRequired.toFixed(2)}m)`,
          );
        }
      }
    }
  }

  // 7. Verify reworked Highway Controls: Tap-to-Switch-Lane, Zero Skid/Drift, and Zero High-Speed Wobble/Overshoot
  for (const testSpeedMs of [32, 75]) {
    const ctrlCar = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG)[0];
    ctrlCar.vz = testSpeedMs;
    ctrlCar.speedMs = testSpeedMs;
    ctrlCar.speedKmh = Math.round(testSpeedMs * 3.6);
    assert.equal(findNearestHighwayLaneIndex(ctrlCar.x), 1); // Starts in lane 1 (x = 1.6)

    // Simulate tapping Left (A) to switch from Lane 1 (x = 1.6) to Lane 0 (x = 4.8)
    const targetLeftLaneX = HIGHWAY_WORLD_LANE_X[0]; // 4.8
    let prevX = ctrlCar.x;
    for (let step = 0; step < 65; step++) {
      const steer = computeHighwaySteerControl(
        ctrlCar.x,
        ctrlCar.heading,
        0,
        targetLeftLaneX,
        false,
        ctrlCar.speedMs,
        ctrlCar.angularVelocity,
      );
      stepSingleRacerPhysics(
        ctrlCar,
        { throttle: 0.85, brake: 0, steer, handbrake: false, nitrous: false },
        DEFAULT_CAR_CONFIG,
        'olympic_circuit',
        0.025,
        step * 0.025,
      );
      assert.equal(
        ctrlCar.isDrifting,
        false,
        `Lane change at ${ctrlCar.speedKmh} km/h must never trigger drifting/skidding (step ${step})`,
      );
      assert.equal(
        ctrlCar.slipAngleRad,
        0,
        `Lane change at ${ctrlCar.speedKmh} km/h must maintain zero rear slip angle (step ${step})`,
      );
      assert.ok(
        ctrlCar.x >= prevX - 0.01 && ctrlCar.x <= targetLeftLaneX + 0.04,
        `High-speed lane change (${ctrlCar.speedKmh} km/h) must not wobble or overshoot target lane x=4.8 (step ${step}, prevX=${prevX.toFixed(3)}, x=${ctrlCar.x.toFixed(3)})`,
      );
      prevX = ctrlCar.x;
    }
    assert.ok(
      Math.abs(ctrlCar.x - targetLeftLaneX) < 0.25,
      `Car at ${ctrlCar.speedKmh} km/h should smoothly center into target left lane x=4.8 (got x=${ctrlCar.x.toFixed(2)})`,
    );
    assert.ok(
      Math.abs(ctrlCar.heading) < 0.03,
      `Car nose at ${ctrlCar.speedKmh} km/h should automatically straighten along +Z after lane change (got heading=${ctrlCar.heading.toFixed(3)} rad)`,
    );
  }

  // 8. Verify Progressive Highway Acceleration (higher initial speed ~95-97 km/h + continuous gradual speed buildup)
  const paceCar = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG)[0];
  paceCar.vz = 26.5;
  paceCar.speedMs = 26.5;
  paceCar.speedKmh = 95;
  paceCar.gear = 3;
  paceCar.rpm = 4200;

  const initPace = computeProgressiveHighwayPace(paceCar.speedMs, 0, false, 0);
  assert.ok(
    initPace.targetSpeedKmh >= 95,
    `Initial highway target speed should be at least 95 km/h (got ${initPace.targetSpeedKmh} km/h)`,
  );

  const speedSnapshots: number[] = [paceCar.speedKmh];
  for (let sec = 1; sec <= 24; sec++) {
    for (let step = 0; step < 20; step++) {
      const t = (sec - 1) + step * 0.05;
      const pace = computeProgressiveHighwayPace(paceCar.speedMs, t, false, 0);
      stepSingleRacerPhysics(
        paceCar,
        {
          throttle: pace.throttle,
          brake: pace.brake,
          steer: 0,
          handbrake: false,
          nitrous: false,
        },
        DEFAULT_CAR_CONFIG,
        'olympic_circuit',
        0.05,
        t,
      );
      assert.equal(paceCar.isBoosting, false, 'Progressive acceleration must not trigger nitro boost state');
    }
    if (sec % 6 === 0) {
      speedSnapshots.push(paceCar.speedKmh);
    }
  }
  for (let i = 1; i < speedSnapshots.length; i++) {
    assert.ok(
      speedSnapshots[i] > speedSnapshots[i - 1] + 15,
      `Car speed must gradually increase over time without nitro (${speedSnapshots.join(' -> ')} km/h)`,
    );
  }

  // 9. Verify Linear Non-Cardboard Lane-Hop (parabolic vertical arc, pitch/roll articulation, and landing shock compression)
  const hopCar = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG)[0];
  stepLaneHopKinematics(hopCar, hopCar.x, 0.02); // Initialize grounded in lane 1 (x = 1.6)
  assert.equal(hopCar.hopProgress, 1);

  const hopTargetX = HIGHWAY_WORLD_LANE_X[0]; // 4.8 (hop left by 3.2m)
  let peakHopY = 0;
  let maxAbsPitch = 0;
  let maxAbsRoll = 0;
  let minLandingCompY = 0;
  let prevHopX = hopCar.x;
  let sawTakeoff = false;
  let sawLanding = false;

  for (let step = 0; step < 25; step++) {
    stepLaneHopKinematics(hopCar, hopTargetX, 0.02);
    if (hopCar.hopJustTookOff) sawTakeoff = true;
    if (hopCar.hopJustLanded) sawLanding = true;
    peakHopY = Math.max(peakHopY, hopCar.hopHeightY ?? 0);
    maxAbsPitch = Math.max(maxAbsPitch, Math.abs(hopCar.hopPitchRad ?? 0));
    maxAbsRoll = Math.max(maxAbsRoll, Math.abs(hopCar.hopRollRad ?? 0));
    minLandingCompY = Math.min(
      minLandingCompY,
      hopCar.hopLandingCompressionY ?? 0,
    );
    assert.ok(
      hopCar.x >= prevHopX - 0.001 && hopCar.x <= hopTargetX + 0.001,
      `Lane-hop X movement must be strictly linear/monotonic without overshoot (prev=${prevHopX.toFixed(3)}, cur=${hopCar.x.toFixed(3)})`,
    );
    prevHopX = hopCar.x;
  }

  assert.equal(sawTakeoff, true, 'Lane hop must flag takeoff event');
  assert.equal(sawLanding, true, 'Lane hop must complete and flag landing event');
  assert.equal(hopCar.x, hopTargetX, 'Car must land squarely on target lane X');
  assert.ok(
    peakHopY > 0.45,
    `Expected physical vertical hop arc > 0.45m (got ${peakHopY.toFixed(3)}m)`,
  );
  assert.ok(
    maxAbsPitch > 0.03 && maxAbsRoll > 0.1,
    `Expected non-cardboard 3D pitch (${maxAbsPitch.toFixed(3)}) and banking roll (${maxAbsRoll.toFixed(3)}) during hop`,
  );
  assert.ok(
    minLandingCompY < -0.03,
    `Expected suspension shock compression on landing < -0.03m (got ${minLandingCompY.toFixed(4)}m)`,
  );

  // 10. Verify 4-Player Highway Pack Synchronization & Constant 4-Player Camera Framing
  const packRacers = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG);
  // Artificially scatter racers along Z initially to verify syncFourPlayerHighwayPack pulls them into a tight 4-car pack
  packRacers[0].z = 200;
  packRacers[0].speedMs = 35;
  packRacers[1].z = 175;
  packRacers[2].z = 230;
  packRacers[3].z = 160;

  for (let s = 0; s < 10; s++) {
    syncFourPlayerHighwayPack(packRacers, s * 0.05, 0.05);
  }

  for (let i = 1; i < packRacers.length; i++) {
    assert.ok(
      Math.abs(packRacers[i].z - packRacers[0].z) <= 2.05,
      `Rival ${i} must stay synchronized within 2.0m of player Z so all 4 racers remain on screen (diff=${Math.abs(packRacers[i].z - packRacers[0].z).toFixed(2)}m)`,
    );
  }

  const camFrame = computeFourPlayerCameraFrame(packRacers);
  assert.equal(camFrame.aliveCount, 4);
  assert.equal(camFrame.camX, 0, 'Camera X must stay locked to highway centerline (0)');
  assert.ok(
    camFrame.camZ < camFrame.minZ - 4.5 && camFrame.lookAtZ > camFrame.maxZ + 10,
    'Camera frustum target and lookAt must encompass all 4 active racers from behind minZ to ahead of maxZ',
  );

  // 11. Verify Concept 2 (Last Player Standing session continuation when Player 1 crashes first)
  const lpsRacers = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG);
  assert.equal(evaluateFourPlayerSessionStatus(lpsRacers).isSessionOver, false);

  // Player 1 crashes at 8.0s while Players 2, 3, 4 remain alive -> session MUST NOT end early!
  lpsRacers[0].eliminated = true;
  lpsRacers[0].eliminatedAtSec = 8.0;
  const afterP1Crash = evaluateFourPlayerSessionStatus(lpsRacers);
  assert.equal(afterP1Crash.aliveCount, 3);
  assert.equal(
    afterP1Crash.isSessionOver,
    false,
    'Session must continue for surviving human players when Player 1 crashes first',
  );
  assert.equal(afterP1Crash.activeAnchorRacer.id, lpsRacers[1].id);

  // Player 2 crashes at 14.5s -> 2 players still alive -> session still continues
  lpsRacers[1].eliminated = true;
  lpsRacers[1].eliminatedAtSec = 14.5;
  const afterP2Crash = evaluateFourPlayerSessionStatus(lpsRacers);
  assert.equal(afterP2Crash.aliveCount, 2);
  assert.equal(afterP2Crash.isSessionOver, false);

  // Player 3 crashes at 21.0s -> Player 4 is the sole surviving Last Player Standing winner!
  lpsRacers[2].eliminated = true;
  lpsRacers[2].eliminatedAtSec = 21.0;
  const afterP3Crash = evaluateFourPlayerSessionStatus(lpsRacers);
  assert.equal(afterP3Crash.aliveCount, 1);
  assert.equal(
    afterP3Crash.isSessionOver,
    true,
    'Session completes once the sole Last Player Standing winner is decided',
  );
  assert.equal(afterP3Crash.winner?.id, lpsRacers[3].id);

  // 12. Verify Concept 3 (Survival Gates cycle open corridors across all 4 lanes) & Concept 4 (4 distinct player visual signatures)
  const openIn3LaneGates = new Set<number>();
  for (let g = 0; g < 4; g++) {
    const gate2 = getSurvivalGateSpec(g, 2);
    assert.equal(gate2.blockedLanes.length, 2);
    assert.equal(gate2.openLanes.length, 2);

    const gate3 = getSurvivalGateSpec(g, 3);
    assert.equal(gate3.blockedLanes.length, 3);
    assert.equal(gate3.openLanes.length, 1);
    openIn3LaneGates.add(gate3.openLanes[0]);
  }
  assert.equal(
    openIn3LaneGates.size,
    4,
    '3-lane needle-eye Survival Gates must cycle their open corridor across all 4 lanes (0..3)',
  );

  const sigHexes = new Set(
    [0, 1, 2, 3].map((slot) => getPlayerSlotSignature(slot).hex),
  );
  assert.equal(
    sigHexes.size,
    4,
    'All 4 human players must have unique neon & hop-trail signature colors',
  );

  // 13. Verify Hard Passable Corridor Validator (enforcePassableCorridorGuarantee): never all 4 lanes blocked in any 24m window
  const wallTraffic = createInitialTraffic('olympic_circuit', 16);
  // Artificially force 4 vehicles side-by-side at Z = 300 across all 4 lanes (0, 1, 2, 3)
  for (let l = 0; l < 4; l++) {
    wallTraffic[l].laneIndex = l;
    wallTraffic[l].z = 300;
  }
  enforcePassableCorridorGuarantee(wallTraffic, 3, 24.0);

  for (let i = 0; i < wallTraffic.length; i++) {
    const anchorZ = wallTraffic[i].z;
    const occupiedLanes = new Set<number>();
    for (let j = 0; j < wallTraffic.length; j++) {
      if (Math.abs(wallTraffic[j].z - anchorZ) <= 24.0) {
        occupiedLanes.add(wallTraffic[j].laneIndex);
      }
    }
    assert.ok(
      occupiedLanes.size <= 3,
      `Passable corridor guarantee must never allow all 4 lanes to be blocked within 24m (got ${occupiedLanes.size} lanes at z=${anchorZ.toFixed(1)})`,
    );
  }
});

test('Arc Testnet (5042002) onchain-money 6/18 decimal bridge and Orion (RandomnessHub v2) Winner-Takes-All wagering math', () => {
  const chain = requireChain(ARC_TESTNET_CHAIN_ID);
  assert.equal(chain.chainId, 5042002);
  assert.equal(chain.nativeCurrency.symbol, 'USDC');
  assert.equal(chain.nativeCurrency.decimals, 18);
  assert.equal(chain.nativeCurrency.isUsdc, true);
  assert.equal(chain.usdc?.decimals, 6);
  assert.equal(
    ORION_HUB_V2_ADDRESS,
    '0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2',
  );
  assert.equal(
    buildAddressExplorerUrl(ARC_TESTNET_CHAIN_ID, ORION_HUB_V2_ADDRESS),
    'https://explorer.testnet.arc.io/address/0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2',
  );

  // 1. Verify exact 6-decimal ERC-20 USDC <-> 18-decimal native gas token bridge (no 10^12 error)
  const fiveUsdc6 = parseAmount(ARC_TESTNET_CHAIN_ID, '5');
  assert.equal(fiveUsdc6.raw, 5_000_000n);
  const fiveUsdcGas18 = usdcToGasToken(ARC_TESTNET_CHAIN_ID, fiveUsdc6);
  assert.equal(fiveUsdcGas18.raw, 5_000_000_000_000_000_000n);
  const roundTrip6 = gasTokenToUsdc(ARC_TESTNET_CHAIN_ID, fiveUsdcGas18, 'exact');
  assert.ok(roundTrip6.eq(fiveUsdc6));

  // 2. Verify Winner-Takes-All 4-player self-wager breakdown
  const wager = computeWagerBreakdown('5', '0.02');
  assert.equal(wager.isWagerEnabled, true);
  assert.equal(wager.stakePerPlayerUsdc.toFixed(2), '5.00');
  assert.equal(wager.totalPotUsdc.toFixed(2), '20.00'); // 4 players * 5 USDC = 20 USDC Winner Takes All
  assert.equal(wager.relayerRewardUsdc.toFixed(2), '0.02');
  assert.equal(wager.relayerRewardGas18.raw, 20_000_000_000_000_000n); // >= 1e16 (0.01 USDC MIN_REWARD)
  assert.equal(wager.playerTotalLockUsdc.toFixed(2), '5.02');

  // Enforce MIN_REWARD floor (0.01 USDC = 1e16 wei) even if a smaller reward string is passed
  const minFloorWager = computeWagerBreakdown('1', '0.001');
  assert.equal(minFloorWager.relayerRewardUsdc.toFixed(2), '0.01');
  assert.equal(minFloorWager.relayerRewardGas18.raw, 10_000_000_000_000_000n);

  // 3. Verify Orion RandomnessHub.roundAt(timestamp) exact boundaries
  const g = DRAND_GENESIS_TIME;
  assert.equal(calculateOrionRoundAt(0n), 1n);
  assert.equal(calculateOrionRoundAt(g), 1n);
  assert.equal(calculateOrionRoundAt(g + 1n), 1n);
  assert.equal(calculateOrionRoundAt(g + 3n), 1n);
  assert.equal(calculateOrionRoundAt(g + 4n), 2n);
  assert.equal(calculateOrionRoundAt(g + 3000n), 1000n);
  assert.equal(calculateOrionRoundAt(g + 3001n), 1001n);

  // Verify 3-period (9-second) safety margin on request
  const reqTs = g + 3000n;
  const targetRound = calculateTargetRoundForRequest(reqTs);
  assert.equal(targetRound, 1003n);

  // 4. Verify deterministic winner lane derivation from 32-byte Orion randomness
  assert.equal(
    deriveWinnerLaneFromRandomness(
      '0x00000000000000000000000000000000000000000000000000000000ee6b2803', // 4,000,000,003 % 4 == 3
    ),
    3,
  );
});

test('Recent Races dashboard history maintains last 5 finished sessions with trackId, placement, and earnings', () => {
  assert.equal(MAX_RECENT_RACES, 5);
  assert.equal(DEFAULT_RECENT_RACES.length, 5);

  const nextWinSession = {
    id: 'session-test-new',
    trackId: 'olympic_circuit' as const,
    trackName: 'Olympic Mid-City Circuit',
    placement: 1,
    totalRacers: 4,
    earningsUsdc: '50.00',
    cashEarned: 18500,
    isVictory: true,
    finishedAtMs: Date.now(),
  };

  const updated = appendRecentRaceSession(DEFAULT_RECENT_RACES, nextWinSession);
  assert.equal(updated.length, 5, 'Recent Races list must cap at 5 entries');
  assert.equal(updated[0].id, 'session-test-new', 'Newest session must be prepended first');
  assert.equal(updated[0].trackId, 'olympic_circuit');
  assert.equal(updated[0].placement, 1);
  assert.equal(updated[0].earningsUsdc, '50.00');
});

test('Arc Studio Onchain Suite: Registry Facts, 6/18-Decimal Money Guards, Custom Fractional Wagers, Live Orion Beacon Telemetry, and Solidity Consumer Rules', async () => {
  // 1. Arc Studio onchain-facts registry verification (Arc Testnet 5042002 & Arc Mainnet 5042)
  const arcTestnet = requireChain(5042002);
  const arcByScp = requireChainByScpBlockchain('ARC-TESTNET');
  assert.deepEqual(arcTestnet, arcByScp);
  assert.equal(arcTestnet.isTestnet, true);
  assert.equal(arcTestnet.nativeCurrency.symbol, 'USDC');
  assert.equal(arcTestnet.nativeCurrency.decimals, 18);
  assert.equal(arcTestnet.nativeCurrency.isUsdc, true);

  const arcUsdcToken = getUsdc(5042002)!;
  assert.ok(arcUsdcToken, 'Arc Testnet must have a registered USDC token entry');
  assert.equal(arcUsdcToken.symbol, 'USDC');
  assert.equal(arcUsdcToken.decimals, 6);
  assert.equal(arcUsdcToken.address, '0x3600000000000000000000000000000000000000');

  const arcMainnet = requireChain(5042);
  assert.equal(arcMainnet.isTestnet, false);
  assert.equal(arcMainnet.nativeCurrency.decimals, 18);
  assert.equal(arcMainnet.nativeCurrency.isUsdc, true);
  assert.equal(getChain(999999999), undefined);

  assert.equal(
    ORION_HUB_V2_ADDRESS,
    '0xe754e552fae5ba55726f0e97a196ee9e19e2f9d2',
  );
  assert.equal(
    ORION_DEMO_V2_ADDRESS,
    '0x1e4861248142748d37b3778aae40df133e0ad5d2',
  );
  assert.equal(
    buildTxExplorerUrl(5042002, '0xabc123'),
    'https://explorer.testnet.arc.io/tx/0xabc123',
  );

  // 2. Arc Studio onchain-money strict type & decimal mismatch guards
  const usdc6 = parseAmount(5042002, '7.5'); // 6 decimals (7_500_000n)
  const gas18 = usdcToGasToken(5042002, usdc6); // 18 decimals (7_500_000_000_000_000_000n)
  assert.equal(usdc6.decimals, 6);
  assert.equal(gas18.decimals, 18);
  assert.equal(gas18.toString(), '7.5');

  // Direct arithmetic between 6-decimal ERC-20 USDC and 18-decimal native gas USDC MUST throw DECIMALS_MISMATCH
  assert.throws(
    () => usdc6.add(gas18),
    (err: unknown) => err instanceof AmountError && err.code === 'DECIMALS_MISMATCH',
    'Adding 6-decimal USDC and 18-decimal gas USDC directly must throw DECIMALS_MISMATCH',
  );

  // Calling parseAmount on a chain without USDC in onchain-facts (e.g. chainId 1) MUST throw NO_USDC
  assert.throws(
    () => parseAmount(1, '7.5'),
    (err: unknown) => err instanceof AmountError && err.code === 'NO_USDC',
    'parseAmount on chain without registered USDC must throw NO_USDC',
  );

  // Calling requireChain on an unregistered chain ID MUST throw the Arc Studio registry guidance error
  assert.throws(
    () => requireChain(11155111),
    /Unknown chain ID 11155111 — ask Arc Studio to add it to its onchain facts registry/,
  );

  // Passing an 18-decimal gas amount into usdcToGasToken (which expects 6-decimal ERC-20 USDC) MUST throw DECIMALS_MISMATCH
  assert.throws(
    () => usdcToGasToken(5042002, gas18),
    (err: unknown) =>
      err instanceof AmountError && err.code === 'DECIMALS_MISMATCH',
    'Passing 18-decimal amount to usdcToGasToken must throw DECIMALS_MISMATCH',
  );

  // Converting 18-decimal gas token with sub-micro-USDC dust in 'exact' mode MUST throw PRECISION_LOSS
  const dustyGas18 = Amount.fromRaw(7_500_000_000_000_000_123n, 18);
  assert.throws(
    () => gasTokenToUsdc(5042002, dustyGas18, 'exact'),
    (err: unknown) => err instanceof AmountError && err.code === 'PRECISION_LOSS',
    'Converting sub-micro-USDC wei in exact mode must throw PRECISION_LOSS',
  );
  // In 'trunc' mode, sub-micro-USDC dust is safely truncated to 6 decimals
  const truncatedUsdc6 = gasTokenToUsdc(5042002, dustyGas18, 'trunc');
  assert.equal(truncatedUsdc6.raw, 7_500_000n);
  assert.equal(truncatedUsdc6.toFixed(2), '7.50');

  // Passing >6 fractional digits to 6-decimal USDC parseAmount MUST throw TOO_MANY_FRACTION_DIGITS
  assert.throws(
    () => parseAmount(5042002, '1.1234567'),
    (err: unknown) =>
      err instanceof AmountError && err.code === 'TOO_MANY_FRACTION_DIGITS',
  );

  // Division by zero MUST throw DIVIDE_BY_ZERO
  assert.throws(
    () => usdc6.div(0n),
    (err: unknown) => err instanceof AmountError && err.code === 'DIVIDE_BY_ZERO',
  );

  // 3. Custom fractional and zero-stake wager calculations
  const customWager = computeWagerBreakdown('7.5', '0.02');
  assert.equal(customWager.isWagerEnabled, true);
  assert.equal(customWager.stakePerPlayerUsdc.toFixed(2), '7.50');
  assert.equal(customWager.totalPotUsdc.toFixed(2), '30.00'); // 4 * 7.50 = 30.00 USDC
  assert.equal(customWager.playerTotalLockUsdc.toFixed(2), '7.52');
  assert.equal(customWager.stakePerPlayerGas18.raw, 7_500_000_000_000_000_000n);
  assert.equal(customWager.totalPotGas18.raw, 30_000_000_000_000_000_000n);

  const freePracticeWager = computeWagerBreakdown('0', '0.02');
  assert.equal(freePracticeWager.isWagerEnabled, false);
  assert.equal(freePracticeWager.totalPotUsdc.toFixed(2), '0.00');
  assert.equal(freePracticeWager.relayerRewardUsdc.toFixed(2), '0.00');
  assert.equal(freePracticeWager.playerTotalLockUsdc.toFixed(2), '0.00');

  // 4. Live Orion RandomnessHub v2 Telemetry & Beacon Randomness Resolution
  assert.equal(ORION_DEMO_ROLL_SELECTOR, '0xcd5e3c5d');
  assert.equal(ORION_HUB_NEXT_REQUEST_ID_SELECTOR, '0x6a84a985');
  const telemetry = await fetchOrionHubTelemetry();
  assert.equal(telemetry.chainId, 5042002);
  assert.equal(telemetry.hubAddress, ORION_HUB_V2_ADDRESS);
  assert.equal(telemetry.demoAddress, ORION_DEMO_V2_ADDRESS);
  assert.ok(
    telemetry.nextRequestId !== null && telemetry.nextRequestId > 0n,
    `Expected live Orion RandomnessHub v2 nextRequestId > 0n, got ${telemetry.nextRequestId}`,
  );
  assert.ok(
    (telemetry.latestDrandRound ?? 0) > 1_000_000,
    `Current drand evmnet round should exceed 1,000,000, got ${telemetry.latestDrandRound}`,
  );
  assert.ok(telemetry.lastUpdatedMs > 0);

  const targetRound = (telemetry.latestDrandRound ?? 15_000_000) + 3;
  const resolvedBeacon = await resolveOrionBeaconRandomness(
    targetRound,
    '42',
  );
  assert.match(
    resolvedBeacon.drandSignatureHex,
    /^0x[0-9a-fA-F.]+$/,
    'Beacon signature must be 0x-prefixed hex preview',
  );
  assert.match(
    resolvedBeacon.randomnessHex,
    /^0x[0-9a-f]{64}$/,
    'Derived randomness must be a 32-byte (64-hex-char) 0x-prefixed digest',
  );
  const derivedLane = deriveWinnerLaneFromRandomness(resolvedBeacon.randomnessHex);
  assert.ok(
    derivedLane >= 0 && derivedLane <= 3,
    `Winner lane must lie in 0..3, got ${derivedLane}`,
  );

  // 5. Solidity Smart Contract Invariants (3 Orion Consumer Rules on Arc)
  const wagerSol = fs.readFileSync(
    path.resolve(process.cwd(), 'contracts/OlympicRaceWager.sol'),
    'utf8',
  );
  const consumerSol = fs.readFileSync(
    path.resolve(process.cwd(), 'contracts/RandomnessConsumer.sol'),
    'utf8',
  );
  const hubInterfaceSol = fs.readFileSync(
    path.resolve(process.cwd(), 'contracts/IRandomnessHub.sol'),
    'utf8',
  );

  assert.ok(
    wagerSol.includes('uint256 public constant MIN_RELAYER_REWARD = 1e16;'),
    'Contract must enforce 0.01 USDC (1e16 wei) minimum relayer reward in 18-decimal native USDC',
  );
  assert.ok(
    wagerSol.includes('uint32 public constant CALLBACK_GAS = 120_000;'),
    'Contract must configure bounded CALLBACK_GAS = 120_000 for RandomnessHub',
  );
  assert.ok(
    wagerSol.includes('uint256 private constant PAYOUT_GAS = 50_000;') &&
      wagerSol.includes('success := call(payoutGas, recipient, amount, 0, 0, 0, 0)'),
    'Contract must cap _payOrCredit transfer gas to 50_000 via memory-safe assembly call',
  );
  assert.ok(
    wagerSol.includes('r.status = RaceStatus.Locked;') &&
      wagerSol.includes('_requestRandomness(CALLBACK_GAS, r.relayerReward)'),
    'Consumer Rule 1: Contract must freeze inputs (RaceStatus.Locked) before calling _requestRandomness',
  );
  assert.ok(
    wagerSol.includes('function _onRandomness(uint256 requestId, bytes32 randomness) internal override') &&
      wagerSol.includes('r.randomness = randomness;') &&
      wagerSol.includes('r.status = RaceStatus.RandomnessReady;'),
    'Consumer Rule 2: _onRandomness callback must only record randomness and status without reverting or transferring funds',
  );
  assert.ok(
    wagerSol.includes('function settleRace(uint256 raceId) external nonReentrant') &&
      wagerSol.includes('_payOrCredit(winner, pot);') &&
      wagerSol.includes('function claim() external nonReentrant'),
    'Consumer Rule 2b: Settlement must occur in a separate transaction with bounded _payOrCredit and pull-over-push claim() fallback',
  );
  assert.ok(
    wagerSol.includes('function cancelExpiredRace(uint256 raceId) external nonReentrant') &&
      wagerSol.includes('if (block.timestamp <= refTime + RACE_TIMEOUT) revert TimeoutNotReached();'),
    'Consumer Rule 3: Contract must provide cancelExpiredRace timeout and refund path',
  );
  assert.ok(
    consumerSol.includes('modifier onlyHub()') &&
      hubInterfaceSol.includes('function requestRandomness(uint32 callbackGas) external payable returns (uint256 id);'),
    'RandomnessConsumer and IRandomnessHub must authenticate the hub and forward 18-decimal native USDC msg.value',
  );
});

test('Unique Player Paint Color Reservation: Players cannot occupy the same paint color in lobby or 3D race', () => {
  assert.ok(
    LOBBY_PAINT_SWATCHES.length >= 6,
    `Lobby must provide at least 6 distinct paint colors so 4 players always have free color choices, got ${LOBBY_PAINT_SWATCHES.length}`,
  );

  // 1. For every swatch and legacy alias, resolveUniqueLanePaintColors must return 4 strictly distinct colors
  const testCandidateColors = [
    ...LOBBY_PAINT_SWATCHES.map((s) => s.hex),
    '#facc15',
    '#1d4ed8',
    '#dc2626',
  ];
  for (const playerChoice of testCandidateColors) {
    const laneColors = resolveUniqueLanePaintColors(playerChoice);
    assert.equal(laneColors.length, 4);
    assert.equal(laneColors[1], normalizePaintHex(playerChoice));
    const uniqueSet = new Set(laneColors);
    assert.equal(
      uniqueSet.size,
      4,
      `Expected 4 strictly unique lane paint colors for player choice ${playerChoice}, got [${laneColors.join(', ')}]`,
    );

    // 2. createInitialRacers must also assign 4 strictly unique paintColor values across all 4 cars
    const racers = createInitialRacers(
      'olympic_circuit',
      { ...DEFAULT_CAR_CONFIG, paintColor: playerChoice },
      laneColors,
    );
    const racerColors = racers.map((r) => normalizePaintHex(r.paintColor));
    assert.equal(
      new Set(racerColors).size,
      4,
      `All 4 racers on the 3D highway must have unique paint colors, got [${racerColors.join(', ')}]`,
    );
  }

  // 3. getPaintColorOccupancy locks colors held by active remote players (ready / ai_bot) and frees waiting slots
  const remoteSlots = [
    {
      laneIndex: 0 as const,
      slotCode: 'P2',
      nickname: 'Kenshin_01',
      paintColor: '#2563eb',
      occupied: true,
    },
    {
      laneIndex: 2 as const,
      slotCode: 'P3',
      nickname: 'Vortex_02',
      paintColor: '#06b6d4',
      occupied: true,
    },
    {
      laneIndex: 3 as const,
      slotCode: 'P4',
      nickname: 'Waiting for player...',
      paintColor: '#f43f5e',
      occupied: false,
    },
  ];

  const blueOcc = getPaintColorOccupancy('#2563eb', remoteSlots);
  assert.equal(blueOcc.taken, true);
  assert.equal(blueOcc.holderSlotCode, 'P2');
  assert.equal(blueOcc.holderNickname, 'Kenshin_01');

  const cyanOcc = getPaintColorOccupancy('#06b6d4', remoteSlots);
  assert.equal(cyanOcc.taken, true);
  assert.equal(cyanOcc.holderSlotCode, 'P3');

  // P4 is waiting (occupied: false), so Crimson (#f43f5e) is NOT locked
  const crimsonOcc = getPaintColorOccupancy('#f43f5e', remoteSlots);
  assert.equal(crimsonOcc.taken, false);

  // Emerald (#10b981) is completely unoccupied
  const emeraldOcc = getPaintColorOccupancy('#10b981', remoteSlots);
  assert.equal(emeraldOcc.taken, false);
  assert.equal(getPaintSwatchName('#10b981'), 'Emerald');
});

test('Deterministic Seeded Highway Traffic: identical Orion seeds produce bit-exact vehicle waves while distinct seeds diverge', () => {
  const racersA = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG);
  const racersB = createInitialRacers('olympic_circuit', DEFAULT_CAR_CONFIG);

  const seed = 0x51a9c3d7;
  const trafficA = createInitialTraffic('olympic_circuit', 28, seed);
  const trafficB = createInitialTraffic('olympic_circuit', 28, seed);
  const trafficDiff = createInitialTraffic('olympic_circuit', 28, seed ^ 0x123456);

  assert.equal(trafficA.length, trafficB.length);
  for (let i = 0; i < trafficA.length; i++) {
    assert.equal(trafficA[i].laneIndex, trafficB[i].laneIndex);
    assert.equal(trafficA[i].type, trafficB[i].type);
    assert.equal(trafficA[i].z, trafficB[i].z);
    assert.equal(trafficA[i].speedMs, trafficB[i].speedMs);
  }

  let diffCount = 0;
  for (let i = 0; i < trafficA.length; i++) {
    if (
      trafficA[i].laneIndex !== trafficDiff[i].laneIndex ||
      trafficA[i].type !== trafficDiff[i].type ||
      Math.abs(trafficA[i].z - trafficDiff[i].z) > 0.01
    ) {
      diffCount += 1;
    }
  }
  assert.ok(diffCount > 0, 'Different Orion traffic seeds must diverge');

  // Step both identical-seed simulations for 5 seconds and confirm exact parity
  for (let step = 0; step < 100; step++) {
    stepTrafficVehicles(trafficA, racersA, 'olympic_circuit', 0.05, step * 0.05, seed);
    stepTrafficVehicles(trafficB, racersB, 'olympic_circuit', 0.05, step * 0.05, seed);
  }

  for (let i = 0; i < trafficA.length; i++) {
    assert.equal(trafficA[i].laneIndex, trafficB[i].laneIndex);
    assert.equal(trafficA[i].z, trafficB[i].z);
    assert.equal(trafficA[i].type, trafficB[i].type);
  }
});

test('Server-Authoritative Atomic Paint Color Locking: First-Write-Wins rejects duplicate color with COLOR_OCCUPIED', () => {
  const manager = new MultiplayerRoomManager(new ArcEscrowLedger(), {
    lobbyEscrowTimeoutMs: 60_000,
    countdownDurationMs: 3_000,
  });

  const msgsA: ServerToClientMessage[] = [];
  const msgsB: ServerToClientMessage[] = [];

  manager.registerClient('pA', '0x1111111111111111111111111111111111111111', 'Alpha', '#2563eb', (m) =>
    msgsA.push(m),
  );
  manager.registerClient('pB', '0x2222222222222222222222222222222222222222', 'Bravo', '#2563eb', (m) =>
    msgsB.push(m),
  );

  manager.handleMessage('pA', { type: 'room:create', stakeTierUsdc: '5' }, 1000);
  const createdState = msgsA.find((m) => m.type === 'room:state' && m.room);
  assert.ok(createdState && createdState.type === 'room:state' && createdState.room);
  const roomCode = createdState.room.roomCode;

  // Player B joins preferring the exact same Blue (#2563eb) — server must auto-assign a distinct free color
  manager.handleMessage('pB', { type: 'room:join', roomCode }, 1100);
  const stateAfterJoin = manager.getRoomState(roomCode, 1100)!;
  const occupiedSlots = stateAfterJoin.slots.filter((s) => s.status !== 'waiting');
  assert.equal(occupiedSlots.length, 2);
  assert.notEqual(
    occupiedSlots[0].paintColor,
    occupiedSlots[1].paintColor,
    'Joining player must automatically receive a distinct paint color',
  );

  // Player B explicitly attempts to steal Player A's Blue (#2563eb)
  manager.handleMessage('pB', { type: 'room:select_color', paintColor: '#2563eb' }, 1200);
  const colorErr = msgsB.find((m) => m.type === 'room:error' && m.code === 'COLOR_OCCUPIED');
  assert.ok(colorErr, 'Server must reject duplicate color claim with COLOR_OCCUPIED');
});

test('Human-Only 2..4 Player Quorum Launch: spawns strictly live human racers with zero AI bots and dynamic N×Stake pot', () => {
  const manager = new MultiplayerRoomManager(new ArcEscrowLedger(), {
    lobbyEscrowTimeoutMs: 60_000,
    countdownDurationMs: 3_000,
  });

  const msgsA: ServerToClientMessage[] = [];
  const msgsB: ServerToClientMessage[] = [];

  manager.registerClient('p1', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'DriverOne', '#2563eb', (m) =>
    msgsA.push(m),
  );
  manager.registerClient('p2', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'DriverTwo', '#fbb124', (m) =>
    msgsB.push(m),
  );

  manager.handleMessage('p1', { type: 'room:quick_match', stakeTierUsdc: '5' }, 1000);
  manager.handleMessage('p2', { type: 'room:quick_match', stakeTierUsdc: '5' }, 1100);

  // Both lock 5 USDC stakes -> countdown starts
  manager.handleMessage('p1', { type: 'room:lock_stake' }, 1200);
  manager.handleMessage('p2', { type: 'room:lock_stake' }, 1300);

  // Advance past 3s countdown
  manager.stepAllRooms(1 / 60, 4_500);

  const startMsg = msgsA.find((m) => m.type === 'match:start');
  assert.ok(startMsg && startMsg.type === 'match:start', '2 live humans must trigger match:start');
  assert.equal(
    startMsg.payload.activeRacers.length,
    2,
    'Online match with 2 humans must spawn exactly 2 racers (zero AI bots)',
  );
  assert.equal(
    startMsg.payload.potFormatted,
    '10.00',
    'Dynamic Winner Pot for 2 players at 5 USDC each must be 10.00 USDC',
  );
});

test('Mid-Race Disconnect Stake Forfeiture: disconnected player forfeits locked stake to pot and survivor receives full payout', () => {
  const ledger = new ArcEscrowLedger();
  const manager = new MultiplayerRoomManager(ledger, {
    lobbyEscrowTimeoutMs: 60_000,
    countdownDurationMs: 1_000,
  });

  const walletA = '0x1000000000000000000000000000000000000001';
  const walletB = '0x2000000000000000000000000000000000000002';
  const msgsA: ServerToClientMessage[] = [];
  const msgsB: ServerToClientMessage[] = [];

  manager.registerClient('pA', walletA, 'Survivor', '#2563eb', (m) => msgsA.push(m));
  manager.registerClient('pB', walletB, 'Quitter', '#fbb124', (m) => msgsB.push(m));

  manager.handleMessage('pA', { type: 'room:create', stakeTierUsdc: '5' }, 1000);
  const created = msgsA.find((m) => m.type === 'room:state' && m.room);
  assert.ok(created && created.type === 'room:state' && created.room);
  const roomCode = created.room.roomCode;

  manager.handleMessage('pB', { type: 'room:join', roomCode }, 1100);
  manager.handleMessage('pA', { type: 'room:lock_stake' }, 1200);
  manager.handleMessage('pB', { type: 'room:lock_stake' }, 1300);

  // Launch match
  manager.stepAllRooms(1 / 60, 2_500);
  const balanceBAfterLock = BigInt(ledger.getWalletSnapshot(walletB).balanceUsdc6);

  // Player B disconnects mid-race
  manager.handleDisconnect('pB', 3_000);

  // Balance of Player B MUST NOT be refunded (stake remains committed in active pot)
  const balanceBAfterDisconnect = BigInt(ledger.getWalletSnapshot(walletB).balanceUsdc6);
  assert.equal(
    balanceBAfterDisconnect,
    balanceBAfterLock,
    'Mid-race disconnect must NOT refund locked stake',
  );

  // Step authoritative 60 Hz loop until traffic eliminates one racer and settles the match
  let finishedPayload:
    | Extract<ServerToClientMessage, { type: 'match:finished' }>['payload']
    | null = null;
  for (let i = 0; i < 60 * 90; i++) {
    // Player A hops safely occasionally while Player B has zero input
    if (i % 90 === 0) {
      const targetLane = ((i / 90) % 4) as 0 | 1 | 2 | 3;
      manager.handleMessage('pA', { type: 'input:lane_hop', targetLaneIndex: targetLane, clientSeq: i }, 3_000 + i * 16);
    }
    manager.stepAllRooms(1 / 60, 3_000 + i * 16);
    const fin = msgsA.find((m) => m.type === 'match:finished');
    if (fin && fin.type === 'match:finished') {
      finishedPayload = fin.payload;
      break;
    }
  }

  assert.ok(finishedPayload, 'Match must eventually conclude via server traffic collisions');
  assert.equal(
    finishedPayload.payoutFormatted,
    '10.00',
    'Winner must receive the full 2×5 = 10.00 USDC pot including the disconnected player’s committed stake',
  );
});

test('Pre-Race 60-Second Lobby Timeout Refund: unlaunched lobby automatically refunds locked USDC stakes after 60 seconds', () => {
  const ledger = new ArcEscrowLedger();
  const manager = new MultiplayerRoomManager(ledger, {
    lobbyEscrowTimeoutMs: 60_000,
    countdownDurationMs: 3_000,
  });

  const walletA = '0x3000000000000000000000000000000000000003';
  const msgsA: ServerToClientMessage[] = [];

  manager.registerClient('pA', walletA, 'WaitingHost', '#2563eb', (m) => msgsA.push(m));
  const initialBalance = BigInt(ledger.getWalletSnapshot(walletA).balanceUsdc6);

  manager.handleMessage('pA', { type: 'room:create', stakeTierUsdc: '10' }, 10_000);
  const created = msgsA.find((m) => m.type === 'room:state' && m.room);
  assert.ok(created && created.type === 'room:state' && created.room);
  const roomCode = created.room.roomCode;

  // Host locks 10 USDC (+0.01 relayer reward), nobody else joins
  manager.handleMessage('pA', { type: 'room:lock_stake' }, 10_500);
  const lockedBalance = BigInt(ledger.getWalletSnapshot(walletA).balanceUsdc6);
  assert.ok(
    lockedBalance < initialBalance,
    'Locking stake must debit player balance on the server ledger',
  );

  // At 59s elapsed (69_500 ms), stake is still locked
  manager.stepAllRooms(1 / 60, 69_500);
  assert.equal(BigInt(ledger.getWalletSnapshot(walletA).balanceUsdc6), lockedBalance);

  // At 60s+ elapsed (70_600 ms), lobby timer expires -> automatic full refund
  manager.stepAllRooms(1 / 60, 70_600);
  const refundedBalance = BigInt(ledger.getWalletSnapshot(walletA).balanceUsdc6);
  assert.equal(
    refundedBalance,
    initialBalance,
    '60-second pre-race lobby timeout must automatically refund the full locked stake + relayer reward',
  );

  const roomAfterTimeout = manager.getRoomState(roomCode, 70_600)!;
  assert.equal(roomAfterTimeout.escrowStatus, 'refunded_timeout');
  assert.equal(roomAfterTimeout.stakedCount, 0);
});



