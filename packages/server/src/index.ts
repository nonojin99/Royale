/**
 * 게임 서버.
 *
 *   - WebSocket으로 커맨드를 받아 미래 틱에 예약하고 양쪽에 브로드캐스트
 *   - 클라이언트와 동일한 시뮬레이션을 20Hz로 직접 실행 (권위)
 *   - 클라가 보고한 상태 해시를 대조해 데스싱크를 감지
 *
 * 상세: docs/NETCODE.md
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { ClientMsg, DECK_IDS, TICK_MS, Team, getDeck } from '@royale/shared';

import { Conn } from './conn.js';
import { Match } from './match.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

/** 대기열 (선착순 2명씩 매칭) */
const queue: Conn[] = [];
/** 진행 중인 매치 */
const matches = new Set<Match>();

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        matches: matches.size,
        queued: queue.length,
        uptime: Math.floor(process.uptime()),
      }),
    );
    return;
  }
  res.writeHead(404).end('royale game server');
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws, req) => {
  const conn = new Conn(ws);
  // ?solo=1 이면 대기열 없이 봇과 바로 매칭한다 (혼자 개발/테스트할 때 필수)
  const solo = /[?&]solo=1/.test(req.url ?? '');

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return;
    }
    handle(conn, msg, solo);
  });

  ws.on('close', () => {
    conn.alive = false;
    const i = queue.indexOf(conn);
    if (i >= 0) queue.splice(i, 1);
    if (conn.match) {
      conn.match.onLeave(conn);
      matches.delete(conn.match);
    }
  });

  ws.on('error', () => {
    /* close 핸들러가 정리한다 */
  });
});

function handle(conn: Conn, msg: ClientMsg, solo: boolean): void {
  switch (msg.t) {
    case 'hello': {
      conn.name = String(msg.name ?? '익명').slice(0, 20) || '익명';
      // 알 수 없는 덱 id는 getDeck이 기본 덱으로 떨어뜨린다
      conn.deckId = getDeck(msg.deckId).id;
      if (conn.match) return;
      if (solo) {
        // 연습 모드 봇은 플레이어와 다른 덱을 쓴다 — 같은 덱만 상대하면
        // 대공 대응 같은 매치업 학습이 안 된다
        const botDeck = DECK_IDS[Math.floor(Math.random() * DECK_IDS.length)];
        matches.add(new Match(conn, null, botDeck));
        return;
      }
      queue.push(conn);
      conn.send({ t: 'queued' });
      tryMatch();
      return;
    }

    case 'play': {
      const m = conn.match;
      if (!m || m.isEnded) {
        conn.send({ t: 'reject', reqTick: msg.reqTick, reason: 'not-playing' });
        return;
      }
      m.schedulePlay(conn.team as Team, msg.card, msg.x, msg.y, msg.reqTick);
      return;
    }

    case 'hash': {
      conn.match?.checkHash(conn, msg.tick, msg.hash);
      return;
    }

    case 'ping': {
      conn.send({ t: 'pong', ts: msg.ts, serverTick: conn.match ? conn.match.nowTick() : 0 });
      return;
    }
  }
}

function tryMatch(): void {
  while (queue.length >= 2) {
    const a = queue.shift()!;
    const b = queue.shift()!;
    if (!a.alive) {
      if (b.alive) queue.unshift(b);
      continue;
    }
    if (!b.alive) {
      queue.unshift(a);
      continue;
    }
    matches.add(new Match(a, b));
    console.log(`[match] ${a.name} vs ${b.name}`);
  }
}

/**
 * 전역 틱 루프.
 *
 * 매치마다 타이머를 두지 않고 하나의 루프에서 전부 돌린다. 각 매치는 자신의
 * 벽시계 기준 목표 틱까지 따라잡으므로, 타이머 지터가 시뮬 결과에 영향을 주지 않는다.
 */
setInterval(() => {
  for (const m of matches) {
    try {
      m.advance();
    } catch (err) {
      console.error(`[match ${m.id}] 시뮬 오류`, err);
      m.onLeave(m.conns[0]!);
      matches.delete(m);
      continue;
    }
    if (m.isEnded) matches.delete(m);
  }
}, TICK_MS);

http.listen(PORT, HOST, () => {
  console.log(`royale server on ws://${HOST}:${PORT}  (tick ${1000 / TICK_MS}Hz)`);
});
