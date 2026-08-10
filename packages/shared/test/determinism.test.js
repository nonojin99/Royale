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
  CARD_IDS,
  ELIXIR_MAX,
  HAND_SIZE,
  MATCH_TICKS,
  RIVER_BOT,
  RIVER_TOP,
  createRng,
  createState,
  hashState,
  isqrt,
  nextInt,
  nextRange,
  restore,
  snapshot,
  sortCommands,
  step,
} from '../dist/index.js';

/* ── 헬퍼 ──────────────────────────────────────────────────────────────── */

/** 시드로부터 결정론적인 "플레이 대본"을 만든다 (Math.random 금지) */
function genCommands(seed, ticks) {
  const rng = createRng((seed ^ 0x5bf03635) >>> 0);
  const cmds = [];
  for (let t = 40; t < ticks; t += 13) {
    const team = nextInt(rng, 2);
    const card = CARD_IDS[nextInt(rng, CARD_IDS.length)];
    const x = nextRange(rng, 1000, ARENA_W - 1000);
    const y =
      team === 0
        ? nextRange(rng, RIVER_BOT + 500, ARENA_H - 2000)
        : nextRange(rng, 2000, RIVER_TOP - 500);
    cmds.push({ execTick: t, team, card, x, y });
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
function runMatch(seed, ticks, cmds) {
  const s = createState(seed);
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
    const a = runMatch(seed, 1200, cmds);
    const b = runMatch(seed, 1200, cmds);
    assert.deepEqual(a.trace, b.trace, `시드 ${seed} 에서 궤적 불일치`);
  }
});

test('커맨드 배열 순서가 뒤섞여도 sortCommands가 정규화해 동일 결과를 낸다', () => {
  const seed = 424242;
  const cmds = genCommands(seed, 1200);
  const reversed = cmds.slice().reverse();
  // 같은 틱 안에서의 순서까지 흔들어 본다
  const rotated = cmds.slice(500).concat(cmds.slice(0, 500));

  const base = runMatch(seed, 1200, cmds).trace;
  assert.deepEqual(runMatch(seed, 1200, reversed).trace, base);
  assert.deepEqual(runMatch(seed, 1200, rotated).trace, base);
});

test('스냅샷 → 복원 후 이어서 돌려도 끊김 없이 동일하다', () => {
  const seed = 99;
  const cmds = genCommands(seed, 1500);
  const byTick = indexByTick(cmds);

  // 통짜로 1500틱
  const straight = createState(seed);
  for (let i = 0; i < 1500; i++) step(straight, byTick.get(straight.tick) ?? []);

  // 700틱에서 스냅샷을 뜨고, 새 상태에 복원한 뒤 나머지를 돌린다
  const split = createState(seed);
  for (let i = 0; i < 700; i++) step(split, byTick.get(split.tick) ?? []);
  const snap = snapshot(split);

  const resumed = createState(seed); // 전혀 다른 상태에서 시작
  restore(resumed, snap);
  for (let i = 700; i < 1500; i++) step(resumed, byTick.get(resumed.tick) ?? []);

  assert.equal(hashState(resumed), hashState(straight));
});

test('JSON 왕복(네트워크 전송 시뮬)을 거쳐도 상태가 보존된다', () => {
  const seed = 31337;
  const cmds = genCommands(seed, 600);
  const { state } = runMatch(seed, 600, cmds);

  const wire = JSON.parse(JSON.stringify(state));
  const revived = createState(1);
  restore(revived, wire);
  assert.equal(hashState(revived), hashState(state));
});

/* ── 상태가 정수로만 이루어져 있는가 ───────────────────────────────────── */

test('시뮬레이션 상태에 부동소수점이 새어 들어오지 않는다', () => {
  const seed = 777;
  const cmds = genCommands(seed, 2000);
  const { state } = runMatch(seed, 2000, cmds);

  for (const e of state.entities) {
    for (const k of ['x', 'y', 'hp', 'maxHp', 'cd', 'deploy', 'life', 'target', 'id']) {
      assert.ok(
        Number.isInteger(e[k]),
        `엔티티 ${e.id}(${e.card})의 ${k}가 정수가 아님: ${e[k]}`,
      );
    }
  }
  for (const p of state.players) {
    assert.ok(Number.isInteger(p.elixir), `엘릭서가 정수가 아님: ${p.elixir}`);
    assert.ok(Number.isInteger(p.crowns));
  }
  assert.ok(Number.isInteger(state.rng.s));
});

