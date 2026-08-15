/**
 * 두들(지형 소품) 시트 생성기 — MAP_RULES §8-3.
 *
 * 스타1의 빈 땅에는 바위·풀·해골이 흩어져 있다. 통행에는 아무 영향이
 * 없지만, 그것이 있고 없고가 "만든 지형"과 "칠한 지형"을 가른다.
 *
 * 아트 발주 대신 여기서 절차적으로 굽는다 — 소품은 24px 실루엣이라
 * 손그림의 이점이 거의 없고, 팔레트를 코드로 잡으면 타일셋과 색이 어긋나지
 * 않는다. 나중에 진짜 시트가 생기면 이 파일이 만든 PNG만 갈아끼우면 된다.
 *
 * 출력: public/art/doodads.png — 24px 정사각 12칸 가로 스트립.
 *   0~2 바위(소·중·대) · 3~4 풀포기 · 5 덤불 · 6 해골 · 7 고사목
 *   8 수정 조각 · 9 갈라진 석판 · 10 마른 가시 · 11 이끼 웅덩이
 */
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

const CELL = 24;
const COUNT = 12;
const png = new PNG({ width: CELL * COUNT, height: CELL });

/** 셀 좌표계로 찍는다 — (0,0)이 그 칸의 왼쪽 위 */
function px(cell, x, y, [r, g, b, a = 255]) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= CELL || y >= CELL) return;
  const gx = cell * CELL + x;
  const i = (y * png.width + gx) * 4;
  const na = a / 255;
  png.data[i] = Math.round(r * na + png.data[i] * (1 - na));
  png.data[i + 1] = Math.round(g * na + png.data[i + 1] * (1 - na));
  png.data[i + 2] = Math.round(b * na + png.data[i + 2] * (1 - na));
  png.data[i + 3] = Math.max(png.data[i + 3], a);
}
const rect = (c, x, y, w, h, col) => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(c, x + i, y + j, col);
};
const blob = (c, cx, cy, r, col) => {
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.4) px(c, cx + x, cy + y, col);
};
/** 발밑 그림자 — 모든 소품이 같은 광원(북서)을 공유해야 지형과 어긋나지 않는다 */
const shadow = (c, cx, cy, w) => {
  for (let x = -w; x <= w; x++) {
    const h = Math.round(Math.sqrt(Math.max(0, w * w - x * x)) * 0.35);
    for (let y = -h; y <= h; y++) px(c, cx + x + 1, cy + y, [0, 0, 0, 60]);
  }
};

/* ── 팔레트 — 타일셋과 같은 계열로 묶는다 ─────────────────────────── */
const ROCK = [124, 116, 104];
const ROCK_L = [162, 154, 140];
const ROCK_D = [78, 72, 64];
const GRASS = [86, 132, 62];
const GRASS_L = [122, 168, 84];
const BONE = [222, 214, 190];
const BONE_D = [166, 158, 136];
const WOOD = [92, 70, 48];
const WOOD_D = [60, 44, 30];
const CRYS = [103, 232, 249];
const CRYS_D = [34, 140, 160];
const MOSS = [72, 110, 66];

/* 0~2 바위 — 크기만 다른 같은 문법 (밝은 면 북서, 어두운 면 남동) */
for (const [c, r] of [[0, 3], [1, 5], [2, 7]]) {
  const cy = 15;
  shadow(c, 12, cy + r - 1, r + 2);
  blob(c, 12, cy, r, ROCK);
  blob(c, 12 - Math.round(r * 0.3), cy - Math.round(r * 0.35), Math.max(1, r - 2), ROCK_L);
  for (let i = 0; i < r; i++) px(c, 12 + r - i - 1, cy + Math.round(r * 0.4), ROCK_D);
}

/* 3~4 풀포기 — 가닥 몇 개. 끝이 밝다 */
for (const [c, n] of [[3, 5], [4, 8]]) {
  shadow(c, 12, 19, 4);
  for (let i = 0; i < n; i++) {
    const bx = 12 + (i - n / 2) * 2;
    const h = 5 + ((i * 7) % 4);
    const lean = ((i % 3) - 1) * 0.6;
    for (let j = 0; j < h; j++) {
      px(c, bx + lean * (j / h) * 2, 19 - j, j > h - 3 ? GRASS_L : GRASS);
    }
  }
}

/* 5 덤불 — 둥근 잎 뭉치 */
{
  const c = 5;
  shadow(c, 12, 19, 6);
  blob(c, 12, 15, 5, GRASS);
  blob(c, 10, 13, 3, GRASS_L);
  blob(c, 15, 15, 3, GRASS_L);
  rect(c, 11, 18, 2, 3, WOOD_D);
}

/* 6 해골 — 두개골과 갈비뼈 두 조각 */
{
  const c = 6;
  shadow(c, 12, 18, 5);
  blob(c, 11, 14, 4, BONE);
  rect(c, 9, 13, 2, 2, ROCK_D); // 눈구멍
  rect(c, 12, 13, 2, 2, ROCK_D);
  rect(c, 10, 17, 5, 2, BONE_D);
  for (let i = 0; i < 4; i++) rect(c, 15 + i, 16 + (i % 2), 2, 1, BONE);
}

/* 7 고사목 — 부러진 그루터기와 가지 */
{
  const c = 7;
  shadow(c, 12, 20, 5);
  rect(c, 10, 9, 4, 12, WOOD);
  rect(c, 10, 9, 2, 12, WOOD_D);
  for (const [x, y, w] of [[7, 12, 3], [14, 10, 3], [15, 14, 2]]) rect(c, x, y, w, 2, WOOD);
  rect(c, 8, 20, 8, 2, WOOD_D);
}

/* 8 수정 조각 — 미네랄과 같은 청록 계열 */
{
  const c = 8;
  shadow(c, 12, 20, 5);
  for (const [x, h] of [[9, 8], [12, 11], [15, 6]]) {
    for (let j = 0; j < h; j++) {
      const w = Math.max(1, 3 - Math.floor((j / h) * 3));
      rect(c, x - w / 2 + 1, 20 - j, w, 1, j > h * 0.6 ? CRYS : CRYS_D);
    }
  }
}

/* 9 갈라진 석판 — 고지용. 마른 땅에 어울리는 판과 균열 */
{
  const c = 9;
  rect(c, 5, 9, 14, 9, ROCK);
  rect(c, 5, 9, 14, 2, ROCK_L);
  rect(c, 5, 16, 14, 2, ROCK_D);
  // 균열 — 지그재그 한 줄
  let x = 7;
  for (let y = 10; y < 17; y++) {
    px(c, x, y, ROCK_D);
    px(c, x + 1, y, ROCK_D);
    x += ((y * 5) % 3) - 1;
  }
}

/* 10 마른 가시 — 고지용 잡초 */
{
  const c = 10;
  shadow(c, 12, 19, 3);
  for (let i = 0; i < 6; i++) {
    const bx = 12 + (i - 3) * 2;
    const h = 4 + ((i * 3) % 3);
    for (let j = 0; j < h; j++) px(c, bx + (j % 2), 19 - j, [140, 124, 84]);
  }
}

/* 11 이끼 웅덩이 — 저지 습한 자리 */
{
  const c = 11;
  blob(c, 12, 15, 6, [40, 62, 48, 150]);
  blob(c, 12, 15, 5, MOSS);
  blob(c, 10, 13, 2, GRASS);
  blob(c, 15, 17, 2, GRASS);
}

writeFileSync(
  new URL('../public/art/doodads.png', import.meta.url),
  PNG.sync.write(png),
);
console.log(`doodads.png — ${COUNT}칸 × ${CELL}px`);
