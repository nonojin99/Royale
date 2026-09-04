/**
 * 유닛 데이터 테이블.
 *
 * 밸런싱은 전부 여기서 일어난다. 시뮬레이션 로직(sim.ts)에는 특정 유닛 이름이
 * 하드코딩되어 있지 않으므로, 유닛 추가는 이 파일에 항목 하나를 더하는 것으로 끝난다.
 *
 * `cost`는 **생산 비용**이다. 해금 비용은 별개이며 factions.ts의 테크트리에 있다.
 *
 * 단위:
 *   hp, damage      정수
 *   range, splash   밀리타일
 *   speed           틱당 밀리타일
 *   hitSpeed        틱
 *
 * ── 네이밍에 관하여 ──────────────────────────────────────────────────────
 * 유닛의 "역할 구조"(값싼 원거리 물량 / 근접 광역 / 공성 / 대공 전용 건물 …)는
 * 실시간 전략 장르에서 수십 년간 검증된 배치를 참고했지만, 이름과 비주얼은 전부
 * 오리지널이다. 특정 상용 IP의 고유명사·디자인을 가져다 쓰지 않는다.
 */

import { HASTE_SPEED_PCT, NEST_HP, TICK_RATE } from './constants.js';
import { seconds, tiles } from './fixed.js';

export type UnitKind = 'unit' | 'building' | 'spell';

/**
 * 무엇을 공격 대상으로 삼는가.
 *   any        지상·공중 모두
 *   ground     지상만 (공중 유닛을 때리지 못한다)
 *   air        공중만 (대공 전용 건물)
 *   buildings  건물·타워만 (유닛을 무시하고 직행)
 */
export type TargetPref = 'any' | 'ground' | 'air' | 'buildings';

