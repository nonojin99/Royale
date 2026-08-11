/**
 * 스프라이트 시트를 게임이 쓸 수 있는 균일 셀 스트립으로 자른다.
 *
 * 이미지 생성 도구는 프레임을 한 장에 나란히 뽑을 때 가장 일관된 결과를 낸다
 * (따로 뽑으면 프레임마다 색·비율이 흔들린다). 그래서 시트로 받아서 여기서
 * 자른다.
 *
 * ── 왜 프레임마다 잘라내지 않는가 ────────────────────────────────────────
 * 프레임별로 알파 경계를 재서 각각 꽉 채워 자르면 **유닛이 떨린다.**
 * 공격 프레임에는 총구 섬광이나 에너지가 몸 밖으로 삐져나오는데, 그 프레임만
 * 경계가 넓어지므로 같은 크기에 맞추는 순간 몸통이 작아진다. 걷기도 마찬가지로
 * 다리를 벌린 프레임이 더 넓다.
 *
 * 그래서 **모든 프레임의 합집합 경계**를 셀로 삼는다. 프레임 사이의 상대적인
 * 움직임(상하 바운스, 다리 벌림)이 그대로 보존된다 — 그 움직임이 애니메이션의
 * 실체이므로 지워서는 안 된다.
 *
 * 사용:
 *   node tools/slice-sheet.mjs <시트.png> --unit gnawer --anim walk
 *   node tools/slice-sheet.mjs <시트.png> --unit strider --anim attack --fps 14
 *
 * 옵션:
 *   --unit   units.ts의 유닛 id (필수)
 *   --anim   walk | attack | idle | death   (기본 walk)
 *   --fps    재생 속도 (기본 walk 10, attack 14)
 *   --tier   small | medium | large — 캔버스 대비 크기. 생략하면 유닛 비용에서 추론
 *   --frames 프레임 수를 강제 지정 (자동 검출이 틀렸을 때만)
 *   --dry    파일을 쓰지 않고 검출 결과만 출력
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { PNG } from 'pngjs';

/** 셀 한 칸의 출력 크기 — ART_PIPELINE §3.2의 유닛 규격 */
const CELL = 128;
/** 발이 셀 아래에서 이 비율 지점에 오게 한다 — §3.3 */
const FEET_FROM_BOTTOM = 0.12;
/** 크기 등급별 셀 높이 점유율 — §3.3 */
const TIERS = { small: 0.55, medium: 0.7, large: 0.9 };
/** 알파가 이보다 크면 "그림이 있다"고 본다. 소프트 그림자를 배경으로 흘리기 위한 값 */
const ALPHA_MIN = 24;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/** 열마다 불투명 픽셀이 있는지 — 프레임 사이의 빈 열을 찾기 위해 */
function columnOccupancy(png) {
  const cols = new Uint8Array(png.width);
  for (let x = 0; x < png.width; x++) {
    for (let y = 0; y < png.height; y++) {
      if (png.data[(png.width * y + x) * 4 + 3] >= ALPHA_MIN) {
        cols[x] = 1;
        break;
      }
    }
  }
  return cols;
}

/** 불투명한 열이 이어지는 구간 = 프레임 하나 */
function findFrameSpans(cols) {
  const spans = [];
  let start = -1;
  for (let x = 0; x < cols.length; x++) {
    if (cols[x] && start < 0) start = x;
    else if (!cols[x] && start >= 0) {
      spans.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0) spans.push([start, cols.length - 1]);
  return spans;
}

/**
 * 시트 전체 폭을 n등분한다.
 *
 * 공격 프레임의 섬광처럼 몸 밖으로 크게 번지는 효과가 있으면 프레임끼리
 * 알파가 이어져 자동 검출이 뭉친다. 생성 도구는 프레임을 **균일한 격자**에
 * 올려 주므로, 개수를 알 때는 전체 폭을 그대로 나누는 쪽이 뭉친 구간을
 * 쪼개려 애쓰는 것보다 정확하다.
 */
function evenCells(width, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([Math.round((width * i) / n), Math.round((width * (i + 1)) / n) - 1]);
  }
  return out;
}

/**
 * 구간 안에서 실제 그림이 차지하는 세로 범위.
 *
 * 한 줄에 불투명 픽셀이 `MIN_ROW_PX`개는 있어야 "그림이 있다"고 본다. JPG에서
 * 배경을 지우고 나면 사방에 1px 잡티가 흩뿌려지는데, 한 픽셀만으로 판정하면
 * 그 잡티까지 경계에 들어가 유닛이 실제보다 작게 축소된다.
 */
const MIN_ROW_PX = 4;

function verticalBounds(png, x0, x1) {
  let top = -1;
  let bot = -1;
  for (let y = 0; y < png.height; y++) {
    let n = 0;
    for (let x = x0; x <= x1; x++) {
      if (png.data[(png.width * y + x) * 4 + 3] >= ALPHA_MIN) n++;
    }
    if (n >= MIN_ROW_PX) {
      if (top < 0) top = y;
      bot = y;
    }
  }
  return [top, bot];
}

