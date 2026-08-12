/**
 * 클라이언트 ↔ 서버 메시지 정의.
 *
 * v1은 JSON을 쓴다. 이 장르는 초당 몇 개의 짧은 메시지만 오가므로 대역폭이
 * 병목이 아니고, 디버깅 편의가 훨씬 중요하다.
 */

import type { Team } from './arena.js';
import type { CommandKind, GameState } from './sim.js';

/* ── 클라이언트 → 서버 ─────────────────────────────────────────────────── */

export interface CHello {
  t: 'hello';
  name: string;
  /** 사용할 종족 id. 없거나 알 수 없는 값이면 서버가 기본 종족으로 떨어뜨린다. */
  factionId?: string;
}

/**
 * 행동 요청. 세 종류가 한 메시지에 담긴다.
 *   kind='unit' — id 유닛을 (x,y)에 생산
 *   kind='base' — (x,y)에서 가장 가까운 빈 지점에 기지 건설
 *   kind='tech' — id 유닛을 해금 (좌표 무시)
 */
export interface CAct {
  t: 'act';
  reqTick: number;
  kind: CommandKind;
  id: string;
  x: number;
  y: number;
}

/** 데스싱크 감지용 상태 해시 */
export interface CHash {
  t: 'hash';
  tick: number;
  hash: number;
}

export interface CPing {
  t: 'ping';
  ts: number;
}

export type ClientMsg = CHello | CAct | CHash | CPing;

/* ── 서버 → 클라이언트 ─────────────────────────────────────────────────── */

export interface SQueued {
  t: 'queued';
}

export interface SMatch {
  t: 'match';
  matchId: string;
  seed: number;
  /** 이 클라이언트가 맡은 팀 */
  team: Team;
  /** 양 팀의 종족 id — 시뮬레이션은 이걸로 초기화된다 */
  factions: [string, string];
  opponent: string;
  /** 서버가 틱 0을 시작한 벽시계 시각 (ms) */
  startWallMs: number;
}

/** 확정된 커맨드. 양쪽 클라에 동일하게 브로드캐스트된다. */
export interface SCmd {
  t: 'cmd';
  execTick: number;
  team: Team;
  kind: CommandKind;
  id: string;
  x: number;
  y: number;
}

/**
 * 요청이 거부됨 (본인에게만).
 *
 * ⚠️ 서버가 실제로 보내는 것은 'unknown-unit' / 'not-playing' 뿐이다.
 * 자원·해금·배치구역 위반은 execTick에 도달했을 때 세 곳(서버+양 클라)의
 * applyCommand가 각자 동일하게 무시하는 방식이라, 서버가 사후에 따로 알려주지
 * 않는다. 클라이언트는 전송 **전에** 같은 조건을 미리 검사해 즉시 피드백을 준다.
 */
export interface SReject {
  t: 'reject';
  reqTick: number;
  reason: 'unknown-unit' | 'not-playing' | 'no-minerals' | 'locked' | 'bad-zone' | 'no-site';
}

export interface SPong {
  t: 'pong';
  ts: number;
  serverTick: number;
}

/** 데스싱크 복구용 전체 상태 */
export interface SResync {
  t: 'resync';
  tick: number;
  state: GameState;
}

export interface SOver {
  t: 'over';
  winner: Team | -1;
  bases: [number, number];
  mined: [number, number];
  /** 이 경기의 리플레이 id — 종료 화면에서 바로 볼 수 있게 */
  replayId?: string;
}

export interface SOpponentLeft {
  t: 'opponent-left';
}

export type ServerMsg =
  | SQueued
  | SMatch
  | SCmd
  | SReject
  | SPong
  | SResync
  | SOver
  | SOpponentLeft;
