/**
 * 리플레이 — 경기 전체를 재현하는 최소 데이터.
 *
 * 결정론적 lockstep의 가장 큰 보상이 여기 있다. 유닛 좌표나 HP를 하나도 저장하지
 * 않고 **시드 + 커맨드 목록**만 남기면 경기 전체가 그대로 재생된다.
 * 3분 경기 하나가 수 KB다.
 *
 * 이 파일이 제공하는 것:
 *   - `Replay` 포맷과 빌더
 *   - `playReplay`   — 끝까지 돌려 최종 상태를 얻는다
 *   - `verifyReplay` — 재생 결과가 기록 당시와 일치하는지 검사한다
 *   - `ReplayPlayer` — 키프레임을 써서 임의 틱으로 즉시 이동한다 (뷰어용)
 *
 * `verifyReplay`는 단순한 편의 기능이 아니라 **결정론 회귀 감지기**다.
 * 시뮬레이션 로직을 바꾸면 과거 리플레이의 해시가 어긋나고, 그건 밸런스 변경이
 * 의도적이었는지 아니면 결정론이 깨진 것인지 되묻게 만든다.
 */

import { MATCH_TICKS, OVERTIME_TICKS } from './constants.js';
import type { Team } from './arena.js';
import {
  Command,
  GameState,
  baseCount,
  createState,
  hashState,
  restore,
  snapshot,
  sortCommands,
  step,
} from './sim.js';
import { DEFAULT_MAP_ID } from './arena.js';

/** 포맷 버전. 시뮬 규칙이 바뀌어 과거 리플레이가 재현 불가능해지면 올린다. */
// v4: 언덕(고지) 데미지 감쇄 도입 — 이전 리플레이는 재현 불가
export const REPLAY_VERSION = 13; // v13 = 침공 모드·게임 필 (라운드 23)

/** 경기가 진행될 수 있는 최대 틱 (정규 + 연장) */
export const MAX_MATCH_TICKS = MATCH_TICKS + OVERTIME_TICKS;

/** 뷰어 탐색용 키프레임 간격 (틱). 200틱 = 10초 */
const KEYFRAME_INTERVAL = 200;
/** 중간 검증 지점 간격 (틱). 30초마다 해시를 남겨 어긋난 지점을 좁힌다 */
const CHECKPOINT_INTERVAL = 600;

export interface ReplayResult {
  winner: Team | -1;
  /** 종료 시점 팀별 기지 수 */
  bases: [number, number];
  /** 종료 시점 팀별 누적 채굴량 */
  mined: [number, number];
  /** 경기가 끝난 틱 */
  ticks: number;
}

export interface ReplayCheckpoint {
  tick: number;
  hash: number;
}

export interface Replay {
  /** REPLAY_VERSION */
  v: number;
  matchId: string;
  seed: number;
  /** 경기가 열린 맵 id (구버전 리플레이엔 없다 → 기본 맵) */
  mapId?: string;
  /** 양 팀의 종족 id — 재생은 이걸로 상태를 초기화한다 */
  factions: [string, string];
  /** 표시용 플레이어 이름 */
  players: [string, string];
  /** 기록 시각 (벽시계 ms). 메타데이터일 뿐 시뮬에는 영향이 없다 */
  createdAt: number;
  /** execTick 오름차순으로 정규화된 커맨드 목록 */
  commands: Command[];
  result: ReplayResult;
  /** 중간 검증 지점 */
  checkpoints: ReplayCheckpoint[];
  /** 종료 시점 상태 해시 */
  finalHash: number;
}

/* ── 재생 ──────────────────────────────────────────────────────────────── */

function indexCommands(cmds: readonly Command[]): Map<number, Command[]> {
  const m = new Map<number, Command[]>();
  for (const c of sortCommands(cmds.slice())) {
    const arr = m.get(c.execTick);
    if (arr) arr.push(c);
    else m.set(c.execTick, [c]);
  }
  return m;
}

/**
 * 리플레이를 처음부터 재생한다.
 * @param untilTick 이 틱에 도달하면 멈춘다 (기본: 경기 끝까지)
 */
