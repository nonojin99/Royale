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
 * 세로 정렬은 기본이 바닥이다(일꾼처럼 땅에 서는 것). 폭발·연기처럼 중심에
 * 찍히는 것은 `--align center`로 가운데 정렬한다.
 *
 * 사용:
 *   node tools/strip.mjs ../../art-src/clean/worker.png --out worker.png \
 *        --grid 2x5 --cell 64 --take 1,1-1,5
 *   node tools/strip.mjs ../../art-src/clean/fx.png --out fx.png \
 *        --grid 4x6 --cell 64 --align center
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { PNG } from 'pngjs';

const ALPHA_MIN = 24;
/**
 * 셀 대비 내용물 크기 — 가장자리가 잘리지 않게 조금 남긴다.
 * 지형 타일처럼 셀을 끝까지 채워 이어 붙여야 하는 것은 `--fill 1`로 켠다.
 */
const DEFAULT_FILL = 0.92;

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

/**
 * 칸 안에서 내용물의 경계를 찾는다.
 *
 * 기본은 불투명 픽셀 기준. 배경이 투명이 아니라 단색으로 구워진 시트는
 * (`--bgcolor auto`) 이미지 네 모서리 색을 배경으로 삼아, 그 색과 충분히
 * 다른 픽셀을 내용물로 본다.
 */
function bounds(png, cx, cy, cw, ch, bg) {
  const isContent = (i) => {
    if (png.data[i + 3] < ALPHA_MIN) return false;
    if (!bg) return true;
    const dr = png.data[i] - bg[0];
    const dg = png.data[i + 1] - bg[1];
    const db = png.data[i + 2] - bg[2];
    return dr * dr + dg * dg + db * db > 28 * 28;
  };
  let minx = cx + cw, maxx = -1, miny = cy + ch, maxy = -1;
  const colN = new Array(cw).fill(0);
  const rowN = new Array(ch).fill(0);
  for (let y = cy; y < cy + ch; y++) {
    for (let x = cx; x < cx + cw; x++) {
      if (isContent((png.width * y + x) * 4)) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        colN[x - cx]++;
        rowN[y - cy]++;
      }
    }
  }
  if (maxx < 0) return null;
  if (!bg) return { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };

  // 배경색 모드는 격자가 균등 분할과 살짝 어긋나 옆 칸의 조각이 창에 들어올
  // 수 있다. 그대로 감싸면 사이의 배경 띠까지 타일에 구워지므로, 내용물이
  // 절반 이상 찬 줄이 가장 길게 이어지는 구간(= 본체)만 취한다.
  const run = (counts, span) => {
    let best = [0, -1], s = -1;
    for (let i = 0; i <= counts.length; i++) {
      const on = i < counts.length && counts[i] >= span * 0.5;
      if (on && s < 0) s = i;
      if (!on && s >= 0) {
        if (i - s > best[1] - best[0] + 1) best = [s, i - 1];
        s = -1;
      }
    }
    return best;
  };
  const [x0, x1] = run(colN, ch);
  const [y0, y1] = run(rowN, cw);
  if (x1 < x0 || y1 < y0) return null;
  return { x: cx + x0, y: cy + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 이미지 네 모서리의 평균색 — 단색 배경 검출용 */
function cornerColor(png) {
  const pick = (x, y) => {
    const i = (png.width * y + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const cs = [
    pick(1, 1),
    pick(png.width - 2, 1),
    pick(1, png.height - 2),
    pick(png.width - 2, png.height - 2),
  ];
  return [0, 1, 2].map((k) => Math.round(cs.reduce((s, c) => s + c[k], 0) / 4));
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
const bg = args.bgcolor === 'auto' ? cornerColor(png) : null;
if (bg) console.log(`배경색 rgb(${bg.join(',')}) 기준으로 경계를 잡는다`);

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
  const b = bounds(png, cx, cy, cw, ch, bg);
  if (!b) {
    console.error(`(${r},${c}) 칸이 비어 있다 — 배경이 구워졌으면 dealpha.mjs 먼저`);
    process.exit(1);
  }
  boxes.push(b);
}
// 타일 가장자리에 어두운 테두리가 구워진 시트는 --inset 비율만큼 깎아 낸다.
// 안 깎으면 게임에서 타일마다 줄눈이 생겨 바둑판처럼 보인다.
const inset = args.inset !== undefined ? Number(args.inset) : 0;
if (!(inset >= 0 && inset < 0.4)) {
  console.error('--inset 은 0 이상 0.4 미만이어야 한다');
  process.exit(1);
}
for (const b of boxes) {
  const ix = Math.round(b.w * inset);
  const iy = Math.round(b.h * inset);
  b.x += ix; b.y += iy; b.w -= ix * 2; b.h -= iy * 2;
}

const maxSpan = Math.max(...boxes.map((b) => Math.max(b.w, b.h)));
const FILL = args.fill !== undefined ? Number(args.fill) : DEFAULT_FILL;
if (!(FILL > 0 && FILL <= 1)) {
  console.error('--fill 은 0보다 크고 1 이하여야 한다');
  process.exit(1);
}
const scale = (cell * FILL) / maxSpan;

const out = new PNG({ width: cell * boxes.length, height: cell });
out.data.fill(0);
boxes.forEach((b, i) => {
  // 지형 타일은 비율을 버리고 셀을 정확히 꽉 채운다 — 빈 줄이 한 줄만 남아도
  // 이어 붙일 때 격자 줄눈이 된다. 약간의 늘어남은 바닥 질감에서 안 보인다.
  if (args.stretch) {
    resampleInto(png, b.x, b.y, b.w, b.h, out, i * cell, 0, cell, cell);
    return;
  }
  const dw = Math.max(1, Math.round(b.w * scale));
  const dh = Math.max(1, Math.round(b.h * scale));
  // 가로는 가운데. 세로는 바닥(발밑이 같은 높이) 또는 가운데(중심에 찍히는 것)
  const dx = i * cell + Math.round((cell - dw) / 2);
  const dy =
    args.align === 'center'
      ? Math.round((cell - dh) / 2)
      : cell - dh - Math.round(cell * (1 - FILL) * 0.5);
  resampleInto(png, b.x, b.y, b.w, b.h, out, dx, dy, dw, dh);
});

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'art');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, outName), PNG.sync.write(out));
console.log(
  `✅ art/${outName} — ${boxes.length}칸 · 셀 ${cell}px · 배율 ${scale.toFixed(3)}\n` +
  `   매니페스트: "${path.basename(outName, '.png')}": { "frames": ${boxes.length}, "fps": 8 }`,
);
