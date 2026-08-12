/**
 * 기지 이미지 한 장을 게임 규격으로 다듬는다.
 *
 * 유닛과 달리 기지는 프레임 시트가 아니라 **단일 이미지**다. 하는 일:
 *   1. 알파 경계로 여백을 잘라내고
 *   2. 256×256 캔버스에 맞춰 축소 (ART_PIPELINE §3.2 기지 규격)
 *   3. `public/art/bases/<종족>.<종류>.png` 로 저장
 *
 * 입력은 **배경이 이미 투명한 PNG**여야 한다. 체크무늬가 구워진 파일은
 * 먼저 `dealpha.mjs`로 지운다 (유닛과 같은 절차).
 *
 * 본진과 확장이 한 장에 격자로 들어온 경우 `--grid`로 칸을 나누고
 * `--pick`으로 쓸 칸 하나를 고른다. 둘 다 1부터 센다.
 *
 * 사용:
 *   node tools/base-art.mjs ../../art-src/clean/steel_main.png --faction steel --kind main
 *   node tools/base-art.mjs ../../art-src/clean/steel.png \
 *        --grid 2x5 --pick 1,1 --faction steel --kind main
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { PNG } from 'pngjs';

const OUT_SIZE = 256;
/** 캔버스 대비 내용물 크기 — 위아래 약간의 숨 쉴 여백 */
const FILL = 0.94;
const ALPHA_MIN = 24;

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

const args = parseArgs(process.argv.slice(2));
const src = args._[0];
const faction = args.faction;
const kind = args.kind;
if (!src || !faction || !['main', 'expansion'].includes(kind ?? '')) {
  console.error('사용: node tools/base-art.mjs <clean.png> --faction <id> --kind main|expansion');
  process.exit(1);
}

const raw = readFileSync(src);
if (!(raw[0] === 0x89 && raw[1] === 0x50)) {
  console.error(`${path.basename(src)} 가 PNG가 아니다 — dealpha.mjs 를 먼저 돌릴 것`);
  process.exit(1);
}
const png = PNG.sync.read(raw);

// 격자에서 칸 하나만 보기 — 없으면 이미지 전체가 곧 그 칸이다
let cellX = 0, cellY = 0, cellW = png.width, cellH = png.height;
if (args.grid) {
  const g = /^(\d+)x(\d+)$/.exec(String(args.grid));
  const p = /^(\d+),(\d+)$/.exec(String(args.pick ?? ''));
  if (!g) {
    console.error('--grid 는 행x열 형식이다 (예: 2x5)');
    process.exit(1);
  }
  if (!p) {
    console.error('--grid 를 쓰면 --pick 행,열 도 줘야 한다 (예: --pick 1,1)');
    process.exit(1);
  }
  const [rows, cols] = [Number(g[1]), Number(g[2])];
  const [r, c] = [Number(p[1]), Number(p[2])];
  if (r < 1 || r > rows || c < 1 || c > cols) {
    console.error(`--pick 이 격자 밖이다 — 1..${rows}, 1..${cols} 범위여야 한다`);
    process.exit(1);
  }
  cellX = Math.floor(((c - 1) * png.width) / cols);
  cellY = Math.floor(((r - 1) * png.height) / rows);
  cellW = Math.floor((c * png.width) / cols) - cellX;
  cellH = Math.floor((r * png.height) / rows) - cellY;
  console.log(`격자 ${rows}x${cols} 중 (${r},${c}) — ${cellW}×${cellH} 영역`);
}

// 알파 경계 트림
let minx = cellX + cellW, maxx = -1, miny = cellY + cellH, maxy = -1;
for (let y = cellY; y < cellY + cellH; y++) {
  for (let x = cellX; x < cellX + cellW; x++) {
    if (png.data[(png.width * y + x) * 4 + 3] >= ALPHA_MIN) {
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  }
}
if (maxx < 0) {
  console.error('불투명 픽셀이 없다 — 배경이 구워진 상태면 dealpha.mjs 먼저');
  process.exit(1);
}
const cw = maxx - minx + 1;
const ch = maxy - miny + 1;

// 칸 경계에 딱 붙어 있으면 옆 프레임 이펙트가 넘어왔을 가능성이 있다
if (args.grid &&
    (minx <= cellX || maxx >= cellX + cellW - 1 ||
     miny <= cellY || maxy >= cellY + cellH - 1)) {
  console.warn('⚠️  내용물이 칸 경계에 닿았다 — 옆 프레임이 섞였는지 결과를 눈으로 볼 것');
}

const scale = (OUT_SIZE * FILL) / Math.max(cw, ch);
const dw = Math.round(cw * scale);
const dh = Math.round(ch * scale);
const out = new PNG({ width: OUT_SIZE, height: OUT_SIZE });
out.data.fill(0);
resampleInto(
  png, minx, miny, cw, ch,
  out, Math.round((OUT_SIZE - dw) / 2), Math.round((OUT_SIZE - dh) / 2), dw, dh,
);

const dir = path.join(
  path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'art', 'bases',
);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const dst = path.join(dir, `${faction}.${kind}.png`);
writeFileSync(dst, PNG.sync.write(out));
console.log(
  `✅ bases/${faction}.${kind}.png — 원본 ${cw}×${ch} → ${OUT_SIZE}×${OUT_SIZE} (배율 ${scale.toFixed(3)})`,
);
