/**
 * 기지 자리 검사기 — 맵 규칙 §7의 3번(확장 사슬 BFS)을 기계로 돌린다.
 *
 * 손으로 좌표를 찍으면 반드시 틀린다. 대협곡의 다리 어귀가 15.8타일로
 * 사슬이 끊겨 필드 절반에서 확장이 멈춘 사고가 그래서 났다 (라운드 14.5).
 *
 * 재는 것:
 *   1. 점대칭  — 모든 자리가 (47-x, 47-y) 짝을 갖는가
 *   2. 사슬    — 본진에서 EXPAND_RANGE 링크만 밟아 전 자리에 닿는가
 *   3. 통행    — 자리가 벽·물 위에 있지 않은가
 *   4. **다툼도** — 각 자리가 양 본진에서 얼마나 먼가. 자기 본진에만
 *      가깝고 적에게서 먼 자리가 넷이면 확장이 벌을 안 받는다 (라운드 50)
 *
 * 사용: node tools/sites.mjs [맵id]
 */
import {
  BASE_SITES,
  EXPAND_RANGE,
  ARENA_W_TILES,
  MAPS,
  setActiveMap,
  blockedAt,
} from '../packages/shared/dist/index.js';

const mapId = process.argv[2];
if (mapId) setActiveMap(mapId);
// 침공 전용 맵은 중앙 본진 방사대칭이다 — 점대칭도 다툼도도 뜻이 없다
const invasionOnly = MAPS.find((m) => m.id === (mapId ?? 'coast'))?.invasionOnly ?? false;
const T = 1000;
const W = ARENA_W_TILES;
const sites = BASE_SITES;
const mains = sites.filter((b) => b.startFor === 0 || b.startFor === 1);
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) / T;

let bad = 0;
const fail = (m) => { console.log('  ✗ ' + m); bad++; };

console.log(`\n【${mapId ?? '기본'}】 자리 ${sites.length}개 · 사슬 간격 ${EXPAND_RANGE / T}타일\n`);

// 1. 점대칭
for (const s of invasionOnly ? [] : sites) {
  const mx = (W - 1) * T - s.x;
  const my = (W - 1) * T - s.y;
  if (!sites.some((o) => o.x === mx && o.y === my)) {
    fail(`${s.id}(${s.x / T},${s.y / T})의 점대칭 짝이 없다`);
  }
}

// 3. 통행
for (const s of sites) {
  if (blockedAt(s.x, s.y)) fail(`${s.id} ${s.label ?? ''}가 벽·물 위에 있다`);
}

// 2. 사슬 BFS — 본진마다
for (const main of invasionOnly ? [] : mains) {
  const seen = new Set([main.id]);
  const q = [main];
  while (q.length) {
    const cur = q.shift();
    for (const s of sites) {
      if (seen.has(s.id)) continue;
      if (d(cur, s) * T <= EXPAND_RANGE) {
        seen.add(s.id);
        q.push(s);
      }
    }
  }
  const missed = sites.filter((s) => !seen.has(s.id)).map((s) => s.id);
  if (missed.length) fail(`본진 ${main.id}에서 사슬이 안 닿는 자리: ${missed.join(', ')}`);
}

// 4. 다툼도
if (invasionOnly) {
  console.log('  (침공 전용 맵 — 대칭·사슬·다툼도 검사는 건너뛴다)');
  console.log(bad ? `\n  ✗ ${bad}건 실패` : '\n  ✓ 통행 통과');
  process.exit(bad ? 1 : 0);
}
const p0 = sites.find((b) => b.startFor === 0);
const p1 = sites.find((b) => b.startFor === 1);
console.log('  id  자리            내본진  적본진   성격');
const safeCount = { 0: 0, 1: 0 };
for (const s of sites) {
  if (s.startFor === 0 || s.startFor === 1) continue;
  const d0 = d(s, p0);
  const d1 = d(s, p1);
  const near = d0 < d1 ? 0 : 1;
  const mine = Math.min(d0, d1);
  const foe = Math.max(d0, d1);
  // 자기 본진에 가깝고 적에게서 두 배 넘게 멀면 "뒤뜰" — 칠 수가 없다
  const kind = foe >= mine * 2 ? '뒤뜰' : foe >= mine * 1.35 ? '반뒤뜰' : '다툼터';
  if (kind === '뒤뜰') safeCount[near]++;
  console.log(
    `  ${String(s.id).padStart(2)}  ${(s.label ?? '').padEnd(12)}` +
      `${mine.toFixed(0).padStart(6)}${foe.toFixed(0).padStart(8)}   ${kind} (팀${near} 쪽)`,
  );
}
console.log(`\n  팀별 뒤뜰 자리: 팀0 ${safeCount[0]}개 · 팀1 ${safeCount[1]}개`);
if (safeCount[0] > 2) {
  console.log('  ⚠️  뒤뜰이 셋 이상이면 4기지까지 안전하게 깔 수 있다 — 확장이 벌을 안 받는다');
}
console.log(bad ? `\n  ✗ ${bad}건 실패` : '\n  ✓ 대칭·사슬·통행 모두 통과');
process.exit(bad ? 1 : 0);
