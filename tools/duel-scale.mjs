/**
 * 유닛 결투 — **규모별** 가치 대비 밸런스 (오너 지시).
 *
 * `duel-matrix.mjs`는 등코스트 한 판(예산 8코)만 본다. 그런데 이 게임에서
 * 유닛의 값어치는 **머릿수에 따라 달라진다**: 광역기는 뭉칠수록 값이 뛰고,
 * 긴 사거리는 뒷줄이 생겨야 값을 하며, 단일 대상 근접은 수가 늘어도 선형에
 * 그친다. 1:1만 재고 밸런스를 잡으면 후반 대군 교전이 통째로 어긋난다.
 *
 * 그래서 같은 짝을 1 · 3 · 9마리로 세 번 붙인다.
 *
 * ── 읽는 법 ────────────────────────────────────────────────────────────
 * **우세도** = (상대가 잃은 가치 − 내가 잃은 가치) ÷ (양쪽이 잃은 가치 합)
 *   +1.00  상대만 전멸시키고 나는 무손실
 *    0.00  주고받은 가치가 같다 (대등)
 *   −1.00  나만 갈렸다
 *
 * 가치는 **마리당 코스트**(cost ÷ count)로 잰다. 소총병 카드 하나가 3마리를
 * 주므로 소총병 한 마리는 1코, 공성전차 한 마리는 5코다. "3마리 대 3마리"는
 * 머릿수가 같을 뿐 값이 같지 않고, 우세도는 그 값 차이를 이미 반영한다.
 *
 * ── 방법에 관하여 ──────────────────────────────────────────────────────
 * `duel-matrix.mjs`가 라운드 20에서 얻은 두 교훈을 그대로 지킨다:
 *   1. 스폰은 성공을 단언한다 (벽 위 스폰 = 조용한 전승 허상)
 *   2. 결투장은 양 본진에서 멀다
 * 여기에 하나를 더한다:
 *   3. 결투장은 **고도가 균일**해야 한다. 언덕은 데미지를 70%로 깎고 시야를
 *      ±30% 바꾸므로, 한쪽이 고지에 서면 유닛이 아니라 지형을 재게 된다.
 *
 * 사용: node tools/duel-scale.mjs [--scales 1,3,9] [--pair rifleman,gnawer]
 */
import {
  ARENA_H_TILES,
  ARENA_W_TILES,
  BASE_SITES,
  FACTION_IDS,
  blockedAt,
  createState,
  elevAt,
  getFaction,
  getUnit,
  step,
} from '../packages/shared/dist/index.js';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const SCALES = (argOf('--scales') ?? '1,3,9').split(',').map(Number);
const ONLY_PAIR = argOf('--pair')?.split(',') ?? null;

/** 한 마리의 값 — 카드 하나가 여러 마리를 주므로 코스트를 머릿수로 나눈다 */
const unitValue = (id) => {
  const u = getUnit(id);
  return u.cost / Math.max(1, u.count);
};

/* ── 결투장 ────────────────────────────────────────────────────────────── */

/**
 * 고도가 균일하고 통행 가능한 평지를 찾는다. 양 본진에서 15타일 이상.
 *
 * 하드코딩하지 않는 이유: 맵이 바뀌면 좌표가 거짓말이 된다. 조건을 적어 두면
 * 맵이 바뀌어도 도구가 스스로 다시 찾는다.
 */
