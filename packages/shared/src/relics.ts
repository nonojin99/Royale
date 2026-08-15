/**
 * 침공 드래프트 유물 (라운드 25).
 *
 * 효과는 sim.ts의 훅에 산다 — 여기는 목록과 문구뿐이다. 유닛 해금 카드는
 * 'unlock:<unitId>' 형태로 드래프트 풀에서 즉석 생성된다.
 */
export interface RelicDef {
  id: string;
  name: string;
  desc: string;
  /**
   * 특성 유물 (3축, 라운드 32) — 이 유닛만 바뀐다. 없으면 전군.
   *
   * 같은 유닛이 런마다 다른 역할이 되는 것이 목적이다: 소총병이 저격수가
   * 되기도 하고, 강철거인이 자폭병이 되기도 한다. 겨냥한 유닛을 아직
   * 해금하지 못했으면 드래프트에 나오지 않는다 — 죽은 카드를 뽑게 하면
   * 3택1이 2택1이 된다.
   */
  unit?: string;
  /** 배수·가산 보정 (정수 백분율 / 밀리타일) */
  mod?: { damagePct?: number; rangeAdd?: number; hpPct?: number; speedPct?: number };
  /** 죽을 때 터진다 */
  onDeath?: { damage: number; radius: number };
}

export const RELICS: readonly RelicDef[] = [
  { id: 'rich_veins', name: '풍부한 광맥', desc: '채굴 효율 50% → 80%' },
  { id: 'war_drums', name: '사기 충천', desc: '전군 공격 +10% (강화와 중첩)' },
  { id: 'iron_heart', name: '강철 심장', desc: '이후 짓는 기지·건물 체력 +30%' },
  { id: 'fast_deploy', name: '신속 배치', desc: '배치 경직 절반' },
  { id: 'focus', name: '집중', desc: '충전 스킬 게이지 2배 속도' },
  { id: 'reserves', name: '예비군', desc: '파도 소탕 보상 +30%' },
  { id: 'deep_roots', name: '깊은 뿌리', desc: '이후 짓는 방어 건물 수명 2배' },
  { id: 'cheap_walls', name: '값싼 방벽', desc: '방어 건물 코스트 -1' },

  /* ── 특성 유물 (3축) — 유닛 하나의 성격을 바꾼다 ─────────────────── */
  {
    id: 'marksman', name: '정밀 조준', desc: '소총병 사거리 +1.5타일',
    unit: 'rifleman', mod: { rangeAdd: 1500 },
  },
  {
    id: 'zeal', name: '광신', desc: '광전사 공격 +35%',
    unit: 'zealot', mod: { damagePct: 35 },
  },
  {
    id: 'volatile_core', name: '불안정 노심', desc: '강철거인이 죽을 때 폭발 (240 · 2.5타일)',
    unit: 'ironwalker', onDeath: { damage: 240, radius: 2500 },
  },
  {
    id: 'carapace', name: '갑각', desc: '물어뜯는것 체력 +70%',
    unit: 'gnawer', mod: { hpPct: 70 },
  },
  {
    id: 'siege_manual', name: '포격 교본', desc: '공성전차 공격 +30%',
    unit: 'siegetank', mod: { damagePct: 30 },
  },
  {
    id: 'stimpack', name: '전투 각성제', desc: '전군 이동 속도 +18%',
    mod: { speedPct: 18 },
  },
];

export const RELIC_BY_ID: ReadonlyMap<string, RelicDef> = new Map(RELICS.map((r) => [r.id, r]));
