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

import { TICK_RATE } from './constants.js';
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
    id: 'rifleman', name: '소총병', cost: 3, kind: 'unit', count: 3,
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
    id: 'scoutcar', name: '정찰차', cost: 2, kind: 'unit',
    hp: 420, damage: 130, hitSpeed: seconds(1.1, TICK_RATE),
    range: tiles(0.8), speed: spd(1.4), targets: 'buildings', siege: 120, color: 0xfbbf24,
  }),
  unit({
    id: 'siegetank', name: '공성전차', cost: 5, kind: 'unit',
    hp: 1000, damage: 230, hitSpeed: seconds(2.2, TICK_RATE),
    range: tiles(7.0), speed: spd(0.45), splash: tiles(2.0),
    targets: 'ground', siege: 220, color: 0x1d4ed8,
  }),
  unit({
    id: 'ironwalker', name: '강철거인', cost: 4, kind: 'unit',
    hp: 850, damage: 110, hitSpeed: seconds(1.2, TICK_RATE),
    range: tiles(5.5), speed: spd(0.8), siege: 120, color: 0x475569,
  }),
  unit({
    id: 'bulwark', name: '방벽', cost: 2, kind: 'building',
    hp: 1000, damage: 150, hitSpeed: seconds(0.8, TICK_RATE),
    range: tiles(5.5), speed: 0, lifetime: BUILDING_LIFE, color: 0x78716c,
  }),
  unit({
    id: 'gunship', name: '전투비행선', cost: 4, kind: 'unit', flying: true,
    hp: 700, damage: 100, hitSpeed: seconds(1.3, TICK_RATE),
    range: tiles(3.0), speed: spd(1.1), siege: 120, color: 0x0891b2,
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
    id: 'gnawer', name: '물어뜯는것', cost: 2, kind: 'unit', count: 4,
    hp: 95, damage: 55, hitSpeed: seconds(0.8, TICK_RATE),
    range: tiles(0.7), speed: spd(1.5), targets: 'ground', siege: 40, color: 0xa16207,
  }),
  unit({
    id: 'spitter', name: '가시뱉는것', cost: 3, kind: 'unit', count: 2,
    hp: 300, damage: 65, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(4.5), speed: spd(1.05), siege: 50, color: 0x84cc16,
  }),
  unit({
    id: 'burrower', name: '땅속의것', cost: 4, kind: 'unit',
    hp: 550, damage: 150, hitSpeed: seconds(1.6, TICK_RATE),
    range: tiles(4.5), speed: spd(0.5), splash: tiles(1.8),
    targets: 'ground', siege: 100, color: 0x713f12,
  }),
  unit({
    id: 'devourer', name: '거대포식자', cost: 5, kind: 'unit',
    hp: 1600, damage: 170, hitSpeed: seconds(1.5, TICK_RATE),
    range: tiles(0.9), speed: spd(0.7), splash: tiles(1.2),
    targets: 'ground', siege: 200, color: 0x7c2d12,
  }),
  unit({
    id: 'spinetentacle', name: '가시촉수', cost: 2, kind: 'building',
    hp: 950, damage: 185, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(4.5), speed: 0, targets: 'ground',
    lifetime: BUILDING_LIFE, color: 0x9f1239,
  }),
  unit({
    id: 'wingswarm', name: '날개무리', cost: 4, kind: 'unit', count: 3, flying: true,
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
    id: 'tunneler', name: '굴착충', cost: 2, kind: 'unit',
    hp: 520, damage: 140, hitSpeed: seconds(1.2, TICK_RATE),
    range: tiles(0.7), speed: spd(1.6), targets: 'buildings', siege: 120, color: 0xca8a04,
  }),

  /* ── 신념단 ───────────────────────────────────────────────────────────
     비싸지만 한 방이 무겁다. 개체 하나하나가 강해 물량에 밀리지 않는다.
     대신 실수 한 번의 비용이 크다. */
  unit({
    id: 'zealot', name: '광전사', cost: 3, kind: 'unit', count: 2,
    hp: 700, damage: 120, hitSpeed: seconds(1.3, TICK_RATE),
    range: tiles(0.8), speed: spd(0.95), targets: 'ground', siege: 50, color: 0xfacc15,
  }),
  unit({
    id: 'strider', name: '사격보행기', cost: 4, kind: 'unit',
    hp: 700, damage: 140, hitSpeed: seconds(1.4, TICK_RATE),
    range: tiles(6.0), speed: spd(0.8), siege: 100, color: 0x0d9488,
  }),
  unit({
    id: 'mystic', name: '술사', cost: 4, kind: 'unit',
    hp: 300, damage: 130, hitSpeed: seconds(1.6, TICK_RATE),
    range: tiles(5.0), speed: spd(0.9), splash: tiles(2.0),
    targets: 'ground', siege: 80, color: 0x8b5cf6,
  }),
  unit({
    id: 'fusionite', name: '융합체', cost: 5, kind: 'unit',
    hp: 1300, damage: 200, hitSpeed: seconds(1.6, TICK_RATE),
    range: tiles(1.0), speed: spd(0.8), splash: tiles(1.6), siege: 200, color: 0x06b6d4,
  }),
  unit({
    id: 'lightpylon', name: '빛기둥', cost: 2, kind: 'building',
    hp: 900, damage: 160, hitSpeed: seconds(0.9, TICK_RATE),
    // 하늘색(0x38bdf8)은 렌더러의 아군 팀 색과 겹쳐서, 적 빛기둥이 아군 건물처럼
    // 보인다. 카드 색은 팀 색과 반드시 구분되어야 한다.
    range: tiles(5.5), speed: 0, lifetime: BUILDING_LIFE, color: 0xfcd34d,
  }),
  unit({
    id: 'shade', name: '그림자', cost: 4, kind: 'unit',
    hp: 550, damage: 320, hitSpeed: seconds(1.8, TICK_RATE),
    range: tiles(0.8), speed: spd(1.2), targets: 'ground', siege: 70, color: 0x4c1d95,
  }),
  unit({
    id: 'skiff', name: '부유선', cost: 4, kind: 'unit', flying: true,
    hp: 650, damage: 90, hitSpeed: seconds(1.1, TICK_RATE),
    range: tiles(3.5), speed: spd(1.0), splash: tiles(1.3),
    targets: 'ground', siege: 100, color: 0xe879f9,
  }),
  unit({
    id: 'mindbreak', name: '정신붕괴', cost: 3, kind: 'spell', count: 0,
    hp: 0, damage: 260, hitSpeed: 0, range: 0, speed: 0,
    splash: tiles(2.6), color: 0x7e22ce,
  }),
];

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
 * 못 막는" 수준으로 맞춘다.
 */
export const MAIN_BASE_STATS: BaseStats = {
  hp: 4000,
  damage: 45,
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
  damage: 30,
  hitSpeed: seconds(1.2, TICK_RATE),
  range: tiles(5.0),
};