export function playReplay(r: Replay, untilTick: number = MAX_MATCH_TICKS): GameState {
  const s = createState(r.seed, r.factions, r.mapId ?? DEFAULT_MAP_ID);
  const byTick = indexCommands(r.commands);
  const limit = Math.min(untilTick, MAX_MATCH_TICKS);
  while (s.tick < limit && !s.over) {
    step(s, byTick.get(s.tick) ?? []);
  }
  return s;
}

export interface VerifyResult {
  ok: boolean;
  /** 어긋난 첫 지점 (없으면 -1) */
  divergedAtTick: number;
  expectedHash: number;
  actualHash: number;
  expected: ReplayResult;
  actual: ReplayResult;
}

/**
 * 리플레이를 다시 돌려 기록 당시와 같은 결과가 나오는지 검사한다.
 *
 * 실패하면 시뮬레이션 규칙이 바뀌었거나 결정론이 깨졌다는 뜻이다.
 * 체크포인트를 함께 대조해 **어느 지점부터** 갈라졌는지 알려준다.
 */
export function verifyReplay(r: Replay): VerifyResult {
  const s = createState(r.seed, r.factions, r.mapId ?? DEFAULT_MAP_ID);
  const byTick = indexCommands(r.commands);
  const checkpoints = new Map(r.checkpoints.map((c) => [c.tick, c.hash]));

  let divergedAtTick = -1;
  while (s.tick < MAX_MATCH_TICKS && !s.over) {
    step(s, byTick.get(s.tick) ?? []);
    const expected = checkpoints.get(s.tick);
    if (expected !== undefined && divergedAtTick < 0 && hashState(s) !== expected) {
      divergedAtTick = s.tick;
    }
  }

  const actualHash = hashState(s);
  const actual: ReplayResult = {
    winner: s.winner,
    bases: [baseCount(s, 0), baseCount(s, 1)],
    mined: [s.players[0].mined, s.players[1].mined],
    ticks: s.tick,
  };
  const ok =
    actualHash === r.finalHash &&
    actual.winner === r.result.winner &&
    actual.ticks === r.result.ticks &&
    actual.bases[0] === r.result.bases[0] &&
    actual.bases[1] === r.result.bases[1] &&
    actual.mined[0] === r.result.mined[0] &&
    actual.mined[1] === r.result.mined[1];

  if (!ok && divergedAtTick < 0) divergedAtTick = s.tick;

  return {
    ok,
    divergedAtTick,
    expectedHash: r.finalHash,
    actualHash,
    expected: r.result,
    actual,
  };
}

/* ── 기록 ──────────────────────────────────────────────────────────────── */

export interface BuildReplayInput {
  matchId: string;
  seed: number;
  mapId?: string;
  factions: [string, string];
  players: [string, string];
  commands: readonly Command[];
  createdAt?: number;
}

/**
 * 커맨드 목록으로부터 리플레이를 만든다.
 *
 * 결과·해시·체크포인트는 **여기서 다시 시뮬을 돌려** 채운다. 진행 중이던 서버
 * 상태를 그대로 쓰지 않는 이유는, 저장된 커맨드만으로 정말 재현되는지를
 * 저장 시점에 한 번 검증하기 위해서다. 재현되지 않는 리플레이를 저장하면
 * 나중에 원인을 찾을 수 없다.
 */
export function buildReplay(input: BuildReplayInput): Replay {
  const commands = sortCommands(input.commands.slice());
  const s = createState(input.seed, input.factions, input.mapId ?? DEFAULT_MAP_ID);
  const byTick = indexCommands(commands);
  const checkpoints: ReplayCheckpoint[] = [];

  while (s.tick < MAX_MATCH_TICKS && !s.over) {
    step(s, byTick.get(s.tick) ?? []);
    if (s.tick % CHECKPOINT_INTERVAL === 0) {
      checkpoints.push({ tick: s.tick, hash: hashState(s) });
    }
  }

  return {
    v: REPLAY_VERSION,
    mapId: s.mapId,
    matchId: input.matchId,
    seed: input.seed,
    factions: input.factions,
    players: input.players,
    createdAt: input.createdAt ?? Date.now(),
    commands,
    result: {
      winner: s.winner,
      bases: [baseCount(s, 0), baseCount(s, 1)],
      mined: [s.players[0].mined, s.players[1].mined],
      ticks: s.tick,
    },
    checkpoints,
    finalHash: hashState(s),
  };
}

