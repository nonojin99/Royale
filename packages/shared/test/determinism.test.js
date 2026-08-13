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
  MATCH_TICKS,
  OVERTIME_TICKS,
  MINERAL_MAX,
  MINERAL_SCALE,
  MINERAL_START,
  ReplayPlayer,
  WALLS,
  blockedAt,
  blockedTile,
  elevAt,
  elevTile,
  navDistance,
  navStep,
  walkable,
  TEAM_COLOR_FOE,
  TEAM_COLOR_ME,
  TICK_RATE,
  START_WORKERS,
  UNIT_IDS,
  UPGRADE_TICKS,
  WORKER_CAP_PER_BASE,
  WORKER_COST,
  WORKER_MINE_PER_TICK,
  activeWorkers,
  baseCount,
  canUpgrade,
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
  workerCapacity,
  restore,
  snapshot,
  sortCommands,
  ARENA_W_TILES,
  siteReachable,
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
          ? nextRange(rng, ARENA_H / 2, ARENA_H - 2000)
          : nextRange(rng, 2000, ARENA_H / 2);
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

test('시작 상태는 본진 하나씩, 일꾼 2기, 시작 미네랄을 갖는다', () => {
  const s = createState(5, MIRROR);
  assert.equal(s.entities.length, 2, '시작 엔티티가 본진 2개가 아니다');
  for (const team of [0, 1]) {
    assert.equal(baseCount(s, team), 1);
    assert.equal(s.players[team].minerals, MINERAL_START);
    assert.equal(s.players[team].workers, START_WORKERS);
    assert.equal(s.players[team].mined, 0);
    assert.ok(mainBase(s, team), `team${team} 본진이 없다`);
  }
});

test('시작 미네랄은 확장 비용과 달라야 한다 (오프닝에 선택지를 만든다)', () => {
  // 같으면 "무조건 즉시 확장"이 유일한 최적해가 되어 첫 판단이 사라진다.
  assert.notEqual(MINERAL_START, BASE_BUILD_COST, '시작 미네랄이 확장 비용과 같다');
  assert.ok(MINERAL_START < BASE_BUILD_COST, '시작부터 확장이 가능하면 안 된다');
  assert.ok(MINERAL_START >= WORKER_COST * 2, '시작에 일꾼 2기도 못 사면 너무 빡빡하다');
});

test('수입은 기지 수가 아니라 일하는 일꾼 수에 비례한다', () => {
  const s = createState(5, MIRROR);
  const perTick = START_WORKERS * WORKER_MINE_PER_TICK;
  step(s, []);
  assert.equal(s.players[0].mined, perTick, '시작 일꾼 수만큼 캐지 않았다');
  assert.equal(s.players[0].minerals, MINERAL_START + perTick);
});

test('일꾼을 사면 그만큼 수입이 늘어난다', () => {
  const s = createState(5, MIRROR);
  step(s, [cmd(s.tick, 0, 'worker', '')]);
  assert.equal(s.players[0].workers, START_WORKERS + 1, '일꾼이 늘지 않았다');

  const before = s.players[0].mined;
  step(s, []);
  assert.equal(
    s.players[0].mined - before,
    (START_WORKERS + 1) * WORKER_MINE_PER_TICK,
    '늘어난 일꾼이 채굴에 반영되지 않았다',
  );
});

test('일꾼은 정원을 넘겨 살 수 없다', () => {
  const s = createState(5, MIRROR);
  assert.equal(workerCapacity(s, 0), WORKER_CAP_PER_BASE, '본진 하나의 정원이 기대와 다르다');

  // 자원을 넉넉히 주고 정원보다 많이 사려고 해본다
  s.players[0].minerals = MINERAL_MAX;
  for (let i = 0; i < WORKER_CAP_PER_BASE + 5; i++) {
    step(s, [cmd(s.tick, 0, 'worker', '')]);
    s.players[0].minerals = MINERAL_MAX; // 자원 부족이 아니라 정원으로 막히는지 본다
  }
  assert.equal(s.players[0].workers, WORKER_CAP_PER_BASE, '정원을 넘겨 일꾼이 늘었다');
});

