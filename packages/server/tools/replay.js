#!/usr/bin/env node
/**
 * 리플레이 검증 / 요약 도구.
 *
 *   node tools/replay.js <파일.json | URL> [...]
 *   node tools/replay.js --from http://localhost:8787     (서버의 최근 리플레이 전부)
 *
 * 하는 일:
 *   1. 리플레이를 다시 시뮬레이션해서 기록 당시와 같은 결과가 나오는지 검증한다
 *   2. 경기 요약과 카드 사용 통계를 출력한다
 *
 * 1번이 이 도구의 존재 이유다. 시뮬레이션 로직을 건드린 뒤 과거 리플레이를 돌려
 * 보면, 바뀐 것이 의도한 밸런스인지 아니면 결정론이 깨진 것인지 바로 드러난다.
 *
 * 2번의 카드 사용 통계는 자동 대전 밸런싱 도구의 출력 형식과 같다 —
 * 지금은 경기 하나를 보지만, 같은 집계를 수천 경기에 돌리면 승률표가 된다.
 */

import { readFileSync } from 'node:fs';

import { TICK_RATE, getCard, summarizeReplay, verifyReplay } from '@royale/shared';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('사용법: node tools/replay.js <파일|URL> [...]  |  --from <서버주소>');
  process.exit(2);
}

/* ── 입력 수집 ─────────────────────────────────────────────────────────── */

async function loadOne(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${src} → HTTP ${res.status}`);
    return await res.json();
  }
  return JSON.parse(readFileSync(src, 'utf8'));
}

async function collect() {
  const fromIdx = args.indexOf('--from');
  if (fromIdx < 0) return Promise.all(args.map(loadOne));

  const base = (args[fromIdx + 1] ?? '').replace(/\/$/, '');
  if (!base) throw new Error('--from 뒤에 서버 주소가 필요하다');
  const index = await (await fetch(`${base}/replays?limit=100`)).json();
  if (!index.replays?.length) {
    console.log('서버에 저장된 리플레이가 없다.');
    return [];
  }
  return Promise.all(index.replays.map((e) => loadOne(`${base}/replay/${encodeURIComponent(e.id)}`)));
}

/* ── 출력 ──────────────────────────────────────────────────────────────── */

function fmtDuration(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function printUsage(label, usage) {
  const rows = Object.entries(usage).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    console.log(`    ${label}: (없음)`);
    return;
  }
  const text = rows
    .map(([id, n]) => {
      let name = id;
      try {
        name = getCard(id).name;
      } catch {
        /* 삭제된 카드의 과거 리플레이 — id를 그대로 보여준다 */
      }
      return `${name}×${n}`;
    })
    .join(', ');
  console.log(`    ${label}: ${text}`);
}

const replays = await collect();
let failed = 0;

for (const r of replays) {
  const v = verifyReplay(r);
  const s = summarizeReplay(r, TICK_RATE);
  const bytes = JSON.stringify(r).length;

  const winner =
    s.winner === -1 ? '무승부' : `${s.players[s.winner]} (${s.deckIds[s.winner]})`;

  console.log(`\n── ${r.matchId} ${'─'.repeat(Math.max(0, 44 - r.matchId.length))}`);
  console.log(`  ${s.players[0]} (${s.deckIds[0]})  vs  ${s.players[1]} (${s.deckIds[1]})`);
  console.log(`  승자: ${winner}   왕관 ${s.crowns[0]}:${s.crowns[1]}   길이 ${fmtDuration(s.durationSec)}`);
  console.log(`  커맨드 ${r.commands.length}개 · ${(bytes / 1024).toFixed(1)}KB · 체크포인트 ${r.checkpoints.length}개`);
  printUsage(`team0 (${s.playCounts[0]}장)`, s.cardUsage[0]);
  printUsage(`team1 (${s.playCounts[1]}장)`, s.cardUsage[1]);

  if (v.ok) {
    console.log(`  ✅ 재현 검증 통과 (해시 ${v.actualHash})`);
  } else {
    failed++;
    console.log(`  ❌ 재현 실패 — 틱 ${v.divergedAtTick} 부터 갈라짐`);
    console.log(`     해시   기록=${v.expectedHash}  재현=${v.actualHash}`);
    console.log(`     결과   기록=${JSON.stringify(v.expected)}`);
    console.log(`            재현=${JSON.stringify(v.actual)}`);
  }
}

console.log(
  `\n총 ${replays.length}개 중 ${replays.length - failed}개 재현 성공, ${failed}개 실패`,
);
process.exit(failed > 0 ? 1 : 0);
