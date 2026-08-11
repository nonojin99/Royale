/**
 * 스프라이트 시트를 게임이 쓸 수 있는 균일 셀 스트립으로 자른다.
 *
 * 이미지 생성 도구는 프레임을 한 장에 나란히 뽑을 때 가장 일관된 결과를 낸다
 * (따로 뽑으면 프레임마다 색·비율이 흔들린다). 그래서 시트로 받아서 여기서
 * 자른다.
 *
 * ── 왜 프레임마다 잘라내지 않는가 ────────────────────────────────────────
 * 프레임별로 알파 경계를 재서 각각 꽉 채워 자르면 **유닛이 떨린다.** 공격
 * 프레임에는 섬광이 몸 밖으로 삐져나오고 걷기는 다리를 벌리므로 프레임마다
 * 경계가 다르다. 그래서 **모든 프레임의 합집합 경계**를 기준으로 한 번만
 * 축소한다. 상하 바운스와 다리 벌림 같은 프레임 간 상대 움직임이 그대로
 * 남는다 — 그게 애니메이션의 실체다.
 *
 * ── 왜 한 유닛의 동작을 한꺼번에 처리하는가 ──────────────────────────────
 * 같은 이유가 **동작 사이에도** 적용된다. walk와 attack을 따로 축소하면
 * 합집합 높이가 다르므로 배율이 달라지고, 공격에 들어가는 순간 유닛 크기가
 * 튄다. 그래서 한 유닛의 시트를 모두 받아 **기준 동작(walk) 하나로 배율을
 * 정하고** 나머지에 같은 배율을 쓴다. 공격 이펙트는 셀 밖으로 나가도 좋다 —
 * 섬광은 원래 몸보다 크다.
 *
 * 사용:
 *   node tools/slice-sheet.mjs --unit gnawer --tier small \
 *        walk=../../art-src/clean/gnawer.png attack=../../art-src/clean/gnawer_attack.png
 *
 *   (동작 하나만)
 *   node tools/slice-sheet.mjs <시트.png> --unit rifleman --anim walk --tier small
 *
 * 옵션:
 *   --unit   units.ts의 유닛 id (필수)
 *   --anim   동작 하나만 넘길 때의 이름 (기본 walk)
 *   --tier   small 55% · medium 70% · large 90% — 캔버스 대비 크기
 *   --fps    재생 속도 (기본 walk 10, attack 14)
 *   --frames 프레임 수 강제 지정 (자동 검출이 틀렸을 때만)
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
/** 알파가 이보다 크면 "그림이 있다"고 본다 */
const ALPHA_MIN = 24;
/** 프레임으로 인정할 최소 가로 폭 — 배경 제거 후 남는 잡티를 거른다 */
const MIN_SPAN = 8;
/** 한 줄에 이만큼은 있어야 "그림이 있는 줄"로 본다 */
const MIN_ROW_PX = 4;

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

/* ── 시트 분석 ───────────────────────────────────────────────────────── */

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

function findSpans(flags) {
  const spans = [];
  let start = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] && start < 0) start = i;
    else if (!flags[i] && start >= 0) {
      spans.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) spans.push([start, flags.length - 1]);
  return spans;
}

/** 시트 전체 폭을 n등분 — 섬광 때문에 프레임이 붙어 버렸을 때 쓴다 */
function evenCells(width, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([Math.round((width * i) / n), Math.round((width * (i + 1)) / n) - 1]);
  }
  return out;
}

/**
 * 그림이 실제로 있는 세로 구간.
 *
 * 생성 도구가 넣은 "Frame1 Frame2…" 라벨이나 배경 제거 후 남은 잡티가 본체와
 * 뚝 떨어진 얇은 띠로 나타난다. 그대로 두면 합집합 경계가 그것까지 삼켜
 * 유닛이 실제보다 작게 축소된다 — 실제로 230px짜리가 569px로 잡혔다.
 * 그래서 **본체에서 멀리 떨어진 얇은 띠는 버린다.**
 */
function contentRange(png) {
  const rows = new Uint8Array(png.height);
  for (let y = 0; y < png.height; y++) {
    let n = 0;
    for (let x = 0; x < png.width; x++) {
      if (png.data[(png.width * y + x) * 4 + 3] >= ALPHA_MIN) n++;
    }
    rows[y] = n >= MIN_ROW_PX ? 1 : 0;
  }
  const bands = findSpans(rows);
  if (!bands.length) return { top: -1, bot: -1, dropped: [] };

  const main = bands.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  const mainH = main[1] - main[0] + 1;
  const kept = [];
  const dropped = [];
  for (const b of bands) {
    const h = b[1] - b[0] + 1;
    const gap = b[0] > main[1] ? b[0] - main[1] : main[0] - b[1];
    // 본체 높이의 15%보다 얇으면서 본체에서 10% 넘게 떨어져 있으면 잡티/라벨
    if (b !== main && h < mainH * 0.15 && gap > mainH * 0.1) dropped.push(b);
    else kept.push(b);
  }
  return {
    top: Math.min(...kept.map((b) => b[0])),
    bot: Math.max(...kept.map((b) => b[1])),
    dropped,
  };
}