function findArena() {
  const far = (cx, cy) => BASE_SITES.every((b) => Math.hypot(b.x - cx, b.y - cy) > 15000);
  const flat = (tx, ty, e0) => {
    const px = tx * 1000 + 500;
    const py = ty * 1000 + 500;
    return !blockedAt(px, py) && elevAt(px, py) === e0;
  };
  let best = null;
  for (let ty = 1; ty < ARENA_H_TILES - 1; ty++) {
    for (let tx = 1; tx < ARENA_W_TILES - 1; tx++) {
      const e0 = elevAt(tx * 1000 + 500, ty * 1000 + 500);
      if (!flat(tx, ty, e0)) continue;
      for (let h = 6; h < 24; h++) {
        for (let w = 5; w < 20; w++) {
          if (tx + w >= ARENA_W_TILES || ty + h >= ARENA_H_TILES) continue;
          let good = true;
          for (let y = ty; y < ty + h && good; y++) {
            for (let x = tx; x < tx + w; x++) {
              if (!flat(x, y, e0)) {
                good = false;
                break;
              }
            }
          }
          if (!good) continue;
          const cx = (tx + w / 2) * 1000;
          const cy = (ty + h / 2) * 1000;
          if (!far(cx, cy)) continue;
          if (!best || w * h > best.w * best.h) best = { cx, cy, w, h };
        }
      }
    }
  }
  if (!best) throw new Error('평지 결투장을 찾지 못했다 — 맵이 바뀌었으면 조건을 다시 보라');
  return best;
}

const ARENA = findArena();

/*
 * 대형 — **평지가 허락하는 만큼만** 세운다.
 *
 * 넘치면 스폰이 평지 밖으로 나가고, 그건 라운드 20이 겪은 "벽 위 스폰 =
 * 조용한 전승 허상"과 같은 오염이다. 그래서 수용 인원을 지형에서 역산하고,
 * 예산이 그보다 많은 마리를 사더라도 여기서 잘린다.
 */
const GAP = 1500; // 몸집(대형 반경 1.1타일)이 서로를 밀어내지 않는 간격
const FRONT = 1300; // 앞줄끼리 2.6타일 — 획득 범위(5.5타일) 안이다
const COLS = Math.max(1, Math.floor(((ARENA.w - 1) * 1000) / GAP));
const ROWS = Math.max(1, Math.floor((((ARENA.h / 2 - 1) * 1000 - FRONT) / GAP) + 1));
const CAPACITY = COLS * ROWS;

/** 결투 한 판. n마리씩 마주 세우고 결판이 날 때까지 돌린다 */
function duel(aId, bId, n, seed = 7, nB = n) {
  // 실험장 모드 — 승패 판정이 없고, 표적 없는 유닛이 서로에게 전진한다
  const s = createState(seed, ['steel', 'steel'], 'coast', true);
  // 기지는 사거리와 시야를 가진 참가자다. 결투에서는 치운다
  s.entities.length = 0;

  const put = (team, id, count) => {
    const u = getUnit(id);
    for (let i = 0; i < count; i++) {
      const col = i % COLS;
      const row = (i / COLS) | 0;
      const x = ARENA.cx + (col - (COLS - 1) / 2) * GAP;
      const dy = FRONT + row * GAP;
      const y = team === 0 ? ARENA.cy + dy : ARENA.cy - dy;
      if (blockedAt(x, y)) throw new Error(`결투장 밖에 스폰: ${id} (${x},${y})`);
      s.entities.push({
        id: s.nextId++,
        team,
        unit: id,
        kind: 'unit',
        x,
        y,
        hp: u.hp,
        maxHp: u.hp,
        cd: 0,
        deploy: 0,
        life: -1,
        target: -1,
        flying: u.flying,
        charge: 0,
        mode: 0,
        haste: 0,
        orderX: -1,
        orderY: -1,
        orderAttack: 0,
        hold: 0,
        reveal: -1,
        siteId: -1,
        isMain: false,
        reserve: 0,
      });
    }
  };
  put(0, aId, n);
  put(1, bId, nB);

  const startA = n * unitValue(aId);
  const startB = nB * unitValue(bId);

  let ticks = 0;
  for (; ticks < 1800; ticks++) {
    step(s, []);
    const liveA = s.entities.some((e) => e.kind === 'unit' && e.team === 0);
    const liveB = s.entities.some((e) => e.kind === 'unit' && e.team === 1);
    if (!liveA || !liveB) break;
  }

  const left = (team) =>
    s.entities
      .filter((e) => e.kind === 'unit' && e.team === team)
      .reduce((sum, e) => sum + unitValue(e.unit), 0);
  const lostA = startA - left(0);
  const lostB = startB - left(1);
  const total = lostA + lostB;

  return {
    // 우세도: 주고받은 가치의 균형. 아무도 안 죽었으면 교전 불가다
    edge: total > 0 ? (lostB - lostA) / total : null,
    lostA,
    lostB,
    ticks,
  };
}

