/**
 * 매치 — 권위 시뮬레이션 + 커맨드 예약/브로드캐스트.
 *
 * 서버는 메시지를 중계만 하지 않고 클라이언트와 **동일한 시뮬레이션**을 직접 돌린다.
 * 이유는 NETCODE.md 참조: 권위, 치팅 방지, 데스싱크 판정, 재접속, 리플레이.
 */

import {
  COMMAND_SCHEDULE_AHEAD,
  Command,
  CommandKind,
  GameState,
  Replay,
  SIM_DELAY_TICKS,
  ServerMsg,
  TICK_MS,
  Team,
  baseCount,
  buildReplay,
  createState,
  getFaction,
  getUnit,
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

  /** 양 팀 종족 id — 리플레이 재현에 필요하다 */
  private readonly factions: [string, string];
  private readonly playerNames: [string, string];

  /** execTick → 그 틱에 실행될 커맨드들 */
  private readonly scheduled = new Map<number, Command[]>();
  /** tick → 그 틱 종료 시점의 상태 해시 */
  private readonly hashes = new Map<number, number>();
  /** 리플레이용 — 확정된 모든 커맨드를 순서대로 누적한다 */
  private readonly recorded: Command[] = [];
  private ended = false;

  constructor(
    a: Conn,
    b: Conn | null,
    botFactionId?: string,
    /** 경기가 정상 종료되면 리플레이를 넘겨받는 콜백 */
    private readonly onReplay?: (r: Replay) => void,
  ) {
    this.id = `m${++matchSeq}-${Date.now().toString(36)}`;
    // 시드는 서버가 정해 양쪽에 동일하게 배포한다
    this.seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
    this.startWallMs = Date.now();

    const f0 = getFaction(a.factionId);
    const f1 = getFaction(b ? b.factionId : botFactionId);
    this.factions = [f0.id, f1.id];
    this.playerNames = [a.name, b ? b.name : `봇 (${f1.name})`];

    this.state = createState(this.seed, this.factions);
    this.conns = [a, b];
    this.bot = b === null ? new Bot(this.seed) : null;

    a.match = this;
    a.team = 0;
    if (b) {
      b.match = this;
      b.team = 1;
    }

    for (const c of this.conns) {
      if (!c) continue;
      c.send({
        t: 'match',
        matchId: this.id,
        seed: this.seed,
        team: c.team as Team,
        factions: this.factions,
        opponent: b === null ? this.playerNames[1] : this.other(c)?.name ?? '???',
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

  /**
   * 행동 요청을 미래 틱에 예약하고 양쪽에 브로드캐스트한다.
   *
   * 여기서는 자원·해금·배치구역을 검증하지 **않는다.** 검증은 execTick에 도달했을 때
   * applyCommand가 서버와 두 클라이언트에서 각각 동일하게 수행하므로, 부정한
   * 요청은 세 곳 모두에서 똑같이 무시된다. 즉 결정론이 곧 치팅 방지 장치다.
   */
  scheduleAct(
    team: Team,
    kind: CommandKind,
    id: string,
    x: number,
    y: number,
    reqTick: number,
  ): void {
    if (this.ended) return;

    // 알 수 없는 유닛 id는 시뮬이 예외를 던질 수 있으므로 여기서만은 미리 거른다
    if (kind === 'unit' || kind === 'tech') {
      try {
        getUnit(id);
      } catch {
        this.conns[team]?.send({ t: 'reject', reqTick, reason: 'unknown-unit' });
        return;
      }
    }

    const execTick = Math.max(
      this.nowTick() + COMMAND_SCHEDULE_AHEAD,
      this.state.tick + 1,
    );
    const cmd: Command = {
      execTick,
      team,
      kind,
      id: kind === 'base' ? '' : id,
      x: Math.round(x),
      y: Math.round(y),
    };

    const arr = this.scheduled.get(execTick);
    if (arr) arr.push(cmd);
    else this.scheduled.set(execTick, [cmd]);
    this.recorded.push(cmd);

    this.broadcast({
      t: 'cmd',
      execTick,
      team,
      kind: cmd.kind,
      id: cmd.id,
      x: cmd.x,
      y: cmd.y,
    });
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
    this.scheduleAct(1, move.kind, move.id, move.x, move.y, tick);
  }

  /** 클라가 보고한 해시를 서버 것과 대조한다. 어긋나면 스냅샷으로 리싱크시킨다. */
  checkHash(c: Conn, tick: number, hash: number): void {
    const mine = this.hashes.get(tick);
    if (mine === undefined) return;
    if (mine === hash) {
      c.desyncs = 0;
      return;
    }
    c.desyncs++;
    console.warn(
      `[desync] match=${this.id} team=${c.team} tick=${tick} client=${hash} server=${mine}`,
    );
    c.send({
      t: 'resync',
      tick: this.state.tick,
      state: JSON.parse(JSON.stringify(this.state)),
    });
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.broadcast({
      t: 'over',
      winner: this.state.winner,
      bases: [baseCount(this.state, 0), baseCount(this.state, 1)],
      mined: [this.state.players[0].mined, this.state.players[1].mined],
    });
    for (const c of this.conns) {
      if (c) c.match = null;
    }
    this.emitReplay();
  }

  /**
   * 정상 종료된 경기만 리플레이로 남긴다.
   * 중간에 나간 경기는 분석에 노이즈가 되고 재현해도 의미가 없다.
   */
  private emitReplay(): void {
    if (!this.onReplay) return;
    try {
      const replay = buildReplay({
        matchId: this.id,
        seed: this.seed,
        factions: this.factions,
        players: this.playerNames,
        commands: this.recorded,
        createdAt: this.startWallMs,
      });

      // 저장 시점에 재현성을 확인한다. 여기서 어긋나면 저장된 커맨드만으로는
      // 경기를 되살릴 수 없다는 뜻이라, 조용히 넘어가면 원인을 영영 못 찾는다.
      if (replay.finalHash !== hashState(this.state)) {
        console.error(
          `[replay] ${this.id}: 재현 결과가 서버 상태와 다르다 ` +
            `(replay=${replay.finalHash} server=${hashState(this.state)}) — 저장은 하되 검증 필요`,
        );
      }
      this.onReplay(replay);
    } catch (err) {
      console.error(`[replay] ${this.id}: 생성 실패`, err);
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
}
