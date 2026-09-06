/**
 * 안개 기습 실험 — "모아서 치는 쪽" 대 "쌓아두고 반응하는 쪽" (라운드 52)
 *
 * 오너의 설계 명제를 그대로 옮긴 저울이다:
 *
 *   러시의 값어치는 **안개 속에서 병력을 모아 기습하는 것**이다.
 *   그런데 지키는 쪽이 쌓아둔 돈으로 그 순간 병력을 순식간에 뽑아내면
 *   기습이 무력해지고 형평성이 깨진다.
 *
 * 전략 하네스로는 이걸 못 잰다. 고정 전략 봇(RUSH·GREED·TECH)은 **보이는
 * 것을 아예 안 본다** — 타이머로 흘려보내고 정해진 순서대로 생산할 뿐이다.
 * 실제로 기지 시야를 12타일에서 4타일로 줄여도 총당전 결과가 한 판도 안
 * 바뀌었다(27:21 · 29:19 · 45:3이 네 번 똑같이 나왔다). 정보가 승패에
 * 안 들어가는 저울로 정보 설계를 논할 수 없다.
 *
 * 그래서 장면 하나를 세운다:
 *   · 지키는 쪽: 기지 N개 · 쌓아둔 돈 M · 상비군 약간. **적이 보이면**
 *     그때부터 가장 가까운 기지에서 밀도 높은 유닛을 뽑고 요격을 보낸다
 *   · 치는 쪽: 기지 1개 · 안개 밖 D타일에 모아 둔 병력. 그대로 돌격한다
 *
 * 재는 것: 치는 쪽이 기지를 부수는가. 그리고 지키는 쪽이 **교전 중에
 * 얼마를 병력으로 바꿨는가**(= 쌓아둔 돈이 얼마나 즉시 방어가 되는가).
 *
 * 사용: node tools/ambush.mjs            (기본 쓸기)
 *       node tools/ambush.mjs --seeds 12
 */
import {
  BASE_SITES,
  MINERAL_SCALE,
  TICK_RATE,
  createRng,
  createState,
  getFaction,
  getUnit,
  isHiddenFrom,
  nextInt,
  ownBasePositions,
  canDeployAt,
  isUnlocked,
  hurtLocked,
  step,
  supplyOf,
  supplyCapOf,
  supplyUsedOf,
  BASE_BUILD_TICKS,
} from '../packages/shared/dist/index.js';

const args = process.argv.slice(2);
const SEEDS = Number(args[args.indexOf('--seeds') + 1] || 0) || 8;
const FACTIONS = ['steel', 'swarmhive', 'covenant'];
const MAX_TICKS = 20 * 120;

/** 한 종족의 싸울 수 있는 유닛 (건물 전용·주문 제외) */
function roster(fid) {
  return getFaction(fid)
    .tech.map((n) => n.unit)
    .filter((id) => {
      const u = getUnit(id);
      return u.kind === 'unit' && u.targets !== 'buildings';
    });
}

/**
 * 칸당 값이 가장 높은(= 밀도 높은) **해금된** 유닛 중 살 수 있는 것.
 *
 * 해금 검사를 빼먹었더니 돈이 많을수록 아직 연구도 안 한 공성전차를
 * 고르려다 매 틱 거절당해, **돈이 많은 쪽이 아무것도 못 뽑는** 표가 나왔다.
 */
function densest(p, ids, minerals) {
  let best = null;
  let bestDense = -1;
  for (const id of ids) {
    if (!isUnlocked(p, id)) continue;
    const u = getUnit(id);
    if (u.cost * MINERAL_SCALE > minerals) continue;
    const d = (u.cost * 1000) / supplyOf(u);
    if (d > bestDense) {
      bestDense = d;
      best = id;
    }
  }
  return best;
}

/**
 * 장면 하나를 돌린다.
 *
 * @param bases  지키는 쪽 기지 수 (1~4)
 * @param bank   지키는 쪽이 쌓아둔 돈 (코스트)
 * @param atk    치는 쪽이 모아 온 병력 (칸)
 * @param def    지키는 쪽 상비군 (칸)
 */
