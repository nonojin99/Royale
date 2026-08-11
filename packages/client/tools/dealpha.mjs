/**
 * 구워진 체크무늬 배경을 지우고 투명 PNG로 되살린다.
 *
 * 생성 도구가 JPG로 내보내면 **미리보기의 투명 체크무늬가 실제 픽셀이 된다.**
 * JPG에는 알파 채널이 없으므로 확장자만 PNG로 바꿔도 소용없다. 이 도구는
 * 체크무늬를 실제로 지워서 알파를 복원한다.
 *
 * ── 어떻게 구분하는가 ──────────────────────────────────────────────────
 * 체크무늬는 **무채색이고 밝다**(회색 215 / 흰색 255). 유닛은 갈색·금색·파랑
 * 처럼 채도가 있거나 어둡다. 그래서 "무채색이면서 밝은" 픽셀을 배경 후보로
 * 본다.
 *
 * 다만 그것만으로는 유닛 안쪽의 흰 하이라이트까지 뚫린다. 그래서 후보 중
 * **가장자리에서 이어진 것만** 지운다(플러드 필). 유닛 내부는 테두리와
 * 이어져 있지 않으므로 살아남는다.
 *
 * ── 품질 ───────────────────────────────────────────────────────────────
 * JPG 압축 때문에 경계에 1~2px 잡티가 남는다. 다만 이후 슬라이서가 원본
 * 330px짜리를 128px 셀로 3~5배 줄이므로 그 오차는 화면에서 거의 사라진다.
 * 그래도 **생성 단계에서 투명 PNG로 뽑는 것이 언제나 더 낫다.** 이 도구는
 * 이미 JPG로 받아 버린 것을 구제하기 위한 것이다.
 *
 * 사용:
 *   node tools/dealpha.mjs ../../art-src/FxDOx.jpg
 *   node tools/dealpha.mjs --all ../../art-src
 *   node tools/dealpha.mjs 시트.jpg --cropbottom 14   (구워진 라벨 잘라내기)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/** 무채색 판정 — 채널 최대·최소 차이가 이보다 작으면 회색으로 본다 */
const NEUTRAL_TOL = 16;
/** 밝기 하한 — 체크무늬는 215 이상이다. 여유를 두되 유닛의 중간톤은 안 걸리게 */
const BRIGHT_MIN = 196;
/** 경계 알파를 부드럽게 만드는 거리 기준 */
const EDGE_SOFT = 70;

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

function decode(file) {
  const raw = readFileSync(file);
  if (raw[0] === 0x89 && raw[1] === 0x50) {
    const p = PNG.sync.read(raw);
    return { width: p.width, height: p.height, data: p.data };
  }
  const j = jpeg.decode(raw, { useTArray: true, formatAsRGBA: true });
  return { width: j.width, height: j.height, data: j.data };
}

