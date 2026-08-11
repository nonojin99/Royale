/**
 * 결정론 회귀 테스트.
 *
 * 이 프로젝트에서 가장 중요한 테스트다. 여기가 깨지면 두 플레이어가 서로 다른
 * 게임을 보게 되고, 그건 게임이 성립하지 않는다는 뜻이다.
 *
 * 실행: pnpm --filter @royale/shared test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARENA_H,
  ARENA_W,
  BASE_BUILD_COST,
  BASE_BUILD_TICKS,
  BASE_MINERAL_RESERVE,
  BASE_SITES,
  DEPLOY_RADIUS,
  FACTION_IDS,
  INCOME_PER_TICK,
  MATCH_TICKS,
  MINERAL_MAX,
  MINERAL_SCALE,
  MINERAL_START,
  ReplayPlayer,
  RIVER_BOT,
  RIVER_TOP,
  TEAM_COLOR_FOE,
  TEAM_COLOR_ME,
  TICK_RATE,
  UNIT_IDS,
  baseCount,
  buildReplay,
  canDeployAt,
  canResearch,
  createRng,
  createState,
  getFaction,
  getUnit,
  hashState,
  isqrt,
  isUnlocked,
  nextInt,
  nextRange,
  ownBasePositions,
  playReplay,
  restore,
  snapshot,
  sortCommands,
  step,
  summarizeReplay,
  verifyReplay,
} from '../dist/index.js';

/* ── 헬퍼 ──────────────────────────────────────────────────────────────── */

/** 기본 대전 구성 — 기갑단 미러전 */
const MIRROR = ['steel', 'steel'];

const cmd = (execTick, team, kind, id, x = 0, y = 0) => ({ execTick, team, kind, id, x, y });

/** 팀의 본진 좌표 */
function mainBase(s, team) {
  return s.entities.find((e) => e.kind === 'base' && e.isMain && e.team === team);
}

/** 본진 바로 앞(배치 가능 구역)의 좌표 */
function nearOwnBase(s, team, dx = 0, dy = 0) {
  const b = mainBase(s, team);
  return [b.x + dx, b.y + dy];
}

/**
 * 시드로부터 결정론적인 "플레이 대본"을 만든다 (Math.random 금지).
 * 유닛 생산·기지 건설·테크 해금을 섞어서 세 경로를 모두 지나가게 한다.
 */
function genCommands(seed, ticks, factions = MIRROR) {
  const rng = createRng((seed ^ 0x5bf03635) >>> 0);
  const cmds = [];
  const pools = factions.map((f) => getFaction(f).tech.map((n) => n.unit));

  for (let t = 40; t < ticks; t += 11) {
    const team = nextInt(rng, 2);
    const roll = nextInt(rng, 10);
    if (roll === 0) {
      // 기지 건설 — 아무 지점 근처를 찍는다
      const site = BASE_SITES[nextInt(rng, BASE_SITES.length)];
      cmds.push(cmd(t, team, 'base', '', site.x, site.y));
    } else if (roll === 1) {
      // 테크 해금
      const pool = pools[team];
      cmds.push(cmd(t, team, 'tech', pool[nextInt(rng, pool.length)]));
    } else {
      const pool = pools[team];
      const id = pool[nextInt(rng, pool.length)];
      const x = nextRange(rng, 1000, ARENA_W - 1000);
      const y =
        team === 0
          ? nextRange(rng, RIVER_BOT + 500, ARENA_H - 2000)
          : nextRange(rng, 2000, RIVER_TOP - 500);
      cmds.push(cmd(t, team, 'unit', id, x, y));
    }
  }
  return cmds;
}

function indexByTick(cmds) {
  const m = new Map();
  for (const c of sortCommands(cmds)) {
    const arr = m.get(c.execTick);
    if (arr) arr.push(c);
    else m.set(c.execTick, [c]);
  }
  return m;
}

/** 매치를 ticks만큼 돌리고, 100틱마다의 해시 궤적을 반환한다 */
function runMatch(seed, ticks, cmds, factions = MIRROR) {
  const s = createState(seed, factions);
  const byTick = indexByTick(cmds);
  const trace = [];
  for (let i = 0; i < ticks; i++) {
    step(s, byTick.get(s.tick) ?? []);
    if (i % 100 === 0) trace.push(hashState(s));
  }
  trace.push(hashState(s));
  return { state: s, trace };
}

/* ── 고정소수점 수학 ───────────────────────────────────────────────────── */

