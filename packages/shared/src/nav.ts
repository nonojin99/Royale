/**
 * 지형과 길찾기.
 *
 * 지금까지 이동은 "강을 건너야 하면 가까운 다리로"라는 하드코딩이었다. 강 하나에
 * 다리 둘이라는 특정 지형에만 맞는 방식이라, 언덕·입구·좁은 길이 생기는 순간
 * 못 쓴다. 여기서 지형을 **데이터로** 두고 그 위에서 길을 찾는다. 그러면 맵을
 * 바꾸는 일이 코드가 아니라 데이터를 바꾸는 일이 된다.
 *
 * ── 왜 흐름장(flow field)인가 ──────────────────────────────────────────
 * 지형은 경기 내내 변하지 않는다. 그래서 **목적지마다 거리장을 한 번만 계산해
 * 두고** 유닛은 자기 칸에서 이웃 칸 중 거리가 가장 작은 쪽으로 한 발 내딛으면
 * 된다. 유닛 수가 늘어도 유닛당 비용은 상수다. 유닛마다 A*를 돌리면 후반
 * 교전에서 그대로 무너진다.
 *
 * ── 결정론 ─────────────────────────────────────────────────────────────
 * 거리장은 지형 상수만으로 결정되는 **순수 함수**다. 그래서 시뮬 상태에 넣지
 * 않고 모듈 캐시에 둔다. 상태 해시가 커지지 않고, 스냅샷에도 실리지 않으며,
 * 모든 클라이언트가 같은 값을 얻는다.
 *
 * 다익스트라는 정수 비용(직선 10 · 대각 14)만 쓰고, 같은 거리일 때는 항상
 * `DIRS` 순서로 먼저 나온 방향을 택한다. 부동소수점도 없고 순서 의존도 없다.
 */

import { ARENA_H_TILES, ARENA_W_TILES, blockedTile, mapVersion } from './arena.js';
import { SCALE } from './fixed.js';

const W = ARENA_W_TILES;
const H = ARENA_H_TILES;
/** 도달 불가 */
const INF = 0x7fffffff;

/** 직선 4방향을 먼저, 대각 4방향을 나중에 — 동률일 때 직선을 선호한다 */
const DIRS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];
const COST: readonly number[] = [10, 10, 10, 10, 14, 14, 14, 14];

/**
 * 통행 불가 지형. 0 = 통행 가능, 1 = 막힘.
 *
 * 지형 정의는 `arena.ts`의 활성 맵이 전부 갖고 있다. 여기서는 그걸 격자로
 * 펼치기만 한다. **활성 맵이 바뀌면 격자와 거리장 캐시를 다시 만든다** —
 * 이걸 빼먹으면 길찾기가 이전 맵의 지형으로 걷는다 (맵 레지스트리 도입
 * 때 실측: 섬이 닫혀 있는데 nav만 뚫려 있었다).
 */
export let TERRAIN: Uint8Array = new Uint8Array(W * H);
let terrainVersion = -1;

/**
 * 동적 장애물 — 방어 건물이 차지한 타일 (라운드 29 "방벽 = 지형").
 *
 * 지형과 달리 경기 중에 변한다. 시뮬이 매 틱 건물 목록에서 파생해 넣어주고
 * (setBlockers), 바뀐 순간에만 거리장 캐시를 버린다. 시뮬 상태에서 파생된
 * 값이므로 모든 클라이언트가 같은 격자를 갖는다 — 결정론은 그대로다.
 *
 * 이 레이어가 있어야 "터렛 놓기"가 "성 설계"가 된다: 파도가 방벽을 돌아
 * 긴 사선으로 유도되고, 그 사선에 화력을 배치하는 것이 전략이 된다.
 */
let BLOCKERS: Uint8Array = new Uint8Array(W * H);
let blockerSig = 0;

/**
 * 건물 점유 타일을 갈아끼운다. `sig`가 같으면 아무것도 하지 않는다 —
 * 매 틱 호출되므로 변화가 없을 때 거리장을 버리면 안 된다.
 */
