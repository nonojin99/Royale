/**
 * 연습 모드 상대.
 *
 * 봇의 수는 **일반 플레이어의 커맨드와 똑같은 경로**로 예약·브로드캐스트된다.
 * 따라서 클라이언트는 봇의 존재를 알 필요가 없고, 결정론에도 영향이 없다.
 * (봇의 내부 RNG는 서버에만 있고 시뮬 상태에 들어가지 않는다.)
 *
 * v1 전략은 매크로 게임의 기본 우선순위를 그대로 따른다:
 *
 *   1. 일꾼 정원이 남으면 채운다        (수입이 모든 것의 기반)
 *   2. 정원이 찼으면 확장한다
 *   3. 연구 중이 아니면 테크를 올린다  (해금 없이는 후반에 밀린다)
 *   4. 남는 자원으로 병력을 뽑는다
 *
 * 강한 AI는 M6 이후의 과제다.
 */

import {
  BASE_BUILD_COST,
  BASE_SITES,
  UPGRADE_COSTS,
  WORKER_COST,
  CommandKind,
  canUpgrade,
  DEPLOY_RADIUS,
  GameState,
  MINERAL_SCALE,
  Rng,
  baseCount,
  canDeployAt,
  canResearch,
  createRng,
  getFaction,
  getUnit,
  isUnlocked,
  nextInt,
  occupiedSites,
  ownBasePositions,
  siteReachable,
  workerCapacity,
} from '@royale/shared';

/** 봇이 수를 두는 최소 간격 (틱) */
const MIN_INTERVAL = 24;
/** 이 이상 기지를 늘리지는 않는다 */
const MAX_BASES = 4;
/**
 * 일꾼 상한. 정원(기지당 8, 최대 32)까지 다 채우면 "일꾼→확장→일꾼→…"
 * 순환에 갇혀 병력을 한 기도 안 뽑는다 — 플레이테스트에서 실제로 관측된
 * 버그다. 경제는 이 정도면 충분하고, 나머지 우선순위가 숨을 쉰다.
 */
const MAX_WORKERS = 10;
/**
 * 방어 건물 상한.
 *
 * 없으면 봇이 가난할 때 "제일 싼 수 = 포탑 2코스트"만 무한히 두면서 확장도
 * 병력도 잊는다 — 대협곡 실전에서 포탑 ~20개로 성을 쌓고 자기 램프까지
 * 막아 본진을 스스로 섬으로 만든 사건의 원인이다 (라운드 15).
 */
const MAX_DEFENSES = 4;

export interface BotMove {
  kind: CommandKind;
  id: string;
  x: number;
  y: number;
}

export class Bot {
  private readonly rng: Rng;
  private lastTick = -999;

  constructor(seed: number) {
    // 시뮬 RNG와 다른 스트림을 쓴다 (섞이면 디버깅이 지옥이 된다)
    this.rng = createRng((seed ^ 0xa5a5a5a5) >>> 0);
  }

  decide(s: GameState, tick: number): BotMove | null {
    if (tick - this.lastTick < MIN_INTERVAL) return null;

    const me = s.players[1];
    // 상대 병력이 더 크면 경제보다 병력이 먼저다 — 확장만 하다 죽지 않는다
    const pressured = this.armyCost(s, 0) > this.armyCost(s, 1);
    const move = pressured
      ? this.produce(s, me) ?? this.train(s) ?? this.expand(s)
      : this.train(s) ??
        this.expand(s) ??
        this.research(s) ??
        this.upgradeMove(me) ??
        this.produce(s, me);
    if (move) this.lastTick = tick;
    return move;
  }

  /**
   * 필드 위 **기동 병력**의 총 코스트 — 압박 판정용.
   *
   * 건물은 세지 않는다. 포탑을 병력으로 치면 봇이 포탑 성을 쌓는 것만으로
   * "병력이 비슷하다"고 착각해 압박 모드가 뒤틀린다 (라운드 15).
   */
  private armyCost(s: GameState, team: 0 | 1): number {
    let sum = 0;
    for (const e of s.entities) {
      if (e.team !== team || e.kind !== 'unit') continue;
      const u = getUnit(e.unit);
      sum += (u.cost * MINERAL_SCALE) / Math.max(1, u.count);
    }
    return sum;
  }

  /** 살아 있는(건설 중 포함) 자기 방어 건물 수 */
  private defenseCount(s: GameState): number {
    let n = 0;
    for (const e of s.entities) if (e.team === 1 && e.kind === 'building') n++;
    return n;
  }

  /** 1순위: 일꾼 — 정원이 빌 때까지 채운다. 경제가 모든 것의 기반이다 */
  private train(s: GameState): BotMove | null {
    const me = s.players[1];
    if (me.minerals < WORKER_COST) return null;
    if (me.workers >= Math.min(MAX_WORKERS, workerCapacity(s, 1))) return null;
    return { kind: 'worker', id: '', x: 0, y: 0 };
  }

  /** 2순위: 확장 — 자기 진영에 가까운 빈 지점부터 채운다 */
  private expand(s: GameState): BotMove | null {
    if (s.players[1].minerals < BASE_BUILD_COST) return null;
    if (baseCount(s, 1) >= MAX_BASES) return null;

    const taken = occupiedSites(s);
    // 팀 1은 위쪽이므로 y가 작은 지점을 선호한다. 인접 제약을 지키지 않으면
    // 서버가 거부한 수를 계속 두면서 다른 우선순위를 막는다
    const candidates = BASE_SITES.filter(
      (b) => !taken.has(b.id) && siteReachable(s, 1, b),
    ).sort((a, b) => a.y - b.y);
    const site = candidates[0];
    if (!site) return null;
    return { kind: 'base', id: '', x: site.x, y: site.y };
  }

