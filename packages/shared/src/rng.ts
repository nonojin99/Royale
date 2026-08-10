/**
 * 결정론적 PRNG (xorshift32).
 *
 * 시뮬레이션 안에서 Math.random()은 절대 금지. 무작위가 필요하면 반드시 이 PRNG를
 * 쓰고, PRNG 상태는 게임 상태의 일부로 취급한다 (스냅샷·해시에 포함).
 *
 * 서버가 매치 시작 시 시드를 양쪽에 동일하게 배포하므로, 두 클라이언트는
 * 같은 순서로 같은 난수를 뽑는다.
 */

export interface Rng {
  s: number;
}

export function createRng(seed: number): Rng {
  // 시드 0은 xorshift에서 고정점(항상 0)이므로 반드시 회피한다.
  const s = seed >>> 0;
  return { s: s === 0 ? 0x9e3779b9 : s };
}

/** 다음 부호 없는 32비트 정수. */
export function nextU32(r: Rng): number {
  let x = r.s;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  r.s = x;
  return x;
}

/** [0, n) 범위의 정수. n <= 0 이면 0. */
export function nextInt(r: Rng, n: number): number {
  if (n <= 0) return 0;
  return nextU32(r) % n;
}

/** [lo, hi] 범위의 정수 (양끝 포함). */
export function nextRange(r: Rng, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + nextInt(r, hi - lo + 1);
}
