/** WebSocket 연결 래퍼 */

import type { WebSocket } from 'ws';
import type { ServerMsg } from '@royale/shared';
import { DEFAULT_FACTION_ID } from '@royale/shared';
import type { Match } from './match.js';

let connSeq = 0;

export class Conn {
  readonly id: number;
  readonly ws: WebSocket;
  name = '익명';
  /** 선택한 종족 id. hello에서 받는다. */
  factionId = DEFAULT_FACTION_ID;
  /** 원하는 맵 id. hello에서 받는다 */
  mapId: string | undefined;
  /** 솔로 봇 난이도 요청 — hello에서 온다 */
  botLevel: string | undefined;
  team: 0 | 1 = 0;
  match: Match | null = null;
  /** 속한 방 코드. 없으면 null */
  roomCode: string | null = null;
  /** 방에서 준비 완료를 눌렀나 (손님만 의미) */
  ready = false;
  /** 연속 데스싱크 횟수 (진단용) */
  desyncs = 0;
  alive = true;

  constructor(ws: WebSocket) {
    this.id = ++connSeq;
    this.ws = ws;
  }

  send(msg: ServerMsg): void {
    if (this.ws.readyState !== 1 /* OPEN */) return;
    this.ws.send(JSON.stringify(msg));
  }
}
