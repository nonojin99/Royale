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

export const ARENA_W_TILES = 24;
export const ARENA_H_TILES = 24;

export const ARENA_W = tiles(ARENA_W_TILES);
export const ARENA_H = tiles(ARENA_H_TILES);

export type Team = 0 | 1;

/**
 * 벽 — 지상 유닛이 통과할 수 없는 타일.
 *
 * `[x0, y0, x1, y1]` 양끝 포함. **절반만 적고 나머지는 점대칭으로 자동
 * 생성한다** — 손으로 양쪽을 적으면 반드시 어긋나고, 대칭이 어긋난 맵은
 * 밸런스를 논할 수 없게 된다.
 *
 * 점대칭 축은 맵 중심 (11.5, 11.5). 즉 (x, y) → (23-x, 23-y).
 *
 * 설계 의도:
 *   1. 본진은 입구가 하나 — 초반에 지킬 수 있어야 확장할 엄두가 난다
 *   2. 중앙은 네 모서리로만 들어가는 고지 — 다툴 이유가 있는 곳
 *   3. 측면에 가림막 — 우회로가 한눈에 안 보여야 심리전이 산다
 */
const WALL_RECTS: readonly (readonly [number, number, number, number])[] = [
  // 본진을 감싸는 벽. 출구는 남쪽 (5~6, 7) 한 곳뿐이라 초반 방어선이 명확하다.
  // 대각선(본진↔본진 최단선) 위에 구멍을 두지 않는 것이 핵심 — 구멍이
  // 대각선에 걸리면 벽이 있으나 마나가 된다.
  [6, 0, 6, 6],
  [0, 7, 4, 7],
  // 중앙 고지를 두르는 벽. 네 변의 **가운데**만 뚫려 있어 모서리로 새지 못한다
  [9, 9, 10, 9],
  [13, 9, 14, 9],
  [9, 10, 9, 10],
  [9, 13, 9, 13],
  // 측면 가림막 — 우회로가 한눈에 안 보이게
  [17, 6, 17, 9],
  // 중앙 상단 바위
  [11, 3, 12, 4],
];

/** 점대칭으로 복제한 전체 벽 목록 */
export const WALLS: readonly (readonly [number, number, number, number])[] = (() => {
  const out: [number, number, number, number][] = [];
  for (const [x0, y0, x1, y1] of WALL_RECTS) {
    out.push([x0, y0, x1, y1]);
    // (x,y) → (23-x, 23-y) 이므로 사각형은 양 끝점이 뒤집힌다
    out.push([
      ARENA_W_TILES - 1 - x1,
      ARENA_H_TILES - 1 - y1,
      ARENA_W_TILES - 1 - x0,
      ARENA_H_TILES - 1 - y0,
    ]);
  }
  return out;
})();

/** 타일이 벽인가 */
export function blockedTile(tx: number, ty: number): boolean {
  for (const [x0, y0, x1, y1] of WALLS) {
    if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) return true;
  }
  return false;
}

/** 밀리타일 좌표가 벽 위인가 */
export function blockedAt(x: number, y: number): boolean {
  return blockedTile(Math.floor(x / 1000), Math.floor(y / 1000));
}

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
  { id: 0, x: tiles(3), y: tiles(3), startFor: 1, label: '위 본진' },
  { id: 1, x: tiles(20), y: tiles(3), startFor: -1, label: '위 우측' },
  { id: 2, x: tiles(3), y: tiles(10), startFor: -1, label: '위 앞마당' },
  { id: 3, x: tiles(13), y: tiles(11), startFor: -1, label: '중앙 위' },
  { id: 4, x: tiles(10), y: tiles(12), startFor: -1, label: '중앙 아래' },
  { id: 5, x: tiles(20), y: tiles(13), startFor: -1, label: '아래 앞마당' },
  { id: 6, x: tiles(3), y: tiles(20), startFor: -1, label: '아래 좌측' },
  { id: 7, x: tiles(20), y: tiles(20), startFor: 0, label: '아래 본진' },
];

/** 아레나 안쪽인가 */
export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < ARENA_W && y >= 0 && y < ARENA_H;
}

/**
 * 유닛 배치 가능 여부.
 *
 * 자기 기지 반경 안이면 어디든 가능하다. 벽 위는 안 된다.
 * `ownBases`는 살아 있고 건설이 끝난 자기 기지의 좌표 목록.
 */
export function canDeployAt(
  x: number,
  y: number,
  ownBases: readonly (readonly [number, number])[],
): boolean {
  if (!inBounds(x, y)) return false;
  if (blockedAt(x, y)) return false;
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
