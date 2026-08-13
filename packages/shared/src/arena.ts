/**
 * 아레나 지형과 기지 지점 — 맵 레지스트리.
 *
 * 좌표계: 왼쪽 위가 (0,0). y가 커질수록 아래(팀 0 진영).
 *   - 팀 0 = 아래쪽 (로컬 플레이어 기준 "내 진영")
 *   - 팀 1 = 위쪽
 *
 * 모든 맵은 지형을 **절반만 정의**하고 점대칭으로 복제한다. 중심은
 * ((W-1)/2, (H-1)/2), 변환 (x,y) → (W-1-x, H-1-y). 손으로 양쪽을 적으면
 * 반드시 어긋나고, 어긋난 맵은 밸런스를 논할 수 없다.
 *
 * 활성 맵은 setActiveMap()으로 바뀐다 — createState/step이 GameState의
 * mapId로 이걸 호출하므로, 단일 스레드에서 서로 다른 맵의 경기를
 * 번갈아 시뮬레이션해도 안전하다. 모든 값은 밀리타일 정수.
 */

import { BASE_SNAP_RADIUS, DEPLOY_RADIUS } from './constants.js';
import { dist2, tiles } from './fixed.js';

export const ARENA_W_TILES = 48;
export const ARENA_H_TILES = 48;

export const ARENA_W = tiles(ARENA_W_TILES);
export const ARENA_H = tiles(ARENA_H_TILES);

export type Team = 0 | 1;

type Rect = readonly [number, number, number, number];

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


/** 맵 정의 — 지형 절반 + 지점 전체 (지점은 손으로 대칭을 맞춰 적는다) */
export interface MapDef {
  id: string;
  name: string;
  /** 설계 한 줄 — 맵 선택 UI에 보여준다 */
  tagline: string;
  walls: readonly Rect[];
  waters: readonly Rect[];
  highs: readonly Rect[];
  sites: readonly BaseSite[];
}

/* ══════════════ 맵 1 — 쌍둥이 해안 (coast) ══════════════
   로스트템플 문법: 본진 고지 주머니 → 램프 밑 앞마당 → 서·동쪽 바다와
   섬. 공격로는 정면 하나로 압축된다. */

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
  // ── 본진 주머니 — 직사각형이 아니라 계단식 블롭. 램프는 남쪽 (4~5,12)
  //    하나이고, 램프 바로 아래에 앞마당이 있다 (로스트템플 문법) ──
  [10, 0, 10, 3],
  [11, 3, 11, 5],
  [10, 5, 10, 7],
  [8, 8, 8, 9],
  [6, 10, 6, 11],
  [6, 12, 7, 12],
  // 램프 x2~5 — 4타일(2부대 동시 통과). 2타일이었을 때는 방어 건물
  // 하나(충돌 반경 ~2타일)로 입구가 완전 봉쇄돼 본진이 섬이 됐다
  // (실전 2인 플레이에서 관측 — 라운드 13)
  [0, 12, 1, 12],
  //    앞마당 뒷길 봉쇄 — 주머니 벽과 서쪽 바다를 절벽으로 잇는다.
  //    로스트템플 문법: 앞마당은 정면(벌판) 한쪽으로만 열린다
  [0, 13, 1, 14],
  [0, 15, 1, 15],

  // ── 중앙 고원 — 팔각 블롭 테두리. 변의 가운데만 뚫린 램프 ──
  [20, 20, 20, 20],
  [21, 19, 22, 19],
  [25, 19, 26, 19],
  [19, 21, 19, 22],
  [19, 25, 19, 26],

  // ── 대각 능선 — 본진과 중앙 사이의 시야 가림 + 우회로 강제 ──
  [17, 12, 18, 12],
  [18, 13, 19, 13],
  [19, 14, 20, 14],

  // ── 측면 가림막 ──
  [33, 10, 33, 16],
  [34, 16, 34, 18],

  // ── 흩어진 바위 ──
  [24, 6, 25, 7],
  [8, 22, 9, 23],
  [16, 30, 17, 31],
  [30, 21, 31, 21],

  // ── 확장지 엄폐물 ──
  [10, 17, 10, 19],
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
  // ── 서쪽 바다 — 행마다 물가 폭이 다른 계단식 블롭 (§MAP_RULES 1.1:
  //    수역도 사각형으로 정의하지 않는다). 섬을 감싼다 ──
  [0, 16, 3, 16],
  [0, 17, 4, 17],
  [0, 18, 5, 18],
  [0, 19, 4, 19],
  //    섬 둘레 고리 — 가운데 구멍이 섬이다
  [0, 20, 0, 23],
  [4, 20, 4, 23],
  //    섬 모서리 깎기 — 섬도 사각형이 아니라 십자 블롭
  [1, 20, 1, 20],
  [3, 20, 3, 20],
  [1, 23, 1, 23],
  [3, 23, 3, 23],
  [0, 24, 5, 24],
  [0, 25, 4, 25],
  [0, 26, 4, 26],
  [0, 27, 5, 27],
  [0, 28, 4, 28],
  [0, 29, 3, 29],
  [0, 30, 2, 30],
  // ── 북쪽 중앙 만 — 가장자리에서 넓고 안으로 좁아지는 부채꼴 ──
  [19, 0, 27, 0],
  [20, 1, 27, 1],
  [20, 2, 26, 2],
  [22, 3, 25, 3],
  // ── 벌판 남서쪽 웅덩이 — 마름모꼴 ──
  [10, 31, 12, 31],
  [9, 32, 13, 32],
  [9, 33, 12, 33],
  [10, 34, 11, 34],
];

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
  // 본진 주머니 — 계단식 블롭 (모서리로 갈수록 좁아진다)
  [0, 0, 9, 7],
  [0, 8, 7, 9],
  [0, 10, 5, 11],
  // 중앙 고원 — 팔각 블롭
  [21, 19, 26, 19],
  [20, 20, 27, 20],
  [19, 21, 28, 26],
  [20, 27, 27, 27],
  [21, 28, 26, 28],
];