/** 구간 안에서 그림이 차지하는 세로 범위 (전역 content 범위로 제한) */
function verticalBounds(png, x0, x1, lo, hi) {
  let top = -1;
  let bot = -1;
  for (let y = lo; y <= hi; y++) {
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

function analyze(file, wantFrames) {
  const raw = readFileSync(file);
  if (!(raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47)) {
    const jpg = raw[0] === 0xff && raw[1] === 0xd8;
    throw new Error(
      jpg
        ? `${path.basename(file)} 는 (확장자와 무관하게) JPG다 — 알파 채널이 없다.\n` +
          '   tools/dealpha.mjs 로 배경을 지운 뒤 art-src/clean/ 의 파일을 쓸 것.'
        : `${path.basename(file)} 가 PNG가 아니다`,
    );
  }
  const png = PNG.sync.read(raw);

  let transparent = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] < ALPHA_MIN) transparent++;
  if (transparent / (png.width * png.height) < 0.02) {
    throw new Error(
      `${path.basename(file)} 에 투명한 픽셀이 거의 없다 — 배경이 구워진 상태다.\n` +
        '   tools/dealpha.mjs 로 먼저 지울 것.',
    );
  }

  const range = contentRange(png);
  if (range.top < 0) throw new Error(`${path.basename(file)} 에서 그림을 찾지 못했다`);

  let spans = findSpans(columnOccupancy(png));
  const specks = spans.filter((s) => s[1] - s[0] + 1 < MIN_SPAN).length;
  spans = spans.filter((s) => s[1] - s[0] + 1 >= MIN_SPAN);
  let grid = false;
  if (wantFrames && spans.length !== wantFrames) {
    spans = evenCells(png.width, wantFrames);
    grid = true;
  }

  const frames = [];
  let top = Infinity;
  let bot = -Infinity;
  let maxW = 0;
  for (const [x0, x1] of spans) {
    const [t, b] = verticalBounds(png, x0, x1, range.top, range.bot);
    if (t < 0) continue;
    frames.push({ x0, x1, top: t, bot: b });
    top = Math.min(top, t);
    bot = Math.max(bot, b);
    maxW = Math.max(maxW, x1 - x0 + 1);
  }
  if (!frames.length) throw new Error(`${path.basename(file)} 에서 프레임을 찾지 못했다`);

  return { png, frames, top, bot, unionH: bot - top + 1, maxW, specks, grid, dropped: range.dropped };
}

/* ── 출력 ────────────────────────────────────────────────────────────── */

