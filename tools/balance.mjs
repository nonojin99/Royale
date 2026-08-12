/**
 * 헤드리스 자동 대전 — 밸런스·전략·정보 가치 실측 (M8.1 / 협의회 안건 C)
 *
 * 렌더러도 서버도 없이 시뮬만 돌린다. 시뮬이 순수하기 때문에 가능하다.
 *
 * 전략 봇 다섯:
 *   RUSH   — 일꾼·확장·테크 전부 생략, 최전방에 병력만 쏟는다
 *   GREED  — 일꾼→확장 우선, 병력은 남는 돈으로
 *   TECH   — 테크 최우선, 그다음 병력
 *   BAL    — 서버 연습봇과 같은 균형 우선순위 (정보를 안 보는 기준선)
 *   REACT  — 상대 상태를 **훔쳐보고** 대응을 바꾼다 (완전 정보의 화신)
 *            상대가 러시면 수비, 상대가 배를 불리면 러시, 그 외엔 BAL
 *
 * 두 실험:
 *   1. RUSH/GREED/TECH/BAL 총당전 매트릭스 — 전략 구조가 가위바위보인지
 *   2. REACT vs 고정 전략들 vs BAL vs 같은 상대 — **정보의 승률 가치**
 *      REACT와 BAL의 차이가 곧 "상대를 볼 수 있어서 얻는 승률"이다.
 *      이 값이 크면: 안개는 그 가치를 지운다 → 눈치 싸움이 복권이 된다
 *      이 값이 작으면: 안개를 넣어도 게임이 크게 무작위화되지 않는다
 *
 * 사용: pnpm balance            (전부)
 *       node tools/balance.mjs --seeds 8   (빠른 확인)
 */

import {
  BASE_BUILD_COST,
  BASE_SITES,
  DEPLOY_RADIUS,
  MINERAL_SCALE,
  WORKER_COST,
  baseCount,
  canDeployAt,
  canResearch,
  createRng,
  createState,
  getFaction,
  getUnit,
  isUnlocked,
  nextInt,
  occupiedSites,
  ownBasePositions,
  step,
  workerCapacity,
} from '../packages/shared/dist/index.js';

const args = process.argv.slice(2);
const SEEDS = Number(args[args.indexOf('--seeds') + 1] || 0) || 16;
const FACTIONS = ['steel', 'swarmhive', 'covenant'];
const DECIDE_EVERY = 24; // 서버 연습봇과 같은 간격
const MAX_TICKS = 20 * 60 * 5; // 5분 안전 상한 (연장 포함 사실상 안 걸림)

/* ── 전략 봇 ───────────────────────────────────────────────────────────── */

/** 상대 본진 좌표 — 전방이 어느 쪽인지 */
function enemyMain(team) {
  const site = BASE_SITES.find((b) => b.startFor === (team === 0 ? 1 : 0));
  return [site.x, site.y];
}

function armyCost(s, team) {
  let sum = 0;
  for (const e of s.entities) {
    if (e.team !== team || e.kind === 'base') continue;
    const u = getUnit(e.unit);
    sum += (u.cost * MINERAL_SCALE) / Math.max(1, u.count);
  }
  return sum;
}

/** 전방(적 본진 방향)으로 치우친 배치 좌표를 찾는다 */
function forwardSpot(s, team, rng) {
  const bases = ownBasePositions(s, team);
  if (!bases.length) return null;
  const [ex, ey] = enemyMain(team);
  // 적에게 가장 가까운 기지에서 적 방향으로 민다
  let front = bases[0];
  let best = Infinity;
  for (const b of bases) {
    const d = Math.abs(b[0] - ex) + Math.abs(b[1] - ey);
    if (d < best) {
      best = d;
      front = b;
    }
  }
  const dx = ex - front[0];
  const dy = ey - front[1];
  const len = Math.max(1, Math.abs(dx) + Math.abs(dy));
  for (let k = 8; k >= 3; k--) {
    const r = (DEPLOY_RADIUS * k) / 10;
    const x = front[0] + Math.trunc((dx / len) * r) + nextInt(rng, 600) - 300;
    const y = front[1] + Math.trunc((dy / len) * r) + nextInt(rng, 600) - 300;
    if (canDeployAt(x, y, bases)) return [x, y];
  }
  return [front[0], front[1]];
}

