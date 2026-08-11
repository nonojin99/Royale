/**
 * 아레나 지형과 기지 지점.
 *
 * 좌표계: 왼쪽 위가 (0,0). y가 커질수록 아래(팀 0 진영).
 *   - 팀 0 = 아래쪽 (로컬 플레이어 기준 "내 진영")
 *   - 팀 1 = 위쪽
 *
 * 모든 값은 밀리타일 정수.
 */

import { BASE_SNAP_RADIUS, DEPLOY_RADIUS } from './constants.js';
import { dist2, tiles } from './fixed.js';

export const ARENA_W_TILES = 18;
export const ARENA_H_TILES = 32;

export const ARENA_W = tiles(ARENA_W_TILES);
export const ARENA_H = tiles(ARENA_H_TILES);

/** 강: y ∈ [RIVER_TOP, RIVER_BOT) 은 다리 위가 아니면 지상 유닛이 통과할 수 없다 */
export const RIVER_TOP = tiles(15);
export const RIVER_BOT = tiles(17);
export const RIVER_MID = tiles(16);

/** 다리 중심 x좌표 (좌 레인 = 0, 우 레인 = 1) */
export const BRIDGE_X: readonly [number, number] = [tiles(4), tiles(14)];
/** 다리 반폭 — 이 안에 있으면 강을 건널 수 있다 */
export const BRIDGE_HALF_W = tiles(1);

export type Team = 0 | 1;
export type Lane = 0 | 1;

/**
 * 기지를 세울 수 있는 지점.
 *
 * 시작 본진 2곳 외의 6곳은 **누구나** 차지할 수 있다. 상대 앞마당에 몰래
 * 확장하는 것도 규칙상 가능하며, 그게 이 게임의 심리전 축이다.
 *
 * 배열 순서가 곧 엔티티 생성 순서(=id)가 되므로 절대 바꾸지 말 것 (결정론).
 */
export interface BaseSite {
  id: number;
  x: number;
  y: number;
  /** 시작 본진이면 그 팀, 아니면 -1 */
  startFor: Team | -1;
  /** UI 표기용 이름 */
  label: string;
}

export const BASE_SITES: readonly BaseSite[] = [
  { id: 0, x: tiles(9), y: tiles(4), startFor: 1, label: '위 본진' },
  { id: 1, x: tiles(3), y: tiles(8), startFor: -1, label: '위 좌측' },
  { id: 2, x: tiles(15), y: tiles(8), startFor: -1, label: '위 우측' },
  { id: 3, x: tiles(9), y: tiles(12), startFor: -1, label: '위 전진' },
  { id: 4, x: tiles(9), y: tiles(20), startFor: -1, label: '아래 전진' },
  { id: 5, x: tiles(3), y: tiles(24), startFor: -1, label: '아래 좌측' },
  { id: 6, x: tiles(15), y: tiles(24), startFor: -1, label: '아래 우측' },
  { id: 7, x: tiles(9), y: tiles(28), startFor: 0, label: '아래 본진' },
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

/** 아레나 안쪽인가 */
export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < ARENA_W && y >= 0 && y < ARENA_H;
}

/**
 * 유닛 배치 가능 여부.
 *
 * 자기 기지 반경 안이면 어디든 가능하다. 강 위는 안 된다.
 * `ownBases`는 살아 있고 건설이 끝난 자기 기지의 좌표 목록.
 */
export function canDeployAt(
  x: number,
  y: number,
  ownBases: readonly (readonly [number, number])[],
): boolean {
  if (!inBounds(x, y)) return false;
  if (inRiver(x, y)) return false;
  const r2 = DEPLOY_RADIUS * DEPLOY_RADIUS;
  for (const [bx, by] of ownBases) {
    if (dist2(x, y, bx, by) <= r2) return true;
  }
  return false;
}

/**
 * 클릭 지점에서 가장 가까운 기지 지점을 찾는다.
 * `occupied`에 있는 id는 이미 누군가 차지한 곳이라 제외한다.
 * 동률이면 id가 작은 쪽 (결정론).
 */
export function nearestFreeSite(
  x: number,
  y: number,
  occupied: ReadonlySet<number>,
): BaseSite | null {
  let best: BaseSite | null = null;
  let bestD2 = BASE_SNAP_RADIUS * BASE_SNAP_RADIUS;
  for (const site of BASE_SITES) {
    if (occupied.has(site.id)) continue;
    const d2 = dist2(x, y, site.x, site.y);
    if (d2 <= bestD2 && (best === null || d2 < bestD2)) {
      bestD2 = d2;
      best = site;
    }
  }
  return best;
}

export function getSite(id: number): BaseSite {
  const s = BASE_SITES[id];
  if (!s) throw new Error(`unknown base site: ${id}`);
  return s;
}