/* ── 명단 ──────────────────────────────────────────────────────────────── */

// 대전에 실제로 나오는 유닛만 — 종족 트리의 kind='unit'. 영웅·새끼·지뢰는
// 침공 전용이거나 카드가 없어 대전 밸런스와 무관하다
const ROSTER = [];
for (const f of FACTION_IDS) {
  for (const node of getFaction(f).tech) {
    const u = getUnit(node.unit);
    if (u.kind !== 'unit') continue;
    if (!ROSTER.includes(node.unit)) ROSTER.push(node.unit);
  }
}

/**
 * A가 B를 때릴 수 있는가 — 시뮬의 canAttack과 같은 규칙.
 *
 * 못 때리는 짝은 **밸런스가 아니라 설계**다. 정찰차·굴착충은 건물만 치는
 * 공성 유닛이고, 지상 전용은 공중을 못 때린다. 이걸 평균에 섞으면 "정찰차
 * 우세도 -1.00"처럼 역할을 결함으로 읽게 된다.
 */
function canHit(aId, bId) {
  const a = getUnit(aId);
  const b = getUnit(bId);
  if (a.targets === 'buildings') return false;
  if (a.targets === 'ground') return !b.flying;
  if (a.targets === 'air') return !!b.flying;
  return true;
}

/** 서로 주고받을 수 있는 짝인가 — 한쪽만 때리는 것도 구조적 상성이다 */
const mutual = (a, b) => canHit(a, b) && canHit(b, a);

const nameOf = (id) => getUnit(id).name;
const pad = (str, n) => {
  // 한글은 폭이 2다 — 표가 어긋나지 않게 실제 폭으로 센다
  let w = 0;
  for (const ch of str) w += ch.charCodeAt(0) > 0x2000 ? 2 : 1;
  return str + ' '.repeat(Math.max(0, n - w));
};
const fmt = (v) => (v === null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(2));

/* ── 1. 미러 검증 ──────────────────────────────────────────────────────── */

function mirrorCheck() {
  console.log('── 1. 미러 검증 (A vs A) — 규모마다 대등해야 한다 ──');
  const bad = [];
  for (const id of ROSTER) {
    const row = SCALES.map((n) => duel(id, id, n).edge);
    const worst = Math.max(...row.map((v) => Math.abs(v ?? 0)));
    if (worst > 0.15) bad.push([id, row, worst]);
  }
  if (bad.length === 0) {
    console.log(`  ${ROSTER.length}유닛 × ${SCALES.length}규모 전부 대등 (|우세도| ≤ 0.15)\n`);
    return;
  }
  console.log('  ⚠️ 같은 유닛끼리 붙었는데 한쪽이 이긴다 — 자리 이점이나 순서 의존이다');
  for (const [id, row, worst] of bad) {
    console.log(`  ${pad(nameOf(id), 12)} ${row.map(fmt).join('  ')}   최대 ${worst.toFixed(2)}`);
  }
  console.log('');
}

/* ── 2. 규모별 종합 ────────────────────────────────────────────────────── */