/* ── 뷰어 ──────────────────────────────────────────────────────────────── */

/**
 * 임의 틱으로 즉시 이동할 수 있는 재생기.
 *
 * 매번 0틱부터 다시 돌리면 스크럽바를 드래그할 때 감당이 안 되므로,
 * 최초 1회 전체 재생 중에 키프레임(상태 스냅샷)을 남겨 둔다.
 * 이후 탐색은 "가장 가까운 이전 키프레임에서 복원 → 최대 KEYFRAME_INTERVAL 틱 전진"
 * 으로 끝난다.
 */
export class ReplayPlayer {
  readonly replay: Replay;
  /** 경기가 실제로 끝난 틱 */
  readonly totalTicks: number;

  private readonly byTick: Map<number, Command[]>;
  /** tick → 그 틱 시작 시점의 상태 스냅샷 */
  private readonly keyframes = new Map<number, GameState>();
  private readonly work: GameState;

  constructor(replay: Replay) {
    this.replay = replay;
    this.byTick = indexCommands(replay.commands);

    // 전체를 한 번 돌면서 키프레임을 남긴다
    const s = createState(replay.seed, replay.factions, replay.mapId ?? DEFAULT_MAP_ID);
    this.keyframes.set(0, snapshot(s));
    while (s.tick < MAX_MATCH_TICKS && !s.over) {
      step(s, this.byTick.get(s.tick) ?? []);
      if (s.tick % KEYFRAME_INTERVAL === 0) this.keyframes.set(s.tick, snapshot(s));
    }
    this.totalTicks = s.tick;

    this.work = createState(replay.seed, replay.factions, replay.mapId ?? DEFAULT_MAP_ID);
  }

  /**
   * 해당 틱 시점의 상태를 돌려준다.
   * 반환된 객체는 내부 작업 상태이므로 **읽기 전용으로 다뤄야 한다.**
   */
  stateAt(tick: number): GameState {
    const target = Math.max(0, Math.min(Math.floor(tick), this.totalTicks));

    // 이미 그 지점이거나 조금 앞이면 그대로 전진 (연속 재생의 일반 경로)
    if (this.work.tick > target || this.work.tick + KEYFRAME_INTERVAL < target) {
      const kfTick = Math.min(
        Math.floor(target / KEYFRAME_INTERVAL) * KEYFRAME_INTERVAL,
        this.totalTicks,
      );
      const kf = this.keyframes.get(kfTick) ?? this.keyframes.get(0)!;
      restore(this.work, kf);
    }

    while (this.work.tick < target && !this.work.over) {
      step(this.work, this.byTick.get(this.work.tick) ?? []);
    }
    return this.work;
  }
}

/* ── 요약 (밸런스 분석의 출발점) ───────────────────────────────────────── */

export interface ReplaySummary {
  matchId: string;
  factions: [string, string];
  players: [string, string];
  winner: Team | -1;
  bases: [number, number];
  mined: [number, number];
  /** 경기 길이 (초) */
  durationSec: number;
  /** 팀별 커맨드 수 (유닛 생산 / 기지 건설 / 테크 해금) */
  playCounts: [number, number];
  baseBuilds: [number, number];
  techUnlocks: [number, number];
  /** 팀별 "유닛 id → 생산 횟수" */
  unitUsage: [Record<string, number>, Record<string, number>];
}

export function summarizeReplay(r: Replay, tickRate = 20): ReplaySummary {
  const usage: [Record<string, number>, Record<string, number>] = [{}, {}];
  const counts: [number, number] = [0, 0];
  const bases: [number, number] = [0, 0];
  const techs: [number, number] = [0, 0];
  for (const c of r.commands) {
    counts[c.team]++;
    if (c.kind === 'base') bases[c.team]++;
    else if (c.kind === 'tech') techs[c.team]++;
    else usage[c.team][c.id] = (usage[c.team][c.id] ?? 0) + 1;
  }
  return {
    matchId: r.matchId,
    factions: r.factions,
    players: r.players,
    winner: r.result.winner,
    bases: r.result.bases,
    mined: r.result.mined,
    durationSec: Math.round(r.result.ticks / tickRate),
    playCounts: counts,
    baseBuilds: bases,
    techUnlocks: techs,
    unitUsage: usage,
  };
}
