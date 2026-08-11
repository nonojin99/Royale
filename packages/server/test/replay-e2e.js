/**
 * 리플레이 종단간 검증.
 *
 * 실제 서버에서 경기를 끝까지 돌린 뒤:
 *   1. 리플레이가 저장되었는가 (GET /replays, GET /replay/:id)
 *   2. 저장된 리플레이가 실제로 경기를 재현하는가 (verifyReplay)
 *   3. 재현한 결과가 클라이언트가 관측한 최종 상태와 같은가
 *
 * 3번이 핵심이다. 리플레이가 "스스로는 일관되지만 실제 경기와는 다른" 상태가
 * 되면 아무 의미가 없다.
 *
 * 경기가 자연 종료되어야 리플레이가 저장되므로 끝까지 돌려야 하는데, 양쪽이
 * 무작위로 카드를 내면 서로 막느라 0:0 무승부로 연장전까지 간다(= 4분 이상).
 * 그래서 **A만 공격하고 B는 아무것도 하지 않게** 한다. 무방비인 쪽의 타워가
 * 빠르게 무너져 경기가 일찍 끝난다.
 *
 * 실행: pnpm --filter @royale/server test:replay
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import WebSocket from 'ws';
import {
  ARENA_H,
  ARENA_W,
  ELIXIR_SCALE,
  HAND_SIZE,
  RIVER_BOT,
  SIM_DELAY_TICKS,
  TICK_MS,
  createState,
  getCard,
  hashState,
  sortCommands,
  step,
  summarizeReplay,
  verifyReplay,
} from '@royale/shared';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(HERE, '..', 'dist', 'index.js');
const PORT = 8901;
/** 경기가 끝날 때까지 기다리는 최대 시간 */
const MATCH_TIMEOUT_MS = 240_000;

class Client {
  constructor(name, deckId) {
    this.name = name;
    this.deckId = deckId;
    this.state = null;
    this.team = 0;
    this.startWallMs = 0;
    this.scheduled = new Map();
    this.over = null;
    this.resyncs = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'hello', name: this.name, deckId: this.deckId }));
        resolve();
      });
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
    });
  }

  onMessage(msg) {
    switch (msg.t) {
      case 'match':
        this.team = msg.team;
        this.startWallMs = msg.startWallMs;
        this.matchId = msg.matchId;
        this.state = createState(msg.seed, msg.decks);
        break;
      case 'cmd': {
        const cmd = { execTick: msg.execTick, team: msg.team, card: msg.card, x: msg.x, y: msg.y };
        const arr = this.scheduled.get(cmd.execTick);
        if (arr) arr.push(cmd);
        else this.scheduled.set(cmd.execTick, [cmd]);
        break;
      }
      case 'resync':
        this.resyncs++;
        break;
      case 'over':
        this.over = msg;
        break;
    }
  }

  update() {
    const s = this.state;
    if (!s) return;
    const target = Math.floor((Date.now() - this.startWallMs) / TICK_MS) - SIM_DELAY_TICKS;
    let guard = 0;
    while (s.tick < target && guard++ < 60 && !s.over) {
      const cmds = this.scheduled.get(s.tick);
      if (cmds) this.scheduled.delete(s.tick);
      step(s, cmds ? sortCommands(cmds) : []);
    }
  }

  /** 엘릭서가 차는 대로 계속 낸다 — 경기를 빨리 끝내기 위해 */
  tryPlay() {
    const s = this.state;
    if (!s || s.over) return;
    const me = s.players[this.team];
    const affordable = me.cycle
      .slice(0, HAND_SIZE)
      .filter((id) => me.elixir >= getCard(id).cost * ELIXIR_SCALE);
    if (!affordable.length) return;
    const card = affordable[Math.floor(Math.random() * affordable.length)];
    // 다리 근처에 몰아서 내면 교전이 빨리 붙는다
    const x = Math.random() < 0.5 ? 4000 : 14000;
    const y =
      this.team === 0
        ? RIVER_BOT + 500 + Math.floor(Math.random() * 2000)
        : 12000 + Math.floor(Math.random() * 2000);
    void ARENA_W;
    void ARENA_H;
    this.ws.send(JSON.stringify({ t: 'play', reqTick: s.tick, card, x, y }));
  }

  close() {
    this.ws?.close();
  }
}