export function setBlockers(tiles: readonly number[], sig: number): void {
  if (sig === blockerSig) return;
  blockerSig = sig;
  const g = new Uint8Array(W * H);
  for (const t of tiles) if (t >= 0 && t < g.length) g[t] = 1;
  BLOCKERS = g;
  fields.clear();
}

/** 타일 인덱스 (경계 밖은 -1) */
export function tileIndex(tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return -1;
  return ty * W + tx;
}

/**
 * `extra`를 추가로 막았다고 가정하고 sx,sy → gx,gy 경로가 남는지 본다.
 *
 * **완전 봉쇄 금지의 집행자**다 (스타의 규칙과 같다): 막다른 길과 미로는
 * 허용하되, 적이 내 본진에 닿는 길이 하나도 없어지는 배치는 거절한다.
 * 그게 없으면 방벽 도배로 게임이 정지한다.
 */
export function pathExists(
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  extra: readonly number[] = [],
): boolean {
  syncTerrain();
  const start = tileIndex(sx, sy);
  const goal = tileIndex(gx, gy);
  if (start < 0 || goal < 0) return false;
  const block = new Uint8Array(W * H);
  for (let i = 0; i < block.length; i++) block[i] = TERRAIN[i] | BLOCKERS[i];
  for (const t of extra) if (t >= 0 && t < block.length) block[t] = 1;
  if (block[start] === 1 || block[goal] === 1) return false;

  const seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === goal) return true;
    const cx = cur % W;
    const cy = (cur / W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d][0];
      const ny = cy + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (seen[ni] || block[ni]) continue;
      seen[ni] = 1;
      queue[tail++] = ni;
    }
  }
  return false;
}

function syncTerrain(): void {
  if (terrainVersion === mapVersion()) return;
  const g = new Uint8Array(W * H);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (blockedTile(tx, ty)) g[ty * W + tx] = 1;
    }
  }
  TERRAIN = g;
  fields.clear();
  terrainVersion = mapVersion();
}

export function tileX(x: number): number {
  const t = Math.floor(x / SCALE);
  return t < 0 ? 0 : t >= W ? W - 1 : t;
}

export function tileY(y: number): number {
  const t = Math.floor(y / SCALE);
  return t < 0 ? 0 : t >= H ? H - 1 : t;
}

export function walkable(tx: number, ty: number): boolean {
  syncTerrain();
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
  const i = ty * W + tx;
  return TERRAIN[i] === 0 && BLOCKERS[i] === 0;
}

/**
 * 대각선으로 지나갈 수 있는가.
 *
 * 두 직교 이웃이 모두 막혀 있으면 벽 모서리를 뚫고 지나가는 셈이 된다.
 * 다리 입구처럼 좁은 곳에서 유닛이 물 위로 새는 것을 막는다.
 */
function diagonalOk(tx: number, ty: number, dx: number, dy: number): boolean {
  if (dx === 0 || dy === 0) return true;
  return walkable(tx + dx, ty) && walkable(tx, ty + dy);
}

/** 목적지 타일 → 거리장. 지형 상수만으로 정해지므로 캐시해도 안전하다 */
const fields = new Map<number, Int32Array>();

/**
 * 목적지까지의 거리장을 만든다 (다익스트라).
 *
 * 타일이 576개뿐이라 우선순위 큐 없이 매번 최솟값을 훑어도 충분하다.
 * 단순한 쪽이 결정론을 보기에도 쉽다.
 */
function buildField(gx: number, gy: number): Int32Array {
  const dist = new Int32Array(W * H).fill(INF);
  const done = new Uint8Array(W * H);
  if (!walkable(gx, gy)) return dist;
  dist[gy * W + gx] = 0;

  for (;;) {
    // 아직 확정되지 않은 것 중 거리가 가장 작은 칸. 동률이면 인덱스가 작은 쪽
    let best = -1;
    let bestD = INF;
    for (let i = 0; i < dist.length; i++) {
      if (!done[i] && dist[i] < bestD) {
        bestD = dist[i];
        best = i;
      }
    }
    if (best < 0) break;
    done[best] = 1;

    const tx = best % W;
    const ty = (best / W) | 0;
    for (let d = 0; d < DIRS.length; d++) {
      const nx = tx + DIRS[d][0];
      const ny = ty + DIRS[d][1];
      if (!walkable(nx, ny)) continue;
      if (!diagonalOk(tx, ty, DIRS[d][0], DIRS[d][1])) continue;
      const ni = ny * W + nx;
      if (done[ni]) continue;
      const nd = bestD + COST[d];
      if (nd < dist[ni]) dist[ni] = nd;
    }
  }
  return dist;
}

