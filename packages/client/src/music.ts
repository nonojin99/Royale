/**
 * 어댑티브 뮤직 — 파도의 흐름에 반응하는 절차적 음악.
 *
 * 오디오 파일이 하나도 없다. 효과음(sound.ts)과 같은 문법으로 **그 자리에서
 * 합성**한다: 파일도, 로딩도, 라이선스도, 용량도 없다. 나중에 진짜 작곡이
 * 생기면 이 모듈의 레이어를 오디오 트랙으로 갈아끼우면 된다.
 *
 * ── 왜 레이어인가 ──────────────────────────────────────────────────────
 * 게임 음악의 어댑티브는 "곡을 바꾸는 것"이 아니라 **켜고 끄는 층**이다.
 * 같은 화성 위에서 층이 쌓이고 빠지면 전환이 끊기지 않는다:
 *
 *   1층 드론(항상)     — 저역 지속음. 세계가 거기 있다는 감각
 *   2층 아르페지오     — 준비 단계의 느린 분산화음. 시계가 간다
 *   3층 박동(파도 임박) — 카운트다운 10초부터. 심장이 빨라진다
 *   4층 타악(전투)     — 적이 살아 있는 동안. 강도는 적 병력에 비례
 *   5층 보스           — 반음 낮은 대위 선율. 다른 곡처럼 들리게
 *
 * 화성은 단조 한 자리(A 에올리안)에 고정한다 — 전조까지 하면 층이 겹칠 때
 * 불협이 난다. 절차적 음악의 미덕은 화려함이 아니라 **끊기지 않음**이다.
 *
 * 렌더 전용이다. 시뮬레이션은 소리의 존재를 모른다.
 */

/** 게임 상태에서 파생하는 음악 국면 */
export type MusicPhase = 'idle' | 'prep' | 'incoming' | 'combat' | 'boss' | 'defeat';

/** A 에올리안 — 단조의 슬픈 자리. 아르페지오와 베이스가 여기서 음을 고른다 */
const SCALE_HZ = [220.0, 246.94, 261.63, 293.66, 329.63, 349.23, 392.0, 440.0];
/** 한 박 = 0.5초 (120 BPM) — 전투에서만 배로 잘게 쪼갠다 */
const BEAT_S = 0.5;

export class Music {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  /** 층별 볼륨 — 국면이 바뀌면 여기로 부드럽게 밀어 넣는다 */
  private readonly gains: Record<string, GainNode> = {};
  private drone: OscillatorNode | null = null;
  private droneSub: OscillatorNode | null = null;

  private phase: MusicPhase = 'idle';
  /** 0~1 — 전투 격렬함. 적 병력 수에서 온다 */
  private intensity = 0;
  private nextBeatAt = 0;
  private beat = 0;
  private timer: number | null = null;

  muted = false;

  /** 첫 사용자 제스처 이후에 호출한다 (자동재생 정책) */
  start(ctx: AudioContext, master: GainNode, noise: AudioBuffer): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.noise = noise;

    // 음악은 효과음보다 확실히 뒤에 앉힌다 — 타격감이 먼저다
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.0;
    this.bus.connect(master);