test('isqrt는 정확한 정수 제곱근을 낸다', () => {
  for (const n of [0, 1, 2, 3, 4, 8, 9, 15, 16, 99, 100, 101, 999999, 1e9, 2 ** 40]) {
    const r = isqrt(n);
    assert.ok(Number.isInteger(r), `${n} → ${r} 이 정수가 아님`);
    assert.ok(r * r <= n, `${n}: r²(${r * r}) > n`);
    assert.ok((r + 1) * (r + 1) > n, `${n}: (r+1)² 가 너무 작음`);
  }
});

test('isqrt는 음수/0에서 0을 낸다', () => {
  assert.equal(isqrt(-5), 0);
  assert.equal(isqrt(0), 0);
});

/* ── 핵심: 같은 입력 → 같은 상태 ───────────────────────────────────────── */

test('같은 시드 + 같은 커맨드는 동일한 해시 궤적을 만든다', () => {
  for (const seed of [1, 12345, 0xdeadbeef, 7]) {
    const cmds = genCommands(seed, 1200);
    assert.deepEqual(
      runMatch(seed, 1200, cmds).trace,
      runMatch(seed, 1200, cmds).trace,
      `시드 ${seed} 에서 궤적 불일치`,
    );
  }
});

test('커맨드 배열 순서가 뒤섞여도 sortCommands가 정규화해 동일 결과를 낸다', () => {
  const seed = 424242;
  const cmds = genCommands(seed, 1200);
  const base = runMatch(seed, 1200, cmds).trace;
  assert.deepEqual(runMatch(seed, 1200, cmds.slice().reverse()).trace, base);
  assert.deepEqual(runMatch(seed, 1200, cmds.slice(500).concat(cmds.slice(0, 500))).trace, base);
});

test('스냅샷 → 복원 후 이어서 돌려도 끊김 없이 동일하다', () => {
  const seed = 99;
  const cmds = genCommands(seed, 1500);
  const byTick = indexByTick(cmds);

  const straight = createState(seed, MIRROR);
  for (let i = 0; i < 1500; i++) step(straight, byTick.get(straight.tick) ?? []);

  const split = createState(seed, MIRROR);
  for (let i = 0; i < 700; i++) step(split, byTick.get(split.tick) ?? []);
  const snap = snapshot(split);

  const resumed = createState(seed, MIRROR);
  restore(resumed, snap);
  for (let i = 700; i < 1500; i++) step(resumed, byTick.get(resumed.tick) ?? []);

  assert.equal(hashState(resumed), hashState(straight));
});

test('JSON 왕복(네트워크 전송 시뮬)을 거쳐도 상태가 보존된다', () => {
  const { state } = runMatch(31337, 600, genCommands(31337, 600));
  const revived = createState(1, MIRROR);
  restore(revived, JSON.parse(JSON.stringify(state)));
  assert.equal(hashState(revived), hashState(state));
});

test('시뮬레이션 상태에 부동소수점이 새어 들어오지 않는다', () => {
  const { state } = runMatch(777, 2000, genCommands(777, 2000));

  for (const e of state.entities) {
    for (const k of ['x', 'y', 'hp', 'maxHp', 'cd', 'deploy', 'life', 'target', 'id', 'reserve']) {
      assert.ok(Number.isInteger(e[k]), `엔티티 ${e.id}(${e.unit})의 ${k}가 정수가 아님: ${e[k]}`);
    }
  }
  for (const p of state.players) {
    assert.ok(Number.isInteger(p.minerals), `미네랄이 정수가 아님: ${p.minerals}`);
    assert.ok(Number.isInteger(p.mined));
    if (p.research) assert.ok(Number.isInteger(p.research.ticks));
  }
  assert.ok(Number.isInteger(state.rng.s));
});

test('해금 목록은 항상 정렬 상태를 유지한다 (해시 결정론의 전제)', () => {
  const { state } = runMatch(818, 2500, genCommands(818, 2500));
  for (const p of state.players) {
    assert.deepEqual(p.unlocked, p.unlocked.slice().sort(), '해금 목록이 정렬되어 있지 않다');
  }
});

/* ── 경제 ──────────────────────────────────────────────────────────────── */

test('시작 상태는 본진 하나씩, 시작 미네랄을 갖는다', () => {
  const s = createState(5, MIRROR);
  assert.equal(s.entities.length, 2, '시작 엔티티가 본진 2개가 아니다');
  for (const team of [0, 1]) {
    assert.equal(baseCount(s, team), 1);
    assert.equal(s.players[team].minerals, MINERAL_START);
    assert.equal(s.players[team].mined, 0);
    assert.ok(mainBase(s, team), `team${team} 본진이 없다`);
  }
});

