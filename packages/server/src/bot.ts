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
  WORKER_COST,
  CommandKind,
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
  workerCapacity,
} from '@royale/shared';

/** 봇이 수를 두는 최소 간격 (틱) */
const MIN_INTERVAL = 24;
/** 이 이상 기지를 늘리지는 않는다 */
const MAX_BASES = 4;

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
    const move = this.train(s) ?? this.expand(s) ?? this.research(s) ?? this.produce(s, me);
    if (move) this.lastTick = tick;
    return move;
  }

  /** 1순위: 일꾼 — 정원이 빌 때까지 채운다. 경제가 모든 것의 기반이다 */
  private train(s: GameState): BotMove | null {
    const me = s.players[1];
    if (me.minerals < WORKER_COST) return null;
    if (me.workers >= workerCapacity(s, 1)) return null;
    return { kind: 'worker', id: '', x: 0, y: 0 };
  }

  /** 2순위: 확장 — 자기 진영에 가까운 빈 지점부터 채운다 */
  private expand(s: GameState): BotMove | null {
    if (s.players[1].minerals < BASE_BUILD_COST) return null;
    if (baseCount(s, 1) >= MAX_BASES) return null;

    const taken = occupiedSites(s);
    // 팀 1은 위쪽이므로 y가 작은 지점을 선호한다
    const candidates = BASE_SITES.filter((b) => !taken.has(b.id)).sort((a, b) => a.y - b.y);
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

  /** 4순위: 병력 — 해금된 것 중 가장 비싼 것을 자기 기지 앞에 낸다 */
  private produce(s: GameState, me: GameState['players'][number]): BotMove | null {
    const bases = ownBasePositions(s, 1);
    if (bases.length === 0) return null;

    let best: string | null = null;
    let bestCost = -1;
    for (const id of me.unlocked) {
      if (!isUnlocked(me, id)) continue;
      const u = getUnit(id);
      if (me.minerals < u.cost * MINERAL_SCALE) continue;
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