  /** 3순위: 테크 — 지금 시작할 수 있고 비용을 감당하는 것 중 가장 싼 것 */
  private research(s: GameState): BotMove | null {
    const me = s.players[1];
    if (me.research) return null;

    const f = getFaction(me.faction);
    let best: string | null = null;
    let bestCost = Infinity;
    for (const node of f.tech) {
      if (!canResearch(me, node.unit)) continue;
      const cost = node.cost * MINERAL_SCALE;
      if (me.minerals < cost) continue;
      if (node.cost < bestCost) {
        bestCost = node.cost;
        best = node.unit;
      }
    }
    if (!best) return null;
    // 확장 여력을 남겨두기 위해 자원이 넉넉할 때만 올린다
    if (me.minerals < bestCost + BASE_BUILD_COST) return null;
    return { kind: 'tech', id: best, x: 0, y: 0 };
  }

  /** 3.5순위: 강화 — 확장 여력을 남기고 여유 자금으로만 올린다 */
  private upgradeMove(me: GameState['players'][number]): BotMove | null {
    if (!canUpgrade(me)) return null;
    if (me.minerals < UPGRADE_COSTS[me.upgrade] + BASE_BUILD_COST) return null;
    return { kind: 'upgrade', id: '', x: 0, y: 0 };
  }

  /**
   * 확장·연구라는 다음 목표에 필요한 만큼은 병력에 쓰지 않는다.
   *
   * 이 저축이 없으면 유닛 2~3코스트가 미네랄을 계속 빨아들여 확장(8)과
   * 2단계 테크(12)에 영원히 도달하지 못한다 — 실측에서 3분 넘는 경기에도
   * 확장 0회가 나온 원인(REVIEW.md P0-3). 사람도 봇도 같은 함정에 빠진다.
   */
  private reserveFor(s: GameState, me: GameState['players'][number]): number {
    const taken = occupiedSites(s);
    const canExpand =
      baseCount(s, 1) < MAX_BASES && BASE_SITES.some((b) => !taken.has(b.id));
    if (canExpand && me.workers >= workerCapacity(s, 1)) return BASE_BUILD_COST;

    if (!me.research) {
      let cheapest = Infinity;
      for (const node of getFaction(me.faction).tech) {
        if (!canResearch(me, node.unit)) continue;
        if (node.cost < cheapest) cheapest = node.cost;
      }
      if (cheapest !== Infinity) return cheapest * MINERAL_SCALE;
    }
    return 0;
  }

  /** 4순위: 병력 — 해금된 것 중 가장 비싼 것을 자기 기지 앞에 낸다 */
  private produce(s: GameState, me: GameState['players'][number]): BotMove | null {
    const bases = ownBasePositions(s, 1);
    if (bases.length === 0) return null;

    const reserve = this.reserveFor(s, me);
    const defenses = this.defenseCount(s);
    let best: string | null = null;
    let bestCost = -1;
    for (const id of me.unlocked) {
      if (!isUnlocked(me, id)) continue;
      const u = getUnit(id);
      // 주문은 자리 계산 없이 던지면 낭비다 — 봇 v1은 유닛·건물만 다룬다.
      // (방어 건물이 시작 해금되면서 여기로 들어온다 — 봇도 포탑을 깐다)
      if (u.kind === 'spell') continue;
      // 포탑은 상한까지만 — 가난할 때 "제일 싼 수"로 무한히 두는 함정을 막고,
      // 상한에 닿으면 null을 돌려 확장·저축 우선순위로 흘러가게 한다
      if (u.kind === 'building' && defenses >= MAX_DEFENSES) continue;
      if (me.minerals - reserve < u.cost * MINERAL_SCALE) continue;
      if (u.cost > bestCost) {
        bestCost = u.cost;
        best = id;
      }
    }
    if (!best) return null;

    // 전선 기지 = 적 본진에 가장 가까운 기지, 배치는 적 방향으로 민다.
    // "y가 큰 기지 아래에 낸다"는 남북 대칭 맵의 가정이라, 대각 맵(대협곡)
    // 에서는 본진 주머니 안에 쌓아 자기 램프를 막았다 (라운드 15)
    const foe = BASE_SITES.find((b) => b.startFor === 0) ?? { x: 0, y: 0 };
    let front = bases[0];
    let bd = Infinity;
    for (const b of bases) {
      const d = (b[0] - foe.x) ** 2 + (b[1] - foe.y) ** 2;
      if (d < bd) {
        bd = d;
        front = b;
      }
    }
    const len = Math.max(1, Math.hypot(foe.x - front[0], foe.y - front[1]));
    const push = DEPLOY_RADIUS * 0.55;
    const cx = front[0] + ((foe.x - front[0]) / len) * push;
    const cy = front[1] + ((foe.y - front[1]) / len) * push;

    const spread = DEPLOY_RADIUS / 2;
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = cx + nextInt(this.rng, spread * 2) - spread;
      const y = cy + nextInt(this.rng, spread * 2) - spread;
      if (canDeployAt(x, y, bases)) return { kind: 'unit', id: best, x, y };
    }
    // 흩뿌리기가 전부 실패하면 밀던 지점에 그대로 낸다
    return { kind: 'unit', id: best, x: cx, y: cy };
  }
}
