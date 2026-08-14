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
  CommandKind,
  SRoomState,
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
  simTick: number;
  leadTick: number;
  desyncs: number;
  connected: boolean;
}

export interface NetEvents {
  onMatch?: (team: Team, opponent: string) => void;
  onQueued?: () => void;
  onOver?: (
    winner: Team | -1,
    bases: [number, number],
    mined: [number, number],
    replayId?: string,
  ) => void;
  onOpponentLeft?: () => void;
  /** 방 상태 갱신 (만들기/참가/준비/퇴장) */
  onRoomState?: (st: SRoomState) => void;
  onRoomError?: (reason: string) => void;
  onReject?: (reason: string) => void;
  /** 시뮬이 한 틱 진행되기 직전에 호출 (보간용 이전 위치 스냅샷) */
  onBeforeStep?: (s: GameState) => void;
}

export class NetClient {
  state: GameState | null = null;
  myTeam: Team = 0;
  opponent = '';
  factions: [string, string] = ['steel', 'steel'];
  desyncs = 0;

  private ws: WebSocket | null = null;
  private startWallMs = 0;
  /** 로컬 시계 → 서버 시계 보정치 (틱 단위) */
  private tickOffset = 0;
  private rttSamples: number[] = [];
  private offsetSamples: number[] = [];
  private scheduled = new Map<number, Command[]>();
  private lastHashSent = -1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  lastStepWallMs = 0;

  constructor(
    private readonly url: string,
    private readonly events: NetEvents = {},
  ) {}

  connect(
    name: string,
    factionId: string,
    mapId?: string,
    opts?: { solo?: boolean; botLevel?: string; onOpen?: () => void },
  ): void {
    let url = this.url;
    if (opts?.solo) url += (url.includes('?') ? '&' : '?') + 'solo=1';
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.send({ t: 'hello', name, factionId, mapId, botLevel: opts?.botLevel });
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
      this.ping();
      opts?.onOpen?.();
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

      case 'room-state':
        this.events.onRoomState?.(msg);
        return;

      case 'room-error':
        this.events.onRoomError?.(msg.reason);
        return;

      case 'match': {
        this.myTeam = msg.team;
        this.opponent = msg.opponent;
        this.factions = msg.factions;
        this.startWallMs = msg.startWallMs;
        this.scheduled.clear();
        this.lastHashSent = -1;
        this.desyncs = 0;
        this.state = createState(msg.seed, msg.factions, msg.mapId);
        this.lastStepWallMs = Date.now();
        this.events.onMatch?.(msg.team, msg.opponent);
        return;
      }

      case 'cmd': {
        const cmd: Command = {
          execTick: msg.execTick,
          team: msg.team,
          kind: msg.kind,
          id: msg.id,
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
          const oneWayTicks = rtt / 2 / TICK_MS;
          const observed = msg.serverTick + oneWayTicks;
          const localRaw = (Date.now() - this.startWallMs) / TICK_MS;
          this.offsetSamples.push(observed - localRaw);
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
        for (const k of [...this.scheduled.keys()]) {
          if (k <= this.state.tick) this.scheduled.delete(k);
        }
        return;
      }

      case 'reject':
        this.events.onReject?.(msg.reason);
        return;

      case 'over':
        this.events.onOver?.(msg.winner, msg.bases, msg.mined, msg.replayId);
        return;

      case 'opponent-left':
        this.events.onOpponentLeft?.();
        return;
    }
  }

  /** 서버 기준 "선두 틱" 추정치 */
  leadTick(): number {
    if (this.startWallMs === 0) return 0;
    return Math.floor((Date.now() - this.startWallMs) / TICK_MS + this.tickOffset);
  }

  /** 행동 요청 — 유닛 생산 / 기지 건설 / 테크 해금 */
  createRoom(): void {
    this.send({ t: 'create-room' });
  }

  /** 방 안에서 종족·맵 변경 — 연결 전이면 조용히 무시된다 */
  setLoadout(v: { factionId?: string; mapId?: string }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ t: 'set-loadout', ...v });
  }

  joinRoom(code: string): void {
    this.send({ t: 'join-room', code });
  }

  setReady(ready: boolean): void {
    this.send({ t: 'ready', ready });
  }

  startRoom(): void {
    this.send({ t: 'start-room' });
  }

  act(kind: CommandKind, id: string, x = 0, y = 0): void {
    if (!this.state) return;
    this.send({
      t: 'act',
      reqTick: this.state.tick,
      kind,
      id,
      x: Math.round(x),
      y: Math.round(y),
    });
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
