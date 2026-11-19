import React, { useState } from 'react';
import { soundEngine } from '../game/audio';
import { RIVAL_DIFFICULTY_CATALOG } from '../game/physics';
import { TRACK_CATALOG } from '../game/track';
import {
  CHASSIS_CATALOG,
  computeCarStats,
  computeDynoCurve,
  PAINT_SWATCHES,
  PRESET_BUILDS,
  UNDERGLOW_SWATCHES,
  UPGRADE_PRICES,
  UPGRADE_STAGE_NAMES,
} from '../game/tuning';
import {
  BodyKitType,
  CameraPreset,
  CarConfig,
  ChassisId,
  PaintFinish,
  RimStyle,
  RivalDifficulty,
  SpoilerType,
  TrackId,
  VinylStyle,
} from '../game/types';

interface TitleAndGarageOverlayProps {
  carConfig: CarConfig;
  onChangeCarConfig: (updater: (prev: CarConfig) => CarConfig) => void;
  trackId: TrackId;
  onSelectTrack: (id: TrackId) => void;
  rivalDifficulty: RivalDifficulty;
  onSelectDifficulty: (diff: RivalDifficulty) => void;
  garageCameraPreset: CameraPreset;
  onSelectCameraPreset: (preset: CameraPreset) => void;
  playerCash: number;
  onSpendCash: (amount: number) => boolean;
  isMuted: boolean;
  onToggleMute: () => void;
  onStartRace: () => void;
}

type WorkshopTab = 'chassis' | 'aero' | 'paint' | 'performance' | 'dyno';