export interface UnitDef {
  id: string;
  name: string;
  cost: number;
  kind: UnitKind;
  /** 한 번에 몇 마리 나오는가 */
  count: number;
  hp: number;
  damage: number;
  /** 공격 간격 (틱) */
  hitSpeed: number;
  /** 사거리 (밀리타일) */
  range: number;
  /** 이동 속도 (틱당 밀리타일). 건물/주문은 0 */
  speed: number;
  /** 광역 피해 반경 (밀리타일). 0이면 단일 대상 */
  splash: number;
  targets: TargetPref;
  /** 충전 스킬 — 게이지가 차면 이 주문을 사거리 안에서 자동 발사한다 */
  charges?: string;
  /**
   * 충전에 걸리는 틱. 적지 않으면 `SKILL_CHARGE_TICKS`(14초).
   *
   * 14초는 **전투가 끝난 뒤에 차는 시간**이다. 결투 실측에서 교전은 3~18초에
   * 결판나므로, 술사처럼 "긴 쿨타임 대신 광역 한 방"이 정체성인 유닛은
   * 그 한 방을 평생 못 써 보고 죽었다 (등코스트 우세도 -0.8).
   */
  chargeTicks?: number;
  /**
   * 생산될 때 게이지가 차 있는 정도 (틱). 적지 않으면 0에서 시작한다.
   *
   * "긴 쿨타임 대신 광역 한 방"이 정체성인 유닛에게는 **첫 한 방을 쓸 수
   * 있느냐**가 전부다. 술사는 집중 사격에 4초 만에 녹아 게이지가 41/140에서
   * 멈췄다(실측) — 충전을 줄여도 소용이 없었던 이유다. 도착하자마자 한 번
   * 터뜨리고, 그다음은 길게 기다린다.
   */
  chargeStart?: number;
  /**
   * 능동 특성 (4축, 라운드 35) — **침공 전용**.
   *
   * 라운드 21의 게이지 틀을 재사용하되, "주문을 쏜다"가 아니라 **상태를
   * 바꾼다**. 유닛마다 다른 동사를 하나씩 쥐어 주는 것이 목적이다:
   *
   *   cloak      게이지가 차면 은신. 공격하는 순간 드러난다(게이지 0)
   *   detect     상시. 반경 안 적의 은신을 무효로 만든다
   *   siegemode  제자리에 charge 틱 머물면 고정 포대가 된다(사거리·공격 ↑, 이동 ✗)
   *   mine       게이지가 차면 둘레에 지뢰를 묻는다 (power기까지)
   *   sprint     게이지가 차면 반경 안 아군 지상 유닛이 ticks 틱 동안 빨라진다
   *   spawn      게이지가 차면 새끼를 power마리 낳는다 (영웅, 라운드 37)
   *   heal       게이지가 차면 반경 안 아군 유닛을 power만큼 회복시킨다 (영웅)
   *
   * 대전에는 켜지지 않는다 — 삼각(RUSH/TECH/ECON)이 이 값들을 모른 채
   * 실측된 것이라, 침공에서 먼저 익힌 뒤 별도 라운드로 옮긴다.
   */
  ability?: {
    kind: 'cloak' | 'detect' | 'siegemode' | 'mine' | 'sprint' | 'spawn' | 'heal';
    /** 게이지 충전 틱 (siegemode는 '정지 유지' 틱) */
    charge?: number;
    /** 효과 반경 (밀리타일) */
    radius?: number;
    /** 세기 — 백분율(sprint·siegemode) 또는 개수(mine) */
    power?: number;
    /** 지속 틱 (sprint) */
    ticks?: number;
    /** 사거리 보너스 (밀리타일, siegemode) */
    rangeAdd?: number;
  };
  /**
   * 몸집 — 충돌 반경을 고른다 (constants.ts의 `UNIT_RADIUS_*`).
   *
   * 적지 않으면 'medium'. 예전에는 전 유닛이 한 반경이라 소총병 셋과
   * 공성전차 하나가 같은 자리를 차지했다 — 화면에서 "큰 놈이 큰 자리를
   * 먹는다"가 거짓이었다는 뜻이다. 물량 유닛은 'small', 중장갑·영웅은
   * 'large'. 건물·기지는 이 값을 쓰지 않는다(고정 반경).
   */
  size?: 'small' | 'medium' | 'large';
  /**
   * 지뢰인가 — 상시 은신 + 접촉 자폭. 이 둘은 늘 함께 다니므로 한 플래그다.
   * 길찾기 장애물에서도 빠진다: 1축의 벽은 '지은 것'이지 '묻은 것'이 아니다.
   */
  mine?: boolean;
  /**
   * 영웅인가 (5축, 라운드 37) — **침공 전용**.
   *
   * 런 시작에 셋 중 하나를 고르고, 파도를 넘길 때마다 자란다. 죽어도 런이
   * 끝나지 않고 본진에서 다시 일어선다(레벨 하나를 잃는다). 대전에는
   * 없다 — 라운드 11에서 영웅을 대전에서 격리하기로 한 결정 그대로다.
   */
  hero?: boolean;
  /**
   * 구조물(기지·건물) 상대 데미지 배율 — **백분율 정수** (100 = 그대로).
   *
   * 이 값이 게임의 시간 축을 결정한다. 시작 유닛은 100 미만이라 본진을 빨리
   * 못 부수고(초반 방어 성립), 2단계 테크의 공성 유닛은 100을 크게 넘어
   * 대치를 끝내는 유일한 효율 수단이 된다. "러시 40초 종결"과 "300초 무승부"
   * 라는 두 극단(REVIEW.md P0-1)을 좁히기 위한 손잡이다.
   */
  siege: number;
  /**
   * 공중 유닛인가.
   * 공중 유닛은 강과 다리를 무시하고 목표를 향해 직선으로 날아가며,
   * 지상 유닛·건물과 충돌하지 않는다. 대신 지상 전용 공격에 맞지 않는다.
   */
  flying: boolean;
  /** 건물 수명 (틱). -1이면 무한 */
  lifetime: number;
  /**
   * 지원 오라 (침공 전용 건물, 라운드 31 "건물 계보").
   *
   * 공격 타워만 있으면 성 설계가 "포탑을 몇 개 놓나"로 납작해진다. 스스로는
   * 쏘지 않지만 **주변을 바꾸는** 건물이 있어야 배치에 층이 생긴다:
   *   chill  적 이동 속도 -값%      (킬존에 가둔다)
   *   rally  아군 유닛 공격 +값%    (화력을 겹친다)
   *   mend   아군 건물 초당 값 회복 (성을 오래 버티게 한다)
   */
  aura?: { kind: 'chill' | 'rally' | 'mend'; radius: number; power: number };
  /** UI 색상 */
  color: number;
}

/** 타일/초 단위를 틱당 밀리타일로 */
function spd(tilesPerSec: number): number {
  return Math.round((tilesPerSec * 1000) / TICK_RATE);
}

