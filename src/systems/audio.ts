/**
 * Звук.
 *
 * Ни одного звукового файла в проекте нет — всё синтезируется на месте через
 * WebAudio. Удар меча это короткий шумовой всплеск с быстрым спадом, тетива —
 * скользящий по частоте щелчок, шаг — глухой стук. Получается скупо, но живо,
 * и репозиторий остаётся невесомым.
 */
export type SoundName =
  | 'hit'
  | 'sever'
  | 'bow'
  | 'arrow-hit'
  | 'death'
  | 'step'
  | 'coin'
  | 'order'
  | 'hurt';

export class Audio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private stepPhase = 0;

  /** Общая громкость, 0…1. */
  volume = 0.5;
  enabled = true;

  /**
   * Браузер не даёт звучать до первого действия пользователя, поэтому
   * контекст создаётся лениво — при первом же звуке после клика.
   */
  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return this.context;
    }

    try {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
      this.noiseBuffer = this.createNoise(this.context);
      return this.context;
    } catch (error) {
      console.warn('[звук] не удалось запустить WebAudio', error);
      this.enabled = false;
      return null;
    }
  }

  private createNoise(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * 0.5);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.volume;
  }

  play(name: SoundName): void {
    const context = this.ensure();
    if (!context || !this.master) return;

    switch (name) {
      case 'hit':
        this.burst(context, 0.09, 1400, 0.35);
        this.tone(context, 'square', 190, 120, 0.08, 0.16);
        break;
      case 'sever':
        // Отрубленная конечность звучит тяжелее обычного удара.
        this.burst(context, 0.22, 900, 0.5);
        this.tone(context, 'sawtooth', 130, 60, 0.3, 0.22);
        break;
      case 'bow':
        this.tone(context, 'triangle', 620, 180, 0.13, 0.14);
        break;
      case 'arrow-hit':
        this.burst(context, 0.07, 2600, 0.28);
        break;
      case 'death':
        this.tone(context, 'sawtooth', 210, 55, 0.7, 0.2);
        break;
      case 'step':
        this.stepPhase = (this.stepPhase + 1) % 2;
        this.burst(context, 0.05, this.stepPhase === 0 ? 420 : 360, 0.12);
        break;
      case 'coin':
        this.tone(context, 'square', 880, 1320, 0.09, 0.1);
        this.tone(context, 'square', 1320, 1760, 0.07, 0.06, 0.05);
        break;
      case 'order':
        this.tone(context, 'triangle', 440, 660, 0.16, 0.12);
        break;
      case 'hurt':
        this.tone(context, 'sawtooth', 260, 150, 0.2, 0.16);
        break;
    }
  }

  /** Шумовой всплеск: удары, шаги, попадания. */
  private burst(context: AudioContext, duration: number, cutoff: number, gain: number): void {
    if (!this.noiseBuffer || !this.master) return;

    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;

    const envelope = context.createGain();
    const now = context.currentTime;
    envelope.gain.setValueAtTime(gain, now);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + duration);

    source.connect(filter).connect(envelope).connect(this.master);
    source.start(now);
    source.stop(now + duration);
  }

  /** Тон со скольжением по частоте: тетива, монеты, сигнал. */
  private tone(
    context: AudioContext,
    type: OscillatorType,
    from: number,
    to: number,
    duration: number,
    gain: number,
    delay = 0,
  ): void {
    if (!this.master) return;

    const oscillator = context.createOscillator();
    oscillator.type = type;

    const envelope = context.createGain();
    const now = context.currentTime + delay;
    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);
    envelope.gain.setValueAtTime(gain, now);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + duration);

    oscillator.connect(envelope).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.master = null;
  }
}
