/**
 * 턴어라운드 시트 일괄 슬라이스 — art-src/<유닛>4.png → 스트립 4벌(건물 2벌).
 *
 * 격자는 4행 5열로 고정한다. 자동 검출은 총구 화염이 칸을 잇거나 작은
 * 유닛이 골짜기를 만들 때 속는다 (라운드 10.6 실측). 예외 열 수는 COLS에
 * 적는다 (예: zealot4는 7열이었다).
 *
 * 사용: node tools/turnaround-batch.mjs <unit> [unit...]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const SCRATCH = '/tmp/claude-0/-home-user-pomingpu/444588a5-89d5-5d3a-8a5b-be78b2c725d0/scratchpad';
const BUILDINGS = new Set(['bulwark', 'spinetentacle', 'sporetentacle']);
// 표준은 4행 5열 — 자동 검출은 총구 화염·작은 유닛에 속는다 (실측)
const COLS = { }; // 예외만 적는다
const units = process.argv.slice(2);

for (const unit of units) {
  const src = `../../art-src/${unit}4.png`;
  const clean = `${SCRATCH}/${unit}4.clean.png`;
  execFileSync('node', ['tools/clean-turnaround.mjs', src, clean], { stdio: 'pipe' });
  const cols = COLS[unit] ?? 5;
  const isB = BUILDINGS.has(unit);
  const plan = isB
    ? [[1, 'idle'], [3, 'attack']]
    : [[1, 'walk'], [2, 'walkback'], [3, 'attack'], [4, 'attackback']];
  for (const [r, name] of plan) {
    execFileSync('node', ['tools/strip.mjs', clean,
      '--out', `units/${unit}.${name}.png`,
      '--grid', `4x${cols}`, '--take', `${r},1-${r},5`,
      '--align', 'center', '--inset', '0.02'], { stdio: 'pipe' });
  }
  console.log(`${unit}: 4x${cols} → ${plan.map(([, n]) => n).join('/')}`);

  // 검수용 썸네일 (1/4)
  const p = PNG.sync.read(readFileSync(clean));
  const scale = 4;
  const w = Math.floor(p.width / scale), h = Math.floor(p.height / scale);
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 30; out.data[i+1] = 34; out.data[i+2] = 40; out.data[i+3] = 255; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = ((y * scale) * p.width + x * scale) * 4;
    const a = p.data[si + 3] / 255;
    if (!a) continue;
    const di = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) out.data[di + c] = Math.round(p.data[si + c] * a + out.data[di + c] * (1 - a));
  }
  writeFileSync(`${SCRATCH}/thumb-${unit}.png`, PNG.sync.write(out));
}
console.log('완료');
