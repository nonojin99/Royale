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
import type { ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';

import { ClientMsg, DEFAULT_MAP_ID, FACTION_IDS, Replay, TICK_MS, Team, getFaction, getMap } from '@royale/shared';

import { Conn } from './conn.js';
import { Match } from './match.js';
import { ReplayStore } from './replays.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
/** 설정하면 리플레이를 디스크에도 쓴다 (미설정 시 메모리 전용) */
const REPLAY_DIR = process.env.REPLAY_DIR;

/** 대기열 (선착순 2명씩 매칭) */
/** 진행 중인 매치 */
const matches = new Set<Match>();
const replays = new ReplayStore(Number(process.env.REPLAY_KEEP ?? 50), REPLAY_DIR);

/**
 * 클라이언트는 정적 호스팅(GitHub Pages)에서, 서버는 Fly.io에서 돌아가므로
 * 리플레이 조회는 교차 출처 요청이 된다. 읽기 전용 공개 데이터라 전체 허용한다.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const http = createServer((req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    });
    res.end();
    return;
  }

  if (url === '/health') {
    sendJson(res, 200, {
      ok: true,
      matches: matches.size,
      queued: 0, // 익명 대기열 은퇴 (라운드 11 ③ — 방 흐름으로 일원화)
      replays: replays.size,
      uptime: Math.floor(process.uptime()),
    });
    return;
  }

  // 최근 리플레이 목록
  if (url.startsWith('/replays')) {
    const limit = Number(new URL(url, 'http://x').searchParams.get('limit') ?? 30);
    sendJson(res, 200, { replays: replays.list(Number.isFinite(limit) ? limit : 30) });
    return;
  }

  // 리플레이 하나 — 이 JSON만 있으면 경기 전체가 재생된다
  if (url.startsWith('/replay/')) {
    const id = decodeURIComponent(url.slice('/replay/'.length).split('?')[0]);
    const r = replays.get(id);
    if (!r) {
      sendJson(res, 404, { error: 'replay not found', id });
      return;
    }
    sendJson(res, 200, r);
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
    leaveRoom(conn);
    if (conn.match) {
      conn.match.onLeave(conn);
      matches.delete(conn.match);
    }
  });

  ws.on('error', () => {
    /* close 핸들러가 정리한다 */
  });
});

/**
 * 방 — 방장이 만들고 코드를 공유하면 손님이 참가한다.
 * 손님이 준비를 누르고 방장이 시작을 눌러야 경기가 열린다 (라운드 11 ③).
 */
interface Room {
  code: string;
  host: Conn;
  guest: Conn | null;
}
const rooms = new Map<string, Room>();

function roomCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(I/L/O/0/1) 제외
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(c)) return c;
  }
}

function broadcastRoom(room: Room): void {
  for (const c of [room.host, room.guest]) {
    if (!c) continue;
    c.send({
      t: 'room-state',
      code: room.code,
      host: c === room.host,
      mapId: getMap(room.host.mapId ?? DEFAULT_MAP_ID).id,
      players: [room.host, room.guest]
        .filter((p): p is Conn => p !== null)
        .map((p) => ({
          name: p.name,
          factionId: p.factionId,
          ready: p === room.host ? true : p.ready,
          host: p === room.host,
        })),
    });
  }
}

function leaveRoom(conn: Conn): void {
  if (!conn.roomCode) return;
  const room = rooms.get(conn.roomCode);
  conn.roomCode = null;
  conn.ready = false;
  if (!room) return;
  if (room.host === conn) {
    // 방장이 나가면 방이 사라진다
    rooms.delete(room.code);
    if (room.guest) {
      room.guest.roomCode = null;
      room.guest.ready = false;
      room.guest.send({ t: 'opponent-left' });
    }
  } else if (room.guest === conn) {
    room.guest = null;
    broadcastRoom(room);
  }
}