/** 카드 정의의 반복을 줄이기 위한 기본값 */
type UnitSpec = Omit<UnitDef, 'count' | 'splash' | 'targets' | 'flying' | 'lifetime' | 'siege'> &
  Partial<Pick<UnitDef, 'count' | 'splash' | 'targets' | 'flying' | 'lifetime' | 'siege'>>;

function unit(spec: UnitSpec): UnitDef {
  return {
    count: 1,
    splash: 0,
    targets: 'any',
    flying: false,
    lifetime: -1,
    siege: 100,
    ...spec,
  };
}

/**
 * 건물 기본 수명 — 80초. 방어 건물이 영구히 남으면 공격이 성립하지 않지만,
 * 40초는 수비 측만 내는 세금이 너무 무거웠다 — 러시는 유지비가 0인데
 * 수비는 40초마다 포탑을 다시 사느라 반격 병력을 영영 못 모았다
 * (실측: 48맵에서 TECH가 RUSH에 23% — COUNCIL 라운드 6.5).
 */
const BUILDING_LIFE = seconds(80, TICK_RATE);

const defs: UnitDef[] = [
  /* ── 기갑단 ───────────────────────────────────────────────────────────
     방어선을 세우고 카운터친다. 건물이 강하고 원거리 유닛이 많다.
     느린 대신 사거리로 이득을 보는 종족. */
  unit({
    id: 'rifleman', size: 'small', name: '소총병', cost: 3, kind: 'unit', count: 3,
    hp: 220, damage: 65, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(5.0), speed: spd(1.0), siege: 30, color: 0x3b82f6,
  }),
  unit({
    id: 'flamer', name: '화염병', cost: 3, kind: 'unit', count: 2,
    hp: 480, damage: 100, hitSpeed: seconds(1.3, TICK_RATE),
    range: tiles(1.6), speed: spd(0.95), splash: tiles(1.4),
    targets: 'ground', siege: 60, color: 0xf97316,
  }),
  unit({
    id: 'scoutcar', size: 'small', name: '정찰차', cost: 2, kind: 'unit',
    hp: 420, damage: 130, hitSpeed: seconds(1.1, TICK_RATE),
    range: tiles(0.8), speed: spd(1.4), targets: 'buildings', siege: 120, color: 0xfbbf24,
    // 디텍터 — 값싼 정찰 유닛에 붙여야 "보는 눈을 사서 데리고 다닌다"가 된다
    ability: { kind: 'detect', radius: tiles(6.5) },
  }),
  unit({
    id: 'siegetank', size: 'large', name: '공성전차', cost: 5, kind: 'unit',
    hp: 1000, damage: 230, hitSpeed: seconds(2.2, TICK_RATE),
    range: tiles(7.0), speed: spd(0.45), splash: tiles(2.0),
    targets: 'ground', siege: 220, color: 0x1d4ed8,
    // 시즈모드 — 2초 정지로 진입. 사거리 7→9.5, 공격 +35%. 이동하면 즉시 풀린다
    ability: {
      kind: 'siegemode',
      charge: seconds(2, TICK_RATE),
      rangeAdd: tiles(2.5),
      power: 35,
    },
  }),
  unit({
    id: 'ironwalker', size: 'large', name: '강철거인', cost: 4, kind: 'unit',
    hp: 850, damage: 110, hitSpeed: seconds(1.2, TICK_RATE),
    range: tiles(5.5), speed: spd(0.8), siege: 120, color: 0x475569,
  }),
  unit({
    // 라운드 50 상향: 러시가 병력을 모아 오게 되면서(봇의 집결 후 출진)
    // 첫 뭉치를 못 버티면 웅크림 전략 자체가 성립하지 않는다. 다만 전량
    // 상향은 과했다 — RUSH vs TECH 55%→35%로 뒤집혔다. 절반만 준다
    id: 'bulwark', name: '방벽', cost: 2, kind: 'building',
    hp: 1000, damage: 182, hitSpeed: seconds(0.8, TICK_RATE),
    range: tiles(5.5), speed: 0, lifetime: BUILDING_LIFE, color: 0x78716c,
    // 지뢰 부설 — 9초마다 둘레에 한 기, 셋까지. 벽이 스스로 지뢰밭을 기른다
    ability: { kind: 'mine', charge: seconds(9, TICK_RATE), radius: tiles(3.0), power: 3 },
  }),
  unit({
    id: 'gunship', name: '전투비행선', cost: 4, kind: 'unit', flying: true,
    hp: 700, damage: 100, hitSpeed: seconds(1.3, TICK_RATE),
    range: tiles(3.0), speed: spd(1.1), siege: 120, color: 0x0891b2,
    charges: 'carpetbomb',
  }),
  unit({
    id: 'carpetbomb', name: '융단폭격', cost: 3, kind: 'spell', count: 0,
    hp: 0, damage: 240, hitSpeed: 0, range: 0, speed: 0,
    splash: tiles(3.0), color: 0xdc2626,
  }),

  /* ── 군체 ─────────────────────────────────────────────────────────────
     숫자로 압도한다. 개체는 약하지만 싸고 빠르다.
     주문이 없는 대신 방어 건물이 둘(지상용·대공용)이다. */
  unit({
    // 라운드 50 상향: 등코스트 우세도 -0.65~-0.76. 물량의 존재 이유는
    // "같은 돈이면 더 오래 버틴다"인데 24마리가 12코 상대에게 갈렸다
    id: 'gnawer', size: 'small', name: '물어뜯는것', cost: 2, kind: 'unit', count: 4,
    hp: 115, damage: 55, hitSpeed: seconds(0.8, TICK_RATE),
    range: tiles(0.7), speed: spd(1.5), targets: 'ground', siege: 40, color: 0xa16207,
  }),
  unit({
    // 라운드 21 상향: 결투 매트릭스 0/14 전패 — 군체 유일 대공의 몸값을 못 했다
    id: 'spitter', size: 'small', name: '가시뱉는것', cost: 3, kind: 'unit', count: 2,
    hp: 340, damage: 80, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(4.5), speed: spd(1.05), siege: 50, color: 0x84cc16,
  }),
  unit({
    id: 'burrower', name: '땅속의것', cost: 4, kind: 'unit',
    hp: 550, damage: 150, hitSpeed: seconds(1.6, TICK_RATE),
    range: tiles(4.5), speed: spd(0.5), splash: tiles(1.8),
    targets: 'ground', siege: 100, color: 0x713f12,
  }),
  unit({
    id: 'devourer', size: 'large', name: '거대포식자', cost: 5, kind: 'unit',
    hp: 1600, damage: 170, hitSpeed: seconds(1.5, TICK_RATE),
    range: tiles(0.9), speed: spd(0.7), splash: tiles(1.2),
    targets: 'ground', siege: 200, color: 0x7c2d12,
  }),
  unit({
    id: 'spinetentacle', name: '가시촉수', cost: 2, kind: 'building',
    hp: 950, damage: 225, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(4.5), speed: 0, targets: 'ground',
    lifetime: BUILDING_LIFE, color: 0x9f1239,
  }),
  unit({
    id: 'wingswarm', size: 'small', name: '날개무리', cost: 4, kind: 'unit', count: 3, flying: true,
    hp: 240, damage: 65, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(2.5), speed: spd(1.4), siege: 100, color: 0xc026d3,
  }),
  unit({
    id: 'sporetentacle', name: '포자촉수', cost: 3, kind: 'building',
    hp: 600, damage: 200, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(6.0), speed: 0, targets: 'air',
    lifetime: BUILDING_LIFE, color: 0x86198f,
  }),
  unit({
    id: 'tunneler', size: 'small', name: '굴착충', cost: 2, kind: 'unit',
    hp: 520, damage: 140, hitSpeed: seconds(1.2, TICK_RATE),
    range: tiles(0.7), speed: spd(1.6), targets: 'buildings', siege: 120, color: 0xca8a04,
    // 굴착 진동 — 12초마다 둘레 아군 지상군이 4초간 +45%. 재배치가 곧 생존인
    // 침공에서, 군체가 "빨리 다시 선다"는 정체성을 얻는다
    ability: {
      kind: 'sprint',
      charge: seconds(12, TICK_RATE),
      radius: tiles(5.0),
      power: HASTE_SPEED_PCT,
      ticks: seconds(4, TICK_RATE),
    },
  }),

  /* ── 신념단 ───────────────────────────────────────────────────────────
     비싸지만 한 방이 무겁다. 개체 하나하나가 강해 물량에 밀리지 않는다.
     대신 실수 한 번의 비용이 크다. */
  unit({
    // 라운드 50 하향: 등코스트 결투에서 전 예산대 우세도 +0.68~+0.93으로
    // 압도적이었다 — 1.5코짜리가 4·5코 유닛을 값으로 이기면 테크가 죽는다
    id: 'zealot', name: '광전사', cost: 3, kind: 'unit', count: 2,
    hp: 580, damage: 120, hitSpeed: seconds(1.3, TICK_RATE),
    range: tiles(0.8), speed: spd(0.95), targets: 'ground', siege: 50, color: 0xfacc15,
  }),
  unit({
    id: 'strider', name: '사격보행기', cost: 4, kind: 'unit',
    hp: 700, damage: 140, hitSpeed: seconds(1.4, TICK_RATE),
    range: tiles(6.0), speed: spd(0.8), siege: 100, color: 0x0d9488,
  }),
  unit({
    // 라운드 20 너프: 등코스트 전 매치업 무손실 전승 관측(130/1.6s/2.0).
    // 물어뜯는것만 1방, 소총병은 2방 유지 — 범위 학살의 '속도'만 깎는다
    // 라운드 50 상향: 등코스트 우세도 -0.72~-0.83. 4코를 내고 사는 광역
    // 딜러가 접근 전에 녹아 없어졌다 — 체력만 올려 사거리·화력은 그대로 둔다
    id: 'mystic', name: '술사', cost: 4, kind: 'unit',
    hp: 420, damage: 110, hitSpeed: seconds(1.7, TICK_RATE),
    range: tiles(5.0), speed: spd(0.9), splash: tiles(2.1),
    targets: 'ground', siege: 80, color: 0x8b5cf6,
    // 라운드 50: 다수전 특화 (오너 지시). 광역을 1.7→2.1타일로 넓히고
    // 충전을 14→7초로 줄인다. "긴 쿨타임 대신 광역 한 방"이 정체성인데
    // 14초는 교전이 끝난 뒤에나 차서 그 한 방을 못 써 보고 죽었다
    charges: 'mindbreak',
    chargeTicks: seconds(9, TICK_RATE),
    // 만충으로 도착하면 붙자마자 한 무리를 지운다(실측: 소총병 12기 즉사).
    // 60%면 교전 3~4초째에 터진다 — 앞줄이 버텨 준 값이라 조합의 보상이 된다
    chargeStart: seconds(5.4, TICK_RATE),
  }),
  unit({
    // 라운드 50 하향: 신념단 편성 리그에서 홀로 +0.23 돌출(다른 종족은 전부
    // ±0.09 안). 광역을 좁혀 **대군에서의 값**만 깎는다 — 한 방이 무겁다는
    // 정체성(체력·데미지)은 건드리지 않는다
    id: 'fusionite', size: 'large', name: '융합체', cost: 5, kind: 'unit',
    hp: 1300, damage: 200, hitSpeed: seconds(1.6, TICK_RATE),
    range: tiles(1.0), speed: spd(0.8), splash: tiles(1.3), siege: 200, color: 0x06b6d4,
  }),
  unit({
    id: 'lightpylon', name: '빛기둥', cost: 2, kind: 'building',
    hp: 900, damage: 192, hitSpeed: seconds(0.9, TICK_RATE),
    // 하늘색(0x38bdf8)은 렌더러의 아군 팀 색과 겹쳐서, 적 빛기둥이 아군 건물처럼
    // 보인다. 카드 색은 팀 색과 반드시 구분되어야 한다.
    range: tiles(5.5), speed: 0, lifetime: BUILDING_LIFE, color: 0xfcd34d,
  }),
  unit({
    // 라운드 21 상향: 0/14 전패 — 암살자가 접근 전에 죽었다. 발과 맷집을 준다
    id: 'shade', name: '그림자', cost: 4, kind: 'unit',
    hp: 650, damage: 320, hitSpeed: seconds(1.8, TICK_RATE),
    range: tiles(0.8), speed: spd(1.35), targets: 'ground', siege: 70, color: 0x4c1d95,
    // 은신 — 5초 충전. **때리는 순간 드러난다**: 디텍터가 없어도 맞받아칠
    // 길이 남아야 "은신 종족을 만나면 진다"는 잠금이 생기지 않는다
    ability: { kind: 'cloak', charge: seconds(5, TICK_RATE) },
  }),
  unit({
    id: 'skiff', name: '부유선', cost: 4, kind: 'unit', flying: true,
    hp: 650, damage: 90, hitSpeed: seconds(1.1, TICK_RATE),
    range: tiles(3.5), speed: spd(1.0), splash: tiles(1.3),
    targets: 'ground', siege: 100, color: 0xe879f9,
  }),
  unit({
    // 지상만 때린다 — 시전자(술사)가 지상 전용인데 그 주문만 공중을 때리면
    // "못 때리는 유닛이 때린다"가 된다 (결정론 테스트가 잡았다)
    id: 'mindbreak', name: '정신붕괴', cost: 3, kind: 'spell', count: 0,
    hp: 0, damage: 260, hitSpeed: 0, range: 0, speed: 0,
    splash: tiles(2.6), targets: 'ground', color: 0x7e22ce,
  }),

  /* ── 침공 전용 지원 건물 (라운드 31) ────────────────────────────────
     종족에 속하지 않는 중립 구조물이다. 드래프트로만 해금되고 대전에는
     나오지 않는다 — 대전 밸런스를 건드리지 않고 침공만 깊게 만든다. */
  unit({
    id: 'chilltower', name: '냉각탑', cost: 3, kind: 'building',
    hp: 900, damage: 0, hitSpeed: 0, range: 0, speed: 0,
    lifetime: BUILDING_LIFE, color: 0x22d3ee,
    aura: { kind: 'chill', radius: tiles(4.5), power: 40 },
  }),
  unit({
    id: 'commandpost', name: '지휘탑', cost: 3, kind: 'building',
    hp: 900, damage: 0, hitSpeed: 0, range: 0, speed: 0,
    lifetime: BUILDING_LIFE, color: 0xfacc15,
    aura: { kind: 'rally', radius: tiles(5.0), power: 15 },
  }),
  unit({
    id: 'repairbay', name: '정비고', cost: 3, kind: 'building',
    hp: 1100, damage: 0, hitSpeed: 0, range: 0, speed: 0,
    lifetime: BUILDING_LIFE, color: 0x4ade80,
    aura: { kind: 'mend', radius: tiles(4.0), power: 25 },
  }),
  /* ── 영웅 (5축, 라운드 37) — 침공 전용 ─────────────────────────────
     런 시작 3택1. 종족과 무관하게 셋 다 후보다 — 영웅이 종족에 묶이면
     "이 종족은 이 영웅"이 되어 런마다 다른 선택이라는 목적이 사라진다.
     각자 능동기가 하나씩 다르다: 포격 / 산란 / 치유. */
  unit({
    id: 'hero_commander', size: 'large', name: '강철 사령관', cost: 0, kind: 'unit', hero: true,
    hp: 1600, damage: 190, hitSpeed: seconds(1.2, TICK_RATE),
    range: tiles(5.5), speed: spd(0.85), splash: tiles(1.2), siege: 150,
    color: 0x2563eb, charges: 'heroshell',
  }),
  unit({
    id: 'heroshell', name: '궤도 포격', cost: 0, kind: 'spell', count: 0,
    hp: 0, damage: 300, hitSpeed: 0, range: 0, speed: 0,
    splash: tiles(2.8), color: 0x93c5fd,
  }),
  unit({
    id: 'hero_queen', size: 'large', name: '군체 여왕', cost: 0, kind: 'unit', hero: true,
    hp: 1900, damage: 150, hitSpeed: seconds(1.1, TICK_RATE),
    range: tiles(1.0), speed: spd(1.0), splash: tiles(1.0),
    targets: 'ground', siege: 120, color: 0x9a3412,
    // 산란 — 10초마다 새끼 둘. 벽을 세우는 대신 몸으로 벽을 만든다
    ability: { kind: 'spawn', charge: seconds(10, TICK_RATE), power: 3, radius: tiles(1.5) },
  }),
  unit({
    id: 'broodling', size: 'small', name: '새끼', cost: 0, kind: 'unit',
    hp: 130, damage: 60, hitSpeed: seconds(0.8, TICK_RATE),
    range: tiles(0.7), speed: spd(1.5), targets: 'ground', siege: 30,
    lifetime: seconds(40, TICK_RATE), color: 0xd97706,
  }),
  unit({
    id: 'hero_prophet', size: 'large', name: '빛의 예언자', cost: 0, kind: 'unit', hero: true,
    hp: 1400, damage: 130, hitSpeed: seconds(1.4, TICK_RATE),
    range: tiles(6.0), speed: spd(0.9), siege: 90, color: 0xa855f7,
    // 치유의 빛 — 8초마다 둘레 아군을 일으킨다. 물량을 오래 살린다
    ability: { kind: 'heal', charge: seconds(8, TICK_RATE), radius: tiles(5.0), power: 220 },
  }),
  unit({
    // 3무대의 목표물 — 부수면 런이 끝난다. 스스로 쏘지 않는다:
    // 둥지를 지키는 것은 파도의 몫이고, 둥지는 그저 거기 있어야 한다
    id: 'nest', name: '둥지', cost: 0, kind: 'building',
    hp: NEST_HP, damage: 0, hitSpeed: 0, range: 0, speed: 0,
    lifetime: -1, color: 0x7f1d1d,
  }),
  unit({
    // 방벽의 능동기가 심는다 — 카드도 테크트리도 없다. 밟히면 터지고 사라진다.
    // 수명은 무한이지만 상한(방벽당 3기)이 있어 지뢰밭이 무한히 자라지 않는다
    id: 'landmine', name: '지뢰', cost: 1, kind: 'building', mine: true,
    hp: 90, damage: 230, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(1.0), speed: 0, splash: tiles(1.8),
    targets: 'ground', siege: 50, lifetime: -1, color: 0xef4444,
  }),
];

