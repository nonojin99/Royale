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

  /** 필드 위 병력의 총 코스트 (기지 제외) — 압박 판정용 */
  private armyCost(s: GameState, team: 0 | 1): number {
    let sum = 0;
    for (const e of s.entities) {
      if (e.team !== team || e.kind === 'base') continue;
      const u = getUnit(e.unit);
      sum += (u.cost * MINERAL_SCALE) / Math.max(1, u.count);
    }
    return sum;
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
    let best: string | null = null;
    let bestCost = -1;
    for (const id of me.unlocked) {
      if (!isUnlocked(me, id)) continue;
      const u = getUnit(id);
      // 주문은 자리 계산 없이 던지면 낭비다 — 봇 v1은 유닛·건물만 다룬다.
      // (방어 건물이 시작 해금되면서 여기로 들어온다 — 봇도 포탑을 깐다)
      if (u.kind === 'spell') continue;
      if (me.minerals - reserve < u.cost * MINERAL_SCALE) continue;
      if (u.cost > bestCost) {
        bestCost = u.cost;
        best = id;
      }
    }
    if (!best) return null;

    // 가장 앞선(=y가 큰) 기지 앞에 낸다 — 팀 1은 아래로 밀고 내려간다
    let front = bases[0];
    for (const b of bases) if (b[1] > front[1]) front = b;

    const spread = DEPLOY_RADIUS / 2;
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = front[0] + nextInt(this.rng, spread * 2) - spread;
      const y = front[1] + nextInt(this.rng, spread);
      if (canDeployAt(x, y, bases)) return { kind: 'unit', id: best, x, y };
    }
    // 흩뿌리기가 전부 실패하면 기지 바로 위에 낸다
    return { kind: 'unit', id: best, x: front[0], y: front[1] + 1000 };
  }
}
