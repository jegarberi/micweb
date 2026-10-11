class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.settings = { bypass: false, gate: true, compressor: true, limiter: true,
      gateThreshold: -50, threshold: -20, ratio: 3, attack: 3, release: 60, ceiling: -7, trim: 0 };
    this.envelope = 0;
    this.gateGain = 1;
    this.compressorGain = 1;
    this.limiterGain = 1;
    this.wet = 1;
    this.port.onmessage = ({ data }) => { this.settings = data; };
  }

  process(inputs, outputs) {
    const filtered = inputs[0];
    const dry = inputs[1];
    const output = outputs[0];
    const s = this.settings;
    const attack = Math.exp(-1 / (sampleRate * s.attack / 1000));
    const release = Math.exp(-1 / (sampleRate * s.release / 1000));
    const gateRelease = Math.exp(-1 / (sampleRate * 0.1));
    const gateAttack = Math.exp(-1 / (sampleRate * 0.002));
    const ceiling = 10 ** (s.ceiling / 20);
    const trim = 10 ** (s.trim / 20);
    for (let i = 0; i < output[0].length; i++) {
      let peak = 0;
      for (const channel of filtered) peak = Math.max(peak, Math.abs(channel[i] || 0));
      this.envelope = Math.max(peak, this.envelope * gateRelease);
      const level = 20 * Math.log10(Math.max(this.envelope, 1e-10));
      const gateTarget = s.gate ? 10 ** (Math.min(0, level - s.gateThreshold) / 20) : 1;
      const gateCoefficient = gateTarget > this.gateGain ? gateAttack : gateRelease;
      this.gateGain = gateTarget + gateCoefficient * (this.gateGain - gateTarget);
      const gatedLevel = 20 * Math.log10(Math.max(peak * this.gateGain, 1e-10));
      const reduction = Math.max(0, gatedLevel - s.threshold) * (1 - 1 / s.ratio);
      const compressorTarget = s.compressor ? 10 ** (-reduction / 20) : 1;
      const coefficient = compressorTarget < this.compressorGain ? attack : release;
      this.compressorGain = compressorTarget + coefficient * (this.compressorGain - compressorTarget);
      const gain = this.gateGain * this.compressorGain * trim;
      const limiterTarget = s.limiter ? Math.min(1, ceiling / Math.max(peak * gain, 1e-10)) : 1;
      this.limiterGain = Math.min(limiterTarget, 1 + gateRelease * (this.limiterGain - 1));
      this.wet += ((s.bypass ? 0 : 1) - this.wet) / (sampleRate * 0.005);
      for (let channel = 0; channel < output.length; channel++) {
        const processed = (filtered[channel]?.[i] || 0) * gain * this.limiterGain;
        output[channel][i] = processed * this.wet + (dry[channel]?.[i] || 0) * (1 - this.wet);
      }
    }
    return true;
  }
}
registerProcessor('voice-processor', VoiceProcessor);