function trainWorker(s, team) {
  const me = s.players[team];
  if (me.minerals < WORKER_COST || me.workers >= workerCapacity(s, team)) return null;
  return { kind: 'worker', id: '', x: 0, y: 0 };
}

function expand(s, team, max = 4) {
  if (s.players[team].minerals < BASE_BUILD_COST) return null;
  if (baseCount(s, team) >= max) return null;
  const taken = occupiedSites(s);
  const [ex, ey] = enemyMain(team);
  // 자기 진영(적에서 먼 곳)부터
  const cands = BASE_SITES.filter((b) => !taken.has(b.id)).sort(
    (a, b) =>
      Math.abs(b.x - ex) + Math.abs(b.y - ey) - (Math.abs(a.x - ex) + Math.abs(a.y - ey)),
  );
  const site = cands[0];
  return site ? { kind: 'base', id: '', x: site.x, y: site.y } : null;
}

function research(s, team, spare = BASE_BUILD_COST, preferDefense = false) {
  const me = s.players[team];
  if (me.research) return null;
  const f = getFaction(me.faction);
  let best = null;
  let bestScore = Infinity;
  for (const node of f.tech) {
    if (!canResearch(me, node.unit)) continue;
    if (me.minerals < node.cost * MINERAL_SCALE + spare) continue;
    // 웅크림 원형은 방어 건물부터 — 포탑 없이 테크만 올리면 러시에 죽는다
    const isDef = getUnit(node.unit).kind === 'building';
    const score = node.cost + (preferDefense && !isDef ? 100 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = node.unit;
    }
  }
  return best ? { kind: 'tech', id: best, x: 0, y: 0 } : null;
}

/** wantCheap이면 싼 것(물량), 아니면 비싼 것(질). 건물은 buildDefense 전용 */
function produce(s, team, rng, { reserve = 0, cheap = false, defend = false } = {}) {
  const me = s.players[team];
  const bases = ownBasePositions(s, team);
  if (!bases.length) return null;
  let best = null;
  let bestCost = cheap ? Infinity : -1;
  for (const id of me.unlocked) {
    if (!isUnlocked(me, id)) continue;
    const u = getUnit(id);
    if (u.kind !== 'unit') continue; // 건물은 명시적 웅크림 채널로만
    if (me.minerals - reserve < u.cost * MINERAL_SCALE) continue;
    if (cheap ? u.cost < bestCost : u.cost > bestCost) {
      bestCost = u.cost;
      best = id;
    }
  }
  if (!best) return null;
  let spot;
  if (defend) {
    // 본진 곁에 깐다
    const main = bases[0];
    spot = [main[0] + nextInt(rng, 1200) - 600, main[1] + nextInt(rng, 1200) - 600];
    if (!canDeployAt(spot[0], spot[1], bases)) spot = main;
  } else {
    spot = forwardSpot(s, team, rng);
  }
  return spot ? { kind: 'unit', id: best, x: spot[0], y: spot[1] } : null;
}

/** 방어 건물(bulwark/spinetentacle/lightpylon 계열)을 본진 곁에 깐다 */
function buildDefense(s, team, rng, want = 2) {
  const me = s.players[team];
  let have = 0;
  for (const e of s.entities) if (e.team === team && e.kind === 'building') have++;
  if (have >= want) return null;
  let best = null;
  for (const id of me.unlocked) {
    const u = getUnit(id);
    if (u.kind !== 'building') continue;
    if (me.minerals < u.cost * MINERAL_SCALE) continue;
    if (u.targets === 'air') continue; // 러시는 지상으로 온다
    best = id;
  }
  if (!best) return null;
  const bases = ownBasePositions(s, team);
  const [ex, ey] = enemyMain(team);
  const main = bases[0];
  // 적 방향으로 약간 앞에 세운다 — 뒤에 세우면 러시가 기지부터 문다
  const dx = ex - main[0] > 0 ? 1 : -1;
  const dy = ey - main[1] > 0 ? 1 : -1;
  for (let k = 0; k < 5; k++) {
    const x = main[0] + dx * (800 + nextInt(rng, 800));
    const y = main[1] + dy * (800 + nextInt(rng, 800));
    if (canDeployAt(x, y, bases)) return { kind: 'unit', id: best, x, y };
  }
  return null;
}

