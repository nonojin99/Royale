/**
 * 턴어라운드 시트 전처리 — 구워진 체커보드 배경과 격자선을 투명으로.
 *
 * 생성기가 내보낸 PNG는 투명이 아니라 회색 체커보드가 구워져 있는 경우가
 * 많다 (라운드 10.5 광전사에서 실측). strip.mjs의 --bgcolor auto는 단색
 * 배경용이라 체커보드에서는 경계 검출이 깨진다 — 이 도구를 먼저 돌린다.
 *
 * 지우는 것:
 *   1. 무채색 회색(밝기 112~220, RGB 채도 낮음) = 체커보드 두 톤
 *   2. 이미지를 관통하는 어두운 세로/가로 줄 = 칸 격자선
 *
 * 사용: node tools/clean-turnaround.mjs <원본.png> <출력.png>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('사용: node tools/clean-turnaround.mjs <원본.png> <출력.png>');
  process.exit(1);
}

const png = PNG.sync.read(readFileSync(src));
const { width: W, height: H, data } = png;

// 관통하는 어두운 줄(격자선) 찾기 — 캐릭터 윤곽선도 어둡지만 화면을
// 끝까지 가로지르지는 않는다
const darkX = new Array(W).fill(0);
const darkY = new Array(H).fill(0);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (data[i] + data[i + 1] + data[i + 2] < 180) {
      darkX[x]++;
      darkY[y]++;
    }
  }
}
const lineX = new Set();
const lineY = new Set();
for (let x = 0; x < W; x++)
  if (darkX[x] > H * 0.85) for (let k = -1; k <= 1; k++) lineX.add(x + k);
for (let y = 0; y < H; y++)
  if (darkY[y] > W * 0.85) for (let k = -1; k <= 1; k++) lineY.add(y + k);

let cleared = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const gray = Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && Math.abs(r - b) < 14;
    const bright = (r + g + b) / 3;
    if ((gray && bright > 112 && bright < 220) || lineX.has(x) || lineY.has(y)) {
      data[i + 3] = 0;
      cleared++;
    }
  }
}
writeFileSync(dst, PNG.sync.write(png));
console.log(
  `✅ ${dst} — 격자선 세로 ${lineX.size / 3}줄·가로 ${lineY.size / 3}줄, ` +
    `투명화 ${Math.round((100 * cleared) / (W * H))}%`,
);
