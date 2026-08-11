/**
 * 종족과 테크트리.
 *
 * 유닛은 처음부터 쓸 수 있는 게 아니라 **미네랄을 들여 해금**해야 한다.
 * 해금과 생산이 같은 자원을 쓰기 때문에 매 순간 선택이 생긴다:
 *
 *     지금 병력을 뽑을까 · 확장할까 · 테크를 올릴까
 *
 * 이 셋을 가르는 것이 이 게임의 실력이다. 특히 연구 중에는 그 미네랄로 병력을
 * 못 뽑으므로, 테크를 올리는 동안은 언제나 얇다 — 그 틈을 찌르는 것이 공격 타이밍이다.
 */

import { TICK_RATE } from './constants.js';
import { UNITS } from './units.js';

export interface TechNode {
  /** 해금되는 유닛 id */
  unit: string;
  /** 해금 비용 (미네랄 정수 단위). 0이면 경기 시작부터 열려 있다 */
  cost: number;
  /** 연구 시간 (틱). 0이면 즉시 */
  researchTicks: number;
  /** 선행으로 해금되어 있어야 하는 유닛 id */
  requires: string | null;
  /** 표시용 단계 (0 = 시작 해금) */
  tier: number;
}

export interface FactionDef {
  id: string;
  name: string;
  tagline: string;
  /** UI 대표 색 */
  color: number;
  /** 기지를 세운 땅에 물드는 종족 필드 색 (외관 전용 — 시뮬에 영향 없음) */
  fieldColor: number;
  tech: TechNode[];
}

/** 단계별 기본값 — 개별 노드에서 덮어쓸 수 있다 */
const T1 = { cost: 6, researchTicks: 8 * TICK_RATE };
const T2 = { cost: 12, researchTicks: 15 * TICK_RATE };

function start(unit: string): TechNode {
  return { unit, cost: 0, researchTicks: 0, requires: null, tier: 0 };
}
function tier1(unit: string): TechNode {
  return { unit, ...T1, requires: null, tier: 1 };
}
function tier2(unit: string, requires: string): TechNode {
  return { unit, ...T2, requires, tier: 2 };
}

const defs: FactionDef[] = [
  {
    id: 'steel',
    name: '기갑단',
    tagline: '방어형 — 방어선을 세우고 사거리로 카운터친다',
    color: 0x3b82f6,
    fieldColor: 0x1e3a8a,
    tech: [
      start('rifleman'), // 지상+공중 원거리 — 초반 만능
      start('scoutcar'), // 건물 직행 — 확장 견제
      tier1('flamer'),
      tier1('bulwark'),
      tier1('ironwalker'),
      tier2('siegetank', 'flamer'),
      tier2('gunship', 'ironwalker'),
      tier2('carpetbomb', 'bulwark'),
    ],
  },
  {
    id: 'swarmhive',
    name: '군체',
    tagline: '물량형 — 싸고 빠른 개체로 숫자를 앞세운다',
    color: 0x9f1239,
    fieldColor: 0x4c0519,
    tech: [
      start('gnawer'), // 초저가 근접 스웜
      start('spitter'), // 지상+공중 원거리
      tier1('tunneler'),
      tier1('spinetentacle'),
      tier1('burrower'),
      tier2('sporetentacle', 'spinetentacle'),
      tier2('wingswarm', 'burrower'),
      tier2('devourer', 'tunneler'),
    ],
  },
  {
    id: 'covenant',
    name: '신념단',
    tagline: '고효율형 — 비싸지만 한 방이 무겁다',
    color: 0x06b6d4,
    fieldColor: 0x164e63,
    tech: [
      start('zealot'), // 근접 전선
      start('lightpylon'), // 지상+공중 방어 건물 — 초반 대공까지 겸한다
      tier1('strider'),
      tier1('shade'),
      tier1('mystic'),
      tier2('fusionite', 'strider'),
      tier2('skiff', 'mystic'),
      tier2('mindbreak', 'shade'),
    ],
  },
];

/* ── 정합성 검증 ───────────────────────────────────────────────────────
   테크트리 오타는 경기 도중 예외로 터지는데, 그러면 매치가 통째로 죽는다.
   모듈 로드 시점에 미리 잡는다. */
for (const f of defs) {
  const seen = new Set<string>();
  for (const node of f.tech) {
    if (!UNITS.has(node.unit)) {
      throw new Error(`종족 '${f.id}'에 존재하지 않는 유닛: '${node.unit}'`);
    }
    if (seen.has(node.unit)) {
      throw new Error(`종족 '${f.id}'에 중복 유닛: '${node.unit}'`);
    }
    seen.add(node.unit);
  }
  for (const node of f.tech) {
    if (node.requires && !seen.has(node.requires)) {
      throw new Error(`종족 '${f.id}'의 '${node.unit}' 선행 '${node.requires}'가 트리에 없다`);
    }
    if (node.requires === node.unit) {
      throw new Error(`종족 '${f.id}'의 '${node.unit}'이 자기 자신을 선행으로 삼는다`);
    }
  }
  if (!f.tech.some((n) => n.cost === 0)) {
    throw new Error(`종족 '${f.id}'에 시작 해금 유닛이 없다 — 경기를 시작할 수 없다`);
  }
}

export const FACTIONS: ReadonlyMap<string, FactionDef> = new Map(defs.map((d) => [d.id, d]));

/** 순회 순서가 필요할 때 쓰는 정렬된 종족 ID 목록 */
export const FACTION_IDS: readonly string[] = defs.map((d) => d.id);

export const DEFAULT_FACTION_ID = 'steel';

/** 알 수 없는 id는 기본 종족으로 떨어뜨린다 (구버전 클라이언트 대응) */
export function getFaction(id: string | undefined): FactionDef {
  const f = id ? FACTIONS.get(id) : undefined;
  return f ?? FACTIONS.get(DEFAULT_FACTION_ID)!;
}

export function findTech(faction: FactionDef, unit: string): TechNode | undefined {
  return faction.tech.find((n) => n.unit === unit);
}

/** 경기 시작부터 열려 있는 유닛 (id 오름차순 — 결정론) */
export function startingUnlocks(faction: FactionDef): string[] {
  return faction.tech
    .filter((n) => n.cost === 0)
    .map((n) => n.unit)
    .sort();
}