/** 박스 필터 축소 — 색을 알파로 가중해 더해야 투명한 가장자리 색이 배지 않는다 */
function resampleInto(src, sx0, sy0, sw, sh, dst, dx0, dy0, dw, dh) {
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(sy0 + (dy * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.ceil(sy0 + ((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(sx0 + (dx * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.ceil(sx0 + ((dx + 1) * sw) / dw));
      const ty = dy0 + dy;
      const tx = dx0 + dx;
      if (ty < 0 || ty >= dst.height || tx < 0 || tx >= dst.width) continue;

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
          r += src.data[i] * av;
          g += src.data[i + 1] * av;
          b += src.data[i + 2] * av;
          a += av;
          n++;
        }
      }
      if (!n) continue;
      const di = (dst.width * ty + tx) * 4;
      if (a > 0) {
        dst.data[di] = Math.round(r / a);
        dst.data[di + 1] = Math.round(g / a);
        dst.data[di + 2] = Math.round(b / a);
      }
      dst.data[di + 3] = Math.round(a / n);
    }
  }
}

function emit(sheet, scale, outPath) {
  const { png, frames, top, unionH } = sheet;
  const feetY = Math.round(CELL * (1 - FEET_FROM_BOTTOM));
  const out = new PNG({ width: CELL * frames.length, height: CELL });
  out.data.fill(0);

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const sw = f.x1 - f.x0 + 1;
    const dw = Math.round(sw * scale);
    const dh = Math.round(unionH * scale);
    const dx = i * CELL + Math.round((CELL - dw) / 2);
    const dy = feetY - dh;
    resampleInto(png, f.x0, top, sw, unionH, out, dx, dy, dw, dh);
  }
  writeFileSync(outPath, PNG.sync.write(out));
}

/* ── 본체 ────────────────────────────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2));
const unit = args.unit;
if (!unit) {
  console.error('사용: node tools/slice-sheet.mjs --unit <id> [--tier t] walk=<파일> attack=<파일>');
  process.exit(1);
}

const tierName = typeof args.tier === 'string' ? args.tier : 'medium';
if (!TIERS[tierName]) {
  console.error(`--tier 는 ${Object.keys(TIERS).join(' | ')} 중 하나여야 한다`);
  process.exit(1);
}
const fill = TIERS[tierName];
const wantFrames = args.frames ? Number(args.frames) : 0;

// anim=file 형태가 하나라도 있으면 다중 모드
const pairs = [];
for (const a of args._) {
  const eq = a.indexOf('=');
  if (eq > 0) pairs.push([a.slice(0, eq), a.slice(eq + 1)]);
}
if (!pairs.length) {
  const file = args._[0];
  if (!file) {
    console.error('시트 파일을 지정할 것');
    process.exit(1);
  }
  pairs.push([typeof args.anim === 'string' ? args.anim : 'walk', file]);
}

const sheets = [];
for (const [anim, file] of pairs) {
  try {
    const s = analyze(file, wantFrames);
    sheets.push({ anim, file, ...s });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

console.log(`유닛 ${unit} · 등급 ${tierName}(${Math.round(fill * 100)}%)`);
for (const s of sheets) {
  console.log(
    `  ${s.anim.padEnd(7)} ${path.basename(s.file).padEnd(26)} ` +
      `프레임 ${s.frames.length}개 · 높이 ${s.unionH}px · 폭 ${s.maxW}px` +
      (s.grid ? ' (균등 격자)' : '') +
      (s.specks ? ` · 잡티 ${s.specks}개 무시` : '') +
      (s.dropped.length ? ` · 라벨/잡티 띠 ${s.dropped.length}개 제외` : ''),
  );
}

/**
 * 배율은 **기준 동작의 첫 프레임 하나로만** 정한다.
 *
 * 합집합을 쓰면 안 된다. 합집합에는 총구 섬광이나 폭발이 들어가는데, 그건 몸이
 * 아니라 이펙트다. 이펙트까지 등급 안에 밀어 넣으면 **이펙트가 화려한 유닛일
 * 수록 몸이 작아진다** — 실제로 공성전차가 물어뜯는것보다 작게 나왔다.
 *
 * 첫 프레임은 어느 시트에서든 중립 자세다(이펙트가 아직 없다). 그래서 몸
 * 크기를 재는 기준으로 가장 믿을 만하다. walk가 있으면 walk를, 없으면 첫
 * 시트를 쓴다.
 */
const ref = sheets.find((s) => s.anim === 'walk' || s.anim === 'idle') ?? sheets[0];
const refFrame = ref.frames[0];
const refH = refFrame.bot - refFrame.top + 1;
const refW = refFrame.x1 - refFrame.x0 + 1;
let scale = (CELL * fill) / refH;
if (refW * scale > CELL) {
  scale = CELL / refW;
  console.log(`  가로가 셀을 넘쳐 축소율을 낮춘다`);
}
console.log(
  `  기준: ${ref.anim} 0번 프레임 (몸 ${refH}px, 합집합 ${ref.unionH}px) → 배율 ${scale.toFixed(3)}`,
);

for (const s of sheets) {
  const h = Math.round(s.unionH * scale);
  if (h > CELL) {
    console.log(`  ${s.anim}: 이펙트가 셀보다 ${h - CELL}px 크다 — 위쪽이 잘린다`);
  }
}

if (args.dry) {
  console.log('  --dry 이므로 파일을 쓰지 않는다');
  process.exit(0);
}

const outDir = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'public',
  'art',
  'units',
);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const entries = [];
for (const s of sheets) {
  const dst = path.join(outDir, `${unit}.${s.anim}.png`);
  emit(s, scale, dst);
  const fps = args.fps ? Number(args.fps) : s.anim === 'attack' ? 14 : s.frames.length === 1 ? 1 : 10;
  entries.push(`"${s.anim}": { "frames": ${s.frames.length}, "fps": ${fps} }`);
  console.log(`  ✅ units/${unit}.${s.anim}.png`);
}

console.log(`\nmanifest.json 에 추가:`);
console.log(`    "${unit}": { ${entries.join(', ')} }`);