async function waitForServer(proc) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch {
      /* 아직 */
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
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));

  let a;
  let b;
  try {
    await waitForServer(proc);

    a = new Client('A', 'steel');
    b = new Client('B', 'covenant');
    await a.connect();
    await b.connect();

    const md = Date.now() + 5000;
    while ((!a.state || !b.state) && Date.now() < md) await sleep(50);
    assert.ok(a.state && b.state, '매치가 성립하지 않았다');
    console.log(`▶ 매치 ${a.matchId} 진행 — 끝까지 돌린다 (최대 ${MATCH_TIMEOUT_MS / 1000}초)`);

    const started = Date.now();
    let lastPlay = 0;
    let lastLog = 0;
    while (!a.over && !b.over && Date.now() - started < MATCH_TIMEOUT_MS) {
      a.update();
      b.update();
      const now = Date.now();
      if (now - lastPlay > 350) {
        lastPlay = now;
        a.tryPlay(); // B는 무방비 — 경기를 빨리 끝내기 위한 의도적 설정
      }
      if (now - lastLog > 30_000) {
        lastLog = now;
        console.log(`  … 진행 중 (tick ${a.state.tick})`);
      }
      await sleep(10);
    }
    assert.ok(a.over, `경기가 ${MATCH_TIMEOUT_MS / 1000}초 안에 끝나지 않았다`);
    console.log(
      `▶ 경기 종료 — 승자 ${a.over.winner === -1 ? '무승부' : `team${a.over.winner}`}, ` +
        `왕관 ${a.over.crowns[0]}:${a.over.crowns[1]}, tick ${a.state.tick}`,
    );

    // 서버가 리플레이를 저장할 틈을 준다
    await sleep(500);

    /* ── 1. 목록에 올라왔는가 ── */
    const index = await (await fetch(`http://127.0.0.1:${PORT}/replays`)).json();
    assert.ok(index.replays?.length >= 1, '리플레이 목록이 비어 있다');
    const entry = index.replays.find((e) => e.id === a.matchId);
    assert.ok(entry, `방금 끝난 경기(${a.matchId})가 목록에 없다`);
    console.log(`  목록 확인 — ${entry.id}, ${(entry.bytes / 1024).toFixed(1)}KB`);

    /* ── 2. 내려받아 재현되는가 ── */
    const res = await fetch(`http://127.0.0.1:${PORT}/replay/${encodeURIComponent(a.matchId)}`);
    assert.equal(res.status, 200, '리플레이 다운로드 실패');
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      '*',
      'CORS 헤더가 없다 — 다른 도메인의 클라이언트가 못 받는다',
    );
    const replay = await res.json();

    const v = verifyReplay(replay);
    assert.ok(v.ok, `리플레이 재현 실패 — 틱 ${v.divergedAtTick} 부터 갈라짐`);
    console.log(`  재현 검증 통과 — 해시 ${v.actualHash}`);

    /* ── 3. 실제 경기와 같은가 (가장 중요) ── */
    assert.equal(
      replay.finalHash,
      hashState(a.state),
      '리플레이 최종 해시가 클라이언트가 본 경기 상태와 다르다',
    );
    assert.equal(replay.result.winner, a.over.winner, '리플레이 승자가 실제와 다르다');
    assert.deepEqual(replay.result.crowns, a.over.crowns, '리플레이 왕관 수가 실제와 다르다');
    assert.deepEqual(replay.deckIds, ['steel', 'covenant'], '덱 id가 잘못 기록됐다');
    assert.equal(a.resyncs + b.resyncs, 0, '경기 중 리싱크가 발생했다');

    const s = summarizeReplay(replay);
    console.log(
      `  요약 — ${s.deckIds[0]} ${s.playCounts[0]}장 vs ${s.deckIds[1]} ${s.playCounts[1]}장, ` +
        `${s.durationSec}초`,
    );

    /* ── 4. 없는 리플레이는 404 ── */
    const missing = await fetch(`http://127.0.0.1:${PORT}/replay/nope`);
    assert.equal(missing.status, 404, '없는 리플레이가 404를 내지 않는다');

    console.log('\n✅ 리플레이 E2E 통과 — 저장·조회·재현·실제 경기 일치 모두 확인');
  } catch (err) {
    console.error('\n❌ 리플레이 E2E 실패:', err.message);
    if (log.length) console.error('--- 서버 로그 ---\n' + log.join(''));
    process.exitCode = 1;
  } finally {
    a?.close();
    b?.close();
    proc.kill('SIGTERM');
    await sleep(200);
  }
}

await main();
