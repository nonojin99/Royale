/**
 * 매치 — 권위 시뮬레이션 + 커맨드 예약/브로드캐스트.
 *
 * 서버는 메시지를 중계만 하지 않고 클라이언트와 **동일한 시뮬레이션**을 직접 돌린다.
 * 이유는 NETCODE.md §4 참조: 권위, 치팅 방지, 데스싱크 판정, 재접속, 리플레이.
 */

import {
  COMMAND_SCHEDULE_AHEAD,
  Command,
  DEFAULT_DECK,
  ELIXIR_SCALE,
  GameState,
  HAND_SIZE,
  SIM_DELAY_TICKS,
  ServerMsg,
  TICK_MS,
  Team,
  createState,
  getCard,
  hashState,
  sortCommands,
  step,
} from '@royale/shared';

import { Conn } from './conn.js';
import { Bot } from './bot.js';

/** 한 번의 advance()에서 진행할 수 있는 최대 틱 수 (서버 히컵 시 폭주 방지) */
const MAX_CATCHUP_TICKS = 40;
/** 데스싱크 판정을 위해 보관하는 과거 해시 개수 */
const HASH_HISTORY = 200;

let matchSeq = 0;

export class Match {
  readonly id: string;
  readonly seed: number;
  readonly startWallMs: number;
  readonly state: GameState;
  readonly conns: (Conn | null)[];
  readonly bot: Bot | null;

  /** execTick → 그 틱에 실행될 커맨드들 */
  private readonly scheduled = new Map<number, Command[]>();
  /** tick → 그 틱 종료 시점의 상태 해시 */
  private readonly hashes = new Map<number, number>();
  private ended = false;

  constructor(a: Conn, b: Conn | null) {
    this.id = `m${++matchSeq}-${Date.now().toString(36)}`;
    // 시드는 서버가 정해 양쪽에 동일하게 배포한다
    this.seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
    this.startWallMs = Date.now();
    this.state = createState(this.seed, [DEFAULT_DECK, DEFAULT_DECK]);
    this.conns = [a, b];
    this.bot = b === null ? new Bot(this.seed) : null;

    a.match = this;
    a.team = 0;
    if (b) {
      b.match = this;
      b.team = 1;
    }

    const decks: [string[], string[]] = [DEFAULT_DECK.slice(), DEFAULT_DECK.slice()];
    for (const c of this.conns) {
      if (!c) continue;
      c.send({
        t: 'match',
        matchId: this.id,
        seed: this.seed,
        team: c.team as Team,
        decks,
        opponent: b === null ? '연습 상대' : this.other(c)?.name ?? '???',
        startWallMs: this.startWallMs,
      });
    }
  }

  private other(c: Conn): Conn | null {
    return this.conns[c.team === 0 ? 1 : 0];
  }

  broadcast(msg: ServerMsg): void {
    for (const c of this.conns) c?.send(msg);
  }

  /** 지금 이 순간의 "선두 틱" — 시뮬레이션은 이보다 SIM_DELAY_TICKS 만큼 뒤처져 있다 */
  nowTick(): number {
    return Math.floor((Date.now() - this.startWallMs) / TICK_MS);
  }

  serverTick(): number {
    return this.state.tick;
  }

  /**
   * 카드 배치 요청을 미래 틱에 예약하고 양쪽에 브로드캐스트한다.
   *
   * 여기서는 엘릭서/손패를 검증하지 **않는다.** 검증은 execTick에 도달했을 때
   * applyCommand가 서버와 두 클라이언트에서 각각 동일하게 수행하므로, 부정한
   * 요청은 세 곳 모두에서 똑같이 무시된다. 즉 결정론이 곧 치팅 방지 장치다.
   */
  schedulePlay(team: Team, card: string, x: number, y: number, reqTick: number): void {
    if (this.ended) return;

    // 알 수 없는 카드 id는 시뮬이 예외를 던지므로 여기서만은 미리 거른다
    try {
      getCard(card);
    } catch {
      this.conns[team]?.send({ t: 'reject', reqTick, reason: 'unknown-card' });
      return;
    }

    const execTick = Math.max(
      this.nowTick() + COMMAND_SCHEDULE_AHEAD,
      this.state.tick + 1,
    );
    const cmd: Command = { execTick, team, card, x: Math.round(x), y: Math.round(y) };

    const arr = this.scheduled.get(execTick);
    if (arr) arr.push(cmd);
    else this.scheduled.set(execTick, [cmd]);

    this.broadcast({ t: 'cmd', execTick, team, card, x: cmd.x, y: cmd.y });
  }

  /** 벽시계를 따라 시뮬레이션을 진행시킨다 */
  advance(): void {
    if (this.ended) return;

    const target = this.nowTick() - SIM_DELAY_TICKS;
    let steps = 0;
    while (this.state.tick < target && steps < MAX_CATCHUP_TICKS) {
      const tick = this.state.tick;

      if (this.bot) this.botTurn(tick);

      const cmds = this.scheduled.get(tick);
      if (cmds) this.scheduled.delete(tick);
      step(this.state, cmds ? sortCommands(cmds) : []);
      steps++;

      this.hashes.set(this.state.tick, hashState(this.state));
      if (this.hashes.size > HASH_HISTORY) {
        // 가장 오래된 항목 제거 (Map은 삽입 순서를 유지한다)
        const oldest = this.hashes.keys().next();
        if (!oldest.done) this.hashes.delete(oldest.value);
      }

      if (this.state.over) {
        this.finish();
        return;
      }
    }
  }

  /** 연습 모드 봇의 수. 일반 커맨드로 브로드캐스트되므로 결정론에 영향이 없다. */
  private botTurn(tick: number): void {
    if (!this.bot) return;
    const move = this.bot.decide(this.state, tick);
    if (!move) return;
    const p = this.state.players[1];
    if (p.elixir < getCard(move.card).cost * ELIXIR_SCALE) return;
    this.schedulePlay(1, move.card, move.x, move.y, tick);
  }

  /** 클라가 보고한 해시를 서버 것과 대조한다. 어긋나면 스냅샷으로 리싱크시킨다. */
  checkHash(c: Conn, tick: number, hash: number): void {
    const mine = this.hashes.get(tick);
    if (mine === undefined) return; // 너무 오래됐거나 아직 도달 전 — 판정 불가
    if (mine === hash) {
      c.desyncs = 0;
      return;
    }
    c.desyncs++;
    console.warn(
      `[desync] match=${this.id} team=${c.team} tick=${tick} client=${hash} server=${mine}`,
    );
    c.send({ t: 'resync', tick: this.state.tick, state: JSON.parse(JSON.stringify(this.state)) });
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.broadcast({
      t: 'over',
      winner: this.state.winner,
      crowns: [this.state.players[0].crowns, this.state.players[1].crowns],
    });
    for (const c of this.conns) {
      if (c) c.match = null;
    }
  }

  /** 한쪽이 나갔을 때 */
  onLeave(c: Conn): void {
    if (this.ended) return;
    const o = this.other(c);
    o?.send({ t: 'opponent-left' });
    this.ended = true;
    if (o) o.match = null;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** 디버그/관전용: 현재 손패 */
  handOf(team: Team): string[] {
    return this.state.players[team].cycle.slice(0, HAND_SIZE);
  }
}