function scene(fid, bases, bank, atk, def, seed) {
  const s = createState(seed, [fid, fid]);
  const rng = createRng((seed ^ 0x5eed) >>> 0);
  const ids = roster(fid);

  // 팀1 = 지키는 쪽. 기지를 원하는 수만큼 즉시 가동 상태로 세운다
  const home1 = s.entities.find((e) => e.kind === 'base' && e.team === 1);
  const taken = new Set(s.entities.map((e) => e.siteId));
  for (const site of BASE_SITES) {
    if (s.entities.filter((e) => e.kind === 'base' && e.team === 1).length >= bases) break;
    if (site.startFor !== -1 || taken.has(site.id)) continue;
    if (Math.hypot(site.x - home1.x, site.y - home1.y) > 20000) continue;
    s.entities.push({
      ...home1,
      id: s.nextId++,
      x: site.x,
      y: site.y,
      siteId: site.id,
      isMain: false,
      hp: 1500,
      maxHp: 1500,
      deploy: 0,
    });
    taken.add(site.id);
  }
  s.players[1].minerals = bank * MINERAL_SCALE;
  s.players[0].minerals = 0;

  // 상비군·기습군을 칸수만큼 깐다
  const fill = (team, slots, x, y) => {
    let used = 0;
    let guard = 0;
    while (used < slots && guard++ < 60) {
      const id = ids[nextInt(rng, ids.length)];
      const u = getUnit(id);
      if (used + supplyOf(u) > slots) continue;
      for (let i = 0; i < u.count; i++) {
        const px = x + nextInt(rng, 2400) - 1200;
        const py = y + nextInt(rng, 2400) - 1200;
        s.entities.push({
          id: s.nextId++, team, unit: id, kind: 'unit', x: px, y: py,
          hp: u.hp, maxHp: u.hp, cd: 0, deploy: 0, life: -1, target: -1,
          flying: u.flying, charge: u.chargeStart ?? 0, mode: 0, haste: 0,
          orderX: -1, orderY: -1, orderAttack: 0, hold: 0, reveal: -1,
          siteId: -1, isMain: false, reserve: 0,
        });
      }
      used += supplyOf(u);
    }
  };
  fill(1, def, home1.x, home1.y + 2000);
  // 치는 쪽은 지키는 쪽 본진에서 18타일 — 안개 밖이다
  const home0 = s.entities.find((e) => e.kind === 'base' && e.team === 0 && e.isMain);
  const dx = home1.x - home0.x;
  const dy = home1.y - home0.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const sx = Math.round(home1.x - (dx / len) * 18000);
  const sy = Math.round(home1.y - (dy / len) * 18000);
  fill(0, atk, sx, sy);

  let spent = 0;
  let sawAt = -1;
  for (let t = 0; t < MAX_TICKS; t++) {
    const cmds = [];
    let ordered = null;
    // 치는 쪽 — 뭉쳐서 본진으로 돌격
    if (t % 40 === 0) {
      const army = s.entities.filter((e) => e.kind === 'unit' && e.team === 0).map((e) => e.id);
      if (army.length) {
        cmds.push({
          execTick: s.tick, team: 0, kind: 'attack',
          id: army.sort((a, b) => a - b).join(','), x: home1.x, y: home1.y,
        });
      }
    }
    // 지키는 쪽 — **보여야** 움직인다
    const seen = s.entities.filter(
      (e) => e.kind === 'unit' && e.team === 0 && !isHiddenFrom(s, 1, e),
    );
    if (seen.length) {
      if (sawAt < 0) sawAt = t;
      if (t % 20 === 0) {
        // 요격
        const army = s.entities.filter((e) => e.kind === 'unit' && e.team === 1).map((e) => e.id);
        if (army.length) {
          cmds.push({
            execTick: s.tick, team: 1, kind: 'attack',
            id: army.sort((a, b) => a - b).join(','), x: seen[0].x, y: seen[0].y,
          });
        }
      }
      // 쌓아둔 돈을 병력으로 — 위협받는 지점에서 가장 가까운 기지에서 뽑는다
      const me = s.players[1];
      const pick = densest(me, ids, me.minerals);
      if (pick && supplyUsedOf(s, 1) + supplyOf(getUnit(pick)) <= supplyCapOf(s, 1)) {
        // **위협받는 기지에서 뽑는다.** 아무 기지에서나 뽑게 했더니 기지가
        // 넷일 때 셋은 엉뚱한 데서 나와 도착도 못 했고, 4기지가 2기지보다
        // 못 막는 표가 나왔다 (전진 배치의 요점이 바로 이것이다)
        // 위협받는 기지부터 쓰되, **맞고 있어 잠긴 기지는 건너뛴다**.
        // 사람도 그렇게 한다 — 다만 뒤 기지에서 뽑으면 걸어와야 한다
        const mine = ownBasePositions(s, 1);
        const order = mine
          .slice()
          .sort(
            (a, b) =>
              Math.hypot(a[0] - seen[0].x, a[1] - seen[0].y) -
              Math.hypot(b[0] - seen[0].x, b[1] - seen[0].y),
          )
          .filter((b) => {
            const base = s.entities.find(
              (e) =>
                e.kind === 'base' && e.team === 1 && e.hp > 0 &&
                Math.abs(e.x - b[0]) < 500 && Math.abs(e.y - b[1]) < 500,
            );
            return base ? !hurtLocked(s, base) : true;
          });
        let spot = null;
        for (const near of order) {
          for (let k = 0; k < 8 && !spot; k++) {
            const px = near[0] + nextInt(rng, 2400) - 1200;
            const py = near[1] + nextInt(rng, 2400) - 1200;
            if (canDeployAt(px, py, mine)) spot = [px, py];
          }
          if (spot) break;
        }
        if (spot) {
          cmds.push({ execTick: s.tick, team: 1, kind: 'unit', id: pick, x: spot[0], y: spot[1] });
          ordered = pick;
        }
      }
    }
    // 미네랄 차이로도 큐 길이로도 못 잰다 — 같은 틱에 수입이 들어오고,
    // 큐는 굽는 대로 빠져나간다. **공급 사용량**(필드 + 예약)으로 센다
    const supBefore = supplyUsedOf(s, 1);
    step(s, cmds);
    if (ordered && supplyUsedOf(s, 1) > supBefore) spent += getUnit(ordered).cost;
    const live0 = s.entities.some((e) => e.kind === 'unit' && e.team === 0);
    const bases1 = s.entities.filter((e) => e.kind === 'base' && e.team === 1 && e.hp > 0);
    const mainDead = !bases1.some((e) => e.isMain);
    // 성공은 **본진 함락**이다. "기지를 하나라도 부쉈나"로 재면 기지가 많은
    // 쪽이 무방비 확장을 더 많이 가진 탓에 오히려 성공률이 올라가, 줄을
    // 서로 비교할 수 없게 된다
    if (!live0 || mainDead || s.over) {
      return { win: mainDead, killed: bases - bases1.length, spent, ticks: t, sawAt };
    }
  }
  return { win: false, killed: 0, spent, ticks: MAX_TICKS, sawAt };
}

