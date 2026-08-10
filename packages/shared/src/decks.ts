/**
 * 덱 정의.
 *
 * 덱은 8장의 카드 목록이고, **배열 순서가 곧 순환 순서**다.
 * 앞 4장이 시작 손패이므로, 첫 4장은 값싸고 방어적인 카드로 채워야
 * 초반에 아무것도 못 하고 얻어맞는 상황이 생기지 않는다.
 *
 * 시뮬레이션은 이미 양쪽에 서로 다른 덱을 받도록 되어 있다
 * (`createState(seed, [deck0, deck1])`). 덱을 늘리는 데 구조 변경은 필요 없다.
 */

import { DECK_SIZE, HAND_SIZE } from './constants.js';
import { CARDS } from './cards.js';

export interface DeckDef {
  id: string;
  name: string;
  /** 한 줄 컨셉 — 덱 선택 UI에 노출된다 */
  tagline: string;
  /** UI 대표 색 */
  color: number;
  /** 8장. 앞 4장이 시작 손패 */
  cards: readonly string[];
}

const defs: DeckDef[] = [
  {
    id: 'pomingpu',
    name: '포밍뿌',
    tagline: '균형형 — 특수 능력 없이 기본기로 싸운다',
    color: 0xec4899,
    cards: [
      // 시작 손패: 원거리 / 스웜 / 저가 압박 / 방어건물
      'mingttu',
      'swarm',
      'runner',
      'cannon',
      'archers',
      'pubi',
      'arrows',
      'porongi',
    ],
  },
  {
    id: 'steel',
    name: '기갑단',
    tagline: '방어형 — 방어선을 세우고 사거리로 카운터친다',
    color: 0x3b82f6,
    cards: [
      'rifleman',
      'flamer',
      'scoutcar',
      'bulwark',
      'ironwalker',
      'carpetbomb',
      'gunship',
      'siegetank',
    ],
  },
  {
    id: 'swarmhive',
    name: '군체',
    tagline: '물량형 — 싸고 빠른 개체로 숫자를 앞세운다',
    color: 0x9f1239,
    cards: [
      'gnawer',
      'spitter',
      'tunneler',
      'spinetentacle',
      'burrower',
      'sporetentacle',
      'wingswarm',
      'devourer',
    ],
  },
  {
    id: 'covenant',
    name: '신념단',
    tagline: '고효율형 — 비싸지만 한 방이 무겁다',
    color: 0x06b6d4,
    cards: [
      'zealot',
      'lightpylon',
      'mindbreak',
      'strider',
      'mystic',
      'shade',
      'skiff',
      'fusionite',
    ],
  },
];

/* ── 정합성 검증 ───────────────────────────────────────────────────────
   덱 오타는 런타임에 `unknown card` 예외로 터지는데, 그게 시뮬 도중이면
   경기가 통째로 죽는다. 모듈 로드 시점에 미리 잡는다. */
for (const d of defs) {
  if (d.cards.length !== DECK_SIZE) {
    throw new Error(`덱 '${d.id}'의 카드가 ${d.cards.length}장 (${DECK_SIZE}장이어야 함)`);
  }
  const seen = new Set<string>();
  for (const c of d.cards) {
    if (!CARDS.has(c)) throw new Error(`덱 '${d.id}'에 존재하지 않는 카드: '${c}'`);
    if (seen.has(c)) throw new Error(`덱 '${d.id}'에 중복 카드: '${c}'`);
    seen.add(c);
  }
}

export const DECKS: ReadonlyMap<string, DeckDef> = new Map(defs.map((d) => [d.id, d]));

/** 순회 순서가 필요할 때 쓰는 정렬된 덱 ID 목록 */
export const DECK_IDS: readonly string[] = defs.map((d) => d.id);

export const DEFAULT_DECK_ID = 'pomingpu';

/** 알 수 없는 id는 기본 덱으로 떨어뜨린다 (구버전 클라이언트 대응) */
export function getDeck(id: string | undefined): DeckDef {
  const d = id ? DECKS.get(id) : undefined;
  return d ?? DECKS.get(DEFAULT_DECK_ID)!;
}

/** 시작 손패 (앞 4장) */
export function openingHand(d: DeckDef): readonly string[] {
  return d.cards.slice(0, HAND_SIZE);
}

/** 하위 호환: 덱을 지정하지 않았을 때의 카드 목록 */
export const DEFAULT_DECK: readonly string[] = getDeck(DEFAULT_DECK_ID).cards;