const COAST_SITES: readonly BaseSite[] = [
  { id: 0, x: tiles(5), y: tiles(5), startFor: 1, label: '위 본진' },
  { id: 1, x: tiles(19), y: tiles(5), startFor: -1, label: '위 우측' },
  { id: 2, x: tiles(5), y: tiles(15), startFor: -1, label: '위 앞마당' },
  { id: 3, x: tiles(21), y: tiles(22), startFor: -1, label: '중앙 위' },
  { id: 4, x: tiles(26), y: tiles(25), startFor: -1, label: '중앙 아래' },
  { id: 5, x: tiles(42), y: tiles(32), startFor: -1, label: '아래 앞마당' },
  { id: 6, x: tiles(28), y: tiles(42), startFor: -1, label: '아래 좌측' },
  { id: 7, x: tiles(42), y: tiles(42), startFor: 0, label: '아래 본진' },
  { id: 8, x: tiles(2), y: tiles(21), startFor: -1, label: '서쪽 섬' },
  { id: 9, x: tiles(45), y: tiles(26), startFor: -1, label: '동쪽 섬' },
  // 앞마당과 중앙 사이의 디딤돌 — 중앙 사슬이 여기서 열린다
  { id: 10, x: tiles(13), y: tiles(19), startFor: -1, label: '위 어귀' },
  { id: 11, x: tiles(34), y: tiles(28), startFor: -1, label: '아래 어귀' },
];

const COAST: MapDef = {
  id: 'coast',
  name: '쌍둥이 해안',
  tagline: '바다가 등을 지켜주는 정면 승부',
  walls: WALL_RECTS,
  waters: WATER_RECTS,
  highs: HIGH_RECTS,
  sites: COAST_SITES,
};

/* ══════════════ 맵 2 — 대협곡 (rift) ══════════════
   본진은 북동·남서 코너. 맵을 대각선으로 가르는 협곡이 지상을 두 다리로
   몰아넣고, 공중에게 지름길을 준다. 다리 싸움의 맵. */

function riftWaters(): Rect[] {
  const out: [number, number, number, number][] = [];
  // 대각 협곡 — 행마다 물가 폭이 출렁인다 (§MAP_RULES 1.1 블롭 규칙).
  // 18~20행은 절개 = 북다리 (점대칭 거울로 27~29행이 남다리가 된다)
  for (let y = 0; y <= 23; y++) {
    if (y >= 18 && y <= 20) continue;
    const w1 = (y * 5) % 3;
    const w2 = ((y + 1) * 7) % 3;
    out.push([Math.max(0, y - 1 - w1), y, Math.min(47, y + 1 + w2), y]);
  }
  // 북동 섬 호수 — 링만 물이고 가운데 십자 섬(중심 37,21)이 남는다
  out.push(
    [35, 19, 39, 19],
    [35, 23, 39, 23],
    [35, 20, 35, 22],
    [39, 20, 39, 22],
    [36, 20, 36, 20],
    [38, 20, 38, 20],
    [36, 22, 36, 22],
    [38, 22, 38, 22],
  );
  return out;
}

