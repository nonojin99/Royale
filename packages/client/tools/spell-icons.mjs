// 주문 카드 아이콘 2장 — 46x46 픽셀 아트 (투명 배경)
// 융단폭격(carpetbomb): 낙하 폭탄 3발 + 지면 폭발 / 정신붕괴(mindbreak): 사이오닉 파열
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

const S = 46;

function make() {
  const png = new PNG({ width: S, height: S });
  return png;
}
function px(p, x, y, [r, g, b, a = 255]) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const na = a / 255;
  p.data[i] = Math.round(r * na + p.data[i] * (1 - na));
  p.data[i + 1] = Math.round(g * na + p.data[i + 1] * (1 - na));
  p.data[i + 2] = Math.round(b * na + p.data[i + 2] * (1 - na));
  p.data[i + 3] = Math.max(p.data[i + 3], a);
}
function disc(p, cx, cy, r, c) {
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++)
      if (x * x + y * y <= r * r + 0.5) px(p, cx + x, cy + y, c);
}
function ring(p, cx, cy, r, c, skip = 1) {
  const steps = Math.max(24, Math.round(r * 8));
  for (let i = 0; i < steps; i++) {
    if (skip > 1 && i % skip === 0) continue;
    const a = (i / steps) * Math.PI * 2;
    px(p, cx + Math.cos(a) * r, cy + Math.sin(a) * r, c);
  }
}
function line(p, x0, y0, x1, y1, c) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= n; i++)
    px(p, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
}

/* ── 융단폭격 — 강철 주황 팔레트 ── */
{
  const p = make();
  const GUN = [75, 85, 99], HI = [156, 163, 175], SH = [43, 50, 61];
  const FLAME = [249, 115, 22], CORE = [250, 204, 21], DEEP = [154, 52, 18];

  // 지면 폭발 (아래 중앙) — 삐죽한 화염 + 노란 핵
  const bx = 25, by = 36;
  disc(p, bx, by, 8, [DEEP[0], DEEP[1], DEEP[2], 200]);
  disc(p, bx, by, 6, FLAME);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    const r = i % 2 === 0 ? 10 : 7.5;
    line(p, bx + Math.cos(a) * 5, by + Math.sin(a) * 5,
      bx + Math.cos(a) * r, by + Math.sin(a) * r, i % 2 === 0 ? FLAME : CORE);
  }
  disc(p, bx, by, 3, CORE);
  px(p, bx - 1, by - 1, [255, 244, 214]);

  // 낙하 폭탄 3발 (좌상단에서 대각 낙하) — 몸통 5x8, 위 꼬리날개
  const bomb = (x, y) => {
    for (let yy = 0; yy < 7; yy++)
      for (let xx = 0; xx < 4; xx++) {
        const c = xx === 0 ? HI : xx === 3 ? SH : GUN;
        // 코(아래 끝)는 둥글게 — 모서리 생략
        if (yy === 6 && (xx === 0 || xx === 3)) continue;
        px(p, x + xx, y + yy, c);
      }
    px(p, x, y - 1, SH); px(p, x + 3, y - 1, SH); // 꼬리날개
    line(p, x + 1, y - 4, x + 2, y - 3, [148, 163, 184, 120]); // 낙하 잔상
  };
  bomb(7, 8);
  bomb(19, 3);
  bomb(31, 10);
  writeFileSync(
    '/home/user/pomingpu-royale/packages/client/public/art/units/carpetbomb.icon.png',
    PNG.sync.write(p),
  );
}

/* ── 정신붕괴 — 군체 보라 팔레트 ── */
{
  const p = make();
  const DK = [76, 29, 149], MID = [126, 34, 206], LT = [168, 85, 247], PALE = [216, 180, 254];
  const cx = 23, cy = 23;

  // 퍼지는 사이오닉 링 — 바깥일수록 어둡고 성기다
  ring(p, cx, cy, 19, [DK[0], DK[1], DK[2], 190], 3);
  ring(p, cx, cy, 14, MID, 4);
  ring(p, cx, cy, 9, LT);

  // 파열 균열 — 중심에서 밖으로 뻗는 지그재그
  const crack = (a) => {
    let x = cx, y = cy;
    for (let seg = 0; seg < 3; seg++) {
      const len = 5 + seg * 2;
      const wob = (seg % 2 === 0 ? 1 : -1) * 0.5;
      const nx = x + Math.cos(a + wob * 0.5) * len;
      const ny = y + Math.sin(a + wob * 0.5) * len;
      line(p, x, y, nx, ny, seg === 0 ? PALE : seg === 1 ? LT : MID);
      x = nx; y = ny;
    }
  };
  for (const a of [0.4, 1.7, 2.9, 4.1, 5.3]) crack(a);

  // 별 모양 핵 — 흰 중심
  line(p, cx - 6, cy, cx + 6, cy, PALE);
  line(p, cx, cy - 6, cx, cy + 6, PALE);
  disc(p, cx, cy, 3, LT);
  disc(p, cx, cy, 2, PALE);
  px(p, cx, cy, [255, 255, 255]);
  writeFileSync(
    '/home/user/pomingpu-royale/packages/client/public/art/units/mindbreak.icon.png',
    PNG.sync.write(p),
  );
}
console.log('icons written');