    for (const layer of ['drone', 'arp', 'pulse', 'perc', 'boss']) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.bus);
      this.gains[layer] = g;
    }

    // 1층 드론 — 곡의 바닥. 시작하면 끝까지 울린다
    const mk = (hz: number, type: OscillatorType, gain: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(this.gains.drone);
      o.start();
      return o;
    };
    this.drone = mk(110, 'sine', 0.5);
    this.droneSub = mk(55, 'triangle', 0.35);

    this.nextBeatAt = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.tick(), 60);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    try {
      this.drone?.stop();
      this.droneSub?.stop();
    } catch {
      /* 이미 멈춘 오실레이터 — 무시 */
    }
    this.drone = null;
    this.droneSub = null;
    this.ctx = null;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyMix();
  }

  /**
   * 게임 상태를 음악 국면으로 옮긴다. 매 프레임 불러도 싸다 — 바뀔 때만 믹스를 민다.
   *
   * @param phase 국면
   * @param intensity 0~1 전투 격렬함 (적 병력 수 기반)
   */
  set(phase: MusicPhase, intensity: number): void {
    const inten = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
    if (phase === this.phase && Math.abs(inten - this.intensity) < 0.12) return;
    this.phase = phase;
    this.intensity = inten;
    this.applyMix();
  }

  private applyMix(): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    const t = ctx.currentTime;
    const to = (node: GainNode | undefined, v: number, sec = 1.2): void => {
      node?.gain.setTargetAtTime(this.muted ? 0 : v, t, sec / 3);
    };

    // 국면별 층 구성 — 전환은 볼륨으로만 한다(곡을 갈아엎지 않는다)
    const p = this.phase;
    const combat = p === 'combat' || p === 'boss';
    this.bus.gain.setTargetAtTime(this.muted || p === 'idle' ? 0 : 0.28, t, 0.5);
    to(this.gains.drone, p === 'defeat' ? 0.5 : 0.35);
    to(this.gains.arp, p === 'prep' ? 0.32 : p === 'incoming' ? 0.22 : combat ? 0.16 : 0);
    to(this.gains.pulse, p === 'incoming' ? 0.3 : combat ? 0.18 : 0, 0.6);
    to(this.gains.perc, combat ? 0.16 + 0.24 * this.intensity : 0, 0.8);
    to(this.gains.boss, p === 'boss' ? 0.3 : 0, 1.6);
  }

  /** 박자 스케줄러 — 다음 박이 가까워지면 그 박의 음을 미리 잡아 둔다 */
  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || this.phase === 'idle') return;
    const beatLen = this.phase === 'combat' || this.phase === 'boss' ? BEAT_S / 2 : BEAT_S;
    while (this.nextBeatAt < ctx.currentTime + 0.25) {
      this.schedule(this.nextBeatAt, this.beat);
      this.nextBeatAt += beatLen;
      this.beat++;
    }
  }

  private schedule(at: number, beat: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    // 2층 아르페지오 — 음계를 오르내린다. 준비 단계의 시계 소리
    if (this.gains.arp.gain.value > 0.01) {
      const idx = [0, 2, 4, 6, 4, 2][beat % 6];
      this.blip(this.gains.arp, SCALE_HZ[idx], at, 0.45, 'triangle');
    }

    // 3층 박동 — 4박에 한 번 낮은 심장 소리
    if (this.gains.pulse.gain.value > 0.01 && beat % 4 === 0) {
      this.thump(this.gains.pulse, at);
    }

    // 4층 타악 — 킥과 하이햇. 전투의 맥박
    if (this.gains.perc.gain.value > 0.01) {
      if (beat % 4 === 0) this.thump(this.gains.perc, at);
      if (beat % 2 === 1) this.hat(this.gains.perc, at);
    }

    // 5층 보스 — 반음 아래를 스치는 대위 선율. 같은 곡이 다른 곡이 된다
    if (this.gains.boss.gain.value > 0.01 && beat % 8 === 0) {
      this.blip(this.gains.boss, 103.83, at, 1.6, 'sawtooth');
      this.blip(this.gains.boss, 155.56, at + 0.25, 1.2, 'sawtooth');
    }

    // 패배 — 드론이 반음씩 가라앉는다
    if (this.phase === 'defeat' && this.drone && beat % 8 === 0) {
      this.drone.frequency.setTargetAtTime(82.41, at, 2.5);
      this.droneSub?.frequency.setTargetAtTime(41.2, at, 2.5);
    }
  }

  private blip(dest: GainNode, hz: number, at: number, dur: number, type: OscillatorType): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.5, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g);
    g.connect(dest);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  private thump(dest: GainNode, at: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, at);
    o.frequency.exponentialRampToValueAtTime(41, at + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
    o.connect(g);
    g.connect(dest);
    o.start(at);
    o.stop(at + 0.3);
  }

  private hat(dest: GainNode, at: number): void {
    const ctx = this.ctx!;
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    src.connect(hp);
    hp.connect(g);
    g.connect(dest);
    src.start(at);
    src.stop(at + 0.08);
  }
}

export const music = new Music();
