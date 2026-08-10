/**
 * 종단간 넷코드 검증.
 *
 * 진짜 서버 프로세스를 띄우고, 서로 다른 두 개의 WebSocket 클라이언트가 각자
 * 독립적으로 시뮬레이션을 돌리게 한다. 양쪽이 카드를 마구 내는 동안:
 *
 *   1. 두 클라이언트의 상태 해시가 같은 틱에서 일치하는가?
 *   2. 서버가 리싱크를 한 번이라도 보냈는가? (보냈다면 시뮬에 버그가 있다)
 *
 * 단위 테스트(determinism.test.js)는 같은 프로세스 안에서의 결정론만 증명한다.
 * 이 테스트는 "서버가 예약한 커맨드가 양쪽에 제때 도착해서 같은 틱에 실행되는가"
 * 라는, 실제로 깨지기 쉬운 부분을 검증한다.
 *
 * 실행: pnpm --filter @royale/server test:e2e
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import WebSocket from 'ws';
import {
  HASH_INTERVAL,
  SIM_DELAY_TICKS,
  TICK_MS,
  createState,
  getCard,
  hashState,
  sortCommands,
  step,
  ELIXIR_SCALE,
  HAND_SIZE,
  RIVER_BOT,
  ARENA_H,
  ARENA_W,
} from '@royale/shared';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(HERE, '..', 'dist', 'index.js');
const PORT = 8899;

/**
 * 이 틱에서 두 클라이언트의 해시를 비교한다.
 * 20초(400틱)면 엘릭서 경제상 양쪽이 6~7장을 낼 수 있어 교전이 충분히 벌어진다.
 */
const COMPARE_TICK = 400;
/** 엘릭서 수급으로 이 시간 안에 낼 수 있는 최소 장수 (5 + 400*18/1000 ≈ 12 엘릭서) */
const MIN_PLAYS = 3;

/* ── 헤드리스 클라이언트 ───────────────────────────────────────────────── */

class HeadlessClient {
  constructor(name, deckId) {
    this.name = name;
    this.deckId = deckId;
    this.state = null;
    this.team = 0;
    this.startWallMs = 0;
    this.scheduled = new Map();
    this.hashAt = new Map();
    this.resyncs = 0;
    this.rejects = 0;
    this.plays = 0;
    this.done = false;
    this.error = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'hello', name: this.name, deckId: this.deckId }));
        resolve();
      });
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        try {
          this.onMessage(JSON.parse(raw.toString()));
        } catch (err) {
          this.error = err;
        }
      });
    });
  }

  onMessage(msg) {
    switch (msg.t) {
      case 'match':
        this.team = msg.team;
        this.startWallMs = msg.startWallMs;
        this.matchDeckIds = msg.deckIds;
        this.state = createState(msg.seed, msg.decks);
        break;
      case 'cmd': {
        const cmd = {
          execTick: msg.execTick,
          team: msg.team,
          card: msg.card,
          x: msg.x,
          y: msg.y,
        };
        if (this.state && cmd.execTick <= this.state.tick) {
          this.error = new Error(
            `지각 커맨드: execTick=${cmd.execTick} 인데 이미 tick=${this.state.tick}`,
          );
        }
        const arr = this.scheduled.get(cmd.execTick);
        if (arr) arr.push(cmd);
        else this.scheduled.set(cmd.execTick, [cmd]);
        break;
      }
      case 'resync':
        this.resyncs++;
        break;
      case 'reject':
        this.rejects++;
        break;
      case 'over':
        this.done = true;
        break;
    }
  }

  leadTick() {
    if (!this.startWallMs) return 0;
    return Math.floor((Date.now() - this.startWallMs) / TICK_MS);
  }

  update() {
    const s = this.state;
    if (!s) return;
    const target = this.leadTick() - SIM_DELAY_TICKS;
    let guard = 0;
    while (s.tick < target && guard++ < 40) {
      const cmds = this.scheduled.get(s.tick);
      if (cmds) this.scheduled.delete(s.tick);
      step(s, cmds ? sortCommands(cmds) : []);

      if (s.tick % HASH_INTERVAL === 0) {
        this.hashAt.set(s.tick, hashState(s));
        this.ws.send(JSON.stringify({ t: 'hash', tick: s.tick, hash: hashState(s) }));
      }
      if (s.tick === COMPARE_TICK) this.hashAt.set(COMPARE_TICK, hashState(s));
      if (s.over) {
        this.done = true;
        break;
      }
    }
  }

  /** 손패에서 낼 수 있는 카드를 아무거나 내 진영에 배치한다 */
  tryPlay() {
    const s = this.state;
    if (!s) return;
    const me = s.players[this.team];
    const affordable = me.cycle
      .slice(0, HAND_SIZE)
      .filter((id) => me.elixir >= getCard(id).cost * ELIXIR_SCALE);
    if (affordable.length === 0) return;

    const card = affordable[Math.floor(Math.random() * affordable.length)];
    const x = 1000 + Math.floor(Math.random() * (ARENA_W - 2000));
    const y =
      this.team === 0
        ? RIVER_BOT + 500 + Math.floor(Math.random() * (ARENA_H - RIVER_BOT - 3000))
        : 2000 + Math.floor(Math.random() * 10000);

    this.ws.send(JSON.stringify({ t: 'play', reqTick: s.tick, card, x, y }));
    this.plays++;
  }

  close() {
    this.ws?.close();
  }
}