/**
 * 주문 시전 — 해금돼 있고 살 수 있으면, 적 병력 뭉치 한가운데에 떨어뜨린다.
 * 적 병력이 적으면 아낀다 (주문은 광역이라 뭉친 상대에게만 값을 한다).
 */
function castSpell(s, team) {
  const me = s.players[team];
  let spell = null;
  for (const id of me.unlocked) {
    const u = getUnit(id);
    if (u.kind === 'spell' && me.minerals >= u.cost * MINERAL_SCALE) spell = id;
  }
  if (!spell) return null;
  const foe = team === 0 ? 1 : 0;
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const e of s.entities) {
    if (e.team !== foe || e.kind === 'base') continue;
    cx += e.x;
    cy += e.y;
    n++;
  }
  if (n < 5) return null; // 흩어진 소수에게 3코스트를 태울 이유가 없다
  return { kind: 'unit', id: spell, x: Math.trunc(cx / n), y: Math.trunc(cy / n) };
}

/**
 * observe: REACT만 쓴다. 완전 정보 — 상대 army/기지/테크가 다 보인다.
 * 안개 도입 = 이 함수가 반환하는 정보를 지우는 것과 같다.
 */
function observe(s, team) {
  const foe = team === 0 ? 1 : 0;
  return {
    foeArmy: armyCost(s, foe),
    myArmy: armyCost(s, team),
    foeBases: baseCount(s, foe),
    myBases: baseCount(s, team),
    foeTeching: s.players[foe].research !== null,
    foeWorkers: s.players[foe].workers,
    myWorkers: s.players[team].workers,
  };
}

const STRATS = {
  // 진짜 올인도 최소한의 경제는 깐다 — 일꾼 4기까지만 (기본 2기로는
  // 2코스트 유닛 하나에 8초가 걸려 러시 자체가 성립하지 않는다)
  RUSH: (s, team, rng) =>
    (s.players[team].workers < 6 ? trainWorker(s, team) : null) ??
    produce(s, team, rng, { cheap: true }),
  GREED: (s, team, rng) =>
    trainWorker(s, team) ??
    expand(s, team) ??
    produce(s, team, rng, { reserve: BASE_BUILD_COST }),
  // 테크의 원형: 포탑 뒤에서 웅크리고 테크 → T2가 나오면 밀고 나간다.
  // 영원히 웅크리면 기지 수 판정에서 자동으로 진다 — 웅크림은 수단이지 목표가 아니다
  TECH: (s, team, rng) => {
    const me = s.players[team];
    const f = getFaction(me.faction);
    const t2 = f.tech.some((n) => n.tier === 2 && me.unlocked.includes(n.unit));
    return (
      // 첫 포탑이 일꾼보다 먼저다 — 러시는 34초에 도착한다
      buildDefense(s, team, rng, 1) ??
      trainWorker(s, team) ??
      buildDefense(s, team, rng) ??
      research(s, team, 0, true) ??
      (t2 ? expand(s, team, 2) : null) ??
      castSpell(s, team) ??
      // T2 전에는 집(고지 주머니 — 올라오는 러시가 30% 깎인다), 이후엔 전진
      produce(s, team, rng, { reserve: 4 * MINERAL_SCALE, defend: !t2 })
    );
  },
  BAL: (s, team, rng) =>
    trainWorker(s, team) ??
    expand(s, team) ??
    research(s, team) ??
    castSpell(s, team) ??
    produce(s, team, rng, { reserve: 0 }),
  REACT: (s, team, rng) => {
    const o = observe(s, team);
    const early = s.tick < 20 * 75;
    // 일꾼 수 판독(올인 예고)도 실험했지만 대응 정책이 방어에 갇혀
    // 역효과였다 — 감지보다 "언제 반격으로 전환하나"가 어렵다 (라운드 4)
    if (early && o.foeArmy > o.myArmy + 4 * MINERAL_SCALE) {
      // 상대가 초반부터 병력을 쏟는다 → 포탑 + 수비 병력, 확장 중단.
      // 정보를 가진 대응이란 "맞는 방어를 제때 사는 것"이다
      return (
        buildDefense(s, team, rng) ??
        produce(s, team, rng, { defend: true }) ??
        trainWorker(s, team)
      );
    }
    if (o.foeBases > o.myBases || (o.foeTeching && o.foeArmy < o.myArmy)) {
      // 상대가 배를 불린다 → 지금 찌른다
      return produce(s, team, rng, { cheap: true }) ?? trainWorker(s, team);
    }
    return STRATS.BAL(s, team, rng);
  },
};

