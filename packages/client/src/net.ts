/**
 * 네트워크 + 로컬 시뮬레이션 구동.
 *
 * 이 클래스가 하는 일:
 *   1. 서버와 WS 연결, 매치 수립
 *   2. **클럭 동기화** — 서버의 "선두 틱"을 추정 (ping/pong RTT 중앙값)
 *   3. 서버가 확정한 커맨드를 예약 테이블에 넣기
 *   4. 벽시계를 따라 로컬 시뮬을 SIM_DELAY_TICKS 만큼 뒤처져서 진행
 *   5. 주기적으로 상태 해시를 보고 → 데스싱크 감지
 *
 * 상세: docs/NETCODE.md
 */

import {
  Command,
  GameState,
  HASH_INTERVAL,
  SIM_DELAY_TICKS,
  ServerMsg,
  TICK_MS,
  Team,
  createState,
  hashState,
  restore,
  sortCommands,
  step,
} from '@royale/shared';

const MAX_CATCHUP_TICKS = 40;
const PING_INTERVAL_MS = 1000;
const RTT_SAMPLES = 9;

export interface NetStats {
  rttMs: number;
  /** 클라 시뮬 틱 */
  simTick: number;
  /** 추정한 서버 선두 틱 */
  leadTick: number;
  desyncs: number;
  connected: boolean;
}

export interface NetEvents {
  onMatch?: (team: Team, opponent: string) => void;
  onQueued?: () => void;
  onOver?: (winner: Team | -1, crowns: [number, number]) => void;
  onOpponentLeft?: () => void;
  onReject?: (reason: string) => void;
  /** 시뮬이 한 틱 진행되기 직전에 호출 (보간용 이전 위치 스냅샷) */
  onBeforeStep?: (s: GameState) => void;
}

export class NetClient {
  state: GameState | null = null;
  myTeam: Team = 0;
  opponent = '';
  desyncs = 0;

  private ws: WebSocket | null = null;
  private startWallMs = 0;
  /** 로컬 시계 → 서버 시계 보정치 (틱 단위) */
  private tickOffset = 0;
  private rttSamples: number[] = [];
  private scheduled = new Map<number, Command[]>();
  private lastHashSent = -1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** 마지막 step()이 끝난 벽시계 시각 — 렌더 보간에 쓴다 */
  lastStepWallMs = 0;

  constructor(
    private readonly url: string,
    private readonly events: NetEvents = {},
  ) {}

  connect(name: string, deckId: string): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.send({ t: 'hello', name, deckId });
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
      this.ping();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      this.onMessage(msg);
    };

    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
    };
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ping(): void {
    this.send({ t: 'ping', ts: Date.now() });
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'queued':
        this.events.onQueued?.();
        return;

      case 'match': {
        this.myTeam = msg.team;
        this.opponent = msg.opponent;
        this.startWallMs = msg.startWallMs;
        this.scheduled.clear();
        this.lastHashSent = -1;
        this.desyncs = 0;
        this.state = createState(msg.seed, msg.decks);
        this.lastStepWallMs = Date.now();
        this.events.onMatch?.(msg.team, msg.opponent);
        return;
      }

      case 'cmd': {
        const cmd: Command = {
          execTick: msg.execTick,
          team: msg.team,
          card: msg.card,
          x: msg.x,
          y: msg.y,
        };
        // 이미 지나간 틱에 대한 커맨드가 오면 시뮬이 갈라진다.
        // 정상 동작에서는 발생하지 않아야 하며, 발생하면 해시 대조가 잡아낸다.
        if (this.state && cmd.execTick <= this.state.tick) {
          console.warn('[net] 지각 커맨드', cmd.execTick, '현재', this.state.tick);
        }
        const arr = this.scheduled.get(cmd.execTick);
        if (arr) arr.push(cmd);
        else this.scheduled.set(cmd.execTick, [cmd]);
        return;
      }

      case 'pong': {
        const rtt = Date.now() - msg.ts;
        this.rttSamples.push(rtt);
        if (this.rttSamples.length > RTT_SAMPLES) this.rttSamples.shift();

        if (this.startWallMs > 0) {
          // pong이 도착한 지금, 서버의 선두 틱은 대략 serverTick + (편도 지연)
          const oneWayTicks = rtt / 2 / TICK_MS;
          const observed = msg.serverTick + oneWayTicks;
          const localRaw = (Date.now() - this.startWallMs) / TICK_MS;
          const sample = observed - localRaw;
          // 스파이크 한 번에 오염되지 않도록 중앙값을 쓴다
          this.offsetSamples.push(sample);
          if (this.offsetSamples.length > RTT_SAMPLES) this.offsetSamples.shift();
          this.tickOffset = median(this.offsetSamples);
        }
        return;
      }

      case 'resync': {
        if (!this.state) return;
        console.warn('[net] 리싱크 수신 — 시뮬 상태를 서버 스냅샷으로 덮어씀');
        restore(this.state, msg.state);
        this.desyncs++;
        // 이미 지나간 예약은 버린다 (스냅샷에 반영되어 있다)
        for (const k of [...this.scheduled.keys()]) {
          if (k <= this.state.tick) this.scheduled.delete(k);
        }
        return;
      }

      case 'reject':
        this.events.onReject?.(msg.reason);
        return;

      case 'over':
        this.events.onOver?.(msg.winner, msg.crowns);
        return;

      case 'opponent-left':
        this.events.onOpponentLeft?.();
        return;
    }
  }

  private offsetSamples: number[] = [];

  /** 서버 기준 "선두 틱" 추정치 */
  leadTick(): number {
    if (this.startWallMs === 0) return 0;
    return Math.floor((Date.now() - this.startWallMs) / TICK_MS + this.tickOffset);
  }

  /** 카드 배치 요청 */
  play(card: string, x: number, y: number): void {
    if (!this.state) return;
    this.send({ t: 'play', reqTick: this.state.tick, card, x: Math.round(x), y: Math.round(y) });
  }

  /**
   * 벽시계를 따라 로컬 시뮬을 진행시킨다. 매 렌더 프레임마다 호출한다.
   * @returns 이번 호출에서 진행한 틱 수
   */
  update(): number {
    const s = this.state;
    if (!s) return 0;

    const target = this.leadTick() - SIM_DELAY_TICKS;
    let steps = 0;
    while (s.tick < target && steps < MAX_CATCHUP_TICKS) {
      const cmds = this.scheduled.get(s.tick);
      if (cmds) this.scheduled.delete(s.tick);
      this.events.onBeforeStep?.(s);
      step(s, cmds ? sortCommands(cmds) : []);
      steps++;

      if (s.tick % HASH_INTERVAL === 0 && s.tick !== this.lastHashSent) {
        this.lastHashSent = s.tick;
        this.send({ t: 'hash', tick: s.tick, hash: hashState(s) });
      }
      if (s.over) break;
    }
    if (steps > 0) this.lastStepWallMs = Date.now();
    return steps;
  }

  /** 마지막 틱 이후 경과 비율 [0,1] — 렌더 보간용 */
  alpha(): number {
    const a = (Date.now() - this.lastStepWallMs) / TICK_MS;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  stats(): NetStats {
    return {
      rttMs: this.rttSamples.length ? Math.round(median(this.rttSamples)) : 0,
      simTick: this.state?.tick ?? 0,
      leadTick: this.leadTick(),
      desyncs: this.desyncs,
      connected: this.ws?.readyState === WebSocket.OPEN,
    };
  }
}

function median(xs: readonly number[]): number {
  const a = xs.slice().sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