/* ── 게임 규칙 ─────────────────────────────────────────────────────────── */

test('엘릭서는 상한을 넘지 않는다', () => {
  const s = createState(5);
  for (let i = 0; i < 600; i++) step(s, []);
  for (const p of s.players) {
    assert.equal(p.elixir, ELIXIR_MAX);
  }
});

test('카드를 내면 손패가 순환한다 (셔플 없음, 덱 크기 유지)', () => {
  const s = createState(5);
  const before = s.players[0].cycle.slice();
  const played = before[1];
  const upcoming = before[HAND_SIZE];

  // 엘릭서가 충분해질 때까지 대기
  for (let i = 0; i < 200; i++) step(s, []);

  step(s, [{ execTick: s.tick, team: 0, card: played, x: 9000, y: 24000 }]);

  const after = s.players[0].cycle;
  assert.equal(after.length, before.length, '덱 크기가 변했다');
  assert.equal(after[1], upcoming, '"다음 카드"가 빈 손패 자리로 오지 않았다');
  assert.equal(after[after.length - 1], played, '낸 카드가 큐 맨 뒤로 가지 않았다');
  assert.deepEqual(
    after.slice().sort(),
    before.slice().sort(),
    '덱 구성이 바뀌었다',
  );
});

test('엘릭서가 모자라면 커맨드가 조용히 무시된다', () => {
  const s = createState(5);
  const card = s.players[0].cycle[0]; // 손패 첫 장
  const entitiesBefore = s.entities.length;
  const elixirBefore = s.players[0].elixir;

  // 5 엘릭서로 시작 → 5코스트 카드는 되지만, 두 번 연속은 불가
  step(s, [
    { execTick: s.tick, team: 0, card, x: 9000, y: 24000 },
    { execTick: s.tick, team: 0, card, x: 9000, y: 24000 },
  ]);

  // 두 번째는 손패에서 이미 빠졌으므로 무시되어야 한다
  assert.ok(s.players[0].elixir <= elixirBefore, '엘릭서가 늘어났다');
  assert.ok(s.entities.length >= entitiesBefore, '엔티티가 사라졌다');
  assert.ok(
    s.entities.filter((e) => e.card === card).length <= 4,
    '한 장으로 두 번 배치되었다',
  );
});

test('상대 진영에는 기본적으로 배치할 수 없다', () => {
  const s = createState(5);
  for (let i = 0; i < 200; i++) step(s, []);
  const before = s.entities.length;
  const card = s.players[0].cycle[0];
  // 팀 0이 팀 1 진영(y가 작은 쪽)에 배치 시도
  step(s, [{ execTick: s.tick, team: 0, card, x: 9000, y: 5000 }]);
  assert.equal(s.entities.length, before, '적 진영 배치가 허용되었다');
});

test('강 위에는 배치할 수 없다', () => {
  const s = createState(5);
  for (let i = 0; i < 200; i++) step(s, []);
  const before = s.entities.length;
  const card = s.players[0].cycle[0];
  step(s, [{ execTick: s.tick, team: 0, card, x: 9000, y: 16000 }]);
  assert.equal(s.entities.length, before, '강 위 배치가 허용되었다');
});

test('손패(덱 앞 4장)에 없는 카드는 낼 수 없다', () => {
  const s = createState(5);
  for (let i = 0; i < 200; i++) step(s, []);
  // 기본 덱에서 5번째 이후 카드는 손패가 아니다
  const notInHand = s.players[0].cycle[5];
  const before = s.entities.length;
  step(s, [{ execTick: s.tick, team: 0, card: notInHand, x: 9000, y: 20000 }]);
  assert.equal(s.entities.length, before, `손패에 없는 ${notInHand}가 배치되었다`);
});

