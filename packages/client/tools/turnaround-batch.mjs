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
const BUILDINGS = new Set(['bulwark', 'spinetentacle', 'sporetentacle', 'lightpylon']);
// 표준은 4행 5열 — 자동 검출은 총구 화염·작은 유닛에 속는다 (실측)
const COLS = { }; // 예외만 적는다
const units = process.argv.slice(2);

/**
 * 칸 단위 성분 필터 — 클리너가 놓친 것을 격자 지식으로 잡는다.
 *
 * 1. 어두운 체커 잔재: 칸당 ~256px 사각형이라 전역 섬 필터(120px)를
 *    통과한다 → 칸 안에서 400px 미만 성분은 전부 버린다
 * 2. 이웃 칸 잔상(슬리버): 캐릭터가 칸을 꽉 채우는 시트에서 옆 칸
 *    캐릭터의 가장자리가 넘어온다 → 무게중심이 칸 좌우 4% 안에 붙어
 *    있고 최대 성분의 절반이 안 되는 성분을 버린다
 */
function cellFilter(png, rows, cols) {
  const { width: W, height: H, data } = png;
  const cw = W / cols, ch = H / rows;
  for (let cr = 0; cr < rows; cr++) for (let cc = 0; cc < cols; cc++) {
    const x0 = Math.round(cc * cw), x1 = Math.round((cc + 1) * cw);
    const y0 = Math.round(cr * ch), y1 = Math.round((cr + 1) * ch);
    const idx = (x, y) => (y * W + x) * 4 + 3;
    const seen = new Set();
    const comps = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const k = y * W + x;
      if (seen.has(k) || data[idx(x, y)] === 0) continue;
      const stack = [k]; seen.add(k);
      const members = []; let sx = 0;
      while (stack.length) {
        const p0 = stack.pop(); members.push(p0);
        const px = p0 % W, py = (p0 - px) / W;
        sx += px;
        for (const [dx2, dy2] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = px + dx2, ny = py + dy2;
          if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
          const nk = ny * W + nx;
          if (seen.has(nk) || data[idx(nx, ny)] === 0) continue;
          seen.add(nk); stack.push(nk);
        }
      }
      comps.push({ members, cx: sx / members.length });
    }
    const largest = Math.max(1, ...comps.map((c) => c.members.length));
    for (const c of comps) {
      const edge = c.cx - x0 < cw * 0.04 || x1 - c.cx < cw * 0.04;
      if (c.members.length < 400 || (edge && c.members.length < largest * 0.5)) {
        for (const m of c.members) data[m * 4 + 3] = 0;
      }
    }
  }
}