/** 니어리스트가 아닌 박스 필터 축소 — 픽셀아트라도 축소는 평균이 깔끔하다 */
function resampleInto(src, sx0, sy0, sw, sh, dst, dx0, dy0, dw, dh) {
  for (let dy = 0; dy < dh; dy++) {
    const fy0 = sy0 + (dy * sh) / dh;
    const fy1 = sy0 + ((dy + 1) * sh) / dh;
    const y0 = Math.floor(fy0);
    const y1 = Math.max(y0 + 1, Math.ceil(fy1));
    for (let dx = 0; dx < dw; dx++) {
      const fx0 = sx0 + (dx * sw) / dw;
      const fx1 = sx0 + ((dx + 1) * sw) / dw;
      const x0 = Math.floor(fx0);
      const x1 = Math.max(x0 + 1, Math.ceil(fx1));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        if (y < 0 || y >= src.height) continue;
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= src.width) continue;
          const i = (src.width * y + x) * 4;
          const av = src.data[i + 3];
          // 색은 알파로 가중해 더한다. 안 그러면 투명한 가장자리의 색이 배어난다
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

/* ── 본체 ────────────────────────────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2));
const srcPath = args._[0];
const unit = args.unit;
const anim = typeof args.anim === 'string' ? args.anim : 'walk';

if (!srcPath || !unit) {
  console.error('사용: node tools/slice-sheet.mjs <시트.png> --unit <id> [--anim walk]');
  process.exit(1);
}

const tierName = typeof args.tier === 'string' ? args.tier : 'medium';
if (!TIERS[tierName]) {
  console.error(`--tier 는 ${Object.keys(TIERS).join(' | ')} 중 하나여야 한다`);
  process.exit(1);
}
const fill = TIERS[tierName];
const fps = args.fps ? Number(args.fps) : anim === 'attack' ? 14 : 10;

const raw = readFileSync(srcPath);

// JPG에는 알파 채널이 없다. 여기서 막지 않으면 pngjs가 알아보기 어려운 오류를 낸다
if (!(raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47)) {
  const jpg = raw[0] === 0xff && raw[1] === 0xd8;
  console.error(
    jpg
      ? 'JPG는 쓸 수 없다 — 알파 채널이 없어서 배경을 투명하게 만들 수 없다.\n' +
          '   생성 도구에서 PNG로 다시 내보낼 것. 단순 변환(JPG→PNG)으로는 해결되지 않는다.'
      : 'PNG가 아니다. 투명 배경 PNG로 내보낼 것',
  );
  process.exit(1);
}

const png = PNG.sync.read(raw);
console.log(`시트 ${path.basename(srcPath)} — ${png.width}×${png.height}`);

/**
 * 실제로 투명한 곳이 있는지 확인한다.
 *
 * JPG를 PNG로 변환하면 알파 채널은 생기지만 전부 불투명이다. 미리보기의
 * 체크무늬가 **진짜 픽셀로 구워진** 상태이므로, 자르면 유닛마다 회색 체크무늬
 * 사각형이 따라붙는다. 확장자만 보고는 알 수 없어서 내용으로 판별한다.
 */
let transparent = 0;
for (let i = 3; i < png.data.length; i += 4) if (png.data[i] < ALPHA_MIN) transparent++;
const ratio = transparent / (png.width * png.height);
if (ratio < 0.02) {
  console.error(
    `투명한 픽셀이 거의 없다 (${(ratio * 100).toFixed(1)}%).\n` +
      '   JPG를 PNG로 변환만 한 파일일 가능성이 높다 — 변환은 알파 채널을 만들 뿐\n' +
      '   배경을 지우지 않는다. 미리보기의 체크무늬가 실제 픽셀로 들어가 있다면\n' +
      '   생성 도구에서 투명 배경 PNG로 다시 내보내야 한다.',
  );
  process.exit(1);
}

let spans = findFrameSpans(columnOccupancy(png));

// JPG에서 배경을 지우고 나면 1~2px짜리 잡티가 남아 프레임으로 오인된다.
// 실제 프레임이 이만큼 좁을 수는 없다.
const MIN_SPAN = 8;
const specks = spans.filter((s) => s[1] - s[0] + 1 < MIN_SPAN).length;
if (specks) {
  spans = spans.filter((s) => s[1] - s[0] + 1 >= MIN_SPAN);
  console.log(`  ${MIN_SPAN}px 미만 잡티 ${specks}개 무시`);
}

if (!spans.length) {
  console.error('불투명한 픽셀을 찾지 못했다. 배경이 투명한 PNG가 맞는지 확인할 것');
  process.exit(1);
}

const want = args.frames ? Number(args.frames) : 0;
/** 균등 격자 모드에서는 칸 전체를 그대로 옮긴다 — 효과의 좌우 위치가 보존된다 */
let gridMode = false;
if (want && spans.length !== want) {
  console.log(`  자동 검출 ${spans.length}개 ≠ 지정 ${want}개 — 전체 폭을 ${want}등분한다`);
  spans = evenCells(png.width, want);
  gridMode = true;
} else if (want) {
  console.log(`  자동 검출 ${spans.length}개 = 지정 ${want}개`);
}

// 모든 프레임의 합집합 경계 — 프레임 간 상대 움직임을 보존하는 핵심
let unionTop = Infinity;
let unionBot = -Infinity;
let maxW = 0;
const frames = [];
for (const [x0, x1] of spans) {
  const [top, bot] = verticalBounds(png, x0, x1);
  if (top < 0) continue;
  frames.push({ x0, x1, top, bot });
  unionTop = Math.min(unionTop, top);
  unionBot = Math.max(unionBot, bot);
  maxW = Math.max(maxW, x1 - x0 + 1);
}

// 생성 도구가 프레임 아래에 "Frame1 Frame2…" 같은 라벨을 그려 넣는 경우가 있다.
// 그대로 두면 합집합 경계가 라벨까지 삼켜 유닛이 작아지고 발 위치가 어긋난다.
// 본체와 뚝 떨어진 얇은 띠가 아래쪽에 있으면 그것이 라벨이다.
{
  const rows = new Uint8Array(png.height);
  for (let y = 0; y < png.height; y++) {
    let n = 0;
    for (let x = 0; x < png.width; x++) if (png.data[(png.width * y + x) * 4 + 3] >= ALPHA_MIN) n++;
    rows[y] = n > 3 ? 1 : 0;
  }
  const bands = [];
  let s = -1;
  for (let y = 0; y < png.height; y++) {
    if (rows[y] && s < 0) s = y;
    else if (!rows[y] && s >= 0) {
      bands.push([s, y - 1]);
      s = -1;
    }
  }
  if (s >= 0) bands.push([s, png.height - 1]);
  if (bands.length >= 2) {
    const main = bands.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    const tail = bands[bands.length - 1];
    if (tail !== main && tail[0] > main[1] && tail[1] - tail[0] + 1 < (main[1] - main[0]) * 0.25) {
      const pct = Math.ceil(((png.height - tail[0] + 4) / png.height) * 100);
      console.warn(
        `  ⚠ 본체(y ${main[0]}~${main[1]}) 아래에 얇은 띠(y ${tail[0]}~${tail[1]})가 있다.\n` +
          `    "Frame1 Frame2…" 같은 구워진 라벨일 가능성이 높다. 그대로 두면 유닛이 작아진다.\n` +
          `    dealpha.mjs 에 --cropbottom ${pct} 을 주고 다시 만들 것.`,
      );
    }
  }
}

const unionH = unionBot - unionTop + 1;
console.log(
  `  프레임 ${frames.length}개, 합집합 높이 ${unionH}px, 최대 폭 ${maxW}px` +
    (gridMode ? ' (균등 격자)' : ''),
);
frames.forEach((f, i) =>
  console.log(
    `    #${i} x ${f.x0}~${f.x1} (${f.x1 - f.x0 + 1}px) · y ${f.top}~${f.bot} (${f.bot - f.top + 1}px)`,
  ),
);

// 합집합 높이가 셀의 fill 비율을 차지하도록 축소한다.
// 가로가 셀을 넘치면 가로 기준으로 한 번 더 줄인다 — 넘치면 잘려 나간다.
let scale = (CELL * fill) / unionH;
if (maxW * scale > CELL) {
  scale = CELL / maxW;
  console.log(`  가로가 셀을 넘쳐 축소율을 ${scale.toFixed(3)}로 낮춘다`);
}
const feetY = Math.round(CELL * (1 - FEET_FROM_BOTTOM));

const out = new PNG({ width: CELL * frames.length, height: CELL });
out.data.fill(0);

for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  const sw = f.x1 - f.x0 + 1;
  const dw = Math.round(sw * scale);
  const dh = Math.round(unionH * scale);
  // 셀 안 가로 중앙, 합집합 바닥이 발 위치에 오도록
  const dx = i * CELL + Math.round((CELL - dw) / 2);
  const dy = feetY - dh;
  resampleInto(png, f.x0, unionTop, sw, unionH, out, dx, dy, dw, dh);
}

if (args.dry) {
  console.log('  --dry 이므로 파일을 쓰지 않는다');
  process.exit(0);
}

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'art', 'units');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${unit}.${anim}.png`);
writeFileSync(outPath, PNG.sync.write(out));

console.log(`\n✅ ${path.relative(process.cwd(), outPath)}`);
console.log(`   ${CELL}×${CELL} 셀 ${frames.length}칸 · 등급 ${tierName}(${fill * 100}%) · ${fps}fps`);
console.log(`\nmanifest.json 에 추가할 내용:`);
console.log(
  `  "${unit}": { "${anim}": { "frames": ${frames.length}, "fps": ${fps} } }`.replace(/^/gm, '  '),
);
