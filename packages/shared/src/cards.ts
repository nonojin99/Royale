/**
 * 카드 / 유닛 데이터 테이블.
 *
 * 밸런싱은 전부 여기서 일어난다. 시뮬레이션 로직(sim.ts)에는 특정 카드 이름이
 * 하드코딩되어 있지 않으므로, 카드 추가는 이 파일에 항목 하나를 더하는 것으로 끝난다.
 *
 * 단위:
 *   hp, damage      정수
 *   range, splash   밀리타일
 *   speed           틱당 밀리타일
 *   hitSpeed        틱
 *
 * ── 네이밍에 관하여 ──────────────────────────────────────────────────────
 * 카드의 "역할 구조"(값싼 원거리 물량 / 근접 광역 / 공성 / 대공 전용 건물 …)는
 * 실시간 전략 장르에서 수십 년간 검증된 배치를 참고했지만, 이름과 비주얼은 전부
 * 오리지널이다. 특정 상용 IP의 고유명사·디자인을 가져다 쓰지 않는다.
 */

import { TICK_RATE } from './constants.js';
import { seconds, tiles } from './fixed.js';

export type CardKind = 'unit' | 'building' | 'spell';

/**
 * 무엇을 공격 대상으로 삼는가.
 *   any        지상·공중 모두
 *   ground     지상만 (공중 유닛을 때리지 못한다)
 *   air        공중만 (대공 전용 건물)
 *   buildings  건물·타워만 (유닛을 무시하고 직행)
 */
export type TargetPref = 'any' | 'ground' | 'air' | 'buildings';

