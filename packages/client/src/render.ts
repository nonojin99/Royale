/**
 * PixiJS 렌더러.
 *
 * 시뮬레이션은 20Hz지만 화면은 60fps로 그린다. 그래서 엔티티 위치는 직전 틱과
 * 현재 틱 사이를 보간한다 — 이 보간이 없으면 눈에 띄게 끊겨 보인다.
 *
 * 렌더러는 시뮬 상태를 **읽기만** 한다. 여기서 상태를 건드리면 그 즉시
 * 결정론이 깨진다. 종족 필드·일꾼 애니메이션처럼 순수 외관 요소는 시뮬 상태에
 * 넣지 않고 여기서 상태를 보고 그린다.
 */

import { Application, Container, Graphics, Sprite, Text, TextStyle, Texture } from 'pixi.js';

import { art } from './art.js';

import {
  ARENA_H,
  ARENA_W,
  BASE_BUILD_TICKS,
  BASE_MINERAL_RESERVE,
  BASE_SITES,
  DEPLOY_RADIUS,
  DEPLOY_TICKS,
  Entity,
  GameState,
  MINERAL_PATCHES,
  SCALE,
  WALLS,
  blockedTile,
  elevTile,
  TEAM_COLOR_FOE,
  TEAM_COLOR_ME,
  Team,
  WORKER_CAP_PER_BASE,
  getFaction,
  getUnit,
  siteReachable,
  workersAtBase,
} from '@royale/shared';

/** 1 타일당 픽셀 */
const PX_PER_TILE = 30;

/**
 * 유닛 스프라이트가 차지하는 상자 높이.
 *
 * 이미지 안에서 소형은 캔버스의 55%, 대형은 90%를 채우기로 했으므로(ART_PIPELINE
 * §3.3) 이 값 하나로 소형 ~26px, 대형 ~42px가 나온다. 도형일 때의 지름 25px과
 * 소형이 맞아떨어지도록 잡은 값이다.
 */
const UNIT_SPRITE_H = PX_PER_TILE * 2.0;
/**
 * 미네랄 덩이와 일꾼.
 *
 * 기지 하나에 덩이 4개와 일꾼 8기가 폭 1.65타일 안에 들어간다. 유닛 규격을
 * 그대로 쓰면 서로 뭉개지므로 훨씬 작게 잡는다 — 읽히기만 하면 되는 배경 요소다.
 */
const MINERAL_SPRITE_H = PX_PER_TILE * 0.85;
const WORKER_SPRITE_H = PX_PER_TILE * 0.7;

/**
 * 이펙트 시트(`fx.png`)의 칸 번호 — 4행 6열을 행 우선으로 편 24칸.
 *
 * 1행 투사체(0~5) · 2행 착탄(6~11) · 3행 폭발(12~17) · 4행 연기(18~23).
 * 시트가 아직 없으면 같은 색의 도형 폴백으로 그린다.
 */
const FX_IMPACT: Record<string, number> = { steel: 13, swarmhive: 16, covenant: 15 };
const FX_DEATH: Record<string, number> = { steel: 19, swarmhive: 22, covenant: 21 };

/**
 * 지형 타일셋(`terrain.png`)의 칸 배정 — 4행 6열을 행 우선으로 편 24칸.
 *
 * 1행 잔디(0~5) · 2행 고지 마른 땅(6~11) · 3행 절벽 조각(12~17) ·
 * 4행 벽 바위(18~23). 변형은 [칸, 가중치] 표에서 좌표 시드 난수로 고른다 —
 * 민무늬가 대부분이고 들꽃·이끼는 드물어야 바닥이 산만하지 않다.
 */
const T_LOW: Array<[number, number]> = [[0, 38], [1, 38], [2, 8], [3, 8], [4, 4], [5, 4]];
const T_HIGH: Array<[number, number]> = [[6, 38], [7, 38], [8, 8], [9, 8], [10, 4], [11, 4]];
/** 남쪽(화면 아래)이 저지인 고지 타일 — 절벽면이 드러난다 */
const T_CLIFF_S: Array<[number, number]> = [[12, 50], [17, 50]];
/** 서/동쪽 가장자리 기둥 절벽 */
const T_CLIFF_W = 14;
const T_CLIFF_E = 15;
const T_WALL: Array<[number, number]> = [[18, 30], [19, 30], [20, 12], [21, 12], [22, 8], [23, 8]];

/** [칸, 가중치] 표에서 0~1 난수로 하나 고른다 */
function pickCell(table: Array<[number, number]>, n: number): number {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [cell, w] of table) {
    acc += w;
    if (n * total < acc) return cell;
  }
  return table[table.length - 1][0];
}
const FX_COLOR: Record<string, number> = {
  steel: 0xf97316,
  swarmhive: 0xa855f7,
  covenant: 0x22d3ee,
};
export const VIEW_W = (ARENA_W / SCALE) * PX_PER_TILE;
export const VIEW_H = (ARENA_H / SCALE) * PX_PER_TILE;

