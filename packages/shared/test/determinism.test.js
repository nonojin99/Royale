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
  MINERAL_SANDBOX,
  SKILL_CHARGE_TICKS,
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
  WORKER_LOSS_DAMAGE,
  activeWorkers,
  DEFAULT_MAP_ID,
  MAPS,
  baseCount,
  canUpgrade,
  setActiveMap,
  buildReplay,
  canDeployAt,
  canResearch,
  createRng,
  INVASION_WALL_START,
  INVASION_WALL_PER_WAVE,
  INVASION_BUILDINGS,
  HERO_IDS,
  RUN_STAGES,
  HERO_RESPAWN_TICKS,
  RELIC_BY_ID,
  applyCommand,
  pathExists,
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
  waveAnchorOf,
  STAGE_REFUND_PCT,
  STAGE_REFUND_MAX,
  STAGE_BUDGET_ROLLBACK_PCT,
  INVASION_BUDGET_START,
  waveTypeOf,
  radiusOf,
  isHiddenFrom,
  sightCirclesOf,
  SIGHT_UNIT,
  UNIT_RADIUS,
  UNIT_RADIUS_LARGE,
  UNIT_RADIUS_SMALL,
  HIGH_GROUND_SIGHT_PCT,
  reachOf,
} from '../dist/index.js';

/* ── 헬퍼 ──────────────────────────────────────────────────────────────── */

/** 기본 대전 구성 — 기갑단 미러전 */
const MIRROR = ['steel', 'steel'];

/** 자원이 문제가 아님을 분명히 하는 넉넉한 보유량 (상한은 없다) */
const RICH = 100 * MINERAL_SCALE;

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
  s.players[0].minerals = RICH;
  for (let i = 0; i < WORKER_CAP_PER_BASE + 5; i++) {
    step(s, [cmd(s.tick, 0, 'worker', '')]);
    s.players[0].minerals = RICH; // 자원 부족이 아니라 정원으로 막히는지 본다
  }
  assert.equal(s.players[0].workers, WORKER_CAP_PER_BASE, '정원을 넘겨 일꾼이 늘었다');
});

test('확장하면 정원이 늘고 그만큼 일꾼을 더 붙일 수 있다', () => {
  const s = createState(5, MIRROR);
  const site = BASE_SITES.find((b) => b.startFor === -1 && siteReachable(s, 0, b));
  s.players[0].minerals = RICH;
  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);
  for (let i = 0; i < BASE_BUILD_TICKS + 1; i++) step(s, []);

  assert.equal(workerCapacity(s, 0), WORKER_CAP_PER_BASE * 2, '확장으로 정원이 늘지 않았다');
});

test('미네랄은 상한 없이 쌓인다 — 잘 쓰는 것이 실력이다', () => {
  // 보유 상한(30)은 라운드 50에 없앴다. 상한이 있으면 "더 벌어도 소용없다"가
  // 되어 남는 돈을 급하게 태우는 것이 최적이 된다
  const s = createState(5, MIRROR);
  s.players[0].workers = WORKER_CAP_PER_BASE;
  for (let i = 0; i < 2000; i++) step(s, []);
  assert.ok(
    s.players[0].minerals > 30 * MINERAL_SCALE,
    `예전 상한(30)을 넘겨 쌓여야 한다 (${s.players[0].minerals / MINERAL_SCALE})`,
  );
  // 매장량이 유한하므로 무한히 쌓이지는 않는다 — 그게 진짜 브레이크다
  assert.ok(s.players[0].minerals <= BASE_MINERAL_RESERVE);
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
  s.players[0].minerals = RICH;
  s.players[1].minerals = RICH;

  step(s, [cmd(s.tick, 0, 'base', '', site.x, site.y)]);
  const after = baseCount(s, 0);
  step(s, [cmd(s.tick, 1, 'base', '', site.x, site.y)]);

  assert.equal(baseCount(s, 0), after);
  assert.equal(baseCount(s, 1), 1, '점유된 지점에 상대가 기지를 세웠다');
});

