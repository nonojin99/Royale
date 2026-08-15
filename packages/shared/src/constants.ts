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

/**
 * 기지가 이만큼 피해를 누적당할 때마다 그 팀 일꾼이 1기 죽는다.
 *
 * 포격이 채굴장을 흔든다 — 이게 없으면 조기 공세가 아무리 성공해도
 * 경제에 흔적이 남지 않아서, 표준 빌드가 안 보고도 모든 도박수를 이기는
 * 지배 구조가 된다 (COUNCIL 라운드 4 실측). hp 문턱값에서 유도하므로
 * 추가 상태가 없고 해시·리플레이 구조도 그대로다.
 */
export const WORKER_LOSS_DAMAGE = 300;

/**
 * 확장은 내 영토에서 이어져야 한다 — 보유한 기지에서 이 거리 안의 지점만
 * 지을 수 있다. 지도 반대편에 뚝 떨어진 확장은 "출진해서 땅을 넓힌다"는
 * 감각을 죽인다 (플레이테스트 피드백 #5). 지점 사슬의 최장 간격이 10타일
 * 이라 11이면 인접 지점은 항상 이어진다.
 */
export const EXPAND_RANGE = 15 * 1000; // 48그리드 지점 사슬의 최장 간격(~13타일)을 덮는다

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
/**
 * 일꾼 회수 기간이 곧 "지금 병력 vs 지금 경제"의 긴장이다.
 *
 * 2.0에서는 17초 만에 회수돼 경제가 항상 정답이었고(표준 빌드가 모든
 * 도박수를 안 보고 이김), 3.0에서는 러시가 전장을 지배했다. 2.5가 실측
 * 최적점 — 러시가 무방비 표준을 벌하되(84%), 포탑 웅크림이 최선의
 * 대응으로 남는다 (COUNCIL 라운드 4).
 */
export const WORKER_COST = Math.trunc(2.5 * MINERAL_SCALE);

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
 * 포화(초당 0.96) 기준 약 220초면 고갈된다 — 4분 경기의 후반이다.
 * 한 기지로 버티면 말라죽는다는 것이 확장을 강제하는 두 번째 장치다.
 * (100=110초는 2인 플레이에서 "자원이 순식간에 마른다"는 체감을 낳았다 —
 *  고갈은 압박이어야지 벼락이면 안 된다. 라운드 9 피드백)
 */
export const BASE_MINERAL_RESERVE = 200 * MINERAL_SCALE;

/**
 * 확장 기지 건설 비용.
 * 8은 2인 플레이에서 "확장이 너무 싸다"는 체감 — 미네랄 상한(30)의 40%인
 * 12로 올려 확장을 '모아서 지르는 결정'으로 만든다 (라운드 9 피드백).
 */
export const BASE_BUILD_COST = 12 * MINERAL_SCALE;
/**
 * 충전 스킬 (라운드 21) — 주문 카드를 유닛 안으로 흡수했다.
 *
 * 융단폭격·정신붕괴는 "전맵 사거리 즉발"이라 사기적이었고(오너 보고),
 * 카드로 남겨두면 다양성이 아니라 자원 변환기가 된다. 이제 보유 유닛
 * (전투비행선·술사)이 게이지를 채워 **사거리 안에서** 자동 발사한다 —
 * 스킬을 쓰려면 그 유닛을 뽑아 전선에 살려 둬야 한다.
 */
export const SKILL_CHARGE_TICKS = 14 * TICK_RATE;
/**
 * 굴착 진동(4축)이 얹는 이동 속도 — 백분율.
 *
 * 버프를 받은 유닛은 출처를 모른다(효과만 틱으로 남는다). 그래서 세기는
 * 유닛 테이블이 아니라 여기 한 곳에 산다 — 굴착충의 ability.power도 이 값을 쓴다.
 */
export const HASTE_SPEED_PCT = 45;
export const SKILL_CAST_RANGE = 7000; // 7타일 (밀리타일)

/**
 * 침공 모드 (라운드 23 — 로그라이트 1단계).
 *
 * 파도 예산은 정수 백분율 곱으로 커진다 (부동소수점 금지 — 결정론).
 * 첫 파도는 느긋하게(빌드 시간), 이후 간격이 조금씩 줄어 숨통을 조인다.
 */
export const INVASION_FIRST_WAVE_TICKS = 30 * TICK_RATE;
export const INVASION_WAVE_TICKS = 22 * TICK_RATE;
/** 파도마다 간격이 이만큼 줄어든다 (최소 12초) */
export const INVASION_WAVE_ACCEL = 0.4 * TICK_RATE;
export const INVASION_WAVE_MIN_TICKS = 10 * TICK_RATE;
/** 첫 파도 예산 (밀리미네랄) */
export const INVASION_BUDGET_START = 6 * MINERAL_SCALE;
/** 파도마다 예산 ×118/100 (정수 연산) */
export const INVASION_BUDGET_GROWTH = 126; // 라운드 24: 118 → 126 (전 확장 플레이어가 13파도를 한가하게 넘겼다)
/**
 * 침공 2.0 (라운드 25) — "파도가 곧 자원".
 * 채굴은 절반, 소탕 보상이 주 수입 — 버티기만 하면 가난해진다.
 */
export const INVASION_MINE_PCT = 50;
export const INVASION_RICH_MINE_PCT = 80;
export const INVASION_BOUNTY_PCT = 70;
/**
 * 침공 방벽 설치 횟수 (라운드 30).
 *
 * 미네랄만으로는 방벽을 무한히 세울 수 있어 "성 설계"가 도배로 퇴화한다.
 * 파도마다 몇 장 주어지는 **설치권**이 있어야 어디에 쓸지가 결정이 된다.
 */