test('기지가 매 틱 채굴해서 미네랄과 누적 채굴량이 늘어난다', () => {
  const s = createState(5, MIRROR);
  step(s, []);
  assert.equal(s.players[0].mined, INCOME_PER_TICK, '한 틱 채굴량이 기대와 다르다');
  assert.equal(s.players[0].minerals, MINERAL_START + INCOME_PER_TICK);
});

test('미네랄은 상한을 넘지 않는다', () => {
  const s = createState(5, MIRROR);
  for (let i = 0; i < 2000; i++) step(s, []);
  for (const p of s.players) assert.equal(p.minerals, MINERAL_MAX);
});

test('기지 매장량은 유한하고, 고갈되면 수입이 끊긴다', () => {
  const s = createState(5, MIRROR);
  const expectedTicks = BASE_MINERAL_RESERVE / INCOME_PER_TICK;

  for (let i = 0; i < expectedTicks; i++) step(s, []);
  const base = mainBase(s, 0);
  assert.equal(base.reserve, 0, '매장량이 예상 시점에 고갈되지 않았다');
  assert.equal(s.players[0].mined, BASE_MINERAL_RESERVE, '누적 채굴량이 매장량과 다르다');

  const minedBefore = s.players[0].mined;
  for (let i = 0; i < 100; i++) step(s, []);
  assert.equal(s.players[0].mined, minedBefore, '고갈된 기지가 계속 채굴하고 있다');
});

test('기지를 늘리면 수입이 비례해서 늘어난다', () => {
  const s = createState(5, MIRROR);
  // 확장 하나를 즉시 세운다 (건설 시간 동안은 채굴하지 않는다)
  const site = BASE_SITES.find((b) => b.startFor === -1 && b.y > RIVER_BOT);
  for (let i = 0; i < 60; i++) step(s, []); // 건설비 확보
  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);
  assert.equal(baseCount(s, 0), 2, '확장 기지가 세워지지 않았다');

  // 건설 중에는 수입이 한 기지분
  const beforeReady = s.players[0].mined;
  step(s, []);
  assert.equal(s.players[0].mined - beforeReady, INCOME_PER_TICK, '건설 중 기지가 채굴했다');

  for (let i = 0; i < BASE_BUILD_TICKS; i++) step(s, []);
  const a = s.players[0].mined;
  step(s, []);
  assert.equal(s.players[0].mined - a, INCOME_PER_TICK * 2, '기지 2개의 수입이 두 배가 아니다');
});

test('미네랄이 모자라면 기지를 세울 수 없다', () => {
  const s = createState(5, MIRROR); // 시작 8, 건설비 8 → 처음엔 딱 한 번만 가능
  const free = BASE_SITES.filter((b) => b.startFor === -1);
  step(s, [
    cmd(s.tick, 0, 'base', '', free[0].x, free[0].y),
    cmd(s.tick, 0, 'base', '', free[1].x, free[1].y),
  ]);
  assert.equal(baseCount(s, 0), 2, '건설 가능 횟수가 자원과 맞지 않는다');
});

test('이미 차지한 지점에는 기지를 세울 수 없다', () => {
  const s = createState(5, MIRROR);
  for (let i = 0; i < 400; i++) step(s, []);
  const site = BASE_SITES.find((b) => b.startFor === -1);

  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);
  const after = baseCount(s, 0);
  step(s, [cmd(s.tick, 1, 'base', '', site.x, site.y)]);

  assert.equal(baseCount(s, 0), after);
  assert.equal(baseCount(s, 1), 1, '점유된 지점에 상대가 기지를 세웠다');
});

test('본진 자리는 상대도 시작부터 점유되어 있어 세울 수 없다', () => {
  const s = createState(5, MIRROR);
  for (let i = 0; i < 400; i++) step(s, []);
  const enemyMain = BASE_SITES.find((b) => b.startFor === 1);
  const before = baseCount(s, 0);
  step(s, [cmd(s.tick, 0, 'base', '', enemyMain.x, enemyMain.y)]);
  assert.equal(baseCount(s, 0), before, '상대 본진 자리에 기지를 세웠다');
});

/* ── 테크트리 ──────────────────────────────────────────────────────────── */

test('시작 해금 유닛은 바로 쓸 수 있고, 나머지는 잠겨 있다', () => {
  const s = createState(5, MIRROR);
  const f = getFaction('steel');
  for (const node of f.tech) {
    assert.equal(
      isUnlocked(s.players[0], node.unit),
      node.cost === 0,
      `'${node.unit}' 초기 해금 상태가 잘못됐다`,
    );
  }
});