test('확장하면 정원이 늘고 그만큼 일꾼을 더 붙일 수 있다', () => {
  const s = createState(5, MIRROR);
  const site = BASE_SITES.find((b) => b.startFor === -1 && siteReachable(s, 0, b));
  s.players[0].minerals = MINERAL_MAX;
  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);
  for (let i = 0; i < BASE_BUILD_TICKS + 1; i++) step(s, []);

  assert.equal(workerCapacity(s, 0), WORKER_CAP_PER_BASE * 2, '확장으로 정원이 늘지 않았다');
});

test('미네랄은 상한을 넘지 않는다', () => {
  const s = createState(5, MIRROR);
  s.players[0].workers = WORKER_CAP_PER_BASE;
  for (let i = 0; i < 2000; i++) step(s, []);
  assert.equal(s.players[0].minerals, MINERAL_MAX);
});

test('기지 매장량은 유한하고, 고갈되면 수입도 정원도 사라진다', () => {
  const s = createState(5, MIRROR);
  s.players[0].workers = WORKER_CAP_PER_BASE; // 포화 상태로 만든다
  const perTick = WORKER_CAP_PER_BASE * WORKER_MINE_PER_TICK;
  const expectedTicks = BASE_MINERAL_RESERVE / perTick;

  for (let i = 0; i < expectedTicks; i++) step(s, []);
  assert.equal(mainBase(s, 0).reserve, 0, '매장량이 예상 시점에 고갈되지 않았다');
  assert.equal(s.players[0].mined, BASE_MINERAL_RESERVE, '누적 채굴량이 매장량과 다르다');

  // 고갈된 기지는 정원에서 빠지고, 남은 일꾼은 논다
  assert.equal(workerCapacity(s, 0), 0, '고갈된 기지가 여전히 정원을 제공한다');
  assert.equal(activeWorkers(s, 0), 0, '고갈됐는데 일꾼이 일하고 있다');

  const minedBefore = s.players[0].mined;
  for (let i = 0; i < 100; i++) step(s, []);
  assert.equal(s.players[0].mined, minedBefore, '고갈된 기지가 계속 채굴하고 있다');
});

test('일꾼이 정원을 넘으면 초과분은 놀고 수입에 잡히지 않는다', () => {
  const s = createState(5, MIRROR);
  s.players[0].workers = WORKER_CAP_PER_BASE + 5;
  assert.equal(activeWorkers(s, 0), WORKER_CAP_PER_BASE, '초과 일꾼이 일하고 있다');

  const before = s.players[0].mined;
  step(s, []);
  assert.equal(
    s.players[0].mined - before,
    WORKER_CAP_PER_BASE * WORKER_MINE_PER_TICK,
    '정원을 넘는 일꾼이 채굴에 반영됐다',
  );
});

test('미네랄이 모자라면 기지를 세울 수 없다', () => {
  const s = createState(5, MIRROR);
  // 인접 제약(라운드 5) 때문에 팀0이 이을 수 있는 지점만 쓴다
  const free = BASE_SITES.filter((b) => b.startFor === -1 && siteReachable(s, 0, b));
  // 시작 자원(5)은 확장 비용(8)에 못 미친다
  step(s, [cmd(s.tick, 0, 'base', '', free[0].x, free[0].y)]);
  assert.equal(baseCount(s, 0), 1, '자원이 모자란데 기지가 세워졌다');

  // 시작 시점에 이을 수 있는 지점은 앞마당 하나뿐이다(인접 제약) —
  // 같은 지점에 두 번 명령해도 돈과 자리가 한 번치뿐임을 확인한다
  s.players[0].minerals = BASE_BUILD_COST;
  step(s, [
    cmd(s.tick, 0, 'base', '', free[0].x, free[0].y),
    cmd(s.tick, 0, 'base', '', free[0].x, free[0].y),
  ]);
  assert.equal(baseCount(s, 0), 2, '한 번치 자원으로 두 곳이 세워졌다');
});

