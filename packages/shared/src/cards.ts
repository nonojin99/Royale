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
 */

import { TICK_RATE } from './constants.js';
import { seconds, tiles } from './fixed.js';

export type CardKind = 'unit' | 'building' | 'spell';
/** 무엇을 공격 대상으로 삼는가 */
export type TargetPref = 'any' | 'buildings';

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
  /** 건물 수명 (틱). -1이면 무한 */
  lifetime: number;
  /** UI 색상 */
  color: number;
}

/** 타일/초 단위를 틱당 밀리타일로 */
function spd(tilesPerSec: number): number {
  return Math.round((tilesPerSec * 1000) / TICK_RATE);
}

const defs: CardDef[] = [
  {
    id: 'porongi',
    name: '포롱이',
    cost: 5,
    kind: 'unit',
    count: 1,
    hp: 1400,
    damage: 160,
    hitSpeed: seconds(1.5, TICK_RATE),
    range: tiles(0.8),
    speed: spd(0.6),
    splash: 0,
    targets: 'any',
    lifetime: -1,
    color: 0x22c55e,
  },
  {
    id: 'pubi',
    name: '뿌비',
    cost: 4,
    kind: 'unit',
    count: 1,
    hp: 800,
    damage: 120,
    hitSpeed: seconds(1.4, TICK_RATE),
    range: tiles(1.2),
    speed: spd(0.9),
    splash: tiles(1.5),
    targets: 'any',
    lifetime: -1,
    color: 0x14b8a6,
  },
  {
    id: 'mingttu',
    name: '밍뚜',
    cost: 3,
    kind: 'unit',
    count: 1,
    hp: 340,
    damage: 110,
    hitSpeed: seconds(1.1, TICK_RATE),
    range: tiles(5.5),
    speed: spd(1.0),
    splash: 0,
    targets: 'any',
    lifetime: -1,
    color: 0xf97316,
  },
  {
    id: 'archers',
    name: '활잡이',
    cost: 3,
    kind: 'unit',
    count: 2,
    hp: 250,
    damage: 70,
    hitSpeed: seconds(1.0, TICK_RATE),
    range: tiles(5.0),
    speed: spd(1.0),
    splash: 0,
    targets: 'any',
    lifetime: -1,
    color: 0xa855f7,
  },
  {
    id: 'swarm',
    name: '꼬마떼',
    cost: 3,
    kind: 'unit',
    count: 4,
    hp: 120,
    damage: 60,
    hitSpeed: seconds(0.9, TICK_RATE),
    range: tiles(0.7),
    speed: spd(1.3),
    splash: 0,
    targets: 'any',
    lifetime: -1,
    color: 0xeab308,
  },
  {
    id: 'runner',
    name: '돌격병',
    cost: 2,
    kind: 'unit',
    count: 1,
    hp: 600,
    damage: 150,
    hitSpeed: seconds(1.2, TICK_RATE),
    range: tiles(0.7),
    speed: spd(1.8),
    splash: 0,
    targets: 'buildings',
    lifetime: -1,
    color: 0xef4444,
  },
  {
    id: 'cannon',
    name: '대포',
    cost: 3,
    kind: 'building',
    count: 1,
    hp: 700,
    damage: 90,
    hitSpeed: seconds(0.8, TICK_RATE),
    range: tiles(5.5),
    speed: 0,
    splash: 0,
    targets: 'any',
    lifetime: seconds(30, TICK_RATE),
    color: 0x64748b,
  },
  {
    id: 'arrows',
    name: '화살비',
    cost: 3,
    kind: 'spell',
    count: 0,
    hp: 0,
    damage: 220,
    hitSpeed: 0,
    range: 0,
    speed: 0,
    splash: tiles(3.0),
    targets: 'any',
    lifetime: -1,
    color: 0x0ea5e9,
  },
];

export const CARDS: ReadonlyMap<string, CardDef> = new Map(defs.map((d) => [d.id, d]));

/** 정렬된 카드 ID 목록 — 순회 순서가 필요할 때 Map 대신 이걸 쓴다 (결정론) */
export const CARD_IDS: readonly string[] = defs.map((d) => d.id);

export function getCard(id: string): CardDef {
  const c = CARDS.get(id);
  if (!c) throw new Error(`unknown card: ${id}`);
  return c;
}

/** v1 기본 덱 — 8종 전부 */
export const DEFAULT_DECK: readonly string[] = CARD_IDS;

/* ── 타워 스탯 ─────────────────────────────────────────────────────────── */

export interface TowerStats {
  hp: number;
  damage: number;
  hitSpeed: number;
  range: number;
}

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