for (const unit of units) {
  const src = `../../art-src/${unit}4.png`;
  const clean = `${SCRATCH}/${unit}4.clean.png`;
  execFileSync('node', ['tools/clean-turnaround.mjs', src, clean], { stdio: 'pipe' });
  {
    const p = PNG.sync.read(readFileSync(clean));
    cellFilter(p, 4, 5);
    writeFileSync(clean, PNG.sync.write(p));
  }
  const isB = BUILDINGS.has(unit);
  const plan = isB
    ? [[1, 'idle'], [3, 'attack']]
    : [[1, 'walk'], [2, 'walkback'], [3, 'attack'], [4, 'attackback']];

  // ── 행별 슬라이스 — 행마다 열 수가 다를 수 있다 (실측: 술사 1행 7열,
  //    2~4행 5열). 후보 열 수마다 등분선 위 내용량을 재서 가장 깨끗하게
  //    갈라지는 열 수를 행 단위로 고른다 ──
  const png = PNG.sync.read(readFileSync(clean));
  const { width: W, height: H, data } = png;
  const ch = H / 4;
  const rowCells = [];
  const colReport = [];
  for (let r = 0; r < 4; r++) {
    const y0 = Math.round(r * ch), y1 = Math.round((r + 1) * ch);
    let best = 5, bestScore = Infinity;
    for (const cand of [5, 6, 7]) {
      let score = 0;
      for (let b = 1; b < cand; b++) {
        const bx = Math.round((W * b) / cand);
        for (let x = bx - 1; x <= bx + 1; x++)
          for (let y = y0; y < y1; y++) if (data[(y * W + x) * 4 + 3] > 40) score++;
      }
      score /= cand - 1;
      if (score < bestScore) { bestScore = score; best = cand; }
    }
    colReport.push(best);
    const cw = W / best;
    const cells = [];
    for (let c = 0; c < Math.min(5, best); c++) {
      cells.push([Math.round(c * cw), y0, Math.round((c + 1) * cw), y1]);
    }
    rowCells.push(cells);
  }

  // 유닛 전체에서 최대 내용 크기를 재서 모든 스트립에 같은 배율을 쓴다
  const CELL = 64, INSET = 0.02;
  const bboxOf = ([x0, y0, x1, y1]) => {
    const ix = Math.round((x1 - x0) * INSET), iy = Math.round((y1 - y0) * INSET);
    let mnx = 1e9, mny = 1e9, mxx = -1, mxy = -1;
    for (let y = y0 + iy; y < y1 - iy; y++) for (let x = x0 + ix; x < x1 - ix; x++) {
      if (data[(y * W + x) * 4 + 3] > 8) {
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
      }
    }
    return mxx < 0 ? null : [mnx, mny, mxx, mxy];
  };
  let maxW = 1, maxH = 1;
  const bboxes = rowCells.map((cells) => cells.map(bboxOf));
  for (const row of bboxes) for (const b of row) {
    if (!b) continue;
    maxW = Math.max(maxW, b[2] - b[0] + 1);
    maxH = Math.max(maxH, b[3] - b[1] + 1);
  }
  const scale = Math.min(CELL / maxW, CELL / maxH);

  for (const [r, name] of plan) {
    const cells = rowCells[r - 1];
    const out = new PNG({ width: CELL * cells.length, height: CELL });
    cells.forEach((cell, ci) => {
      const b = bboxes[r - 1][ci];
      if (!b) return;
      const bw = b[2] - b[0] + 1, bh = b[3] - b[1] + 1;
      const dw = bw * scale, dh = bh * scale;
      const ox = ci * CELL + (CELL - dw) / 2, oy = CELL - dh; // 발 정렬
      for (let dy2 = 0; dy2 < Math.round(dh); dy2++) for (let dx2 = 0; dx2 < Math.round(dw); dx2++) {
        const sx2 = b[0] + Math.min(bw - 1, Math.floor(dx2 / scale));
        const sy2 = b[1] + Math.min(bh - 1, Math.floor(dy2 / scale));
        const si = (sy2 * W + sx2) * 4;
        if (data[si + 3] === 0) continue;
        const di = ((Math.round(oy) + dy2) * out.width + Math.round(ox) + dx2) * 4;
        out.data[di] = data[si]; out.data[di + 1] = data[si + 1];
        out.data[di + 2] = data[si + 2]; out.data[di + 3] = data[si + 3];
      }
    });
    const dir = new URL('../public/art/units/', import.meta.url).pathname;
    writeFileSync(`${dir}${unit}.${name}.png`, PNG.sync.write(out));
  }
  console.log(`${unit}: 행별 열수 [${colReport.join(',')}] · 배율 ${scale.toFixed(2)} → ${plan.map(([, n]) => n).join('/')}`);

  // 검수용 썸네일 (1/4)
  const p = PNG.sync.read(readFileSync(clean));
  const thumbScale = 4;
  const w = Math.floor(p.width / thumbScale), h = Math.floor(p.height / thumbScale);
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 30; out.data[i+1] = 34; out.data[i+2] = 40; out.data[i+3] = 255; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = ((y * thumbScale) * p.width + x * thumbScale) * 4;
    const a = p.data[si + 3] / 255;
    if (!a) continue;
    const di = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) out.data[di + c] = Math.round(p.data[si + c] * a + out.data[di + c] * (1 - a));
  }
  writeFileSync(`${SCRATCH}/thumb-${unit}.png`, PNG.sync.write(out));
}
console.log('완료');
