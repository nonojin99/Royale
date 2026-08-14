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
  /** 원하는 맵 id — 솔로는 그대로, 2인 매칭은 먼저 온 쪽 선택을 따른다 */
  mapId?: string;
  /** 봇 난이도 (솔로 전용): 'easy' | 'normal' | 'hard'. 그 외 값은 중급 */
  botLevel?: string;
  /** 실험장 모드 (솔로 전용) — 봇 없이 양 팀 유닛을 자유 배치한다 */
  sandbox?: boolean;
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
  /** 실험장 전용 — 상대 팀(1)으로 배치. 일반 경기에서는 무시된다 */
  foe?: boolean;
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

/** 방 만들기 — 보낸 사람이 방장이 된다. hello 이후에 보낸다 */
export interface CCreateRoom {
  t: 'create-room';
}

/** 코드로 방 참가 */
export interface CJoinRoom {
  t: 'join-room';
  code: string;
}

/** 준비 토글 (손님 전용) */
export interface CReady {
  t: 'ready';
  ready: boolean;
}

/** 경기 시작 (방장 전용, 손님이 준비 상태여야 한다) */
export interface CStartRoom {
  t: 'start-room';
}

/**
 * 방 안에서 종족·맵 변경 (라운드 11.5 — 선택은 방 안에서 한다).
 * 종족은 각자, 맵은 방장 것만 반영된다. 변경은 room-state로 즉시 퍼진다.
 */
export interface CSetLoadout {
  t: 'set-loadout';
  factionId?: string;
  mapId?: string;
}

export type ClientMsg = CHello | CAct | CHash | CPing | CCreateRoom | CJoinRoom | CReady | CStartRoom | CSetLoadout;

/* ── 서버 → 클라이언트 ─────────────────────────────────────────────────── */

export interface SQueued {
  t: 'queued';
}

export interface SMatch {
  t: 'match';
  matchId: string;
  seed: number;
  /** 확정된 맵 id — 시뮬레이션은 이걸로 초기화된다 */
  mapId: string;
  /** 이 클라이언트가 맡은 팀 */
  team: Team;
  /** 양 팀의 종족 id — 시뮬레이션은 이걸로 초기화된다 */
  factions: [string, string];
  opponent: string;
  /** 서버가 틱 0을 시작한 벽시계 시각 (ms) */
  startWallMs: number;
  /** 실험장 경기 — 클라이언트도 같은 규칙으로 시뮬해야 한다 */
  sandbox?: boolean;
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

/** 방 상태 — 만들기/참가/준비/퇴장 때마다 양쪽에 브로드캐스트 */
export interface SRoomState {
  t: 'room-state';
  code: string;
  /** 이 클라이언트가 방장인가 */
  host: boolean;
  mapId: string;
  players: {
    name: string;
    factionId: string;
    ready: boolean;
    host: boolean;
  }[];
}

export interface SRoomError {
  t: 'room-error';
  reason: 'no-room' | 'full' | 'not-host' | 'not-ready' | 'already-in-room';
}

export type ServerMsg =
  | SRoomState
  | SRoomError
  | SQueued
  | SMatch
  | SCmd
  | SReject
  | SPong
  | SResync
  | SOver
  | SOpponentLeft;