const COLORS = {
  bg: 0x0d1b12,
  ground: 0x1a6b3a,
  groundAlt: 0x176034,
  wall: 0x3f3f46,
  wallEdge: 0x71717a,
  teamMe: TEAM_COLOR_ME,
  teamFoe: TEAM_COLOR_FOE,
  hp: 0x22c55e,
  hpBg: 0x0f172a,
  deployRing: 0xfacc15,
  siteMarker: 0x94a3b8,
  mineral: 0x67e8f9,
  worker: 0xfde68a,
} as const;

export interface RenderInput {
  state: GameState;
  myTeam: Team;
  /** 직전 틱의 엔티티 위치 (id → [x,y]) */
  prev: Map<number, [number, number]>;
  /** 0~1 보간 계수 */
  alpha: number;
  /** 마우스/터치가 가리키는 아레나 좌표 (밀리타일). 없으면 null */
  cursor: [number, number] | null;
  /** 배치 가능 여부 (커서 위치 기준) */
  cursorValid: boolean;
  /** 기지 건설 모드면 스냅될 지점을 표시한다 */
  pendingSite: { x: number; y: number } | null;
  /** 배치 가능 구역을 표시할지 */
  showDeployZone: boolean;
}

export class Renderer {
  readonly app = new Application();
  private readonly world = new Container();
  /** 지형 타일 스프라이트 — 시트가 있을 때만 채워진다. 맨 아래 층 */
  private readonly gTiles = new Container();
  private readonly gTerrain = new Graphics();
  private readonly gField = new Graphics();
  private readonly gZone = new Graphics();
  /** 이미지가 없는 엔티티의 도형 + 스프라이트 아래에 깔리는 것(그림자·발판 링) */
  private readonly gEntities = new Graphics();
  /** 이미지가 있는 엔티티. y좌표로 정렬해 아래쪽이 위에 겹치게 한다 */
  private readonly sprites = new Container();
  /** 체력바처럼 스프라이트 **위에** 떠야 하는 것 */
  private readonly gDecor = new Graphics();
  private readonly gOverlay = new Graphics();
  private readonly labels = new Container();
  private readonly labelPool: Text[] = [];
  private readonly spritePool: Sprite[] = [];
  private terrainDrawn = false;
  private labelCount = 0;
  private spriteCount = 0;

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      width: VIEW_W,
      height: VIEW_H,
      background: COLORS.bg,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    host.appendChild(this.app.canvas);
    this.sprites.sortableChildren = true;
    this.world.addChild(
      this.gTiles,
      this.gTerrain,
      this.gField,
      this.gZone,
      this.gEntities,
      this.sprites,
      this.gDecor,
      this.gOverlay,
      this.labels,
    );
    this.app.stage.addChild(this.world);
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /* ── 좌표 변환 ───────────────────────────────────────────────────────── */

  /** 아레나 좌표(밀리타일) → 화면 픽셀. 내 팀이 1이면 180° 뒤집는다 */
  toScreen(x: number, y: number, myTeam: Team): [number, number] {
    const ax = myTeam === 0 ? x : ARENA_W - x;
    const ay = myTeam === 0 ? y : ARENA_H - y;
    return [(ax / SCALE) * PX_PER_TILE, (ay / SCALE) * PX_PER_TILE];
  }

  /** 화면 픽셀 → 아레나 좌표(밀리타일) */
  toArena(px: number, py: number, myTeam: Team): [number, number] {
    const ax = (px / PX_PER_TILE) * SCALE;
    const ay = (py / PX_PER_TILE) * SCALE;
    return myTeam === 0 ? [ax, ay] : [ARENA_W - ax, ARENA_H - ay];
  }

  private pxLen(mt: number): number {
    return (mt / SCALE) * PX_PER_TILE;
  }

  /* ── 그리기 ──────────────────────────────────────────────────────────── */

  draw(input: RenderInput): void {
    if (!this.terrainDrawn) {
      this.drawTerrain(input.myTeam);
      this.terrainDrawn = true;
    }
    // 미네랄·일꾼도 스프라이트를 쓰므로 풀 반납은 첫 사용처보다 앞에서 한 번에 한다
    this.resetSprites();
    this.drawFields(input);
    this.drawZone(input);
    this.drawEntities(input);
    this.drawOverlay(input);
  }

