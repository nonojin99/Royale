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
];

export const RELIC_BY_ID: ReadonlyMap<string, RelicDef> = new Map(RELICS.map((r) => [r.id, r]));