test('본진 자리는 상대도 시작부터 점유되어 있어 세울 수 없다', () => {
  const s = createState(5, MIRROR);
  const enemyMain = BASE_SITES.find((b) => b.startFor === 1);
  s.players[0].minerals = RICH;
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
    charge: u.chargeStart ?? 0,
    orderX: -1,
    orderY: -1,
    orderAttack: 0,
    hold: 0,
    reveal: -1,
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
  // 목적지를 **명령으로** 준다. 예전에는 표적 없는 유닛의 기본 행동에
  // 기댔는데, 그 행동이 바뀔 때마다(안개·지점 순회) 경로가 달라져 이
  // 테스트가 같이 흔들렸다. 검사하려는 것은 "공중은 지형을 무시한다"이지
  // "기본 행동이 어디로 향하나"가 아니다
  const foeMain = mainBase(s, 1);
  assert.ok(applyCommand(s, cmd(0, 0, 'move', String(air.id), foeMain.x, foeMain.y)));

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
  const car = place(s, 0, 'scoutcar', 18000, 18000);
  // 대전 유닛은 명령이 없으면 제자리를 지키므로 목적지를 준다.
  // 검사하려는 것은 "지상은 지형을 못 뚫는다"이지 기본 행동이 아니다
  const foeMain = mainBase(s, 1);
  assert.ok(applyCommand(s, cmd(0, 0, 'move', String(car.id), foeMain.x, foeMain.y)));

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

/* ── 맵 레지스트리 — 모든 맵이 구조 규칙을 지킨다 ─────────────────────── */

test('모든 맵: 점대칭 + 뭍 연결 + 섬 고립 + 지점이 지형 위에 없다', () => {
  const T = ARENA_W_TILES;
  for (const m of MAPS) {
    setActiveMap(m.id);
    for (let ty = 0; ty < T; ty++) {
      for (let tx = 0; tx < T; tx++) {
        assert.equal(
          blockedTile(tx, ty),
          blockedTile(T - 1 - tx, T - 1 - ty),
          `[${m.id}] (${tx},${ty}) 대칭 지형 어긋남`,
        );
        assert.equal(
          elevTile(tx, ty),
          elevTile(T - 1 - tx, T - 1 - ty),
          `[${m.id}] (${tx},${ty}) 대칭 고도 어긋남`,
        );
      }
    }
    const land = BASE_SITES.filter((b) => !b.label.includes('섬'));
    const isles = BASE_SITES.filter((b) => b.label.includes('섬'));
    assert.ok(isles.length >= 2, `[${m.id}] 섬 확장이 없다`);
    for (const a of land) {
      for (const b of land) {
        if (a.id >= b.id) continue;
        assert.ok(
          navDistance(a.x, a.y, b.x, b.y) > 0,
          `[${m.id}] ${a.label} → ${b.label} 도달 불가`,
        );
      }
    }
    for (const isle of isles) {
      assert.equal(
        navDistance(land[0].x, land[0].y, isle.x, isle.y),
        -1,
        `[${m.id}] ${isle.label} 이 지상으로 도달된다`,
      );
    }
    for (const b of BASE_SITES) {
      assert.equal(
        blockedAt(b.x, b.y),
        false,
        `[${m.id}] ${b.label} 이 벽/물 위에 있다`,
      );
      // 대칭 지점 존재
      const mx = (T - 1) * 1000 - b.x;
      const my = (T - 1) * 1000 - b.y;
      assert.ok(
        BASE_SITES.some((o) => Math.abs(o.x - mx) <= 1000 && Math.abs(o.y - my) <= 1000),
        `[${m.id}] ${b.label} 대칭 자리 없음`,
      );
    }
    // 본진 경로 우회율 1.05~1.3 (MAP_RULES §5)
    const m0 = BASE_SITES.find((b) => b.startFor === 0);
    const m1 = BASE_SITES.find((b) => b.startFor === 1);
    const path = navDistance(m0.x, m0.y, m1.x, m1.y);
    const dx = Math.abs(m0.x - m1.x) / 1000;
    const dy = Math.abs(m0.y - m1.y) / 1000;
    const straight = Math.min(dx, dy) * 14 + Math.abs(dx - dy) * 10;
    const ratio = path / straight;
    assert.ok(ratio >= 1.0 && ratio <= 1.5, `[${m.id}] 우회율 ${ratio.toFixed(2)} 규격 밖`);
  }
  setActiveMap(DEFAULT_MAP_ID); // 다른 테스트를 오염시키지 않는다
});

test('실험장 — 반경 해제·무한 자원·승패 없음, 해시에 모드가 들어간다', () => {
  const s = createState(11, ['steel', 'swarmhive'], 'coast', true);

  // 전 유닛 해금 상태로 시작한다
  assert.ok(s.players[0].unlocked.length > 5, '실험장은 전 유닛 해금');
  assert.equal(s.players[0].minerals, MINERAL_SANDBOX);

  // 기지 반경 밖(맵 한가운데)에 배치가 통한다 — 양 팀 모두
  const mid = 24 * 1000;
  step(s, [
    { execTick: s.tick, team: 0, kind: 'unit', id: 'rifleman', x: mid - 3000, y: mid },
    { execTick: s.tick, team: 1, kind: 'unit', id: 'gnawer', x: mid + 3000, y: mid },
  ]);
  assert.ok(
    s.entities.some((e) => e.kind === 'unit' && e.team === 0) &&
      s.entities.some((e) => e.kind === 'unit' && e.team === 1),
    '실험장은 어디든 배치된다',
  );
  // 자원은 계속 만땅
  assert.equal(s.players[0].minerals, MINERAL_SANDBOX);

  // 본진이 죽어도 경기는 계속된다
  for (const e of s.entities) if (e.kind === 'base' && e.isMain && e.team === 0) e.hp = 0;
  step(s, []);
  assert.equal(s.over, false, '실험장은 본진 파괴로 끝나지 않는다');

  // 같은 시드의 일반 경기와 해시가 다르다 (모드가 해시에 들어간다)
  const normal = createState(11, ['steel', 'swarmhive'], 'coast');
  assert.notEqual(hashState(normal), hashState(createState(11, ['steel', 'swarmhive'], 'coast', true)));
});

test('충전 스킬 — 게이지가 차면 사거리 안에서 자동 발사한다', () => {
  const s = createState(9, ['steel', 'swarmhive'], 'coast', true);
  // 전투비행선 홀로 — 표적이 없으면 게이지가 만땅에서 대기한다
  const gs = place(s, 0, 'gunship', 20000, 10000);
  for (let i = 0; i < SKILL_CHARGE_TICKS + 10; i++) step(s, []);
  assert.equal(byId(s, gs.id).charge, SKILL_CHARGE_TICKS, '표적 없이는 발사하지 않는다');

  // 사거리(7타일) 안에 물어뜯는것 4기 — 융단폭격 240이 한 번에 지운다.
  // 워밍업 동안 비행선이 이동했을 수 있으니 **현재 위치** 곁에 놓는다
  const at = byId(s, gs.id);
  for (let i = 0; i < 4; i++) place(s, 1, 'gnawer', at.x + 4000 + i * 400, at.y);
  const before = s.entities.filter((e) => e.kind === 'unit' && e.team === 1).length;
  for (let i = 0; i < 3; i++) step(s, []);
  const after = s.entities.filter((e) => e.kind === 'unit' && e.team === 1).length;
  assert.ok(before - after >= 3, `광역 즉사 기대 (${before}→${after}) — 일반 공격으로는 불가능한 속도`);
  assert.ok(byId(s, gs.id).charge < SKILL_CHARGE_TICKS, '발사 후 게이지가 리셋된다');
});

test('침공 — 파도가 예정 틱에 쏟아지고, 시간 종료 없이 본진 함락으로만 끝난다', () => {
  const s = createState(3, ['steel', 'swarmhive'], 'coast', false, true);
  assert.equal(s.invasion, true);

  // 첫 파도 직전까지: 침공군 유닛 없음
  while (s.tick < s.nextWaveTick) step(s, []);
  step(s, []);
  assert.equal(s.wave, 1, '첫 파도가 쏟아졌다');
  assert.ok(
    s.entities.some((e) => e.kind === 'unit' && e.team === 1),
    '파도 유닛이 생성됐다',
  );
  // 예산은 정수 곱으로 자란다
  assert.ok(s.waveBudget > 6000, '다음 파도 예산이 커졌다');

  // 내 본진을 부수면 끝난다
  for (const e of s.entities) if (e.kind === 'base' && e.isMain && e.team === 0) e.hp = 0;
  step(s, []);
  assert.equal(s.over, true, '본진 함락 = 종료');
  assert.equal(s.winner, 1);
});

test('침공 2.0 — 소탕 보상·드래프트·유물이 결정론적으로 작동한다', () => {
  const s = createState(4, ['steel', 'swarmhive'], 'siege', false, true);
  // 첫 파도까지 진행
  while (s.wave === 0) step(s, []);
  assert.equal(s.waveAlive, true);
  const before = s.players[0].minerals;

  // 파도를 즉살 — 소탕 보상과 드래프트가 와야 한다
  for (const e of s.entities) if (e.team === 1 && e.kind === 'unit') e.hp = 0;
  step(s, []);
  assert.equal(s.waveAlive, false, '파도 소탕 판정');
  assert.ok(s.players[0].minerals > before, '소탕 보상 지급');
  assert.equal(s.draft.length, 3, '드래프트 3장 제안');

  // 드래프트 선택 — 제안에 있는 카드만
  const pick = s.draft[0];
  step(s, [{ execTick: s.tick, team: 0, kind: 'relic', id: pick, x: 0, y: 0 }]);
  assert.equal(s.draft.length, 0, '선택 후 제안이 닫힌다');
  const p = s.players[0];
  assert.ok(
    pick.startsWith('unlock:') ? p.unlocked.includes(pick.slice(7)) : p.relics.includes(pick),
    '선택이 적용됐다',
  );

  // 침공에서 연구는 봉인
  const ok = applyCommand(s, { execTick: s.tick, team: 0, kind: 'tech', id: 'scoutcar', x: 0, y: 0 });
  assert.equal(ok, false, '침공에서 연구 봉인');

  // 채굴 절반 확인 — 같은 조건 일반 경기 대비
  const inv = createState(4, ['steel', 'swarmhive'], 'siege', false, true);
  const pvp = createState(4, ['steel', 'swarmhive'], 'siege');
  for (let i = 0; i < 100; i++) {
    step(inv, []);
    step(pvp, []);
  }
  assert.ok(inv.players[0].mined < pvp.players[0].mined, '침공 채굴이 더 느리다');
});

test('침공 집결 깃발 — 수비군이 모이고, 재지정은 해제, 지형 위는 거절', () => {
  const s = createState(5, ['steel', 'swarmhive'], 'siege', false, true);
  const main = s.entities.find((e) => e.kind === 'base' && e.team === 0);
  for (let i = 0; i < 3; i++) {
    applyCommand(s, {
      execTick: s.tick, team: 0, kind: 'unit', id: 'rifleman',
      x: main.x + (i - 1) * 900, y: main.y + 900,
    });
  }
  for (let i = 0; i < 25; i++) step(s, []); // 배치 경직 해소

  // 물 위 깃발은 거절 — 갈 수 없는 곳에 꽂으면 전군이 벽에 붙는다
  step(s, [{ execTick: s.tick, team: 0, kind: 'rally', id: '', x: 23500, y: 1500 }]);
  assert.equal(s.players[0].rally, null, '수역 지정은 거절');

  // 평지 깃발 → 수비군이 모인다
  const rx = 23500;
  const ry = 13500;
  step(s, [{ execTick: s.tick, team: 0, kind: 'rally', id: '', x: rx, y: ry }]);
  assert.deepEqual(s.players[0].rally, { x: rx, y: ry });
  for (let i = 0; i < 400; i++) step(s, []);
  const units = s.entities.filter((e) => e.kind === 'unit' && e.team === 0);
  const near = units.filter((e) => Math.hypot(e.x - rx, e.y - ry) < 3000).length;
  assert.equal(near, units.length, '전 수비군이 깃발로 모였다');

  // 같은 자리 재지정 = 해제
  step(s, [{ execTick: s.tick, team: 0, kind: 'rally', id: '', x: rx, y: ry }]);
  assert.equal(s.players[0].rally, null, '재지정은 해제');
});

test('이동 명령 — 전진 본능을 이기고 도착하면 스스로 해제, 남의 유닛은 못 움직인다', () => {
  const s = createState(9, ['steel', 'swarmhive'], 'coast');
  const main = s.entities.find((e) => e.kind === 'base' && e.team === 0);
  for (let i = 0; i < 3; i++) {
    applyCommand(s, {
      execTick: s.tick, team: 0, kind: 'unit', id: 'rifleman',
      x: main.x + (i - 1) * 900, y: main.y - 1200,
    });
  }
  for (let i = 0; i < 25; i++) step(s, []);
  const mine = () => s.entities.filter((e) => e.kind === 'unit' && e.team === 0);
  const ids = mine().map((e) => e.id);

  // 전진 방향(북)과 직각인 서쪽으로 명령
  const tx = main.x - 9000;
  const ty = main.y;
  assert.equal(
    applyCommand(s, { execTick: s.tick, team: 0, kind: 'move', id: ids.join(','), x: tx, y: ty }),
    true,
  );
  let best = Infinity;
  for (let i = 0; i < 400; i++) {
    step(s, []);
    for (const e of mine()) best = Math.min(best, Math.hypot(e.x - tx, e.y - ty));
  }
  assert.ok(best < 2000, `명령 지점에 도달해야 한다 (최근접 ${(best / 1000).toFixed(2)}타일)`);
  assert.ok(mine().every((e) => e.orderX < 0), '도착하면 명령이 스스로 풀린다');

  // 남의 유닛은 조종 불가 — 위조 메시지 방어
  const foe = s.entities.filter((e) => e.kind === 'unit' && e.team === 1).map((e) => e.id);
  assert.equal(
    applyCommand(s, { execTick: s.tick, team: 0, kind: 'move', id: foe.join(',') || '9999', x: tx, y: ty }),
    false,
  );
});

test('방벽 = 지형 — 침공에서만 길을 막고, 완전 봉쇄는 거절된다', () => {
  const s = createState(5, ['steel', 'swarmhive'], 'siege', true, false); // 실험장(대전 규칙)
  for (let i = 0; i < 30; i++) step(s, []);
  applyCommand(s, { execTick: s.tick, team: 0, kind: 'unit', id: 'bulwark', x: 22500, y: 17500 });
  step(s, []);
  const bx = 22;
  const by = 17;
  assert.equal(walkable(bx, by), true, '대전 규칙에서는 건물이 길을 막지 않는다');

  // 침공: 같은 자리에 지으면 길찾기 격자가 막힌다
  const inv = createState(5, ['steel', 'swarmhive'], 'siege', false, true);
  for (let i = 0; i < 30; i++) step(inv, []);
  const main = inv.entities.find((e) => e.kind === 'base' && e.team === 0);
  const before = navDistance(23500, 6500, main.x, main.y);
  applyCommand(inv, { execTick: inv.tick, team: 0, kind: 'unit', id: 'bulwark', x: 22500, y: 17500 });
  applyCommand(inv, { execTick: inv.tick, team: 0, kind: 'unit', id: 'bulwark', x: 25500, y: 17500 });
  step(inv, []);
  assert.equal(walkable(bx, by), false, '침공에서는 건물이 길을 막는다');
  const after = navDistance(23500, 6500, main.x, main.y);
  assert.ok(after > before, `문을 좁히면 경로가 길어진다 (${before} → ${after})`);

  // 완전 봉쇄는 거절 — 본진 둘레를 촘촘히 두르면 어느 순간부터 안 지어진다
  let rejected = 0;
  for (let a = 0; a < 64; a++) {
    const ang = (a / 64) * Math.PI * 2;
    const ok = applyCommand(inv, {
      execTick: inv.tick, team: 0, kind: 'unit', id: 'bulwark',
      x: main.x + Math.cos(ang) * 3200, y: main.y + Math.sin(ang) * 3200,
    });
    if (!ok) rejected++;
    step(inv, []);
  }
  assert.ok(rejected > 0, '완전 봉쇄 배치는 거절된다');
  assert.equal(
    pathExists(1, 1, Math.floor(main.x / 1000), Math.floor(main.y / 1000)),
    true,
    '적이 올 길은 언제나 남는다',
  );
});

test('침공 방벽 설치권 — 다 쓰면 미네랄이 넘쳐도 못 세우고, 파도를 넘기면 보충된다', () => {
  const s = createState(5, ['steel', 'swarmhive'], 'siege', false, true);
  for (let i = 0; i < 30; i++) step(s, []);
  const p = s.players[0];
  p.minerals = 30000; // 자원은 넉넉히 — 제한이 설치권임을 분리해서 본다
  assert.equal(p.wallCharges, INVASION_WALL_START);

  const main = s.entities.find((e) => e.kind === 'base' && e.team === 0);
  let placed = 0;
  for (let i = 0; i < INVASION_WALL_START + 3; i++) {
    const ang = (i / 10) * Math.PI * 2;
    const ok = applyCommand(s, {
      execTick: s.tick, team: 0, kind: 'unit', id: 'bulwark',
      x: main.x + Math.cos(ang) * 4000, y: main.y + Math.sin(ang) * 4000,
    });
    if (ok) placed++;
    step(s, []);
  }
  assert.equal(placed, INVASION_WALL_START, '설치권 수만큼만 지어진다');
  assert.equal(p.wallCharges, 0);

  // 파도를 소탕하면 한 장 보충
  while (s.wave === 0) step(s, []);
  for (const e of s.entities) if (e.team === 1 && e.kind === 'unit') e.hp = 0;
  step(s, []);
  assert.equal(p.wallCharges, INVASION_WALL_PER_WAVE, '파도를 넘기면 설치권이 보충된다');
});

test('침공 지원 건물 — 감속·공격·수리 오라가 결정론적으로 작동한다', () => {
  const mk = () => {
    const s = createState(5, ['steel', 'swarmhive'], 'siege', false, true);
    for (let i = 0; i < 30; i++) step(s, []);
    const p = s.players[0];
    p.minerals = 30000;
    p.wallCharges = 9;
    for (const id of INVASION_BUILDINGS) if (!p.unlocked.includes(id)) p.unlocked.push(id);
    p.unlocked.sort();
    return s;
  };
  const foe = (s, x, y, unit, hp) => {
    const e = {
      id: s.nextId++, team: 1, unit, kind: 'unit', x, y, hp, maxHp: hp, cd: 0, deploy: 0,
      life: -1, target: -1, flying: false, charge: 0, orderX: -1, orderY: -1,
      siteId: -1, isMain: false, reserve: 0,
    };
    s.entities.push(e);
    s.entities.sort((a, b) => a.id - b.id);
    return e;
  };

  // 냉각탑 — 오라 안에서 진군이 느려진다 (이동 명령으로 '표적 정지' 오염 제거)
  const march = (tower) => {
    const s = mk();
    const m = s.entities.find((e) => e.kind === 'base' && e.team === 0);
    if (tower) {
      assert.equal(
        applyCommand(s, { execTick: s.tick, team: 0, kind: 'unit', id: 'chilltower', x: m.x - 2000, y: m.y - 8000 }),
        true,
        '냉각탑 배치는 성공해야 한다 (실측 하네스 오염 방지)',
      );
      for (let i = 0; i < 30; i++) step(s, []);
    }
    const e = foe(s, m.x, m.y - 9000, 'gnawer', 95);
    e.orderX = m.x;
    e.orderY = m.y - 6000;
    const y0 = e.y;
    for (let i = 0; i < 40; i++) step(s, []);
    return Math.abs(e.y - y0);
  };
  const free = march(false);
  const chilled = march(true);
  assert.ok(chilled < free * 0.8, `냉각탑이 진군을 늦춘다 (${free} → ${chilled})`);

  // 정비고 — 아군 건물이 회복된다
  const s = mk();
  const m = s.entities.find((e) => e.kind === 'base' && e.team === 0);
  assert.equal(
    applyCommand(s, { execTick: s.tick, team: 0, kind: 'unit', id: 'repairbay', x: m.x + 2000, y: m.y - 2000 }),
    true,
  );
  assert.equal(
    applyCommand(s, { execTick: s.tick, team: 0, kind: 'unit', id: 'bulwark', x: m.x + 3200, y: m.y - 2000 }),
    true,
  );
  for (let i = 0; i < 40; i++) step(s, []);
  const wall = s.entities.find((e) => e.unit === 'bulwark');
  wall.hp = 400;
  for (let i = 0; i < 200; i++) step(s, []);
  assert.ok(wall.hp > 500, `정비고가 건물을 수리한다 (400 → ${wall.hp})`);

  // 지원 건물은 종족 트리에 없다 — 드래프트로만 온다
  for (const id of INVASION_BUILDINGS) {
    for (const f of FACTION_IDS) {
      assert.ok(
        !getFaction(f).tech.some((n) => n.unit === id),
        `${id}가 종족 트리에 새어 들어갔다 — 대전에 나오면 안 된다`,
      );
    }
  }
});

test('3축 특성 유물 — 유닛 하나의 성격을 바꾸고, 미해금 유닛 특성은 제안되지 않는다', () => {
  const arena = (relics) => {
    const s = createState(7, ['steel', 'covenant'], 'coast', true); // 실험장: 전 유닛 해금
    s.players[0].relics = relics.slice();
    return s;
  };
  const foe = (s, x, y, hp) => {
    const e = {
      id: s.nextId++, team: 1, unit: 'devourer', kind: 'unit', x, y, hp, maxHp: hp,
      cd: 0, deploy: 0, life: -1, target: -1, flying: false, charge: 0,
      orderX: -1, orderY: -1, siteId: -1, isMain: false, reserve: 0,
    };
    s.entities.push(e);
    s.entities.sort((a, b) => a.id - b.id);
    return e;
  };

  // 광신 — 공격 +35% (중립 평지: 본진 사거리 오염을 피한다)
  const zeal = (relics) => {
    const s = arena(relics);
    assert.equal(
      applyCommand(s, { execTick: s.tick, team: 0, kind: 'unit', id: 'zealot', x: 17000, y: 8800 }),
      true,
    );
    for (let i = 0; i < 25; i++) step(s, []);
    const t = foe(s, 17600, 8800, 99999);
    const h0 = t.hp;
    for (let i = 0; i < 200; i++) {
      t.x = 17600;
      t.y = 8800;
      step(s, []);
    }
    return h0 - t.hp;
  };
  const plain = zeal([]);
  const zealed = zeal(['zeal']);
  assert.ok(zealed > plain * 1.25, `광신이 광전사 피해를 키운다 (${plain} → ${zealed})`);

  // 불안정 노심 — 죽을 때 폭발. 수명·주문으로 죽어도 터져야 한다(reap 경로)
  const s = arena(['volatile_core']);
  assert.equal(
    applyCommand(s, { execTick: s.tick, team: 0, kind: 'unit', id: 'ironwalker', x: 17000, y: 8800 }),
    true,
  );
  for (let i = 0; i < 25; i++) step(s, []);
  const w = s.entities.find((e) => e.unit === 'ironwalker');
  const near = foe(s, w.x + 1500, w.y, 5000);
  const far = foe(s, w.x + 6000, w.y, 5000);
  w.hp = 0;
  step(s, []);
  assert.equal(5000 - near.hp, 240, '반경 안은 폭발 피해를 받는다');
  assert.equal(far.hp, 5000, '반경 밖은 멀쩡하다');

  // 겨냥한 유닛이 없으면 드래프트에 나오지 않는다
  const inv = createState(3, ['steel', 'swarmhive'], 'siege', false, true);
  while (inv.wave === 0) step(inv, []);
  for (let round = 0; round < 12; round++) {
    for (const e of inv.entities) if (e.team === 1 && e.kind === 'unit') e.hp = 0;
    step(inv, []);
    for (const card of inv.draft) {
      if (card.startsWith('unlock:')) continue;
      const r = RELIC_BY_ID.get(card);
      if (r?.unit) {
        assert.ok(
          inv.players[0].unlocked.includes(r.unit),
          `미해금 유닛(${r.unit}) 특성이 제안됐다 — 죽은 카드가 된다`,
        );
      }
    }
    if (inv.draft.length > 0) {
      step(inv, [{ execTick: inv.tick, team: 0, kind: 'relic', id: inv.draft[0], x: 0, y: 0 }]);
    }
    while (inv.entities.every((e) => e.team !== 1 || e.kind !== 'unit')) step(inv, []);
  }
});

/* ── 4축 능동 스킬 (라운드 35) ─────────────────────────────────────────── */

test('4축 능동 스킬 — 은신·디텍팅·시즈모드·지뢰·가속이 침공에서만 작동한다', () => {
  const FY = 9000; // coast 중립 평지 — 본진 사거리 밖
  const mk = (invasion) => {
    const s = createState(11, ['steel', 'swarmhive'], 'coast', false, invasion);
    s.nextWaveTick = 1 << 28; // 파도가 실측에 끼어들지 않게
    return s;
  };
  /** 엔티티를 직접 세운다 — 자리가 통행 가능하고 기지에서 먼지 단언한다 */
  const put = (s, team, id, x, y) => {
    assert.ok(!blockedAt(x, y), `배치 자리가 막혀 있다: ${id}`);
    for (const b of s.entities) {
      if (b.kind !== 'base') continue;
      assert.ok(
        (b.x - x) ** 2 + (b.y - y) ** 2 >= 12000 ** 2,
        `${id}가 기지 사거리 안이다 — 기지가 대신 때린다`,
      );
    }
    const u = getUnit(id);
    const e = {
      id: s.nextId++, team, unit: id,
      kind: u.kind === 'building' ? 'building' : 'unit',
      x, y, hp: u.hp, maxHp: u.hp, cd: 0, deploy: 0,
      life: u.lifetime, target: -1, flying: u.flying,
      charge: 0, mode: 0, haste: 0, orderX: -1, orderY: -1,
      siteId: -1, isMain: false, reserve: 0,
    };
    s.entities.push(e);
    return e;
  };
  const live = (s, id) => s.entities.find((e) => e.id === id);
  /** 못박은 유닛은 매 틱 자기 자리로 명령을 다시 받는다 (도착하면 풀리므로) */
  const run = (s, n, pins = []) => {
    for (let i = 0; i < n; i++) {
      for (const p of pins) {
        const e = live(s, p.id);
        if (e) { e.orderX = p.x; e.orderY = p.y; }
      }
      step(s, []);
    }
  };
  const pin = (e) => ({ id: e.id, x: e.x, y: e.y });

  // 은신 — 게이지가 차면 표적에서 빠지고, 때리면 드러난다
  {
    const s = mk(true);
    const shade = put(s, 0, 'shade', 20000, FY);
    const spit = put(s, 1, 'spitter', 23000, FY);
    const pins = [pin(shade), pin(spit)];
    run(s, 20, pins);
    assert.equal(live(s, spit.id).target, shade.id, '은신 전에는 표적이 된다');
    run(s, 110, pins);
    assert.ok(live(s, shade.id).charge >= 100, '5초면 게이지가 찬다');
    assert.notEqual(live(s, spit.id).target, shade.id, '은신하면 표적에서 빠진다');
    const hp = live(s, shade.id).hp;
    run(s, 60, pins);
    assert.equal(live(s, shade.id).hp, hp, '은신 중에는 맞지 않는다');

    // 디텍터가 오면 다시 보인다
    put(s, 1, 'scoutcar', 25000, FY);
    run(s, 3, pins);
    assert.equal(live(s, spit.id).target, shade.id, '디텍터 반경 안이면 표적이 된다');
  }

  // 은신 해제 — 공격이 곧 노출이다 (디텍터 없는 상대의 유일한 반격로)
  {
    const s = mk(true);
    const shade = put(s, 0, 'shade', 20000, FY);
    run(s, 110, [pin(shade)]);
    assert.ok(live(s, shade.id).charge >= 100);
    const foe = put(s, 1, 'gnawer', 20900, FY);
    run(s, 10, [pin(shade), pin(foe)]);
    assert.ok(live(s, shade.id).charge < 100, '때리면 게이지가 비워진다');
  }

  // 시즈모드 — 정지 2초로 사거리 7 → 9.5, 공격 +35%
  {
    const reach = (dist) => {
      const s = mk(true);
      put(s, 0, 'siegetank', 16000, FY);
      run(s, 60); // 적 없이 자리를 잡는다 (이동 명령은 곧 시즈 해제라 핀을 쓰지 않는다)
      const foe = put(s, 1, 'devourer', 16000 + dist, FY);
      const hp0 = foe.hp;
      run(s, 200, [pin(foe)]);
      return hp0 - (live(s, foe.id)?.hp ?? 0);
    };
    assert.ok(reach(8500) > 0, '시즈 사거리(8.5타일)에서 닿는다');
    assert.equal(reach(11000), 0, '9.5타일 밖에는 못 닿는다');

    const oneHit = (settle) => {
      const s = mk(true);
      const tank = put(s, 0, 'siegetank', 16000, FY);
      if (settle) run(s, 60);
      const foe = put(s, 1, 'devourer', 22000, FY);
      let hp = foe.hp;
      for (let i = 0; i < 80; i++) {
        run(s, 1, [pin(foe)]);
        const f = live(s, foe.id);
        if (f.hp !== hp) return hp - f.hp;
      }
      return 0;
    };
    const base = getUnit('siegetank').damage;
    assert.equal(oneHit(false), base, '평시 타격은 기본 공격력');
    assert.equal(oneHit(true), Math.trunc((base * 135) / 100), '시즈 타격은 +35%');
  }

  // 지뢰 — 방벽이 상한까지 묻고, 밟히면 자폭한다
  {
    const s = mk(true);
    put(s, 0, 'bulwark', 20000, FY);
    const mines = () => s.entities.filter((e) => e.unit === 'landmine');
    run(s, 181);
    assert.equal(mines().length, 1, '9초에 한 기');
    run(s, 1000);
    assert.equal(mines().length, 3, '상한 3기에서 멈춘다');
    const mine = mines()[0];
    const foe = put(s, 1, 'devourer', mine.x + 1100, mine.y);
    const hp0 = foe.hp;
    run(s, 40, [pin(foe)]);
    assert.ok(!live(s, mine.id), '밟은 지뢰는 사라진다');
    assert.ok(hp0 - live(s, foe.id).hp > 0, '폭발 피해가 들어간다');
    // 묻은 것은 길을 막지 않는다 — 1축의 벽과 다르다
    for (const m of mines()) {
      assert.ok(!blockedAt(m.x, m.y), '지뢰가 길찾기 장애물이 됐다');
    }
  }

  // 가속 — 굴착충 둘레의 아군 지상군이 빨라진다
  {
    const march = (withTunneler) => {
      const s = mk(true);
      const g = put(s, 0, 'gnawer', 16000, FY);
      if (withTunneler) put(s, 0, 'tunneler', 16000, FY - 2000); // 행군로 밖
      run(s, 239);
      const x0 = live(s, g.id).x;
      run(s, 80, [{ id: g.id, x: 34000, y: FY }]);
      return live(s, g.id).x - x0;
    };
    const plain = march(false);
    const fast = march(true);
    assert.ok(fast > plain * 130 / 100, `가속이 붙는다 (${plain} → ${fast})`);
  }

  // 대전 불가침 — 같은 유닛도 대전에서는 아무 능동기를 쓰지 않는다
  {
    const s = mk(false);
    const shade = put(s, 0, 'shade', 20000, FY);
    const spit = put(s, 1, 'spitter', 23000, FY);
    run(s, 130, [pin(shade), pin(spit)]);
    const sh = live(s, shade.id);
    assert.ok(!sh || sh.charge === 0, '대전에서는 게이지가 차지 않는다');
    assert.ok(!sh || sh.hp < sh.maxHp, '대전에서 그림자는 그냥 맞는다');
  }

  // 지뢰는 카드가 없다 — 종족 트리에도, 실험장 해금에도 없다
  for (const f of FACTION_IDS) {
    assert.ok(
      !getFaction(f).tech.some((n) => n.unit === 'landmine'),
      '지뢰가 종족 트리에 새어 들어갔다',
    );
  }
  const sb = createState(3, ['steel', 'swarmhive'], 'coast', true);
  assert.ok(!sb.players[0].unlocked.includes('landmine'), '실험장 해금에 지뢰가 섞였다');
});

/* ── 5축 영웅 (라운드 37) ──────────────────────────────────────────────── */

test('5축 영웅 — 런 시작 3택1·성장·재기, 대전에는 없다', () => {
  const FY = 9000;
  const inv = (seed = 11) => {
    const s = createState(seed, ['steel', 'swarmhive'], 'coast', false, true);
    s.nextWaveTick = 1 << 28;
    return s;
  };
  const pick = (s, id) =>
    applyCommand(s, { execTick: s.tick, team: 0, kind: 'relic', id, x: 0, y: 0 });
  const heroOf = (s) => s.entities.find((e) => e.kind !== 'base' && getUnit(e.unit).hero);
  /** 영웅을 중립 평지로 — 본진 곁에서 재면 기지가 대신 때린다 */
  const relocate = (s, e, x = 20000, y = FY) => {
    assert.ok(!blockedAt(x, y), '이전 자리가 막혀 있다');
    for (const b of s.entities) {
      if (b.kind !== 'base') continue;
      assert.ok((b.x - x) ** 2 + (b.y - y) ** 2 >= 12000 ** 2, '이전 자리가 기지 코앞');
    }
    e.x = x;
    e.y = y;
    e.deploy = 0;
    return e;
  };

  // 런 시작 3택1 — 보상 드래프트와 채널이 다르다
  {
    const s = inv();
    assert.equal(s.heroDraft.length, 3, '시작하자마자 영웅 3장');
    assert.equal(s.draft.length, 0, '보상 드래프트는 비어 있다');
    assert.ok(pick(s, 'hero:hero_queen'), '픽이 먹는다');
    assert.equal(s.players[0].hero, 'hero_queen');
    assert.ok(heroOf(s), '영웅이 전장에 선다');
    assert.equal(s.heroDraft.length, 0, '제안이 닫힌다');
    assert.equal(pick(s, 'hero:hero_prophet'), false, '두 번은 못 고른다');
  }

  // 대전·실험장 불가침
  {
    const v = createState(3, ['covenant', 'swarmhive'], 'coast');
    assert.equal(v.heroDraft.length, 0, '대전에는 제안이 없다');
    assert.equal(
      applyCommand(v, { execTick: 0, team: 0, kind: 'relic', id: 'hero:hero_queen', x: 0, y: 0 }),
      false,
      '대전에서 영웅 픽이 거절된다',
    );
    const sb = createState(3, ['steel', 'swarmhive'], 'coast', true);
    for (const id of HERO_IDS) {
      assert.ok(!sb.players[0].unlocked.includes(id), `실험장 해금에 ${id}가 섞였다`);
      for (const f of FACTION_IDS) {
        assert.ok(
          !getFaction(f).tech.some((n) => n.unit === id),
          `${id}가 종족 트리에 새어 들어갔다`,
        );
      }
    }
  }

  // 성장 — 레벨당 공격 +8%
  {
    const dealt = (level) => {
      const s = inv();
      pick(s, 'hero:hero_commander');
      s.players[0].heroLevel = level;
      const h = relocate(s, heroOf(s));
      const foe = {
        id: s.nextId++, team: 1, unit: 'devourer', kind: 'unit',
        x: h.x + 4000, y: h.y, hp: 999999, maxHp: 999999, cd: 0, deploy: 0,
        life: -1, target: -1, flying: false, charge: 0, mode: 0, haste: 0,
        orderX: -1, orderY: -1, siteId: -1, isMain: false, reserve: 0,
      };
      s.entities.push(foe);
      for (let i = 0; i < 200; i++) {
        foe.orderX = foe.x;
        foe.orderY = foe.y;
        h.orderX = h.x;
        h.orderY = h.y;
        step(s, []);
      }
      return 999999 - foe.hp;
    };
    const lv0 = dealt(0);
    const lv5 = dealt(5);
    assert.ok(lv5 > lv0 * 130 / 100, `레벨이 화력을 올린다 (${lv0} → ${lv5})`);
  }

  // 전사 → 레벨 하나를 잃고 다시 일어선다
  {
    const s = inv();
    pick(s, 'hero:hero_commander');
    s.players[0].heroLevel = 4;
    heroOf(s).hp = 0;
    step(s, []);
    assert.ok(!heroOf(s), '시체가 걷힌다');
    assert.equal(s.players[0].heroLevel, 3, '레벨 하나를 잃는다');
    assert.ok(s.players[0].heroRespawn > 0, '재기 시계가 걸린다');
    for (let i = 0; i < HERO_RESPAWN_TICKS + 2; i++) step(s, []);
    const back = heroOf(s);
    assert.ok(back, '다시 일어선다');
    assert.ok(back.maxHp > getUnit('hero_commander').hp, '체력에 성장이 얹힌다');
  }

  // 산란 — 새끼는 수명이 있어 무한히 쌓이지 않는다
  {
    const s = inv();
    pick(s, 'hero:hero_queen');
    const h = relocate(s, heroOf(s));
    const brood = () => s.entities.filter((e) => e.unit === 'broodling').length;
    for (let i = 0; i < 205; i++) {
      h.orderX = h.x;
      h.orderY = h.y;
      step(s, []);
    }
    assert.equal(brood(), 3, '10초마다 셋');
    for (let i = 0; i < 1100; i++) {
      h.orderX = h.x;
      h.orderY = h.y;
      step(s, []);
    }
    assert.ok(brood() < 16, `새끼가 무한 증식하지 않는다 (${brood()}마리)`);
  }
});

/* ── 로그라이트 3단계: 런 체인 (라운드 38) ────────────────────────────── */

test('런 체인 — 무대를 넘기면 전장만 바뀌고 성장은 따라온다', () => {
  const pick = (s, id) =>
    applyCommand(s, { execTick: s.tick, team: 0, kind: 'relic', id, x: 0, y: 0 });
  const wipe = (s) => {
    for (const e of s.entities) if (e.team === 1 && e.kind === 'unit') e.hp = 0;
    step(s, []);
  };
  const forceWave = (s) => {
    s.nextWaveTick = s.tick;
    step(s, []);
  };

  const s = createState(9, ['steel', 'swarmhive'], 'siege', false, true);
  pick(s, 'hero:hero_commander');
  assert.equal(s.stage, 0, '런은 1무대에서 시작한다');

  // 1무대 → 2무대
  let guard = 0;
  while (s.stage === 0 && guard++ < 40) {
    forceWave(s);
    wipe(s);
    if (s.draft.length > 0) pick(s, s.draft[0]);
  }
  assert.equal(s.stage, 1, '목표 파도를 넘기면 다음 무대');
  assert.equal(s.mapId, RUN_STAGES[1].map, '전장이 바뀐다');
  assert.ok(s.wave >= RUN_STAGES[0].waves, '파도 번호는 이어진다(예산 연속)');
  assert.ok(
    s.entities.some((e) => e.kind === 'base' && e.team === 0 && e.isMain),
    '새 전장에 내 본진이 선다',
  );
  assert.ok(
    s.entities.some((e) => e.kind !== 'base' && getUnit(e.unit).hero),
    '영웅이 따라온다',
  );
  assert.ok(s.players[0].relics.length + s.players[0].unlocked.length > 0, '성장이 남는다');
  assert.equal(s.players[0].rally, null, '집결 깃발은 초기화');

  // 2무대 → 3무대(둥지)
  guard = 0;
  while (s.stage === 1 && guard++ < 40) {
    forceWave(s);
    wipe(s);
    if (s.draft.length > 0) pick(s, s.draft[0]);
  }
  assert.equal(s.stage, 2, '2무대를 넘기면 둥지 무대');
  const nest = s.entities.find((e) => e.unit === 'nest');
  assert.ok(nest, '둥지가 선다');
  assert.equal(nest.team, 1, '둥지는 적의 것이다');
  assert.equal(s.over, false, '아직 런은 끝나지 않았다');

  // 둥지 격파 = 런 완주
  nest.hp = 0;
  step(s, []);
  assert.equal(s.over, true, '둥지를 부수면 런이 끝난다');
  assert.equal(s.winner, 0, '완주는 승리다');

  // 본진 함락은 여전히 패배
  const lose = createState(3, ['steel', 'swarmhive'], 'siege', false, true);
  lose.entities.find((e) => e.kind === 'base' && e.team === 0 && e.isMain).hp = 0;
  step(lose, []);
  assert.equal(lose.winner, 1, '본진이 무너지면 패배');

  // 대전은 무대를 모른다
  const v = createState(3, ['covenant', 'swarmhive'], 'coast');
  for (let i = 0; i < 200; i++) step(v, []);
  assert.equal(v.stage, 0);
  assert.ok(!v.entities.some((e) => e.unit === 'nest'), '대전에 둥지가 없다');
});

test('침공에서는 기지 포격이 일꾼을 갈아내지 않는다 (대전에서는 그대로)', () => {
  const hit = (invasion) => {
    const s = createState(7, ['steel', 'swarmhive'], invasion ? 'siege' : 'coast', false, invasion);
    const p = s.players[0];
    const before = p.workers;
    const base = s.entities.find((e) => e.kind === 'base' && e.team === 0 && e.isMain);
    // 문턱(WORKER_LOSS_DAMAGE)을 훌쩍 넘는 피해를 한 번에 먹인다
    const foe = {
      id: s.nextId++, team: 1, unit: 'devourer', kind: 'unit',
      x: base.x + 800, y: base.y, hp: 99999, maxHp: 99999, cd: 0, deploy: 0,
      life: -1, target: -1, flying: false, charge: 0, mode: 0, haste: 0,
      orderX: -1, orderY: -1, siteId: -1, isMain: false, reserve: 0,
    };
    s.entities.push(foe);
    for (let i = 0; i < 200; i++) {
      foe.x = base.x + 800;
      foe.y = base.y;
      step(s, []);
    }
    return { before, after: p.workers, dealt: base.maxHp - base.hp };
  };
  const inv = hit(true);
  const pvp = hit(false);
  assert.ok(inv.dealt > WORKER_LOSS_DAMAGE * 2, `침공 기지가 충분히 맞았다 (${inv.dealt})`);
  assert.equal(inv.after, inv.before, '침공에서는 일꾼이 죽지 않는다');
  assert.ok(pvp.dealt > WORKER_LOSS_DAMAGE, `대전 기지가 충분히 맞았다 (${pvp.dealt})`);
  assert.ok(pvp.after < pvp.before, '대전에서는 일꾼이 갈려 나간다 (라운드 4 규칙 유지)');
});

/* ── 라운드 47: 파도 진입로 예고 ───────────────────────────────────────── */

test('waveAnchorOf가 실제 스폰 위치와 일치한다 (예고가 거짓말하지 않는다)', () => {
  const s = createState(13, ['steel', 'swarmhive'], 'siege', false, true);
  // 다음 파도가 어디서 나올지 **미리** 묻는다
  const predicted = waveAnchorOf(s, s.wave + 1);
  const before = new Set(s.entities.filter((e) => e.team === 1).map((e) => e.id));

  // 그 파도를 실제로 부른다
  s.nextWaveTick = s.tick;
  step(s, []);
  const born = s.entities.filter((e) => e.team === 1 && !before.has(e.id));
  assert.ok(born.length > 0, '파도가 실제로 나왔다');

  // 새로 태어난 것들은 전부 예고 지점 둘레에 있어야 한다
  for (const e of born) {
    const d = Math.hypot(e.x - predicted[0], e.y - predicted[1]);
    assert.ok(d < 8000, `예고(${predicted}) 둘레에서 태어났다 — ${e.unit} @${e.x},${e.y} d=${d}`);
  }
});

test('파도 진입로는 세 모서리를 돌아간다 (한 방향에 몰리지 않는다)', () => {
  const s = createState(13, ['steel', 'swarmhive'], 'siege', false, true);
  const seen = [];
  for (let w = 1; w <= 6; w++) seen.push(waveAnchorOf(s, w).join(','));
  const uniq = new Set(seen);
  assert.equal(uniq.size, 3, `세 모서리를 쓴다 — ${[...uniq].join(' / ')}`);
  // 로테이션이므로 3파도 뒤에는 같은 자리로 돌아온다
  assert.equal(seen[0], seen[3], '3파도 주기');
  assert.equal(seen[1], seen[4], '3파도 주기');

  // 내 본진 코앞 모서리는 쓰지 않는다
  const main = s.entities.find((e) => e.kind === 'base' && e.team === 0 && e.isMain);
  for (const a of uniq) {
    const [ax, ay] = a.split(',').map(Number);
    assert.ok(
      Math.hypot(ax - main.x, ay - main.y) > 10000,
      `진입로가 본진 코앞이 아니다 — ${a}`,
    );
  }
});

test('waveAnchorOf는 상태를 건드리지 않는다 (해시 불변 — 렌더러가 매 프레임 부른다)', () => {
  const s = createState(21, ['steel', 'swarmhive'], 'siege', false, true);
  for (let i = 0; i < 60; i++) step(s, []);
  const before = hashState(s);
  for (let w = 1; w <= 20; w++) waveAnchorOf(s, w);
  assert.equal(hashState(s), before, '예고를 물어도 시뮬 상태는 그대로다');
});

/* ── 라운드 48: 철수 정산 ──────────────────────────────────────────────── */

/** 무대 하나를 넘긴다 — 목표 파도까지 밀고 전장을 비운다 */
function pushStage(s) {
  let guard = 0;
  const from = s.stage;
  while (s.stage === from && guard++ < 60) {
    s.nextWaveTick = s.tick;
    step(s, []);
    for (const e of s.entities) if (e.team === 1 && e.kind === 'unit') e.hp = 0;
    step(s, []);
    if (s.draft.length > 0) {
      applyCommand(s, { execTick: s.tick, team: 0, kind: 'relic', id: s.draft[0], x: 0, y: 0 });
    }
  }
  return s.stage !== from;
}

test('무대를 넘기면 두고 가는 병력·확장이 미네랄로 정산된다', () => {
  const s = createState(5, ['steel', 'swarmhive'], 'siege', false, true);
  const p = s.players[0];
  // 병력을 세운다 (정산 대상). 시뮬이 직접 만들게 하지 않고 배치 명령을 쓴다
  p.minerals = RICH;
  const base = s.entities.find((e) => e.kind === 'base' && e.team === 0 && e.isMain);
  let placed = 0;
  for (let i = 0; i < 6; i++) {
    const okCmd = applyCommand(s, {
      execTick: s.tick, team: 0, kind: 'unit', id: 'rifleman',
      x: base.x + (i - 3) * 900, y: base.y - 2600,
    });
    if (okCmd) placed++;
    p.minerals = RICH; // 배치 성공을 단언하기 위해 돈 걱정을 지운다
  }
  assert.ok(placed >= 4, `병력이 실제로 섰다 (${placed}기)`);
  for (let i = 0; i < 40; i++) step(s, []);

  const army = s.entities.filter((e) => e.team === 0 && e.kind === 'unit'
    && !getUnit(e.unit).hero).length;
  assert.ok(army >= 4, `정산 대상 병력이 있다 (${army}기)`);
  const before = p.minerals;

  assert.ok(pushStage(s), '무대를 넘겼다');
  assert.equal(s.stage, 1, '2무대');
  assert.ok(s.salvage > 0, `정산이 있었다 (+${s.salvage})`);
  assert.ok(p.minerals > before - RICH, '정산이 미네랄로 들어왔다');

  // 정산액은 판 것의 STAGE_REFUND_PCT — 소총병 코스트로 하한을 확인한다
  const floor = Math.trunc((army * getUnit('rifleman').cost * MINERAL_SCALE * STAGE_REFUND_PCT) / 100);
  assert.ok(s.salvage >= Math.min(floor, STAGE_REFUND_MAX) * 0.9,
    `정산이 병력 값어치에 비례한다 (정산 ${s.salvage} vs 병력분 ${floor})`);
});

test('정산에는 상한이 있다 (스노볼 차단)', () => {
  const s = createState(9, ['steel', 'swarmhive'], 'siege', false, true);
  const p = s.players[0];
  const base = s.entities.find((e) => e.kind === 'base' && e.team === 0 && e.isMain);
  // 상한을 확실히 넘길 만큼 세운다
  for (let i = 0; i < 40; i++) {
    p.minerals = RICH;
    applyCommand(s, {
      execTick: s.tick, team: 0, kind: 'unit', id: 'rifleman',
      x: base.x + ((i % 7) - 3) * 700, y: base.y - 2200 - Math.trunc(i / 7) * 700,
    });
  }
  for (let i = 0; i < 40; i++) step(s, []);
  const army = s.entities.filter((e) => e.team === 0 && e.kind === 'unit').length;
  assert.ok(army >= 20, `대군이 섰다 (${army}기)`);
  assert.ok(pushStage(s), '무대를 넘겼다');
  assert.equal(s.salvage, STAGE_REFUND_MAX, `정산이 상한에서 잘린다 (${s.salvage})`);
});

test('영웅과 소환물은 정산 대상이 아니다 (영웅은 따라오고, 소환물은 산 적 없다)', () => {
  const s = createState(15, ['steel', 'swarmhive'], 'siege', false, true);
  applyCommand(s, { execTick: s.tick, team: 0, kind: 'relic', id: 'hero:hero_commander', x: 0, y: 0 });
  for (let i = 0; i < 30; i++) step(s, []);
  const hero = s.entities.find((e) => e.team === 0 && e.kind === 'unit' && getUnit(e.unit).hero);
  assert.ok(hero, '영웅이 섰다');
  // 병력은 영웅 하나뿐 — 정산은 0이어야 한다
  const others = s.entities.filter((e) => e.team === 0 && e.kind === 'unit'
    && !getUnit(e.unit).hero).length;
  assert.equal(others, 0, '영웅 외 병력이 없다');
  assert.ok(pushStage(s), '무대를 넘겼다');
  assert.equal(s.salvage, 0, `영웅만 있으면 정산이 없다 (${s.salvage})`);
  // 그리고 영웅은 새 전장에 따라와 있다
  assert.ok(s.entities.some((e) => e.team === 0 && e.kind === 'unit' && getUnit(e.unit).hero),
    '영웅은 무대를 따라온다');
});

test('채굴은 이미 쌓인 정산금을 깎지 않는다', () => {
  const s = createState(5, ['steel', 'swarmhive'], 'siege', false, true);
  const p = s.players[0];
  p.minerals = 50 * MINERAL_SCALE; // 정산으로 크게 넘겨받은 상태를 흉내
  const before = p.minerals;
  for (let i = 0; i < 200; i++) step(s, []);
  // 상한이 사라졌으므로 채굴은 **더하기만** 한다 — 예전에는 천장 위의 몫을
  // 매 틱 깎아 정산금이 증발했다 (라운드 48에 고친 버그의 회귀 방지)
  assert.ok(p.minerals >= before, `채굴이 쌓인 몫을 깎았다 (${before} → ${p.minerals})`);
});

test('대전·실험장에는 정산이 없다 (침공 전용)', () => {
  const v = createState(5, ['covenant', 'swarmhive'], 'coast');
  for (let i = 0; i < 400; i++) step(v, []);
  assert.equal(v.salvage, 0, '대전은 정산을 모른다');
  assert.equal(v.stage, 0, '대전은 무대를 모른다');
  // 그리고 대전의 보유 상한은 그대로다
  assert.equal(v.salvage, 0, '대전에 정산이 들어왔다');
});

test('무대를 넘기면 파도 예산이 되감긴다 (번호·조성 예고는 그대로)', () => {
  const s = createState(5, ['steel', 'swarmhive'], 'siege', false, true);
  assert.ok(pushStage(s), '무대를 넘겼다');
  const waveAtBoundary = s.wave;
  const budgetAfter = s.waveBudget;

  // 같은 파도 번호까지 **한 무대에서** 밀었을 때의 예산과 비교한다
  const flat = createState(5, ['steel', 'swarmhive'], 'siege', false, true);
  flat.stage = 2; // 목표 파도 게이트가 없는 무대 — 계속 스폰된다
  while (flat.wave < waveAtBoundary) {
    flat.nextWaveTick = flat.tick;
    step(flat, []);
    for (const e of flat.entities) if (e.team === 1 && e.kind === 'unit') e.hp = 0;
    step(flat, []);
  }

  if (STAGE_BUDGET_ROLLBACK_PCT < 100) {
    assert.ok(budgetAfter < flat.waveBudget,
      `되감기가 예산을 물렸다 (무대 전환 후 ${budgetAfter} < 그냥 진행 ${flat.waveBudget})`);
  }
  // 번호는 이어진다 — 되감기가 번호를 건드리면 조성 예고와 보스 주기가
  // 통째로 어긋난다. 크기만 물리고 리듬은 그대로여야 한다
  assert.ok(s.wave >= RUN_STAGES[0].waves, `파도 번호는 이어진다 (${s.wave})`);
  assert.equal(s.wave, flat.wave, '무대를 넘긴 쪽과 그냥 진행한 쪽의 파도 번호가 같다');
  assert.equal(waveTypeOf(s.wave + 1), waveTypeOf(flat.wave + 1),
    '다음 파도 조성 예고도 같다 (보스 주기 유지)');
});

test('되감기에도 예산은 시작값 아래로 내려가지 않는다', () => {
  const s = createState(5, ['steel', 'swarmhive'], 'siege', false, true);
  assert.ok(pushStage(s), '2무대');
  assert.ok(s.waveBudget >= INVASION_BUDGET_START,
    `예산 하한 (${s.waveBudget} >= ${INVASION_BUDGET_START})`);
  assert.ok(pushStage(s), '3무대');
  assert.ok(s.waveBudget >= INVASION_BUDGET_START,
    `두 번 되감아도 하한 (${s.waveBudget})`);
});

/* ── 몸집 (오너 지시: 유닛·기지 3배, 크기별로 겹치지 않게) ─────────────── */

test('유닛 몸집은 크기 등급을 따른다 — 작은 놈이 큰 놈보다 자리를 덜 먹는다', () => {
  const s = createState(5, MIRROR);
  const small = place(s, 0, 'gnawer', 24000, 30000);
  const medium = place(s, 0, 'zealot', 24000, 32000);
  const large = place(s, 0, 'devourer', 24000, 34000);

  assert.equal(radiusOf(small), UNIT_RADIUS_SMALL);
  assert.equal(radiusOf(medium), UNIT_RADIUS);
  assert.equal(radiusOf(large), UNIT_RADIUS_LARGE);
  assert.ok(
    radiusOf(small) < radiusOf(medium) && radiusOf(medium) < radiusOf(large),
    '크기 등급이 반경 순서로 이어지지 않는다',
  );
});

test('겹쳐 놓은 유닛은 두 몸집의 합만큼 벌어진다', () => {
  const s = createState(5, MIRROR);
  // 같은 자리에 겹쳐 둔다 — 밀어내기가 자기 몸집을 알고 있어야 벌어진다
  const a = place(s, 0, 'devourer', 24000, 30000);
  const b = place(s, 0, 'devourer', 24100, 30000);
  const want = radiusOf(a) + radiusOf(b);
  for (let i = 0; i < 200; i++) step(s, []);
  const A = byId(s, a.id);
  const B = byId(s, b.id);
  const d = Math.hypot(A.x - B.x, A.y - B.y);
  // 밀어내기는 한 틱에 겹친 만큼만 미므로 완전히 딱 떨어지진 않는다 — 9할이면 벌어진 것이다
  assert.ok(d > want * 0.9, `대형 둘이 ${Math.round(d)}밖에 안 벌어졌다 (기대 ${want})`);
});

/* ── 전장의 안개 (대전 전용) ───────────────────────────────────────────── */

test('안개는 대전에만 걸린다 — 침공과 실험장은 전부 보인다', () => {
  assert.ok(sightCirclesOf(createState(5, MIRROR), 0), '대전에 안개가 없다');
  assert.equal(sightCirclesOf(createState(5, MIRROR, DEFAULT_MAP_ID, false, true), 0), null);
  assert.equal(sightCirclesOf(createState(5, MIRROR, DEFAULT_MAP_ID, true, false), 0), null);
});

test('시야 밖의 적 유닛은 보이지도, 타겟이 되지도 않는다', () => {
  const s = createState(5, MIRROR);
  // 서로 시야(8타일)의 두 배 넘게 떨어뜨린다
  const me = place(s, 0, 'rifleman', 24000, 32000);
  const foe = place(s, 1, 'rifleman', 24000, 32000 - SIGHT_UNIT * 2);
  step(s, []);
  assert.ok(isHiddenFrom(s, 0, foe), '시야 밖 적이 보인다');
  assert.notEqual(byId(s, me.id).target, foe.id, '시야 밖 적을 겨냥했다');
});

test('시야 안에 들어온 적은 보이고 타겟이 된다', () => {
  const s = createState(5, MIRROR);
  const me = place(s, 0, 'rifleman', 24000, 27000);
  const foe = place(s, 1, 'rifleman', 24000, 24000); // 3타일
  step(s, []);
  assert.ok(!isHiddenFrom(s, 0, foe), '코앞의 적이 안 보인다');
  assert.equal(byId(s, me.id).target, foe.id);
});

test('안개는 본진도 가린다 — 시야 밖이면 무엇이든 안 보인다', () => {
  const s = createState(5, MIRROR);
  s.players[1].minerals = BASE_BUILD_COST;
  const site = BASE_SITES.find((b) => b.id === 1);
  assert.ok(applyCommand(s, cmd(0, 1, 'base', '', site.x, site.y)), '확장이 세워지지 않았다');
  const expansion = s.entities.find((e) => e.kind === 'base' && e.team === 1 && !e.isMain);
  const foeMain = mainBase(s, 1);
  const myMain = mainBase(s, 0);

  // 내 본진에서 본다 — 상대 진영은 전부 시야 밖이다
  assert.ok(isHiddenFrom(s, 0, foeMain), '적 본진이 그대로 보인다 (4인용 맵의 전제가 깨진다)');
  assert.ok(isHiddenFrom(s, 0, expansion), '적 확장이 그대로 보인다');
  assert.ok(!isHiddenFrom(s, 0, myMain), '내 것이 가려졌다');
});

test('대전에서 명령 없는 병력은 스스로 걸어나가지 않는다', () => {
  const s = createState(5, MIRROR);
  const home = mainBase(s, 0);
  const me = place(s, 0, 'rifleman', home.x - 4000, home.y - 4000);
  const x0 = me.x;
  const y0 = me.y;
  for (let i = 0; i < 20 * TICK_RATE; i++) step(s, []);
  const m = byId(s, me.id);
  assert.ok(m, '유닛이 죽었다 — 전제가 깨졌다');
  assert.equal(m.x, x0, '명령도 표적도 없는데 움직였다');
  assert.equal(m.y, y0);
});

test('제자리를 지켜도 사거리 안의 적은 쏜다 — 안 걷는 것이지 안 싸우는 게 아니다', () => {
  const s = createState(5, MIRROR);
  const me = place(s, 0, 'rifleman', 24000, 27000);
  const foe = place(s, 1, 'gnawer', 24000, 25000); // 2타일
  const hp0 = foe.hp;
  for (let i = 0; i < 40; i++) step(s, []);
  const f = byId(s, foe.id);
  assert.ok(!f || f.hp < hp0, '코앞의 적을 쏘지 않았다');
});

test('침공 파도는 그대로 성으로 몰려온다', () => {
  const s = createState(5, MIRROR, DEFAULT_MAP_ID, false, true);
  // 벽 위에 놓으면 길찾기가 아니라 지형에 낀 것을 재게 된다
  let spot = null;
  for (let ty = 4; ty < 12 && !spot; ty++) {
    for (let tx = 10; tx < 38; tx++) {
      const x = tx * 1000 + 500;
      const y = ty * 1000 + 500;
      if (!blockedAt(x, y)) { spot = [x, y]; break; }
    }
  }
  assert.ok(spot, '맵 위쪽에 통행 가능한 자리가 없다');
  const wave = place(s, 1, 'gnawer', spot[0], spot[1]);
  const y0 = wave.y;
  for (let i = 0; i < 60; i++) step(s, []);
  const w = byId(s, wave.id);
  assert.ok(w, '파도 유닛이 죽었다 — 전제가 깨졌다');
  assert.ok(w.y > y0 + 1000, `파도가 전진하지 않았다 (${y0} → ${w.y})`);
});

/* ── 명령어 A · S · Y (오너 지시) ──────────────────────────────────────── */

test('공격 이동(A)은 길에서 만난 적에 붙고, 그냥 이동은 지나친다', () => {
  const run = (kind) => {
    const s = createState(5, MIRROR);
    const me = place(s, 0, 'rifleman', 24000, 34000);
    // 쏘지 않는 구조물을 길옆 3타일에 둔다 — 맞아 죽으면 무엇도 측정되지 않는다.
    // 피해량은 판별자가 될 수 없다: 그냥 이동도 지나가며 쏘기 때문이다.
    // 차이는 **발이 멈추는가**에 있다 (y가 목적지 쪽으로 얼마나 갔는가).
    place(s, 1, 'nest', 27000, 28000);
    assert.ok(applyCommand(s, cmd(0, 0, kind, String(me.id), 24000, 20000)));
    for (let i = 0; i < 200; i++) step(s, []);
    return byId(s, me.id).y;
  };
  const moved = run('move');
  const attacked = run('attack');

  assert.ok(moved < 30000, '그냥 이동이 목적지 쪽으로 나아가지 않았다 — 전제가 깨졌다');
  assert.ok(
    attacked > moved + 3000,
    `공격 이동이 붙어 싸우지 않고 지나쳤다 (이동 y=${moved}, 공격 y=${attacked})`,
  );
});

test('정지(S)는 가던 명령을 버리고 그 자리에 선다', () => {
  const s = createState(5, MIRROR);
  const me = place(s, 0, 'rifleman', 24000, 30000);
  assert.ok(applyCommand(s, cmd(0, 0, 'move', String(me.id), 24000, 16000)));
  for (let i = 0; i < 20; i++) step(s, []);
  const mid = byId(s, me.id);
  assert.ok(mid.y < 30000, '이동 명령을 받고도 안 움직였다 — 전제가 깨졌다');

  assert.ok(applyCommand(s, cmd(0, 0, 'stop', String(me.id))));
  const stopped = { x: byId(s, me.id).x, y: byId(s, me.id).y };
  for (let i = 0; i < 60; i++) step(s, []);
  const after = byId(s, me.id);
  assert.equal(after.x, stopped.x, '정지 명령을 받고도 계속 갔다');
  assert.equal(after.y, stopped.y);
  assert.equal(after.orderX, -1, '명령이 남아 있다');
  assert.equal(after.hold, 1);
});

test('정지한 유닛도 사거리 안의 적은 쏜다 — 정지는 "가지 마라"이지 "싸우지 마라"가 아니다', () => {
  const s = createState(5, MIRROR);
  const me = place(s, 0, 'rifleman', 24000, 27000);
  const foe = place(s, 1, 'gnawer', 24000, 25000); // 2타일 — 사거리 안
  applyCommand(s, cmd(0, 0, 'stop', String(me.id)));
  const hp0 = foe.hp;
  for (let i = 0; i < 40; i++) step(s, []);
  const f = byId(s, foe.id);
  assert.ok(!f || f.hp < hp0, '정지한 유닛이 코앞의 적을 쏘지 않았다');
});

test('새 이동·공격 명령은 정지를 푼다', () => {
  const s = createState(5, MIRROR);
  const me = place(s, 0, 'rifleman', 24000, 30000);
  applyCommand(s, cmd(0, 0, 'stop', String(me.id)));
  assert.equal(byId(s, me.id).hold, 1);
  applyCommand(s, cmd(0, 0, 'move', String(me.id), 24000, 26000));
  assert.equal(byId(s, me.id).hold, 0, '이동 명령이 정지를 풀지 않았다');
});

test('집결지(Y)는 대전에서 갓 생산된 유닛을 그리로 보낸다', () => {
  const s = createState(5, MIRROR);
  s.players[0].minerals = RICH;
  const home = mainBase(s, 0);
  const rx = home.x - 4000;
  const ry = home.y - 4000;
  assert.ok(applyCommand(s, cmd(0, 0, 'rally', '', rx, ry)), '대전에서 집결지가 거절됐다');

  const before = s.entities.length;
  assert.ok(applyCommand(s, cmd(0, 0, 'unit', 'rifleman', home.x, home.y - 1000)));
  const made = s.entities.slice(before);
  assert.ok(made.length > 0, '유닛이 생산되지 않았다');
  for (const e of made) {
    assert.equal(e.orderX, rx, '갓 나온 유닛이 집결지로 가지 않는다');
    assert.equal(e.orderY, ry);
  }
});

test('같은 자리에 집결지를 다시 찍으면 해제된다', () => {
  const s = createState(5, MIRROR);
  const home = mainBase(s, 0);
  applyCommand(s, cmd(0, 0, 'rally', '', home.x - 4000, home.y - 4000));
  assert.ok(s.players[0].rally);
  applyCommand(s, cmd(0, 0, 'rally', '', home.x - 4000, home.y - 4000));
  assert.equal(s.players[0].rally, null);
});

test('남의 유닛에는 공격 이동·정지 명령이 먹히지 않는다', () => {
  const s = createState(5, MIRROR);
  const foe = place(s, 1, 'rifleman', 24000, 24000);
  assert.equal(applyCommand(s, cmd(0, 0, 'attack', String(foe.id), 24000, 30000)), false);
  assert.equal(applyCommand(s, cmd(0, 0, 'stop', String(foe.id))), false);
  assert.equal(byId(s, foe.id).orderX, -1);
  assert.equal(byId(s, foe.id).hold, 0);
});

test('안개·새 명령이 섞여도 결정론은 그대로다', () => {
  const cmds = genCommands(4242, 900);
  // 같은 대본에 A·S·Y를 얹는다
  for (let t = 120; t < 900; t += 37) {
    cmds.push(cmd(t, t % 2, 'rally', '', 20000 + (t % 5000), 20000 + (t % 7000)));
  }
  const a = runMatch(11, 900, cmds);
  const b = runMatch(11, 900, cmds);
  assert.deepEqual(a.trace, b.trace, '같은 입력이 다른 궤적을 냈다');
});

/* ── 확장 건설 시간 (오너 지시: 1.5배) ─────────────────────────────────── */

test('확장 기지는 6초 뒤에 가동한다', () => {
  assert.equal(BASE_BUILD_TICKS, 6 * TICK_RATE);
  const s = createState(5, MIRROR);
  s.players[0].minerals = BASE_BUILD_COST;
  // 확장은 내 영토에서 이어져야 한다 — 팀 0 본진(42000,42000)에서 닿는 지점
  const site = BASE_SITES.find((b) => b.id === 5);
  assert.ok(siteReachable(s, 0, site), '고른 지점이 팀 0에서 닿지 않는다');
  assert.ok(applyCommand(s, cmd(0, 0, 'base', '', site.x, site.y)));
  const built = s.entities.find((e) => e.kind === 'base' && e.team === 0 && !e.isMain);

  for (let i = 0; i < BASE_BUILD_TICKS - 1; i++) step(s, []);
  assert.ok(byId(s, built.id).deploy > 0, '6초가 되기 전에 가동했다');
  step(s, []);
  assert.equal(byId(s, built.id).deploy, 0, '6초가 지나도 가동하지 않았다');
});

/* ── 안개 2차 규칙 (오너 지시: 교전 노출 · 고지 시야 · 정찰 기억) ───────── */

test('공격하면 안개 속이라도 내 자리가 드러난다', () => {
  const s = createState(5, MIRROR);
  const shooter = place(s, 0, 'rifleman', 24000, 26000);
  const target = place(s, 1, 'rifleman', 24000, 24000); // 2타일 — 사거리 안
  target.hp = 999999;
  target.maxHp = 999999;

  // 실제로 한 대 칠 때까지 돌린다 (쿨다운 때문에 첫 틱에 쏘지 않을 수 있다)
  let fired = false;
  for (let i = 0; i < 60 && !fired; i++) {
    step(s, []);
    const sh = byId(s, shooter.id);
    if (sh && sh.reveal >= s.tick) fired = true;
  }
  assert.ok(fired, '공격하고도 드러나지 않았다');

  // 시야 밖으로 물러나도 노출이 남은 동안은 보인다
  const sh = byId(s, shooter.id);
  sh.x = 4000;
  sh.y = 44000;
  assert.ok(!isHiddenFrom(s, 1, sh), '공격 직후인데 안 보인다');
});

test('노출은 시간이 지나면 풀린다', () => {
  const s = createState(5, MIRROR);
  const shooter = place(s, 0, 'rifleman', 24000, 26000);
  const target = place(s, 1, 'rifleman', 24000, 24000);
  target.hp = 999999;
  target.maxHp = 999999;
  for (let i = 0; i < 60; i++) step(s, []);

  const sh = byId(s, shooter.id);
  assert.ok(sh, '공격자가 죽었다 — 전제가 깨졌다');
  // 아무도 없는 구석으로 물려 노출이 갱신되지 않게 한다
  sh.x = 4000;
  sh.y = 44000;
  const target2 = byId(s, target.id);
  if (target2) {
    target2.x = 44000;
    target2.y = 4000;
  }
  for (let i = 0; i < 4 * TICK_RATE; i++) step(s, []);
  const sh2 = byId(s, shooter.id);
  assert.ok(sh2, '공격자가 사라졌다');
  assert.ok(isHiddenFrom(s, 1, sh2), '4초가 지나도 노출이 안 풀렸다');
});

test('고지에 선 쪽이 더 멀리 본다', () => {
  const s = createState(5, MIRROR);
  // 맵에서 고지/저지 타일을 하나씩 찾는다
  let high = null;
  let low = null;
  for (let ty = 4; ty < ARENA_W_TILES - 4 && (!high || !low); ty++) {
    for (let tx = 4; tx < ARENA_W_TILES - 4; tx++) {
      const x = tx * 1000 + 500;
      const y = ty * 1000 + 500;
      if (blockedAt(x, y)) continue;
      if (!high && elevAt(x, y) === 1) high = [x, y];
      if (!low && elevAt(x, y) === 0) low = [x, y];
    }
  }
  assert.ok(high && low, '맵에 고지 또는 저지가 없다');

  // 같은 거리에서, 고지→저지가 저지→고지보다 먼저 보인다
  const gap = 9000; // 기본 시야 8타일보다 조금 멀게
  const upper = () => {
    const t = createState(5, MIRROR);
    const w = place(t, 0, 'rifleman', high[0], high[1]);
    const o = place(t, 1, 'rifleman', high[0] + gap, high[1]);
    // 상대를 저지로 옮긴다 — x만 옮기면 고도가 안 바뀔 수 있어 실제 저지 좌표를 쓴다
    o.x = low[0];
    o.y = low[1];
    w.x = high[0];
    w.y = high[1];
    return { t, w, o };
  };
  const A = upper();
  const d = Math.hypot(A.w.x - A.o.x, A.w.y - A.o.y);
  step(A.t, []);
  const highSeesLow = !isHiddenFrom(A.t, 0, byId(A.t, A.o.id));

  const B = upper();
  // 시점을 뒤집는다 — 저지에 선 쪽이 고지의 적을 본다
  step(B.t, []);
  const lowSeesHigh = !isHiddenFrom(B.t, 1, byId(B.t, B.w.id));

  // 거리가 시야 근처일 때만 의미 있는 비교다
  if (d > 8000 * 0.7 && d < 8000 * 1.3) {
    assert.ok(
      highSeesLow || !lowSeesHigh,
      '저지가 고지를 보는데 고지는 저지를 못 본다 — 우위가 뒤집혔다',
    );
  }
  assert.equal(HIGH_GROUND_SIGHT_PCT > 0, true, '고지 시야 보정이 꺼져 있다');
});

test('한 번 정찰한 기지 자리는 계속 안다', () => {
  const s = createState(5, MIRROR);
  const foeMain = mainBase(s, 1);
  assert.ok(isHiddenFrom(s, 0, foeMain), '처음부터 적 본진이 보인다');
  assert.equal(s.players[0].scouted & (1 << foeMain.siteId), 0);

  // 정찰병을 적 본진 앞에 세운다
  // 적 본진은 고지 주머니에 있다 — 저지에서 올려다보면 시야가 30% 깎이므로
  // 넉넉히 붙인다 (그 규칙 자체는 아래 고지 테스트가 따로 본다)
  const scout = place(s, 0, 'scoutcar', foeMain.x + 2500, foeMain.y + 2500);
  step(s, []);
  assert.ok((s.players[0].scouted & (1 << foeMain.siteId)) !== 0, '봤는데 기록되지 않았다');
  assert.ok(!isHiddenFrom(s, 0, mainBase(s, 1)), '보고 있는데 안 보인다');

  // 정찰병이 사라져도 자리는 기억한다 — 기지는 움직이지 않으므로 거짓이 아니다
  const idx = s.entities.findIndex((e) => e.id === scout.id);
  s.entities.splice(idx, 1);
  step(s, []);
  assert.ok(!isHiddenFrom(s, 0, mainBase(s, 1)), '정찰한 기지 자리를 잊어버렸다');
});

test('정찰 기록은 해시에 들어간다 (리싱크가 이걸 놓치면 안 된다)', () => {
  const a = createState(7, MIRROR);
  const b = createState(7, MIRROR);
  step(a, []);
  step(b, []);
  assert.equal(hashState(a), hashState(b));
  a.players[0].scouted |= 1 << 3;
  assert.notEqual(hashState(a), hashState(b), 'scouted가 해시에 안 들어간다');
});

/* ── 몸집과 사거리의 관계 (라운드 50 — 근접이 표적에 못 닿던 버그) ─────── */

test('모든 유닛은 밀어내기 거리 너머까지 닿는다 — 근접이 허공을 치면 안 된다', () => {
  // 밀어내기는 두 몸집의 합만큼 떼어 놓는다. 닿는 거리가 그보다 짧으면
  // 그 짝은 **영원히 서로를 못 때린다** — 몸집을 키우면서 실제로 그랬다
  // (거대포식자 반경 1100 + 소총병 600 = 1700 떨어져 서는데 닿는 거리 1500).
  const fake = (id) => ({ kind: 'unit', unit: id, team: 0 });
  const fighters = UNIT_IDS.filter((id) => {
    const u = getUnit(id);
    return u.kind === 'unit' && u.range > 0;
  });
  for (const a of fighters) {
    for (const b of UNIT_IDS) {
      if (getUnit(b).kind !== 'unit') continue;
      const ea = fake(a);
      const eb = fake(b);
      const push = radiusOf(ea) + radiusOf(eb);
      const reach = reachOf(ea, eb, getUnit(a).range);
      assert.ok(
        reach > push,
        `${getUnit(a).name}가 ${getUnit(b).name}에 못 닿는다 (닿는 거리 ${reach} ≤ 밀어내기 ${push})`,
      );
    }
  }
});

test('같은 유닛끼리 대군으로 붙으면 어느 쪽도 이기지 않는다', () => {
  // 미러가 한쪽으로 기울면 자리나 순서에 이점이 있다는 뜻이고, 그러면
  // 결투 하네스의 모든 수치가 같이 기운다. 사거리 버그 시절 실제로 기울었다
  // 고도가 균일하고 통행 가능한 자리를 먼저 찾는다. 언덕에 걸치면 데미지가
  // 70%로 깎이고 시야가 ±30% 달라져, 유닛이 아니라 지형을 재게 된다
  let spot = null;
  for (let ty = 6; ty < ARENA_W_TILES - 12 && !spot; ty++) {
    for (let tx = 6; tx < ARENA_W_TILES - 8; tx++) {
      const e0 = elevAt(tx * 1000 + 500, ty * 1000 + 500);
      let ok = true;
      for (let y = ty; y < ty + 10 && ok; y++) {
        for (let x = tx; x < tx + 6; x++) {
          const px = x * 1000 + 500;
          const py = y * 1000 + 500;
          if (blockedAt(px, py) || elevAt(px, py) !== e0) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        spot = [tx * 1000 + 1500, ty * 1000 + 5000];
        break;
      }
    }
  }
  assert.ok(spot, '고도가 균일한 평지를 찾지 못했다');

  for (const id of ['zealot', 'rifleman', 'siegetank']) {
    const s = createState(9, MIRROR);
    const N = 6;
    for (let i = 0; i < N; i++) {
      place(s, 0, id, spot[0] + (i % 3) * 1600, spot[1] + 1600 + ((i / 3) | 0) * 1600);
      place(s, 1, id, spot[0] + (i % 3) * 1600, spot[1] - 1600 - ((i / 3) | 0) * 1600);
    }
    for (let t = 0; t < 1200; t++) {
      step(s, []);
      const a = s.entities.some((e) => e.kind === 'unit' && e.team === 0);
      const b = s.entities.some((e) => e.kind === 'unit' && e.team === 1);
      if (!a || !b) break;
    }
    const live = (t) => s.entities.filter((e) => e.kind === 'unit' && e.team === t).length;
    assert.equal(
      live(0),
      live(1),
      `${getUnit(id).name} 미러가 기울었다 (${live(0)} : ${live(1)}) — 자리나 순서에 이점이 있다`,
    );
  }
});

/* ── 공중의 지형 이점 (라운드 50, 오너 지시) ───────────────────────────── */

test('공중은 같은 사거리의 지상보다 멀리 본다 — 지형이 시야를 막지 못한다', () => {
  // 사격보행기(지상)와 부유선(공중)은 둘 다 대공 가능한 4코 유닛이다.
  // 같은 거리에 적을 두고, 공중 쪽이 먼저 본다
  const probe = (watcher) => {
    const s = createState(5, MIRROR);
    const w = place(s, 0, watcher, 24000, 30000);
    const foe = place(s, 1, 'rifleman', 24000, 30000 - 9500); // 9.5타일
    step(s, []);
    void w;
    return !isHiddenFrom(s, 0, byId(s, foe.id));
  };
  assert.equal(probe('skiff'), true, '공중이 9.5타일 밖을 못 본다');
  assert.equal(probe('strider'), false, '지상이 공중만큼 멀리 본다 — 이점이 없다');
});

test('충전 스킬은 유닛마다 다른 시간을 쓰고, 술사는 게이지를 채워 나온다', () => {
  const mystic = getUnit('mystic');
  assert.ok(mystic.chargeTicks, '술사에 유닛별 충전 시간이 없다');
  assert.ok(mystic.chargeStart > 0, '술사가 빈 게이지로 나온다 — 한 방을 못 쓴다');
  assert.ok(
    mystic.chargeStart < mystic.chargeTicks,
    '만충으로 나오면 붙자마자 한 무리를 지운다 (실측: 소총병 12기 즉사)',
  );
  // 실제로 생산 경로를 타면 게이지가 차 있어야 한다
  const s = createState(5, ['covenant', 'covenant']);
  s.players[0].minerals = RICH;
  s.players[0].unlocked = [...s.players[0].unlocked, 'mystic'].sort();
  const home = mainBase(s, 0);
  const before = s.entities.length;
  assert.ok(applyCommand(s, cmd(0, 0, 'unit', 'mystic', home.x, home.y - 1000)));
  const made = s.entities.slice(before);
  assert.ok(made.length > 0 && made[0].charge === mystic.chargeStart, '생산된 술사의 게이지가 비었다');
});

test('지상 전용 시전자의 주문도 지상만 때린다', () => {
  // 술사는 지상만 때리는데 그 주문(정신붕괴)만 공중을 때리면
  // "못 때리는 유닛이 때린다"가 된다
  assert.equal(getUnit('mystic').targets, 'ground');
  assert.equal(getUnit('mindbreak').targets, 'ground');
});