  /** 지형은 매 프레임 다시 그릴 이유가 없다 */
  private drawTerrain(myTeam: Team): void {
    const g = this.gTerrain;
    g.clear();
    this.gTiles.removeChildren();

    const t = PX_PER_TILE;
    const W = ARENA_W / SCALE;
    const H = ARENA_H / SCALE;
    // 타일셋이 있으면 이미지로, 없으면 페인트로. 한 판 안에서 섞지 않는다
    const hasTiles = art.terrain(0) !== null;

    // 지형 좌표는 시점(myTeam)에 따라 화면이 뒤집히므로, 화면 타일 → 월드
    // 타일로 역변환해서 조회한다
    const worldTile = (sx: number, sy: number): [number, number] =>
      myTeam === 0 ? [sx, sy] : [W - 1 - sx, H - 1 - sy];

    // 렌더 전용 의사난수 — 잔디 얼룩과 타일 변형. 시뮬과 무관하다
    const noise = (x: number, y: number): number => {
      let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
      h = (h ^ (h >> 13)) * 1274126177;
      return ((h ^ (h >> 16)) >>> 0) % 1000 / 1000;
    };

    for (let sy = 0; sy < H; sy++) {
      for (let sx = 0; sx < W; sx++) {
        const [wx, wy] = worldTile(sx, sy);
        const high = elevTile(wx, wy) === 1;
        const n = noise(wx, wy);

        // 절벽 가장자리 — 고지가 저지와 만나는 변. 화면 기준으로 판정해서
        // 어느 팀 시점이든 그림자가 화면 아래쪽으로 떨어진다
        const edge = (dx: number, dy: number): boolean => {
          const [ax, ay] = worldTile(sx + dx, sy + dy);
          return sx + dx >= 0 && sy + dy >= 0 && sx + dx < W && sy + dy < H
            ? elevTile(ax, ay) === 0
            : false;
        };

        if (hasTiles) {
          let cell: number;
          if (blockedTile(wx, wy)) cell = pickCell(T_WALL, n);
          else if (!high) cell = pickCell(T_LOW, n);
          else if (edge(0, 1)) cell = pickCell(T_CLIFF_S, n);
          else if (edge(-1, 0)) cell = T_CLIFF_W;
          else if (edge(1, 0)) cell = T_CLIFF_E;
          else cell = pickCell(T_HIGH, n);

          const sp = new Sprite(art.terrain(cell)!);
          sp.position.set(sx * t, sy * t);
          sp.width = t;
          sp.height = t;
          this.gTiles.addChild(sp);

          // 북쪽 능선 조각은 시트에 없어서(위·아래가 섞인 칸뿐) 페인트로 잇는다
          if (high && !blockedTile(wx, wy) && edge(0, -1) && !edge(0, 1)) {
            g.rect(sx * t, sy * t, t, 3);
            g.fill({ color: 0xd9cf9a, alpha: 0.55 });
          }
          // 절벽 발치 그림자 — 저지 쪽으로 한 뼘 떨어뜨려 높이차를 만든다
          if (high && edge(0, 1)) {
            g.rect(sx * t, (sy + 1) * t, t, 4);
            g.fill({ color: 0x000000, alpha: 0.25 });
          }
          continue;
        }

        // ── 페인트 폴백 (시트가 없을 때) ──
        let c: number;
        if (high) c = n < 0.15 ? 0x8a7a4a : n < 0.5 ? 0x7d8f4e : 0x74884a;
        else c = n < 0.12 ? 0x145a30 : (sx + sy) % 2 === 0 ? COLORS.ground : COLORS.groundAlt;
        g.rect(sx * t, sy * t, t, t);
        g.fill(c);

        if (!high) continue;
        if (edge(0, 1)) {
          g.rect(sx * t, sy * t + t - 5, t, 5);
          g.fill({ color: 0x3f3626, alpha: 0.9 });
          g.rect(sx * t, (sy + 1) * t, t, 4);
          g.fill({ color: 0x000000, alpha: 0.25 });
        }
        if (edge(0, -1)) {
          g.rect(sx * t, sy * t, t, 3);
          g.fill({ color: 0xd9cf9a, alpha: 0.7 });
        }
        if (edge(-1, 0)) {
          g.rect(sx * t, sy * t, 3, t);
          g.fill({ color: 0xa89968, alpha: 0.6 });
        }
        if (edge(1, 0)) {
          g.rect(sx * t + t - 3, sy * t, 3, t);
          g.fill({ color: 0x4a3f2c, alpha: 0.7 });
        }
      }
    }

    // 벽 — 지상 유닛이 못 지나가는 지형. 아래쪽에 그림자를 깔아 높이를 준다
    for (const [x0, y0, x1, y1] of WALLS) {
      const [ax, ay] = this.toScreen(x0 * SCALE, y0 * SCALE, myTeam);
      const [bx, by] = this.toScreen((x1 + 1) * SCALE, (y1 + 1) * SCALE, myTeam);
      const rx = Math.min(ax, bx);
      const ry = Math.min(ay, by);
      const rw = Math.abs(bx - ax);
      const rh = Math.abs(by - ay);

      if (hasTiles) {
        // 바위 타일이 몸통이다. 여기서는 블록 밖으로 떨어지는 그림자와
        // 옅은 윤곽만 얹어 "지나갈 수 없다"를 붙잡아 둔다
        g.rect(rx + 3, ry + rh, rw, 4);
        g.fill({ color: 0x000000, alpha: 0.3 });
        g.rect(rx + rw, ry + 4, 3, rh);
        g.fill({ color: 0x000000, alpha: 0.3 });
        g.rect(rx, ry, rw, rh);
        g.stroke({ width: 1.5, color: 0x1c1c20, alpha: 0.55 });
        continue;
      }

      g.rect(rx + 3, ry + 4, rw, rh);
      g.fill({ color: 0x000000, alpha: 0.35 });
      g.rect(rx, ry, rw, rh);
      g.fill(COLORS.wall);
      g.rect(rx, ry, rw, rh);
      g.stroke({ width: 2, color: COLORS.wallEdge, alpha: 0.9 });
    }
  }