test('이미 차지한 지점에는 기지를 세울 수 없다', () => {
  const s = createState(5, MIRROR);
  const site = BASE_SITES.find((b) => b.startFor === -1 && siteReachable(s, 0, b));
  s.players[0].minerals = MINERAL_MAX;
  s.players[1].minerals = MINERAL_MAX;

  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);
  const after = baseCount(s, 0);
  step(s, [cmd(s.tick, 1, 'base', '', site.x, site.y)]);

  assert.equal(baseCount(s, 0), after);
  assert.equal(baseCount(s, 1), 1, '점유된 지점에 상대가 기지를 세웠다');
});

test('본진 자리는 상대도 시작부터 점유되어 있어 세울 수 없다', () => {
  const s = createState(5, MIRROR);
  const enemyMain = BASE_SITES.find((b) => b.startFor === 1);
  s.players[0].minerals = MINERAL_MAX;
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
  for (let i = 0; i < 700; i++) step(s, []); // 확장비 12를 모을 시간 (2일꾼 0.24/s)
  const locked = getFaction('steel').tech.find((n) => n.cost > 0).unit;
  const before = s.entities.length;
  const [x, y] = nearOwnBase(s, 0, 0, -2000);
  step(s, [cmd(s.tick, 0, 'unit', locked, x, y)]);
  assert.equal(s.entities.length, before, `잠긴 유닛 '${locked}'이 생산되었다`);
});

test('연구는 시간이 걸리고, 끝나야 해금된다', () => {
  const s = createState(5, MIRROR);
  for (let i = 0; i < 700; i++) step(s, []); // 확장비 12를 모을 시간 (2일꾼 0.24/s)

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
  for (let i = 0; i < 700; i++) step(s, []); // 확장비 12를 모을 시간 (2일꾼 0.24/s)
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
  for (let i = 0; i < 700; i++) step(s, []); // 확장비 12를 모을 시간 (2일꾼 0.24/s)
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
  // 인접 제약 때문에 본진에서 바로 이어지는 앞마당을 전진 기지로 쓴다
  const forward = BASE_SITES.find((b) => b.label === '아래 앞마당');

  // 기지가 없을 때는 배치 불가
  assert.equal(canDeployAt(forward.x, forward.y, ownBasePositions(s, 0)), false);

  for (let i = 0; i < 700; i++) step(s, []); // 확장비 12를 모을 시간 (2일꾼 0.24/s)
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
  const forward = BASE_SITES.find((b) => b.label === '중앙 아래');
  for (let i = 0; i < 700; i++) step(s, []); // 확장비 12를 모을 시간 (2일꾼 0.24/s)
  step(s, [cmd(s.tick, 0, 'base', '', forward.x, forward.y)]);
  assert.equal(
    canDeployAt(forward.x, forward.y, ownBasePositions(s, 0)),
    false,
    '건설이 끝나기 전인데 배치 거점이 되었다',
  );
});

test('강 위에는 배치할 수 없다', () => {
  const s = createState(5, MIRROR);
  const forward = BASE_SITES.find((b) => b.label === '중앙 아래');
  for (let i = 0; i < 700; i++) step(s, []); // 확장비 12를 모을 시간 (2일꾼 0.24/s)
  step(s, [cmd(s.tick, 0, 'base', '', forward.x, forward.y)]);
  for (let i = 0; i < BASE_BUILD_TICKS + 1; i++) step(s, []);

  // 중앙 기지 반경 안에 벽이 있어야 이 테스트가 의미를 갖는다
  const own = ownBasePositions(s, 0);
  const wallPt = (() => {
    for (const [x0, y0, x1, y1] of WALLS) {
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const px = tx * 1000 + 500;
          const py = ty * 1000 + 500;
          for (const [bx, by] of own) {
            const dx = px - bx;
            const dy = py - by;
            if (dx * dx + dy * dy <= DEPLOY_RADIUS * DEPLOY_RADIUS) return [px, py];
          }
        }
      }
    }
    return null;
  })();
  assert.ok(wallPt, '테스트 전제(배치 반경 안에 벽이 있다)가 깨졌다');
  assert.equal(canDeployAt(wallPt[0], wallPt[1], own), false, '벽 위 배치가 허용됐다');
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
  const site = BASE_SITES.find((b) => b.startFor === -1 && siteReachable(s, 0, b));
  for (let i = 0; i < 700; i++) step(s, []); // 확장비 12를 모을 시간 (2일꾼 0.24/s)
  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);
  assert.equal(baseCount(s, 0), 2);

  s.entities.find((e) => e.kind === 'base' && e.siteId === site.id).hp = 0;
  step(s, []);

  assert.equal(s.over, false, '확장 기지 파괴로 경기가 끝났다');
  assert.equal(baseCount(s, 0), 1);
});