/* ── 실행 ──────────────────────────────────────────────────────────────── */

async function waitForServer(proc) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch {
      /* 아직 안 떴다 */
    }
    if (proc.exitCode !== null) throw new Error('서버가 시작하자마자 종료됨');
    await sleep(150);
  }
  throw new Error('서버가 10초 안에 뜨지 않음');
}

async function main() {
  console.log('▶ 서버 기동…');
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  proc.stdout.on('data', (d) => serverLog.push(String(d)));
  proc.stderr.on('data', (d) => serverLog.push(String(d)));

  let a;
  let b;
  try {
    await waitForServer(proc);
    console.log('▶ 클라이언트 2개 접속…');

    // 서로 다른 덱으로 붙인다. 비대칭 덱은 양쪽 시뮬이 서로 다른 카드 테이블을
    // 참조한다는 뜻이라, 미러전보다 훨씬 깨지기 쉬운 조건이다.
    a = new HeadlessClient('A', 'steel');
    b = new HeadlessClient('B', 'swarmhive');
    await a.connect();
    await b.connect();

    // 매치 성립 대기
    const matchDeadline = Date.now() + 5000;
    while ((!a.state || !b.state) && Date.now() < matchDeadline) await sleep(50);
    assert.ok(a.state && b.state, '5초 안에 매치가 성립하지 않았다');
    assert.notEqual(a.team, b.team, '두 클라이언트가 같은 팀을 배정받았다');

    // 양쪽이 같은 덱 구성을 받아야 한다 — 여기가 어긋나면 시뮬이 시작부터 갈라진다
    assert.deepEqual(
      a.state.players.map((p) => p.cycle),
      b.state.players.map((p) => p.cycle),
      '두 클라이언트가 서로 다른 덱 구성으로 시작했다',
    );
    assert.deepEqual(a.matchDeckIds, b.matchDeckIds, 'deckIds가 양쪽에 다르게 전달됐다');
    assert.notEqual(
      a.matchDeckIds[0],
      a.matchDeckIds[1],
      '비대칭 덱을 요청했는데 같은 덱으로 매칭됐다',
    );
    console.log(
      `▶ 매치 성립 (A=team${a.team}, B=team${b.team}, ` +
        `덱=${a.matchDeckIds[0]} vs ${a.matchDeckIds[1]}). 시뮬 진행…`,
    );

    // 시뮬 루프 + 주기적 카드 배치
    const started = Date.now();
    let lastPlay = 0;
    while (Date.now() - started < 25_000) {
      a.update();
      b.update();
      if (a.error) throw a.error;
      if (b.error) throw b.error;

      const now = Date.now();
      if (now - lastPlay > 400) {
        lastPlay = now;
        a.tryPlay();
        b.tryPlay();
      }
      if (a.hashAt.has(COMPARE_TICK) && b.hashAt.has(COMPARE_TICK)) break;
      if (a.done || b.done) break;
      await sleep(10);
    }

    /* ── 검증 ── */
    const ha = a.hashAt.get(COMPARE_TICK);
    const hb = b.hashAt.get(COMPARE_TICK);
    assert.ok(ha !== undefined && hb !== undefined, `tick ${COMPARE_TICK} 에 도달하지 못했다`);

    console.log(`  tick ${COMPARE_TICK} 해시 → A=${ha} B=${hb}`);
    console.log(`  배치 시도: A=${a.plays} B=${b.plays} / 리싱크: A=${a.resyncs} B=${b.resyncs}`);
    console.log(`  최종 엔티티 수: A=${a.state.entities.length} B=${b.state.entities.length}`);

    assert.equal(ha, hb, '★ 두 클라이언트의 상태가 갈라졌다 (데스싱크)');
    assert.equal(a.resyncs, 0, '서버가 A에게 리싱크를 보냈다 = 서버와 상태가 달랐다');
    assert.equal(b.resyncs, 0, '서버가 B에게 리싱크를 보냈다 = 서버와 상태가 달랐다');
    assert.ok(
      a.plays >= MIN_PLAYS && b.plays >= MIN_PLAYS,
      `카드를 충분히 내지 못해 검증이 의미 없다 (A=${a.plays}, B=${b.plays})`,
    );
    // 타워 6개 외에 실제 유닛이 존재해야 교전을 검증한 것이다
    assert.ok(
      a.state.entities.length > 6,
      '유닛이 하나도 살아남지 않아 교전 검증이 되지 않았다',
    );

    // 여러 틱에서 교차 검증
    let compared = 0;
    for (const [tick, hash] of a.hashAt) {
      const other = b.hashAt.get(tick);
      if (other === undefined) continue;
      assert.equal(hash, other, `tick ${tick} 에서 해시 불일치`);
      compared++;
    }
    console.log(`  공통 틱 ${compared}개에서 해시 전부 일치`);

    console.log('\n✅ E2E 통과 — 두 클라이언트와 서버가 완전히 동일한 시뮬레이션을 유지했다');
  } catch (err) {
    console.error('\n❌ E2E 실패:', err.message);
    if (serverLog.length) console.error('--- 서버 로그 ---\n' + serverLog.join(''));
    process.exitCode = 1;
  } finally {
    a?.close();
    b?.close();
    proc.kill('SIGTERM');
    await sleep(200);
  }
}

await main();
