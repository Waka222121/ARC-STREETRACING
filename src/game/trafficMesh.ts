import * as THREE from 'three';
import type { TrafficVehicle } from './traffic';

// Shared immutable materials & wheel geometries reused across all 28 highway traffic vehicles
// to minimize GPU allocations and shader compilations when a race launches.
const sharedGlassMat = new THREE.MeshStandardMaterial({
  color: 0x0b1120,
  roughness: 0.12,
  metalness: 0.85,
});
const sharedDarkTrimMat = new THREE.MeshStandardMaterial({
  color: 0x111827,
  roughness: 0.7,
  metalness: 0.3,
});
const sharedWheelMat = new THREE.MeshStandardMaterial({
  color: 0x090d16,
  roughness: 0.85,
  metalness: 0.15,
});
const sharedHeadLightMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
const sharedTailLightMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
const sharedAmberMarkerMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });

const sharedTruckWheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.36, 12);
sharedTruckWheelGeo.rotateZ(Math.PI / 2);

const sharedCarWheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12);
sharedCarWheelGeo.rotateZ(Math.PI / 2);

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
    const windshieldMesh = new THREE.Mesh(windshieldGeo, sharedGlassMat);
    windshieldMesh.position.set(0, 2.0, 4.26);
    group.add(windshieldMesh);

    // Front radiator grille
    const grilleGeo = new THREE.BoxGeometry(1.6, 0.95, 0.14);
    const grilleMesh = new THREE.Mesh(grilleGeo, sharedDarkTrimMat);
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
    const stripeMesh = new THREE.Mesh(stripeGeo, sharedAmberMarkerMat);
    stripeMesh.position.set(0, 3.38, -1.45);
    group.add(stripeMesh);

    // Chassis lower frame rail
    const frameGeo = new THREE.BoxGeometry(1.5, 0.35, 8.8);
    const frameMesh = new THREE.Mesh(frameGeo, sharedDarkTrimMat);
    frameMesh.position.set(0, 0.52, -0.1);
    group.add(frameMesh);

    // 6 heavy truck wheel pairs
    for (const zPos of [3.2, 0.8, -2.4, -3.5]) {
      for (const xSide of [-1.1, 1.1]) {
        const w = new THREE.Mesh(sharedTruckWheelGeo, sharedWheelMat);
        w.position.set(xSide, 0.46, zPos);
        group.add(w);
      }
    }

    // Truck headlights & bright rear brake bar
    const hlGeo = new THREE.BoxGeometry(0.42, 0.22, 0.1);
    for (const xSide of [-0.82, 0.82]) {
      const hl = new THREE.Mesh(hlGeo, sharedHeadLightMat);
      hl.position.set(xSide, 0.85, 4.31);
      group.add(hl);
    }
    const tlGeo = new THREE.BoxGeometry(2.15, 0.24, 0.12);
    const tl = new THREE.Mesh(tlGeo, sharedTailLightMat);
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
    const cabinMesh = new THREE.Mesh(cabinGeo, sharedGlassMat);
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
      const beaconMesh = new THREE.Mesh(beaconGeo, sharedAmberMarkerMat);
      beaconMesh.position.set(0, 0.34 + hullH + cabinH + 0.04, 0.1);
      group.add(beaconMesh);
    }

    // 4 wheels
    const zWheel = len * 0.31;
    const xWheel = wid * 0.48;
    for (const zPos of [zWheel, -zWheel]) {
      for (const xSide of [-xWheel, xWheel]) {
        const w = new THREE.Mesh(sharedCarWheelGeo, sharedWheelMat);
        w.position.set(xSide, 0.34, zPos);
        group.add(w);
      }
    }

    // Headlights & bright rear tail-light strip
    const hlGeo = new THREE.BoxGeometry(0.36, 0.15, 0.1);
    for (const xSide of [-wid * 0.32, wid * 0.32]) {
      const hl = new THREE.Mesh(hlGeo, sharedHeadLightMat);
      hl.position.set(xSide, 0.62, len * 0.5 + 0.01);
      group.add(hl);
    }
    const tlGeo = new THREE.BoxGeometry(wid * 0.84, 0.16, 0.1);
    const tl = new THREE.Mesh(tlGeo, sharedTailLightMat);
    tl.position.set(0, 0.66, -len * 0.5 - 0.01);
    group.add(tl);
  }

  return group;
}