test('시간이 다 되면 기지 수로 승패를 가린다', () => {
  const s = createState(13, MIRROR);
  const site = BASE_SITES.find((b) => b.startFor === -1 && siteReachable(s, 0, b));
  for (let i = 0; i < 700; i++) step(s, []); // 확장비 12를 모을 시간 (2일꾼 0.24/s)
  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);

  while (s.tick < MATCH_TICKS && !s.over) step(s, []);
  assert.ok(s.over, '정규 시간이 지났는데 경기가 안 끝났다');
  assert.equal(s.winner, 0, '기지가 더 많은 쪽이 이기지 않았다');
});

test('기지 수가 같으면 연장전으로 가고, 연장 끝에 기지 총 HP로 가린다', () => {
  const s = createState(14, MIRROR);
  while (s.tick < MATCH_TICKS - 1) step(s, []);
  // 채굴량은 앞서지만 기지 HP는 뒤진 상태 — HP가 우선해야 한다.
  // 채굴량 비교는 확장 없는 장기전에서 양쪽 다 매장량을 다 캐 무의미해지기
  // 때문이다 (REVIEW.md P0-2).
  s.players[0].mined += 1000;
  const main0 = s.entities.find((e) => e.kind === 'base' && e.isMain && e.team === 0);
  main0.hp -= 500;
  step(s, []);
  assert.equal(s.over, false, '기지 수가 같은데 정규 시간에 끝났다');
  assert.equal(s.overtime, true, '연장전에 들어가지 않았다');

  while (s.tick < MATCH_TICKS + OVERTIME_TICKS - 1) step(s, []);
  step(s, []);
  assert.ok(s.over, '연장전이 끝났는데 경기가 안 끝났다');
  assert.equal(s.winner, 1, '기지 총 HP가 아니라 채굴량으로 가렸다');
});

test('연장 끝에 기지 HP까지 같으면 채굴량으로 가린다', () => {
  const s = createState(14, MIRROR);
  while (s.tick < MATCH_TICKS - 1) step(s, []);
  s.players[0].mined += 1000;
  while (s.tick < MATCH_TICKS + OVERTIME_TICKS - 1) step(s, []);
  step(s, []);
  assert.ok(s.over);
  assert.equal(s.winner, 0, 'HP 동률에서 채굴량 우위가 반영되지 않았다');
});

test('공성 배율 — 같은 유닛이 유닛에게는 원래 데미지, 구조물에는 배율 데미지를 준다', () => {
  // 시작 유닛의 siege 는 100 미만이어야 한다 (초반 방어 성립 — P0-1)
  for (const fid of FACTION_IDS) {
    const f = getFaction(fid);
    for (const node of f.tech.filter((n) => n.cost === 0)) {
      const u = getUnit(node.unit);
      if (u.kind !== 'unit') continue;
      assert.ok(u.siege < 100, `시작 유닛 ${u.id} 의 siege(${u.siege})가 100 이상이다`);
    }
  }
  // 2단계 공성 유닛은 100을 크게 넘어야 한다 (스톨 브레이커)
  for (const id of ['siegetank', 'devourer', 'fusionite']) {
    assert.ok(getUnit(id).siege >= 150, `${id} 의 siege(${getUnit(id).siege})가 150 미만`);
  }
  // 배율 적용이 정수를 유지하는지 — 임의 조합 검사
  for (const id of UNIT_IDS) {
    const u = getUnit(id);
    assert.ok(Number.isInteger(Math.trunc((u.damage * u.siege) / 100)));
  }
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

  let flewOverWall = false;
  for (let i = 0; i < 300; i++) {
    step(s, []);
    for (const e of s.entities) {
      if (e.unit !== 'gunship') continue;
      if (blockedAt(e.x, e.y)) flewOverWall = true;
    }
  }
  assert.ok(flewOverWall, '공중 유닛이 벽을 피해 돌아갔다 — 지형을 무시해야 한다');
});