const RIFT_WALLS: readonly Rect[] = [
  // ── 북동 본진 주머니 — 서쪽 램프 하나 (37, 2~5 · 4타일 폭) ──
  [37, 0, 37, 1],
  [37, 6, 37, 8],
  [38, 8, 41, 8],
  [42, 9, 44, 9],
  [45, 9, 47, 9],
  // ── 앞마당 엄폐물 ──
  [29, 8, 30, 8],
  [38, 12, 38, 14],
  // ── 다리 어귀 능선 — 다리로 가는 길을 굽힌다 ──
  [22, 10, 23, 11],
  [28, 21, 29, 21],
  // ── 흩어진 바위 ──
  [20, 6, 21, 7],
  [9, 12, 10, 13],
  [44, 20, 45, 21],
];

const RIFT_HIGHS: readonly Rect[] = [
  // 북동 본진 고지 블롭
  [38, 0, 47, 7],
  // 북다리 어귀 고원 — 다리를 내려다보는 다툼의 땅
  [24, 14, 28, 17],
];

const RIFT_SITES: readonly BaseSite[] = [
  { id: 0, x: tiles(42), y: tiles(5), startFor: 1, label: '북동 본진' },
  { id: 1, x: tiles(32), y: tiles(5), startFor: -1, label: '북동 앞마당' },
  { id: 2, x: tiles(42), y: tiles(15), startFor: -1, label: '북동 남마당' },
  { id: 3, x: tiles(26), y: tiles(16), startFor: -1, label: '북다리 어귀' },
  { id: 4, x: tiles(21), y: tiles(31), startFor: -1, label: '남다리 어귀' },
  { id: 5, x: tiles(5), y: tiles(32), startFor: -1, label: '남서 북마당' },
  { id: 6, x: tiles(15), y: tiles(42), startFor: -1, label: '남서 앞마당' },
  { id: 7, x: tiles(5), y: tiles(42), startFor: 0, label: '남서 본진' },
  { id: 8, x: tiles(10), y: tiles(26), startFor: -1, label: '남서 섬' },
  { id: 9, x: tiles(37), y: tiles(21), startFor: -1, label: '북동 섬' },
];

const RIFT: MapDef = {
  id: 'rift',
  name: '대협곡',
  tagline: '두 다리를 두고 다투는 협곡전',
  walls: RIFT_WALLS,
  waters: riftWaters(),
  highs: RIFT_HIGHS,
  sites: RIFT_SITES,
};

/* ══════════════ 레지스트리와 활성 맵 ══════════════ */

export const MAPS: readonly MapDef[] = [COAST, RIFT];
export const DEFAULT_MAP_ID = COAST.id;

export function getMap(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? COAST;
}

/** 절반 정의 → 점대칭 복제된 전체 목록 */
function mirrored(halves: readonly Rect[]): readonly Rect[] {
  const out: Rect[] = [];
  for (const [x0, y0, x1, y1] of halves) {
    out.push([x0, y0, x1, y1]);
    out.push([
      ARENA_W_TILES - 1 - x1,
      ARENA_H_TILES - 1 - y1,
      ARENA_W_TILES - 1 - x0,
      ARENA_H_TILES - 1 - y0,
    ]);
  }
  return out;
}

interface Compiled {
  walls: readonly Rect[];
  waters: readonly Rect[];
  highs: readonly Rect[];
}

function compile(m: MapDef): Compiled {
  return { walls: mirrored(m.walls), waters: mirrored(m.waters), highs: mirrored(m.highs) };
}

let active = compile(COAST);

/** 점대칭 복제된 전체 목록 — 활성 맵의 것. setActiveMap이 갈아 끼운다 */
export let WALLS: readonly Rect[] = active.walls;
export let WATERS: readonly Rect[] = active.waters;
export let HIGHS: readonly Rect[] = active.highs;
export let BASE_SITES: readonly BaseSite[] = COAST.sites;
export let ACTIVE_MAP_ID: string = COAST.id;

/** 활성 맵이 바뀔 때마다 1 증가 — nav 캐시 무효화용 */
let version = 0;
export function mapVersion(): number {
  return version;
}

export function setActiveMap(id: string): void {
  if (id === ACTIVE_MAP_ID) return;
  const m = getMap(id);
  if (m.id === ACTIVE_MAP_ID) return;
  active = compile(m);
  WALLS = active.walls;
  WATERS = active.waters;
  HIGHS = active.highs;
  BASE_SITES = m.sites;
  ACTIVE_MAP_ID = m.id;
  version++;
}

/** 타일이 협곡(물)인가 (렌더 구분용 — 이동 차단은 blockedTile이 겸한다) */
export function waterTile(tx: number, ty: number): boolean {
  for (const [x0, y0, x1, y1] of WATERS) {
    if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) return true;
  }
  return false;
}

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
