/**
 * 연습 모드 상대.
 *
 * 봇의 수는 **일반 플레이어의 커맨드와 똑같은 경로**로 예약·브로드캐스트된다.
 * 따라서 클라이언트는 봇의 존재를 알 필요가 없고, 결정론에도 영향이 없다.
 * (봇의 내부 RNG는 서버에만 있고 시뮬 상태에 들어가지 않는다.)
 *
 * v1 전략: "엘릭서가 차면 상황에 맞는 카드를 낸다" 수준의 규칙 기반.
 * 강한 AI는 M4 이후의 과제다.
 */

import {
  ARENA_W,
  ELIXIR_SCALE,
  GameState,
  HAND_SIZE,
  RIVER_TOP,
  Rng,
  createRng,
  getCard,
  nextInt,
  nextRange,
  tiles,
} from '@royale/shared';

/** 봇이 수를 두는 최소 간격 (틱) */
const MIN_INTERVAL = 30;

export interface BotMove {
  card: string;
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
    const hand = me.cycle.slice(0, HAND_SIZE);

    // 낼 수 있는 카드 중 가장 비싼 것을 고른다 (엘릭서를 흘리지 않도록)
    let best: string | null = null;
    let bestCost = -1;
    for (const id of hand) {
      const c = getCard(id);
      const cost = c.cost * ELIXIR_SCALE;
      if (me.elixir < cost) continue;
      if (c.cost > bestCost) {
        bestCost = c.cost;
        best = id;
      }
    }
    if (!best) return null;

    // 엘릭서를 8 이상 모았을 때만 공격적으로 움직인다
    if (me.elixir < 7 * ELIXIR_SCALE && nextInt(this.rng, 3) !== 0) return null;

    const card = getCard(best);
    this.lastTick = tick;

    // 주문은 적(팀 0) 유닛이 뭉친 곳에, 그 외에는 자기 진영 다리 앞에 배치
    if (card.kind === 'spell') {
      const target = this.densestEnemyCluster(s);
      if (!target) return null;
      return { card: best, x: target[0], y: target[1] };
    }

    const lane = nextInt(this.rng, 2);
    const x = lane === 0 ? nextRange(this.rng, tiles(2), tiles(6)) : nextRange(this.rng, tiles(12), tiles(16));
    const y = nextRange(this.rng, tiles(9), RIVER_TOP - tiles(1));
    return { card: best, x: Math.min(x, ARENA_W - tiles(1)), y };
  }

  /** 팀 0 유닛이 가장 많이 뭉친 지점 (주문 타겟팅용) */
  private densestEnemyCluster(s: GameState): [number, number] | null {
    const units = s.entities.filter((e) => e.team === 0 && e.kind === 'unit');
    if (units.length === 0) return null;

    let bestIdx = 0;
    let bestCount = -1;
    const r = tiles(3);
    for (let i = 0; i < units.length; i++) {
      let count = 0;
      for (const o of units) {
        const dx = o.x - units[i].x;
        const dy = o.y - units[i].y;
        if (dx * dx + dy * dy <= r * r) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestIdx = i;
      }
    }
    // 유닛 하나 잡자고 주문을 쓰진 않는다
    if (bestCount < 2) return null;
    return [units[bestIdx].x, units[bestIdx].y];
  }
}