test('잠긴 유닛은 생산되지 않는다', () => {
  const s = createState(5, MIRROR);
  for (let i = 0; i < 400; i++) step(s, []);
  const locked = getFaction('steel').tech.find((n) => n.cost > 0).unit;
  const before = s.entities.length;
  const [x, y] = nearOwnBase(s, 0, 0, -2000);
  step(s, [cmd(s.tick, 0, 'unit', locked, x, y)]);
  assert.equal(s.entities.length, before, `잠긴 유닛 '${locked}'이 생산되었다`);
});

test('연구는 시간이 걸리고, 끝나야 해금된다', () => {
  const s = createState(5, MIRROR);
  for (let i = 0; i < 400; i++) step(s, []);

  const node = getFaction('steel').tech.find((n) => n.tier === 1);
  step(s, [cmd(s.tick, 0, 'tech', node.unit)]);

  assert.ok(s.players[0].research, '연구가 시작되지 않았다');
  assert.equal(s.players[0].research.unit, node.unit);
  assert.equal(isUnlocked(s.players[0], node.unit), false, '연구 중인데 이미 해금됐다');

  for (let i = 0; i < node.researchTicks; i++) step(s, []);
  assert.equal(s.players[0].research, null, '연구가 끝나지 않았다');
  assert.ok(isUnlocked(s.players[0], node.unit), '연구가 끝났는데 해금되지 않았다');
});

test('연구는 한 번에 하나만 진행된다', () => {
  const s = createState(5, MIRROR);
  for (let i = 0; i < 400; i++) step(s, []);
  const [a, b] = getFaction('steel').tech.filter((n) => n.tier === 1);

  // 실제 호출자와 같이 sortCommands로 정규화해서 넘긴다.
  // 같은 틱의 두 요청 중 정렬상 먼저 오는 쪽이 채택되어야 한다.
  const both = sortCommands([cmd(s.tick, 0, 'tech', a.unit), cmd(s.tick, 0, 'tech', b.unit)]);
  step(s, both);
  assert.equal(s.players[0].research.unit, both[0].id, '정렬상 앞선 연구가 채택되지 않았다');

  // 두 번째 요청은 무시되었으므로 비용도 한 번만 나갔어야 한다
  for (let i = 0; i < a.researchTicks + 5; i++) step(s, []);
  assert.equal(s.players[0].unlocked.filter((u) => u === a.unit || u === b.unit).length, 1);
});

test('선행 조건을 만족하지 않으면 연구를 시작할 수 없다', () => {
  const s = createState(5, MIRROR);
  const gated = getFaction('steel').tech.find((n) => n.requires);
  assert.equal(canResearch(s.players[0], gated.unit), false, '선행 없이 상위 테크가 열렸다');

  // 선행을 강제로 해금하면 열려야 한다
  s.players[0].unlocked.push(gated.requires);
  s.players[0].unlocked.sort();
  assert.equal(canResearch(s.players[0], gated.unit), true, '선행을 갖췄는데 여전히 잠겨 있다');
});

test('연구 비용이 모자라면 시작되지 않는다', () => {
  const s = createState(5, MIRROR); // 시작 8 미네랄
  const node = getFaction('steel').tech.find((n) => n.tier === 2);
  assert.ok(node.cost * MINERAL_SCALE > MINERAL_START, '테스트 전제(비용 > 시작 자원)가 깨졌다');
  step(s, [cmd(s.tick, 0, 'tech', node.unit)]);
  assert.equal(s.players[0].research, null, '자원이 없는데 연구가 시작됐다');
});

/* ── 배치 구역 ─────────────────────────────────────────────────────────── */

test('기지 반경 안에만 유닛을 배치할 수 있다', () => {
  const s = createState(5, MIRROR);
  for (let i = 0; i < 400; i++) step(s, []);
  const unitId = getFaction('steel').tech.find((n) => n.cost === 0).unit;

  const before = s.entities.length;
  // 본진에서 아주 먼 곳 (강 건너)
  step(s, [cmd(s.tick, 0, 'unit', unitId, 9000, 3000)]);
  assert.equal(s.entities.length, before, '기지에서 먼 곳에 배치되었다');

  const [x, y] = nearOwnBase(s, 0, 0, -2000);
  step(s, [cmd(s.tick, 0, 'unit', unitId, x, y)]);
  assert.ok(s.entities.length > before, '기지 근처인데 배치되지 않았다');
});

