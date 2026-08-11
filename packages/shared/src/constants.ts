/** 시뮬레이션 전역 상수. 여기 값을 바꾸면 리플레이 호환성이 깨진다. */

/** 시뮬레이션 틱레이트 (Hz) */
export const TICK_RATE = 20;
/** 한 틱의 길이 (ms) */
export const TICK_MS = 1000 / TICK_RATE;

/** 정규 경기 길이 (틱) — 4분. 매크로 게임이라 레인 푸셔보다 길게 잡는다 */
export const MATCH_TICKS = 4 * 60 * TICK_RATE;
/** 연장전 길이 (틱) — 60초 */
export const OVERTIME_TICKS = 60 * TICK_RATE;

/* ── 자원 ──────────────────────────────────────────────────────────────── */

/** 미네랄은 1/1000 단위 정수로 저장한다 */
export const MINERAL_SCALE = 1000;
/** 보유 상한 */
export const MINERAL_MAX = 30 * MINERAL_SCALE;
/** 시작 보유량 — 초반에 아무것도 못 하는 시간을 없앤다 */
export const MINERAL_START = 8 * MINERAL_SCALE;

/**
 * 기지 하나가 틱당 캐는 양.
 * 20/틱 = 초당 0.4 = 2.5초에 1개. 기지가 둘이면 그 두 배가 된다.
 * 수입이 기지 수에 비례한다는 것이 이 게임의 핵심 축이다.
 */
export const INCOME_PER_TICK = 20;

/** 기지 하나에 매장된 총량. 50 / (20/틱) = 2500틱 = 125초면 고갈된다 */
export const BASE_MINERAL_RESERVE = 50 * MINERAL_SCALE;
/** 기지당 미네랄 덩이 수 (표시용 — 잔량에 비례해 줄어든다) */
export const MINERAL_PATCHES = 4;

/** 확장 기지 건설 비용 */
export const BASE_BUILD_COST = 8 * MINERAL_SCALE;
/** 기지 건설 후 가동까지 걸리는 시간 (틱) — 2초 */
export const BASE_BUILD_TICKS = 2 * TICK_RATE;

/* ── 배치 ──────────────────────────────────────────────────────────────── */

/**
 * 유닛은 자기 기지 반경 안에만 배치할 수 있다 (밀리타일).
 * 그래서 전진 기지를 세우는 것 자체가 공격 준비가 된다 —
 * 기지가 경제이자 전선이다.
 */
export const DEPLOY_RADIUS = 6000;

/** 기지를 세울 때 클릭 지점에서 이 거리 안의 빈 확장 지점을 집는다 */
export const BASE_SNAP_RADIUS = 4000;

/* ── 넷코드 ────────────────────────────────────────────────────────────── */

/** 서버가 커맨드를 예약할 때 확보하는 최소 미래 거리 (틱) */
export const COMMAND_SCHEDULE_AHEAD = 2;
/** 모두가 서버 시계보다 이만큼 과거를 시뮬레이션한다 (틱) */
export const SIM_DELAY_TICKS = 6;
/** 상태 해시를 주고받는 주기 (틱) */
export const HASH_INTERVAL = 20;

/* ── 엔티티 ────────────────────────────────────────────────────────────── */

/** 유닛 배치 후 행동 불가 시간 (틱) — 1초 */
export const DEPLOY_TICKS = TICK_RATE;

/**
 * 렌더러가 아군/적군 구분에 쓰는 색.
 *
 * 유닛·건물은 유닛 색으로 칠하고 팀 색으로 테두리를 두르기 때문에, 유닛 색이
 * 팀 색과 같으면 적 건물이 아군 건물처럼 보인다. 유닛 색은 이 값들과 반드시
 * 달라야 하며, 그 규칙은 테스트로 고정되어 있다.
 */
export const TEAM_COLOR_ME = 0x38bdf8;
export const TEAM_COLOR_FOE = 0xf87171;

/** 유닛 충돌 반경 (밀리타일) — 서로 밀어내는 기준 */
export const UNIT_RADIUS = 400;
/** 건물 반경 (밀리타일) — 사거리 계산에 더해진다 */
export const BUILDING_RADIUS = 900;
/** 기지 반경 (밀리타일) */
export const BASE_RADIUS = 1300;