function scaleTable() {
  console.log('── 2. 규모별 종합 우세도 (전 상대 평균) ──');
  console.log(`  ${pad('유닛', 12)} ${pad('마리당', 7)} ${SCALES.map((n) => pad(`${n}마리`, 8)).join('')} 1→9 변화`);

  let rows = [];
  for (const a of ROSTER) {
    const byScale = SCALES.map((n) => {
      const vals = [];
      for (const b of ROSTER) {
        if (a === b || !mutual(a, b)) continue; // 구조적 상성은 따로 본다
        const r = duel(a, b, n);
        if (r.edge !== null) vals.push(r.edge);
      }
      return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    });
    const first = byScale[0];
    const last = byScale[byScale.length - 1];
    rows.push({ a, byScale, drift: first !== null && last !== null ? last - first : null });
  }

  const structural = ROSTER.filter((id) => getUnit(id).targets === 'buildings');
  rows = rows.filter((r) => getUnit(r.a).targets !== 'buildings');
  rows.sort((x, y) => (y.byScale[y.byScale.length - 1] ?? -9) - (x.byScale[x.byScale.length - 1] ?? -9));
  for (const { a, byScale, drift } of rows) {
    const flag =
      drift === null ? '' : drift > 0.25 ? '  ↑ 뭉칠수록 강해짐' : drift < -0.25 ? '  ↓ 뭉칠수록 약해짐' : '';
    console.log(
      `  ${pad(nameOf(a), 12)} ${pad(unitValue(a).toFixed(2) + '코', 7)} ` +
        `${byScale.map((v) => pad(fmt(v), 8)).join('')} ${drift === null ? '—' : fmt(drift)}${flag}`,
    );
  }
  // 공중 유닛에 대한 경고 — 이 표는 그들의 **최악**만 잰다
  const air = ROSTER.filter((id) => getUnit(id).flying);
  if (air.length) {
    const lines = air.map((id) => {
      const safe = ROSTER.filter((b) => b !== id && !canHit(b, id)).length;
      return `${nameOf(id)}(${safe}유닛이 못 때림)`;
    });
    console.log(
      `\n  ⚠️ 공중은 이 표에서 과소평가된다 — 서로 때릴 수 있는 짝만 재므로\n` +
        `     "절반이 나를 못 때린다"는 값어치가 통째로 빠진다: ${lines.join(' · ')}`,
    );
  }
  if (structural.length) {
    console.log(
      `\n  (표에서 뺌) 건물 전용: ${structural.map(nameOf).join(' · ')}` +
        ' — 유닛을 아예 못 때린다. 대인 결투로는 잴 수 없는 역할이다',
    );
  }
  console.log('');
  return rows;
}

/* ── 2b. 예산별 종합 (등코스트) ─────────────────────────────────────────── */

/**
 * 같은 **값**을 붙인다 — 이게 "가치 대비 밸런스"의 본 검사다.
 *
 * 머릿수를 맞추면 싼 유닛이 반드시 진다: 물어뜯는것 9마리(4.5코)와
 * 공성전차 9대(45코)는 애초에 같은 저울이 아니다. 예산을 맞추면
 * "같은 돈으로 무엇을 사는 게 이득인가"를 묻게 된다 — 실제 결정과 같은 질문이다.
 */
const BUDGETS = (argOf('--budgets') ?? '4,8,12').split(',').map(Number);
const countFor = (id, budget) =>
  Math.min(CAPACITY, Math.max(1, Math.floor(budget / unitValue(id))));