test('전진 기지를 세우면 그만큼 배치 구역이 앞으로 나온다', () => {
  const s = createState(5, MIRROR);
  const forward = BASE_SITES.find((b) => b.label === '아래 전진');

  // 기지가 없을 때는 배치 불가
  assert.equal(canDeployAt(forward.x, forward.y, ownBasePositions(s, 0)), false);

  for (let i = 0; i < 400; i++) step(s, []);
  step(s, [cmd(s.tick, 0, 'base', '', forward.x, forward.y)]);
  for (let i = 0; i < BASE_BUILD_TICKS + 1; i++) step(s, []);

  assert.equal(
    canDeployAt(forward.x, forward.y, ownBasePositions(s, 0)),
    true,
    '전진 기지를 세웠는데 그 근처에 배치할 수 없다',
  );
});

test('건설 중인 기지는 아직 배치 거점이 되지 않는다', () => {
  const s = createState(5, MIRROR);
  const forward = BASE_SITES.find((b) => b.label === '아래 전진');
  for (let i = 0; i < 400; i++) step(s, []);
  step(s, [cmd(s.tick, 0, 'base', '', forward.x, forward.y)]);
  assert.equal(
    canDeployAt(forward.x, forward.y, ownBasePositions(s, 0)),
    false,
    '건설이 끝나기 전인데 배치 거점이 되었다',
  );
});

test('강 위에는 배치할 수 없다', () => {
  const s = createState(5, MIRROR);
  const forward = BASE_SITES.find((b) => b.label === '아래 전진');
  for (let i = 0; i < 400; i++) step(s, []);
  step(s, [cmd(s.tick, 0, 'base', '', forward.x, forward.y)]);
  for (let i = 0; i < BASE_BUILD_TICKS + 1; i++) step(s, []);

  // 전진 기지에서 강까지는 DEPLOY_RADIUS 안이지만 강 위는 막혀야 한다
  assert.ok(forward.y - RIVER_BOT < DEPLOY_RADIUS, '테스트 전제(강이 반경 안)가 깨졌다');
  assert.equal(canDeployAt(9000, 16000, ownBasePositions(s, 0)), false, '강 위 배치가 허용됐다');
});

/* ── 승패 ──────────────────────────────────────────────────────────────── */

test('본진이 파괴되면 즉시 상대가 승리한다', () => {
  const s = createState(11, MIRROR);
  const enemyMain = mainBase(s, 1);
  enemyMain.hp = 1;
  step(s, [cmd(s.tick, 0, 'unit', 'rifleman', enemyMain.x, enemyMain.y + 1000)]);
  // 배치 구역 밖이라 생산이 막히므로 직접 꽂아 넣는다 (테스트 목적의 상태 조작)
  s.entities.push({
    id: s.nextId++,
    team: 0,
    unit: 'rifleman',
    kind: 'unit',
    x: enemyMain.x,
    y: enemyMain.y + 1500,
    hp: 5000,
    maxHp: 5000,
    cd: 0,
    deploy: 0,
    life: -1,
    target: -1,
    flying: false,
    lane: 0,
    siteId: -1,
    isMain: false,
    reserve: 0,
  });

  for (let i = 0; i < 60 && !s.over; i++) step(s, []);
  assert.ok(s.over, '본진이 파괴됐는데 경기가 끝나지 않았다');
  assert.equal(s.winner, 0);
});

test('확장 기지가 파괴되어도 경기는 계속된다', () => {
  const s = createState(12, MIRROR);
  const site = BASE_SITES.find((b) => b.startFor === -1);
  for (let i = 0; i < 400; i++) step(s, []);
  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);
  assert.equal(baseCount(s, 0), 2);

  s.entities.find((e) => e.kind === 'base' && e.siteId === site.id).hp = 0;
  step(s, []);

  assert.equal(s.over, false, '확장 기지 파괴로 경기가 끝났다');
  assert.equal(baseCount(s, 0), 1);
});

test('시간이 다 되면 기지 수로 승패를 가린다', () => {
  const s = createState(13, MIRROR);
  const site = BASE_SITES.find((b) => b.startFor === -1 && b.y > RIVER_BOT);
  for (let i = 0; i < 400; i++) step(s, []);
  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);

  while (s.tick < MATCH_TICKS && !s.over) step(s, []);
  assert.ok(s.over, '정규 시간이 지났는데 경기가 안 끝났다');
  assert.equal(s.winner, 0, '기지가 더 많은 쪽이 이기지 않았다');
});

test('기지 수가 같으면 누적 채굴량으로 가린다', () => {
  const s = createState(14, MIRROR);
  while (s.tick < MATCH_TICKS - 1) step(s, []);
  s.players[0].mined += 1; // 채굴량만 미세하게 앞선 상태를 만든다
  step(s, []);
  assert.ok(s.over);
  assert.equal(s.winner, 0);
});

