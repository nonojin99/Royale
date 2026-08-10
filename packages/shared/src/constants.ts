/** 시뮬레이션 전역 상수. 여기 값을 바꾸면 리플레이 호환성이 깨진다. */

/** 시뮬레이션 틱레이트 (Hz) */
export const TICK_RATE = 20;
/** 한 틱의 길이 (ms) */
export const TICK_MS = 1000 / TICK_RATE;

/** 정규 경기 길이 (틱) — 3분 */
export const MATCH_TICKS = 3 * 60 * TICK_RATE;
/** 연장전 길이 (틱) — 60초 */
export const OVERTIME_TICKS = 60 * TICK_RATE;
/** 2배속 엘릭서가 시작되는 시점 (틱) — 마지막 60초 */
export const DOUBLE_ELIXIR_TICK = MATCH_TICKS - 60 * TICK_RATE;

/** 엘릭서는 1/1000 단위 정수로 저장한다 */
export const ELIXIR_SCALE = 1000;
export const ELIXIR_MAX = 10 * ELIXIR_SCALE;
export const ELIXIR_START = 5 * ELIXIR_SCALE;
/**
 * 2.8초당 1 엘릭서 → 틱당 1000/(2.8*20) = 17.857...
 * 정수만 써야 하므로 18로 고정한다 (실효 2.78초/엘릭서). 양쪽 시뮬이 같은 값을
 * 쓰기만 하면 결정론에는 아무 문제가 없다.
 */
export const ELIXIR_PER_TICK = 18;

/** 서버가 커맨드를 예약할 때 확보하는 최소 미래 거리 (틱) */
export const COMMAND_SCHEDULE_AHEAD = 2;
/** 모두가 서버 시계보다 이만큼 과거를 시뮬레이션한다 (틱) */
export const SIM_DELAY_TICKS = 6;

/** 상태 해시를 주고받는 주기 (틱) */
export const HASH_INTERVAL = 20;

/** 유닛 배치 후 행동 불가 시간 (틱) — 1초 */
export const DEPLOY_TICKS = TICK_RATE;

/** 손패 크기 */
export const HAND_SIZE = 4;
/** 덱 크기 */
export const DECK_SIZE = 8;

/** 유닛 충돌 반경 (밀리타일) — 서로 밀어내는 기준 */
export const UNIT_RADIUS = 400;
/** 건물/타워 반경 (밀리타일) — 사거리 계산에 더해진다 */
export const BUILDING_RADIUS = 900;
