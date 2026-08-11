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

import { ARENA_H_TILES, ARENA_W_TILES, inRiver, onBridge } from './arena.js';
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
 * 현재 맵에서는 다리를 뺀 강이 유일한 장애물이다. 새 맵을 넣을 때는 이 배열을
 * 만드는 방식만 바꾸면 되고, 아래 길찾기는 그대로 쓴다.
 */
export const TERRAIN: Uint8Array = (() => {
  const g = new Uint8Array(W * H);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const cx = tx * SCALE + SCALE / 2;
      const cy = ty * SCALE + SCALE / 2;
      if (inRiver(cx, cy) && !onBridge(cx)) g[ty * W + tx] = 1;
    }
  }
  return g;
})();

export function tileX(x: number): number {
  const t = Math.floor(x / SCALE);
  return t < 0 ? 0 : t >= W ? W - 1 : t;
}

export function tileY(y: number): number {
  const t = Math.floor(y / SCALE);
  return t < 0 ? 0 : t >= H ? H - 1 : t;
}

export function walkable(tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
  return TERRAIN[ty * W + tx] === 0;
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
  const gx = tileX(goalX);
  const gy = tileY(goalY);
  const cx = tileX(x);
  const cy = tileY(y);
  if (cx === gx && cy === gy) return [goalX, goalY];

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
