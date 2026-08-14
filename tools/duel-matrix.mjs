/**
 * 유닛 결투 매트릭스 — 등코스트 모의 전투로 이상치(버그성 유닛)를 찾는다.
 *
 * 라운드 20의 두 가지 오염 교훈을 도구에 박았다:
 *   1. 스폰은 성공을 단언한다 (벽 타일 스폰 = 조용한 전승 허상)
 *   2. 결투장은 양 본진에서 멀고, 두 편은 획득 범위(5.5타일) 안에 놓는다
 *
 * 사용: node tools/duel-matrix.mjs [--budget 8]
 * 출력: 승률 매트릭스 + 유닛별 종합 점수 + 이상치 표시
 */
import { createState, step, applyCommand, getUnit, UNIT_IDS } from '../packages/shared/dist/index.js';

const budget = Number(process.argv[process.argv.indexOf('--budget') + 1]) || 8;

/** 예산에 맞는 카드 수 — 코스트가 예산을 넘지 않는 최대 장수 (최소 1장) */
function cardsFor(id) {
  const u = getUnit(id);
  return Math.max(1, Math.floor(budget / u.cost));
}

/** 검증된 중립 평지 (coast (13,8)~(26,11), 양 본진에서 15타일 이상) */
function duel(aId, bId) {
  const s = createState(7, ['covenant', 'steel'], 'coast', true);
  const spawn = (team, id, n, x0) => {
    let ok = 0;
    for (let i = 0; i < n; i++) {
      ok += applyCommand(s, {
        execTick: s.tick, team, kind: 'unit', id,
        x: x0 + (i % 2) * 900, y: 8800 + ((i / 2) | 0) * 900,
      }) ? 1 : 0;
    }
    return ok === n;
  };
  if (!spawn(0, aId, cardsFor(aId), 17000)) throw new Error(`스폰 실패 ${aId}`);
  if (!spawn(1, bId, cardsFor(bId), 22500)) throw new Error(`스폰 실패 ${bId}`);

  for (let i = 0; i < 1200; i++) {
    step(s, []);
    const a = s.entities.some((e) => e.kind === 'unit' && e.team === 0);
    const b = s.entities.some((e) => e.kind === 'unit' && e.team === 1);
    if (!a || !b) break;
  }
  // 생존 코스트 비율로 판정 — 전멸 못 시켜도 우세가 드러난다
  const costOf = (team) =>
    s.entities
      .filter((e) => e.kind === 'unit' && e.team === team)
      .reduce((sum, e) => sum + getUnit(e.unit).cost / Math.max(1, getUnit(e.unit).count), 0);
  const a = costOf(0);
  const b = costOf(1);
  return a > b ? 1 : a < b ? 0 : 0.5;
}

const ground = UNIT_IDS.filter((id) => {
  const u = getUnit(id);
  return u.kind === 'unit' && !u.flying;
});
const air = UNIT_IDS.filter((id) => {
  const u = getUnit(id);
  return u.kind === 'unit' && u.flying;
});

function matrix(ids, label) {
  console.log(`\n── ${label} (예산 ${budget}코) ──`);
  const score = new Map(ids.map((id) => [id, 0]));
  for (const a of ids) {
    const row = [];
    for (const b of ids) {
      if (a === b) { row.push(' - '); continue; }
      const w = duel(a, b);
      score.set(a, score.get(a) + w);
      row.push(w === 1 ? ' ○ ' : w === 0 ? ' × ' : ' △ ');
    }
    console.log(getUnit(a).name.padEnd(6), row.join(''));
  }
  console.log('\n종합 (전승·전패는 이상치):');
  const max = ids.length - 1;
  for (const [id, sc] of [...score.entries()].sort((x, y) => y[1] - x[1])) {
    const flag = sc === max ? ' ⚠️ 전승' : sc === 0 ? ' ⚠️ 전패' : '';
    console.log(' ', getUnit(id).name.padEnd(6), sc + '/' + max + flag);
  }
}

matrix(ground, '지상전 매트릭스');
// 공중은 대공 가능한 지상 유닛과도 붙인다
const aa = ground.filter((id) => getUnit(id).targets !== 'ground' && getUnit(id).targets !== 'buildings');
matrix([...air, ...aa], '공중 관련 매트릭스');
