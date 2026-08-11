/**
 * 리플레이 저장소.
 *
 * 메모리에 최근 N개를 들고 있고, REPLAY_DIR이 설정되어 있으면 디스크에도 쓴다.
 *
 * ⚠️ Fly.io 머신의 디스크는 영구 저장소가 아니다. 볼륨을 붙이지 않는 한 재배포·재시작
 * 시 사라진다. 그래서 기본값은 메모리 전용이고, 보관이 필요하면 클라이언트가
 * `GET /replay/<id>`로 받아서 내려받는 구조다. 영구 보관은 볼륨이나 오브젝트
 * 스토리지를 붙이는 별도 작업이다.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Replay, Team } from '@royale/shared';

export interface ReplayIndexEntry {
  id: string;
  createdAt: number;
  deckIds: [string, string];
  players: [string, string];
  winner: Team | -1;
  crowns: [number, number];
  ticks: number;
  /** 바이트 단위 대략 크기 — "경기 하나가 수 KB"를 눈으로 확인하기 위한 값 */
  bytes: number;
}

export class ReplayStore {
  private readonly mem = new Map<string, Replay>();
  /** 삽입 순서 (오래된 것부터) */
  private readonly order: string[] = [];

  constructor(
    private readonly maxInMemory = 50,
    private readonly dir?: string,
  ) {
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      // 재시작 시 디스크에 남아 있던 것을 다시 올린다
      const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      for (const f of files.slice(-maxInMemory)) {
        try {
          const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Replay;
          this.mem.set(r.matchId, r);
          this.order.push(r.matchId);
        } catch {
          /* 손상된 파일은 건너뛴다 */
        }
      }
      if (files.length) console.log(`[replay] 디스크에서 ${this.mem.size}개 복원 (${dir})`);
    } catch (err) {
      console.error('[replay] 저장 디렉터리를 준비하지 못했다', err);
    }
  }

  save(r: Replay): void {
    this.mem.set(r.matchId, r);
    this.order.push(r.matchId);
    while (this.order.length > this.maxInMemory) {
      const oldest = this.order.shift();
      if (oldest) this.mem.delete(oldest);
    }

    if (!this.dir) return;
    try {
      // 파일명이 시간순 정렬되도록 타임스탬프를 앞에 붙인다
      const name = `${r.createdAt}-${r.matchId}.json`;
      writeFileSync(path.join(this.dir, name), JSON.stringify(r), 'utf8');
    } catch (err) {
      console.error('[replay] 디스크 저장 실패', err);
    }
  }

  get(id: string): Replay | undefined {
    return this.mem.get(id);
  }

  /** 최신순 목록 */
  list(limit = 30): ReplayIndexEntry[] {
    const out: ReplayIndexEntry[] = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.mem.get(this.order[i]);
      if (!r) continue;
      out.push({
        id: r.matchId,
        createdAt: r.createdAt,
        deckIds: r.deckIds,
        players: r.players,
        winner: r.result.winner,
        crowns: r.result.crowns,
        ticks: r.result.ticks,
        bytes: JSON.stringify(r).length,
      });
    }
    return out;
  }

  get size(): number {
    return this.mem.size;
  }
}