test('긴 경기(연장전 포함)를 끝까지 돌려도 예외 없이 종료된다', () => {
  const total = MATCH_TICKS + 1200 + 10;
  const cmds = genCommands(5150, total);
  const a = runMatch(5150, total, cmds);
  assert.deepEqual(a.trace, runMatch(5150, total, cmds).trace);
  assert.ok(a.state.over, '연장전까지 끝났는데 경기가 안 끝났다');
});

/* ── 종족 ──────────────────────────────────────────────────────────────── */

test('모든 종족이 유효한 테크트리를 갖는다', () => {
  assert.ok(FACTION_IDS.length >= 3, `종족이 ${FACTION_IDS.length}개뿐이다`);
  for (const id of FACTION_IDS) {
    const f = getFaction(id);
    const units = new Set(f.tech.map((n) => n.unit));
    assert.equal(units.size, f.tech.length, `종족 '${id}'에 중복 유닛이 있다`);
    assert.ok(
      f.tech.some((n) => n.cost === 0),
      `종족 '${id}'에 시작 해금 유닛이 없다`,
    );
    for (const n of f.tech) {
      assert.doesNotThrow(() => getUnit(n.unit), `종족 '${id}'에 없는 유닛 '${n.unit}'`);
      if (n.requires) assert.ok(units.has(n.requires), `선행 '${n.requires}'가 트리에 없다`);
    }
  }
});

test('모든 종족은 시작 해금만으로 대공이 가능하다', () => {
  // 초반에 공중을 못 때리는 종족이 있으면 그 종족은 시작하자마자 진다.
  for (const id of FACTION_IDS) {
    const f = getFaction(id);
    const canHitAir = f.tech
      .filter((n) => n.cost === 0)
      .some((n) => {
        const t = getUnit(n.unit).targets;
        return t === 'any' || t === 'air';
      });
    assert.ok(canHitAir, `종족 '${id}'는 시작 유닛으로 공중을 때릴 수 없다`);
  }
});

test('알 수 없는 종족 id는 기본 종족으로 떨어진다', () => {
  assert.equal(getFaction('없는종족').id, getFaction(undefined).id);
});

test('서로 다른 종족끼리 붙어도 결정론이 유지된다', () => {
  const pairs = [
    ['steel', 'swarmhive'],
    ['covenant', 'steel'],
    ['swarmhive', 'covenant'],
    ['steel', 'steel'],
  ];
  for (const [f0, f1] of pairs) {
    const factions = [f0, f1];
    const cmds = genCommands(4242, 1500, factions);
    assert.deepEqual(
      runMatch(4242, 1500, cmds, factions).trace,
      runMatch(4242, 1500, cmds, factions).trace,
      `${f0} vs ${f1} 에서 궤적 불일치`,
    );
  }
});

test('유닛 색이 팀 구분 색과 겹치지 않는다', () => {
  for (const id of UNIT_IDS) {
    const u = getUnit(id);
    assert.notEqual(u.color, TEAM_COLOR_ME, `유닛 '${id}'의 색이 아군 팀 색과 같다`);
    assert.notEqual(u.color, TEAM_COLOR_FOE, `유닛 '${id}'의 색이 적군 팀 색과 같다`);
  }
});

/* ── 공중 / 대공 ───────────────────────────────────────────────────────── */

function place(s, team, unitId, x, y) {
  const u = getUnit(unitId);
  const e = {
    id: s.nextId++,
    team,
    unit: unitId,
    kind: u.kind === 'building' ? 'building' : 'unit',
    x,
    y,
    hp: u.hp,
    maxHp: u.hp,
    cd: 0,
    deploy: 0,
    life: -1,
    target: -1,
    flying: u.flying,
    lane: 0,
    siteId: -1,
    isMain: false,
    reserve: 0,
  };
  s.entities.push(e);
  return e;
}

const byId = (s, id) => s.entities.find((e) => e.id === id);

test('지상 전용 유닛은 바로 옆 공중 유닛을 타겟으로 삼지 않는다', () => {
  const s = createState(5, MIRROR);
  const zealot = place(s, 0, 'zealot', 9000, 19000);
  const gunship = place(s, 1, 'gunship', 9400, 19000);
  step(s, []);
  assert.notEqual(byId(s, zealot.id).target, gunship.id, '지상 전용이 공중을 타겟팅했다');
  assert.equal(byId(s, gunship.id).target, zealot.id, '공중이 옆의 지상 유닛을 무시했다');
});

