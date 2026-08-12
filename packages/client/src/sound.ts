/**
 * 합성 효과음.
 *
 * 오디오 파일이 하나도 없다 — 전부 WebAudio 오실레이터와 노이즈로 그 자리에서
 * 만든다. 파일이 없으니 로딩도, 아트 파이프라인도, 매니페스트도 필요 없고,
 * 나중에 진짜 녹음이 생기면 이 모듈의 재생부만 갈아끼우면 된다.
 *
 * 렌더 전용이다. 시뮬레이션은 소리의 존재를 모른다.
 *
 * 브라우저 자동재생 정책 때문에 AudioContext는 **첫 사용자 입력에서** 연다
 * (`unlock()`). 그 전의 재생 요청은 조용히 버려진다.
 */

type Sfx =
  | 'impact_steel'
  | 'impact_swarmhive'
  | 'impact_covenant'
  | 'death'
  | 'deploy'
  | 'build'
  | 'tech'
  | 'ui'
  | 'error'
  | 'win'
  | 'lose'
  | 'draw';

const MUTE_KEY = 'royale-muted';

class SoundBank {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  /** 이름별 마지막 재생 시각 — 대군 전투에서 같은 소리가 겹쳐 포화되는 것을 막는다 */
  private readonly last = new Map<string, number>();

  muted = localStorage.getItem(MUTE_KEY) === '1';

  /** 첫 사용자 제스처에서 호출 — 이미 열려 있으면 아무것도 안 한다 */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as never)['webkitAudioContext'];
    if (!Ctx) return; // 지원하지 않는 브라우저 — 소리 없이 진행
    this.ctx = new Ctx();

    // 리미터를 겸하는 컴프레서 → 마스터 볼륨. 착탄이 수십 개 겹쳐도
    // 볼륨이 터지지 않고 눌린다.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 8;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);

    // 노이즈는 매번 만들지 않고 1초짜리 버퍼 하나를 돌려 쓴다
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.02);
    }
    return this.muted;
  }

  play(name: Sfx): void {
    if (!this.ctx || !this.master || this.muted) return;
    // 같은 소리는 70ms에 한 번 — 물량전 보호. 승패 스팅어는 제한 없음
    const now = performance.now();
    const gap = name === 'win' || name === 'lose' || name === 'draw' ? 0 : 70;
    const prev = this.last.get(name) ?? -Infinity;
    if (now - prev < gap) return;
    this.last.set(name, now);

    const t = this.ctx.currentTime;
    switch (name) {
      case 'impact_steel':
        // 총격: 짧은 노이즈 + 급강하 사각파
        this.noise(t, 0.07, 0.25, 1800, 'highpass');
        this.tone(t, 0.08, 0.2, 'square', 220, 70);
        break;
      case 'impact_swarmhive':
        // 유기체 타격: 낮은 톱니 + 둔탁한 노이즈
        this.tone(t, 0.12, 0.25, 'sawtooth', 150, 45);
        this.noise(t, 0.1, 0.15, 500, 'lowpass');
        break;
      case 'impact_covenant':
        // 에너지: 높은 사인 글라이드
        this.tone(t, 0.11, 0.22, 'sine', 990, 330);
        this.tone(t, 0.09, 0.1, 'triangle', 1480, 660);
        break;
      case 'death':
        this.noise(t, 0.22, 0.3, 420, 'lowpass');
        this.tone(t, 0.18, 0.25, 'sine', 130, 40);
        break;
      case 'deploy':
        this.tone(t, 0.05, 0.2, 'square', 520, 520);
        this.tone(t + 0.06, 0.06, 0.2, 'square', 700, 700);
        break;
      case 'build':
        for (const [i, f] of [330, 415, 495].entries()) {
          this.tone(t + i * 0.07, 0.09, 0.18, 'triangle', f, f);
        }
        break;
      case 'tech':
        for (const [i, f] of [523, 659, 784, 1047].entries()) {
          this.tone(t + i * 0.055, 0.08, 0.16, 'triangle', f, f);
        }
        break;
      case 'ui':
        this.tone(t, 0.03, 0.12, 'square', 880, 880);
        break;
      case 'error':
        this.tone(t, 0.09, 0.2, 'square', 110, 110);
        this.tone(t + 0.11, 0.09, 0.2, 'square', 92, 92);
        break;
      case 'win':
        for (const [i, f] of [523, 659, 784, 1047, 1319].entries()) {
          this.tone(t + i * 0.12, 0.28, 0.22, 'triangle', f, f);
        }
        break;
      case 'lose':
        for (const [i, f] of [392, 349, 311, 262].entries()) {
          this.tone(t + i * 0.16, 0.34, 0.22, 'triangle', f, f);
        }
        break;
      case 'draw':
        this.tone(t, 0.3, 0.2, 'triangle', 440, 440);
        this.tone(t + 0.34, 0.4, 0.2, 'triangle', 440, 440);
        break;
    }
  }

  /** 감쇠 포락선을 씌운 오실레이터 한 발 */
  private tone(
    at: number,
    dur: number,
    vol: number,
    type: OscillatorType,
    from: number,
    to: number,
  ): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /** 필터를 거친 노이즈 한 발 */
  private noise(
    at: number,
    dur: number,
    vol: number,
    freq: number,
    kind: BiquadFilterType,
  ): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    // 버퍼 재사용이라 매번 같은 구간이면 기계적으로 들린다 — 시작점을 흔든다
    const offset = Math.random() * (this.noiseBuf.duration - dur);
    const filter = this.ctx.createBiquadFilter();
    filter.type = kind;
    filter.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(at, offset, dur + 0.02);
    src.stop(at + dur + 0.04);
  }
}

export const sound = new SoundBank();