  /**
   * 종족 필드 — 기지를 세운 땅이 그 종족 색으로 물든다.
   *
   * 순수 외관이다. 시뮬 상태에는 아무 영향이 없고, 여기서 기지 목록을 보고
   * 그릴 뿐이다. 그래서 결정론 검증 대상이 늘지 않는다.
   */
  private drawFields(input: RenderInput): void {
    const { state, myTeam } = input;
    const g = this.gField;
    g.clear();

    // 아직 비어 있는 지점은 옅은 표식으로 남겨 "여기 지을 수 있다"를 알린다
    const taken = new Set<number>();
    for (const e of state.entities) if (e.kind === 'base') taken.add(e.siteId);

    for (const site of BASE_SITES) {
      if (taken.has(site.id)) continue;
      const [sx, sy] = this.toScreen(site.x, site.y, myTeam);
      // 이을 수 있는 지점(내 기지에서 11타일 안)은 또렷하게 — 다음 확장의
      // 후보가 한눈에 보여야 "출진해서 땅을 넓힌다"가 계획이 된다
      const ok = siteReachable(state, myTeam, site);
      g.circle(sx, sy, this.pxLen(1200));
      g.stroke({ width: ok ? 2.5 : 1.5, color: COLORS.siteMarker, alpha: ok ? 0.55 : 0.15 });
      this.drawMineralPatches(g, sx, sy, 1, ok ? 0.3 : 0.12, site.id);
    }

    for (const e of state.entities) {
      if (e.kind !== 'base') continue;
      const faction = getFaction(state.players[e.team].faction);
      const [sx, sy] = this.toScreen(e.x, e.y, myTeam);
      const r = this.pxLen(DEPLOY_RADIUS);

      // 종족 색으로 물든 영역 = 배치 가능 반경이기도 하다
      g.circle(sx, sy, r);
      g.fill({ color: faction.fieldColor, alpha: e.deploy > 0 ? 0.1 : 0.22 });
      g.circle(sx, sy, r);
      g.stroke({ width: 1.5, color: faction.fieldColor, alpha: 0.5 });

      // 남은 매장량에 비례해 미네랄 덩이를 그린다
      const left = Math.ceil((e.reserve / BASE_MINERAL_RESERVE) * MINERAL_PATCHES);
      this.drawMineralPatches(g, sx, sy, left, 1, e.siteId);
    }
  }

  /**
   * 기지 아래쪽에 미네랄 덩이를 늘어놓는다.
   *
   * `seed`는 지점 번호다 — 덩이마다 다른 변형을 고르되 같은 지점은 매 프레임
   * 같은 모양이어야 하므로, 난수가 아니라 지점·순번으로 결정한다.
   */
  private drawMineralPatches(
    g: Graphics,
    sx: number,
    sy: number,
    count: number,
    alpha: number,
    seed: number,
  ): void {
    const gap = PX_PER_TILE * 0.55;
    const y = sy + PX_PER_TILE * 1.15;
    const startX = sx - (gap * (MINERAL_PATCHES - 1)) / 2;
    for (let i = 0; i < count && i < MINERAL_PATCHES; i++) {
      const x = startX + gap * i;
      const tex = art.mineral(seed * MINERAL_PATCHES + i);
      if (tex) {
        this.place(tex, x, y + MINERAL_SPRITE_H * 0.3, MINERAL_SPRITE_H, 1).alpha = alpha;
      } else {
        g.rect(x - 4, y - 4, 8, 8);
        g.fill({ color: COLORS.mineral, alpha });
      }
    }
  }

  /** 배치 가능 구역 (카드를 고른 동안만) */
  private drawZone(input: RenderInput): void {
    const g = this.gZone;
    g.clear();
    if (!input.showDeployZone) return;

    for (const e of input.state.entities) {
      if (e.kind !== 'base' || e.team !== input.myTeam || e.deploy > 0) continue;
      const [sx, sy] = this.toScreen(e.x, e.y, input.myTeam);
      g.circle(sx, sy, this.pxLen(DEPLOY_RADIUS));
      g.stroke({ width: 2.5, color: 0x4ade80, alpha: 0.6 });
    }
  }

