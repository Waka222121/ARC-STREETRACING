import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { soundEngine } from './audio';
import { buildProceduralCar, CarRigHandles } from './carMesh';
import {
  buildRaceSummary,
  computeFourPlayerCameraFrame,
  computeHighwaySteerControl,
  computeProgressiveHighwayPace,
  computeRivalControls,
  createInitialRacers,
  createOnlineHumanRacers,
  evaluateFourPlayerSessionStatus,
  findNearestHighwayLaneIndex,
  getPlayerSlotSignature,
  getSortedStandings,
  HIGHWAY_WORLD_LANE_X,
  PlayerInputState,
  resolveRacerCollisions,
  RIVAL_DIFFICULTY_CATALOG,
  stepLaneHopKinematics,
  stepSingleRacerPhysics,
  syncFourPlayerHighwayPack,
} from './physics';
import {
  FOUR_LANE_OFFSETS,
  HIGHWAY_TOTAL_WIDTH,
  TRACK_CATALOG,
} from './track';
import {
  buildTrafficVehicleMesh,
  checkRacerTrafficCollision,
  createInitialTraffic,
  stepTrafficVehicles,
  TrafficVehicle,
} from './traffic';
import { computeCarStats, DEFAULT_CAR_CONFIG } from './tuning';
import {
  CameraPreset,
  CarConfig,
  GameState,
  RaceCameraMode,
  RacerState,
  RaceSummary,
  RivalDifficulty,
  TrackId,
} from './types';
import {
  MatchStartPayload,
  SerializedRacerState,
} from '../shared/multiplayerProtocol';

export interface LiveHudSnapshot {
  speedKmh: number;
  rpm: number;
  redlineRpm: number;
  gear: number;
  turboBoostBar: number;
  nitrousRemaining: number;
  isDrifting: boolean;
  isBoosting: boolean;
  currentDriftScore: number;
  totalDriftScore: number;
  driftMultiplier: number;
  position: number;
  totalRacers: number;
  aliveRacers?: number;
  trafficNearMisses?: number;
  lap: number;
  totalLaps: number;
  elapsedSec: number;
  cameraMode: RaceCameraMode;
  racerPositions: Array<{
    id: string;
    x: number;
    z: number;
    heading: number;
    isPlayer: boolean;
    color: string;
    eliminated?: boolean;
  }>;
  trafficPositions?: Array<{
    id: string;
    x: number;
    z: number;
    type: 'sedan' | 'suv' | 'truck';
  }>;
}

interface WorldCanvasProps {
  gameState: GameState;
  carConfig: CarConfig;
  trackId: TrackId;
  rivalDifficulty: RivalDifficulty;
  garageCameraPreset: CameraPreset;
  raceCameraMode: RaceCameraMode;
  raceSessionId: number;
  lobbySlotOccupancy?: [boolean, boolean, boolean, boolean];
  lobbySlotColors?: [string, string, string, string];
  onlineMatch?: MatchStartPayload | null;
  onlineRacersSnapshotRef?: React.MutableRefObject<SerializedRacerState[] | null>;
  localOnlinePlayerId?: string | null;
  onSendOnlineLaneHop?: (targetLaneIndex: 0 | 1 | 2 | 3) => void;
  onHudUpdate: (snapshot: LiveHudSnapshot) => void;
  onRaceFinish: (summary: RaceSummary) => void;
  onTogglePause: () => void;
  onCycleRaceCamera: () => void;
  onStartFromKey: () => void;
}

const _camTargetPos = new THREE.Vector3();
const _camLookAtPos = new THREE.Vector3();
const _currentCamPos = new THREE.Vector3(0, 34, 40);
const _currentLookAt = new THREE.Vector3(0, 0.5, 80);
const _particleMatrix = new THREE.Matrix4();
const _particlePos = new THREE.Vector3();
const _particleScale = new THREE.Vector3();
const _particleQuat = new THREE.Quaternion();
const _particleColor = new THREE.Color();

interface PooledParticle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  maxAge: number;
  size: number;
  r: number;
  g: number;
  b: number;
}

const MAX_PARTICLES = 120;
const HIGHWAY_REPEAT_STEP_Z = 60;
const HIGHWAY_SPAN_Z = 960;

/**
 * Generates a clean, purpose-built 4-Lane Unified Straight Highway Texture:
 * - 4 equal forward lanes (Lane 1 | Lane 2 | Lane 3 | Lane 4)
 * - 3 crisp white dashed lane dividers (at u = 0.322, 0.500, 0.678 -> world x = -3.2m, 0.0m, +3.2m)
 * - Solid outer highway edge lines (at u = 0.144, 0.856 -> world x = ±6.4m)
 * - Subtle directional lane chevrons in the center of each of the 4 lanes
 */
