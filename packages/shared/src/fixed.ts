/**
 * 고정소수점 정수 수학.
 *
 * 시뮬레이션의 모든 좌표/거리/속도는 "밀리타일"(1 타일 = 1000) 단위의 정수다.
 * 부동소수점을 쓰는 순간 두 클라이언트의 상태가 갈라지므로, 여기 있는 함수 외에는
 * 시뮬레이션 코드에서 산술 연산을 하지 않는다.
 *
 * 안전성 근거: JS number는 float64이므로 |v| < 2^53 인 정수는 정확히 표현된다.
 * 이 게임의 좌표 최대값은 32_000(밀리타일)이고 중간 곱셈 결과는 ~1e9 수준이라
 * 2^53 = 9.0e15 에 한참 못 미친다.
 */

/** 1 타일 = 1000 밀리타일 */
export const SCALE = 1000;

/** 타일 단위 실수를 밀리타일 정수로 변환한다 (데이터 정의 시점에만 사용). */
export function tiles(n: number): number {
  return Math.round(n * SCALE);
}

/** 초 단위를 틱 수로 변환한다. */
export function seconds(s: number, tickRate: number): number {
  return Math.round(s * tickRate);
}

/** 고정소수점 곱셈: (a * b) / SCALE, 0 방향 절삭. */
export function fmul(a: number, b: number): number {
  return Math.trunc((a * b) / SCALE);
}

/** 고정소수점 나눗셈: (a * SCALE) / b, 0 방향 절삭. */
export function fdiv(a: number, b: number): number {
  if (b === 0) return 0;
  return Math.trunc((a * SCALE) / b);
}

/**
 * 정수 제곱근. Math.sqrt는 IEEE-754가 정확한 반올림을 요구하는 함수라
 * 그 자체로 결정론적이지만, 경계에서의 부동소수점 오차를 제거하기 위해
 * 정수 보정 루프를 덧붙인다. 이 함수의 결과는 어떤 엔진에서도 동일하다.
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  // 부동소수점 오차로 1 정도 어긋날 수 있으므로 양방향 보정
  while (x > 0 && x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

/** 두 점 사이의 거리 (밀리타일). */
export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return isqrt(dx * dx + dy * dy);
}

/** 두 점 사이의 거리 제곱. 비교 목적이면 sqrt를 피하려고 이걸 쓴다. */
export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** 값을 [lo, hi] 범위로 자른다. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
