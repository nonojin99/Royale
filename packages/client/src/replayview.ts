/**
 * 리플레이 뷰어.
 *
 * 서버에서 리플레이 JSON 하나를 받아 **서버 연결 없이** 경기를 재생한다.
 * 시뮬레이션이 순수 함수라서 가능한 일이다 — 뷰어는 넷코드를 전혀 모른다.
 *
 * 탐색은 `ReplayPlayer`가 키프레임으로 처리하므로, 스크럽바를 끌어도
 * 매번 0틱부터 다시 돌리지 않는다.
 */

import {
  GameState,
  Replay,
  ReplayPlayer,
  TICK_MS,
  TICK_RATE,
  Team,
  getFaction,
} from '@royale/shared';

export interface ReplayViewCallbacks {
  /** 매 프레임 그릴 상태를 넘겨준다 */
  onFrame: (state: GameState, viewTeam: Team) => void;
  /** 재생 위치/상태가 바뀔 때 UI 갱신용 */
  onStatus: (s: ReplayStatus) => void;
}

export interface ReplayStatus {
  tick: number;
  totalTicks: number;
  playing: boolean;
  speed: number;
  title: string;
  timeText: string;
}

const SPEEDS = [1, 2, 4, 0.5] as const;

export class ReplayView {
  private readonly player: ReplayPlayer;
  private readonly replay: Replay;
  private readonly cb: ReplayViewCallbacks;

  private tick = 0;
  private playing = false;
  private speedIndex = 0;
  private lastFrameMs = 0;
  private raf = 0;

  constructor(replay: Replay, cb: ReplayViewCallbacks) {
    this.replay = replay;
    this.cb = cb;
    this.player = new ReplayPlayer(replay);
  }

  get totalTicks(): number {
    return this.player.totalTicks;
  }

  start(): void {
    this.playing = true;
    this.lastFrameMs = performance.now();
    this.emitStatus();
    this.loop();
  }

  stop(): void {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  togglePlay(): void {
    if (this.tick >= this.totalTicks) this.tick = 0; // 끝났으면 처음부터
    this.playing = !this.playing;
    this.lastFrameMs = performance.now();
    this.emitStatus();
  }

  cycleSpeed(): void {
    this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
    this.emitStatus();
  }

  seek(tick: number): void {
    this.tick = Math.max(0, Math.min(tick, this.totalTicks));
    this.lastFrameMs = performance.now();
    this.render();
    this.emitStatus();
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);

    const now = performance.now();
    if (this.playing) {
      const elapsed = now - this.lastFrameMs;
      const advanced = (elapsed / TICK_MS) * SPEEDS[this.speedIndex];
      if (advanced >= 1) {
        this.tick = Math.min(this.tick + Math.floor(advanced), this.totalTicks);
        this.lastFrameMs = now;
        if (this.tick >= this.totalTicks) {
          this.playing = false;
        }
        this.emitStatus();
      }
    }
    this.render();
  };

  private render(): void {
    // 뷰어는 항상 team0 시점으로 본다 (관전 시점 전환은 추후 과제)
    this.cb.onFrame(this.player.stateAt(this.tick), 0);
  }

  private emitStatus(): void {
    const d0 = safeFactionName(this.replay.factions[0]);
    const d1 = safeFactionName(this.replay.factions[1]);
    this.cb.onStatus({
      tick: this.tick,
      totalTicks: this.totalTicks,
      playing: this.playing,
      speed: SPEEDS[this.speedIndex],
      title: `${this.replay.players[0]} (${d0}) vs ${this.replay.players[1]} (${d1})`,
      timeText: `${fmt(this.tick)} / ${fmt(this.totalTicks)}`,
    });
  }
}

/** 삭제된 종족의 과거 리플레이면 id를 그대로 보여준다 */
function safeFactionName(id: string): string {
  const f = getFaction(id);
  return f.id === id ? f.name : id;
}

function fmt(tick: number): string {
  const sec = Math.floor(tick / TICK_RATE);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/* ── 로딩 ──────────────────────────────────────────────────────────────── */

/** WS 주소(ws://host:port)를 HTTP 주소로 바꾼다 */
export function httpBaseFrom(wsUrl: string): string {
  return wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\?.*$/, '');
}

export async function fetchReplay(serverWsUrl: string, id: string): Promise<Replay> {
  const url = /^https?:\/\//.test(id)
    ? id // 전체 URL을 직접 준 경우
    : `${httpBaseFrom(serverWsUrl)}/replay/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`리플레이를 불러오지 못했다 (HTTP ${res.status})`);
  return (await res.json()) as Replay;
}

export interface ReplayIndexEntry {
  id: string;
  createdAt: number;
  factions: [string, string];
  players: [string, string];
  winner: Team | -1;
  bases: [number, number];
  ticks: number;
  bytes: number;
}

export async function fetchReplayList(serverWsUrl: string): Promise<ReplayIndexEntry[]> {
  const res = await fetch(`${httpBaseFrom(serverWsUrl)}/replays?limit=20`);
  if (!res.ok) return [];
  const body = (await res.json()) as { replays?: ReplayIndexEntry[] };
  return body.replays ?? [];
}
