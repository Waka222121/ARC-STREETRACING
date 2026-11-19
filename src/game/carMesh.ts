import * as THREE from 'three';
import { CarConfig, ChassisId } from './types';

export interface CarRigHandles {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  wheels: THREE.Group[]; // [FL, FR, RL, RR]
  frontWheelPivots: THREE.Group[]; // [FL, FR]
  flameMeshes: THREE.Mesh[];
  purgeNozzleMeshes: THREE.Mesh[];
  tailLightMaterial: THREE.MeshStandardMaterial;
  bodyMaterials: THREE.MeshPhysicalMaterial[];
  underglowLight: THREE.PointLight | null;
  underglowPlane: THREE.Mesh;
}

function createVinylTexture(config: CarConfig): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }

  // Deep saturated automotive base coat
  ctx.fillStyle = config.paintColor;
  ctx.fillRect(0, 0, 1024, 1024);

  // Subtle side-flank metallic highlight gradient along the doors/fenders
  const flankGradLeft = ctx.createLinearGradient(0, 0, 240, 0);
  flankGradLeft.addColorStop(0, 'rgba(0,0,0,0.18)');
  flankGradLeft.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  flankGradLeft.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = flankGradLeft;
  ctx.fillRect(0, 0, 240, 1024);

  const flankGradRight = ctx.createLinearGradient(1024, 0, 784, 0);
  flankGradRight.addColorStop(0, 'rgba(0,0,0,0.18)');
  flankGradRight.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  flankGradRight.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = flankGradRight;
  ctx.fillRect(784, 0, 240, 1024);

  if (config.vinylStyle === 'twin_stripes') {
    ctx.fillStyle = config.vinylColor;
    ctx.fillRect(392, 0, 86, 1024);
    ctx.fillRect(546, 0, 86, 1024);

    ctx.fillStyle = config.pearlColor;
    ctx.fillRect(368, 0, 14, 1024);
    ctx.fillRect(642, 0, 14, 1024);

    ctx.fillStyle = config.vinylColor;
    ctx.fillRect(68, 140, 38, 740);
    ctx.fillRect(918, 140, 38, 740);
  } else if (config.vinylStyle === 'side_slash') {
    const drawSideSlash = (flip: boolean) => {
      ctx.save();
      if (flip) {
        ctx.translate(1024, 0);
        ctx.scale(-1, 1);
      }
      ctx.fillStyle = config.vinylColor;
      ctx.beginPath();
      ctx.moveTo(45, 860);
      ctx.lineTo(295, 190);
      ctx.lineTo(410, 140);
      ctx.lineTo(210, 880);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = config.pearlColor;
      ctx.beginPath();
      ctx.moveTo(140, 910);
      ctx.lineTo(365, 240);
      ctx.lineTo(445, 220);
      ctx.lineTo(260, 910);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.moveTo(80, 680);
      ctx.lineTo(280, 340);
      ctx.lineTo(310, 360);
      ctx.lineTo(130, 720);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    drawSideSlash(false);
    drawSideSlash(true);
  } else if (config.vinylStyle === 'carbon_hood') {
    ctx.fillStyle = '#0b101b';
    ctx.fillRect(210, 560, 604, 420);
    ctx.strokeStyle = '#222d42';
    ctx.lineWidth = 6;
    for (let i = -480; i < 820; i += 16) {
      ctx.beginPath();
      ctx.moveTo(210 + i, 560);
      ctx.lineTo(210 + i + 480, 980);
      ctx.stroke();
    }
  }

  // Subtle automotive panel gap lines (hood, trunk, doors)
  ctx.strokeStyle = 'rgba(0,0,0,0.34)';
  ctx.lineWidth = 3;
  ctx.strokeRect(232, 625, 560, 338); // Hood seam
  ctx.strokeRect(244, 52, 536, 178); // Trunk seam

  for (const doorY of [330, 515, 675]) {
    ctx.beginPath();
    ctx.moveTo(25, doorY);
    ctx.lineTo(215, doorY);
    ctx.moveTo(809, doorY);
    ctx.lineTo(999, doorY);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function createIntercoolerMeshTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, '#475569');
    grad.addColorStop(0.15, '#cbd5e1');
    grad.addColorStop(0.5, '#f8fafc');
    grad.addColorStop(0.85, '#cbd5e1');
    grad.addColorStop(1, '#475569');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 128);

    ctx.fillStyle = 'rgba(15, 23, 42, 0.54)';
    for (let y = 6; y < 122; y += 8) {
      ctx.fillRect(14, y, 228, 3);
    }

    ctx.strokeStyle = 'rgba(15, 23, 42, 0.68)';
    ctx.lineWidth = 2;
    for (let x = -128; x < 384; x += 12) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 128, 128);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 128, 0);
      ctx.lineTo(x, 128);
      ctx.stroke();
    }

    ctx.strokeStyle = '#090d16';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 248, 120);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 128, 14, 64, 128, 63);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.96)');
    grad.addColorStop(0.62, 'rgba(0, 0, 0, 0.62)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 256);
  }
  return new THREE.CanvasTexture(canvas);
}

let sharedShadowTex: THREE.CanvasTexture | null = null;
let sharedIntercoolerTex: THREE.CanvasTexture | null = null;