  private drawEntities(input: RenderInput): void {
    const { state, myTeam, prev, alpha } = input;
    const g = this.gEntities;
    const d = this.gDecor;
    g.clear();
    d.clear();
    this.resetLabels();
    this.pruneAnimState(state);

    for (const e of state.entities) {
      const p = prev.get(e.id);
      const ix = p ? p[0] + (e.x - p[0]) * alpha : e.x;
      const iy = p ? p[1] + (e.y - p[1]) * alpha : e.y;
      const [sx, sy] = this.toScreen(ix, iy, myTeam);
      const mine = e.team === myTeam;
      const teamColor = mine ? COLORS.teamMe : COLORS.teamFoe;

      if (e.kind === 'base') {
        this.drawBase(g, d, e, sx, sy, teamColor, state);
        continue;
      }

      const u = getUnit(e.unit);
      const moved = !!p && (p[0] !== e.x || p[1] !== e.y);
      const tex = this.frameFor(e, moved);

      if (e.kind === 'building') {
        const size = PX_PER_TILE * 1.5;
        if (tex) {
          g.ellipse(sx, sy + size * 0.12, size * 0.52, size * 0.22);
          g.fill({ color: 0x000000, alpha: 0.22 });
          this.groundRing(g, sx, sy, size * 0.5, teamColor);
          this.place(tex, sx, sy, PX_PER_TILE * 2.0, 0.85);
        } else {
          g.rect(sx - size / 2, sy - size / 2, size, size);
          g.fill(u.color);
          g.rect(sx - size / 2, sy - size / 2, size, size);
          g.stroke({ width: 3.5, color: teamColor });
        }
        if (e.deploy > 0) {
          this.progressBar(d, sx, sy + size * 0.5, size, 1 - e.deploy / DEPLOY_TICKS);
        }
        this.hpBar(d, sx, sy - size / 2 - 6, size, e);
        continue;
      }

      // 유닛. 공중 유닛은 그림자를 지면에 남기고 본체를 위로 띄운다.
      const r = PX_PER_TILE * 0.42;
      const lift = e.flying ? PX_PER_TILE * 0.55 : 0;
      const by = sy - lift;

      if (e.flying) {
        g.ellipse(sx, sy, r * 0.85, r * 0.4);
        g.fill({ color: 0x000000, alpha: 0.28 });
      }

      if (tex) {
        // 접지 그림자 — 이게 없으면 스프라이트가 바닥에 붙은 스티커로 보인다.
        // 공중 유닛의 "그림자가 떨어져 있음"도 지상 그림자가 있어야 대비가 산다
        if (!e.flying) {
          g.ellipse(sx, sy + r * 0.18, r * 0.95, r * 0.4);
          g.fill({ color: 0x000000, alpha: 0.22 });
        }
        // 팀 구분은 발밑 링으로 한다 — 이미지 위에 외곽선을 두르면 그림을 가린다
        if (!e.flying) this.groundRing(g, sx, sy, r, teamColor);
        this.place(tex, sx, by, UNIT_SPRITE_H, 0.88, this.facingOf(e, p, myTeam));
      } else {
        g.circle(sx, by, r);
        g.fill(u.color);
        g.circle(sx, by, r);
        g.stroke({ width: 2.5, color: teamColor });
      }

      if (e.flying) {
        const ring = tex ? r + 1 : r + 3;
        d.circle(sx, by, ring);
        d.stroke({ width: 1.5, color: tex ? teamColor : 0xffffff, alpha: tex ? 0.9 : 0.55 });
      }
      if (e.deploy > 0) {
        d.circle(sx, by, r + 4);
        d.stroke({ width: 2, color: COLORS.deployRing, alpha: 0.9 });
        this.progressBar(d, sx, by + r + 6, r * 2, 1 - e.deploy / DEPLOY_TICKS);
      }
      this.hpBar(d, sx, by - r - 6, PX_PER_TILE * 1.1, e);
    }

    this.spawnFx(state, myTeam);
    this.drawFx(d);
  }

  /**
   * 이 엔티티가 지금 보여야 할 프레임.
   *
   * 애니메이션 선택은 **시뮬 상태에서 파생**한다. 시뮬에 애니메이션 상태를
   * 넣으면 한쪽 클라이언트에만 이미지가 있어도 결정론이 깨진다.
   *
   * - 공격: 쿨다운이 올라간 순간 = 방금 쏜 것이다. 한 번만 재생한다
   * - 걷기: 직전 틱 대비 좌표가 변했다
   * - 그 외: 대기 (없으면 걷기 0프레임에서 멈춘다)
   */
  private frameFor(e: Entity, moved: boolean): Texture | null {
    const prevCd = this.prevCd.get(e.id);
    const fired = prevCd !== undefined && e.cd > prevCd;
    this.prevCd.set(e.id, e.cd);

    let st = this.animState.get(e.id);
    const attack = art.clip(e.unit, 'attack');

    if (fired && attack) {
      st = { name: 'attack', startMs: this.nowMs };
      this.animState.set(e.id, st);
    } else {
      // 공격 재생이 끝나기 전에는 다른 동작으로 넘어가지 않는다
      const busy =
        st?.name === 'attack' && attack && this.nowMs - st.startMs < attack.durationMs;
      if (!busy) {
        const want = moved && art.clip(e.unit, 'walk') ? 'walk' : 'idle';
        if (!st || st.name !== want) {
          st = { name: want, startMs: this.nowMs };
          this.animState.set(e.id, st);
        }
      }
    }

    const clip = art.clip(e.unit, st!.name) ?? art.clip(e.unit, 'walk');
    if (!clip) return art.unit(e.unit);

    const i = Math.floor(((this.nowMs - st!.startMs) / 1000) * clip.fps);
    // 대기는 걷기 첫 프레임에 멈춰 있고, 공격은 마지막 프레임에서 끝난다
    if (st!.name === 'idle' && !art.clip(e.unit, 'idle')) return clip.textures[0];
    const last = clip.textures.length - 1;
    return clip.textures[st!.name === 'attack' ? Math.min(i, last) : i % clip.textures.length];
  }

  /** 스프라이트 발밑에 두는 팀 색 타원 링 */
  private groundRing(g: Graphics, sx: number, sy: number, r: number, color: number): void {
    g.ellipse(sx, sy, r * 1.05, r * 0.45);
    g.fill({ color, alpha: 0.18 });
    g.ellipse(sx, sy, r * 1.05, r * 0.45);
    g.stroke({ width: 2, color, alpha: 0.85 });
  }