function createUnified4LaneHighwayTexture(maxAnisotropy: number): {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;

  // Base dry slate highway asphalt
  ctx.fillStyle = '#1b2230';
  ctx.fillRect(0, 0, 1024, 1024);

  // Outer paved shoulders (outside x = ±6.4m -> u < 0.144 and u > 0.856)
  ctx.fillStyle = '#131822';
  ctx.fillRect(0, 0, 147, 1024);
  ctx.fillRect(877, 0, 147, 1024);

  // Subtle tire-wear track shading centered in each of the 4 unified lanes
  // Lane centers in world X: -4.8m, -1.6m, +1.6m, +4.8m -> u = 0.233, 0.411, 0.589, 0.767 -> canvas X = 239, 421, 603, 785
  const laneCenterPixels = [239, 421, 603, 785];
  for (const cx of laneCenterPixels) {
    const grad = ctx.createLinearGradient(cx - 70, 0, cx + 70, 0);
    grad.addColorStop(0, 'rgba(15, 20, 29, 0)');
    grad.addColorStop(0.3, 'rgba(12, 16, 24, 0.38)');
    grad.addColorStop(0.5, 'rgba(28, 36, 50, 0.22)');
    grad.addColorStop(0.7, 'rgba(12, 16, 24, 0.38)');
    grad.addColorStop(1, 'rgba(15, 20, 29, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - 70, 0, 140, 1024);
  }

  // Fine dry stone grain across the 4-lane highway surface
  for (let i = 0; i < 9000; i++) {
    const x = (i * 73) % 1024;
    const y = (i * 137) % 1024;
    const v = 26 + ((i * 29) % 24);
    ctx.fillStyle = `rgb(${v}, ${v + 5}, ${v + 12})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // Subtle horizontal concrete expansion joints across the 4 lanes
  ctx.fillStyle = 'rgba(10, 14, 20, 0.55)';
  for (const sy of [256, 512, 768]) {
    ctx.fillRect(147, sy, 730, 3);
  }

  // Solid outer highway boundary lines (left orange-amber edge, right white edge, plus shoulder rumble ticks)
  ctx.fillStyle = '#ff4d00';
  ctx.fillRect(142, 0, 10, 1024);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(872, 0, 10, 1024);

  // Shoulder rumble strip ticks outside the solid boundary lines
  for (let y = 0; y < 1024; y += 32) {
    ctx.fillStyle = (y / 32) % 2 === 0 ? '#f59e0b' : '#1e293b';
    ctx.fillRect(116, y + 4, 20, 18);
    ctx.fillRect(888, y + 4, 20, 18);
  }

  // 3 Unified White Dashed Lane Dividers separating Lane 1 | Lane 2 | Lane 3 | Lane 4
  // World X = -3.2m, 0.0m, +3.2m -> canvas X = 330, 512, 694
  const dividerPixels = [330, 512, 694];
  ctx.fillStyle = '#f1f5f9';
  for (const dx of dividerPixels) {
    for (let y = 24; y < 1024; y += 128) {
      ctx.fillRect(dx - 5, y, 10, 68);
    }
  }

  // Subtle forward-pointing directional chevrons in each of the 4 lanes (pointing toward +Z / top of screen)
  ctx.strokeStyle = 'rgba(241, 245, 249, 0.16)';
  ctx.lineWidth = 6;
  for (const cx of laneCenterPixels) {
    for (const cy of [256, 768]) {
      ctx.beginPath();
      ctx.moveTo(cx - 26, cy - 20);
      ctx.lineTo(cx, cy + 20);
      ctx.lineTo(cx + 26, cy - 20);
      ctx.stroke();
    }
  }

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, HIGHWAY_SPAN_Z / 20);
  map.anisotropy = maxAnisotropy;

  const rCanvas = document.createElement('canvas');
  rCanvas.width = 256;
  rCanvas.height = 256;
  const rCtx = rCanvas.getContext('2d')!;
  rCtx.fillStyle = '#c4c4c4';
  rCtx.fillRect(0, 0, 256, 256);
  const roughnessMap = new THREE.CanvasTexture(rCanvas);
  roughnessMap.wrapS = THREE.RepeatWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.repeat.set(1, HIGHWAY_SPAN_Z / 20);

  return { map, roughnessMap };
}

function createGuardrailBarrierTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, 512, 128);

  // Metallic guardrail beam groove
  ctx.fillStyle = '#334155';
  ctx.fillRect(0, 18, 512, 42);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 36, 512, 6);

  // High-contrast orange/dark hazard stripe along lower barrier
  const stripeW = 32;
  for (let x = 0; x < 512; x += stripeW) {
    ctx.fillStyle = (x / stripeW) % 2 === 0 ? '#ff4d00' : '#0f172a';
    ctx.fillRect(x, 76, stripeW, 32);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(HIGHWAY_SPAN_Z / 12, 1);
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/**
 * Generates a warm, sunlit green lawn texture (#56CC5C) with organic small grass blades (небольшие травинки)
 * and zero visible grid repetition.
 * Tile size in world space is 60m x 60m, matching HIGHWAY_REPEAT_STEP_Z (60m).
 */
function createPixelatedLawnTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // Warm sunlit meadow green base (#56CC5C)
  ctx.fillStyle = '#56CC5C';
  ctx.fillRect(0, 0, 512, 512);

  // Organic, non-grid small grass blade tufts (небольшие травинки) using integer hash
  for (let i = 0; i < 180; i++) {
    const h1 = ((i * 2654435761) >>> 0) % 496;
    const h2 = (((i + 47) * 2246822519) >>> 0) % 496;
    const gx = 8 + h1;
    const gy = 8 + h2;
    const variant = i % 3;

    // Subtle grass blade base shadow (#42B248)
    ctx.fillStyle = '#42B248';
    ctx.fillRect(gx, gy + 5, 1, 2);
    ctx.fillRect(gx + 2, gy + 4, 1, 3);
    ctx.fillRect(gx + 4, gy + 5, 1, 2);

    // Warm sunlit grass blade tips (#72E26E)
    ctx.fillStyle = '#72E26E';
    ctx.fillRect(gx, gy + 3, 1, 2);
    ctx.fillRect(gx + 2, gy + (variant === 0 ? 1 : 2), 1, variant === 0 ? 3 : 2);
    ctx.fillRect(gx + 4, gy + 3, 1, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.repeat.set(180 / 60, HIGHWAY_SPAN_Z / 60);
  return tex;
}

/**
 * Builds the continuous, perfectly straight 4-lane highway module (no turns, no legacy city blocks).
 * Recycles seamlessly along +Z in steps of HIGHWAY_REPEAT_STEP_Z (60m).
 */
function buildContinuousStraightHighway(
  trackId: TrackId,
  maxAnisotropy: number,
  isSoftwareGl: boolean,
): THREE.Group {
  const highwayGroup = new THREE.Group();
  const spec = TRACK_CATALOG[trackId];
  const accentHex = new THREE.Color(spec.accentColor).getHex();

  // 0. Warm Sunlit Green Lawn (#56CC5C) surrounding both sides of the highway
  const lawnTex = createPixelatedLawnTexture();
  const lawnGeo = new THREE.PlaneGeometry(180, HIGHWAY_SPAN_Z);
  lawnGeo.rotateX(-Math.PI / 2);
  const lawnMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: lawnTex,
    toneMapped: false,
    fog: false,
  });
  const lawnMesh = new THREE.Mesh(lawnGeo, lawnMat);
  lawnMesh.position.set(0, 0.0, HIGHWAY_SPAN_Z * 0.35);
  highwayGroup.add(lawnMesh);

  // 0b. Sunlit Green Terrace Ledge flanking the road (#56CC5C)
  const grassLedgeGeo = new THREE.BoxGeometry(2.6, 0.28, HIGHWAY_SPAN_Z);
  const grassLedgeMat = new THREE.MeshBasicMaterial({
    color: 0x56cc5c,
    toneMapped: false,
    fog: false,
  });
  for (const side of [-1, 1]) {
    const ledge = new THREE.Mesh(grassLedgeGeo, grassLedgeMat);
    ledge.position.set(
      side * (HIGHWAY_TOTAL_WIDTH * 0.5 + 0.55),
      0.1,
      HIGHWAY_SPAN_Z * 0.35,
    );
    highwayGroup.add(ledge);
  }

  // 1. Flat 4-Lane Unified Road Deck (18.0m wide x 960m long, centered at z = 360m)
  const { map: roadMap, roughnessMap: roadRough } =
    createUnified4LaneHighwayTexture(maxAnisotropy);
  const roadGeo = new THREE.PlaneGeometry(HIGHWAY_TOTAL_WIDTH, HIGHWAY_SPAN_Z);
  roadGeo.rotateX(-Math.PI / 2);
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: roadMap,
    roughnessMap: isSoftwareGl ? null : roadRough,
    roughness: 0.78,
    metalness: 0.12,
    envMapIntensity: 0.4,
  });
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.position.set(0, 0.03, HIGHWAY_SPAN_Z * 0.35);
  roadMesh.receiveShadow = !isSoftwareGl;
  highwayGroup.add(roadMesh);

  // 2. Continuous Straight Left & Right Highway Crash Barriers (at x = ±8.05m) + Compact Curb Verge
  const barrierTex = createGuardrailBarrierTexture(maxAnisotropy);
  const barrierGeo = new THREE.BoxGeometry(0.45, 0.95, HIGHWAY_SPAN_Z);
  const barrierMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: barrierTex,
    roughness: 0.55,
    metalness: 0.35,
  });
  const curbVergeMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.85,
    metalness: 0.15,
  });
  const apronGeo = new THREE.BoxGeometry(0.65, 0.16, HIGHWAY_SPAN_Z);

  for (const side of [-1, 1]) {
    const barrier = new THREE.Mesh(barrierGeo, barrierMat);
    barrier.position.set(
      side * (HIGHWAY_TOTAL_WIDTH * 0.5 - 0.95),
      0.48,
      HIGHWAY_SPAN_Z * 0.35,
    );
    highwayGroup.add(barrier);

    const apron = new THREE.Mesh(apronGeo, curbVergeMat);
    apron.position.set(
      side * (HIGHWAY_TOTAL_WIDTH * 0.5 - 0.35),
      0.04,
      HIGHWAY_SPAN_Z * 0.35,
    );
    highwayGroup.add(apron);
  }

  const startZ = -HIGHWAY_SPAN_Z * 0.15;

  // 3. Instanced Lane Reflector Studs along the 3 lane dividers and outer shoulders
  const zRows = Math.floor(HIGHWAY_SPAN_Z / 10);
  const studXPositions = [-7.6, -3.8, 0.0, 3.8, 7.6];
  const totalStuds = zRows * studXPositions.length;
  const studGeo = new THREE.BoxGeometry(0.16, 0.045, 0.24);
  const studMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const instStuds = new THREE.InstancedMesh(studGeo, studMat, totalStuds);
  instStuds.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  let sIdx = 0;

  for (let r = 0; r < zRows; r++) {
    const zPos = startZ + r * 10;
    for (let c = 0; c < studXPositions.length; c++) {
      const xPos = studXPositions[c];
      dummy.position.set(xPos, 0.055, zPos);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      instStuds.setMatrixAt(sIdx, dummy.matrix);
      col.setHex(c === 0 || c === 4 ? accentHex : 0xe2e8f0);
      instStuds.setColorAt(sIdx, col);
      sIdx++;
    }
  }
  instStuds.instanceMatrix.needsUpdate = true;
  if (instStuds.instanceColor) instStuds.instanceColor.needsUpdate = true;
  highwayGroup.add(instStuds);

  // 3b. Crossy Fluffle Low-Poly Trees & Circular Ground Shadow Discs along the Two-Tone Lawn
  // Exact 3 tree species from Crossy Fluffle (periodic every 60m for 100% seamless HIGHWAY_REPEAT_STEP_Z recycling):
  //   - Type 0: Tall Tapered Low-Poly Cypress / Poplar Spindle Tree (#536f17 / #65881e)
  //   - Type 1: 3-Tiered Low-Poly Conical Pine / Fir Tree (#466216 / #55771b / #648b20)
  //   - Type 2: Puffy Faceted Low-Poly Deciduous Tree (#62861f / #729a26)
  const treeCycles = Math.floor(HIGHWAY_SPAN_Z / HIGHWAY_REPEAT_STEP_Z);

  const treePatternOffsets: Array<{
    side: number;
    xDist: number;
    zOff: number;
    scale: number;
    kind: 0 | 1 | 2;
    rotY: number;
  }> = [
    // Sparse, open placement: only 2 trees per side every 60m cycle
    { side: -1, xDist: 19.5, zOff: 12, scale: 1.15, kind: 1, rotY: 0.4 },
    { side: -1, xDist: 24.8, zOff: 44, scale: 1.08, kind: 0, rotY: 1.7 },
    { side: 1, xDist: 20.2, zOff: 26, scale: 1.12, kind: 2, rotY: 0.9 },
    { side: 1, xDist: 25.5, zOff: 54, scale: 1.2, kind: 1, rotY: 2.1 },
  ];

  const totalTrees = treeCycles * treePatternOffsets.length;
  const cypressCount =
    treeCycles * treePatternOffsets.filter((p) => p.kind === 0).length;
  const pineCount =
    treeCycles * treePatternOffsets.filter((p) => p.kind === 1).length;
  const puffyCount =
    treeCycles * treePatternOffsets.filter((p) => p.kind === 2).length;

  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x352e18,
    roughness: 0.92,
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.08,
  });
  const shadowDiscMat = new THREE.MeshBasicMaterial({
    color: 0x41b047,
    toneMapped: false,
    fog: false,
  });
  // Sunlit tree foliage calibrated to match the #56CC5C sunlit lawn
  const cypressLowerMat = new THREE.MeshStandardMaterial({
    color: 0x278a2e,
    roughness: 0.88,
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.06,
  });
  const cypressUpperMat = new THREE.MeshStandardMaterial({
    color: 0x31a339,
    roughness: 0.86,
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.06,
  });
  const pineTier1Mat = new THREE.MeshStandardMaterial({
    color: 0x24822b,
    roughness: 0.88,
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.06,
  });
  const pineTier2Mat = new THREE.MeshStandardMaterial({
    color: 0x2d9935,
    roughness: 0.86,
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.06,
  });
  const pineTier3Mat = new THREE.MeshStandardMaterial({
    color: 0x37b040,
    roughness: 0.84,
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.06,
  });
  const puffyMainMat = new THREE.MeshStandardMaterial({
    color: 0x2d9935,
    roughness: 0.86,
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.06,
  });
  const puffyCapMat = new THREE.MeshStandardMaterial({
    color: 0x38b241,
    roughness: 0.84,
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.06,
  });

  // Shared trunks & soft circular lawn shadow discs
  const shadowDiscGeo = new THREE.CylinderGeometry(1.65, 1.65, 0.02, 12);
  const instShadowDiscs = new THREE.InstancedMesh(
    shadowDiscGeo,
    shadowDiscMat,
    totalTrees,
  );
  const instTrunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.24, 0.36, 1.5, 7),
    trunkMat,
    totalTrees,
  );

  // Type 0: Tall Tapered Cypress Spindle (lower fullness + tall tapered upper cone)
  const instCypressLower = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.95, 1.35, 2.2, 7),
    cypressLowerMat,
    cypressCount,
  );
  const instCypressUpper = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.12, 3.4, 7),
    cypressUpperMat,
    cypressCount,
  );

  // Type 1: 3-Tiered Low-Poly Conical Pine / Fir Tree
  const instPineBottom = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.75, 2.1, 7),
    pineTier1Mat,
    pineCount,
  );
  const instPineMid = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.42, 1.9, 7),
    pineTier2Mat,
    pineCount,
  );
  const instPineTop = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.05, 1.75, 7),
    pineTier3Mat,
    pineCount,
  );

  // Type 2: Puffy Faceted Low-Poly Deciduous Crown
  const instPuffyMain = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1.55, 1),
    puffyMainMat,
    puffyCount,
  );
  const instPuffyCap = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1.15, 1),
    puffyCapMat,
    puffyCount,
  );

  const allTreeInstanced = [
    instShadowDiscs,
    instTrunks,
    instCypressLower,
    instCypressUpper,
    instPineBottom,
    instPineMid,
    instPineTop,
    instPuffyMain,
    instPuffyCap,
  ];
  for (const mesh of allTreeInstanced) {
    mesh.frustumCulled = false;
  }

  let tIdx = 0;
  let cypIdx = 0;
  let pineIdx = 0;
  let pufIdx = 0;

  for (let c = 0; c < treeCycles; c++) {
    const baseZ = startZ + c * HIGHWAY_REPEAT_STEP_Z;
    for (const pat of treePatternOffsets) {
      const tx = pat.side * pat.xDist;
      const tz = baseZ + pat.zOff;
      const s = pat.scale;

      // Ground shadow disc on the lawn
      dummy.position.set(tx + 0.25 * s, 0.015, tz - 0.18 * s);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(s, 1, s * 0.92);
      dummy.updateMatrix();
      instShadowDiscs.setMatrixAt(tIdx, dummy.matrix);

      // Tree trunk
      dummy.position.set(tx, 0.75 * s, tz);
      dummy.rotation.set(0, pat.rotY, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      instTrunks.setMatrixAt(tIdx, dummy.matrix);
      tIdx++;

      if (pat.kind === 0) {
        dummy.position.set(tx, 2.15 * s, tz);
        dummy.rotation.set(0, pat.rotY, 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        instCypressLower.setMatrixAt(cypIdx, dummy.matrix);

        dummy.position.set(tx, 4.45 * s, tz);
        dummy.rotation.set(0, pat.rotY + 0.25, 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        instCypressUpper.setMatrixAt(cypIdx, dummy.matrix);
        cypIdx++;
      } else if (pat.kind === 1) {
        dummy.position.set(tx, 2.05 * s, tz);
        dummy.rotation.set(0, pat.rotY, 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        instPineBottom.setMatrixAt(pineIdx, dummy.matrix);

        dummy.position.set(tx, 3.25 * s, tz);
        dummy.rotation.set(0, pat.rotY + 0.45, 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        instPineMid.setMatrixAt(pineIdx, dummy.matrix);

        dummy.position.set(tx, 4.4 * s, tz);
        dummy.rotation.set(0, pat.rotY + 0.9, 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        instPineTop.setMatrixAt(pineIdx, dummy.matrix);
        pineIdx++;
      } else {
        dummy.position.set(tx, 2.45 * s, tz);
        dummy.rotation.set(0.15, pat.rotY, 0.1);
        dummy.scale.set(s * 1.18, s * 0.88, s * 1.14);
        dummy.updateMatrix();
        instPuffyMain.setMatrixAt(pufIdx, dummy.matrix);

        dummy.position.set(tx - 0.18 * s, 3.35 * s, tz + 0.12 * s);
        dummy.rotation.set(-0.1, pat.rotY + 0.6, 0.12);
        dummy.scale.set(s * 1.05, s * 0.82, s * 1.02);
        dummy.updateMatrix();
        instPuffyCap.setMatrixAt(pufIdx, dummy.matrix);
        pufIdx++;
      }
    }
  }

  for (const mesh of allTreeInstanced) {
    mesh.instanceMatrix.needsUpdate = true;
    highwayGroup.add(mesh);
  }

  // 3c. 3D Small Grass Blades / Tufts (небольшие травинки) scattered along the #2AAF47 lawn
  // Each tuft consists of 3 angled miniature grass blades in matching #2AAF47 highlights/shadows
  const tuftsPerCycle = 24; // 12 tufts per side every 60m
  const totalBlades = treeCycles * tuftsPerCycle * 3;
  const bladeGeo = new THREE.ConeGeometry(0.09, 0.48, 3);
  bladeGeo.translate(0, 0.24, 0);
  const bladeMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
    fog: false,
  });
  const instGrassBlades = new THREE.InstancedMesh(
    bladeGeo,
    bladeMat,
    totalBlades,
  );
  instGrassBlades.frustumCulled = false;

  const bladeColors = [0x42b248, 0x72e26e, 0x4bbe51];
  let gIdx = 0;
  for (let c = 0; c < treeCycles; c++) {
    const baseZ = startZ + c * HIGHWAY_REPEAT_STEP_Z;
    for (let t = 0; t < tuftsPerCycle; t++) {
      const side = t % 2 === 0 ? -1 : 1;
      const row = Math.floor(t / 2);
      const xDist = 12.8 + ((row * 37 + 11) % 180) * 0.1; // 12.8m to 30.8m from center
      const zOff = (row * 5 + ((row * 17) % 4)) % HIGHWAY_REPEAT_STEP_Z;
      const gx = side * xDist;
      const gz = baseZ + zOff;
      const tuftScale = 0.85 + (t % 4) * 0.14;

      for (let b = 0; b < 3; b++) {
        const angle = (b * Math.PI * 2) / 3 + (t % 5) * 0.3;
        const tilt = b === 1 ? 0.12 : 0.28;
        const bOffX = Math.cos(angle) * 0.08;
        const bOffZ = Math.sin(angle) * 0.08;
        dummy.position.set(gx + bOffX, 0.0, gz + bOffZ);
        dummy.rotation.set(
          Math.sin(angle) * tilt,
          angle,
          -Math.cos(angle) * tilt,
        );
        dummy.scale.set(
          tuftScale,
          tuftScale * (b === 1 ? 1.18 : 0.92),
          tuftScale,
        );
        dummy.updateMatrix();
        instGrassBlades.setMatrixAt(gIdx, dummy.matrix);
        col.setHex(bladeColors[b]);
        instGrassBlades.setColorAt(gIdx, col);
        gIdx++;
      }
    }
  }
  instGrassBlades.instanceMatrix.needsUpdate = true;
  if (instGrassBlades.instanceColor) {
    instGrassBlades.instanceColor.needsUpdate = true;
  }
  highwayGroup.add(instGrassBlades);

  // 4. Symmetrical Straight Highway Light Masts every 30m + Overhead 4-Lane Portals every 60m
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    metalness: 0.78,
    roughness: 0.28,
  });
  const lampBulbMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
  const laneSignMat = new THREE.MeshBasicMaterial({ color: accentHex });
  const slotPaletteMats = [
    new THREE.MeshBasicMaterial({ color: 0xfbbf24 }), // Lane 1 Gold
    new THREE.MeshBasicMaterial({ color: 0x06b6d4 }), // Lane 2 Cyan
    new THREE.MeshBasicMaterial({ color: 0xf43f5e }), // Lane 3 Crimson
    new THREE.MeshBasicMaterial({ color: 0x10b981 }), // Lane 4 Emerald
  ];

  for (
    let zPos = -120;
    zPos <= HIGHWAY_SPAN_Z - 120;
    zPos += HIGHWAY_REPEAT_STEP_Z
  ) {
    // Overhead 4-Lane Gantry Portal spanning all 4 unified lanes
    const portal = new THREE.Group();
    portal.position.set(0, 0, zPos);

    const spanWidth = HIGHWAY_TOTAL_WIDTH - 1.2;
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 7.2, 0.42),
        steelMat,
      );
      pillar.position.set(side * (spanWidth * 0.5), 3.6, 0);
      portal.add(pillar);
    }

    const crossBeam = new THREE.Mesh(
      new THREE.BoxGeometry(spanWidth + 0.8, 0.55, 0.55),
      steelMat,
    );
    crossBeam.position.set(0, 7.1, 0);
    portal.add(crossBeam);

    // 4 Overhead Lane Indicator Boards aligned directly above each of the 4 lanes
    for (let li = 0; li < FOUR_LANE_OFFSETS.length; li++) {
      const laneX = -FOUR_LANE_OFFSETS[li];
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 0.65, 0.16),
        steelMat,
      );
      board.position.set(laneX, 6.75, 0.25);
      portal.add(board);

      const ledStrip = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.16, 0.2),
        slotPaletteMats[li % slotPaletteMats.length],
      );
      ledStrip.position.set(laneX, 6.75, 0.26);
      portal.add(ledStrip);
    }

    // Accent strip along top of gantry
    const topAccent = new THREE.Mesh(
      new THREE.BoxGeometry(spanWidth * 0.92, 0.1, 0.6),
      laneSignMat,
    );
    topAccent.position.set(0, 7.4, 0);
    portal.add(topAccent);

    highwayGroup.add(portal);

    // Intermediate Dual Highway Streetlights at zPos + 30m
    const midZ = zPos + 30;
    for (const side of [-1, 1]) {
      const poleX = side * (HIGHWAY_TOTAL_WIDTH * 0.5 - 0.55);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.14, 6.4, 8),
        steelMat,
      );
      pole.position.set(poleX, 3.2, midZ);
      highwayGroup.add(pole);

      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(2.1, 0.1, 0.14),
        steelMat,
      );
      arm.position.set(poleX - side * 0.95, 6.3, midZ);
      highwayGroup.add(arm);

      const bulb = new THREE.Mesh(
        new THREE.BoxGeometry(0.85, 0.12, 0.36),
        lampBulbMat,
      );
      bulb.position.set(poleX - side * 1.75, 6.22, midZ);
      highwayGroup.add(bulb);
    }
  }

  return highwayGroup;
}

/**
 * Clean minimal showcase platform for the vehicle configuration screen.
 */
function buildShowcasePlatform(): {
  stageGroup: THREE.Group;
  dynoRollers: THREE.Mesh[];
} {
  const stageGroup = new THREE.Group();
  const dynoRollers: THREE.Mesh[] = [];

  const padGeo = new THREE.CylinderGeometry(3.4, 3.6, 0.05, 40);
  const padMat = new THREE.MeshStandardMaterial({
    color: 0x111622,
    metalness: 0.6,
    roughness: 0.3,
  });
  const padMesh = new THREE.Mesh(padGeo, padMat);
  padMesh.position.y = 0.01;
  stageGroup.add(padMesh);

  const ringGeo = new THREE.TorusGeometry(3.45, 0.035, 8, 48);
  ringGeo.rotateX(Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff4d00 });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.position.y = 0.04;
  stageGroup.add(ringMesh);

  const rollerMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    metalness: 0.85,
    roughness: 0.2,
  });
  for (const wz of [1.34, -1.32]) {
    for (const roff of [-0.19, 0.19]) {
      const rollerGeo = new THREE.CylinderGeometry(0.11, 0.11, 2.3, 14);
      rollerGeo.rotateZ(Math.PI / 2);
      const roller = new THREE.Mesh(rollerGeo, rollerMat);
      roller.position.set(0, -0.02, wz + roff);
      stageGroup.add(roller);
      dynoRollers.push(roller);
    }
  }

  return { stageGroup, dynoRollers };
}

export const WorldCanvas: React.FC<WorldCanvasProps> = ({
  gameState,
  carConfig,
  trackId,
  rivalDifficulty,
  garageCameraPreset,
  raceCameraMode,
  raceSessionId,
  lobbySlotOccupancy = [false, true, false, false],
  lobbySlotColors = ['#2563eb', '#fbb124', '#06b6d4', '#f43f5e'],
  onlineMatch = null,
  onlineRacersSnapshotRef,
  localOnlinePlayerId = null,
  onSendOnlineLaneHop,
  onHudUpdate,
  onRaceFinish,
  onTogglePause,
  onCycleRaceCamera,
  onStartFromKey,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const gameStateRef = useRef<GameState>(gameState);
  gameStateRef.current = gameState;
  const onlineMatchRef = useRef<MatchStartPayload | null>(onlineMatch);
  onlineMatchRef.current = onlineMatch;
  const localOnlinePlayerIdRef = useRef<string | null>(localOnlinePlayerId);
  localOnlinePlayerIdRef.current = localOnlinePlayerId;
  const onSendOnlineLaneHopRef = useRef(onSendOnlineLaneHop);
  onSendOnlineLaneHopRef.current = onSendOnlineLaneHop;
  const onlineRacersSnapshotPropRef = useRef(onlineRacersSnapshotRef);
  onlineRacersSnapshotPropRef.current = onlineRacersSnapshotRef;
  const lobbySlotOccupancyRef =
    useRef<[boolean, boolean, boolean, boolean]>(lobbySlotOccupancy);
  const lobbySlotColorsRef =
    useRef<[string, string, string, string]>(lobbySlotColors);
  const carConfigRef = useRef<CarConfig>(carConfig);
  const trackIdRef = useRef<TrackId>(trackId);
  const rivalDifficultyRef = useRef<RivalDifficulty>(rivalDifficulty);
  const garagePresetRef = useRef<CameraPreset>(garageCameraPreset);
  const raceCameraModeRef = useRef<RaceCameraMode>(raceCameraMode);
  const onHudUpdateRef = useRef(onHudUpdate);
  const onRaceFinishRef = useRef(onRaceFinish);
  const onTogglePauseRef = useRef(onTogglePause);
  const onCycleRaceCameraRef = useRef(onCycleRaceCamera);
  const onStartFromKeyRef = useRef(onStartFromKey);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);
  useEffect(() => {
    carConfigRef.current = carConfig;
  }, [carConfig]);
  useEffect(() => {
    trackIdRef.current = trackId;
  }, [trackId]);
  useEffect(() => {
    rivalDifficultyRef.current = rivalDifficulty;
  }, [rivalDifficulty]);
  useEffect(() => {
    garagePresetRef.current = garageCameraPreset;
  }, [garageCameraPreset]);
  useEffect(() => {
    raceCameraModeRef.current = raceCameraMode;
  }, [raceCameraMode]);
  useEffect(() => {
    onHudUpdateRef.current = onHudUpdate;
  }, [onHudUpdate]);
  useEffect(() => {
    onRaceFinishRef.current = onRaceFinish;
  }, [onRaceFinish]);
  useEffect(() => {
    onTogglePauseRef.current = onTogglePause;
  }, [onTogglePause]);
  useEffect(() => {
    onCycleRaceCameraRef.current = onCycleRaceCamera;
  }, [onCycleRaceCamera]);
  useEffect(() => {
    onStartFromKeyRef.current = onStartFromKey;
  }, [onStartFromKey]);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const isSoftwareGlRef = useRef<boolean>(false);
  const maxAnisotropyRef = useRef<number>(1);
  const playerCarRigRef = useRef<CarRigHandles | null>(null);
  const rivalCarRigsRef = useRef<CarRigHandles[]>([]);
  const trackGroupRef = useRef<THREE.Group | null>(null);
  const garageStageRef = useRef<{
    stageGroup: THREE.Group;
    dynoRollers: THREE.Mesh[];
  } | null>(null);
  const racersRef = useRef<RacerState[]>([]);
  const trafficRef = useRef<TrafficVehicle[]>([]);
  const trafficMeshesRef = useRef<THREE.Group[]>([]);
  const elapsedRaceSecRef = useRef<number>(0);
  const topSpeedSessionRef = useRef<number>(0);
  const hitstopTimerRef = useRef<number>(0);
  const cameraTraumaRef = useRef<number>(0);
  const purgeTimerRef = useRef<number>(0);
  const userOrbitYawRef = useRef<number>(0);
  const userOrbitPitchRef = useRef<number>(0);
  const isDraggingOrbitRef = useRef<boolean>(false);
  const lastDragClientRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pointerParallaxRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const keysHeldRef = useRef<Set<string>>(new Set());
  const playerTargetLaneIdxRef = useRef<number>(1);
  const steerHoldTimeRef = useRef<number>(0);
  const paceClockSecRef = useRef<number>(0);
  const postBrakeRampRef = useRef<number>(1);
  const sessionFinishedRef = useRef<boolean>(false);

  const rebuildPlayerCarMesh = () => {
    const scene = sceneRef.current;
    if (!scene) return;

    const prevPos = new THREE.Vector3();
    let prevRotY = 0;
    if (playerCarRigRef.current) {
      prevPos.copy(playerCarRigRef.current.root.position);
      prevRotY = playerCarRigRef.current.root.rotation.y;
      scene.remove(playerCarRigRef.current.root);
    }

    const slot0Cfg: CarConfig = {
      ...carConfigRef.current,
      underglowColor: getPlayerSlotSignature(0).hex,
    };
    const newRig = buildProceduralCar(
      slot0Cfg,
      isSoftwareGlRef.current,
      true,
    );
    newRig.root.position.copy(prevPos);
    newRig.root.rotation.y = prevRotY;
    scene.add(newRig.root);
    playerCarRigRef.current = newRig;
  };

  const rebuildRivalCarMeshes = () => {
    const scene = sceneRef.current;
    if (!scene) return;
    const racers = racersRef.current;

    const prevTransforms = rivalCarRigsRef.current.map((rig) => ({
      pos: rig.root.position.clone(),
      rotY: rig.root.rotation.y,
      visible: rig.root.visible,
    }));

    rivalCarRigsRef.current.forEach((rig) => scene.remove(rig.root));
    rivalCarRigsRef.current = [];
    if (racers.length <= 1) return;

    const isLobby = gameStateRef.current === 'title';
    const isOnlineActive =
      Boolean(onlineMatchRef.current) && gameStateRef.current === 'playing';
    const occ = lobbySlotOccupancyRef.current;
    const rivalLaneMap: Record<number, 0 | 2 | 3> = { 1: 2, 2: 0, 3: 3 };

    for (let i = 1; i < racers.length; i++) {
      const r = racers[i];
      const laneIdx = rivalLaneMap[i] ?? 2;
      const laneColor = isOnlineActive
        ? r.paintColor
        : lobbySlotColorsRef.current[laneIdx] || r.paintColor;
      r.paintColor = laneColor;
      r.underglowColor = laneColor;

      const rivalCfg: CarConfig = {
        ...DEFAULT_CAR_CONFIG,
        chassis: DEFAULT_CAR_CONFIG.chassis,
        paintColor: laneColor,
        underglowColor: laneColor,
      };
      const rig = buildProceduralCar(rivalCfg, isSoftwareGlRef.current, false);
      const prev = prevTransforms[i - 1];
      if (prev && !isOnlineActive) {
        rig.root.position.copy(prev.pos);
        rig.root.rotation.y = prev.rotY;
        rig.root.visible = isLobby ? occ[laneIdx] : prev.visible;
      } else {
        rig.root.position.set(r.x, 0, r.z);
        rig.root.rotation.y = r.heading;
        rig.root.visible = isLobby ? occ[laneIdx] : true;
      }
      scene.add(rig.root);
      rivalCarRigsRef.current.push(rig);
    }
  };

  const resetRaceGrid = () => {
    const scene = sceneRef.current;
    if (!scene) return;

    const activeOnline =
      onlineMatchRef.current && gameStateRef.current === 'playing'
        ? onlineMatchRef.current
        : null;

    let racers: RacerState[];
    if (activeOnline && activeOnline.activeRacers.length >= 2) {
      const localId = localOnlinePlayerIdRef.current;
      const sortedOnline = [...activeOnline.activeRacers].sort((a, b) => {
        if (a.playerId === localId) return -1;
        if (b.playerId === localId) return 1;
        return a.laneIndex - b.laneIndex;
      });
      racers = createOnlineHumanRacers(
        trackIdRef.current,
        sortedOnline.map((sr, idx) => ({
          playerId: sr.playerId,
          displayName: sr.displayName,
          laneIndex: sr.laneIndex,
          paintColor: sr.paintColor,
          isLocalPlayer: idx === 0,
          chassis: DEFAULT_CAR_CONFIG.chassis,
        })),
      );
      if (racers[0]) {
        carConfigRef.current = {
          ...carConfigRef.current,
          paintColor: racers[0].paintColor,
        };
        rebuildPlayerCarMesh();
      }
    } else {
      racers = createInitialRacers(
        trackIdRef.current,
        carConfigRef.current,
        lobbySlotColorsRef.current,
      );
    }

    // Start all racers with a brisk rolling highway speed (95 km/h) along the straight 4-lane highway (+Z)
    for (const r of racers) {
      const sH = Math.sin(r.heading);
      const cH = Math.cos(r.heading);
      r.vx = sH * 26.5;
      r.vz = cH * 26.5;
      r.speedMs = 26.5;
      r.speedKmh = 95;
      r.gear = 3;
      r.rpm = 4200;
      r.eliminated = false;
      r.eliminatedAtSec = undefined;
      r.trafficNearMisses = 0;
      r.ghostOverlap = 0;
      r.hopStartX = r.x;
      r.hopTargetX = r.x;
      r.hopProgress = 1;
      r.hopDirection = 0;
      r.hopHeightY = 0;
      r.hopPitchRad = 0;
      r.hopRollRad = 0;
      r.hopYawRad = 0;
      r.hopLandingCompressionY = 0;
      r.hopLandingTimer = 0;
      r.hopJustTookOff = false;
      r.hopJustLanded = false;
    }
    racersRef.current = racers;
    if (racers[0]) {
      playerTargetLaneIdxRef.current = findNearestHighwayLaneIndex(racers[0].x);
    }
    steerHoldTimeRef.current = 0;
    elapsedRaceSecRef.current = 0;
    paceClockSecRef.current = 0;
    postBrakeRampRef.current = 1;
    sessionFinishedRef.current = false;
    topSpeedSessionRef.current = 95;
    hitstopTimerRef.current = 0;
    cameraTraumaRef.current = 0;

    if (trackGroupRef.current) {
      trackGroupRef.current.position.z = 0;
    }

    rebuildRivalCarMeshes();

    const isLobby = gameStateRef.current === 'title';
    const occ = lobbySlotOccupancyRef.current;
    // Racer slot to visual lane mapping (0: x=5.7 [racer 2], 1: x=1.9 [racer 0], 2: x=-1.9 [racer 1], 3: x=-5.7 [racer 3])
    const rivalLaneMap: Record<number, 0 | 2 | 3> = { 1: 2, 2: 0, 3: 3 };
    for (let i = 1; i < racers.length; i++) {
      const r = racers[i];
      const rig = rivalCarRigsRef.current[i - 1];
      if (rig) {
        rig.root.position.set(r.x, 0, r.z);
        rig.root.rotation.y = r.heading;
        const laneIdx = rivalLaneMap[i] ?? 2;
        rig.root.visible = isLobby ? occ[laneIdx] : true;
      }
    }

    // Spawn 28 civilian passenger sedans, SUVs, and heavy cargo trucks on the straight 4-lane highway
    // Uses Orion room seed when online so all 2..4 players see identical deterministic traffic waves
    trafficMeshesRef.current.forEach((m) => scene.remove(m));
    trafficMeshesRef.current = [];
    const trafficList = createInitialTraffic(
      trackIdRef.current,
      28,
      activeOnline?.trafficSeed,
    );
    trafficRef.current = trafficList;
    for (const tv of trafficList) {
      const tMesh = buildTrafficVehicleMesh(tv);
      tMesh.position.set(tv.x, isLobby ? -35 : 0, tv.z);
      tMesh.rotation.y = tv.heading;
      tMesh.visible = !isLobby;
      scene.add(tMesh);
      trafficMeshesRef.current.push(tMesh);
    }

    if (playerCarRigRef.current && racers[0]) {
      const p0 = racers[0];
      playerCarRigRef.current.root.position.set(p0.x, 0, p0.z);
      playerCarRigRef.current.root.rotation.y = p0.heading;
      playerCarRigRef.current.root.visible = isLobby ? occ[1] : true;
      if (garageStageRef.current) {
        garageStageRef.current.stageGroup.position.set(p0.x, -25, p0.z);
        garageStageRef.current.stageGroup.visible = false;
      }
      const sinH = Math.sin(p0.heading);
      const cosH = Math.cos(p0.heading);
      if (isLobby) {
        // 4-Player Highway Starting Grid Podium Camera framing all 4 lanes in the center window
        _currentCamPos.set(0, 10.2, p0.z - 12.8);
        _currentLookAt.set(0, 0.2, p0.z - 0.5);
      } else if (raceCameraModeRef.current === 'top_down') {
        // Center top-down camera over the 4-lane straight highway (x = 0)
        _currentCamPos.set(0, 34.0, p0.z - 4.5);
        _currentLookAt.set(0, 0.4, p0.z + 14.5);
      } else {
        _currentCamPos.set(
          p0.x - sinH * 6.1,
          2.15,
          p0.z - cosH * 6.1,
        );
        _currentLookAt.set(
          p0.x + sinH * 6.5,
          0.95,
          p0.z + cosH * 6.5,
        );
      }
    }
  };

  useEffect(() => {
    rebuildPlayerCarMesh();
  }, [carConfig]);

  useEffect(() => {
    lobbySlotColorsRef.current = lobbySlotColors;
    rebuildRivalCarMeshes();
  }, [
    lobbySlotColors[0],
    lobbySlotColors[1],
    lobbySlotColors[2],
    lobbySlotColors[3],
  ]);

  useEffect(() => {
    lobbySlotOccupancyRef.current = lobbySlotOccupancy;
    if (gameStateRef.current === 'title') {
      if (playerCarRigRef.current) {
        playerCarRigRef.current.root.visible = lobbySlotOccupancy[1];
      }
      const rivalLaneMap: Record<number, 0 | 2 | 3> = { 1: 2, 2: 0, 3: 3 };
      rivalCarRigsRef.current.forEach((rig, idx) => {
        const laneIdx = rivalLaneMap[idx + 1] ?? 2;
        rig.root.visible = lobbySlotOccupancy[laneIdx];
      });
    }
  }, [lobbySlotOccupancy]);

  const activeTrackMeshIdRef = useRef<TrackId | null>(null);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (activeTrackMeshIdRef.current !== trackId) {
      if (trackGroupRef.current) {
        scene.remove(trackGroupRef.current);
      }
      scene.background = new THREE.Color(0x56cc5c);
      scene.fog = new THREE.FogExp2(0x56cc5c, 0.0022);

      const highwayGroup = buildContinuousStraightHighway(
        trackId,
        maxAnisotropyRef.current,
        isSoftwareGlRef.current,
      );
      scene.add(highwayGroup);
      trackGroupRef.current = highwayGroup;
      activeTrackMeshIdRef.current = trackId;
    }

    resetRaceGrid();
  }, [trackId, raceSessionId]);

  useEffect(() => {
    keysHeldRef.current.clear();
    const isLobby = gameState === 'title';
    if (garageStageRef.current) {
      garageStageRef.current.stageGroup.visible = false;
    }
    const racers = racersRef.current;
    const occ = lobbySlotOccupancyRef.current;
    const rivalLaneMap: Record<number, 0 | 2 | 3> = { 1: 2, 2: 0, 3: 3 };
    rivalCarRigsRef.current.forEach((rig, idx) => {
      const r = racers[idx + 1];
      if (r) {
        rig.root.position.set(r.x, 0, r.z);
        const laneIdx = rivalLaneMap[idx + 1] ?? 2;
        rig.root.visible = isLobby ? occ[laneIdx] : true;
      }
    });
    const trafficList = trafficRef.current;
    trafficMeshesRef.current.forEach((tMesh, idx) => {
      const tv = trafficList[idx];
      if (tv) {
        tMesh.position.set(tv.x, isLobby ? -35 : 0, tv.z);
        tMesh.visible = !isLobby;
      }
    });
    if (playerCarRigRef.current && racers[0]) {
      const p0 = racers[0];
      playerCarRigRef.current.root.position.y = 0;
      if (isLobby) {
        _currentCamPos.set(0, 10.2, p0.z - 12.8);
        _currentLookAt.set(0, 0.2, p0.z - 0.5);
      } else if (gameState === 'playing') {
        const sinH = Math.sin(p0.heading);
        const cosH = Math.cos(p0.heading);
        if (raceCameraModeRef.current === 'top_down') {
          _currentCamPos.set(0, 34.0, p0.z - 4.5);
          _currentLookAt.set(0, 0.4, p0.z + 14.5);
        } else {
          _currentCamPos.set(
            p0.x - sinH * 6.1,
            2.15,
            p0.z - cosH * 6.1,
          );
          _currentLookAt.set(
            p0.x + sinH * 6.5,
            0.95,
            p0.z + cosH * 6.5,
          );
        }
      }
    }
    if (gameState === 'playing') {
      soundEngine.startDrivingLoop();
    } else {
      soundEngine.stopDrivingLoop();
    }
  }, [gameState]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = (() => {
      const probeCanvas = document.createElement('canvas');
      const gl = probeCanvas.getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();
    isSoftwareGlRef.current = isSoftwareGl;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.24;
    renderer.setPixelRatio(
      isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const initW = container.clientWidth || window.innerWidth;
    const initH = container.clientHeight || window.innerHeight;
    renderer.setSize(initW, initH);
    renderer.domElement.setAttribute('data-testid', 'street-racing-canvas');
    container.appendChild(renderer.domElement);

    maxAnisotropyRef.current = renderer.capabilities.getMaxAnisotropy();

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    scene.background = new THREE.Color(0x56cc5c);
    scene.fog = new THREE.FogExp2(0x56cc5c, 0.0022);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(
      new RoomEnvironment(),
      0.04,
    ).texture;
    pmremGenerator.dispose();

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x56cc5c, 1.05);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfffbeb, 1.32);
    dirLight.position.set(35, 85, 45);
    if (!isSoftwareGl) {
      dirLight.castShadow = true;
      dirLight.shadow.mapSize.width = 1024;
      dirLight.shadow.mapSize.height = 1024;
      const d = 65;
      dirLight.shadow.camera.left = -d;
      dirLight.shadow.camera.right = d;
      dirLight.shadow.camera.top = d;
      dirLight.shadow.camera.bottom = -d;
      dirLight.shadow.bias = -0.0005;
      dirLight.shadow.normalBias = 0.02;
    }
    scene.add(dirLight);

    const rimLight = new THREE.DirectionalLight(0x7dd3fc, 0.65);
    rimLight.position.set(-40, 35, -50);
    scene.add(rimLight);

    // Overhead highway light pool following the player along +Z
    const highwayPointLight = new THREE.PointLight(0xffca68, 5.5, 42, 1.3);
    highwayPointLight.position.set(0, 7.5, 64);
    scene.add(highwayPointLight);

    // Far horizon lawn under-plane
    const groundGeo = new THREE.PlaneGeometry(1200, 1200);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshBasicMaterial({
      color: 0x56cc5c,
      toneMapped: false,
      fog: false,
    });
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.position.y = -0.05;
    scene.add(groundMesh);

    const camera = new THREE.PerspectiveCamera(58, initW / initH, 0.2, 600);

    const highwayGroup = buildContinuousStraightHighway(
      trackIdRef.current,
      maxAnisotropyRef.current,
      isSoftwareGl,
    );
    scene.add(highwayGroup);
    trackGroupRef.current = highwayGroup;
    activeTrackMeshIdRef.current = trackIdRef.current;

    const garageStage = buildShowcasePlatform();
    scene.add(garageStage.stageGroup);
    garageStageRef.current = garageStage;

    rebuildPlayerCarMesh();
    resetRaceGrid();

    // Pooled Tire Skidmark Ring Buffer
    const MAX_SKIDMARKS = 320;
    const skidGeo = new THREE.PlaneGeometry(0.32, 0.95);
    skidGeo.rotateX(-Math.PI / 2);
    const skidMat = new THREE.MeshBasicMaterial({
      color: 0x05070b,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    });
    const skidMesh = new THREE.InstancedMesh(skidGeo, skidMat, MAX_SKIDMARKS);
    skidMesh.frustumCulled = false;
    const skidDummy = new THREE.Object3D();
    skidDummy.position.set(0, -100, 0);
    skidDummy.updateMatrix();
    for (let i = 0; i < MAX_SKIDMARKS; i++) {
      skidMesh.setMatrixAt(i, skidDummy.matrix);
    }
    skidMesh.instanceMatrix.needsUpdate = true;
    scene.add(skidMesh);
    let skidCursor = 0;

    function spawnTireSkidmark(x: number, z: number, headingRad: number) {
      skidDummy.position.set(x, 0.036, z);
      skidDummy.rotation.set(0, headingRad, 0);
      skidDummy.scale.set(1, 1, 1);
      skidDummy.updateMatrix();
      skidMesh.setMatrixAt(skidCursor, skidDummy.matrix);
      skidCursor = (skidCursor + 1) % MAX_SKIDMARKS;
      skidMesh.instanceMatrix.needsUpdate = true;
    }

    // Pooled Particle Ring Buffer
    const particleGeo = new THREE.SphereGeometry(0.28, 8, 8);
    const particleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const particleMesh = new THREE.InstancedMesh(
      particleGeo,
      particleMat,
      MAX_PARTICLES,
    );
    particleMesh.frustumCulled = false;
    scene.add(particleMesh);

    const particles: PooledParticle[] = Array.from(
      { length: MAX_PARTICLES },
      () => ({
        active: false,
        x: 0,
        y: -100,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        age: 0,
        maxAge: 0.5,
        size: 0.1,
        r: 1,
        g: 1,
        b: 1,
      }),
    );
    let particleCursor = 0;

    function spawnParticle(
      x: number,
      y: number,
      z: number,
      vx: number,
      vy: number,
      vz: number,
      maxAge: number,
      size: number,
      r: number,
      g: number,
      b: number,
    ) {
      const p = particles[particleCursor];
      particleCursor = (particleCursor + 1) % MAX_PARTICLES;
      p.active = true;
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = vx;
      p.vy = vy;
      p.vz = vz;
      p.age = 0;
      p.maxAge = maxAge;
      p.size = size;
      p.r = r;
      p.g = g;
      p.b = b;
    }

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const code = e.code;
      const isRepeat = keysHeldRef.current.has(code);
      keysHeldRef.current.add(code);

      if (!isRepeat) {
        if (
          gameStateRef.current === 'title' &&
          (code === 'Space' || code === 'KeyN') &&
          document.activeElement?.tagName !== 'INPUT'
        ) {
          purgeTimerRef.current = 0.85;
          soundEngine.playTurboBlowOff();
        }
        if (code === 'Escape' || code === 'KeyP') {
          if (
            gameStateRef.current === 'playing' ||
            gameStateRef.current === 'paused'
          ) {
            e.preventDefault();
            onTogglePauseRef.current();
          }
        } else if (code === 'KeyC' && gameStateRef.current === 'playing') {
          onCycleRaceCameraRef.current();
        } else if (
          gameStateRef.current === 'playing' &&
          (code === 'KeyA' || code === 'ArrowLeft')
        ) {
          const prevLane = playerTargetLaneIdxRef.current;
          const nextLane = Math.max(0, prevLane - 1);
          playerTargetLaneIdxRef.current = nextLane;
          steerHoldTimeRef.current = 0;
          if (onlineMatchRef.current && nextLane !== prevLane) {
            onSendOnlineLaneHopRef.current?.(nextLane as 0 | 1 | 2 | 3);
          }
        } else if (
          gameStateRef.current === 'playing' &&
          (code === 'KeyD' || code === 'ArrowRight')
        ) {
          const prevLane = playerTargetLaneIdxRef.current;
          const nextLane = Math.min(HIGHWAY_WORLD_LANE_X.length - 1, prevLane + 1);
          playerTargetLaneIdxRef.current = nextLane;
          steerHoldTimeRef.current = 0;
          if (onlineMatchRef.current && nextLane !== prevLane) {
            onSendOnlineLaneHopRef.current?.(nextLane as 0 | 1 | 2 | 3);
          }
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysHeldRef.current.delete(e.code);
    };

    const clearInputs = () => {
      keysHeldRef.current.clear();
      isDraggingOrbitRef.current = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (gameStateRef.current === 'title' && e.target === renderer.domElement) {
        isDraggingOrbitRef.current = true;
        lastDragClientRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const onPointerUp = () => {
      isDraggingOrbitRef.current = false;
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        pointerParallaxRef.current.x =
          ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointerParallaxRef.current.y =
          ((e.clientY - rect.top) / rect.height) * 2 - 1;
      }
      if (isDraggingOrbitRef.current && gameStateRef.current === 'title') {
        const dx = e.clientX - lastDragClientRef.current.x;
        const dy = e.clientY - lastDragClientRef.current.y;
        lastDragClientRef.current = { x: e.clientX, y: e.clientY };
        userOrbitYawRef.current -= dx * 0.009;
        userOrbitPitchRef.current = Math.max(
          -0.35,
          Math.min(0.55, userOrbitPitchRef.current + dy * 0.006),
        );
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.render(scene, camera);
    });
    resizeObserver.observe(container);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearInputs);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);

    let frameId = 0;
    let lastTimeMs = performance.now();
    let lastHudEmitMs = 0;
    let showcaseAngle = 0.65;
    let skidStepAccum = 0;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync
        ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
        : null;
      gl.flush();
      const poll = () => {
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 45);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function updateVisualCarRig(
      rig: CarRigHandles,
      racer: RacerState,
      dt: number,
      simTimeSec: number,
    ) {
      const hopY = racer.hopHeightY ?? 0;
      const hopPitch = racer.hopPitchRad ?? 0;
      const hopRoll = racer.hopRollRad ?? 0;
      const hopYaw = racer.hopYawRad ?? 0;
      const hopLandCompY = racer.hopLandingCompressionY ?? 0;
      const isHoppingOrSettling =
        hopY > 0.002 || Math.abs(hopLandCompY) > 0.001;

      rig.root.position.set(racer.x, hopY, racer.z);
      rig.root.rotation.y = racer.heading + hopYaw;

      const longG = racer.longitudinalG ?? 0;
      const latG = racer.lateralG ?? 0;
      const curbRumble = racer.curbRumbleIntensity ?? 0;
      const shiftPulse = (racer.shiftTimer ?? 0) > 0 ? 0.036 : 0;

      const suspStiffFactor =
        racer.isPlayer
          ? 1 - carConfigRef.current.suspensionStage * 0.1
          : 0.85;

      const targetPitch =
        (-longG * 0.036 - (racer.isBoosting ? 0.016 : 0) + shiftPulse) *
          suspStiffFactor +
        hopPitch;
      const targetRoll = -latG * 0.042 * suspStiffFactor + hopRoll;

      const roadMicroBounce =
        hopY > 0.01
          ? 0
          : Math.sin(simTimeSec * 28 + racer.x * 0.5) *
            Math.min(1, racer.speedMs / 45) *
            0.004;
      const curbBounce =
        curbRumble > 0.02 && hopY <= 0.01
          ? Math.sin(simTimeSec * 62) * curbRumble * 0.022
          : 0;
      const baseRideY = racer.isPlayer ? carConfigRef.current.rideHeight : -0.03;
      const aeroCompression =
        -Math.pow(Math.min(1, racer.speedMs / 75), 2) * 0.012;

      const bodyDampRate = isHoppingOrSettling ? 32 : 18;
      rig.bodyGroup.position.y = THREE.MathUtils.damp(
        rig.bodyGroup.position.y,
        baseRideY + aeroCompression + roadMicroBounce + curbBounce + hopLandCompY,
        bodyDampRate,
        dt,
      );
      rig.bodyGroup.rotation.x = THREE.MathUtils.damp(
        rig.bodyGroup.rotation.x,
        targetPitch + curbBounce * 0.4,
        isHoppingOrSettling ? 28 : 14.5,
        dt,
      );
      rig.bodyGroup.rotation.z = THREE.MathUtils.damp(
        rig.bodyGroup.rotation.z,
        targetRoll + curbBounce * 0.6,
        isHoppingOrSettling ? 28 : 14.5,
        dt,
      );

      const baseWheelAngularVel = racer.speedMs / 0.355;
      const wheelspinExtra = (racer.wheelspinIntensity ?? 0) * 28;
      for (let wIdx = 0; wIdx < rig.wheels.length; wIdx++) {
        const isRear = wIdx >= 2;
        const spinRate = isRear
          ? baseWheelAngularVel + wheelspinExtra
          : baseWheelAngularVel;
        rig.wheels[wIdx].rotation.x += spinRate * dt;
      }

      const visualSteer = Math.max(
        -0.62,
        Math.min(
          0.62,
          racer.steerAngle * 0.42 - racer.slipAngleRad * 0.72 + hopYaw * 3.0,
        ),
      );
      if (rig.frontWheelPivots.length >= 2) {
        const leftMult = visualSteer > 0 ? 1.12 : 0.9;
        const rightMult = visualSteer < 0 ? 1.12 : 0.9;
        rig.frontWheelPivots[0].rotation.y = visualSteer * leftMult;
        rig.frontWheelPivots[1].rotation.y = visualSteer * rightMult;

        // Unloaded coilover droop in mid-air + shock compression tuck on landing
        const wheelAirDroop =
          hopY > 0.01
            ? -Math.min(0.055, hopY * 0.11)
            : -hopLandCompY * 0.42;
        rig.frontWheelPivots[0].position.y =
          0.36 +
          wheelAirDroop +
          (curbRumble > 0 ? Math.sin(simTimeSec * 58) * curbRumble * 0.018 : 0);
        rig.frontWheelPivots[1].position.y =
          0.36 +
          wheelAirDroop +
          (curbRumble > 0 ? -Math.sin(simTimeSec * 58) * curbRumble * 0.018 : 0);
      }

      rig.tailLightMaterial.emissiveIntensity = racer.eliminated
        ? 0.25
        : racer.isBraking
          ? 4.4
          : 1.5;

      // All 4 human players in the session have equal 1.0 opacity; only translucent during ghost overlap or after elimination
      const ghostOverlap = racer.ghostOverlap ?? 0;
      const targetOpacity = racer.eliminated
        ? 0.42
        : ghostOverlap > 0.01
          ? Math.max(0.48, 1.0 - ghostOverlap * 0.48)
          : 1.0;

      for (const mat of rig.bodyMaterials) {
        if (racer.hitFlashTimer > 0) {
          mat.emissive.setHex(0xffffff);
          mat.emissiveIntensity = 0.65;
        } else {
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 0;
        }
        mat.transparent = targetOpacity < 0.99;
        mat.opacity = targetOpacity;
      }

      for (const flame of rig.flameMeshes) {
        const mat = flame.material as THREE.MeshBasicMaterial;
        mat.opacity = 0;
      }
    }

    function tick() {
      const nowMs = performance.now();
      const rawDt = (nowMs - lastTimeMs) / 1000;
      lastTimeMs = nowMs;
      const dt = Math.min(Math.max(rawDt, 0.001), 0.65);

      const state = gameStateRef.current;
      const racers = racersRef.current;
      const player = racers[0];
      const playerRig = playerCarRigRef.current;

      const activeSessionRacer =
        racers.find((r) => !r.eliminated) ?? player;
      if (activeSessionRacer) {
        highwayPointLight.position.set(0, 8.5, activeSessionRacer.z + 10);
        groundMesh.position.z = activeSessionRacer.z;
        // Seamlessly recycle the continuous straight 4-lane highway in 60m increments along +Z
        if (trackGroupRef.current) {
          trackGroupRef.current.position.z =
            Math.floor(activeSessionRacer.z / HIGHWAY_REPEAT_STEP_Z) *
            HIGHWAY_REPEAT_STEP_Z;
        }
      }

      if (state === 'title' && player && playerRig) {
        if (!isDraggingOrbitRef.current) {
          showcaseAngle += dt * 0.24;
        }
        const preset = garagePresetRef.current;
        const px = pointerParallaxRef.current.x;
        const py = pointerParallaxRef.current.y;

        const carX = player.x;
        const carZ = player.z;
        const heading = player.heading;
        const sinH = Math.sin(heading);
        const cosH = Math.cos(heading);
        const rightX = -cosH;
        const rightZ = sinH;

        playerRig.root.position.set(carX, 0.035, carZ);
        camera.up.set(0, 1, 0);

        if (purgeTimerRef.current > 0) {
          purgeTimerRef.current = Math.max(0, purgeTimerRef.current - dt);
          for (const nozzle of playerRig.purgeNozzleMeshes) {
            const mat = nozzle.material as THREE.MeshBasicMaterial;
            mat.opacity = Math.min(0.85, purgeTimerRef.current * 1.4);
            const jitter = 0.85 + Math.random() * 0.35;
            nozzle.scale.set(jitter, 0.8 + Math.random() * 0.45, jitter);
          }
          for (const side of [-0.55, 0.55]) {
            spawnParticle(
              carX + rightX * side + sinH * 0.72,
              0.88,
              carZ + rightZ * side + cosH * 0.72,
              rightX * side * (4.5 + Math.random() * 2.5),
              2.8 + Math.random() * 1.8,
              rightZ * side * (4.5 + Math.random() * 2.5),
              0.36,
              0.28,
              0.75,
              0.95,
              1.0,
            );
          }
        } else {
          for (const nozzle of playerRig.purgeNozzleMeshes) {
            (nozzle.material as THREE.MeshBasicMaterial).opacity = 0;
          }
        }

        // 4-Player Highway Starting Grid Podium Camera (frames all 4 lanes side-by-side)
        for (const flame of playerRig.flameMeshes) {
          (flame.material as THREE.MeshBasicMaterial).opacity = 0;
        }
        playerRig.root.position.set(carX, 0, carZ);
        for (const w of playerRig.wheels) {
          w.rotation.x += dt * 4.5;
        }
        rivalCarRigsRef.current.forEach((rig, idx) => {
          const rr = racers[idx + 1];
          if (rr) {
            rig.root.position.set(rr.x, 0, rr.z);
            for (const w of rig.wheels) {
              w.rotation.x += dt * 4.5;
            }
          }
        });

        const swayX = Math.sin(showcaseAngle * 0.7) * 0.7 - px * 1.2;
        const swayY = 10.2 - py * 0.4;
        const swayZ = carZ - 12.8 + Math.cos(showcaseAngle * 0.5) * 0.5;

        _camTargetPos.set(swayX, swayY, swayZ);
        _camLookAtPos.set(-px * 0.4, 0.2, carZ - 0.5);

        const dampFactor = 1 - Math.exp(-7.5 * dt);
        _currentCamPos.lerp(_camTargetPos, dampFactor);
        _currentLookAt.lerp(_camLookAtPos, dampFactor);

        camera.position.copy(_currentCamPos);
        camera.lookAt(_currentLookAt);
      } else if (state === 'playing' && player && playerRig) {
        if (hitstopTimerRef.current > 0) {
          hitstopTimerRef.current = Math.max(0, hitstopTimerRef.current - dt);
        }

        const keys = keysHeldRef.current;
        const steerLeft =
          keys.has('KeyA') || keys.has('ArrowLeft') ? -1 : 0;
        const steerRight =
          keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0;

        const rawSteer = steerLeft + steerRight;

        const subSteps = Math.min(26, Math.max(1, Math.ceil(dt / 0.025)));
        const subDt = dt / subSteps;
        const activeDifficulty = rivalDifficultyRef.current;
        let maxWallImpact = 0;
        let maxCarHit = 0;
        let gearUpshifted = false;
        let raceFinishedThisFrame = false;
        let lastEffectiveThrottle = 0.5;
        let progressiveBonusTime = 0;

        for (let stepIdx = 0; stepIdx < subSteps; stepIdx++) {
          // Uniform acceleration time for all 4 human players in the session (no braking, no manual speed-up disparity)
          elapsedRaceSecRef.current += subDt;
          paceClockSecRef.current += subDt;
          progressiveBonusTime = paceClockSecRef.current;
          skidStepAccum += subDt;

          if (rawSteer !== 0) {
            steerHoldTimeRef.current += subDt;
            const currentTargetX =
              HIGHWAY_WORLD_LANE_X[playerTargetLaneIdxRef.current];
            // If holding A/Left or D/Right continuously, chain into the next lane hop once landing/approaching the current target lane
            if (
              steerHoldTimeRef.current >= 0.20 &&
              Math.abs(player.x - currentTargetX) < 0.75
            ) {
              const prevLane = playerTargetLaneIdxRef.current;
              let nextLane = prevLane;
              if (rawSteer < 0) {
                nextLane = Math.max(0, prevLane - 1);
              } else if (rawSteer > 0) {
                nextLane = Math.min(HIGHWAY_WORLD_LANE_X.length - 1, prevLane + 1);
              }
              playerTargetLaneIdxRef.current = nextLane;
              if (onlineMatchRef.current && nextLane !== prevLane) {
                onSendOnlineLaneHopRef.current?.(nextLane as 0 | 1 | 2 | 3);
              }
              steerHoldTimeRef.current = 0.02;
            }
          } else {
            steerHoldTimeRef.current = 0;
          }

          const targetLaneX =
            HIGHWAY_WORLD_LANE_X[playerTargetLaneIdxRef.current];

          // Uniform Progressive Highway Speed-Up shared identically by all 4 players (brake = 0)
          const refSpeedMs =
            (racers.find((r) => !r.eliminated) ?? player).speedMs;
          const pace = computeProgressiveHighwayPace(
            refSpeedMs,
            progressiveBonusTime,
            false,
            0,
          );
          lastEffectiveThrottle = pace.throttle;

          const playerInput: PlayerInputState = {
            throttle: pace.throttle,
            brake: 0,
            steer: 0,
            handbrake: false,
            nitrous: false,
            desiredLaneX: targetLaneX,
          };

          // Identical car configuration and final drive stretch for all 4 human players so top speed limit & acceleration time match 100%
          const progressiveFinalDrive = Math.max(
            3.3,
            carConfigRef.current.finalDriveRatio -
              Math.max(0, progressiveBonusTime - 18) * 0.02,
          );
          const progressivePlayerCfg: CarConfig = {
            ...carConfigRef.current,
            finalDriveRatio: progressiveFinalDrive,
          };

          const activeOnlineMatch = onlineMatchRef.current;
          const onlineSnapshots = onlineRacersSnapshotPropRef.current?.current ?? null;

          // 1. Step Highway Traffic along the 4 straight lanes (deterministic Orion seed when online)
          stepTrafficVehicles(
            trafficRef.current,
            racers,
            trackIdRef.current,
            subDt,
            elapsedRaceSecRef.current,
            activeOnlineMatch?.trafficSeed,
          );

          const prevGear = player.gear;
          if (!player.eliminated) {
            const stepRes = stepSingleRacerPhysics(
              player,
              playerInput,
              progressivePlayerCfg,
              trackIdRef.current,
              subDt,
              elapsedRaceSecRef.current,
            );
            // Step linear, physical (non-cardboard) lane-hop kinematics for local player
            stepLaneHopKinematics(player, targetLaneX, subDt);
            player.isBoosting = false;
            player.exhaustFlameIntensity = 0;

            if (player.speedKmh > topSpeedSessionRef.current) {
              topSpeedSessionRef.current = player.speedKmh;
            }
            if (stepRes.gearShifted && player.gear > prevGear) {
              gearUpshifted = true;
            }
            if (stepRes.wallImpactMagnitude > maxWallImpact) {
              maxWallImpact = stepRes.wallImpactMagnitude;
            }
          }

          // 2. Step remote human players (server-driven lane target when online; zero AI steering)
          for (let i = 1; i < racers.length; i++) {
            const rival = racers[i];
            if (rival.eliminated) continue;

            if (activeOnlineMatch) {
              const snap = onlineSnapshots?.find((s) => s.playerId === rival.id);
              const rivalTargetX = snap
                ? HIGHWAY_WORLD_LANE_X[snap.targetLaneIndex]
                : rival.hopTargetX ?? rival.x;

              stepSingleRacerPhysics(
                rival,
                {
                  throttle: pace.throttle,
                  brake: 0,
                  steer: 0,
                  handbrake: false,
                  nitrous: false,
                  desiredLaneX: rivalTargetX,
                },
                progressivePlayerCfg,
                trackIdRef.current,
                subDt,
                elapsedRaceSecRef.current,
                activeDifficulty,
              );
              stepLaneHopKinematics(rival, rivalTargetX, subDt);
              if (snap) {
                const blend = Math.min(1, subDt * 10);
                rival.x += (snap.x - rival.x) * blend;
                rival.z += (snap.z - rival.z) * blend;
                rival.speedMs = snap.speedMs;
                rival.speedKmh = snap.speedKmh;
                if (snap.eliminated && !rival.eliminated) {
                  rival.eliminated = true;
                  rival.speedMs = 0;
                  rival.speedKmh = 0;
                  rival.vx = 0;
                  rival.vz = 0;
                  rival.hitFlashTimer = 0.65;
                }
              }
            } else {
              const aiInput = computeRivalControls(
                rival,
                player,
                trackIdRef.current,
                elapsedRaceSecRef.current,
                activeDifficulty,
                trafficRef.current,
              );
              const rivalTargetX =
                aiInput.desiredLaneX ?? rival.hopTargetX ?? rival.x;
              stepSingleRacerPhysics(
                rival,
                {
                  throttle: pace.throttle,
                  brake: 0,
                  steer: 0,
                  handbrake: false,
                  nitrous: false,
                  desiredLaneX: rivalTargetX,
                },
                progressivePlayerCfg,
                trackIdRef.current,
                subDt,
                elapsedRaceSecRef.current,
                activeDifficulty,
              );
              stepLaneHopKinematics(rival, rivalTargetX, subDt);
            }
            rival.isBoosting = false;
            rival.exhaustFlameIntensity = 0;
          }

          // Reconcile local player with authoritative server snapshot in online mode
          if (activeOnlineMatch && onlineSnapshots) {
            const localSnap = onlineSnapshots.find((s) => s.playerId === player.id);
            if (localSnap) {
              const zBlend = Math.min(1, subDt * 8);
              player.z += (localSnap.z - player.z) * zBlend;
              if (
                Math.abs(localSnap.x - player.x) > 1.8 &&
                (player.hopProgress ?? 1) >= 1
              ) {
                player.x += (localSnap.x - player.x) * Math.min(1, subDt * 8);
              }
              if (localSnap.eliminated && !player.eliminated) {
                player.eliminated = true;
                player.vx = 0;
                player.vz = 0;
                player.speedMs = 0;
                player.speedKmh = 0;
                player.hitFlashTimer = 0.65;
                soundEngine.playCollisionImpact(0.95);
              }
            }
          }

          // Synchronize all active human players so they share the exact same longitudinal speed and Z line
          syncFourPlayerHighwayPack(
            racers,
            elapsedRaceSecRef.current,
            subDt,
          );

          // 3. Ghost Pass-Through between Racers (all 4 human players are transparent to each other)
          resolveRacerCollisions(racers, trackIdRef.current);

          // Spawn per-player signature colored tire-hop bursts, mid-air slipstream trails, and ghost-overlap phase sparks
          for (let rIdx = 0; rIdx < racers.length; rIdx++) {
            const r = racers[rIdx];
            if (r.eliminated) continue;
            if (r.speedKmh > topSpeedSessionRef.current) {
              topSpeedSessionRef.current = r.speedKmh;
            }
            const sig = getPlayerSlotSignature(rIdx);
            const [dr, dg, db] = sig.hopDustRgb;
            const [sr, sg, sb] = sig.sparkRgb;

            if (r.hopJustTookOff || r.hopJustLanded) {
              if (r.isPlayer) {
                soundEngine.playLaneHop(Boolean(r.hopJustLanded));
              }
              const puffCount = r.hopJustLanded ? 4 : 2;
              for (const wheelSide of [-0.82, 0.82]) {
                for (let pIdx = 0; pIdx < puffCount; pIdx++) {
                  spawnParticle(
                    r.x + wheelSide + (Math.random() - 0.5) * 0.25,
                    0.12 + Math.random() * 0.08,
                    r.z - 1.1 + (Math.random() - 0.5) * 0.8,
                    (Math.random() - 0.5) * 2.2,
                    0.65 + Math.random() * 0.75,
                    (Math.random() - 0.5) * 2.2,
                    0.28 + Math.random() * 0.12,
                    r.hopJustLanded ? 0.30 : 0.22,
                    dr,
                    dg,
                    db,
                  );
                }
              }
            } else if ((r.hopHeightY ?? 0) > 0.08 && stepIdx === 0) {
              // Mid-air signature neon slipstream ribbon during lane hop
              spawnParticle(
                r.x + (Math.random() - 0.5) * 0.4,
                Math.max(0.14, (r.hopHeightY ?? 0) * 0.75),
                r.z - 1.65,
                (Math.random() - 0.5) * 0.8,
                0.15,
                -2.5,
                0.20,
                0.22,
                sr,
                sg,
                sb,
              );
            }

            // When 2+ players hop into the same narrow Survival Gate corridor and overlap, emit subtle signature phase sparks
            if ((r.ghostOverlap ?? 0) > 0.18 && stepIdx === 0 && Math.random() < 0.65) {
              const sideSign = rIdx % 2 === 0 ? -0.92 : 0.92;
              spawnParticle(
                r.x + sideSign,
                0.24 + (r.hopHeightY ?? 0),
                r.z + (Math.random() - 0.5) * 1.8,
                sideSign * 1.4,
                0.8 + Math.random() * 0.6,
                (Math.random() - 0.5) * 1.5,
                0.22,
                0.18,
                sr,
                sg,
                sb,
              );
            }
          }

          // 4. Collisions with Highway Traffic Vehicles: colliding ends the game for that specific player,
          // while the session continues for surviving players until the Last Player Standing is decided!
          for (let rIdx = 0; rIdx < racers.length; rIdx++) {
            const r = racers[rIdx];
            if (r.eliminated) continue;
            const tHit = checkRacerTrafficCollision(r, trafficRef.current);
            if (tHit.nearMiss) {
              r.trafficNearMisses = (r.trafficNearMisses ?? 0) + 1;
              r.totalDriftScore += 200;
              if (r.isPlayer) {
                soundEngine.playTrafficNearMiss(r.speedKmh);
              }
            }

            if (tHit.collided) {
              r.eliminated = true;
              r.eliminatedAtSec = elapsedRaceSecRef.current;
              r.finished = true;
              r.finishTimeSec = elapsedRaceSecRef.current;
              r.vx = 0;
              r.vz = 0;
              r.speedMs = 0;
              r.speedKmh = 0;
              r.isBoosting = false;
              r.isDrifting = false;
              r.hitFlashTimer = 0.65;

              const sig = getPlayerSlotSignature(rIdx);
              const [sr, sg, sb] = sig.sparkRgb;
              for (let s = 0; s < 14; s++) {
                const useSigColor = s % 2 === 0;
                spawnParticle(
                  r.x + (Math.random() - 0.5) * 1.6,
                  0.45 + Math.random() * 0.4,
                  r.z + (Math.random() - 0.5) * 1.6,
                  (Math.random() - 0.5) * 14,
                  3 + Math.random() * 6,
                  (Math.random() - 0.5) * 14,
                  0.3 + Math.random() * 0.2,
                  0.18,
                  useSigColor ? sr : 1.0,
                  useSigColor ? sg : 0.58,
                  useSigColor ? sb : 0.12,
                );
              }

              maxCarHit = Math.max(maxCarHit, r.isPlayer ? 1.0 : 0.72);
              soundEngine.playCollisionImpact(r.isPlayer ? 0.95 : 0.68);

              const sessionStatus = evaluateFourPlayerSessionStatus(racers);
              if (
                !activeOnlineMatch &&
                (r.isPlayer || sessionStatus.isSessionOver) &&
                !sessionFinishedRef.current
              ) {
                sessionFinishedRef.current = true;
                raceFinishedThisFrame = true;
              }
            }
          }

          if (skidStepAccum >= 0.032) {
            skidStepAccum = 0;
            for (const r of racers) {
              if (r.eliminated) continue;
              const shouldSkid =
                r.isDrifting ||
                (r.wheelspinIntensity ?? 0) > 0.42 ||
                (r.isBraking && r.speedMs > 18);
              if (shouldSkid) {
                const sH = Math.sin(r.heading);
                const cH = Math.cos(r.heading);
                const rX = -cH;
                const rZ = sH;
                const velAngle =
                  r.speedMs > 2 ? Math.atan2(r.vx, r.vz) : r.heading;
                for (const wheelSide of [-0.82, 0.82]) {
                  spawnTireSkidmark(
                    r.x + rX * wheelSide - sH * 1.32,
                    r.z + rZ * wheelSide - cH * 1.32,
                    velAngle,
                  );
                }
              }
            }
          }
        }

        if (gearUpshifted) {
          soundEngine.playTurboBlowOff();
        }

        const totalImpact = Math.max(maxWallImpact, maxCarHit);

        if (totalImpact > 0.42 && hitstopTimerRef.current <= 0) {
          hitstopTimerRef.current = 0.18;
          cameraTraumaRef.current = Math.min(
            1,
            cameraTraumaRef.current + totalImpact * 0.5,
          );
        }

        const liveAnchor =
          racers.find((r) => !r.eliminated) ?? player;
        const stats = computeCarStats(carConfigRef.current);
        soundEngine.updateDrivingTelemetry(
          liveAnchor.rpm,
          stats.redlineRpm,
          liveAnchor.isDrifting,
          false,
          liveAnchor.speedKmh,
          lastEffectiveThrottle,
          liveAnchor.turboBoostBar,
          liveAnchor.wheelspinIntensity ?? 0,
        );

        if (raceFinishedThisFrame) {
          const summary = buildRaceSummary(
            racers,
            trackIdRef.current,
            topSpeedSessionRef.current,
            elapsedRaceSecRef.current,
            rivalDifficultyRef.current,
          );
          soundEngine.stopDrivingLoop();
          soundEngine.playRaceFanfare(summary.isVictory);
          onRaceFinishRef.current(summary);
        }

        updateVisualCarRig(playerRig, player, dt, elapsedRaceSecRef.current);
        for (let i = 1; i < racers.length; i++) {
          const rRig = rivalCarRigsRef.current[i - 1];
          if (rRig) {
            updateVisualCarRig(rRig, racers[i], dt, elapsedRaceSecRef.current);
          }
        }

        const trafficList = trafficRef.current;
        const trafficMeshes = trafficMeshesRef.current;
        for (let tIdx = 0; tIdx < trafficList.length; tIdx++) {
          const tv = trafficList[tIdx];
          const tMesh = trafficMeshes[tIdx];
          if (tMesh) {
            tMesh.position.set(tv.x, 0, tv.z);
            tMesh.rotation.y = tv.heading;
          }
        }

        // Camera Controller: Top-Down camera constantly frames all 4 active players across the 4-lane highway (x = 0)
        const camMode = raceCameraModeRef.current;
        const sinH = Math.sin(player.heading);
        const cosH = Math.cos(player.heading);
        const rightX = -cosH;
        const rightZ = sinH;

        const camFollowHeading = player.heading + player.slipAngleRad * 0.72;
        const sinCam = Math.sin(camFollowHeading);
        const cosCam = Math.cos(camFollowHeading);

        const longG = player.longitudinalG ?? 0;
        const latG = player.lateralG ?? 0;
        const shiftPunch = (player.shiftTimer ?? 0) > 0 ? 0.28 : 0;
        const gForceDistDelta =
          Math.max(-0.45, Math.min(0.65, longG * 0.34)) + shiftPunch;

        const camLateralOffset = Math.max(
          -1.05,
          Math.min(1.05, -player.steerAngle * 0.55 + player.slipAngleRad * 0.45),
        );

        if (camMode === 'top_down') {
          const packFrame = computeFourPlayerCameraFrame(racers);
          _camTargetPos.set(
            packFrame.camX,
            packFrame.camY,
            packFrame.camZ,
          );
          _camLookAtPos.set(
            packFrame.lookAtX,
            packFrame.lookAtY,
            packFrame.lookAtZ,
          );
        } else if (camMode === 'hood') {
          _camTargetPos.set(
            player.x + sinH * (0.45 - gForceDistDelta * 0.18),
            1.32 - longG * 0.025,
            player.z + cosH * (0.45 - gForceDistDelta * 0.18),
          );
          _camLookAtPos.set(
            player.x + sinCam * 18,
            1.1 - longG * 0.08,
            player.z + cosCam * 18,
          );
        } else {
          const baseDistBack = camMode === 'far' ? 8.0 : 5.85;
          const distBack = baseDistBack + gForceDistDelta;
          const heightUp =
            (camMode === 'far' ? 2.75 : 2.02) - longG * 0.04;
          _camTargetPos.set(
            player.x - sinCam * distBack + rightX * camLateralOffset,
            heightUp,
            player.z - cosCam * distBack + rightZ * camLateralOffset,
          );
          _camLookAtPos.set(
            player.x + sinCam * 5.4 + sinH * 1.6 - rightX * camLateralOffset * 0.25,
            0.92,
            player.z + cosCam * 5.4 + cosH * 1.6 - rightZ * camLateralOffset * 0.25,
          );
        }

        const camDamp = 1 - Math.exp(-(camMode === 'hood' ? 24 : 12.5) * dt);
        _currentCamPos.lerp(_camTargetPos, camDamp);
        _currentLookAt.lerp(_camLookAtPos, camDamp);

        cameraTraumaRef.current = Math.max(
          0,
          cameraTraumaRef.current - dt * 1.8,
        );
        const curbShake = (player.curbRumbleIntensity ?? 0) * 0.025;
        const shake =
          cameraTraumaRef.current * cameraTraumaRef.current * 0.32 + curbShake;
        camera.position.set(
          _currentCamPos.x + (Math.random() - 0.5) * shake,
          _currentCamPos.y + (Math.random() - 0.5) * shake,
          _currentCamPos.z + (Math.random() - 0.5) * shake,
        );

        if (camMode === 'top_down') {
          // Straight ahead along +Z is always top of screen
          camera.up.set(0, 0.89, 0.45).normalize();
        } else {
          const bankAngle = Math.max(-0.045, Math.min(0.045, latG * 0.018));
          camera.up.set(rightX * bankAngle, 1, rightZ * bankAngle).normalize();
        }
        camera.lookAt(_currentLookAt);

        const targetFov =
          camMode === 'top_down'
            ? 54 + Math.min(7, (player.speedKmh / 280) * 7)
            : 60 + Math.min(12, (player.speedKmh / 280) * 12);
        if (Math.abs(camera.fov - targetFov) > 0.1) {
          camera.fov = THREE.MathUtils.damp(camera.fov, targetFov, 6, dt);
          camera.updateProjectionMatrix();
        }

        if (nowMs - lastHudEmitMs > 95) {
          lastHudEmitMs = nowMs;
          const standings = getSortedStandings(racers);
          const posIdx = standings.findIndex((r) => r.isPlayer);
          const stats = computeCarStats(carConfigRef.current);
          const trackSpec = TRACK_CATALOG[trackIdRef.current];
          const aliveCount = racers.filter((r) => !r.eliminated).length;

          onHudUpdateRef.current({
            speedKmh: player.speedKmh,
            rpm: player.rpm,
            redlineRpm: stats.redlineRpm,
            gear: player.gear,
            turboBoostBar: player.turboBoostBar,
            nitrousRemaining: Math.round(player.nitrousRemaining),
            isDrifting: player.isDrifting,
            isBoosting: player.isBoosting,
            currentDriftScore: Math.round(player.currentDriftScore),
            totalDriftScore: Math.round(player.totalDriftScore),
            driftMultiplier: player.driftMultiplier,
            position: posIdx >= 0 ? posIdx + 1 : 1,
            totalRacers: racers.length,
            aliveRacers: aliveCount,
            trafficNearMisses: player.trafficNearMisses ?? 0,
            lap: Math.min(trackSpec.laps, player.lap),
            totalLaps: trackSpec.laps,
            elapsedSec: elapsedRaceSecRef.current,
            cameraMode: camMode,
            racerPositions: racers.map((r) => ({
              id: r.id,
              x: r.x,
              z: r.z,
              heading: r.heading,
              isPlayer: r.isPlayer,
              color: r.isPlayer ? '#f59e0b' : r.underglowColor,
              eliminated: Boolean(r.eliminated),
            })),
            trafficPositions: trafficRef.current.map((tv) => ({
              id: tv.id,
              x: tv.x,
              z: tv.z,
              type: tv.type,
            })),
          });
        }
      }

      for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = particles[i];
        if (p.active) {
          p.age += dt;
          if (p.age >= p.maxAge) {
            p.active = false;
            _particlePos.set(0, -100, 0);
            _particleScale.set(0.001, 0.001, 0.001);
          } else {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;
            const lifeFrac = p.age / p.maxAge;
            const curScale = p.size * (1 + lifeFrac * 1.4) * (1 - lifeFrac * 0.6);
            _particlePos.set(p.x, p.y, p.z);
            _particleScale.set(curScale, curScale, curScale);
            _particleColor.setRGB(p.r, p.g, p.b);
            particleMesh.setColorAt(i, _particleColor);
          }
        } else {
          _particlePos.set(0, -100, 0);
          _particleScale.set(0.001, 0.001, 0.001);
        }
        _particleMatrix.compose(_particlePos, _particleQuat, _particleScale);
        particleMesh.setMatrixAt(i, _particleMatrix);
      }
      particleMesh.instanceMatrix.needsUpdate = true;
      if (particleMesh.instanceColor) {
        particleMesh.instanceColor.needsUpdate = true;
      }

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      resizeObserver.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearInputs);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      soundEngine.stopDrivingLoop();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className="fixed inset-0 z-0 w-full h-full overflow-hidden bg-[#56cc5c]"
      aria-label="3D 4-Lane Highway Survival Viewport"
    />
  );
};
