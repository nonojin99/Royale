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

export const ARENA_W_TILES = 48;
export const ARENA_H_TILES = 48;

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
  // ── 본진 주머니 (0..12, 0..13) — 출구는 남쪽 (10~12, 14) 한 곳 ──
  // 직선 한 줄 대신 짧은 조각을 계단처럼 어긋나게 쌓아 능선처럼 보이게 한다
  [13, 0, 13, 5],
  [14, 5, 14, 9],
  [13, 9, 13, 13],
  [0, 14, 4, 14],
  [4, 15, 7, 15],
  [7, 14, 9, 14],

  // ── 중앙 고원 (19..28, 19..28) 테두리 — 변의 가운데만 뚫린 램프 ──
  [19, 19, 21, 19],
  [26, 19, 28, 19],
  [19, 20, 19, 21],
  [19, 26, 19, 28],

  // ── 대각 능선 — 본진과 중앙 사이의 시야 가림 + 우회로 강제 ──
  [17, 12, 18, 12],
  [18, 13, 19, 13],
  [19, 14, 20, 14],

  // ── 측면 가림막 (오른쪽 위 지역) ──
  [33, 10, 33, 16],
  [34, 16, 34, 18],

  // ── 흩어진 바위 — 벌판이 밋밋하지 않게, 길을 살짝 굽히게 ──
  [24, 6, 25, 7],
  [8, 22, 9, 23],
  [16, 30, 17, 31],
  [30, 21, 31, 21],

  // ── 확장지 엄폐물 — 지점을 그냥 벌판에 두면 지킬 방법이 없다 ──
  // 앞마당(7,18) 동쪽 가림벽: 중앙 방면 접근을 좁힌다
  [10, 17, 10, 19],
  // 측면(19,5) 남쪽 조각: 중앙에서 오는 길을 굽힌다
  [22, 3, 22, 4],
];

/**
 * 협곡 — 지상 유닛이 **걸어서 못 가는** 필드. 공중 유닛은 그대로 넘는다.
 *
 * 스타크래프트의 바다·우주 공백과 같은 역할: 지상 병력을 길로 몰아넣고,
 * 공중 유닛에게 지름길이라는 존재 이유를 준다. 벽(절벽 메사)과 달리
 * 파인 지형이라 렌더러가 어둡게 그린다.
 */
const WATER_RECTS: readonly (readonly [number, number, number, number])[] = [
  // 서쪽 중앙의 큰 협곡 — 왼쪽 우회로를 지상에게 막고 공중에게만 연다
  [0, 20, 4, 27],
  // 벌판 남서쪽의 웅덩이 — 앞마당→중앙 행군로를 굽힌다
  [9, 31, 12, 34],
];

/** 점대칭 복제된 전체 협곡 목록 */
export const WATERS: readonly (readonly [number, number, number, number])[] = (() => {
  const out: [number, number, number, number][] = [];
  for (const [x0, y0, x1, y1] of WATER_RECTS) {
    out.push([x0, y0, x1, y1]);
    out.push([
      ARENA_W_TILES - 1 - x1,
      ARENA_H_TILES - 1 - y1,
      ARENA_W_TILES - 1 - x0,
      ARENA_H_TILES - 1 - y0,
    ]);
  }
  return out;
})();

/** 타일이 협곡인가 (렌더 구분용 — 이동 차단은 blockedTile이 겸한다) */
export function waterTile(tx: number, ty: number): boolean {
  for (const [x0, y0, x1, y1] of WATERS) {
    if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) return true;
  }
  return false;
}

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

/**
 * 고지 — 언덕 위 타일.
 *
 * 절반만 적고 벽과 같은 점대칭으로 복제한다. 고지는 **이동에는 영향이 없다**
 * (오르내림은 벽의 틈 = 램프로 이미 제한된다). 영향은 전투 한 가지다:
 * 저지대의 지상 유닛이 고지대를 때리면 데미지가 깎인다 (sim.ts).
 *
 * 본진 주머니와 중앙 고원이 고지다 — "본진 램프를 지키는 싸움"과
 * "중앙 고지를 다투는 싸움"이라는 RTS 문법을 만드는 장치.
 */
const HIGH_RECTS: readonly (readonly [number, number, number, number])[] = [
  // 본진 주머니 — 램프(출구) 직전까지
  [0, 0, 12, 13],
  // 중앙 고원
  [19, 19, 28, 28],
];

/** 점대칭 복제된 전체 고지 목록 */
export const HIGHS: readonly (readonly [number, number, number, number])[] = (() => {
  const out: [number, number, number, number][] = [];
  for (const [x0, y0, x1, y1] of HIGH_RECTS) {
    out.push([x0, y0, x1, y1]);
    out.push([
      ARENA_W_TILES - 1 - x1,
      ARENA_H_TILES - 1 - y1,
      ARENA_W_TILES - 1 - x0,
      ARENA_H_TILES - 1 - y0,
    ]);
  }
  return out;
})();

/** 타일 고도 — 0 저지 · 1 고지 */
export function elevTile(tx: number, ty: number): number {
  for (const [x0, y0, x1, y1] of HIGHS) {
    if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) return 1;
  }
  return 0;
}

/** 밀리타일 좌표의 고도 */
export function elevAt(x: number, y: number): number {
  return elevTile(Math.floor(x / 1000), Math.floor(y / 1000));
}

/** 타일이 벽(절벽 메사)인가 — 협곡과 달리 솟은 지형. 렌더 구분용 */
export function wallTile(tx: number, ty: number): boolean {
  for (const [x0, y0, x1, y1] of WALLS) {
    if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) return true;
  }
  return false;
}

/** 타일이 지상 통행 불가인가 — 벽(솟음)과 협곡(파임) 모두 */
export function blockedTile(tx: number, ty: number): boolean {
  return wallTile(tx, ty) || waterTile(tx, ty);
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
  { id: 0, x: tiles(6), y: tiles(6), startFor: 1, label: '위 본진' },
  { id: 1, x: tiles(19), y: tiles(5), startFor: -1, label: '위 우측' },
  { id: 2, x: tiles(7), y: tiles(18), startFor: -1, label: '위 앞마당' },
  { id: 3, x: tiles(21), y: tiles(22), startFor: -1, label: '중앙 위' },
  { id: 4, x: tiles(26), y: tiles(25), startFor: -1, label: '중앙 아래' },
  { id: 5, x: tiles(40), y: tiles(29), startFor: -1, label: '아래 앞마당' },
  { id: 6, x: tiles(28), y: tiles(42), startFor: -1, label: '아래 좌측' },
  { id: 7, x: tiles(41), y: tiles(41), startFor: 0, label: '아래 본진' },
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