export interface CardDef {
  id: string;
  name: string;
  cost: number;
  kind: CardKind;
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
type CardSpec = Omit<CardDef, 'count' | 'splash' | 'targets' | 'flying' | 'lifetime'> &
  Partial<Pick<CardDef, 'count' | 'splash' | 'targets' | 'flying' | 'lifetime'>>;

function card(spec: CardSpec): CardDef {
  return {
    count: 1,
    splash: 0,
    targets: 'any',
    flying: false,
    lifetime: -1,
    ...spec,
  };
}

/** 건물 기본 수명 — 40초. 방어 건물이 영구히 남으면 공격이 성립하지 않는다. */
const BUILDING_LIFE = seconds(40, TICK_RATE);

const defs: CardDef[] = [
  /* ── 포밍뿌 (원년 덱) ─────────────────────────────────────────────────
     캐릭터 IP 기반의 균형형 덱. 특수 메커니즘 없이 기본기만으로 구성된다. */
  card({
    id: 'porongi', name: '포롱이', cost: 5, kind: 'unit',
    hp: 1400, damage: 160, hitSpeed: seconds(1.5, TICK_RATE),
    range: tiles(0.8), speed: spd(0.6), targets: 'ground', color: 0x22c55e,
  }),
  card({
    id: 'pubi', name: '뿌비', cost: 4, kind: 'unit',
    hp: 800, damage: 120, hitSpeed: seconds(1.4, TICK_RATE),
    range: tiles(1.2), speed: spd(0.9), splash: tiles(1.5),
    targets: 'ground', color: 0x14b8a6,
  }),
  card({
    id: 'mingttu', name: '밍뚜', cost: 3, kind: 'unit',
    hp: 340, damage: 110, hitSpeed: seconds(1.1, TICK_RATE),
    range: tiles(5.5), speed: spd(1.0), color: 0xf97316,
  }),
  card({
    id: 'archers', name: '활잡이', cost: 3, kind: 'unit', count: 2,
    hp: 250, damage: 70, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(5.0), speed: spd(1.0), color: 0xa855f7,
  }),
  card({
    id: 'swarm', name: '꼬마떼', cost: 3, kind: 'unit', count: 4,
    hp: 120, damage: 60, hitSpeed: seconds(0.9, TICK_RATE),
    range: tiles(0.7), speed: spd(1.3), targets: 'ground', color: 0xeab308,
  }),
  card({
    id: 'runner', name: '돌격병', cost: 2, kind: 'unit',
    hp: 600, damage: 150, hitSpeed: seconds(1.2, TICK_RATE),
    range: tiles(0.7), speed: spd(1.8), targets: 'buildings', color: 0xef4444,
  }),
  card({
    id: 'cannon', name: '대포', cost: 3, kind: 'building',
    hp: 700, damage: 90, hitSpeed: seconds(0.8, TICK_RATE),
    range: tiles(5.5), speed: 0, lifetime: seconds(30, TICK_RATE), color: 0x64748b,
  }),
  card({
    id: 'arrows', name: '화살비', cost: 3, kind: 'spell', count: 0,
    hp: 0, damage: 220, hitSpeed: 0, range: 0, speed: 0,
    splash: tiles(3.0), color: 0x0ea5e9,
  }),

  /* ── 기갑단 ───────────────────────────────────────────────────────────
     방어선을 세우고 카운터친다. 건물이 강하고 원거리 유닛이 많다.
     느린 대신 사거리로 이득을 보는 종족. */
  card({
    id: 'rifleman', name: '소총병', cost: 3, kind: 'unit', count: 3,
    hp: 200, damage: 50, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(5.0), speed: spd(1.0), color: 0x3b82f6,
  }),
  card({
    id: 'flamer', name: '화염병', cost: 3, kind: 'unit', count: 2,
    hp: 480, damage: 85, hitSpeed: seconds(1.3, TICK_RATE),
    range: tiles(1.2), speed: spd(0.95), splash: tiles(1.4),
    targets: 'ground', color: 0xf97316,
  }),
  card({
    id: 'scoutcar', name: '정찰차', cost: 2, kind: 'unit',
    hp: 420, damage: 130, hitSpeed: seconds(1.1, TICK_RATE),
    range: tiles(0.8), speed: spd(1.9), targets: 'buildings', color: 0xfbbf24,
  }),
  card({
    id: 'siegetank', name: '공성전차', cost: 5, kind: 'unit',
    hp: 1000, damage: 230, hitSpeed: seconds(2.2, TICK_RATE),
    range: tiles(7.0), speed: spd(0.45), splash: tiles(2.0),
    targets: 'ground', color: 0x1d4ed8,
  }),
  card({
    id: 'ironwalker', name: '강철거인', cost: 4, kind: 'unit',
    hp: 850, damage: 110, hitSpeed: seconds(1.2, TICK_RATE),
    range: tiles(5.5), speed: spd(0.8), color: 0x475569,
  }),
  card({
    id: 'bulwark', name: '방벽', cost: 3, kind: 'building',
    hp: 800, damage: 85, hitSpeed: seconds(0.8, TICK_RATE),
    range: tiles(5.5), speed: 0, lifetime: BUILDING_LIFE, color: 0x78716c,
  }),
  card({
    id: 'gunship', name: '전투비행선', cost: 4, kind: 'unit', flying: true,
    hp: 700, damage: 100, hitSpeed: seconds(1.3, TICK_RATE),
    range: tiles(3.0), speed: spd(1.1), color: 0x0891b2,
  }),
  card({
    id: 'carpetbomb', name: '융단폭격', cost: 3, kind: 'spell', count: 0,
    hp: 0, damage: 240, hitSpeed: 0, range: 0, speed: 0,
    splash: tiles(3.0), color: 0xdc2626,
  }),

  /* ── 군체 ─────────────────────────────────────────────────────────────
     숫자로 압도한다. 개체는 약하지만 싸고 빠르다.
     주문이 없는 대신 방어 건물이 둘(지상용·대공용)이다. */
  card({
    id: 'gnawer', name: '물어뜯는것', cost: 2, kind: 'unit', count: 4,
    hp: 130, damage: 55, hitSpeed: seconds(0.8, TICK_RATE),
    range: tiles(0.7), speed: spd(1.5), targets: 'ground', color: 0xa16207,
  }),
  card({
    id: 'spitter', name: '가시뱉는것', cost: 3, kind: 'unit', count: 2,
    hp: 300, damage: 65, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(4.5), speed: spd(1.05), color: 0x84cc16,
  }),
  card({
    id: 'burrower', name: '땅속의것', cost: 4, kind: 'unit',
    hp: 550, damage: 150, hitSpeed: seconds(1.6, TICK_RATE),
    range: tiles(4.5), speed: spd(0.5), splash: tiles(1.8),
    targets: 'ground', color: 0x713f12,
  }),
  card({
    id: 'devourer', name: '거대포식자', cost: 5, kind: 'unit',
    hp: 1600, damage: 170, hitSpeed: seconds(1.5, TICK_RATE),
    range: tiles(0.9), speed: spd(0.7), splash: tiles(1.2),
    targets: 'ground', color: 0x7c2d12,
  }),
  card({
    id: 'spinetentacle', name: '가시촉수', cost: 3, kind: 'building',
    hp: 750, damage: 110, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(4.5), speed: 0, targets: 'ground',
    lifetime: BUILDING_LIFE, color: 0x9f1239,
  }),
  card({
    id: 'wingswarm', name: '날개무리', cost: 4, kind: 'unit', count: 3, flying: true,
    hp: 240, damage: 65, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(2.5), speed: spd(1.4), color: 0xc026d3,
  }),
  card({
    id: 'sporetentacle', name: '포자촉수', cost: 3, kind: 'building',
    hp: 600, damage: 200, hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(6.0), speed: 0, targets: 'air',
    lifetime: BUILDING_LIFE, color: 0x86198f,
  }),
  card({
    id: 'tunneler', name: '굴착충', cost: 2, kind: 'unit',
    hp: 520, damage: 140, hitSpeed: seconds(1.2, TICK_RATE),
    range: tiles(0.7), speed: spd(1.6), targets: 'buildings', color: 0xca8a04,
  }),

  /* ── 신념단 ───────────────────────────────────────────────────────────
     비싸지만 한 방이 무겁다. 개체 하나하나가 강해 물량에 밀리지 않는다.
     대신 실수 한 번의 비용이 크다. */
  card({
    id: 'zealot', name: '광전사', cost: 3, kind: 'unit', count: 2,
    hp: 700, damage: 120, hitSpeed: seconds(1.3, TICK_RATE),
    range: tiles(0.8), speed: spd(0.95), targets: 'ground', color: 0xfacc15,
  }),
  card({
    id: 'strider', name: '사격보행기', cost: 4, kind: 'unit',
    hp: 700, damage: 140, hitSpeed: seconds(1.4, TICK_RATE),
    range: tiles(6.0), speed: spd(0.8), color: 0x0d9488,
  }),
  card({
    id: 'mystic', name: '술사', cost: 4, kind: 'unit',
    hp: 300, damage: 130, hitSpeed: seconds(1.6, TICK_RATE),
    range: tiles(5.0), speed: spd(0.9), splash: tiles(2.0),
    targets: 'ground', color: 0x8b5cf6,
  }),
  card({
    id: 'fusionite', name: '융합체', cost: 5, kind: 'unit',
    hp: 1300, damage: 200, hitSpeed: seconds(1.6, TICK_RATE),
    range: tiles(1.0), speed: spd(0.8), splash: tiles(1.6), color: 0x06b6d4,
  }),
  card({
    id: 'lightpylon', name: '빛기둥', cost: 3, kind: 'building',
    hp: 700, damage: 95, hitSpeed: seconds(0.9, TICK_RATE),
    // 하늘색(0x38bdf8)은 렌더러의 아군 팀 색과 겹쳐서, 적 빛기둥이 아군 건물처럼
    // 보인다. 카드 색은 팀 색과 반드시 구분되어야 한다.
    range: tiles(5.5), speed: 0, lifetime: BUILDING_LIFE, color: 0xfcd34d,
  }),
  card({
    id: 'shade', name: '그림자', cost: 4, kind: 'unit',
    hp: 550, damage: 320, hitSpeed: seconds(1.8, TICK_RATE),
    range: tiles(0.8), speed: spd(1.2), targets: 'ground', color: 0x4c1d95,
  }),
  card({
    id: 'skiff', name: '부유선', cost: 4, kind: 'unit', flying: true,
    hp: 650, damage: 90, hitSpeed: seconds(1.1, TICK_RATE),
    range: tiles(3.5), speed: spd(1.0), splash: tiles(1.3),
    targets: 'ground', color: 0xe879f9,
  }),
  card({
    id: 'mindbreak', name: '정신붕괴', cost: 3, kind: 'spell', count: 0,
    hp: 0, damage: 260, hitSpeed: 0, range: 0, speed: 0,
    splash: tiles(2.6), color: 0x7e22ce,
  }),
];

export const CARDS: ReadonlyMap<string, CardDef> = new Map(defs.map((d) => [d.id, d]));

/** 정렬된 카드 ID 목록 — 순회 순서가 필요할 때 Map 대신 이걸 쓴다 (결정론) */
export const CARD_IDS: readonly string[] = defs.map((d) => d.id);

export function getCard(id: string): CardDef {
  const c = CARDS.get(id);
  if (!c) throw new Error(`unknown card: ${id}`);
  return c;
}

/* ── 타워 스탯 ─────────────────────────────────────────────────────────── */

export interface TowerStats {
  hp: number;
  damage: number;
  hitSpeed: number;
  range: number;
}

/**
 * 타워는 지상·공중을 모두 공격한다.
 * 타워가 공중을 때리지 못하면 공중 유닛만으로 무한정 타워를 부술 수 있어
 * 게임이 성립하지 않는다.
 */
export const PRINCESS_STATS: TowerStats = {
  hp: 2400,
  damage: 90,
  hitSpeed: seconds(0.8, TICK_RATE),
  range: tiles(7.5),
};

export const KING_STATS: TowerStats = {
  hp: 4000,
  damage: 120,
  hitSpeed: seconds(1.0, TICK_RATE),
  range: tiles(7.0),
};
