/**
 * 격자 시트를 가로 한 줄 스트립으로 편다.
 *
 * 유닛 시트는 `slice-sheet.mjs`가 등급·행 이름까지 챙기지만, 일꾼과 미네랄은
 * 그런 규칙이 없다 — 그냥 셀 여러 개가 가로로 늘어선 스트립이면 된다.
 * 로더의 `sliceStrip()`이 폭을 프레임 수로 나눠 읽기 때문이다.
 *
 * 칸마다 따로 확대하면 크기가 널뛰므로 **배율은 하나만 쓴다.** 가장 큰 칸이
 * 셀에 들어가는 배율을 구해 전부에 적용한다 — 원본의 크기 차이가 그대로
 * 남아서 미네랄 덩이가 자연스럽게 들쭉날쭉해진다.
 *
 * 입력은 배경이 투명한 PNG여야 한다 (`dealpha.mjs` 먼저).
 *
 * 사용:
 *   node tools/strip.mjs ../../art-src/clean/worker.png --out worker.png \
 *        --grid 2x5 --cell 64 --take 1,1-1,5
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { PNG } from 'pngjs';

const ALPHA_MIN = 24;
/** 셀 대비 내용물 크기 — 가장자리가 잘리지 않게 조금 남긴다 */
const FILL = 0.92;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      out[k] = n === undefined || n.startsWith('--') ? true : argv[++i];
    } else out._.push(a);
  }
  return out;
}

/** 박스 필터 축소 — 색을 알파로 가중해야 투명 가장자리 색이 배지 않는다 */
function resampleInto(src, sx0, sy0, sw, sh, dst, dx0, dy0, dw, dh) {
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(sy0 + (dy * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.ceil(sy0 + ((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(sx0 + (dx * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.ceil(sx0 + ((dx + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        if (y < 0 || y >= src.height) continue;
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= src.width) continue;
          const i = (src.width * y + x) * 4;
          const av = src.data[i + 3];
          r += src.data[i] * av;
          g += src.data[i + 1] * av;
          b += src.data[i + 2] * av;
          a += av;
          n++;
        }
      }
      if (!n) continue;
      const di = (dst.width * (dy0 + dy) + (dx0 + dx)) * 4;
      if (a > 0) {
        dst.data[di] = Math.round(r / a);
        dst.data[di + 1] = Math.round(g / a);
        dst.data[di + 2] = Math.round(b / a);
      }
      dst.data[di + 3] = Math.round(a / n);
    }
  }
}

/** 칸 안에서 불투명 픽셀의 경계를 찾는다 */
function bounds(png, cx, cy, cw, ch) {
  let minx = cx + cw, maxx = -1, miny = cy + ch, maxy = -1;
  for (let y = cy; y < cy + ch; y++) {
    for (let x = cx; x < cx + cw; x++) {
      if (png.data[(png.width * y + x) * 4 + 3] >= ALPHA_MIN) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  return maxx < 0 ? null : { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };
}

const args = parseArgs(process.argv.slice(2));
const src = args._[0];
const outName = args.out;
const cell = Number(args.cell ?? 64);
if (!src || typeof outName !== 'string') {
  console.error('사용: node tools/strip.mjs <clean.png> --out <이름.png> --grid 행x열 [--cell 64] [--take r,c-r,c]');
  process.exit(1);
}

const raw = readFileSync(src);
if (!(raw[0] === 0x89 && raw[1] === 0x50)) {
  console.error(`${path.basename(src)} 가 PNG가 아니다 — dealpha.mjs 를 먼저 돌릴 것`);
  process.exit(1);
}
const png = PNG.sync.read(raw);

const gm = /^(\d+)x(\d+)$/.exec(String(args.grid ?? ''));
if (!gm) {
  console.error('--grid 는 행x열 형식이다 (예: 2x5)');
  process.exit(1);
}
const rows = Number(gm[1]);
const cols = Number(gm[2]);

// 쓸 칸을 고른다. --take 가 없으면 격자 전체를 행 우선으로 편다.
let picks = [];
if (typeof args.take === 'string') {
  const tm = /^(\d+),(\d+)-(\d+),(\d+)$/.exec(args.take);
  if (!tm) {
    console.error('--take 는 시작행,시작열-끝행,끝열 형식이다 (예: 1,1-1,5)');
    process.exit(1);
  }
  const [r0, c0, r1, c1] = tm.slice(1).map(Number);
  for (let r = r0; r <= r1; r++) {
    for (let c = r === r0 ? c0 : 1; c <= (r === r1 ? c1 : cols); c++) picks.push([r, c]);
  }
} else {
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) picks.push([r, c]);
}

// 칸별 경계를 모으고, 가장 큰 칸을 기준으로 배율을 하나만 정한다
const boxes = [];
for (const [r, c] of picks) {
  const cx = Math.floor(((c - 1) * png.width) / cols);
  const cy = Math.floor(((r - 1) * png.height) / rows);
  const cw = Math.floor((c * png.width) / cols) - cx;
  const ch = Math.floor((r * png.height) / rows) - cy;
  const b = bounds(png, cx, cy, cw, ch);
  if (!b) {
    console.error(`(${r},${c}) 칸이 비어 있다 — 배경이 구워졌으면 dealpha.mjs 먼저`);
    process.exit(1);
  }
  boxes.push(b);
}
const maxSpan = Math.max(...boxes.map((b) => Math.max(b.w, b.h)));
const scale = (cell * FILL) / maxSpan;

const out = new PNG({ width: cell * boxes.length, height: cell });
out.data.fill(0);
boxes.forEach((b, i) => {
  const dw = Math.max(1, Math.round(b.w * scale));
  const dh = Math.max(1, Math.round(b.h * scale));
  // 가로는 가운데, 세로는 바닥 정렬 — 발밑이 같은 높이여야 줄이 맞는다
  const dx = i * cell + Math.round((cell - dw) / 2);
  const dy = cell - dh - Math.round(cell * (1 - FILL) * 0.5);
  resampleInto(png, b.x, b.y, b.w, b.h, out, dx, dy, dw, dh);
});

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'art');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, outName), PNG.sync.write(out));
console.log(
  `✅ art/${outName} — ${boxes.length}칸 · 셀 ${cell}px · 배율 ${scale.toFixed(3)}\n` +
  `   매니페스트: "${path.basename(outName, '.png')}": { "frames": ${boxes.length}, "fps": 8 }`,
);