/** 침공 전용 지원 건물 — 드래프트 해금 풀. 종족 트리에는 없다 */
export const INVASION_BUILDINGS: readonly string[] = ['chilltower', 'commandpost', 'repairbay'];

/**
 * 카드로 존재하지 않는 유닛 — 능동기가 낳는 것들.
 * 해금 목록(실험장의 전체 해금 포함)에서 빠진다.
 */
export const SPAWNED_ONLY: readonly string[] = [
  'landmine',
  'nest',
  'broodling',
  'hero_commander',
  'hero_queen',
  'hero_prophet',
  'heroshell',
];

/** 영웅 후보 — 런 시작 3택1 (침공 전용). 순서가 곧 제안 순서다 */
export const HERO_IDS: readonly string[] = ['hero_commander', 'hero_queen', 'hero_prophet'];

export const UNITS: ReadonlyMap<string, UnitDef> = new Map(defs.map((d) => [d.id, d]));

/** 정렬된 유닛 ID 목록 — 순회 순서가 필요할 때 Map 대신 이걸 쓴다 (결정론) */
export const UNIT_IDS: readonly string[] = defs.map((d) => d.id);

export function getUnit(id: string): UnitDef {
  const c = UNITS.get(id);
  if (!c) throw new Error(`unknown unit: ${id}`);
  return c;
}