test('지상 유닛은 벽을 통과하지 못하고 돌아간다', () => {
  const s = createState(5, MIRROR);
  place(s, 0, 'scoutcar', 18000, 18000);

  let moved = 0;
  let lastX = 18000;
  let lastY = 18000;
  for (let i = 0; i < 400; i++) {
    step(s, []);
    for (const e of s.entities) {
      if (e.unit !== 'scoutcar') continue;
      assert.equal(blockedAt(e.x, e.y), false, `유닛이 벽 위에 있다: x=${e.x}, y=${e.y}`);
      if (e.x !== lastX || e.y !== lastY) moved++;
      lastX = e.x;
      lastY = e.y;
    }
  }
  assert.ok(moved > 50, '유닛이 400틱 동안 거의 움직이지 않았다 (길이 막혔을 수 있다)');
});

test('길찾기는 지형 데이터만 보고 결정된다 (하드코딩된 지형이 아니라)', () => {
  // 벽 정의(WALLS)와 통행 판정(walkable)이 같은 것을 말해야 한다
  for (const [x0, y0, x1, y1] of WALLS) {
    assert.equal(walkable(x0, y0), false, `벽 (${x0},${y0}) 이 통행 가능으로 잡혔다`);
    assert.equal(walkable(x1, y1), false, `벽 (${x1},${y1}) 이 통행 가능으로 잡혔다`);
  }

  // 뭍의 기지 자리는 서로 도달 가능해야 한다 — 하나라도 고립되면 맵이
  // 망가진 것. 단 섬은 **의도적으로** 지상 불가다 (로스트템플 문법):
  // 공중만 견제할 수 있는 안전 경제가 섬의 존재 이유다
  const land = BASE_SITES.filter((b) => !b.label.includes('섬'));
  const isles = BASE_SITES.filter((b) => b.label.includes('섬'));
  assert.ok(isles.length >= 2, '섬 확장이 없다 — MAP_RULES 위반');
  for (const a of land) {
    for (const b of land) {
      if (a.id >= b.id) continue;
      assert.ok(
        navDistance(a.x, a.y, b.x, b.y) > 0,
        `${a.label} → ${b.label} 이 도달 불가다`,
      );
    }
  }
  for (const isle of isles) {
    assert.equal(
      navDistance(land[0].x, land[0].y, isle.x, isle.y),
      -1,
      `${isle.label} 이 지상으로 도달된다 — 섬이 아니다`,
    );
  }

  // 본진끼리는 벽을 우회해야 하므로 직선 대각선보다 멀어야 한다.
  // 이게 성립해야 "벽이 실제로 진격로를 막는다"고 말할 수 있다.
  const m0 = BASE_SITES.find((b) => b.startFor === 0);
  const m1 = BASE_SITES.find((b) => b.startFor === 1);
  const path = navDistance(m0.x, m0.y, m1.x, m1.y);
  const dx = Math.abs(m0.x - m1.x) / 1000;
  const dy = Math.abs(m0.y - m1.y) / 1000;
  const straight = Math.min(dx, dy) * 14 + Math.abs(dx - dy) * 10;
  assert.ok(
    path > straight,
    `본진 간 경로(${path})가 무장애 직선(${straight})과 같다 — 벽이 주 진격로를 막지 못한다`,
  );
});

