/**
 * 아레나 지형 정의.
 *
 * 좌표계: 왼쪽 위가 (0,0). y가 커질수록 아래(팀 0 진영).
 *   - 팀 0 = 아래쪽(로컬 플레이어 기준 "내 진영")
 *   - 팀 1 = 위쪽
 *
 * 모든 값은 밀리타일 정수.
 */

import { tiles } from './fixed.js';

export const ARENA_W_TILES = 18;
export const ARENA_H_TILES = 32;

export const ARENA_W = tiles(ARENA_W_TILES);
export const ARENA_H = tiles(ARENA_H_TILES);

/** 강: y ∈ [RIVER_TOP, RIVER_BOT) 은 다리 위가 아니면 통과 불가 */
export const RIVER_TOP = tiles(15);
export const RIVER_BOT = tiles(17);
export const RIVER_MID = tiles(16);

/** 다리 중심 x좌표 (좌 레인 = 0, 우 레인 = 1) */
export const BRIDGE_X: readonly [number, number] = [tiles(4), tiles(14)];
/** 다리 반폭 — 이 안에 있으면 강을 건널 수 있다 */
export const BRIDGE_HALF_W = tiles(1);

export type Team = 0 | 1;
export type Lane = 0 | 1;

export interface TowerSpot {
  team: Team;
  kind: 'king' | 'princess';
  lane: Lane | -1;
  x: number;
  y: number;
}

/** 타워 배치. 순서가 곧 엔티티 ID 순서가 되므로 절대 바꾸지 말 것 (결정론). */
export const TOWER_SPOTS: readonly TowerSpot[] = [
  { team: 1, kind: 'princess', lane: 0, x: tiles(3.5), y: tiles(6.5) },
  { team: 1, kind: 'princess', lane: 1, x: tiles(14.5), y: tiles(6.5) },
  { team: 1, kind: 'king', lane: -1, x: tiles(9), y: tiles(3) },
  { team: 0, kind: 'princess', lane: 0, x: tiles(3.5), y: tiles(25.5) },
  { team: 0, kind: 'princess', lane: 1, x: tiles(14.5), y: tiles(25.5) },
  { team: 0, kind: 'king', lane: -1, x: tiles(9), y: tiles(29) },
];

/** 점이 강 안(다리 제외)에 있는가 */
export function inRiver(x: number, y: number): boolean {
  if (y < RIVER_TOP || y >= RIVER_BOT) return false;
  return !onBridge(x);
}

/** x좌표가 다리 위인가 */
export function onBridge(x: number): boolean {
  for (const bx of BRIDGE_X) {
    if (x >= bx - BRIDGE_HALF_W && x <= bx + BRIDGE_HALF_W) return true;
  }
  return false;
}

/** 목표로 가려면 강을 건너야 하는가 */
export function mustCross(fromY: number, toY: number): boolean {
  return fromY < RIVER_MID !== toY < RIVER_MID;
}

/** x좌표에서 가장 가까운 레인 */
export function nearestLane(x: number): Lane {
  return Math.abs(x - BRIDGE_X[0]) <= Math.abs(x - BRIDGE_X[1]) ? 0 : 1;
}

/**
 * 배치 가능 구역 판정.
 *
 * 기본: 자기 진영(강 이쪽 편)에만. 단 강 바로 앞 1타일은 금지해서
 * "다리 코앞 배치"로 방어를 스킵하는 것을 막는다.
 *
 * 상대 공주탑을 파괴했다면 그 레인의 적 진영 절반(강 건너 ~ 적 공주탑 라인)까지 열린다.
 */
export function canDeploy(
  team: Team,
  x: number,
  y: number,
  enemyPrincessDown: readonly [boolean, boolean],
): boolean {
  if (x < 0 || x >= ARENA_W || y < 0 || y >= ARENA_H) return false;
  if (y >= RIVER_TOP && y < RIVER_BOT) return false; // 강 위 금지

  const ownHalf = team === 0 ? y >= RIVER_BOT : y < RIVER_TOP;
  if (ownHalf) return true;

  // 적 진영 — 해당 레인의 적 공주탑이 파괴된 경우에만
  const lane = nearestLane(x);
  if (!enemyPrincessDown[lane]) return false;

  // 레인 절반 폭 안쪽으로 제한
  const inLaneX = lane === 0 ? x < ARENA_W / 2 : x >= ARENA_W / 2;
  if (!inLaneX) return false;

  // 적 진영 중에서도 적 공주탑 라인까지만 (킹타워 앞마당은 금지)
  return team === 0 ? y >= tiles(6.5) : y <= tiles(25.5);
}