  private drawBase(
    g: Graphics,
    d: Graphics,
    e: Entity,
    sx: number,
    sy: number,
    teamColor: number,
    state: GameState,
  ): void {
    const faction = getFaction(state.players[e.team].faction);
    const size = e.isMain ? PX_PER_TILE * 2.4 : PX_PER_TILE * 1.8;
    const building = e.deploy > 0;
    const tex = art.base(state.players[e.team].faction, e.isMain);

    if (tex) {
      this.groundRing(g, sx, sy, size * 0.5, teamColor);
      const sp = this.place(tex, sx, sy, size * 1.25, 0.85);
      // 건설 중에는 반투명 — 도형일 때의 규칙을 그대로 옮긴다
      sp.alpha = building ? 0.45 : 1;
    } else {
      g.rect(sx - size / 2, sy - size / 2, size, size);
      g.fill({ color: faction.color, alpha: building ? 0.4 : 1 });
      g.rect(sx - size / 2, sy - size / 2, size, size);
      g.stroke({ width: 3.5, color: teamColor });

      if (e.isMain) {
        // 본진은 안쪽에 표식을 하나 더 둬서 확장과 즉시 구분되게 한다
        g.rect(sx - size / 6, sy - size / 6, size / 3, size / 3);
        g.fill({ color: 0xffffff, alpha: 0.75 });
      }
    }

    if (building) this.label('건설 중', sx, sy - size / 2 - 12, 10);
    if (e.reserve <= 0) this.label('고갈', sx, sy + size / 2 + 10, 10);
    // 고갈되고 나서 알리면 늦다 — 확장을 준비할 시간이 필요하다
    else if (e.reserve < BASE_MINERAL_RESERVE / 4)
      this.label('곧 고갈', sx, sy + size / 2 + 10, 10);

    if (building) {
      this.progressBar(d, sx, sy + size * 0.55, size, 1 - e.deploy / BASE_BUILD_TICKS);
    }
    this.hpBar(d, sx, sy - size / 2 - 7, size, e);
    this.drawWorkers(g, workersAtBase(state, e), sx, sy);
  }

  /* ── 스프라이트 풀 ───────────────────────────────────────────────────── */

  /**
   * 엔티티 하나를 스프라이트로 배치한다.
   *
   * 크기는 **유닛 종류와 무관하게 같은 상자**에 맞춘다. 유닛의 덩치 차이는
   * 이미지 안에서 캔버스 대비 55/70/90%로 표현하기로 했으므로(ART_PIPELINE
   * §3.3), 여기서 유닛별로 배율을 따로 주면 그 규격이 두 번 적용된다.
   */
  private place(
    tex: Texture,
    x: number,
    y: number,
    height: number,
    anchorY: number,
    flip = 1,
  ): Sprite {
    let sp = this.spritePool[this.spriteCount];
    if (!sp) {
      sp = new Sprite();
      this.spritePool.push(sp);
      this.sprites.addChild(sp);
    }
    this.spriteCount++;
    sp.texture = tex;
    sp.anchor.set(0.5, anchorY);
    const k = height / tex.height;
    sp.scale.set(k * flip, k);
    sp.position.set(x, y);
    // 아래쪽(= y가 큰) 것이 위에 그려져야 겹침이 자연스럽다
    sp.zIndex = Math.round(y);
    sp.alpha = 1;
    sp.visible = true;
    return sp;
  }

  private resetSprites(): void {
    for (const s of this.spritePool) s.visible = false;
    this.spriteCount = 0;
  }

  /**
   * 일꾼 — 기지와 미네랄 사이를 오간다.
   *
   * 시뮬 엔티티가 아니라 **기지 상태에서 파생된 애니메이션**이다. 그래서 공격
   * 대상이 되지 않는다. 일꾼 견제를 게임 규칙으로 넣는 것은 별개의 큰 작업이라
   * 지금은 수입의 시각화로만 둔다.
   */
  private drawWorkers(g: Graphics, count: number, sx: number, sy: number): void {
    if (count <= 0) return;
    // 덩이 하나에 일꾼 둘이 붙으므로, 덩이 열에 맞춰 두 줄로 늘어놓는다
    const gap = PX_PER_TILE * 0.55;
    const patchY = sy + PX_PER_TILE * 1.15;
    const startX = sx - (gap * (MINERAL_PATCHES - 1)) / 2;

    for (let i = 0; i < count && i < WORKER_CAP_PER_BASE; i++) {
      const lane = i % MINERAL_PATCHES;
      const row = Math.floor(i / MINERAL_PATCHES);
      // 일꾼마다 위상을 어긋나게 해서 한꺼번에 움직이지 않게 한다
      const phase = (this.workerPhase + i * 0.13) % 1;
      // 0→1 사이를 왕복 (0.5에서 반환)
      const t = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      const wx = startX + gap * lane + (row === 1 ? gap * 0.28 : -gap * 0.28);
      const wy = sy + (patchY - sy) * t;
      // 걷기 프레임도 같은 위상에서 고른다 — 왕복 위치와 다리가 따로 놀지 않는다
      const tex = art.worker(phase);
      if (tex) this.place(tex, wx, wy, WORKER_SPRITE_H, 1, phase < 0.5 ? 1 : -1);
      else {
        g.circle(wx, wy, 2.6);
        g.fill(COLORS.worker);
      }
    }
  }