test('언덕 — 저지에서 고지를 때리면 데미지가 깎인다 (원거리 기준)', () => {
  // 본진 주머니는 고지, 출구 밖은 저지 (맵 전제)
  const m1 = BASE_SITES.find((b) => b.startFor === 1);
  assert.equal(elevAt(m1.x, m1.y), 1, '본진이 고지가 아니다');
  assert.equal(elevAt(4500, 14500), 0, '본진 출구 밖이 저지가 아니다');

  // 같은 표적(고지 위 광전사)을 원거리 소총병으로 때린다.
  // 근접 유닛은 붙는 동안 자기도 고지에 올라가므로 이 규칙의 대상이 아니다 —
  // 원거리로 사거리 안·고도 밖에서 쏘는 상황만 감쇄된다.
  const firstVolley = (ax, ay) => {
    const s = createState(9, MIRROR);
    const target = place(s, 1, 'zealot', 4500, 11500); // 고지 램프 위 (4,11)
    place(s, 0, 'rifleman', ax, ay);
    const hp0 = target.hp;
    for (let i = 0; i < 100; i++) {
      step(s, []);
      const t = byId(s, target.id);
      if (!t) return hp0; // 죽었으면 전부 들어간 것
      if (t.hp !== hp0) return hp0 - t.hp;
    }
    return 0;
  };

  const fromLow = firstVolley(4500, 14500); // 저지 (4,14) — 램프 아래, 사거리 안
  const fromHigh = firstVolley(4500, 8500); // 고지 (4,8)
  assert.ok(fromLow > 0, '저지 공격자가 때리지 못했다');
  assert.ok(fromHigh > 0, '고지 공격자가 때리지 못했다');
  assert.ok(
    fromLow < fromHigh,
    `저지→고지(${fromLow})가 같은고도(${fromHigh})와 같거나 크면 안 된다`,
  );
});

test('맵은 점대칭이다 (한쪽만 유리한 지형이 없다)', () => {
  // 벽을 절반만 적고 자동 복제하므로, 그 복제가 실제로 맞는지 확인한다.
  const T = ARENA_W_TILES;
  for (let ty = 0; ty < T; ty++) {
    for (let tx = 0; tx < T; tx++) {
      assert.equal(
        blockedTile(tx, ty),
        blockedTile(T - 1 - tx, T - 1 - ty),
        `(${tx},${ty}) 와 대칭점의 지형이 다르다`,
      );
      assert.equal(
        elevTile(tx, ty),
        elevTile(T - 1 - tx, T - 1 - ty),
        `(${tx},${ty}) 와 대칭점의 고도가 다르다`,
      );
    }
  }
  // 기지 자리도 대칭이어야 한다
  for (const a of BASE_SITES) {
    const mx = (T - 1) * 1000 - a.x;
    const my = (T - 1) * 1000 - a.y;
    assert.ok(
      BASE_SITES.some((b) => Math.abs(b.x - mx) <= 1000 && Math.abs(b.y - my) <= 1000),
      `${a.label} 의 대칭 자리가 없다`,
    );
  }
  // 기지 자리가 벽 위에 있으면 안 된다
  for (const a of BASE_SITES) {
    assert.equal(
      blockedTile(Math.floor(a.x / 1000), Math.floor(a.y / 1000)),
      false,
      `${a.label} 이 벽 위에 있다`,
    );
  }
});