/** 체크무늬일 법한 픽셀인가 — 무채색이면서 밝다 */
function bgLike(d, i) {
  const r = d[i];
  const g = d[i + 1];
  const b = d[i + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min <= NEUTRAL_TOL && min >= BRIGHT_MIN;
}

function processFile(file, opts) {
  const img = decode(file);
  const { width, height, data } = img;

  // 구워진 라벨 등을 잘라낼 영역
  const cutBottom = opts.cropbottom ? Math.round((height * Number(opts.cropbottom)) / 100) : 0;
  const cutTop = opts.croptop ? Math.round((height * Number(opts.croptop)) / 100) : 0;
  const y0 = cutTop;
  const y1 = height - cutBottom;

  /** 0 = 미판정, 1 = 배경(지움) */
  const bg = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < y0 || x >= width || y >= y1) return;
    const k = y * width + x;
    if (bg[k]) return;
    if (!bgLike(data, k * 4)) return;
    bg[k] = 1;
    stack.push(k);
  };

  // 자른 영역의 테두리에서 시작한다
  for (let x = 0; x < width; x++) {
    push(x, y0);
    push(x, y1 - 1);
  }
  for (let y = y0; y < y1; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const k = stack.pop();
    const x = k % width;
    const y = (k / width) | 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  // 이펙트에 둘러싸여 테두리와 끊긴 배경 웅덩이가 남는다. 체크무늬는 밝은 칸과
  // 어두운 칸이 **번갈아** 나타나므로, 남은 후보 덩어리 안에 두 밝기가 모두
  // 상당량 있으면 배경으로 본다. 유닛의 흰 하이라이트에는 이 교대가 없다.
  const seen = new Uint8Array(width * height);
  let pockets = 0;
  for (let sk = 0; sk < bg.length; sk++) {
    if (bg[sk] || seen[sk] || !bgLike(data, sk * 4)) continue;
    const comp = [];
    const q = [sk];
    seen[sk] = 1;
    let light = 0;
    let dark = 0;
    while (q.length) {
      const k = q.pop();
      comp.push(k);
      const lum = (data[k * 4] + data[k * 4 + 1] + data[k * 4 + 2]) / 3;
      if (lum >= 243) light++;
      else dark++;
      const x = k % width;
      const y = (k / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < y0 || nx >= width || ny >= y1) continue;
        const nk = ny * width + nx;
        if (seen[nk] || bg[nk] || !bgLike(data, nk * 4)) continue;
        seen[nk] = 1;
        q.push(nk);
      }
    }
    // 두 밝기가 모두 20% 이상이면 체크무늬다
    const total = light + dark;
    if (total >= 64 && light / total > 0.2 && dark / total > 0.2) {
      for (const k of comp) bg[k] = 1;
      pockets++;
    }
  }
  if (pockets) console.log(`  고립된 배경 웅덩이 ${pockets}곳 추가 제거`);

  /*
   * 바닥 그림자 제거 (--shadow).
   *
   * 생성 도구가 캐릭터 발밑에 부드러운 회색 그림자를 그려 넣는 경우가 있다.
   * 게임은 발밑에 팀 색 링을 따로 그리므로 그림자가 남으면 지저분하고, 무엇보다
   * 합집합 아래쪽을 "발"로 잡기 때문에 발 위치가 그림자만큼 아래로 밀린다.
   *
   * 그림자는 **채도가 낮고 어중간하게 밝다.** 장갑·갑주는 채도가 있거나 어둡다.
   * 다만 그 조건만으로는 은색 하이라이트도 걸리므로, 여기서도 **이미 지워진
   * 배경과 이어진 것만** 먹어 들어간다. 캐릭터 내부는 손대지 않는다.
   */
  if (opts.shadow) {
    const [maxSat, minLum] = String(opts.shadow === true ? '20,120' : opts.shadow)
      .split(',')
      .map(Number);
    const q = [];
    for (let k = 0; k < bg.length; k++) if (bg[k]) q.push(k);
    let eaten = 0;
    const shadowLike = (i) => {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      return mx - mn <= maxSat && (r + g + b) / 3 >= minLum;
    };
    while (q.length) {
      const k = q.pop();
      const x = k % width;
      const y = (k / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < y0 || nx >= width || ny >= y1) continue;
        const nk = ny * width + nx;
        if (bg[nk]) continue;
        if (!shadowLike(nk * 4)) continue;
        bg[nk] = 1;
        eaten++;
        q.push(nk);
      }
    }
    console.log(`  그림자 제거 — 채도≤${maxSat} 밝기≥${minLum} 조건으로 ${eaten}px`);
  }

  const out = new PNG({ width, height });
  let removed = 0;
  let kept = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = y * width + x;
      const i = k * 4;
      // 잘라낸 영역은 통째로 투명
      if (y < y0 || y >= y1) {
        out.data[i + 3] = 0;
        continue;
      }
      if (bg[k]) {
        out.data[i + 3] = 0;
        removed++;
        continue;
      }
      out.data[i] = data[i];
      out.data[i + 1] = data[i + 1];
      out.data[i + 2] = data[i + 2];

      // 지워진 픽셀과 맞닿은 자리는 배경과 섞여 있다. 배경색에서 얼마나
      // 멀어졌는지로 알파를 매겨 테두리 잡티를 줄인다.
      let touches = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < y0 || nx >= width || ny >= y1) continue;
        if (bg[ny * width + nx]) {
          touches = true;
          break;
        }
      }
      if (touches) {
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const dist = Math.max(0, 235 - lum);
        out.data[i + 3] = Math.round(Math.min(255, (dist / EDGE_SOFT) * 255));
      } else {
        out.data[i + 3] = 255;
      }
      kept++;
    }
  }

  // 기본 출력은 clean/ 하위. 원본에서 언제든 다시 만들 수 있는 중간 산출물이라
  // 저장소에 넣지 않는다(.gitignore).
  let dst;
  if (opts.out) {
    dst = String(opts.out);
  } else {
    const dir = path.join(path.dirname(file), 'clean');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    dst = path.join(dir, path.basename(file).replace(/\.[^.]+$/, '') + '.png');
  }
  writeFileSync(dst, PNG.sync.write(out));

  const pct = ((removed / (width * height)) * 100).toFixed(1);
  console.log(
    `${path.basename(file)} → ${path.basename(dst)}  ${width}×${height}  배경 ${pct}% 제거` +
      (cutBottom || cutTop ? `  (상 ${cutTop}px / 하 ${cutBottom}px 잘라냄)` : ''),
  );
  if (removed / (width * height) < 0.2) {
    console.warn('  ⚠ 지운 비율이 낮다 — 배경이 체크무늬가 아니거나 유닛이 화면을 꽉 채운다');
  }
  return { removed, kept };
}

const args = parseArgs(process.argv.slice(2));
if (args.all) {
  const dir = args._[0] ?? path.join(process.cwd(), '..', '..', 'art-src');
  const files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f));
  if (!files.length) {
    console.error(`${dir} 에 JPG가 없다`);
    process.exit(1);
  }
  console.log(`${files.length}장 처리\n`);
  for (const f of files) processFile(path.join(dir, f), args);
  console.log(`\n✅ ${files.length}장 완료 — 이제 slice-sheet.mjs 로 자르면 된다`);
} else {
  if (!args._[0]) {
    console.error('사용: node tools/dealpha.mjs <파일.jpg> | --all <폴더>');
    process.exit(1);
  }
  processFile(args._[0], args);
}