  /* ── 애니메이션 시계 (전부 렌더 전용, 시뮬과 무관) ──────────────────── */

  /** 일꾼 애니메이션 위상 (0~1) */
  private workerPhase = 0;
  /** 렌더 기준 경과 시간(ms). 프레임 선택에 쓴다 */
  private nowMs = 0;
  /** 엔티티별 현재 동작 */
  private readonly animState = new Map<number, { name: string; startMs: number }>();
  /** 직전에 본 공격 쿨다운 — 올라가면 방금 쏜 것이다 */
  private readonly prevCd = new Map<number, number>();

  advanceAnimations(deltaMs: number): void {
    this.nowMs += deltaMs;
    // 1.6초에 한 번 왕복
    this.workerPhase = (this.workerPhase + deltaMs / 1600) % 1;
  }

  /** 엔티티별 마지막 좌우 방향 (1 = 원본, -1 = 거울상) */
  private readonly facing = new Map<number, 1 | -1>();

  /**
   * 이동 방향에 따른 좌우 반전.
   *
   * 아트는 화면 아래(약간 왼쪽)를 향한 한 장뿐이다. 위/아래 방향까지 아트로
   * 해결하려면 시트에 등 방향 행이 더 필요하지만, 좌우는 **거울상으로 공짜**다.
   * 수평 이동이 거의 없을 때는 마지막 방향을 유지한다 — 매 프레임 뒤집히면
   * 유닛이 파닥거린다.
   */
  private facingOf(e: Entity, prev: [number, number] | undefined, myTeam: Team): number {
    if (prev) {
      const dx = myTeam === 0 ? e.x - prev[0] : prev[0] - e.x; // 화면 기준 dx
      if (dx > 8) this.facing.set(e.id, -1);
      else if (dx < -8) this.facing.set(e.id, 1);
    }
    return this.facing.get(e.id) ?? 1;
  }

  /* ── 이펙트 (전부 렌더 전용, 시뮬과 무관) ──────────────────────────── */

  /** 재생 중인 이펙트. 수명이 다하면 지워진다 */
  private readonly fxList: Array<{
    tex: Texture | null;
    color: number;
    sx: number;
    sy: number;
    startMs: number;
    durMs: number;
    h: number;
  }> = [];
  /**
   * 이펙트가 생길 때 알림 — 사운드가 여기 붙는다.
   *
   * 렌더러가 직접 소리를 내지 않는 것은 층을 지키기 위해서다: 발사·죽음
   * 감지는 이미 여기서 하고 있으므로 감지를 두 번 하지 않고 결과만 넘긴다.
   */
  onFx: ((kind: 'impact' | 'death', faction: string, sx: number) => void) | null = null;

  /** 발사 감지용 — frameFor의 prevCd와 별도로 둬서 서로 간섭하지 않는다 */
  private readonly fxPrevCd = new Map<number, number>();
  /** 직전 프레임에 살아 있던 엔티티 — 사라지면 그 자리에 죽음 이펙트 */
  private readonly fxSeen = new Map<number, { sx: number; sy: number; faction: string }>();
  private fxLastTick = -1;

  /**
   * 시뮬 상태의 변화(발사·죽음)를 보고 이펙트를 만든다.
   *
   * 상태를 읽기만 하므로 결정론과 무관하다 — 공격 애니메이션을 고르는 것과
   * 같은 원리다. cd가 직전보다 커졌으면 방금 쐈다는 뜻이고, 그 순간 대상
   * 위치에 착탄을 심는다. 투사체 비행은 없다: 시뮬에 투사체가 없어서
   * 데미지가 즉시 들어가기 때문에, 날아가는 그림을 그리면 오히려
   * "맞았는데 아직 안 날아왔다"는 거짓말이 된다.
   */
  private spawnFx(state: GameState, myTeam: Team): void {
    // 틱이 뒤로 갔으면 새 경기다 — 이전 경기의 기억으로 이펙트를 만들면 안 된다
    if (state.tick < this.fxLastTick) {
      this.fxPrevCd.clear();
      this.fxSeen.clear();
      this.fxList.length = 0;
    }
    this.fxLastTick = state.tick;

    const byId = new Map<number, Entity>();
    for (const e of state.entities) byId.set(e.id, e);

    for (const e of state.entities) {
      const prev = this.fxPrevCd.get(e.id);
      this.fxPrevCd.set(e.id, e.cd);
      if (prev === undefined || e.cd <= prev) continue;
      const victim = byId.get(e.target);
      if (!victim) continue;
      const faction = state.players[e.team].faction;
      const [sx, sy] = this.toScreen(victim.x, victim.y, myTeam);
      const lift = victim.flying ? PX_PER_TILE * 0.55 : 0;
      this.pushFx(FX_IMPACT[faction], FX_COLOR[faction], sx, sy - lift, 300, PX_PER_TILE * 1.1);
      this.onFx?.('impact', faction, sx);
    }

    // 지난 프레임엔 있었는데 지금 없다 = 죽었다. 마지막 자리에 연기를 남긴다
    for (const [id, seen] of this.fxSeen) {
      if (byId.has(id)) continue;
      this.fxSeen.delete(id);
      this.fxPrevCd.delete(id);
      this.pushFx(
        FX_DEATH[seen.faction],
        FX_COLOR[seen.faction],
        seen.sx,
        seen.sy,
        550,
        PX_PER_TILE * 1.3,
      );
      this.onFx?.('death', seen.faction, seen.sx);
    }
    for (const e of state.entities) {
      const [sx, sy] = this.toScreen(e.x, e.y, myTeam);
      this.fxSeen.set(e.id, { sx, sy, faction: state.players[e.team].faction });
    }
  }

