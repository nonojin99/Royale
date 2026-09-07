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
  supplyOf,
  SUPPLY_MAIN,
  SUPPLY_PER_EXPANSION,
  MAIN_BASE_STATS,
  EXPANSION_BASE_STATS,
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
  // 기지 자리에서 조금만 떨어지면 된다. `fight()`가 엔티티를 통째로 지우므로
  // 기지가 싸움에 끼지 않고, 고지/물/벽은 아래 평지 검사가 이미 거른다.
  // 15타일을 요구했더니 지도의 확장 자리를 안쪽으로 옮긴 뒤 결투장이
  // 19×9에서 11×12로 줄어, 정원 18이 병목이 되어 물량 유닛을 잘라 먹었다
  const far = (cx, cy) => BASE_SITES.every((b) => Math.hypot(b.x - cx, b.y - cy) > 8000);
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
      for (let h = 6; h < 28; h++) {
        for (let w = 5; w < 28; w++) {
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
  return fight([{ id: aId, n }], [{ id: bId, n: nB }], seed);
}

/**
 * 부대 대 부대 — `[{id, n}, ...]`. 섞인 편성도 그대로 받는다.
 *
 * `defender`를 주면 B편 뒤에 그 편의 기지를 세운다. 벌판 싸움과 비교하면
 * **기지를 등지고 싸우는 값어치**가 그대로 차이로 나온다.
 */
function fight(forceA, forceB, seed = 7, { defender = null } = {}) {
  // 실험장 모드 — 승패 판정이 없고, 표적 없는 유닛이 서로에게 전진한다
  const s = createState(seed, ['steel', 'steel'], 'coast', true);
  // 기지는 사거리와 시야를 가진 참가자다. 결투에서는 치운다
  s.entities.length = 0;
  if (defender) {
    const st = defender === 'main' ? MAIN_BASE_STATS : EXPANSION_BASE_STATS;
    s.entities.push({
      id: s.nextId++,
      team: 1,
      unit: '__base',
      kind: 'base',
      x: ARENA.cx,
      y: ARENA.cy - FRONT - GAP, // B편 바로 뒤 — 사거리 안에 들어와야 참가한다
      hp: st.hp,
      maxHp: st.hp,
      cd: 0,
      deploy: 0,
      life: -1,
      target: -1,
      flying: false,
      charge: 0,
      mode: 0,
      haste: 0,
      orderX: -1,
      orderY: -1,
      orderAttack: 0,
      hold: 0,
      reveal: -1,
      siteId: -1,
      isMain: defender === 'main',
      reserve: 0,
    });
  }

  const put = (team, id, count, offset) => {
    const u = getUnit(id);
    for (let k = 0; k < count; k++) {
      const i = offset + k;
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
        charge: u.chargeStart ?? 0, // 생산될 때의 게이지 — 현실과 같아야 한다
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
  let slotA = 0;
  let slotB = 0;
  for (const g of forceA) put(0, g.id, g.n, slotA), (slotA += g.n);
  for (const g of forceB) put(1, g.id, g.n, slotB), (slotB += g.n);

  const cost = (f) => f.reduce((sum, g) => sum + g.n * unitValue(g.id), 0);
  const startA = cost(forceA);
  const startB = cost(forceB);

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

/* ── 2c. 공급 칸별 종합 (등공급) ───────────────────────────────────────── */

/**
 * 같은 **칸**을 붙인다 — 공급 천장이 생긴 뒤로는 이쪽이 진짜 결정이다.
 *
 * 등코스트는 "같은 돈으로 무엇을 살까"를 묻는다. 그건 천장에 닿기 전의
 * 질문이다. 천장에 닿으면 돈은 남고 칸이 모자라서, 질문이 **"이 한 칸에
 * 무엇을 세울까"**로 바뀐다. 그때부터 비싼 유닛은 비싼 게 흠이 아니라
 * 값을 치르고 사는 밀도가 된다.
 *
 * 그래서 테크가 값을 하는지는 여기서 갈린다. 등코스트에서 T2가 T0에게
 * 지더라도, 등공급에서 이기면 "천장에 닿은 뒤 돈을 질로 바꾼다"가 성립한다.
 * 둘 다 지면 연구비는 그냥 버리는 돈이다.
 */
const SLOTS = (argOf('--slots') ?? '12,24,36').split(',').map(Number);
/** 이 칸수로 살 수 있는 카드 수 (마리 수가 아니라 카드 장수 × count) */
const cardsForSlots = (id, slots) => {
  const per = supplyOf(getUnit(id));
  const cards = Math.max(1, Math.floor(slots / per));
  return Math.min(CAPACITY, cards * getUnit(id).count);
};

function supplyTable() {
  console.log('── 2c. 공급 칸별 종합 우세도 (같은 칸으로 세울 수 있는 만큼) ──');
  console.log(
    `  ${pad('유닛', 12)} ${pad('칸당코', 7)} ` +
      `${SLOTS.map((s) => pad(`${s}칸`, 9)).join('')} 적음→많음`,
  );

  const rows = [];
  for (const a of ROSTER) {
    if (getUnit(a).targets === 'buildings') continue;
    const bySlots = SLOTS.map((slots) => {
      const vals = [];
      for (const b of ROSTER) {
        if (a === b || !mutual(a, b)) continue;
        const r = duel(a, b, cardsForSlots(a, slots), 7, cardsForSlots(b, slots));
        if (r.edge !== null) vals.push(r.edge);
      }
      return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    });
    const first = bySlots[0];
    const last = bySlots[bySlots.length - 1];
    rows.push({ a, bySlots, drift: first !== null && last !== null ? last - first : null });
  }
  rows.sort((x, y) => {
    const avg = (r) =>
      r.bySlots.filter((v) => v !== null).reduce((p, c, _, arr) => p + c / arr.length, 0);
    return avg(y) - avg(x);
  });
  for (const { a, bySlots, drift } of rows) {
    const u = getUnit(a);
    const perSlot = (u.cost / supplyOf(u)).toFixed(2);
    const counts = SLOTS.map((s) => cardsForSlots(a, s)).join('/');
    console.log(
      `  ${pad(nameOf(a), 12)} ${pad(perSlot + '코', 7)} ` +
        `${bySlots.map((v) => pad(fmt(v), 9)).join('')} ${drift === null ? '—' : fmt(drift)}` +
        `   [${counts}마리]`,
    );
  }
  console.log('');
  return rows;
}

/* ── 2d. 테크 대 확장 (판의 실제 질문) ─────────────────────────────────── */

/**
 * **칸이 적지만 좋은 군대** vs **칸이 많지만 싼 군대**.
 *
 * 공급 천장을 기지에 묶은 순간, 판의 결정은 이 한 줄로 압축된다.
 * 테크로 간 쪽은 칸당 값어치를 얻고(2c 표에서 T2가 +0.35~0.57),
 * 확장으로 간 쪽은 칸 자체를 얻는다(본진 28 + 확장마다 10).
 *
 * 어느 쪽이 이기는지는 **칸 비율**이 정한다. 그 문턱이 어디인지 몰라서
 * TECH이 GREED에 91%로 지는 이유를 세 번 놓쳤다 — 유닛을 의심하고,
 * 봇을 의심하고, 지도를 의심했다. 정작 재야 할 것은 이 저울이었다.
 */
function tierTable() {
  console.log(
    '── 2d. 테크(T2) 대 확장(T0) — 칸이 적지만 좋은 군대 vs 많지만 싼 군대 (최선 대 최선) ──',
  );
  // 칸수는 실제 천장에서 가져온다 — 눈금이 바뀌면 표도 따라가야 한다
  const B1 = SUPPLY_MAIN;
  const B = (n) => SUPPLY_MAIN + (n - 1) * SUPPLY_PER_EXPANSION;
  const RATIOS = [
    [B1, B(1), '1기지 : 1기지'],
    [B1, B(2), '1기지 : 2기지'],
    [B1, B(3), '1기지 : 3기지'],
    [B(2), B(4), '2기지 : 4기지'],
    [B(2), B(3), '2기지 : 3기지'],
  ];
  // 결투장이 좁으면 비율을 지키며 함께 줄인다 — 묻는 것은 절대 규모가 아니라 비율이다
  console.log(`  ${pad('종족', 8)} ${pad('T2 편성', 22)} ${pad('T0 편성', 22)} 칸비  우세도`);
  for (const fid of FACTION_IDS) {
    const f = getFaction(fid);
    const pick = (tier) =>
      f.tech
        .filter((n) => n.tier === tier)
        .map((n) => n.unit)
        .filter((id) => {
          const u = getUnit(id);
          return u.kind === 'unit' && u.targets !== 'buildings';
        });
    const t2 = pick(2);
    const t0 = pick(0);
    if (!t2.length || !t0.length) continue;
    // 고를 수 있는 편성 — 종류마다 몰빵, 그리고 고르게 섞은 것
    const options = (ids) => [...ids.map((id) => [id]), ids].filter((g) => g.length);
    for (const [slotsA, slotsB, label] of RATIOS) {
      // 두 편이 모두 정원에 들어가도록 같은 비율로 줄인다
      const fits = (ids, slots) => {
        const g = evenSlots(ids, slots);
        const n = g.reduce((s, x) => s + x.n, 0);
        return n > 0 && n <= CAPACITY ? g : null;
      };
      let k = 1;
      for (; k <= 8; k++) {
        const ok = options(t2).every((g) => fits(g, Math.round(slotsA / k)));
        const ok2 = options(t0).every((g) => fits(g, Math.round(slotsB / k)));
        if (ok && ok2) break;
      }
      // **최선 대 최선** — 균등 분할만 재면 "거대포식자만 뽑는다" 같은
      // 실제 선택이 안 보인다. 공격하는 쪽이 최선을 고르되, 지키는 쪽도
      // 최선으로 답한다고 보고 그 최솟값을 취한다 (max-min)
      let bestEdge = -Infinity;
      let bestA = null;
      let bestB = null;
      for (const ga of options(t2)) {
        const A = fits(ga, Math.round(slotsA / k));
        if (!A) continue;
        let worst = Infinity;
        let worstB = null;
        for (const gb of options(t0)) {
          const B = fits(gb, Math.round(slotsB / k));
          if (!B) continue;
          const e = fight(A, B, 7).edge;
          if (e !== null && e < worst) {
            worst = e;
            worstB = B;
          }
        }
        if (worstB && worst > bestEdge) {
          bestEdge = worst;
          bestA = A;
          bestB = worstB;
        }
      }
      if (!bestA) continue;
      const desc = (g) => g.map((x) => `${nameOf(x.id)}×${x.n}`).join('+');
      console.log(
        `  ${pad(f.name, 8)} ${pad(desc(bestA), 22)} ${pad(desc(bestB), 22)}` +
          ` ${pad(label, 12)} ${fmt(bestEdge)}`,
      );
    }
  }
  console.log('');
}

/** 주어진 칸수를 종류별로 고르게 채운다 (evenForce의 공급판) */
function evenSlots(ids, slots) {
  const per = ids.map((id) => supplyOf(getUnit(id)));
  const cards = ids.map(() => 0);
  let used = 0;
  for (;;) {
    const order = ids.map((_, i) => i).sort((x, y) => cards[x] * per[x] - cards[y] * per[y]);
    const pick = order.find((i) => used + per[i] <= slots);
    if (pick === undefined) break;
    cards[pick]++;
    used += per[pick];
  }
  return ids
    .map((id, i) => ({ id, n: cards[i] * getUnit(id).count }))
    .filter((g) => g.n > 0);
}

/* ── 2e. 수비 이점 ─────────────────────────────────────────────────────── */

/**
 * 기지를 등지고 싸우면 얼마나 이득인가.
 *
 * 판에서 되풀이된 그림이 있다: 들판에서 이기는 편성이 상대 기지 앞에
 * 가면 전멸한다. TECH이 120초에 GREED와 대등한 병력으로 나갔다가 20초
 * 만에 다 잃은 것도, 러시가 140초 동안 준 피해가 132였던 것도 같은 일이다.
 * 그 값을 모르면 "공격이 성립하는가"를 논할 수 없다.
 *
 * 같은 두 편성을 두 번 붙인다 — 벌판에서 한 번, B편이 자기 기지를 등지고
 * 한 번. 차이가 곧 기지 한 채의 값어치다.
 */
function defenseTable() {
  console.log('── 2e. 기지를 등지고 싸우면 얼마나 이득인가 ──');
  console.log(`  ${pad('편성', 26)} ${pad('벌판', 8)} ${pad('확장 낀 수비', 12)} ${pad('본진 낀 수비', 12)} 기지값`);
  const CASES = [];
  for (const fid of FACTION_IDS) {
    const f = getFaction(fid);
    const units = f.tech
      .map((n) => n.unit)
      .filter((id) => {
        const u = getUnit(id);
        return u.kind === 'unit' && u.targets !== 'buildings';
      });
    if (units.length < 2) continue;
    CASES.push([f.name, units]);
  }
  for (const [name, units] of CASES) {
    const force = evenSlots(units, 18);
    const n = force.reduce((s, g) => s + g.n, 0);
    if (!n || n > CAPACITY) continue;
    const flat = fight(force, force, 7).edge;
    const exp = fight(force, force, 7, { defender: 'expansion' }).edge;
    const main = fight(force, force, 7, { defender: 'main' }).edge;
    // 미러 편성이므로 벌판은 0에 가까워야 한다. 수비 쪽 값이 내려간 만큼이 기지값
    console.log(
      `  ${pad(name + ' 미러', 26)} ${pad(fmt(flat), 8)} ${pad(fmt(exp), 12)} ${pad(fmt(main), 12)}` +
        ` ${fmt(flat - main)}`,
    );
  }
  console.log(
    '  (우세도는 **공격하는 A편** 기준이다. 수비 쪽 숫자가 낮을수록 기지가 세다)\n',
  );
}

/* ── 2f. 한 유닛 파고들기 (--focus) ────────────────────────────────────── */

/**
 * 한 유닛이 **누구에게** 지는지 상대별로 편다.
 *
 * 종합 우세도는 "약하다"까지만 말해 준다. 고치려면 체력이 모자라 먼저
 * 죽는 건지, 화력이 모자라 못 죽이는 건지, 사거리에 밀려 붙지도 못하는
 * 건지를 갈라야 한다. 살아남은 비율까지 같이 찍는 이유다.
 */
function focusTable(id) {
  const u = getUnit(id);
  console.log(
    `── 2f. ${nameOf(id)} 파고들기 — ${u.cost}코 · ${u.count}마리 · ` +
      `${u.size ?? 'medium'} · ${supplyOf(u)}칸 (칸당 ${(u.cost / supplyOf(u)).toFixed(2)}코) ──`,
  );
  console.log(`  ${pad('상대', 12)} ${pad('칸당코', 7)} ${SLOTS.map((s) => pad(`${s}칸`, 9)).join('')}`);
  const rows = [];
  for (const b of ROSTER) {
    if (b === id || !mutual(id, b)) continue;
    const vals = SLOTS.map((slots) => {
      const r = duel(id, b, cardsForSlots(id, slots), 7, cardsForSlots(b, slots));
      return r.edge;
    });
    const avg = vals.filter((v) => v !== null).reduce((p, c, _, a) => p + c / a.length, 0);
    rows.push({ b, vals, avg });
  }
  rows.sort((x, y) => x.avg - y.avg);
  for (const { b, vals } of rows) {
    const ub = getUnit(b);
    console.log(
      `  ${pad(nameOf(b), 12)} ${pad((ub.cost / supplyOf(ub)).toFixed(2) + '코', 7)} ` +
        vals.map((v) => pad(fmt(v), 9)).join(''),
    );
  }
  const blind = ROSTER.filter((b) => b !== id && !canHit(b, id));
  if (blind.length) {
    console.log(
      `\n  이 표에 안 잡히는 값어치: ${blind.length}유닛이 ${nameOf(id)}를 못 때린다 ` +
        `(${blind.map(nameOf).join(' · ')})`,
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

/* ── 4. 혼합 대 순수 ───────────────────────────────────────────────────── */

/**
 * 예산을 여러 종류에 **값이 고르게** 나눠 담는다.
 *
 * `budget/2`로 나눠 각자 내림하면 비싼 유닛에서 예산이 샌다 — 4코짜리 둘을
 * 12코로 섞으면 1+1=8코가 되어 12코 몰빵을 상대로 3분의 1을 손해 보고 시작한다.
 * 그러면 "혼합이 약하다"가 아니라 "혼합이 가난하다"를 재게 된다 (실측에서
 * 역시너지 27건이 전부 이 artifact였다). 그래서 값이 적은 쪽부터 한 마리씩
 * 채워 예산을 끝까지 쓴다.
 */
function evenForce(ids, budget) {
  const vals = ids.map(unitValue);
  const ns = ids.map(() => 0);
  let spent = 0;
  for (;;) {
    // 지금 가장 값이 적게 들어간 종류부터 — 없으면 들어갈 수 있는 아무거나
    const order = ids
      .map((_, i) => i)
      .sort((x, y) => ns[x] * vals[x] - ns[y] * vals[y]);
    // 결투장 정원은 **한 편 전체**의 몫이다. 종류마다 CAPACITY까지 허용하면
    // 3종 조합이 정원의 세 배를 깔아 배치가 결투장 밖으로 나간다
    // (지도를 손질해 결투장이 19×9에서 11×12로 줄자 바로 터졌다)
    const total = ns.reduce((a, b) => a + b, 0);
    const pick =
      total >= CAPACITY
        ? undefined
        : order.find((i) => spent + vals[i] <= budget + 1e-9 && ns[i] < CAPACITY);
    if (pick === undefined) break;
    ns[pick]++;
    spent += vals[pick];
  }
  return ids.map((id, i) => ({ id, n: ns[i] })).filter((g) => g.n > 0);
}

const mixOf = (a, b, budget) => evenForce([a, b], budget);
const pureOf = (id, budget) => [{ id, n: countFor(id, budget) }];
const forceCost = (f) => f.reduce((sum, g) => sum + g.n * unitValue(g.id), 0);
const forceLabel = (f) => f.map((g) => `${nameOf(g.id)}×${g.n}`).join(' + ');

/**
 * 섞는 것이 이득인가 — 같은 돈으로 **A+B 혼합**과 **A 몰빵 · B 몰빵**을 붙인다.
 *
 * 이게 조합 밸런스의 첫 질문이다. 혼합이 자기 재료 둘을 **모두** 이기면
 * 시너지(앞줄이 버티고 뒷줄이 때린다)이고, 둘 다에게 지면 역시너지다.
 * 둘 다 없이 중간이면 그 짝은 그냥 취향 문제고, 그건 건강한 상태다.
 */
function mixTable(budget) {
  console.log(`── 4. 혼합 대 순수 (예산 ${budget}코, 반반) ──`);
  const syn = [];
  const anti = [];
  for (let i = 0; i < ROSTER.length; i++) {
    for (let j = i + 1; j < ROSTER.length; j++) {
      const a = ROSTER[i];
      const b = ROSTER[j];
      const mix = mixOf(a, b, budget);
      const pa = pureOf(a, budget);
      const pb = pureOf(b, budget);
      // 값이 한 코 넘게 어긋나면 비교가 아니라 빈부 격차를 재는 것이다
      if (Math.abs(forceCost(mix) - forceCost(pa)) > 1) continue;
      if (Math.abs(forceCost(mix) - forceCost(pb)) > 1) continue;
      const vsA = fight(mix, pa).edge;
      const vsB = fight(mix, pb).edge;
      if (vsA === null || vsB === null) continue;
      const worst = Math.min(vsA, vsB);
      const best = Math.max(vsA, vsB);
      if (worst > 0.15) syn.push([a, b, vsA, vsB, worst]);
      else if (best < -0.15) anti.push([a, b, vsA, vsB, best]);
    }
  }
  syn.sort((x, y) => y[4] - x[4]);
  anti.sort((x, y) => x[4] - y[4]);

  console.log(`  ▲ 시너지 — 섞은 쪽이 재료 둘 다를 이긴다 (${syn.length}건)`);
  for (const [a, b, vsA, vsB] of syn.slice(0, 10)) {
    console.log(
      `    ${pad(nameOf(a) + ' + ' + nameOf(b), 24)} vs ${pad(nameOf(a), 12)}${fmt(vsA)}` +
        `   vs ${pad(nameOf(b), 12)}${fmt(vsB)}`,
    );
  }
  console.log(`  ▼ 역시너지 — 섞으면 재료 둘보다 못하다 (${anti.length}건)`);
  for (const [a, b, vsA, vsB] of anti.slice(0, 10)) {
    console.log(
      `    ${pad(nameOf(a) + ' + ' + nameOf(b), 24)} vs ${pad(nameOf(a), 12)}${fmt(vsA)}` +
        `   vs ${pad(nameOf(b), 12)}${fmt(vsB)}`,
    );
  }
  console.log('');
}

/* ── 5. 세 종류 조합 ───────────────────────────────────────────────────── */

const trioOf = (ids, budget) => evenForce(ids, budget);

/**
 * 종족 안에서 세 종류를 골라 짠 편성끼리 리그를 돌린다.
 *
 * 실제 경기에서 고르는 것은 유닛 하나가 아니라 **편성**이다. 유닛 단독
 * 우세도가 낮아도(술사처럼) 앞줄을 세워 주면 값을 하는 경우가 있고,
 * 그 값은 단독 결투로는 영영 안 보인다.
 */
function trioTable(budget) {
  console.log(`── 5. 세 종류 조합 리그 (예산 ${budget}코, 3분할) ──`);
  for (const f of FACTION_IDS) {
    const pool = getFaction(f)
      .tech.map((n) => n.unit)
      .filter((id) => getUnit(id).kind === 'unit' && getUnit(id).targets !== 'buildings');
    const combos = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        for (let k = j + 1; k < pool.length; k++) combos.push([pool[i], pool[j], pool[k]]);
      }
    }
    const score = combos.map(() => 0);
    const played = combos.map(() => 0);
    for (let x = 0; x < combos.length; x++) {
      for (let y = x + 1; y < combos.length; y++) {
        const r = fight(trioOf(combos[x], budget), trioOf(combos[y], budget));
        if (r.edge === null) continue;
        score[x] += r.edge;
        score[y] -= r.edge;
        played[x]++;
        played[y]++;
      }
    }
    const rank = combos
      .map((c, i) => ({ c, avg: played[i] ? score[i] / played[i] : null }))
      .filter((r) => r.avg !== null)
      .sort((a, b) => b.avg - a.avg);
    console.log(`\n  【${getFaction(f).name}】 ${combos.length}개 편성`);
    for (const r of rank.slice(0, 3)) {
      console.log(`    최강 ${pad(r.c.map(nameOf).join(' + '), 34)} ${fmt(r.avg)}`);
    }
    for (const r of rank.slice(-3)) {
      console.log(`    최약 ${pad(r.c.map(nameOf).join(' + '), 34)} ${fmt(r.avg)}`);
    }
    // 특정 유닛이 편성에 들어가면 평균이 오르는가 — 조합 안에서의 값어치
    console.log('    유닛이 편성에 들어갈 때의 평균 우세도:');
    const per = pool
      .map((id) => {
        const withIt = rank.filter((r) => r.c.includes(id));
        return { id, avg: withIt.reduce((s2, r) => s2 + r.avg, 0) / Math.max(1, withIt.length) };
      })
      .sort((a, b) => b.avg - a.avg);
    console.log('      ' + per.map((x) => `${nameOf(x.id)} ${fmt(x.avg)}`).join('  ·  '));
  }
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
} else if (argOf('--focus')) {
  focusTable(argOf('--focus'));
} else {
  const MODE = argOf('--mode') ?? 'all';
  const want = (m) => MODE === 'all' || MODE === m;
  if (want('unit')) {
    mirrorCheck();
    scaleTable();
    budgetTable();
    supplyTable();
    tierTable();
    defenseTable();
    outliers();
  }
  if (want('comp')) {
    mixTable(20);
    trioTable(24);
  }
}
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s 소요`);