function budgetTable() {
  console.log('── 2b. 예산별 종합 우세도 (같은 코스트로 살 수 있는 만큼) ──');
  console.log(
    `  ${pad('유닛', 12)} ${pad('마리당', 7)} ` +
      `${BUDGETS.map((b) => pad(`${b}코`, 9)).join('')} 소→대 변화`,
  );

  const rows = [];
  for (const a of ROSTER) {
    if (getUnit(a).targets === 'buildings') continue;
    const byBudget = BUDGETS.map((budget) => {
      const vals = [];
      for (const b of ROSTER) {
        if (a === b || !mutual(a, b)) continue;
        const r = duel(a, b, countFor(a, budget), 7, countFor(b, budget));
        if (r.edge !== null) vals.push(r.edge);
      }
      return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    });
    const first = byBudget[0];
    const last = byBudget[byBudget.length - 1];
    rows.push({ a, byBudget, drift: first !== null && last !== null ? last - first : null });
  }
  rows.sort((x, y) => {
    const avg = (r) => r.byBudget.filter((v) => v !== null).reduce((p, c, _, arr) => p + c / arr.length, 0);
    return avg(y) - avg(x);
  });
  for (const { a, byBudget, drift } of rows) {
    const counts = BUDGETS.map((b) => countFor(a, b)).join('/');
    const flag = drift === null ? '' : drift > 0.25 ? '  ↑ 대군에서 강함' : drift < -0.25 ? '  ↓ 대군에서 약함' : '';
    console.log(
      `  ${pad(nameOf(a), 12)} ${pad(unitValue(a).toFixed(2) + '코', 7)} ` +
        `${byBudget.map((v) => pad(fmt(v), 9)).join('')} ${drift === null ? '—' : fmt(drift)}` +
        `${flag}   [${counts}마리]`,
    );
  }
  console.log('');
}

/* ── 3. 이상치 짝 ──────────────────────────────────────────────────────── */

function outliers() {
  console.log('── 3. 같은 돈인데 일방적인 짝 (|우세도| ≥ 0.8) — 상성이 아니라 벽이다 ──');
  const found = [];
  for (let i = 0; i < ROSTER.length; i++) {
    for (let j = i + 1; j < ROSTER.length; j++) {
      const a = ROSTER[i];
      const b = ROSTER[j];
      if (!mutual(a, b)) continue;
      for (const budget of BUDGETS) {
        const na = countFor(a, budget);
        const nb = countFor(b, budget);
        const r = duel(a, b, na, 7, nb);
        if (r.edge !== null && Math.abs(r.edge) >= 0.8) found.push([a, b, budget, na, nb, r.edge]);
      }
    }
  }
  if (!found.length) {
    console.log('  없음\n');
    return;
  }
  found.sort((x, y) => Math.abs(y[5]) - Math.abs(x[5]));
  for (const [a, b, budget, na, nb, e] of found.slice(0, 20)) {
    const win = e > 0 ? [a, na] : [b, nb];
    const lose = e > 0 ? [b, nb] : [a, na];
    console.log(
      `  ${String(budget).padStart(2)}코  ${pad(nameOf(win[0]), 12)} ${String(win[1]).padStart(2)}마리 → ` +
        `${pad(nameOf(lose[0]), 12)} ${String(lose[1]).padStart(2)}마리   ${fmt(Math.abs(e))}`,
    );
  }
  if (found.length > 20) console.log(`  … 그 밖에 ${found.length - 20}건`);
  console.log('');
}

/* ── 실행 ──────────────────────────────────────────────────────────────── */

const t0 = Date.now();
console.log(
  `결투장 (${(ARENA.cx / 1000).toFixed(0)},${(ARENA.cy / 1000).toFixed(0)}) 평지 · ` +
    `${ARENA.w}×${ARENA.h}타일 · 한 편 최대 ${CAPACITY}마리 · ` +
    `규모 ${SCALES.join('/')}마리 · ${ROSTER.length}유닛\n`,
);

if (ONLY_PAIR) {
  const [a, b] = ONLY_PAIR;
  console.log(`── ${nameOf(a)} vs ${nameOf(b)} ──`);
  for (const n of SCALES) {
    const r = duel(a, b, n);
    console.log(
      `  ${n}마리  우세도 ${fmt(r.edge)}  잃은 가치 ${r.lostA.toFixed(1)} : ${r.lostB.toFixed(1)}` +
        `  ${(r.ticks / 20).toFixed(1)}초`,
    );
  }
} else {
  mirrorCheck();
  scaleTable();
  budgetTable();
  outliers();
}
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s 소요`);