/* ── 기지 스탯 ─────────────────────────────────────────────────────────── */

export interface BaseStats {
  hp: number;
  damage: number;
  hitSpeed: number;
  range: number;
}

/**
 * 기지는 지상·공중을 모두 약하게 공격한다.
 *
 * 공격력이 0이면 초반 러시에 무방비가 되고(방어 건물은 테크를 올려야 나온다),
 * 너무 세면 확장을 견제할 방법이 없어진다. "일꾼 몇 기는 지키지만 병력은
 * 못 막는" 수준으로 맞춘다. 45는 그 선을 넘어 있었다 — 기지 딜이 공짜
 * 수비가 되어 "무조건 확장"이 정답이 됐다 (라운드 10 오너 피드백).
 * 확장의 안전은 공짜가 아니라 포탑·병력이라는 선택에서 나와야 한다.
 */
export const MAIN_BASE_STATS: BaseStats = {
  hp: 4000,
  damage: 28,
  hitSpeed: seconds(1.0, TICK_RATE),
  range: tiles(6.5),
};

/**
 * 확장 기지는 본진보다 약하다 — 지켜야 하는 대상이라야 공방이 생긴다.
 *
 * 자체 방어(뎀 55)가 너무 강해 러시가 확장 상대로도 손해를 봤고, 그 결과
 * "무조건 배 불리기"가 지배 전략이 됐다(실측: 러시 상대 77% — COUNCIL 라운드 2).
 * 일꾼 몇 기 지킬 화력만 남기고, 병력 방어는 병력으로 하게 한다.
 */
export const EXPANSION_BASE_STATS: BaseStats = {
  hp: 1500,
  damage: 18,
  hitSpeed: seconds(1.2, TICK_RATE),
  range: tiles(5.0),
};