test('지상 전용 광역 공격은 범위 안의 공중 유닛에 피해를 주지 않는다', () => {
  const s = createState(5, MIRROR);
  // 기지 사거리 밖(강 근처)에 배치해 기지 개입을 없앤다
  const mystic = place(s, 0, 'mystic', 9000, 17500);
  const ground = place(s, 1, 'zealot', 9000, 19500);
  const air = place(s, 1, 'gunship', 9200, 19500);
  const airHp0 = air.hp;

  for (let i = 0; i < 3; i++) step(s, []);
  assert.ok(byId(s, mystic.id), '술사가 관찰 구간 안에 죽어 전제가 깨졌다');

  const g = byId(s, ground.id);
  const a = byId(s, air.id);
  assert.ok(!g || g.hp < ground.maxHp, '지상 전용 광역이 지상 적을 못 때렸다');
  assert.ok(a, '공중 유닛이 지상 전용 광역에 죽었다');
  assert.equal(a.hp, airHp0, '지상 전용 광역이 공중 유닛에 피해를 줬다');
});

test('대공 전용 건물은 지상만 있을 때 아무것도 타겟팅하지 않는다', () => {
  const s = createState(5, MIRROR);
  const spore = place(s, 0, 'sporetentacle', 9000, 19000);
  place(s, 1, 'zealot', 9600, 19000);
  step(s, []);
  assert.equal(byId(s, spore.id).target, -1, '대공 전용이 지상 유닛을 타겟팅했다');
});

test('대공 전용 건물은 공중 유닛이 오면 타겟팅한다', () => {
  const s = createState(5, MIRROR);
  const spore = place(s, 0, 'sporetentacle', 9000, 19000);
  place(s, 1, 'zealot', 9600, 19000);
  const air = place(s, 1, 'gunship', 10000, 19000);
  step(s, []);
  assert.equal(byId(s, spore.id).target, air.id, '대공 전용이 공중 유닛을 놓쳤다');
});

test('기지는 공중 유닛을 공격한다', () => {
  const s = createState(5, MIRROR);
  const base = mainBase(s, 0);
  const air = place(s, 1, 'gunship', base.x, base.y - 2000);
  const hp0 = air.hp;
  for (let i = 0; i < 40; i++) step(s, []);
  const a = byId(s, air.id);
  assert.ok(!a || a.hp < hp0, '기지가 공중 유닛을 때리지 못했다 — 공중이 무적이 된다');
});

test('공중 유닛은 다리를 거치지 않고 강을 직선으로 건넌다', () => {
  const s = createState(5, MIRROR);
  const air = place(s, 0, 'gunship', 9000, 20000);
  void air;

  let crossedOffBridge = false;
  for (let i = 0; i < 300; i++) {
    step(s, []);
    for (const e of s.entities) {
      if (e.unit !== 'gunship') continue;
      if (e.y >= RIVER_TOP && e.y < RIVER_BOT) {
        const onBridge = (e.x >= 3000 && e.x <= 5000) || (e.x >= 13000 && e.x <= 15000);
        if (!onBridge) crossedOffBridge = true;
      }
    }
  }
  assert.ok(crossedOffBridge, '공중 유닛이 다리로 우회했다 — 지형을 무시해야 한다');
});

test('지상 유닛은 강을 건너지 않고 다리로만 넘어간다', () => {
  const s = createState(5, MIRROR);
  place(s, 0, 'scoutcar', 9000, 20000);

  let sawRiver = false;
  for (let i = 0; i < 400; i++) {
    step(s, []);
    for (const e of s.entities) {
      if (e.unit !== 'scoutcar') continue;
      if (e.y >= RIVER_TOP && e.y < RIVER_BOT) {
        sawRiver = true;
        const onBridge = (e.x >= 3000 && e.x <= 5000) || (e.x >= 13000 && e.x <= 15000);
        assert.ok(onBridge, `유닛이 다리 밖 강 위에 있다: x=${e.x}, y=${e.y}`);
      }
    }
  }
  assert.ok(sawRiver, '유닛이 400틱 동안 강에 도달조차 못했다');
});

test('공중과 지상은 서로 밀어내지 않는다 (다른 층)', () => {
  const solo = createState(5, MIRROR);
  const a0 = place(solo, 0, 'gunship', 9000, 19000);
  step(solo, []);
  const soloPos = [byId(solo, a0.id).x, byId(solo, a0.id).y];

  const mixed = createState(5, MIRROR);
  const a1 = place(mixed, 0, 'gunship', 9000, 19000);
  place(mixed, 0, 'zealot', 9000, 19000);
  step(mixed, []);

  assert.deepEqual(
    [byId(mixed, a1.id).x, byId(mixed, a1.id).y],
    soloPos,
    '겹친 지상 유닛이 공중 유닛을 밀어냈다',
  );
});

