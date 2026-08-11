/**
 * 종단간 넷코드 검증.
 *
 * 진짜 서버 프로세스를 띄우고, 서로 다른 두 개의 WebSocket 클라이언트가 각자
 * 독립적으로 시뮬레이션을 돌리게 한다. 양쪽이 확장하고 병력을 뽑는 동안:
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
  BASE_BUILD_COST,
  BASE_SITES,
  DEPLOY_RADIUS,
  HASH_INTERVAL,
  MINERAL_SCALE,
  SIM_DELAY_TICKS,
  TICK_MS,
  baseCount,
  canDeployAt,
  createState,
  getUnit,
  hashState,
  occupiedSites,
  ownBasePositions,
  sortCommands,
  step,
} from '@royale/shared';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(HERE, '..', 'dist', 'index.js');
const PORT = 8899;

/**
 * 이 틱에서 두 클라이언트의 해시를 비교한다.
 * 20초(400틱)면 채굴 수입으로 확장 한 번 + 병력 여러 기를 낼 수 있다.
 */
const COMPARE_TICK = 400;
/** 이 시간 안에 최소한 이만큼은 행동해야 검증이 의미 있다 */
const MIN_PLAYS = 3;

/* ── 헤드리스 클라이언트 ───────────────────────────────────────────────── */

class HeadlessClient {
  constructor(name, factionId) {
    this.name = name;
    this.factionId = factionId;
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
        this.ws.send(JSON.stringify({ t: 'hello', name: this.name, factionId: this.factionId }));
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
        this.matchFactions = msg.factions;
        this.state = createState(msg.seed, msg.factions);
        break;
      case 'cmd': {
        const cmd = {
          execTick: msg.execTick,
          team: msg.team,
          kind: msg.kind,
          id: msg.id,
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

  /**
   * 매크로 게임의 기본 우선순위를 따라 행동한다:
   * 자원이 충분하면 확장하고, 아니면 해금된 유닛을 기지 앞에 뽑는다.
   */
  tryPlay() {
    const s = this.state;
    if (!s || s.over) return;
    const me = s.players[this.team];

    // 확장 — 빈 지점이 있고 여유가 있으면
    if (me.minerals >= BASE_BUILD_COST * 2 && baseCount(s, this.team) < 3) {
      const taken = occupiedSites(s);
      const free = BASE_SITES.filter((b) => !taken.has(b.id));
      if (free.length) {
        const site = free[Math.floor(Math.random() * free.length)];
        this.ws.send(
          JSON.stringify({ t: 'act', reqTick: s.tick, kind: 'base', id: '', x: site.x, y: site.y }),
        );
        this.plays++;
        return;
      }
    }

    // 병력 — 해금된 것 중 낼 수 있는 것을 기지 반경 안에 낸다
    const bases = ownBasePositions(s, this.team);
    if (!bases.length) return;
    const affordable = me.unlocked.filter(
      (id) => me.minerals >= getUnit(id).cost * MINERAL_SCALE,
    );
    if (!affordable.length) return;

    const id = affordable[Math.floor(Math.random() * affordable.length)];
    const base = bases[Math.floor(Math.random() * bases.length)];
    for (let i = 0; i < 8; i++) {
      const x = base[0] + Math.floor(Math.random() * DEPLOY_RADIUS) - DEPLOY_RADIUS / 2;
      const y = base[1] + Math.floor(Math.random() * DEPLOY_RADIUS) - DEPLOY_RADIUS / 2;
      if (!canDeployAt(x, y, bases)) continue;
      this.ws.send(JSON.stringify({ t: 'act', reqTick: s.tick, kind: 'unit', id, x, y }));
      this.plays++;
      return;
    }
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

    // 서로 다른 종족으로 붙인다. 비대칭 대전은 양쪽 시뮬이 서로 다른 테크트리와
    // 유닛 테이블을 참조한다는 뜻이라, 미러전보다 훨씬 깨지기 쉬운 조건이다.
    a = new HeadlessClient('A', 'steel');
    b = new HeadlessClient('B', 'swarmhive');
    await a.connect();
    await b.connect();

    // 매치 성립 대기
    const matchDeadline = Date.now() + 5000;
    while ((!a.state || !b.state) && Date.now() < matchDeadline) await sleep(50);
    assert.ok(a.state && b.state, '5초 안에 매치가 성립하지 않았다');
    assert.notEqual(a.team, b.team, '두 클라이언트가 같은 팀을 배정받았다');

    // 양쪽이 같은 종족 구성을 받아야 한다 — 어긋나면 시뮬이 시작부터 갈라진다
    assert.deepEqual(
      a.state.players.map((p) => p.unlocked),
      b.state.players.map((p) => p.unlocked),
      '두 클라이언트가 서로 다른 해금 상태로 시작했다',
    );
    assert.deepEqual(a.matchFactions, b.matchFactions, 'factions가 양쪽에 다르게 전달됐다');
    assert.notEqual(
      a.matchFactions[0],
      a.matchFactions[1],
      '이종족을 요청했는데 같은 종족으로 매칭됐다',
    );
    console.log(
      `▶ 매치 성립 (A=team${a.team}, B=team${b.team}, ` +
        `종족=${a.matchFactions[0]} vs ${a.matchFactions[1]}). 시뮬 진행…`,
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
    // 본진 2개 외에 실제 유닛/기지가 생겨야 교전을 검증한 것이다
    assert.ok(
      a.state.entities.length > 2,
      '엔티티가 늘지 않아 검증이 의미 없다',
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