/* ── 쓸기 ─────────────────────────────────────────────────────────────── */

console.log(
  `\n안개 기습 — 치는 쪽은 18타일 밖에 모아 두고 돌격, 지키는 쪽은 **보여야** 반응한다\n` +
    `종족 ${FACTIONS.length} × 시드 ${SEEDS} = 조합당 ${FACTIONS.length * SEEDS}판\n`,
);
console.log(
  `  ${'기지'.padEnd(4)} ${'쌓아둔돈'.padEnd(8)} ${'본진 함락'.padEnd(9)} ${'부순 기지'.padEnd(9)} 교전 중 뽑은 값`,
);
for (const bases of [1, 2, 4]) {
  for (const bank of [0, 30, 60, 120]) {
    let win = 0;
    let n = 0;
    let spent = 0;
    let killed = 0;
    for (const fid of FACTIONS) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        // 치는 쪽은 1기지 천장(56칸)만큼 모아 왔고, 지키는 쪽 상비군은 그 절반
        const r = scene(fid, bases, bank, 56, 28, seed * 31 + bases * 7 + bank);
        n++;
        if (r.win) win++;
        spent += r.spent;
        killed += r.killed;
      }
    }
    console.log(
      `  ${String(bases).padEnd(4)} ${String(bank + '코').padEnd(8)} ` +
        `${((win / n) * 100).toFixed(0).padStart(3)}%       ${(killed / n).toFixed(2).padStart(6)}채    ${(spent / n).toFixed(1)}코`,
    );
  }
}
