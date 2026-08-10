/**
 * 클라이언트 ↔ 서버 메시지 정의.
 *
 * v1은 JSON을 쓴다. 이 장르는 초당 1~2개의 짧은 메시지만 오가므로 대역폭이
 * 병목이 아니고, 디버깅 편의가 훨씬 중요하다. 바이너리 인코딩이 필요해지는
 * 시점은 관전자를 대규모로 붙일 때다.
 */

import type { Team } from './arena.js';
import type { GameState } from './sim.js';

/* ── 클라이언트 → 서버 ─────────────────────────────────────────────────── */

export interface CHello {
  t: 'hello';
  name: string;
}

/** 카드 배치 요청. x,y는 밀리타일. reqTick은 클라 시뮬 기준 시각(진단용). */
export interface CPlay {
  t: 'play';
  reqTick: number;
  card: string;
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

export type ClientMsg = CHello | CPlay | CHash | CPing;

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
  decks: [string[], string[]];
  opponent: string;
  /** 서버가 틱 0을 시작한 벽시계 시각 (ms) */
  startWallMs: number;
}

/** 확정된 커맨드. 양쪽 클라에 동일하게 브로드캐스트된다. */
export interface SCmd {
  t: 'cmd';
  execTick: number;
  team: Team;
  card: string;
  x: number;
  y: number;
}

/**
 * 요청이 거부됨 (본인에게만).
 *
 * ⚠️ 현재 서버가 실제로 보내는 것은 'unknown-card' / 'not-playing' 뿐이다.
 * 엘릭서·손패·배치구역 위반은 execTick에 도달했을 때 세 곳(서버+양 클라)의
 * applyCommand가 각자 동일하게 무시하는 방식이라, 서버가 사후에 따로 알려주지
 * 않는다. 클라이언트는 전송 **전에** 같은 조건을 미리 검사해 즉시 피드백을 준다.
 * 경합으로 사후 실패한 경우의 피드백은 M4 과제. (docs/NETCODE.md §5)
 */
export interface SReject {
  t: 'reject';
  reqTick: number;
  reason: 'not-in-hand' | 'no-elixir' | 'bad-zone' | 'not-playing' | 'unknown-card';
}

export interface SPong {
  t: 'pong';
  /** 클라가 보낸 ts를 그대로 돌려준다 */
  ts: number;
  /** 서버의 현재 권위 틱 */
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
  crowns: [number, number];
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