export const INVASION_WALL_START = 3;
export const INVASION_WALL_PER_WAVE = 1;
export const INVASION_WALL_CAP = 6;

/** 집결 깃발 도착 판정 반경 (밀리타일) — 이 안이면 주둔으로 친다 */
export const RALLY_ARRIVE = 2000;
/** 이동 명령 도착 판정 반경 — 뭉치가 서로 밀며 진동하지 않을 만큼 넉넉히 */
export const ORDER_ARRIVE = 1200;
/** 한 명령이 움직일 수 있는 최대 유닛 수 — 위조 메시지 방어 */
export const ORDER_MAX_UNITS = 64;

/** 기지 건설 후 가동까지 걸리는 시간 (틱) — 4초.
 * 라운드 20에서 2초→4초: "확장이 무조건 정답"이라는 실전 관측에 대한
 * 두 번째 브레이크(첫 번째는 라운드 10C의 확장비 12). 건설 중 기지는
 * 채굴하지 못하고 공격에 노출되므로, 시간 자체가 위험 비용이다. */
export const BASE_BUILD_TICKS = 4 * TICK_RATE;

/* ── 강화 (업그레이드) ─────────────────────────────────────────────────── */

/**
 * 전군 공격 강화 — 1~3단계.
 *
 * 단계 k는 k-1단계 열의 연구를 하나라도 마쳐야 열린다 (1단계는 시작부터,
 * 2단계는 1단계 연구 후, 3단계는 2단계 연구 후 — 라운드 10 피드백).
 * 효과는 유닛·방어 건물의 공격 +10%/단계. 기지·주문은 제외 — 기지가
 * 강해지면 수비가 공짜가 되고, 주문은 이미 고정 효율이다.
 *
 * 스킬 대신 강화가 상성을 흔든다: 고정 데미지 체계에서 +10%는 "몇 방에
 * 죽는가"의 문턱을 넘기는 장치다 (예: 화염병 100→120이면 소총병 220을
 * 3방→2방). 발동 조작이 없는 이 게임에서 마이크로 없이 상성 역전을 주는
 * 유일한 통로다.
 */
export const UPGRADE_MAX = 3;
export const UPGRADE_COSTS = [4 * MINERAL_SCALE, 8 * MINERAL_SCALE, 12 * MINERAL_SCALE];
/** 단계별 소요 시간 (틱) */
export const UPGRADE_TICKS = [10 * TICK_RATE, 14 * TICK_RATE, 18 * TICK_RATE];
/** 단계당 공격 증가율 (%) */
export const UPGRADE_DAMAGE_PCT = 10;

/* ── 배치 ──────────────────────────────────────────────────────────────── */

/**
 * 유닛은 자기 기지 반경 안에만 배치할 수 있다 (밀리타일).
 * 그래서 전진 기지를 세우는 것 자체가 공격 준비가 된다 —
 * 기지가 경제이자 전선이다.
 */
export const DEPLOY_RADIUS = 9000; // 48그리드에서도 기지 주변 '진영'이 화면에서 읽히는 크기

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

/* ── 영웅 (5축, 라운드 37 — 침공 전용) ─────────────────────────────────── */

/** 레벨 상한 — 파도마다 하나씩 오른다. 10이면 20파도쯤에 천장에 닿는다 */
export const HERO_LEVEL_MAX = 10;
/** 레벨당 공격력 (백분율 정수) */
export const HERO_DAMAGE_PER_LEVEL = 8;
/** 레벨당 체력 (백분율 정수) — 소환 시점에 얹는다 */
export const HERO_HP_PER_LEVEL = 10;
/**
 * 전사 후 재소환까지 (틱).
 *
 * 영웅이 영영 죽으면 런이 사실상 끝난다 — 성장을 얹은 것이 오히려 실패를
 * 되돌릴 수 없게 만드는 셈이다. 대신 **레벨 하나를 잃고** 25초 뒤 본진에서
 * 다시 일어선다: 죽음이 아프되 치명적이지는 않다.
 */
export const HERO_RESPAWN_TICKS = 25 * TICK_RATE;

/* ── 런 체인 (로그라이트 3단계, 라운드 38) ─────────────────────────────── */

/**
 * 런은 세 무대를 잇는다 — **방어 두 번, 공격 한 번**.
 *
 * 끝없는 파도는 점수판이지 이야기가 아니다. 무대를 나누면 런에 마디가
 * 생기고("여기만 넘기면 다음"), 마지막에 동사가 바뀐다: 지키던 사람이
 * 쳐들어간다. 무대가 바뀌어도 성장(유물·해금·영웅 레벨)은 따라간다 —
 * 잃는 것은 전장뿐이다.
 *
 * `map`이 빈 문자열이면 로비에서 고른 맵을 그대로 쓴다(1무대).
 * `waves`가 0이면 파도 수가 아니라 **둥지 격파**가 조건이다.
 */
export interface StageDef {
  map: string;
  waves: number;
  name: string;
  tagline: string;
  nest?: boolean;
}

export const RUN_STAGES: readonly StageDef[] = [
  { map: '', waves: 6, name: '전초 방어', tagline: '사방에서 온다 — 여섯 파도를 넘겨라' },
  { map: 'coast', waves: 6, name: '포위망', tagline: '바다를 등졌다 — 여섯 파도 더' },
  {
    map: 'rift', waves: 0, nest: true,
    name: '둥지 격파', tagline: '이제 우리가 간다 — 둥지를 부숴라',
  },
];

/** 무대를 넘길 때 주는 방벽 설치권 (성은 새로 지어야 한다) */
export const STAGE_WALL_GRANT = 4;
/** 둥지 체력 — 파도를 헤치고 도달해야 하므로 넉넉히 */
export const NEST_HP = 7000;