interface HullStation {
  z: number;
  bottomY: number;
  rockerW: number;
  rockerY: number;
  flareW: number;
  flareY: number;
  shoulderW: number;
  shoulderY: number;
  deckW: number;
  deckY: number;
  centerY: number;
}

/**
 * Builds a single-skin sculpted JDM Lancer Evolution VIII / Widebody Tuner hull
 * with blistered front/rear fender arches, tapered shark-nose hood, and high rear decklid.
 */
function buildSculptedHullGeometry(
  _chassis: ChassisId,
  bodyWidth: number,
  flareSpread: number,
): THREE.BufferGeometry {
  const hw = bodyWidth * 0.5;

  const zCoords = [
    -2.16, // 0: Rear bumper lower valence
    -2.10, // 1: Rear bumper vertical face
    -1.80, // 2: Rear quarter panel behind wheel
    -1.34, // 3: Rear wheel arch center (blistered widebody flare)
    -0.88, // 4: Rear wheel arch leading edge
    -0.42, // 5: B-pillar / center door line
    0.08, // 6: Front door middle
    0.62, // 7: Front fender A-pillar base
    0.92, // 8: Front wheel arch rear edge
    1.34, // 9: Front wheel arch center (blistered widebody flare)
    1.74, // 10: Front wheel arch leading edge
    2.04, // 11: Headlight brow & upper grille header
    2.18, // 12: Flush front bumper face & intercooler surround
    2.24, // 13: Lower front aero chin splitter tip
  ];

  const stations: HullStation[] = zCoords.map((z) => {
    const rearArchDist = Math.abs(z - -1.34);
    const frontArchDist = Math.abs(z - 1.34);
    const rearBulge = Math.max(0, 1 - (rearArchDist / 0.52) ** 2);
    const frontBulge = Math.max(0, 1 - (frontArchDist / 0.52) ** 2);
    const archBulge = Math.max(rearBulge, frontBulge);

    let endTaper = 1.0;
    if (z > 1.78) {
      const t = (z - 1.78) / (2.24 - 1.78);
      endTaper = 1 - 0.085 * t * t;
    } else if (z < -1.80) {
      const t = (-1.80 - z) / (-1.80 - -2.16);
      endTaper = 1 - 0.068 * t * t;
    }

    const baseHalfW = hw * endTaper;
    const extraArch = archBulge * (0.072 + flareSpread * 0.85);

    let deckY = 0.81;
    let centerY = 0.832;
    let bottomY = 0.18;

    if (z >= 0.62) {
      if (z <= 2.04) {
        const hoodT = (z - 0.62) / (2.04 - 0.62);
        deckY = 0.81 - 0.18 * hoodT ** 1.15;
        centerY = deckY + 0.022 * (1 - hoodT * 0.35);
      } else {
        const noseT = (z - 2.04) / (2.24 - 2.04);
        deckY = 0.63 - 0.15 * noseT ** 1.3;
        centerY = deckY + 0.012 * (1 - noseT);
      }
    } else if (z <= -1.35) {
      const tailT = Math.min(1, (-1.35 - z) / (-1.35 - -2.16));
      deckY = 0.82 - 0.04 * tailT ** 1.6;
      centerY = deckY + 0.014;
    }

    if (z < -1.95) bottomY = 0.20;
    if (z > 1.95) bottomY = 0.16;

    const shoulderY = deckY - 0.045 + archBulge * 0.028;
    const flareY = 0.47 + archBulge * 0.045;
    const rockerY = bottomY + 0.042;

    return {
      z,
      bottomY,
      rockerW: baseHalfW * 0.95 + extraArch * 0.55,
      rockerY,
      flareW: baseHalfW * 1.01 + extraArch,
      flareY,
      shoulderW: baseHalfW * 0.98 + extraArch * 0.65,
      shoulderY,
      deckW: baseHalfW * 0.90 + extraArch * 0.3,
      deckY,
      centerY,
    };
  });

  const ptsPerRing = 11;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let sIdx = 0; sIdx < stations.length; sIdx++) {
    const st = stations[sIdx];
    const ringPts: Array<[number, number]> = [
      [0, st.bottomY],
      [-st.rockerW, st.rockerY],
      [-st.flareW, st.flareY],
      [-st.shoulderW, st.shoulderY],
      [-st.deckW, st.deckY],
      [0, st.centerY],
      [st.deckW, st.deckY],
      [st.shoulderW, st.shoulderY],
      [st.flareW, st.flareY],
      [st.rockerW, st.rockerY],
      [0, st.bottomY],
    ];

    const vCoord = (st.z - -2.16) / (2.24 - -2.16);
    for (let pIdx = 0; pIdx < ptsPerRing; pIdx++) {
      const [px, py] = ringPts[pIdx];
      positions.push(px, py, st.z);
      const uCoord = 0.5 + px / (bodyWidth + 0.35);
      uvs.push(
        Math.max(0, Math.min(1, uCoord)),
        Math.max(0, Math.min(1, vCoord)),
      );
    }
  }

  for (let sIdx = 0; sIdx < stations.length - 1; sIdx++) {
    const rowA = sIdx * ptsPerRing;
    const rowB = (sIdx + 1) * ptsPerRing;
    for (let pIdx = 0; pIdx < ptsPerRing - 1; pIdx++) {
      const a = rowA + pIdx;
      const b = rowA + pIdx + 1;
      const c = rowB + pIdx;
      const d = rowB + pIdx + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds the sculpted glass greenhouse canopy (windshield, side windows, rear window)
 * with curved A/B/C pillar tumblehome.
 */
function buildSculptedCanopyGeometry(
  _chassis: ChassisId,
  bodyWidth: number,
): THREE.BufferGeometry {
  const roofPeakY = 1.28;
  const baseW = bodyWidth * 0.435;

  const slices = [
    {
      z: -1.48,
      yBase: 0.81,
      yTop: 0.84,
      wBase: baseW * 0.84,
      wTop: baseW * 0.66,
    },
    {
      z: -0.96,
      yBase: 0.81,
      yTop: roofPeakY - 0.02,
      wBase: baseW * 0.95,
      wTop: baseW * 0.77,
    },
    {
      z: -0.42,
      yBase: 0.81,
      yTop: roofPeakY,
      wBase: baseW * 0.99,
      wTop: baseW * 0.8,
    },
    {
      z: 0.14,
      yBase: 0.81,
      yTop: roofPeakY - 0.01,
      wBase: baseW * 0.98,
      wTop: baseW * 0.78,
    },
    {
      z: 0.78,
      yBase: 0.79,
      yTop: 0.82,
      wBase: baseW * 0.88,
      wTop: baseW * 0.68,
    },
  ];

  const ptsPerSlice = 7;
  const positions: number[] = [];
  const indices: number[] = [];

  for (const sl of slices) {
    const centerCrown = sl.yTop + 0.018;
    const shoulderCrown = sl.yTop + 0.014;
    const ring: Array<[number, number]> = [
      [-sl.wBase, sl.yBase],
      [-sl.wTop, sl.yTop - 0.015],
      [-sl.wTop * 0.5, shoulderCrown],
      [0, centerCrown],
      [sl.wTop * 0.5, shoulderCrown],
      [sl.wTop, sl.yTop - 0.015],
      [sl.wBase, sl.yBase],
    ];
    for (const [x, y] of ring) {
      positions.push(x, y, sl.z);
    }
  }

  for (let i = 0; i < slices.length - 1; i++) {
    const rA = i * ptsPerSlice;
    const rB = (i + 1) * ptsPerSlice;
    for (let j = 0; j < ptsPerSlice - 1; j++) {
      const a = rA + j;
      const b = rA + j + 1;
      const c = rB + j;
      const d = rB + j + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function buildProceduralCar(
  config: CarConfig,
  isSoftwareGl: boolean,
  withPointLight = true,
): CarRigHandles {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  bodyGroup.position.y = config.rideHeight;
  root.add(bodyGroup);

  const bodyMaterials: THREE.MeshPhysicalMaterial[] = [];

  const vinylTex = createVinylTexture(config);
  const isChrome = config.paintFinish === 'chrome';
  const isMatte = config.paintFinish === 'matte';
  const isPearl = config.paintFinish === 'pearlescent';

  const primaryPaintMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: vinylTex,
    emissive: new THREE.Color(config.paintColor),
    emissiveIntensity: isMatte ? 0.05 : 0.14,
    metalness: isChrome ? 0.92 : isMatte ? 0.14 : 0.18,
    roughness: isChrome ? 0.06 : isMatte ? 0.48 : 0.14,
    clearcoat: isMatte ? 0.12 : 1.0,
    clearcoatRoughness: isChrome ? 0.02 : 0.04,
    sheen: isPearl ? 0.9 : 0.25,
    sheenColor: new THREE.Color(config.pearlColor),
    sheenRoughness: 0.18,
  });
  bodyMaterials.push(primaryPaintMat);

  const solidBodyPaintMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(config.paintColor),
    emissive: new THREE.Color(config.paintColor),
    emissiveIntensity: isMatte ? 0.05 : 0.14,
    metalness: isChrome ? 0.92 : isMatte ? 0.14 : 0.18,
    roughness: isChrome ? 0.06 : isMatte ? 0.48 : 0.14,
    clearcoat: isMatte ? 0.12 : 1.0,
    clearcoatRoughness: isChrome ? 0.02 : 0.04,
  });
  bodyMaterials.push(solidBodyPaintMat);

  const carbonTrimMat = new THREE.MeshStandardMaterial({
    color: 0x0b101b,
    roughness: 0.36,
    metalness: 0.45,
  });

  const darkGrilleMat = new THREE.MeshStandardMaterial({
    color: 0x050811,
    roughness: 0.8,
    metalness: 0.22,
  });

  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x060a14,
    metalness: 0.35,
    roughness: 0.04,
    transmission: isSoftwareGl ? 0 : 0.2 * (1 - config.windowTint * 0.55),
    transparent: true,
    opacity: isSoftwareGl ? 0.92 : 0.94,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    sheen: 0.45,
    sheenColor: new THREE.Color(0x38bdf8),
  });

  const bodyWidth = 1.9;
  const bodyLength = 4.46;

  const flareSpread =
    config.bodyKit === 'widebody'
      ? 0.12
      : config.bodyKit === 'street'
        ? 0.06
        : 0.03;

  // PART 1: Sculpted JDM Hull
  const hullGeo = buildSculptedHullGeometry(
    config.chassis,
    bodyWidth,
    flareSpread,
  );
  const hullMesh = new THREE.Mesh(hullGeo, primaryPaintMat);
  hullMesh.castShadow = !isSoftwareGl;
  hullMesh.receiveShadow = !isSoftwareGl;
  bodyGroup.add(hullMesh);

  const rearBumperCapGeo = new THREE.BoxGeometry(bodyWidth * 0.92, 0.5, 0.12);
  const rearBumperCap = new THREE.Mesh(rearBumperCapGeo, solidBodyPaintMat);
  rearBumperCap.position.set(0, 0.48, -2.1);
  bodyGroup.add(rearBumperCap);

  const frontBumperCapGeo = new THREE.BoxGeometry(bodyWidth * 0.88, 0.3, 0.12);
  const frontBumperCap = new THREE.Mesh(frontBumperCapGeo, solidBodyPaintMat);
  frontBumperCap.position.set(0, 0.35, 2.13);
  bodyGroup.add(frontBumperCap);

  // PART 2: Glass Greenhouse + Flush Body-Color Roof Skin + B/C Pillars
  const canopyGeo = buildSculptedCanopyGeometry(config.chassis, bodyWidth);
  const canopyMesh = new THREE.Mesh(canopyGeo, glassMat);
  bodyGroup.add(canopyMesh);

  const roofPanelGeo = new THREE.BoxGeometry(bodyWidth * 0.64, 0.028, 1.12);
  const roofPanel = new THREE.Mesh(roofPanelGeo, solidBodyPaintMat);
  roofPanel.position.set(0, 1.284, -0.41);
  bodyGroup.add(roofPanel);

  for (const side of [-1, 1]) {
    const bPillarGeo = new THREE.BoxGeometry(0.024, 0.42, 0.065);
    bPillarGeo.rotateZ(side * 0.34);
    const bPillar = new THREE.Mesh(bPillarGeo, darkGrilleMat);
    bPillar.position.set(side * (bodyWidth * 0.372), 1.02, -0.22);
    bodyGroup.add(bPillar);

    const cDividerGeo = new THREE.BoxGeometry(0.022, 0.38, 0.042);
    cDividerGeo.rotateZ(side * 0.34);
    cDividerGeo.rotateX(-0.22);
    const cDivider = new THREE.Mesh(cDividerGeo, darkGrilleMat);
    cDivider.position.set(side * (bodyWidth * 0.368), 1.0, -0.82);
    bodyGroup.add(cDivider);
  }

  const cowlGeo = new THREE.BoxGeometry(bodyWidth * 0.72, 0.024, 0.12);
  const cowlMesh = new THREE.Mesh(cowlGeo, darkGrilleMat);
  cowlMesh.position.set(0, 0.822, 0.76);
  bodyGroup.add(cowlMesh);

  // PART 3: Sculpted Carbon Louvered Hood Extractor Vent
  const hoodVentFrameGeo = new THREE.BoxGeometry(0.7, 0.028, 0.52);
  hoodVentFrameGeo.rotateX(0.12);
  const hoodVentFrame = new THREE.Mesh(hoodVentFrameGeo, darkGrilleMat);
  hoodVentFrame.position.set(0, 0.748, 1.32);
  bodyGroup.add(hoodVentFrame);

  for (let lz = -0.18; lz <= 0.18; lz += 0.09) {
    const slatGeo = new THREE.BoxGeometry(0.62, 0.02, 0.032);
    slatGeo.rotateX(0.32);
    const slat = new THREE.Mesh(slatGeo, carbonTrimMat);
    slat.position.set(0, 0.758 - lz * 0.12, 1.32 + lz);
    bodyGroup.add(slat);
  }

  // PART 4: Widebody Side Skirts, Blistered Wheel Arches, Door Handles & Mirrors
  const wheelZPositions = [1.34, -1.34];
  const archTubeRadius = 0.044 + flareSpread * 0.36;
  const archGeom = new THREE.TorusGeometry(
    0.365,
    archTubeRadius,
    12,
    24,
    Math.PI,
  );
  const wellLinerGeom = new THREE.CylinderGeometry(
    0.36,
    0.36,
    0.36,
    18,
    1,
    false,
    0,
    Math.PI,
  );
  wellLinerGeom.rotateZ(Math.PI / 2);

  const amberMarkerMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
  const redReflectorMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });

  for (const side of [-1, 1]) {
    const skirtGeo = new THREE.BoxGeometry(
      0.14 + flareSpread * 0.65,
      0.11,
      1.92,
    );
    const skirtMesh = new THREE.Mesh(skirtGeo, solidBodyPaintMat);
    skirtMesh.position.set(
      side * (bodyWidth * 0.475 + flareSpread * 0.35),
      0.22,
      0.0,
    );
    bodyGroup.add(skirtMesh);

    const sillLipGeo = new THREE.BoxGeometry(
      0.18 + flareSpread * 0.8,
      0.03,
      1.96,
    );
    const sillLipMesh = new THREE.Mesh(sillLipGeo, carbonTrimMat);
    sillLipMesh.position.set(
      side * (bodyWidth * 0.492 + flareSpread * 0.46),
      0.158,
      0.0,
    );
    bodyGroup.add(sillLipMesh);

    for (const handleZ of [0.12, -0.62]) {
      const handleGeo = new THREE.BoxGeometry(0.032, 0.028, 0.14);
      const handleMesh = new THREE.Mesh(handleGeo, solidBodyPaintMat);
      handleMesh.position.set(
        side * (bodyWidth * 0.486 + flareSpread * 0.2),
        0.74,
        handleZ,
      );
      bodyGroup.add(handleMesh);
    }

    const repeaterGeo = new THREE.BoxGeometry(0.024, 0.022, 0.052);
    const repeater = new THREE.Mesh(repeaterGeo, amberMarkerMat);
    repeater.position.set(
      side * (bodyWidth * 0.492 + flareSpread * 0.32),
      0.56,
      0.82,
    );
    bodyGroup.add(repeater);

    const rearMarkerGeo = new THREE.BoxGeometry(0.024, 0.026, 0.082);
    const rearMarker = new THREE.Mesh(rearMarkerGeo, redReflectorMat);
    rearMarker.position.set(
      side * (bodyWidth * 0.485 + flareSpread * 0.22),
      0.4,
      -1.92,
    );
    bodyGroup.add(rearMarker);

    const mirrorGroup = new THREE.Group();
    mirrorGroup.position.set(side * (bodyWidth * 0.455), 0.84, 0.5);
    const mirrorBaseGeo = new THREE.BoxGeometry(0.07, 0.05, 0.1);
    const mirrorBase = new THREE.Mesh(mirrorBaseGeo, darkGrilleMat);
    mirrorGroup.add(mirrorBase);

    const mirrorHousingGeo = new THREE.BoxGeometry(0.16, 0.085, 0.095);
    const mirrorHousing = new THREE.Mesh(mirrorHousingGeo, solidBodyPaintMat);
    mirrorHousing.position.set(side * 0.075, 0.015, -0.01);
    mirrorHousing.rotation.y = side * -0.18;
    mirrorGroup.add(mirrorHousing);
    bodyGroup.add(mirrorGroup);

    for (const wz of wheelZPositions) {
      const archMesh = new THREE.Mesh(archGeom, solidBodyPaintMat);
      archMesh.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      archMesh.scale.set(1.06, 0.88, 1.14);
      archMesh.position.set(
        side * (bodyWidth * 0.465 + flareSpread * 0.45),
        0.35,
        wz,
      );
      bodyGroup.add(archMesh);

      const linerMesh = new THREE.Mesh(wellLinerGeom, darkGrilleMat);
      linerMesh.position.set(side * (bodyWidth * 0.39), 0.35, wz);
      bodyGroup.add(linerMesh);
    }
  }

  // PART 5: Front Splitter, Split Grille & Finned Front-Mount Intercooler (FMIC)
  if (!sharedIntercoolerTex) {
    sharedIntercoolerTex = createIntercoolerMeshTexture();
  }

  const chinLipGeo = new THREE.BoxGeometry(
    bodyWidth * 0.96 + flareSpread * 1.15,
    0.045,
    0.22,
  );
  const chinLipMesh = new THREE.Mesh(chinLipGeo, carbonTrimMat);
  chinLipMesh.position.set(0, 0.175, 2.18);
  bodyGroup.add(chinLipMesh);

  for (const side of [-1, 1]) {
    const sideDuctGeo = new THREE.BoxGeometry(0.3, 0.15, 0.08);
    const sideDuct = new THREE.Mesh(sideDuctGeo, darkGrilleMat);
    sideDuct.position.set(side * 0.66, 0.29, 2.18);
    sideDuct.rotation.y = side * 0.12;
    bodyGroup.add(sideDuct);
  }

  const centerMouthGeo = new THREE.BoxGeometry(0.94, 0.25, 0.08);
  const centerMouth = new THREE.Mesh(centerMouthGeo, darkGrilleMat);
  centerMouth.position.set(0, 0.29, 2.19);
  bodyGroup.add(centerMouth);

  const fmicMat = new THREE.MeshStandardMaterial({
    map: sharedIntercoolerTex,
    metalness: 0.78,
    roughness: 0.22,
  });
  const fmicGeo = new THREE.BoxGeometry(0.86, 0.22, 0.05);
  const fmicMesh = new THREE.Mesh(fmicGeo, fmicMat);
  fmicMesh.position.set(0, 0.29, 2.215);
  bodyGroup.add(fmicMesh);

  for (const sx of [-0.2, 0.2]) {
    const slotGeo = new THREE.BoxGeometry(0.32, 0.026, 0.06);
    const slot = new THREE.Mesh(slotGeo, darkGrilleMat);
    slot.position.set(sx, 0.445, 2.205);
    bodyGroup.add(slot);
  }

  const upperGrilleGeo = new THREE.BoxGeometry(0.82, 0.105, 0.08);
  upperGrilleGeo.rotateX(0.12);
  const upperGrille = new THREE.Mesh(upperGrilleGeo, darkGrilleMat);
  upperGrille.position.set(0, 0.555, 2.17);
  bodyGroup.add(upperGrille);

  const noseShieldGeo = new THREE.ConeGeometry(0.11, 0.13, 3);
  noseShieldGeo.rotateX(0.12);
  noseShieldGeo.rotateY(Math.PI);
  const noseShield = new THREE.Mesh(noseShieldGeo, solidBodyPaintMat);
  noseShield.position.set(0, 0.56, 2.2);
  bodyGroup.add(noseShield);

  const badgeChromeMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0.96,
    roughness: 0.06,
    clearcoat: 1.0,
  });
  const diamondPositions: Array<[number, number]> = [
    [0, 0.582],
    [-0.024, 0.545],
    [0.024, 0.545],
  ];
  for (const [dx, dy] of diamondPositions) {
    const dGeo = new THREE.OctahedronGeometry(0.02, 0);
    dGeo.scale(0.85, 1.15, 0.35);
    const dMesh = new THREE.Mesh(dGeo, badgeChromeMat);
    dMesh.position.set(dx, dy, 2.228);
    bodyGroup.add(dMesh);
  }

  // PART 6: Carbon Rear Diffuser & Dual Burnt-Titanium Exhausts
  const rearApronGeo = new THREE.BoxGeometry(bodyWidth * 0.94, 0.16, 0.2);
  const rearApronMesh = new THREE.Mesh(rearApronGeo, carbonTrimMat);
  rearApronMesh.position.set(0, 0.22, -2.12);
  bodyGroup.add(rearApronMesh);

  for (const fx of [-0.58, -0.3, 0, 0.3, 0.58]) {
    const finGeo = new THREE.BoxGeometry(0.024, 0.15, 0.24);
    const fin = new THREE.Mesh(finGeo, carbonTrimMat);
    fin.position.set(fx, 0.2, -2.15);
    bodyGroup.add(fin);
  }

  const exhaustMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    metalness: 0.96,
    roughness: 0.08,
  });
  const burntTipMat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    emissive: 0x1d4ed8,
    emissiveIntensity: 0.65,
    metalness: 0.94,
    roughness: 0.12,
  });
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
  });
  const flameMeshes: THREE.Mesh[] = [];
  const purgeNozzleMeshes: THREE.Mesh[] = [];

  for (const ex of [-0.54, 0.54]) {
    const canisterGeo = new THREE.CylinderGeometry(0.076, 0.076, 0.32, 16);
    canisterGeo.rotateX(Math.PI / 2);
    const canister = new THREE.Mesh(canisterGeo, exhaustMat);
    canister.position.set(ex, 0.23, -2.13);
    canister.rotation.y = Math.sign(ex) * -0.08;
    bodyGroup.add(canister);

    const tipRingGeo = new THREE.TorusGeometry(0.072, 0.012, 8, 16);
    const tipRing = new THREE.Mesh(tipRingGeo, burntTipMat);
    tipRing.position.set(ex, 0.23, -2.28);
    bodyGroup.add(tipRing);

    const flameGeo = new THREE.ConeGeometry(0.11, 0.68, 12);
    flameGeo.rotateX(-Math.PI / 2);
    const flameMesh = new THREE.Mesh(flameGeo, flameMat);
    flameMesh.position.set(ex, 0.23, -2.6);
    bodyGroup.add(flameMesh);
    flameMeshes.push(flameMesh);
  }

  // PART 7: High-Arch JDM GT Spoiler Wing
  if (config.spoiler !== 'none') {
    const wingGroup = new THREE.Group();
    wingGroup.position.set(0, 0.83, -1.92);

    if (config.spoiler === 'ducktail') {
      const duckGeo = new THREE.BoxGeometry(bodyWidth * 0.88, 0.14, 0.26);
      duckGeo.rotateX(-0.36);
      const duckMesh = new THREE.Mesh(duckGeo, solidBodyPaintMat);
      duckMesh.position.set(0, 0.06, -0.05);
      wingGroup.add(duckMesh);
    } else {
      const wingSpan = bodyWidth * 0.88;
      const wingHeight = config.spoiler === 'twin_deck' ? 0.39 : 0.35;

      for (const side of [-1, 1]) {
        const pillarGeo = new THREE.BoxGeometry(0.052, wingHeight, 0.32);
        pillarGeo.rotateX(-0.18);
        pillarGeo.rotateZ(side * -0.05);
        const pillarMesh = new THREE.Mesh(pillarGeo, solidBodyPaintMat);
        pillarMesh.position.set(
          side * (wingSpan * 0.48),
          wingHeight * 0.48,
          -0.04,
        );
        wingGroup.add(pillarMesh);
      }

      const mainBladeGeo = new THREE.BoxGeometry(wingSpan + 0.04, 0.036, 0.29);
      mainBladeGeo.rotateX(0.14);
      const mainBlade = new THREE.Mesh(mainBladeGeo, carbonTrimMat);
      mainBlade.position.set(0, wingHeight - 0.02, -0.06);
      wingGroup.add(mainBlade);

      if (config.spoiler === 'twin_deck') {
        const midBladeGeo = new THREE.BoxGeometry(wingSpan - 0.04, 0.026, 0.22);
        midBladeGeo.rotateX(0.16);
        const midBlade = new THREE.Mesh(midBladeGeo, solidBodyPaintMat);
        midBlade.position.set(0, wingHeight * 0.58, -0.05);
        wingGroup.add(midBlade);
      }
    }
    bodyGroup.add(wingGroup);
  }

  // PART 8: Crystal Projector Headlights & Altezza Rear Tail Lamps
  const headlightMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(config.headlightColor),
    emissive: new THREE.Color(config.headlightColor),
    emissiveIntensity: 3.0,
    roughness: 0.05,
  });
  const chromeReflectorMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    metalness: 0.92,
    roughness: 0.1,
  });

  for (const side of [-1, 1]) {
    const housingGeo = new THREE.BoxGeometry(0.39, 0.115, 0.15);
    housingGeo.rotateY(side * 0.14);
    housingGeo.rotateX(0.1);
    const housing = new THREE.Mesh(housingGeo, chromeReflectorMat);
    housing.position.set(side * 0.62, 0.56, 2.13);
    bodyGroup.add(housing);

    for (const lx of [-0.08, 0.05]) {
      const bulbGeo = new THREE.SphereGeometry(0.044, 12, 12);
      const bulb = new THREE.Mesh(bulbGeo, headlightMat);
      bulb.position.set(side * 0.61 + lx, 0.56, 2.19);
      bodyGroup.add(bulb);
    }

    const cornerSignalGeo = new THREE.BoxGeometry(0.065, 0.09, 0.08);
    cornerSignalGeo.rotateY(side * 0.18);
    const cornerSignal = new THREE.Mesh(cornerSignalGeo, amberMarkerMat);
    cornerSignal.position.set(side * 0.78, 0.56, 2.1);
    bodyGroup.add(cornerSignal);
  }

  const tailLightMaterial = new THREE.MeshStandardMaterial({
    color: 0xff1e1e,
    emissive: 0xef4444,
    emissiveIntensity: 2.6,
    roughness: 0.08,
  });

  for (const side of [-1, 1]) {
    const tailHousingGeo = new THREE.BoxGeometry(0.38, 0.155, 0.08);
    const tailHousing = new THREE.Mesh(tailHousingGeo, darkGrilleMat);
    tailHousing.position.set(side * 0.64, 0.64, -2.14);
    bodyGroup.add(tailHousing);

    const mainLampGeo = new THREE.CylinderGeometry(0.056, 0.056, 0.05, 16);
    mainLampGeo.rotateX(Math.PI / 2);
    const mainLamp = new THREE.Mesh(mainLampGeo, tailLightMaterial);
    mainLamp.position.set(side * 0.69, 0.66, -2.17);
    bodyGroup.add(mainLamp);

    const innerLampGeo = new THREE.CylinderGeometry(0.044, 0.044, 0.05, 14);
    innerLampGeo.rotateX(Math.PI / 2);
    const innerLamp = new THREE.Mesh(innerLampGeo, tailLightMaterial);
    innerLamp.position.set(side * 0.56, 0.65, -2.17);
    bodyGroup.add(innerLamp);

    const rearIndGeo = new THREE.BoxGeometry(0.13, 0.032, 0.05);
    const rearInd = new THREE.Mesh(rearIndGeo, amberMarkerMat);
    rearInd.position.set(side * 0.67, 0.585, -2.17);
    bodyGroup.add(rearInd);
  }

  // PART 9..12: 4 Deep-Dish Racing Rims, Brembo Calipers & Low-Profile Tires
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x0f131b,
    roughness: 0.72,
    metalness: 0.14,
  });
  const rimMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(config.rimColor),
    metalness: 0.25,
    roughness: 0.12,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
  });
  const innerBarrelMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    metalness: 0.68,
    roughness: 0.32,
    side: THREE.DoubleSide,
  });
  const rotorMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    metalness: 0.88,
    roughness: 0.22,
  });
  const caliperMat = new THREE.MeshStandardMaterial({
    color: 0xef4444,
    emissive: 0x991b1b,
    emissiveIntensity: 0.4,
    roughness: 0.18,
    metalness: 0.55,
  });

  const wheels: THREE.Group[] = [];
  const frontWheelPivots: THREE.Group[] = [];
  const trackHalfWidth = bodyWidth * 0.48 + flareSpread * 0.65;
  const camberRad = THREE.MathUtils.degToRad(config.camberAngle);

  const wheelCoords: Array<{ x: number; z: number; isFront: boolean }> = [
    { x: -trackHalfWidth, z: 1.34, isFront: true },
    { x: trackHalfWidth, z: 1.34, isFront: true },
    { x: -trackHalfWidth, z: -1.34, isFront: false },
    { x: trackHalfWidth, z: -1.34, isFront: false },
  ];

  const spokeCount =
    config.rimStyle === 'te37' ? 6 : config.rimStyle === 'bbs' ? 10 : 5;

  for (const wc of wheelCoords) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(wc.x, 0.355, wc.z);

    const camberHolder = new THREE.Group();
    const sideSign = Math.sign(wc.x);
    camberHolder.rotation.z = sideSign * camberRad;
    steerPivot.add(camberHolder);

    const rotorGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.032, 24);
    rotorGeo.rotateZ(Math.PI / 2);
    const rotor = new THREE.Mesh(rotorGeo, rotorMat);
    rotor.position.x = sideSign * 0.045;
    camberHolder.add(rotor);

    const caliperGeo = new THREE.BoxGeometry(0.065, 0.16, 0.11);
    const caliper = new THREE.Mesh(caliperGeo, caliperMat);
    caliper.position.set(sideSign * 0.072, 0.055, -0.12);
    camberHolder.add(caliper);

    const spinGroup = new THREE.Group();

    const tireTreadGeo = new THREE.CylinderGeometry(
      0.35,
      0.35,
      0.27,
      28,
      1,
      true,
    );
    tireTreadGeo.rotateZ(Math.PI / 2);
    const tireTreadMat = tireMat.clone();
    tireTreadMat.side = THREE.DoubleSide;
    spinGroup.add(new THREE.Mesh(tireTreadGeo, tireTreadMat));

    const sidewallGeo = new THREE.TorusGeometry(0.305, 0.048, 12, 28);
    sidewallGeo.rotateY(Math.PI / 2);
    const outerWall = new THREE.Mesh(sidewallGeo, tireMat);
    outerWall.position.x = sideSign * 0.108;
    spinGroup.add(outerWall);

    const innerWall = new THREE.Mesh(sidewallGeo, tireMat);
    innerWall.position.x = -sideSign * 0.108;
    spinGroup.add(innerWall);

    const barrelGeo = new THREE.CylinderGeometry(
      0.265,
      0.265,
      0.24,
      24,
      1,
      true,
    );
    barrelGeo.rotateZ(Math.PI / 2);
    spinGroup.add(new THREE.Mesh(barrelGeo, innerBarrelMat));

    const dishLipGeo = new THREE.TorusGeometry(0.262, 0.022, 12, 28);
    dishLipGeo.rotateY(Math.PI / 2);
    const dishLip = new THREE.Mesh(dishLipGeo, rimMat);
    dishLip.position.x = sideSign * 0.118;
    spinGroup.add(dishLip);

    const hubGeo = new THREE.CylinderGeometry(0.068, 0.072, 0.05, 16);
    hubGeo.rotateZ(Math.PI / 2);
    const hubMesh = new THREE.Mesh(hubGeo, rimMat);
    hubMesh.position.x = sideSign * 0.105;
    spinGroup.add(hubMesh);

    for (let s = 0; s < spokeCount; s++) {
      const angle = (s / spokeCount) * Math.PI * 2;
      const spokeWidth = config.rimStyle === 'aero' ? 0.082 : 0.046;
      const spokeGeo = new THREE.BoxGeometry(0.032, 0.23, spokeWidth);
      spokeGeo.translate(0, 0.135, 0);
      spokeGeo.rotateX(angle);
      const spoke = new THREE.Mesh(spokeGeo, rimMat);
      spoke.position.x = sideSign * 0.112;
      spinGroup.add(spoke);
    }

    camberHolder.add(spinGroup);
    root.add(steerPivot);
    wheels.push(spinGroup);
    if (wc.isFront) {
      frontWheelPivots.push(steerPivot);
    }
  }

  // PART 13: Ground Contact Shadow Disc & Neon Underglow Plane
  if (!sharedShadowTex) {
    sharedShadowTex = createContactShadowTexture();
  }
  const shadowPlaneGeo = new THREE.PlaneGeometry(
    bodyWidth + 0.85,
    bodyLength + 0.85,
  );
  shadowPlaneGeo.rotateX(-Math.PI / 2);
  const shadowPlaneMat = new THREE.MeshBasicMaterial({
    map: sharedShadowTex,
    transparent: true,
    opacity: 0.84,
    depthWrite: false,
  });
  const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
  shadowPlane.position.y = 0.035;
  root.add(shadowPlane);

  const underglowGeo = new THREE.PlaneGeometry(
    bodyWidth * 1.15,
    bodyLength * 0.92,
  );
  underglowGeo.rotateX(-Math.PI / 2);
  const underglowMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(config.underglowColor),
    transparent: true,
    opacity: config.underglowEnabled ? 0.38 : 0.0,
    depthWrite: false,
  });
  const underglowPlane = new THREE.Mesh(underglowGeo, underglowMat);
  underglowPlane.position.y = 0.044;
  root.add(underglowPlane);

  let underglowLight: THREE.PointLight | null = null;
  if (withPointLight && !isSoftwareGl) {
    underglowLight = new THREE.PointLight(
      new THREE.Color(config.underglowColor),
      config.underglowEnabled ? 4.2 : 0,
      6.8,
      1.7,
    );
    underglowLight.position.set(0, 0.24, 0);
    root.add(underglowLight);
  }

  return {
    root,
    bodyGroup,
    wheels,
    frontWheelPivots,
    flameMeshes,
    purgeNozzleMeshes,
    tailLightMaterial,
    bodyMaterials,
    underglowLight,
    underglowPlane,
  };
}