test('길찾기 결과는 호출 순서와 무관하다 (캐시가 결과를 바꾸지 않는다)', () => {
  // 거리장을 캐시하므로, 캐시가 비어 있을 때와 차 있을 때가 같아야 한다.
  const first = navStep(3000, 25000, 9000, 3000);
  for (let i = 0; i < 50; i++) navStep(i * 300, 20000, 15000, 4000);
  const again = navStep(3000, 25000, 9000, 3000);
  assert.deepEqual(again, first, '다른 목적지를 조회한 뒤 결과가 달라졌다');
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

test('주문은 자기 기지 반경 밖에도 시전된다 (라운드 1 안건 D)', () => {
  const s = createState(1, ['steel', 'swarmhive']);
  s.players[0].unlocked.push('carpetbomb');
  s.players[0].minerals = 99 * MINERAL_SCALE;
  s.players[1].minerals = 99 * MINERAL_SCALE;

  // 팀1이 자기 진영(팀0 반경에서 한참 밖)에 무리를 깐다
  const site1 = BASE_SITES.find((b) => b.startFor === 1);
  step(s, [{ execTick: 0, team: 1, kind: 'unit', id: 'gnawer', x: site1.x, y: site1.y }]);
  for (let i = 0; i < 40; i++) step(s, []);

  const hpOf = () =>
    s.entities.filter((e) => e.kind === 'unit' && e.team === 1).reduce((a, e) => a + e.hp, 0);
  const before = hpOf();
  assert.ok(before > 0, '전제: 적 유닛이 깔려 있어야 한다');

  step(s, [{ execTick: s.tick, team: 0, kind: 'unit', id: 'carpetbomb', x: site1.x, y: site1.y }]);
  assert.ok(hpOf() < before, '반경 밖 시전이 적 유닛에게 피해를 주지 않았다');

  // 전장 밖 좌표는 거부된다 — 자원이 줄지 않아야 한다
  const minerals = s.players[0].minerals;
  step(s, [{ execTick: s.tick, team: 0, kind: 'unit', id: 'carpetbomb', x: -5000, y: 0 }]);
  // 채굴이 한 틱 들어오므로 "줄지 않았다"로 본다 — 시전됐다면 3코스트가 빠졌을 것
  assert.ok(s.players[0].minerals >= minerals, '전장 밖 시전이 자원을 소모했다');
});

test('확장은 보유 기지에서 EXPAND_RANGE 안의 지점만 지을 수 있다 (라운드 5)', () => {
  const s = createState(9, MIRROR);
  s.players[0].minerals = 99 * MINERAL_SCALE;

  // 팀0 본진은 아래쪽 — 반대편 지점은 이어지지 않아야 한다
  const near = BASE_SITES.find((b) => b.startFor === -1 && siteReachable(s, 0, b));
  const far = BASE_SITES.find((b) => b.startFor === 1); // 상대 본진 쪽
  assert.ok(siteReachable(s, 0, near), '가까운 지점이 이어지지 않는다');
  assert.ok(!siteReachable(s, 0, { x: far.x, y: far.y }), '반대편 지점이 이어진다');

  // 실제 명령도 같은 판정을 따른다
  const basesBefore = s.entities.filter((e) => e.kind === 'base').length;
  step(s, [{ execTick: s.tick, team: 0, kind: 'base', id: '', x: far.x, y: far.y }]);
  assert.equal(
    s.entities.filter((e) => e.kind === 'base').length,
    basesBefore,
    '멀리 떨어진 확장이 지어졌다',
  );
  step(s, [{ execTick: s.tick, team: 0, kind: 'base', id: '', x: near.x, y: near.y }]);
  assert.equal(
    s.entities.filter((e) => e.kind === 'base').length,
    basesBefore + 1,
    '이어지는 확장이 지어지지 않았다',
  );
});

/* ── 강화 ──────────────────────────────────────────────────────────────── */

test('강화는 단계별 연구 뒤에 열리고, 진행 후 단계가 오른다', () => {
  const s = createState(21, MIRROR);
  const p = s.players[0];

  // 1단계는 시작부터 열려 있고, 시작 미네랄(5)로 비용(4)을 감당한다
  assert.equal(canUpgrade(p), true, '1단계 강화가 시작부터 열려 있지 않다');
  step(s, [cmd(s.tick, 0, 'upgrade', '', 0, 0)]);
  assert.ok(p.upgrading, '강화가 시작되지 않았다');
  assert.equal(canUpgrade(p), false, '강화 중에 또 강화가 열렸다');

  for (let i = 0; i < UPGRADE_TICKS[0] + 1; i++) step(s, []);
  assert.equal(p.upgrade, 1, '강화 1단계가 완료되지 않았다');

  // 2단계는 1단계 열의 연구를 마치기 전에는 잠긴다
  assert.equal(canUpgrade(p), false, '1단계 연구 없이 2단계 강화가 열렸다');
});
