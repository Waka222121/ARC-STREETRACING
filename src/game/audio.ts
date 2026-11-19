// Multi-Layered JDM 4G63T Inline-4 Turbo Car Audio Synthesizer
// Models crankshaft half-order pulse, 4-cylinder firing harmonics, dual exhaust manifold/muffler
// formants, intake induction roar, asphalt tire rolling texture, dog-box shift cut + wastegate flutter,
// lane-hop suspension takeoff/touchdown, traffic near-miss Doppler whoosh, and multi-stage collision crunch.

function createAsymmetricExhaustCurve(drive = 2.2): Float32Array<ArrayBuffer> {
  const samples = 2048;
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    // Asymmetric valve-pulse saturation: sharper positive compression peak, warm negative expansion tail
    if (x >= 0) {
      curve[i] = Math.tanh(x * drive * 1.25);
    } else {
      curve[i] = Math.tanh(x * drive * 0.85) * 0.92;
    }
  }
  return curve;
}

class UndergroundAudioEngine {
  private ctx: AudioContext | null = null;
  private isMuted = false;

  // 4G63T Inline-4 Multi-Harmonic Oscillators
  private subCamOsc: OscillatorNode | null = null; // 0.5x firing freq (crankshaft / cam lope throatiness)
  private firingOsc: OscillatorNode | null = null; // 1.0x primary 4-cylinder firing frequency (rpm / 30)
  private secondHarmonicOsc: OscillatorNode | null = null; // 2.0x exhaust pulse octave
  private thirdHarmonicOsc: OscillatorNode | null = null; // 3.0x high-RPM metallic JDM bark
  private jitterOsc: OscillatorNode | null = null;
  private jitterGain: GainNode | null = null;

  // Dynamic Harmonic Mix Gains
  private subCamGain: GainNode | null = null;
  private firingGain: GainNode | null = null;
  private secondHarmonicGain: GainNode | null = null;
  private thirdHarmonicGain: GainNode | null = null;

  // Exhaust Formant & Tone Shaping Chain
  private dcBlockHighpass: BiquadFilterNode | null = null;
  private mufflerBodyPeaking: BiquadFilterNode | null = null;
  private manifoldRaspyPeaking: BiquadFilterNode | null = null;
  private exhaustLowpass: BiquadFilterNode | null = null;
  private engineMasterGain: GainNode | null = null;

  // Intake Induction Air-Box & Road Rolling Layers
  private inductionFilter: BiquadFilterNode | null = null;
  private inductionGain: GainNode | null = null;
  private roadRollFilter: BiquadFilterNode | null = null;
  private roadRollGain: GainNode | null = null;

  // Tire Asphalt Scrub & N2O Combustion Rush
  private skidScrubFilter: BiquadFilterNode | null = null;
  private skidScrubGain: GainNode | null = null;
  private nitroGain: GainNode | null = null;

  private sharedPinkBuffer: AudioBuffer | null = null;
  private activeSources: AudioScheduledSourceNode[] = [];
  private isRunningLoop = false;
  private lastThrottle = 0;
  private lastPopTime = 0;
  private shiftCutUntilTime = 0;