export const TitleAndGarageOverlay: React.FC<TitleAndGarageOverlayProps> = ({
  carConfig,
  onChangeCarConfig,
  trackId,
  onSelectTrack,
  rivalDifficulty,
  onSelectDifficulty,
  garageCameraPreset,
  onSelectCameraPreset,
  playerCash,
  onSpendCash,
  isMuted,
  onToggleMute,
  onStartRace,
}) => {
  const [activeTab, setActiveTab] = useState<WorkshopTab>('chassis');
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const stats = computeCarStats(carConfig);
  const chassisSpec = CHASSIS_CATALOG[carConfig.chassis];
  const selectedTrack = TRACK_CATALOG[trackId];
  const diffSpec = RIVAL_DIFFICULTY_CATALOG[rivalDifficulty];
  const scaledPrize = Math.round(selectedTrack.prizeFirst * diffSpec.prizeMultiplier);
  const dynoPoints = computeDynoCurve(carConfig);

  const maxStage = Math.max(
    carConfig.engineStage,
    carConfig.turboStage,
    carConfig.transmissionStage,
    carConfig.suspensionStage,
    carConfig.tiresStage,
    carConfig.nitrousStage,
  );

  const triggerWrenchAndUpdate = (
    updater: (prev: CarConfig) => CarConfig,
    camPreset?: CameraPreset,
  ) => {
    soundEngine.playGarageWrench();
    onChangeCarConfig(updater);
    if (camPreset) {
      onSelectCameraPreset(camPreset);
    }
  };

  const triggerGarageNitrousPurge = () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', bubbles: true }),
    );
    setTimeout(() => {
      window.dispatchEvent(
        new KeyboardEvent('keyup', { code: 'Space', bubbles: true }),
      );
    }, 150);
  };

  const handleTabChange = (tab: WorkshopTab) => {
    setActiveTab(tab);
    if (tab === 'chassis' || tab === 'paint') onSelectCameraPreset('overview');
    if (tab === 'aero') onSelectCameraPreset('rear');
    if (tab === 'performance' || tab === 'dyno') onSelectCameraPreset('dyno');
  };

  const handleUpgradeStage = (
    key:
      | 'engineStage'
      | 'turboStage'
      | 'transmissionStage'
      | 'suspensionStage'
      | 'tiresStage'
      | 'nitrousStage',
    targetStage: number,
  ) => {
    const currentStage = carConfig[key];
    if (targetStage === currentStage) return;

    if (targetStage > currentStage) {
      const cost = UPGRADE_PRICES[targetStage] - UPGRADE_PRICES[currentStage];
      if (!onSpendCash(cost)) {
        setStatusNotice(`Need $${cost.toLocaleString()} for ${UPGRADE_STAGE_NAMES[targetStage]}`);
        setTimeout(() => setStatusNotice(null), 2400);
        return;
      }
    }
    setStatusNotice(null);
    triggerWrenchAndUpdate((prev) => ({ ...prev, [key]: targetStage }), 'dyno');
  };

  const buildDynoSvgPaths = () => {
    const w = 320;
    const h = 104;
    const maxVal = Math.max(850, stats.hp + 80, stats.torqueNm + 80);
    const hpCoords = dynoPoints.map((pt, i) => {
      const x = 24 + (i / (dynoPoints.length - 1)) * (w - 36);
      const y = h - 18 - (pt.hp / maxVal) * (h - 26);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const tqCoords = dynoPoints.map((pt, i) => {
      const x = 24 + (i / (dynoPoints.length - 1)) * (w - 36);
      const y = h - 18 - (pt.torqueNm / maxVal) * (h - 26);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { hpPath: hpCoords.join(' '), tqPath: tqCoords.join(' ') };
  };

  const { hpPath, tqPath } = buildDynoSvgPaths();

  const defaultChassisStyles: Record<ChassisId, Partial<CarConfig>> = {
    rx7: {
      chassis: 'rx7',
      paintColor: '#facc15',
      pearlColor: '#fde047',
      paintFinish: 'metallic',
      vinylStyle: 'none',
      vinylColor: '#0f172a',
      underglowColor: '#f59e0b',
      spoiler: 'gt_wing',
      rimStyle: 'te37',
      rimColor: '#f8fafc',
      bodyKit: 'street',
    },
    r34: {
      chassis: 'r34',
      paintColor: '#1d4ed8',
      pearlColor: '#06b6d4',
      paintFinish: 'metallic',
      vinylStyle: 'twin_stripes',
      vinylColor: '#f8fafc',
      underglowColor: '#06b6d4',
      spoiler: 'twin_deck',
      rimStyle: 'bbs',
    },
    supra: {
      chassis: 'supra',
      paintColor: '#7c3aed',
      pearlColor: '#10b981',
      paintFinish: 'pearlescent',
      vinylStyle: 'carbon_hood',
      vinylColor: '#0f172a',
      underglowColor: '#a855f7',
      spoiler: 'gt_wing',
      rimStyle: 'aero',
    },
  };

  const renderCameraModeStrip = () => (
    <div className="border-t border-[rgba(241,241,241,0.12)] pt-2 mt-2 flex flex-wrap items-center justify-between gap-2 min-w-0">
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        <span className="v2-label mr-1">Camera Mode:</span>
        {(
          [
            { id: 'overview', label: 'Orbit' },
            { id: 'front', label: 'Front' },
            { id: 'rear', label: 'Rear' },
            { id: 'wheels', label: 'Stance' },
            { id: 'dyno', label: 'Dyno' },
          ] as Array<{ id: CameraPreset; label: string }>
        ).map((cam) => (
          <button
            key={cam.id}
            type="button"
            onClick={() => onSelectCameraPreset(cam.id)}
            className={`v2-btn !py-1 !px-2 !text-[10px] ${
              garageCameraPreset === cam.id ? 'v2-btn-active' : ''
            }`}
          >
            {cam.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono-num text-[rgba(241,241,241,0.65)] min-w-0">
        <span className="text-[#ff4d00] font-bold">
          {carConfig.driftBias >= 0.65
            ? 'TOUGE DRIFT'
            : carConfig.driftBias <= 0.42
              ? 'TRACK GRIP'
              : 'STREET SPEC'}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Shift {Math.round(Math.max(35, 140 - carConfig.transmissionStage * 35))}ms
        </span>
        <span aria-hidden="true">·</span>
        <span>
          N2O +{Math.round((4.8 + carConfig.nitrousStage * 1.65) * carConfig.nitrousFlowRate * 3.6)} km/h
        </span>
        <span aria-hidden="true">·</span>
        <span>{stats.weightKg} KG</span>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-10 pointer-events-none flex flex-col justify-between overflow-hidden">
      {/* ROW 1: HEADER + TOP HUD CONTAINER */}
      <div className="flex flex-col gap-2.5 shrink-0">
        <header className="px-5 pt-4 pb-0.5 flex flex-wrap justify-between items-start gap-3 z-10">
          <div className="pointer-events-auto hud-text-shadow min-w-0">
            <h1 className="font-['Chakra_Petch'] font-bold text-2xl sm:text-3xl leading-none tracking-tight uppercase text-[#f1f1f1] mb-1 truncate">
              ARC STREETRACING
            </h1>
            <div className="font-mono-num text-[11px] text-[#ff4d00] font-bold tracking-[0.12em] uppercase truncate">
              ONLINE HIGHWAY SURVIVAL • ARC TESTNET
            </div>
          </div>

          <div className="pointer-events-auto flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                triggerGarageNitrousPurge();
              }}
              aria-label="Purge N2O Nitrous Jets"
              className="v2-btn"
            >
              N2O Purge
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                onToggleMute();
              }}
              aria-label={isMuted ? 'Unmute Audio' : 'Mute Audio'}
              className="v2-btn"
            >
              {isMuted ? 'Audio: Off' : 'Audio: On'}
            </button>
          </div>
        </header>

        {/* Top HUD Area: Left Vehicle Configuration | Center Open 3D Viewport | Right Session Status */}
        <div className="grid grid-cols-1 lg:grid-cols-[310px_1fr_310px] xl:grid-cols-[340px_1fr_340px] gap-4 px-5 z-10 items-start">
          {/* Left Panel: Vehicle Configuration */}
          <div className="pointer-events-auto v2-panel">
            <div className="v2-label">Vehicle Configuration</div>
            <div className="text-base font-bold text-[#f1f1f1] mt-0.5 truncate">
              {chassisSpec.name}
            </div>
            <div className="v2-label !text-[9px] mb-2">
              {chassisSpec.drivetrain} · {chassisSpec.codename} · STAGE {maxStage}
            </div>

            <div className="v2-stats-grid">
              <div className="v2-stat-cell">
                <span className="v2-label">Power</span>
                <span className="v2-stat-value" data-testid="stat-hp">
                  <span>{stats.hp}</span>
                  <span className="v2-stat-unit">HP</span>
                </span>
              </div>
              <div className="v2-stat-cell">
                <span className="v2-label">Torque</span>
                <span className="v2-stat-value">
                  <span>{stats.torqueNm}</span>
                  <span className="v2-stat-unit">NM</span>
                </span>
              </div>
              <div className="v2-stat-cell">
                <span className="v2-label">Top Speed</span>
                <span className="v2-stat-value">
                  <span>{stats.topSpeedKmh}</span>
                  <span className="v2-stat-unit">KM/H</span>
                </span>
              </div>
              <div className="v2-stat-cell">
                <span className="v2-label">0-100</span>
                <span className="v2-stat-value">
                  <span>{stats.accel0to100Sec}</span>
                  <span className="v2-stat-unit">SEC</span>
                </span>
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] font-mono-num text-[rgba(241,241,241,0.75)]">
              <div className="truncate">
                GRIP: <span className="text-[#f1f1f1] font-bold">{stats.gripScore}</span>
              </div>
              <div className="text-right truncate">
                DRIFT: <span className="text-[#f1f1f1] font-bold">{stats.driftControlScore}</span>
              </div>
            </div>

            {statusNotice && (
              <div className="mt-1.5 text-[11px] font-mono-num text-[#ff4d00] font-bold truncate">
                {statusNotice}
              </div>
            )}
          </div>

          {/* Center Spacer for Unobstructed 3D Car Turntable */}
          <div className="hidden lg:block" />

          {/* Right Panel: Session Status & Active Circuit */}
          <div className="pointer-events-auto v2-panel">
            <div className="v2-label">Session Status</div>
            <div className="grid grid-cols-2 gap-2 items-baseline my-2">
              <div className="min-w-0">
                <span className="v2-label">Bank</span>
                <div
                  className="text-lg xl:text-xl font-extrabold text-[#4ade80] font-mono-num truncate"
                  data-testid="player-cash"
                >
                  ${playerCash.toLocaleString()}
                </div>
              </div>
              <div className="text-right min-w-0">
                <span className="v2-label">Reputation</span>
                <div
                  className="text-lg xl:text-xl font-extrabold text-[#22d3ee] font-mono-num truncate"
                  data-testid="style-rep"
                >
                  {stats.styleReputationPoints} PTS
                </div>
              </div>
            </div>

            <div className="v2-label">Active Circuit</div>
            <div className="p-2 border border-[#ff4d00] mt-1 bg-[rgba(255,77,0,0.04)] min-w-0 overflow-hidden">
              <div className="text-xs font-bold text-[#f1f1f1] truncate">
                {selectedTrack.name}
              </div>
              <div
                className="text-[10px] font-mono-num text-[#ff4d00] mt-0.5 truncate"
                data-testid="circuit-prize"
              >
                1st Prize: ${scaledPrize.toLocaleString()} · {selectedTrack.laps} Laps
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1.5 mt-2">
              {(Object.keys(TRACK_CATALOG) as TrackId[]).map((tKey) => {
                const t = TRACK_CATALOG[tKey];
                const active = tKey === trackId;
                return (
                  <button
                    key={tKey}
                    type="button"
                    onClick={() => onSelectTrack(tKey)}
                    className={`v2-btn !py-1.5 !px-1.5 !text-[10px] !tracking-[0.04em] ${
                      active ? 'v2-btn-active' : ''
                    }`}
                  >
                    {t.name.split(' ')[0]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ROW 3: BOTTOM WORKSHOP DOCK + FOOTER METADATA STRIP */}
      <div className="flex flex-col z-10 shrink-0">
        <div className="px-5 pb-2">
          {/* Workshop Navigation Tabs + Collapse Toggle */}
          <div className="pointer-events-auto v2-nav-tabs">
            <div className="flex items-center overflow-x-auto min-w-0">
              {(
                [
                  { id: 'chassis', label: '01. Garage' },
                  { id: 'aero', label: '02. Body' },
                  { id: 'paint', label: '03. Paint' },
                  { id: 'performance', label: '04. Performance' },
                  { id: 'dyno', label: '05. Dyno' },
                ] as Array<{ id: WorkshopTab; label: string }>
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setDockCollapsed(false);
                    handleTabChange(t.id);
                  }}
                  className={`v2-tab-btn ${
                    activeTab === t.id && !dockCollapsed ? 'active' : ''
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setDockCollapsed((prev) => !prev)}
              className="v2-tab-btn !text-[10px] shrink-0"
            >
              {dockCollapsed ? '+ Expand Dock' : '— Collapse Dock'}
            </button>
          </div>

          {!dockCollapsed && (
            <div
              className="pointer-events-auto grid grid-cols-1 lg:grid-cols-[210px_1fr_250px] xl:grid-cols-[235px_1fr_285px] gap-3 items-stretch"
              role="region"
              aria-label="Underground Tuning Workshop"
            >
              {/* COLUMN 1: CHASSIS SELECTOR */}
              <div className="flex flex-col gap-1.5 justify-between min-w-0">
                {(Object.keys(CHASSIS_CATALOG) as ChassisId[]).map((cid) => {
                  const cSpec = CHASSIS_CATALOG[cid];
                  const selected = carConfig.chassis === cid;
                  return (
                    <button
                      key={cid}
                      type="button"
                      data-testid={`select-chassis-${cid}`}
                      onClick={() => {
                        triggerWrenchAndUpdate(
                          (prev) => ({
                            ...prev,
                            ...defaultChassisStyles[cid],
                          }),
                          'overview',
                        );
                        triggerGarageNitrousPurge();
                      }}
                      className={`v2-car-card flex-1 justify-center ${
                        selected ? 'active' : ''
                      }`}
                    >
                      <span className="v2-label">
                        {selected ? 'Active Chassis' : 'Available'}
                      </span>
                      <div
                        className={`text-xs font-bold truncate ${
                          selected
                            ? 'text-[#f1f1f1]'
                            : 'text-[rgba(241,241,241,0.55)]'
                        }`}
                      >
                        {cSpec.name}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* COLUMN 2: ACTIVE TAB WORKSPACE PANEL */}
              <div className="v2-panel flex flex-col justify-between min-w-0">
                {/* TAB 01: GARAGE SPEC PRESETS */}
                {activeTab === 'chassis' && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 min-w-0">
                    {PRESET_BUILDS.map((preset, idx) => {
                      const specLetter = String.fromCharCode(65 + idx);
                      const specProgress = idx === 0 ? 70 : idx === 1 ? 58 : 92;
                      return (
                        <button
                          key={preset.name}
                          type="button"
                          onClick={() =>
                            triggerWrenchAndUpdate(
                              (prev) => ({ ...prev, ...preset.config }),
                              'overview',
                            )
                          }
                          className="v2-car-card justify-between min-w-0"
                        >
                          <div className="min-w-0 w-full">
                            <span className="v2-label">Spec {specLetter}</span>
                            <div className="text-xs font-bold text-[#f1f1f1] my-0.5 truncate">
                              {preset.name}
                            </div>
                            <div className="text-[10px] font-mono-num text-[rgba(241,241,241,0.55)] truncate">
                              {preset.tag}
                            </div>
                          </div>
                          <div className="v2-bar-bg">
                            <div
                              className="v2-bar-fill"
                              style={{ width: `${specProgress}%` }}
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* TAB 02: BODY KIT, SPOILER, RIMS & STANCE */}
                {activeTab === 'aero' && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 min-w-0">
                    <div className="min-w-0">
                      <div className="v2-label mb-1">Aero Body Kit</div>
                      <div className="flex flex-col gap-1">
                        {(
                          [
                            { id: 'stock', label: 'Stock OEM Body' },
                            { id: 'street', label: 'Street Splitter' },
                            { id: 'widebody', label: 'Widebody Kit' },
                          ] as Array<{ id: BodyKitType; label: string }>
                        ).map((bk) => (
                          <button
                            key={bk.id}
                            type="button"
                            onClick={() =>
                              triggerWrenchAndUpdate(
                                (prev) => ({ ...prev, bodyKit: bk.id }),
                                'front',
                              )
                            }
                            className={`v2-btn !py-1 !px-2 !text-[10px] text-left ${
                              carConfig.bodyKit === bk.id ? 'v2-btn-active' : ''
                            }`}
                          >
                            {bk.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <div className="v2-label mb-1">Rear Wing</div>
                      <div className="grid grid-cols-2 gap-1">
                        {(
                          [
                            { id: 'none', label: 'Wingless' },
                            { id: 'ducktail', label: 'Ducktail' },
                            { id: 'gt_wing', label: 'GT Carbon' },
                            { id: 'twin_deck', label: 'Twin-Deck' },
                          ] as Array<{ id: SpoilerType; label: string }>
                        ).map((sp) => (
                          <button
                            key={sp.id}
                            type="button"
                            onClick={() =>
                              triggerWrenchAndUpdate(
                                (prev) => ({ ...prev, spoiler: sp.id }),
                                'rear',
                              )
                            }
                            className={`v2-btn !py-1 !px-1.5 !text-[10px] ${
                              carConfig.spoiler === sp.id ? 'v2-btn-active' : ''
                            }`}
                          >
                            {sp.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <div className="v2-label mb-1">Forged Rims</div>
                      <div className="flex flex-col gap-1">
                        {(
                          [
                            { id: 'te37', label: 'Rays 6-Spoke' },
                            { id: 'bbs', label: 'Mesh 10-Spoke' },
                            { id: 'aero', label: 'Turbofan Aero' },
                          ] as Array<{ id: RimStyle; label: string }>
                        ).map((rm) => (
                          <button
                            key={rm.id}
                            type="button"
                            onClick={() =>
                              triggerWrenchAndUpdate(
                                (prev) => ({ ...prev, rimStyle: rm.id }),
                                'wheels',
                              )
                            }
                            className={`v2-btn !py-1 !px-2 !text-[10px] text-left ${
                              carConfig.rimStyle === rm.id ? 'v2-btn-active' : ''
                            }`}
                          >
                            {rm.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-col justify-between gap-1.5 min-w-0">
                      <div>
                        <label
                          htmlFor="camber-slider"
                          className="flex justify-between items-center text-[10px] font-mono-num text-[#f1f1f1] mb-0.5 gap-1"
                        >
                          <span className="v2-label">Camber</span>
                          <span className="text-[#ff4d00] shrink-0">
                            -{carConfig.camberAngle.toFixed(1)}°
                          </span>
                        </label>
                        <input
                          id="camber-slider"
                          type="range"
                          min="0"
                          max="9"
                          step="0.5"
                          value={carConfig.camberAngle}
                          onChange={(e) =>
                            triggerWrenchAndUpdate(
                              (prev) => ({
                                ...prev,
                                camberAngle: parseFloat(e.target.value),
                              }),
                              'wheels',
                            )
                          }
                          className="w-full accent-[#ff4d00]"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="ride-height-slider"
                          className="flex justify-between items-center text-[10px] font-mono-num text-[#f1f1f1] mb-0.5 gap-1"
                        >
                          <span className="v2-label">Ride Drop</span>
                          <span className="text-[#22d3ee] shrink-0">
                            {Math.round(carConfig.rideHeight * 1000)} mm
                          </span>
                        </label>
                        <input
                          id="ride-height-slider"
                          type="range"
                          min="-0.07"
                          max="0.02"
                          step="0.01"
                          value={carConfig.rideHeight}
                          onChange={(e) =>
                            triggerWrenchAndUpdate(
                              (prev) => ({
                                ...prev,
                                rideHeight: parseFloat(e.target.value),
                              }),
                              'wheels',
                            )
                          }
                          className="w-full accent-[#ff4d00]"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 03: PAINT, VINYL & NEON */}
                {activeTab === 'paint' && (
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center min-w-0">
                    <div className="md:col-span-5 min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-1 mb-1.5">
                        <span className="v2-label">Paint Finish</span>
                        <div className="flex flex-wrap gap-1">
                          {(
                            ['metallic', 'matte', 'pearlescent', 'chrome'] as PaintFinish[]
                          ).map((fin) => (
                            <button
                              key={fin}
                              type="button"
                              onClick={() =>
                                triggerWrenchAndUpdate((prev) => ({
                                  ...prev,
                                  paintFinish: fin,
                                }))
                              }
                              className={`v2-btn !py-0.5 !px-1.5 !text-[9px] ${
                                carConfig.paintFinish === fin
                                  ? 'v2-btn-active'
                                  : ''
                              }`}
                            >
                              {fin}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {PAINT_SWATCHES.map((sw) => (
                          <button
                            key={sw.hex}
                            type="button"
                            aria-label={`Paint ${sw.name}`}
                            onClick={() =>
                              triggerWrenchAndUpdate((prev) => ({
                                ...prev,
                                paintColor: sw.hex,
                              }))
                            }
                            className={`w-6 h-6 border transition-transform ${
                              carConfig.paintColor === sw.hex
                                ? 'border-[#ff4d00] scale-110'
                                : 'border-[rgba(241,241,241,0.25)]'
                            }`}
                            style={{ backgroundColor: sw.hex }}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="md:col-span-4 min-w-0">
                      <div className="v2-label mb-1">Vinyl Livery</div>
                      <div className="grid grid-cols-2 gap-1">
                        {(
                          [
                            { id: 'none', label: 'Clean Paint' },
                            { id: 'twin_stripes', label: 'Twin Stripes' },
                            { id: 'side_slash', label: 'Tribal Slash' },
                            { id: 'carbon_hood', label: 'Carbon Hood' },
                          ] as Array<{ id: VinylStyle; label: string }>
                        ).map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() =>
                              triggerWrenchAndUpdate((prev) => ({
                                ...prev,
                                vinylStyle: v.id,
                              }))
                            }
                            className={`v2-btn !py-1 !px-1.5 !text-[10px] ${
                              carConfig.vinylStyle === v.id
                                ? 'v2-btn-active'
                                : ''
                            }`}
                          >
                            {v.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="md:col-span-3 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="v2-label">Underglow</span>
                        <button
                          type="button"
                          onClick={() =>
                            triggerWrenchAndUpdate((prev) => ({
                              ...prev,
                              underglowEnabled: !prev.underglowEnabled,
                            }))
                          }
                          className={`v2-btn !py-0.5 !px-2 !text-[9px] ${
                            carConfig.underglowEnabled ? 'v2-btn-active' : ''
                          }`}
                        >
                          {carConfig.underglowEnabled ? 'ON' : 'OFF'}
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {UNDERGLOW_SWATCHES.map((ug) => (
                          <button
                            key={ug.hex}
                            type="button"
                            aria-label={`Underglow ${ug.name}`}
                            onClick={() =>
                              triggerWrenchAndUpdate((prev) => ({
                                ...prev,
                                underglowColor: ug.hex,
                                underglowEnabled: true,
                              }))
                            }
                            className={`w-6 h-6 border transition-transform ${
                              carConfig.underglowColor === ug.hex &&
                              carConfig.underglowEnabled
                                ? 'border-white scale-110'
                                : 'border-[rgba(241,241,241,0.2)]'
                            }`}
                            style={{ backgroundColor: ug.hex }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 04: PERFORMANCE STAGE UPGRADES */}
                {activeTab === 'performance' && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2 min-w-0">
                    {(
                      [
                        { key: 'engineStage', label: 'Engine Block & ECU' },
                        { key: 'turboStage', label: 'Twin-Scroll Turbo' },
                        { key: 'transmissionStage', label: '6-Speed Gearbox' },
                        { key: 'suspensionStage', label: 'Track Coilovers' },
                        { key: 'tiresStage', label: 'Semi-Slick Tires' },
                        { key: 'nitrousStage', label: 'Direct-Port N2O' },
                      ] as const
                    ).map((item) => {
                      const stageVal = carConfig[item.key];
                      return (
                        <div
                          key={item.key}
                          className="p-2 border border-[rgba(241,241,241,0.12)] bg-[rgba(255,255,255,0.02)] flex flex-col justify-between min-w-0 overflow-hidden"
                        >
                          <div className="min-w-0">
                            <div className="text-[11px] font-bold text-[#f1f1f1] truncate">
                              {item.label}
                            </div>
                            <div className="v2-label !text-[9px] !text-[#ff4d00] mt-0.5">
                              STAGE {stageVal} / 3
                            </div>
                          </div>

                          <div className="grid grid-cols-4 gap-1 mt-1.5">
                            {[0, 1, 2, 3].map((st) => (
                              <button
                                key={st}
                                type="button"
                                aria-label={`${item.label} Stage ${st}`}
                                onClick={() => handleUpgradeStage(item.key, st)}
                                className={`py-1 px-0.5 text-[10px] font-mono-num font-bold border transition-colors min-w-0 ${
                                  stageVal === st
                                    ? 'bg-[#ff4d00] text-[#0b0c0f] border-[#ff4d00]'
                                    : st < stageVal
                                      ? 'bg-[rgba(255,77,0,0.18)] text-[#ff4d00] border-[rgba(255,77,0,0.45)]'
                                      : 'bg-transparent text-[rgba(241,241,241,0.6)] border-[rgba(241,241,241,0.12)] hover:border-[#ff4d00]'
                                }`}
                              >
                                S{st}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* TAB 05: DYNO GRAPH & CALIBRATION */}
                {activeTab === 'dyno' && (
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center min-w-0">
                    <div className="md:col-span-5 border border-[rgba(241,241,241,0.12)] bg-[#0b0c0f] p-2 min-w-0 overflow-hidden">
                      <div className="flex items-center justify-between text-[10px] font-mono-num mb-1 gap-2">
                        <span className="text-[#ff4d00] font-bold truncate">
                          PEAK: {stats.hp} HP
                        </span>
                        <span className="text-[#22d3ee] font-bold truncate">
                          TORQUE: {stats.torqueNm} NM
                        </span>
                      </div>
                      <svg
                        viewBox="0 0 320 104"
                        className="w-full h-20 overflow-hidden"
                        aria-label="Dynamometer Horsepower and Torque Curve"
                      >
                        <line x1="24" y1="14" x2="308" y2="14" stroke="rgba(241,241,241,0.08)" strokeWidth="1" />
                        <line x1="24" y1="50" x2="308" y2="50" stroke="rgba(241,241,241,0.08)" strokeWidth="1" />
                        <line x1="24" y1="86" x2="308" y2="86" stroke="rgba(241,241,241,0.2)" strokeWidth="1" />
                        <path d={tqPath} fill="none" stroke="#22d3ee" strokeWidth="2.4" />
                        <path d={hpPath} fill="none" stroke="#ff4d00" strokeWidth="2.4" />
                        <text x="24" y="100" fill="rgba(241,241,241,0.5)" fontSize="8" fontFamily="Space Mono">
                          1500 RPM
                        </text>
                        <text x="242" y="100" fill="#ff4d00" fontSize="8" fontFamily="Space Mono">
                          {stats.redlineRpm} RPM
                        </text>
                      </svg>
                    </div>

                    <div className="md:col-span-7 grid grid-cols-2 gap-x-3 gap-y-1.5 min-w-0">
                      <div className="min-w-0">
                        <label
                          htmlFor="final-drive-slider"
                          className="flex justify-between items-center text-[10px] font-mono-num mb-0.5 gap-1"
                        >
                          <span className="v2-label">Final Drive</span>
                          <span className="text-[#ff4d00] shrink-0">
                            {carConfig.finalDriveRatio.toFixed(2)}:1
                          </span>
                        </label>
                        <input
                          id="final-drive-slider"
                          type="range"
                          min="3.3"
                          max="4.7"
                          step="0.05"
                          value={carConfig.finalDriveRatio}
                          onChange={(e) =>
                            onChangeCarConfig((prev) => ({
                              ...prev,
                              finalDriveRatio: parseFloat(e.target.value),
                            }))
                          }
                          className="w-full accent-[#ff4d00]"
                        />
                      </div>

                      <div className="min-w-0">
                        <label
                          htmlFor="drift-bias-slider"
                          className="flex justify-between items-center text-[10px] font-mono-num mb-0.5 gap-1"
                        >
                          <span className="v2-label">Drift Bias</span>
                          <span className="text-[#22d3ee] shrink-0">
                            {Math.round(carConfig.driftBias * 100)}%
                          </span>
                        </label>
                        <input
                          id="drift-bias-slider"
                          type="range"
                          min="0.25"
                          max="0.9"
                          step="0.05"
                          value={carConfig.driftBias}
                          onChange={(e) =>
                            onChangeCarConfig((prev) => ({
                              ...prev,
                              driftBias: parseFloat(e.target.value),
                            }))
                          }
                          className="w-full accent-[#ff4d00]"
                        />
                      </div>

                      <div className="min-w-0">
                        <label
                          htmlFor="aero-downforce-slider"
                          className="flex justify-between items-center text-[10px] font-mono-num mb-0.5 gap-1"
                        >
                          <span className="v2-label">Downforce</span>
                          <span className="text-[#4ade80] shrink-0">
                            {Math.round(carConfig.aeroDownforce * 100)}%
                          </span>
                        </label>
                        <input
                          id="aero-downforce-slider"
                          type="range"
                          min="0.3"
                          max="1.0"
                          step="0.05"
                          value={carConfig.aeroDownforce}
                          onChange={(e) =>
                            onChangeCarConfig((prev) => ({
                              ...prev,
                              aeroDownforce: parseFloat(e.target.value),
                            }))
                          }
                          className="w-full accent-[#ff4d00]"
                        />
                      </div>

                      <div className="min-w-0">
                        <label
                          htmlFor="nitrous-flow-slider"
                          className="flex justify-between items-center text-[10px] font-mono-num mb-0.5 gap-1"
                        >
                          <span className="v2-label">N2O Flow</span>
                          <span className="text-[#f1f1f1] shrink-0">
                            {Math.round(carConfig.nitrousFlowRate * 100)}%
                          </span>
                        </label>
                        <input
                          id="nitrous-flow-slider"
                          type="range"
                          min="0.6"
                          max="1.4"
                          step="0.05"
                          value={carConfig.nitrousFlowRate}
                          onChange={(e) =>
                            onChangeCarConfig((prev) => ({
                              ...prev,
                              nitrousFlowRate: parseFloat(e.target.value),
                            }))
                          }
                          className="w-full accent-[#ff4d00]"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {renderCameraModeStrip()}
              </div>

              {/* COLUMN 3: ENGAGE RACE CTA + DIFFICULTY SETTINGS */}
              <div className="flex flex-col justify-between gap-2.5 min-w-0">
                <button
                  type="button"
                  data-start="true"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onStartRace();
                  }}
                  className="v2-start-btn"
                >
                  ENGAGE RACE [ENTER]
                </button>

                <div className="v2-panel flex-1 flex flex-col justify-between">
                  <div className="min-w-0">
                    <div className="v2-label">Difficulty Settings</div>
                    <div
                      className="text-xs font-mono-num text-[#f1f1f1] my-1 truncate"
                      data-testid="ai-difficulty-stats"
                    >
                      Speed {Math.round(diffSpec.speedMultiplier * 100)}% · Aggr{' '}
                      {Math.round(diffSpec.aggression * 100)}%
                    </div>
                  </div>

                  <div
                    className="grid grid-cols-3 gap-1.5"
                    role="group"
                    aria-label="AI Rival Difficulty"
                  >
                    {(
                      Object.keys(RIVAL_DIFFICULTY_CATALOG) as RivalDifficulty[]
                    ).map((diffKey) => {
                      const d = RIVAL_DIFFICULTY_CATALOG[diffKey];
                      const isSelected = rivalDifficulty === diffKey;
                      const shortLabel =
                        diffKey === 'rookie'
                          ? 'Rookie'
                          : diffKey === 'pro'
                            ? 'Pro'
                            : 'King';
                      return (
                        <button
                          key={diffKey}
                          type="button"
                          aria-label={d.label}
                          onClick={() => onSelectDifficulty(diffKey)}
                          className={`v2-btn !py-1.5 !px-1.5 !text-[10px] !tracking-[0.04em] ${
                            isSelected
                              ? '!border-[#ff4d00] !text-[#ff4d00] font-bold'
                              : ''
                          }`}
                        >
                          {shortLabel}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* FOOTER METADATA STRIP */}
        <footer className="pointer-events-auto v2-metadata-strip">
          <span className="v2-label">WASD/Arrows Drive</span>
          <span className="v2-label">Space Drift</span>
          <span className="v2-label">Shift Nitrous</span>
          <span className="v2-label">C Camera</span>
          <span className="v2-label">P Pause</span>
        </footer>
      </div>
    </div>
  );
};