function handle(conn: Conn, msg: ClientMsg, solo: boolean): void {
  switch (msg.t) {
    case 'hello': {
      conn.name = String(msg.name ?? '익명').slice(0, 20) || '익명';
      // 알 수 없는 종족 id는 getFaction이 기본 종족으로 떨어뜨린다
      conn.factionId = getFaction(msg.factionId).id;
      conn.mapId = msg.mapId;
      if (conn.match) return;
      if (solo) {
        // 연습 모드 봇은 무작위 종족을 쓴다 — 같은 종족만 상대하면
        // 매치업 감각이 생기지 않는다
        const botFaction = FACTION_IDS[Math.floor(Math.random() * FACTION_IDS.length)];
        matches.add(new Match(conn, null, botFaction, saveReplay));
        return;
      }
      // 2인전은 방(만들기/코드 참가)으로만 성립한다 — 익명 대기열은
      // 방·준비·시작 흐름 도입(라운드 11 ③)과 함께 은퇴했다.
      // hello는 신원 등록까지만 하고, 다음 수는 create-room/join-room이다
      return;
    }

    case 'create-room': {
      if (conn.match || conn.roomCode) {
        conn.send({ t: 'room-error', reason: 'already-in-room' });
        return;
      }
      const room: Room = { code: roomCode(), host: conn, guest: null };
      rooms.set(room.code, room);
      conn.roomCode = room.code;
      broadcastRoom(room);
      return;
    }

    case 'join-room': {
      if (conn.match || conn.roomCode) {
        conn.send({ t: 'room-error', reason: 'already-in-room' });
        return;
      }
      const room = rooms.get(String(msg.code ?? '').toUpperCase());
      if (!room) {
        conn.send({ t: 'room-error', reason: 'no-room' });
        return;
      }
      if (room.guest) {
        conn.send({ t: 'room-error', reason: 'full' });
        return;
      }
      room.guest = conn;
      conn.roomCode = room.code;
      conn.ready = false;
      broadcastRoom(room);
      return;
    }

    case 'ready': {
      const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
      if (!room || room.guest !== conn) return;
      conn.ready = Boolean(msg.ready);
      broadcastRoom(room);
      return;
    }

    case 'set-loadout': {
      if (msg.factionId) conn.factionId = getFaction(msg.factionId).id;
      const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
      // 맵은 방장의 선택만 의미가 있다
      if (msg.mapId !== undefined && (!room || room.host === conn)) conn.mapId = msg.mapId;
      if (room) broadcastRoom(room);
      return;
    }

    case 'start-room': {
      const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
      if (!room || room.host !== conn) {
        conn.send({ t: 'room-error', reason: 'not-host' });
        return;
      }
      if (!room.guest || !room.guest.ready) {
        conn.send({ t: 'room-error', reason: 'not-ready' });
        return;
      }
      // 방장 = 팀 0, 방장의 맵 선택이 적용된다 (Match가 a.mapId를 읽는다)
      const host = room.host;
      const guest = room.guest;
      rooms.delete(room.code);
      host.roomCode = null;
      guest.roomCode = null;
      matches.add(new Match(host, guest, undefined, saveReplay));
      return;
    }

    case 'act': {
      const m = conn.match;
      if (!m || m.isEnded) {
        conn.send({ t: 'reject', reqTick: msg.reqTick, reason: 'not-playing' });
        return;
      }
      m.scheduleAct(conn.team as Team, msg.kind, msg.id, msg.x, msg.y, msg.reqTick);
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

/** 정상 종료된 경기의 리플레이를 저장소로 넘긴다 */
function saveReplay(r: Replay): void {
  replays.save(r);
  const bytes = JSON.stringify(r).length;
  console.log(
    `[replay] ${r.matchId} 저장 — ${r.factions[0]} vs ${r.factions[1]}, ` +
      `승자 ${r.result.winner === -1 ? '무승부' : `team${r.result.winner}`}, ` +
      `커맨드 ${r.commands.length}개, ${(bytes / 1024).toFixed(1)}KB`,
  );
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
