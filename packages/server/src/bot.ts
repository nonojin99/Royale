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

/** 난이도 — 로비에서 고른다. 알 수 없는 값은 botLevelOf가 중급으로 떨어뜨린다 */
export type BotLevel = 'easy' | 'normal' | 'hard';

export function botLevelOf(v: unknown): BotLevel {
  return v === 'easy' || v === 'hard' ? v : 'normal';
}

/**
 * 난이도별 조율 값.
 *
 * 봇의 세기는 전략이 아니라 **손과 경제의 속도**로 조절한다 — 전략을
 * 난이도마다 갈라놓으면 유지비가 배로 들고, 사람이 느끼는 "세다"의 대부분은
 * 어차피 수 간격과 일꾼 수에서 온다 (스타의 컴퓨터도 같은 원리다).
 *
 * - interval: 수 간격(틱). 20틱 = 1초. 초급은 3초에 한 수, 고급은 0.5초
 * - maxWorkers: 일꾼 상한. 정원까지 다 채우면 "일꾼→확장→…" 순환에 갇혀
 *   병력을 안 뽑는 버그가 있어(실측) 정원보다 낮게 잡는다
 * - maxDefenses: 방어 건물 상한. 없으면 가난할 때 "제일 싼 수 = 포탑
 *   2코스트"만 무한히 두면서 성을 쌓는다 — 대협곡에서 포탑 ~20개로 자기
 *   램프를 막아 본진을 섬으로 만든 사건의 원인 (라운드 15)
 * - maxBases: 확장 상한. 초급은 2로 묶어 후반 물량이 아예 안 나온다
 * - useUpgrades: 강화 사용 여부
 * - armyDelay: 이 틱 전에는 병력을 안 뽑는다(방어 건물은 예외). 무저항
 *   실측에서 초급이 "경제 투자를 안 하니 싼 유닛을 바로 쏟는" 역설로
 *   오히려 제일 빨리 이겼다 — 초보자에게 필요한 건 약한 봇이 아니라
 *   **배울 시간**이다. 초반 75초를 비워 준다
 */
interface Tuning {
  interval: number;
  maxWorkers: number;
  maxDefenses: number;
  maxBases: number;
  useUpgrades: boolean;
  armyDelay: number;
}

const TUNINGS: Record<BotLevel, Tuning> = {
  easy: { interval: 60, maxWorkers: 6, maxDefenses: 2, maxBases: 2, useUpgrades: false, armyDelay: 20 * 75 },
  normal: { interval: 24, maxWorkers: 10, maxDefenses: 4, maxBases: 4, useUpgrades: true, armyDelay: 0 },
  hard: { interval: 10, maxWorkers: 16, maxDefenses: 4, maxBases: 4, useUpgrades: true, armyDelay: 0 },
};

export interface BotMove {
  kind: CommandKind;
  id: string;
  x: number;
  y: number;
}

export class Bot {
  private readonly rng: Rng;
  private readonly tune: Tuning;
  private lastTick = -999;

  constructor(seed: number, level: BotLevel = 'normal') {
    // 시뮬 RNG와 다른 스트림을 쓴다 (섞이면 디버깅이 지옥이 된다)
    this.rng = createRng((seed ^ 0xa5a5a5a5) >>> 0);
    this.tune = TUNINGS[level];
  }

  decide(s: GameState, tick: number): BotMove | null {
    if (tick - this.lastTick < this.tune.interval) return null;

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
    if (me.workers >= Math.min(this.tune.maxWorkers, workerCapacity(s, 1))) return null;
    return { kind: 'worker', id: '', x: 0, y: 0 };
  }

  /** 2순위: 확장 — 자기 진영에 가까운 빈 지점부터 채운다 */
  private expand(s: GameState): BotMove | null {
    if (s.players[1].minerals < BASE_BUILD_COST) return null;
    if (baseCount(s, 1) >= this.tune.maxBases) return null;

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
    if (!this.tune.useUpgrades) return null;
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
      baseCount(s, 1) < this.tune.maxBases && BASE_SITES.some((b) => !taken.has(b.id));
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
      if (u.kind === 'building' && defenses >= this.tune.maxDefenses) continue;
      // 초급의 유예 시간 — 병력은 나중에, 방어 건물만 허용
      if (u.kind !== 'building' && s.tick < this.tune.armyDelay) continue;
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