test('공중 유닛끼리는 서로 밀어낸다 (같은 층)', () => {
  const s = createState(5, MIRROR);
  const a0 = place(s, 0, 'gunship', 9000, 19000);
  const a1 = place(s, 0, 'gunship', 9000, 19000);
  step(s, []);
  const p = byId(s, a0.id);
  const q = byId(s, a1.id);
  assert.notEqual(`${p.x},${p.y}`, `${q.x},${q.y}`, '겹친 공중 유닛이 분리되지 않았다');
});

/* ── 리플레이 ──────────────────────────────────────────────────────────── */

function makeReplay(seed, factions = MIRROR, matchId = `t${seed}`) {
  return buildReplay({
    matchId,
    seed,
    factions: [factions[0], factions[1]],
    players: ['A', 'B'],
    commands: genCommands(seed, MATCH_TICKS, factions),
    createdAt: 1_700_000_000_000,
  });
}

test('리플레이는 기록한 경기를 그대로 재현한다', () => {
  for (const seed of [1, 42, 0xbeef]) {
    const v = verifyReplay(makeReplay(seed));
    assert.ok(v.ok, `시드 ${seed} 재현 실패: 틱 ${v.divergedAtTick} 부터 갈라짐`);
    assert.equal(v.divergedAtTick, -1);
  }
});

test('리플레이는 서로 다른 종족 대전도 재현한다', () => {
  assert.ok(verifyReplay(makeReplay(909, ['steel', 'covenant'])).ok, '이종족 리플레이 재현 실패');
});

test('리플레이는 JSON 왕복(네트워크/디스크)을 견딘다', () => {
  const wire = JSON.parse(JSON.stringify(makeReplay(77)));
  assert.ok(verifyReplay(wire).ok, 'JSON 왕복 후 재현 실패');
});

test('경기 하나의 리플레이가 수십 KB를 넘지 않는다', () => {
  const r = makeReplay(4242);
  const kb = JSON.stringify(r).length / 1024;
  assert.ok(kb < 128, `리플레이가 ${kb.toFixed(1)}KB — 너무 크다`);
  assert.ok(r.commands.length > 10, '커맨드가 너무 적어 크기 검증이 의미 없다');
});

test('커맨드가 변조되면 재현 검증이 실패한다', () => {
  const r = makeReplay(31337);
  assert.ok(verifyReplay(r).ok, '원본 리플레이부터 검증에 실패했다');

  const tampered = JSON.parse(JSON.stringify(r));
  for (const c of tampered.commands) c.x = ARENA_W - c.x;

  const v = verifyReplay(tampered);
  assert.equal(v.ok, false, '커맨드를 변조했는데 검증이 통과했다');
  assert.ok(v.divergedAtTick >= 0, '갈라진 지점을 찾지 못했다');
});

test('ReplayPlayer는 임의 틱으로 이동해도 순차 재생과 같은 상태를 낸다', () => {
  const r = makeReplay(5150);
  const player = new ReplayPlayer(r);
  assert.ok(player.totalTicks > 0);

  for (const tick of [0, 37, 200, 201, 999, 1400, 640, 55, player.totalTicks]) {
    assert.equal(
      hashState(player.stateAt(tick)),
      hashState(playReplay(r, tick)),
      `틱 ${tick} 에서 탐색 결과가 순차 재생과 다르다`,
    );
  }
});

test('리플레이 요약이 커맨드 종류별로 정확히 집계된다', () => {
  const r = makeReplay(2024);
  const s = summarizeReplay(r, TICK_RATE);

  assert.equal(s.playCounts[0] + s.playCounts[1], r.commands.length);
  for (const team of [0, 1]) {
    const units = Object.values(s.unitUsage[team]).reduce((a, b) => a + b, 0);
    assert.equal(
      units + s.baseBuilds[team] + s.techUnlocks[team],
      s.playCounts[team],
      `team${team} 집계가 어긋난다`,
    );
    for (const id of Object.keys(s.unitUsage[team])) {
      assert.doesNotThrow(() => getUnit(id), `요약에 존재하지 않는 유닛 '${id}'`);
    }
  }
  assert.equal(s.winner, r.result.winner);
  assert.ok(s.baseBuilds[0] + s.baseBuilds[1] > 0, '기지 건설 커맨드가 하나도 없다');
  assert.ok(s.techUnlocks[0] + s.techUnlocks[1] > 0, '테크 커맨드가 하나도 없다');
});