/* ── 경기 실행 ─────────────────────────────────────────────────────────── */

function playGame(stratA, stratB, faction, seed) {
  const s = createState(seed, [faction, faction]);
  const rngs = [createRng((seed ^ 0x1234abcd) >>> 0), createRng((seed ^ 0x9876fedc) >>> 0)];
  const strats = [STRATS[stratA], STRATS[stratB]];
  const last = [-999, -999];
  let firstBlood = -1;
  let firstExpand = -1;
  let prevUnits = 0;

  while (!s.over && s.tick < MAX_TICKS) {
    const cmds = [];
    for (const team of [0, 1]) {
      if (s.tick - last[team] < DECIDE_EVERY) continue;
      const mv = strats[team](s, team, rngs[team]);
      if (mv) {
        cmds.push({ execTick: s.tick, team, ...mv });
        last[team] = s.tick;
        if (mv.kind === 'base' && firstExpand < 0) firstExpand = s.tick;
      }
    }
    const units = s.entities.filter((e) => e.kind !== 'base').length;
    step(s, cmds);
    const unitsAfter = s.entities.filter((e) => e.kind !== 'base').length;
    if (firstBlood < 0 && unitsAfter < units + cmdsUnits(cmds)) firstBlood = s.tick;
    prevUnits = unitsAfter;
  }
  return { winner: s.winner, ticks: s.tick, firstBlood, firstExpand };
}

function cmdsUnits(cmds) {
  let n = 0;
  for (const c of cmds) if (c.kind === 'unit') n += getUnit(c.id).count;
  return n;
}

/** 양쪽 진영을 바꿔 두 판 — 자리 편향을 상쇄한다 */
function series(a, b, faction, seed) {
  const g1 = playGame(a, b, faction, seed);
  const g2 = playGame(b, a, faction, seed + 100000);
  let aw = 0;
  let bw = 0;
  if (g1.winner === 0) aw++;
  else if (g1.winner === 1) bw++;
  if (g2.winner === 1) aw++;
  else if (g2.winner === 0) bw++;
  return { aw, bw, games: [g1, g2] };
}

/* ── 단일 경기 추적 (--trace A B) ─────────────────────────────────────── */

if (args.includes('--trace')) {
  const i = args.indexOf('--trace');
  const [a, b] = [args[i + 1], args[i + 2]];
  const s = createState(7000, ['steel', 'steel']);
  const rngs = [createRng(0x11111111), createRng(0x22222222)];
  const strats = [STRATS[a], STRATS[b]];
  const last = [-999, -999];
  console.log(`\n${a}(팀0, 아래) vs ${b}(팀1, 위) — 10초마다 상태`);
  while (!s.over && s.tick < MAX_TICKS) {
    const cmds = [];
    for (const team of [0, 1]) {
      if (s.tick - last[team] >= DECIDE_EVERY) {
        const mv = strats[team](s, team, rngs[team]);
        if (mv) {
          cmds.push({ execTick: s.tick, team, ...mv });
          last[team] = s.tick;
        }
      }
    }
    step(s, cmds);
    if (s.tick % 200 === 0) {
      const line = [0, 1].map((t) => {
        const p = s.players[t];
        const bases = s.entities.filter((e) => e.kind === 'base' && e.team === t);
        const hp = bases.reduce((x, e) => x + Math.max(0, e.hp), 0);
        return `팀${t} 병력${Math.round(armyCost(s, t) / 1000)} 일꾼${p.workers} 기지${bases.length}(${hp})`;
      });
      console.log(`${String(s.tick / 20).padStart(3)}s  ${line.join('   ')}`);
    }
  }
  console.log(`승자: ${s.winner === -1 ? '무승부' : (s.winner === 0 ? a : b)} (${(s.tick / 20).toFixed(0)}초)`);
  process.exit(0);
}

