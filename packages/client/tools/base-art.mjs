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
 * 사용:
 *   node tools/base-art.mjs ../../art-src/clean/steel_main.png --faction steel --kind main
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

// 알파 경계 트림
let minx = png.width, maxx = -1, miny = png.height, maxy = -1;
for (let y = 0; y < png.height; y++) {
  for (let x = 0; x < png.width; x++) {
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