  private ensureContext(): AudioContext | null {
    if (this.isMuted) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private getPinkNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.sharedPinkBuffer && this.sharedPinkBuffer.sampleRate === ctx.sampleRate) {
      return this.sharedPinkBuffer;
    }
    const bufferSize = Math.floor(ctx.sampleRate * 2.0);
    const pinkBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const pinkData = pinkBuffer.getChannelData(0);

    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      pinkData[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
      b6 = white * 0.115926;
    }
    this.sharedPinkBuffer = pinkBuffer;
    return pinkBuffer;
  }

  private createFourStrokeExhaustWave(ctx: AudioContext): PeriodicWave {
    // Rich 4-stroke exhaust blowdown harmonic spectrum (12 partials)
    const real = new Float32Array([
      0, 0.0, -0.28, -0.14, 0.09, -0.06, 0.04, -0.025, 0.018, -0.01, 0.006,
      -0.004, 0.002,
    ]);
    const imag = new Float32Array([
      0, 1.0, 0.82, 0.64, 0.46, 0.32, 0.22, 0.15, 0.10, 0.07, 0.045, 0.03,
      0.018,
    ]);
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  private createRaspyManifoldWave(ctx: AudioContext): PeriodicWave {
    // Upper-harmonic rich waveform for high-RPM JDM exhaust bark
    const real = new Float32Array([0, 0.0, 0.18, -0.24, 0.15, -0.1, 0.06, -0.04]);
    const imag = new Float32Array([0, 0.55, 0.95, 0.78, 0.62, 0.42, 0.28, 0.16]);
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted;
    if (muted) {
      this.stopDrivingLoop();
    }
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public startDrivingLoop() {
    const ctx = this.ensureContext();
    if (!ctx || this.isRunningLoop) return;

    try {
      this.activeSources = [];
      const exhaustWave = this.createFourStrokeExhaustWave(ctx);
      const raspyWave = this.createRaspyManifoldWave(ctx);
      const pinkBuffer = this.getPinkNoiseBuffer(ctx);

      // 1. Exhaust Acoustic Chain:
      // DC/Sub Highpass (58 Hz) -> Muffler Body Resonator (175 Hz) -> Asymmetric Tube Waveshaper
      // -> Manifold Bark Formant (780 Hz) -> Dynamic Lowpass -> Master Gain
      this.dcBlockHighpass = ctx.createBiquadFilter();
      this.dcBlockHighpass.type = 'highpass';
      this.dcBlockHighpass.frequency.value = 58;
      this.dcBlockHighpass.Q.value = 0.707;

      this.mufflerBodyPeaking = ctx.createBiquadFilter();
      this.mufflerBodyPeaking.type = 'peaking';
      this.mufflerBodyPeaking.frequency.value = 165;
      this.mufflerBodyPeaking.Q.value = 1.25;
      this.mufflerBodyPeaking.gain.value = 4.5;

      const waveshaper = ctx.createWaveShaper();
      waveshaper.curve = createAsymmetricExhaustCurve(2.35);
      waveshaper.oversample = '2x';

      this.manifoldRaspyPeaking = ctx.createBiquadFilter();
      this.manifoldRaspyPeaking.type = 'peaking';
      this.manifoldRaspyPeaking.frequency.value = 740;
      this.manifoldRaspyPeaking.Q.value = 1.4;
      this.manifoldRaspyPeaking.gain.value = 3.2;

      this.exhaustLowpass = ctx.createBiquadFilter();
      this.exhaustLowpass.type = 'lowpass';
      this.exhaustLowpass.frequency.value = 480;
      this.exhaustLowpass.Q.value = 0.82;

      this.engineMasterGain = ctx.createGain();
      this.engineMasterGain.gain.value = 0.001;

      this.dcBlockHighpass.connect(this.mufflerBodyPeaking);
      this.mufflerBodyPeaking.connect(waveshaper);
      waveshaper.connect(this.manifoldRaspyPeaking);
      this.manifoldRaspyPeaking.connect(this.exhaustLowpass);
      this.exhaustLowpass.connect(this.engineMasterGain);
      this.engineMasterGain.connect(ctx.destination);

      // 2a. Sub-Order Crankshaft / Camshaft Pulse (0.5x firing frequency)
      this.subCamOsc = ctx.createOscillator();
      this.subCamOsc.setPeriodicWave(exhaustWave);
      this.subCamOsc.frequency.value = 26;
      this.subCamGain = ctx.createGain();
      this.subCamGain.gain.value = 0.36;
      this.subCamOsc.connect(this.subCamGain);
      this.subCamGain.connect(this.dcBlockHighpass);

      // 2b. Primary 4-Cylinder Firing Pulse (1.0x firing frequency)
      this.firingOsc = ctx.createOscillator();
      this.firingOsc.setPeriodicWave(exhaustWave);
      this.firingOsc.frequency.value = 52;
      this.firingGain = ctx.createGain();
      this.firingGain.gain.value = 0.82;
      this.firingOsc.connect(this.firingGain);
      this.firingGain.connect(this.dcBlockHighpass);

      // 2c. 2nd Harmonic Exhaust Octave (2.0x firing frequency)
      this.secondHarmonicOsc = ctx.createOscillator();
      this.secondHarmonicOsc.setPeriodicWave(exhaustWave);
      this.secondHarmonicOsc.frequency.value = 104;
      this.secondHarmonicGain = ctx.createGain();
      this.secondHarmonicGain.gain.value = 0.42;
      this.secondHarmonicOsc.connect(this.secondHarmonicGain);
      this.secondHarmonicGain.connect(this.dcBlockHighpass);

      // 2d. 3rd Harmonic High-RPM JDM Bark (2.98x slightly detuned for natural twin-scroll phasing)
      this.thirdHarmonicOsc = ctx.createOscillator();
      this.thirdHarmonicOsc.setPeriodicWave(raspyWave);
      this.thirdHarmonicOsc.frequency.value = 155;
      this.thirdHarmonicGain = ctx.createGain();
      this.thirdHarmonicGain.gain.value = 0.14;
      this.thirdHarmonicOsc.connect(this.thirdHarmonicGain);
      this.thirdHarmonicGain.connect(this.dcBlockHighpass);

      // 3. Rotational Combustion Micro-Jitter LFO (prevents robotic static pitch)
      this.jitterOsc = ctx.createOscillator();
      this.jitterOsc.type = 'triangle';
      this.jitterOsc.frequency.value = 23;
      this.jitterGain = ctx.createGain();
      this.jitterGain.gain.value = 1.35;
      this.jitterOsc.connect(this.jitterGain);
      this.jitterGain.connect(this.firingOsc.frequency);
      this.jitterGain.connect(this.secondHarmonicOsc.frequency);

      this.subCamOsc.start();
      this.firingOsc.start();
      this.secondHarmonicOsc.start();
      this.thirdHarmonicOsc.start();
      this.jitterOsc.start();
      this.activeSources.push(
        this.subCamOsc,
        this.firingOsc,
        this.secondHarmonicOsc,
        this.thirdHarmonicOsc,
        this.jitterOsc,
      );

      // 4. Intake Air-Box Induction & Twin-Scroll Spool Air Rush (no sine whistle)
      const inductionSource = ctx.createBufferSource();
      inductionSource.buffer = pinkBuffer;
      inductionSource.loop = true;

      this.inductionFilter = ctx.createBiquadFilter();
      this.inductionFilter.type = 'bandpass';
      this.inductionFilter.frequency.value = 420;
      this.inductionFilter.Q.value = 1.15;

      this.inductionGain = ctx.createGain();
      this.inductionGain.gain.value = 0.001;

      inductionSource.connect(this.inductionFilter);
      this.inductionFilter.connect(this.inductionGain);
      this.inductionGain.connect(ctx.destination);
      inductionSource.start();
      this.activeSources.push(inductionSource);

      // 5. Highway Asphalt Rolling Texture (connects car weight to the road surface at speed)
      const roadSource = ctx.createBufferSource();
      roadSource.buffer = pinkBuffer;
      roadSource.loop = true;

      this.roadRollFilter = ctx.createBiquadFilter();
      this.roadRollFilter.type = 'bandpass';
      this.roadRollFilter.frequency.value = 145;
      this.roadRollFilter.Q.value = 0.85;

      this.roadRollGain = ctx.createGain();
      this.roadRollGain.gain.value = 0.001;

      roadSource.connect(this.roadRollFilter);
      this.roadRollFilter.connect(this.roadRollGain);
      this.roadRollGain.connect(ctx.destination);
      roadSource.start();
      this.activeSources.push(roadSource);

      // 6. Matte Rubber Tire Scrub (during drifts, hard lane-cut load, or wheelspin)
      const skidSource = ctx.createBufferSource();
      skidSource.buffer = pinkBuffer;
      skidSource.loop = true;

      this.skidScrubFilter = ctx.createBiquadFilter();
      this.skidScrubFilter.type = 'bandpass';
      this.skidScrubFilter.frequency.value = 580;
      this.skidScrubFilter.Q.value = 1.1;
      this.skidScrubGain = ctx.createGain();
      this.skidScrubGain.gain.value = 0;

      skidSource.connect(this.skidScrubFilter);
      this.skidScrubFilter.connect(this.skidScrubGain);
      this.skidScrubGain.connect(ctx.destination);
      skidSource.start();
      this.activeSources.push(skidSource);

      // 7. N2O Combustion Jet Rush
      const nitroSource = ctx.createBufferSource();
      nitroSource.buffer = pinkBuffer;
      nitroSource.loop = true;

      const nitroFilter = ctx.createBiquadFilter();
      nitroFilter.type = 'bandpass';
      nitroFilter.frequency.value = 640;
      nitroFilter.Q.value = 0.8;

      this.nitroGain = ctx.createGain();
      this.nitroGain.gain.value = 0;

      nitroSource.connect(nitroFilter);
      nitroFilter.connect(this.nitroGain);
      this.nitroGain.connect(ctx.destination);
      nitroSource.start();
      this.activeSources.push(nitroSource);

      this.isRunningLoop = true;
    } catch {
      // Ignore Web Audio restriction errors in headless environments
    }
  }

  public updateDrivingTelemetry(
    rpm: number,
    redlineRpm: number,
    isDrifting: boolean,
    isBoosting: boolean,
    speedKmh: number,
    throttle = 1,
    turboBoostBar = 0,
    wheelspinIntensity = 0,
  ) {
    if (this.isMuted || !this.ctx || !this.isRunningLoop) return;
    const now = this.ctx.currentTime;
    const rpmNorm = Math.max(0.1, Math.min(1.06, rpm / Math.max(4000, redlineRpm)));

    // Realistic 4-cylinder 4-stroke firing frequency:
    // 2 firing pulses per crank revolution -> f = (RPM / 60) * 2
    // Scaled with a muscular low-RPM floor (44 Hz idle -> 248 Hz at 8500 RPM redline)
    const firingFreq = 40 + Math.pow(rpmNorm, 1.08) * 208;

    // ECU Rev-Limiter Fuel Cut at Redline + Sequential Shift Cut
    const isAtLimiter = rpm >= redlineRpm * 0.968 && throttle > 0.5;
    const isInShiftCut = now < this.shiftCutUntilTime;
    const limiterCut = isInShiftCut
      ? 0.22
      : isAtLimiter
        ? Math.sin(now * 165) > -0.15
          ? 1.0
          : 0.18
        : 1.0;

    if (
      this.subCamOsc &&
      this.firingOsc &&
      this.secondHarmonicOsc &&
      this.thirdHarmonicOsc &&
      this.subCamGain &&
      this.firingGain &&
      this.secondHarmonicGain &&
      this.thirdHarmonicGain &&
      this.dcBlockHighpass &&
      this.mufflerBodyPeaking &&
      this.manifoldRaspyPeaking &&
      this.exhaustLowpass &&
      this.engineMasterGain
    ) {
      // Track all 4 engine harmonic layers smoothly with RPM
      this.subCamOsc.frequency.setTargetAtTime(firingFreq * 0.5, now, 0.02);
      this.firingOsc.frequency.setTargetAtTime(firingFreq, now, 0.02);
      this.secondHarmonicOsc.frequency.setTargetAtTime(
        firingFreq * 2.0,
        now,
        0.02,
      );
      this.thirdHarmonicOsc.frequency.setTargetAtTime(
        firingFreq * 2.985,
        now,
        0.02,
      );

      // Crossfade harmonic balance across the RPM band:
      // Low-to-mid RPM emphasizes deep sub-cam rumble & primary pulse;
      // High RPM (5000..8500) brings up the 2nd & 3rd harmonic JDM exhaust bark
      const highRpmFactor = Math.max(0, (rpmNorm - 0.38) / 0.62);
      this.subCamGain.gain.setTargetAtTime(
        0.42 * (1 - highRpmFactor * 0.35),
        now,
        0.03,
      );
      this.firingGain.gain.setTargetAtTime(0.84, now, 0.03);
      this.secondHarmonicGain.gain.setTargetAtTime(
        0.34 + highRpmFactor * 0.32,
        now,
        0.03,
      );
      this.thirdHarmonicGain.gain.setTargetAtTime(
        0.08 + Math.pow(highRpmFactor, 1.4) * 0.36 * (0.4 + throttle * 0.6),
        now,
        0.03,
      );

      // Track muffler & manifold formants slightly with RPM & throttle load
      this.dcBlockHighpass.frequency.setTargetAtTime(
        56 + rpmNorm * 34,
        now,
        0.04,
      );
      this.mufflerBodyPeaking.frequency.setTargetAtTime(
        145 + rpmNorm * 85,
        now,
        0.04,
      );
      this.manifoldRaspyPeaking.frequency.setTargetAtTime(
        580 + rpmNorm * 540,
        now,
        0.04,
      );
      this.manifoldRaspyPeaking.gain.setTargetAtTime(
        1.8 + throttle * 3.2 + highRpmFactor * 1.5,
        now,
        0.04,
      );

      // Open exhaust lowpass under throttle & boost (340 Hz coast -> 2150 Hz WOT redline)
      const loadFactor = 0.42 + throttle * 0.58;
      const boostOpen = Math.max(0, turboBoostBar) * 260;
      const filterCutoff =
        (340 + Math.pow(rpmNorm, 1.22) * 1550) * loadFactor + boostOpen;
      this.exhaustLowpass.frequency.setTargetAtTime(filterCutoff, now, 0.025);

      // Responsive volume envelope
      const baseIdleVol = speedKmh < 5 && throttle < 0.1 ? 0.016 : 0.026;
      const throttleVol = throttle * (0.024 + rpmNorm * 0.036);
      const targetVol = (baseIdleVol + throttleVol) * limiterCut;
      this.engineMasterGain.gain.setTargetAtTime(targetVol, now, 0.022);
    }

    // Intake Induction & Twin-Scroll Spool Air Rush (scales with throttle & positive turbo boost)
    if (this.inductionFilter && this.inductionGain) {
      const positiveBoost = Math.max(0, turboBoostBar);
      const inductionCutoff = 360 + rpmNorm * 480 + positiveBoost * 240;
      const inductionVol =
        throttle > 0.25
          ? (0.008 + positiveBoost * 0.018 + rpmNorm * 0.012) * throttle
          : 0.001;
      this.inductionFilter.frequency.setTargetAtTime(inductionCutoff, now, 0.04);
      this.inductionGain.gain.setTargetAtTime(inductionVol, now, 0.04);
    }

    // Highway Asphalt Rolling Rumble (scales smoothly with vehicle speed)
    if (this.roadRollFilter && this.roadRollGain) {
      const speedNorm = Math.min(1, Math.max(0, speedKmh / 270));
      this.roadRollFilter.frequency.setTargetAtTime(
        115 + speedNorm * 135,
        now,
        0.05,
      );
      this.roadRollGain.gain.setTargetAtTime(
        speedNorm * 0.022,
        now,
        0.05,
      );
    }

    // Off-throttle overrun exhaust burble & pop when lifting at high RPM
    if (
      this.lastThrottle > 0.5 &&
      throttle < 0.2 &&
      rpmNorm > 0.58 &&
      now - this.lastPopTime > 0.28
    ) {
      this.lastPopTime = now;
      this.playExhaustBackfirePop(0.7);
    }
    this.lastThrottle = throttle;

    // Matte rubber tire scrub during drifts or launch wheelspin
    if (this.skidScrubGain && this.skidScrubFilter) {
      const slipActive =
        (isDrifting && speedKmh > 35) || wheelspinIntensity > 0.4;
      const slipStrength = slipActive
        ? Math.min(1, Math.max(wheelspinIntensity, (speedKmh - 25) / 140))
        : 0;
      this.skidScrubFilter.frequency.setTargetAtTime(
        480 + Math.min(280, speedKmh * 1.45),
        now,
        0.04,
      );
      this.skidScrubGain.gain.setTargetAtTime(slipStrength * 0.036, now, 0.04);
    }

    if (this.nitroGain) {
      const targetNitro = isBoosting ? 0.04 : 0;
      this.nitroGain.gain.setTargetAtTime(targetNitro, now, 0.04);
    }
  }

  public stopDrivingLoop() {
    if (!this.ctx || !this.isRunningLoop) return;
    try {
      const now = this.ctx.currentTime;
      this.engineMasterGain?.gain.setTargetAtTime(0, now, 0.02);
      this.inductionGain?.gain.setTargetAtTime(0, now, 0.02);
      this.roadRollGain?.gain.setTargetAtTime(0, now, 0.02);
      this.skidScrubGain?.gain.setTargetAtTime(0, now, 0.02);
      this.nitroGain?.gain.setTargetAtTime(0, now, 0.02);
      for (const src of this.activeSources) {
        try {
          src.stop(now + 0.05);
        } catch {
          // Ignore already stopped
        }
      }
    } catch {
      // Ignore
    }
    this.activeSources = [];
    this.subCamOsc = null;
    this.firingOsc = null;
    this.secondHarmonicOsc = null;
    this.thirdHarmonicOsc = null;
    this.jitterOsc = null;
    this.isRunningLoop = false;
  }

  /**
   * Deep resonant JDM exhaust overrun pop / crackle on gearshifts and high-RPM deceleration
   */
  public playExhaustBackfirePop(intensity = 1.0) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const clamped = Math.min(1.3, Math.max(0.25, intensity));

      // 1. Low-frequency muffler pressure thump
      const thumpOsc = ctx.createOscillator();
      const thumpGain = ctx.createGain();
      thumpOsc.type = 'triangle';
      thumpOsc.frequency.setValueAtTime(135 + Math.random() * 28, now);
      thumpOsc.frequency.exponentialRampToValueAtTime(36, now + 0.085);

      const vol = 0.055 * clamped;
      thumpGain.gain.setValueAtTime(vol, now);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.095);

      thumpOsc.connect(thumpGain);
      thumpGain.connect(ctx.destination);
      thumpOsc.start(now);
      thumpOsc.stop(now + 0.1);

      // 2. Crisp unburnt-fuel tailpipe crack transient
      const pinkBuf = this.getPinkNoiseBuffer(ctx);
      const crackSrc = ctx.createBufferSource();
      crackSrc.buffer = pinkBuf;

      const crackFilter = ctx.createBiquadFilter();
      crackFilter.type = 'bandpass';
      crackFilter.frequency.setValueAtTime(620 + Math.random() * 180, now);
      crackFilter.Q.value = 1.2;

      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(0.04 * clamped, now);
      crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

      crackSrc.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(ctx.destination);
      crackSrc.start(now, Math.random() * 0.5, 0.06);
    } catch {
      // Ignore
    }
  }

  /**
   * Sequential dog-box ignition cut + twin-scroll wastegate/blow-off flutter + exhaust shift thump
   */
  public playTurboBlowOff() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      // Trigger brief 48ms sequential gearbox ignition torque cut on the engine loop
      this.shiftCutUntilTime = now + 0.048;

      const duration = 0.21;
      const sampleCount = Math.floor(ctx.sampleRate * duration);
      const noiseBuf = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);

      // Modulated compressor release envelope (subtle JDM flutter cadence without any pure-tone whistle)
      for (let i = 0; i < sampleCount; i++) {
        const t = i / ctx.sampleRate;
        const decay = Math.exp(-t * 14.5);
        const flutter = 0.72 + 0.28 * Math.sin(t * Math.PI * 2 * 34);
        data[i] = (Math.random() * 2 - 1) * decay * flutter;
      }

      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuf;

      const bovFilter = ctx.createBiquadFilter();
      bovFilter.type = 'bandpass';
      bovFilter.frequency.setValueAtTime(980, now);
      bovFilter.frequency.exponentialRampToValueAtTime(440, now + duration);
      bovFilter.Q.value = 0.95;

      const bovGain = ctx.createGain();
      bovGain.gain.setValueAtTime(0.045, now);
      bovGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      noiseSrc.connect(bovFilter);
      bovFilter.connect(bovGain);
      bovGain.connect(ctx.destination);
      noiseSrc.start(now);
      noiseSrc.stop(now + duration);

      this.playExhaustBackfirePop(0.85);
    } catch {
      // Ignore
    }
  }

  /**
   * Tactile lane-hop tire side-bite chirp on takeoff & suspension strut compression thud on landing
   */
  public playLaneHop(isLanding = false) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const pinkBuf = this.getPinkNoiseBuffer(ctx);

      if (!isLanding) {
        // Quick lateral tire side-bite scrub + suspension spring release
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(92, now);
        osc.frequency.exponentialRampToValueAtTime(148, now + 0.055);
        gain.gain.setValueAtTime(0.032, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.07);

        const tireSrc = ctx.createBufferSource();
        tireSrc.buffer = pinkBuf;
        const tireFilter = ctx.createBiquadFilter();
        tireFilter.type = 'bandpass';
        tireFilter.frequency.setValueAtTime(520, now);
        tireFilter.Q.value = 1.2;
        const tireGain = ctx.createGain();
        tireGain.gain.setValueAtTime(0.028, now);
        tireGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        tireSrc.connect(tireFilter);
        tireFilter.connect(tireGain);
        tireGain.connect(ctx.destination);
        tireSrc.start(now, Math.random() * 0.4, 0.065);
      } else {
        // Weighty tarmac tire touchdown thud + damper compression
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(108, now);
        osc.frequency.exponentialRampToValueAtTime(34, now + 0.09);
        gain.gain.setValueAtTime(0.052, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.11);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Aerodynamic Doppler air-shear whoosh when narrowly dodging a highway traffic car or truck
   */
  public playTrafficNearMiss(speedKmh = 180) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const duration = 0.22;
      const pinkBuf = this.getPinkNoiseBuffer(ctx);
      const src = ctx.createBufferSource();
      src.buffer = pinkBuf;

      const speedFactor = Math.min(1.4, Math.max(0.7, speedKmh / 180));
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(640 * speedFactor, now);
      filter.frequency.exponentialRampToValueAtTime(
        175 * speedFactor,
        now + duration,
      );
      filter.Q.value = 1.35;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.055 * speedFactor, now + 0.055);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      src.start(now, Math.random() * 0.5, duration + 0.02);
    } catch {
      // Ignore
    }
  }

  /**
   * Multi-layered vehicle collision: heavy chassis sub-thud + sheet-metal crunch + locked-tire skid
   */
  public playCollisionImpact(magnitude: number) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const clampedMag = Math.min(1.2, Math.max(0.25, magnitude));

      // 1. Heavy structural chassis kinetic punch
      const punchOsc = ctx.createOscillator();
      const punchGain = ctx.createGain();
      punchOsc.type = 'triangle';
      punchOsc.frequency.setValueAtTime(140 + Math.random() * 20, now);
      punchOsc.frequency.exponentialRampToValueAtTime(26, now + 0.24);

      const punchVol = Math.min(0.18, 0.06 + clampedMag * 0.11);
      punchGain.gain.setValueAtTime(punchVol, now);
      punchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

      punchOsc.connect(punchGain);
      punchGain.connect(ctx.destination);
      punchOsc.start(now);
      punchOsc.stop(now + 0.27);

      // 2. Crumpling bodywork & bumper crunch burst
      const crunchDuration = 0.28;
      const sampleCount = Math.floor(ctx.sampleRate * crunchDuration);
      const crunchBuf = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
      const data = crunchBuf.getChannelData(0);
      for (let i = 0; i < sampleCount; i++) {
        const t = i / ctx.sampleRate;
        const env = Math.exp(-t * 11.5) * (0.65 + 0.35 * Math.cos(t * 95));
        data[i] = Math.tanh((Math.random() * 2 - 1) * 2.4) * env;
      }

      const crunchSrc = ctx.createBufferSource();
      crunchSrc.buffer = crunchBuf;

      const crunchFilter = ctx.createBiquadFilter();
      crunchFilter.type = 'bandpass';
      crunchFilter.frequency.setValueAtTime(520, now);
      crunchFilter.frequency.exponentialRampToValueAtTime(
        210,
        now + crunchDuration,
      );
      crunchFilter.Q.value = 0.85;

      const crunchGain = ctx.createGain();
      crunchGain.gain.setValueAtTime(0.085 * clampedMag, now);
      crunchGain.gain.exponentialRampToValueAtTime(
        0.001,
        now + crunchDuration,
      );

      crunchSrc.connect(crunchFilter);
      crunchFilter.connect(crunchGain);
      crunchGain.connect(ctx.destination);
      crunchSrc.start(now);
      crunchSrc.stop(now + crunchDuration);
    } catch {
      // Ignore
    }
  }

  public playGarageWrench() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      for (const offset of [0, 0.042]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        const pitchVar = 0.95 + Math.random() * 0.1;
        osc.frequency.setValueAtTime(680 * pitchVar, now + offset);
        osc.frequency.exponentialRampToValueAtTime(210, now + offset + 0.032);

        gain.gain.setValueAtTime(0.04, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.036);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.04);
      }
    } catch {
      // Ignore
    }
  }

  public playRaceFanfare(victory: boolean) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const notes = victory
        ? [440, 554.37, 659.25, 880]
        : [392, 349.23, 311.13, 261.63];
      notes.forEach((freq, idx) => {
        const now = ctx.currentTime + idx * 0.11;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(0.055, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.3);
      });
    } catch {
      // Ignore
    }
  }
}

export const soundEngine = new UndergroundAudioEngine();