/* ── 실험 ──────────────────────────────────────────────────────────────── */

const t0 = Date.now();
const fixed = ['RUSH', 'GREED', 'TECH'];
const metrics = { blood: [], expand: [], len: [] };

function record(g) {
  if (g.firstBlood > 0) metrics.blood.push(g.firstBlood / 20);
  if (g.firstExpand > 0) metrics.expand.push(g.firstExpand / 20);
  metrics.len.push(g.ticks / 20);
}

function runPair(a, b) {
  let aw = 0;
  let bw = 0;
  let n = 0;
  for (const faction of FACTIONS) {
    for (let i = 0; i < SEEDS; i++) {
      const r = series(a, b, faction, 7000 + i * 31);
      aw += r.aw;
      bw += r.bw;
      n += r.aw + r.bw;
      for (const g of r.games) record(g);
    }
  }
  return { aw, bw, n };
}

console.log(`시드 ${SEEDS} × 종족 3 × 진영 교대 2 = 짝당 ${SEEDS * 6}판\n`);

console.log('── 실험 1. 고정 전략 총당전 (가위바위보 구조인가) ──');
const matrix = {};
for (let i = 0; i < fixed.length; i++) {
  for (let j = i + 1; j < fixed.length; j++) {
    const r = runPair(fixed[i], fixed[j]);
    matrix[`${fixed[i]} vs ${fixed[j]}`] = r;
    console.log(
      `${fixed[i].padEnd(5)} vs ${fixed[j].padEnd(5)}  ${r.aw}:${r.bw}` +
        `  (${((100 * r.aw) / Math.max(1, r.n)).toFixed(0)}%)`,
    );
  }
}

console.log('\n── 실험 2. 정보의 승률 가치 (REACT=훔쳐봄, BAL=안 봄) ──');
let reactW = 0;
let reactN = 0;
let balW = 0;
let balN = 0;
for (const foe of fixed) {
  const r1 = runPair('REACT', foe);
  reactW += r1.aw;
  reactN += r1.n;
  const r2 = runPair('BAL', foe);
  balW += r2.aw;
  balN += r2.n;
  console.log(
    `vs ${foe.padEnd(5)}  REACT ${r1.aw}:${r1.bw} (${((100 * r1.aw) / Math.max(1, r1.n)).toFixed(0)}%)` +
      `   BAL ${r2.aw}:${r2.bw} (${((100 * r2.aw) / Math.max(1, r2.n)).toFixed(0)}%)`,
  );
}
const reactPct = (100 * reactW) / Math.max(1, reactN);
const balPct = (100 * balW) / Math.max(1, balN);
console.log(
  `\n종합: REACT ${reactPct.toFixed(1)}% vs BAL ${balPct.toFixed(1)}%` +
    ` → 정보의 승률 가치 ≈ ${(reactPct - balPct).toFixed(1)}%p`,
);

const med = (a) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
console.log('\n── 경기 지표 (중앙값) ──');
console.log(`첫 교전   ${med(metrics.blood).toFixed(1)}초`);
console.log(`첫 확장   ${med(metrics.expand).toFixed(1)}초`);
console.log(`경기 길이 ${med(metrics.len).toFixed(1)}초`);
console.log(`\n${metrics.len.length}판, ${((Date.now() - t0) / 1000).toFixed(1)}s 소요`);