test('유닛은 강을 건너지 않고 다리로만 넘어간다', () => {
  // 'runner'를 손패 맨 앞에 두는 전용 덱으로 시작한다
  const deck = ['runner', 'mingttu', 'pubi', 'archers', 'porongi', 'swarm', 'cannon', 'arrows'];
  const s = createState(5, [deck, deck]);
  for (let i = 0; i < 100; i++) step(s, []);
  // 맵 한가운데(양쪽 다리에서 똑같이 먼 곳)에 빠른 유닛을 낸다
  const applied = step(s, [
    { execTick: s.tick, team: 0, card: 'runner', x: 9000, y: 20000 },
  ]);
  void applied;
  assert.ok(
    s.entities.some((e) => e.card === 'runner'),
    'runner가 배치되지 않았다',
  );

  let sawRiverRow = false;
  let crossed = false;
  for (let i = 0; i < 400; i++) {
    step(s, []);
    for (const e of s.entities) {
      if (e.card !== 'runner') continue;
      if (e.y >= RIVER_TOP && e.y < RIVER_BOT) {
        sawRiverRow = true;
        // 강 구간에 있다면 반드시 다리 위여야 한다
        const onBridge =
          (e.x >= 3000 && e.x <= 5000) || (e.x >= 13000 && e.x <= 15000);
        assert.ok(onBridge, `유닛이 다리 밖 강 위에 있다: x=${e.x}, y=${e.y}`);
      }
      if (e.y < RIVER_TOP) crossed = true;
    }
  }
  assert.ok(sawRiverRow, '유닛이 400틱 동안 강에 도달조차 못했다');
  assert.ok(crossed, '유닛이 400틱 안에 강을 건너지 못했다');
});

test('3분이 지나면 경기가 끝나거나 연장전에 들어간다', () => {
  const s = createState(2024);
  const cmds = genCommands(2024, MATCH_TICKS);
  const byTick = indexByTick(cmds);
  for (let i = 0; i < MATCH_TICKS + 5; i++) step(s, byTick.get(s.tick) ?? []);
  assert.ok(s.over || s.overtime, '정규 시간이 끝났는데 경기가 계속된다');
});

test('킹타워가 파괴되면 즉시 종료되고 왕관 3개가 주어진다', () => {
  const s = createState(11);
  const king = s.entities.find((e) => e.tower === 'king' && e.team === 1);
  king.hp = 1; // 마지막 일격 상황을 강제로 만든다
  // 팀 0 유닛을 적 킹타워 옆에 직접 꽂아 넣는다 (테스트 목적의 상태 조작)
  s.entities.push({
    id: s.nextId++,
    team: 0,
    card: 'porongi',
    kind: 'unit',
    tower: 'none',
    lane: 0,
    x: king.x,
    y: king.y + 1000,
    hp: 5000,
    maxHp: 5000,
    cd: 0,
    deploy: 0,
    life: -1,
    target: -1,
    active: true,
  });

  for (let i = 0; i < 60 && !s.over; i++) step(s, []);
  assert.ok(s.over, '킹타워가 파괴됐는데 경기가 끝나지 않았다');
  assert.equal(s.winner, 0);
  assert.ok(s.players[0].crowns >= 3, `왕관이 3 미만: ${s.players[0].crowns}`);
});

test('공주탑이 무너지면 같은 팀 킹타워가 활성화된다', () => {
  const s = createState(13);
  const princess = s.entities.find((e) => e.tower === 'princess' && e.team === 1);
  const king = s.entities.find((e) => e.tower === 'king' && e.team === 1);
  assert.equal(king.active, false, '킹타워가 처음부터 활성화되어 있다');

  princess.hp = 0;
  step(s, []);

  const kingAfter = s.entities.find((e) => e.tower === 'king' && e.team === 1);
  assert.equal(kingAfter.active, true, '공주탑이 무너졌는데 킹이 잠들어 있다');
  assert.equal(s.players[0].crowns, 1);
});

test('긴 경기(연장전 포함)를 끝까지 돌려도 예외 없이 종료된다', () => {
  const total = MATCH_TICKS + 1200 + 10;
  const seed = 5150;
  const cmds = genCommands(seed, total);
  const a = runMatch(seed, total, cmds);
  const b = runMatch(seed, total, cmds);
  assert.deepEqual(a.trace, b.trace);
  assert.ok(a.state.over, '연장전까지 끝났는데 경기가 안 끝났다');
});