  private pushFx(
    index: number | undefined,
    color: number | undefined,
    sx: number,
    sy: number,
    durMs: number,
    h: number,
  ): void {
    // 대군 전투에서 이펙트가 수백 개로 불어나지 않게 오래된 것부터 버린다
    if (this.fxList.length >= 80) this.fxList.shift();
    this.fxList.push({
      tex: index === undefined ? null : art.fx(index),
      color: color ?? 0xffffff,
      sx,
      sy,
      startMs: this.nowMs,
      durMs,
      h,
    });
  }

  private drawFx(d: Graphics): void {
    for (let i = this.fxList.length - 1; i >= 0; i--) {
      const f = this.fxList[i];
      const t = (this.nowMs - f.startMs) / f.durMs;
      if (t >= 1) {
        this.fxList.splice(i, 1);
        continue;
      }
      if (f.tex) {
        // 살짝 커지며 사라진다. 프레임이 하나뿐이라 크기·투명도가 곧 애니메이션이다
        const sp = this.place(f.tex, f.sx, f.sy, f.h * (0.6 + 0.6 * t), 0.5);
        sp.alpha = 1 - t * t;
        sp.zIndex = Math.round(f.sy) + 4; // 같은 y의 유닛보다 위
      } else {
        // 시트가 아직 없다 — 종족 색 링이 퍼지며 사라진다
        const r = f.h * (0.25 + 0.55 * t);
        d.circle(f.sx, f.sy, r);
        d.stroke({ width: 3 * (1 - t), color: f.color, alpha: 0.8 * (1 - t) });
      }
    }
  }

  /** 죽은 엔티티가 남긴 항목을 걷어낸다 — 경기가 길어지면 계속 쌓인다 */
  private pruneAnimState(state: GameState): void {
    if (this.animState.size < state.entities.length * 2 + 32) return;
    const live = new Set(state.entities.map((e) => e.id));
    for (const id of this.animState.keys()) if (!live.has(id)) this.animState.delete(id);
    for (const id of this.prevCd.keys()) if (!live.has(id)) this.prevCd.delete(id);
    for (const id of this.facing.keys()) if (!live.has(id)) this.facing.delete(id);
  }

  /** 건설·배치 진행 게이지 — 노란 바가 차오른다 */
  private progressBar(g: Graphics, cx: number, cy: number, w: number, frac: number): void {
    const h = 4;
    g.rect(cx - w / 2, cy, w, h);
    g.fill({ color: COLORS.hpBg, alpha: 0.75 });
    g.rect(cx - w / 2, cy, w * Math.max(0, Math.min(1, frac)), h);
    g.fill(COLORS.deployRing);
  }

  private hpBar(g: Graphics, cx: number, cy: number, w: number, e: Entity): void {
    if (e.hp >= e.maxHp) return;
    const h = 4;
    const ratio = Math.max(0, e.hp) / e.maxHp;
    g.rect(cx - w / 2, cy, w, h);
    g.fill({ color: COLORS.hpBg, alpha: 0.7 });
    g.rect(cx - w / 2, cy, w * ratio, h);
    g.fill(COLORS.hp);
  }

  private drawOverlay(input: RenderInput): void {
    const g = this.gOverlay;
    g.clear();

    if (input.pendingSite) {
      const [sx, sy] = this.toScreen(input.pendingSite.x, input.pendingSite.y, input.myTeam);
      g.circle(sx, sy, this.pxLen(1300));
      g.stroke({ width: 3.5, color: 0xfacc15, alpha: 0.95 });
      g.circle(sx, sy, this.pxLen(DEPLOY_RADIUS));
      g.stroke({ width: 1.5, color: 0xfacc15, alpha: 0.35 });
      return;
    }

    if (!input.cursor) return;
    const [sx, sy] = this.toScreen(input.cursor[0], input.cursor[1], input.myTeam);
    g.circle(sx, sy, PX_PER_TILE * 0.9);
    g.stroke({
      width: 3,
      color: input.cursorValid ? 0x4ade80 : 0xef4444,
      alpha: 0.95,
    });
  }

  /* ── 텍스트 풀 ───────────────────────────────────────────────────────── */

  private resetLabels(): void {
    for (const t of this.labelPool) t.visible = false;
    this.labelCount = 0;
  }

  private label(text: string, x: number, y: number, size: number): void {
    let t = this.labelPool[this.labelCount];
    if (!t) {
      t = new Text({
        text,
        style: new TextStyle({
          fontSize: size,
          fill: 0xffffff,
          fontFamily: 'sans-serif',
          stroke: { color: 0x0f172a, width: 3 },
        }),
      });
      t.anchor.set(0.5);
      this.labelPool.push(t);
      this.labels.addChild(t);
    }
    t.text = text;
    t.position.set(x, y);
    t.visible = true;
    this.labelCount++;
  }
}