function fieldFor(gx: number, gy: number): Int32Array {
  const key = gy * W + gx;
  let f = fields.get(key);
  if (!f) {
    f = buildField(gx, gy);
    fields.set(key, f);
  }
  return f;
}

/**
 * 막힌 목표 타일을 가장 가까운 통행 타일로 옮긴다.
 *
 * 물·벽 위를 목표로 받으면(타겟 없는 전진이 물가를 가리킬 때, 물 위의 공중
 * 유닛을 추격할 때) 거리장이 전부 INF가 되고, navStep이 직선 돌진으로
 * 후퇴해 유닛이 벽에 끼었다 (라운드 19 실전 보고 — 강철거인 낌).
 * 고정된 나선 순서로 첫 후보를 취하므로 결정론이 유지된다.
 */
function nearestWalkableTile(gx: number, gy: number): [number, number] {
  if (walkable(gx, gy)) return [gx, gy];
  const R = W > H ? W : H;
  for (let r = 1; r < R; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cheb = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy);
        if (cheb !== r) continue;
        if (walkable(gx + dx, gy + dy)) return [gx + dx, gy + dy];
      }
    }
  }
  return [gx, gy];
}

/**
 * (x, y)에서 목적지로 가기 위해 지금 향할 지점 (밀리타일).
 *
 * 목적지와 같은 칸이거나 길이 막혀 있으면 목적지를 그대로 돌려준다 — 그 경우
 * 호출부가 직선으로 향하게 되고, 그게 자연스럽다.
 */
export function navStep(
  x: number,
  y: number,
  goalX: number,
  goalY: number,
): [number, number] {
  let gx = tileX(goalX);
  let gy = tileY(goalY);
  const cx = tileX(x);
  const cy = tileY(y);
  if (cx === gx && cy === gy) return [goalX, goalY];
  // 막힌 목표는 곁의 통행 타일로 — 이미 그 타일에 서 있으면 제자리
  const [wx, wy] = nearestWalkableTile(gx, gy);
  if (wx !== gx || wy !== gy) {
    gx = wx;
    gy = wy;
    if (cx === gx && cy === gy) return [x, y];
  }

  const field = fieldFor(gx, gy);
  const here = field[cy * W + cx];
  // 지금 서 있는 칸이 막혀 있거나(배치 직후 등) 도달 불가면 직선으로 둔다
  if (here === INF) return [goalX, goalY];

  let bestD = here;
  let bx = -1;
  let by = -1;
  for (let d = 0; d < DIRS.length; d++) {
    const nx = cx + DIRS[d][0];
    const ny = cy + DIRS[d][1];
    if (!walkable(nx, ny)) continue;
    if (!diagonalOk(cx, cy, DIRS[d][0], DIRS[d][1])) continue;
    const nd = field[ny * W + nx];
    if (nd < bestD) {
      bestD = nd;
      bx = nx;
      by = ny;
    }
  }
  if (bx < 0) return [goalX, goalY];

  // 다음 칸이 목적지 칸이면 목적지 자체로 향한다 — 칸 중앙에 들렀다 가지 않게
  if (bx === gx && by === gy) return [goalX, goalY];
  return [bx * SCALE + SCALE / 2, by * SCALE + SCALE / 2];
}

/** 테스트·디버깅용 — 목적지까지의 거리(정수 비용). 도달 불가면 -1 */
export function navDistance(x: number, y: number, goalX: number, goalY: number): number {
  const f = fieldFor(tileX(goalX), tileY(goalY));
  const d = f[tileY(y) * W + tileX(x)];
  return d === INF ? -1 : d;
}
