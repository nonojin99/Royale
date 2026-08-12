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
/**
 * 시작 보유량.
 *
 * ⚠️ 확장 비용(BASE_BUILD_COST)과 **같은 값으로 두면 안 된다.** 같으면
 * "무조건 즉시 확장"이 유일한 최적해가 되어 오프닝에 선택지가 사라진다.
 * 5는 일꾼 2기(4) 또는 값싼 유닛 하나를 살 수 있고, 확장은 조금 모자란 값이다.
 */
export const MINERAL_START = 5 * MINERAL_SCALE;

/* ── 일꾼 ──────────────────────────────────────────────────────────────── */

/**
 * 수입은 기지 수가 아니라 **일하는 일꾼 수**에서 나온다.
 *
 * 일꾼당 틱당 6 = 초당 0.12. 시작 2기면 초당 0.24로 아주 느리고,
 * 정원(8기)을 채우면 초당 0.96이 된다.
 */
export const WORKER_MINE_PER_TICK = 6;
/** 경기 시작 시 일꾼 수 */
export const START_WORKERS = 2;
/** 일꾼 한 기 생산 비용. 회수까지 약 16.7초 — 초반에는 확실한 이득이다 */
export const WORKER_COST = 2 * MINERAL_SCALE;

/**
 * 기지당 미네랄 덩이 수.
 *
 * 이 값의 진짜 의미는 매장량이 아니라 **일꾼 정원**이다.
 * 정원이 차면 일꾼을 더 붙여도 소용없고, 그래서 확장이 강제된다.
 */
export const MINERAL_PATCHES = 4;
/** 덩이 하나가 먹여살리는 일꾼 수 */
export const WORKERS_PER_PATCH = 2;
/** 기지 하나의 일꾼 정원 = 4 × 2 = 8 → 포화 수입 초당 0.96 */
export const WORKER_CAP_PER_BASE = MINERAL_PATCHES * WORKERS_PER_PATCH;

/**
 * 기지 하나에 매장된 총량.
 * 포화(초당 0.96) 기준 약 110초면 고갈된다 — 4분 경기의 중반이다.
 * 한 기지로 버티면 말라죽는다는 것이 확장을 강제하는 두 번째 장치다.
 */
export const BASE_MINERAL_RESERVE = 100 * MINERAL_SCALE;

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
/**
 * 저지 → 고지 공격의 데미지 배율 (백분율 정수).
 *
 * 스타크래프트의 언덕 미스(확률)와 달리 결정론이 공짜인 고정 감쇄를 쓴다 —
 * 확률도 시드 RNG로 가능하지만, 고정 감쇄가 툴팁 한 줄로 설명되고 테스트도
 * 단순하다. 공중 유닛은 지형 위를 날므로 이 규칙의 영향을 받지 않는다.
 */
export const HIGH_GROUND_DAMAGE_PCT = 70;

export const TEAM_COLOR_ME = 0x38bdf8;
export const TEAM_COLOR_FOE = 0xf87171;

/** 유닛 충돌 반경 (밀리타일) — 서로 밀어내는 기준 */
export const UNIT_RADIUS = 400;
/** 건물 반경 (밀리타일) — 사거리 계산에 더해진다 */
export const BUILDING_RADIUS = 900;
/** 기지 반경 (밀리타일) */
export const BASE_RADIUS = 1300;
