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

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';

import {
  ARENA_H,
  ARENA_W,
  BASE_MINERAL_RESERVE,
  BASE_SITES,
  BRIDGE_HALF_W,
  BRIDGE_X,
  DEPLOY_RADIUS,
  Entity,
  GameState,
  MINERAL_PATCHES,
  RIVER_BOT,
  RIVER_TOP,
  SCALE,
  TEAM_COLOR_FOE,
  TEAM_COLOR_ME,
  Team,
  WORKER_CAP_PER_BASE,
  getFaction,
  getUnit,
  workersAtBase,
} from '@royale/shared';

/** 1 타일당 픽셀 */
const PX_PER_TILE = 30;
export const VIEW_W = (ARENA_W / SCALE) * PX_PER_TILE;
export const VIEW_H = (ARENA_H / SCALE) * PX_PER_TILE;

const COLORS = {
  bg: 0x0d1b12,
  ground: 0x1a6b3a,
  groundAlt: 0x176034,
  river: 0x1d4ed8,
  bridge: 0x92602e,
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
  private readonly gTerrain = new Graphics();
  private readonly gField = new Graphics();
  private readonly gZone = new Graphics();
  private readonly gEntities = new Graphics();
  private readonly gOverlay = new Graphics();
  private readonly labels = new Container();
  private readonly labelPool: Text[] = [];
  private terrainDrawn = false;
  private labelCount = 0;

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
    this.world.addChild(
      this.gTerrain,
      this.gField,
      this.gZone,
      this.gEntities,
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
    this.drawFields(input);
    this.drawZone(input);
    this.drawEntities(input);
    this.drawOverlay(input);
  }

  /** 지형은 매 프레임 다시 그릴 이유가 없다 */
  private drawTerrain(myTeam: Team): void {
    const g = this.gTerrain;
    g.clear();

    const t = PX_PER_TILE;
    for (let ty = 0; ty < ARENA_H / SCALE; ty++) {
      for (let tx = 0; tx < ARENA_W / SCALE; tx++) {
        g.rect(tx * t, ty * t, t, t);
        g.fill((tx + ty) % 2 === 0 ? COLORS.ground : COLORS.groundAlt);
      }
    }

    const [, ry0] = this.toScreen(0, RIVER_TOP, myTeam);
    const [, ry1] = this.toScreen(0, RIVER_BOT, myTeam);
    const top = Math.min(ry0, ry1);
    const h = Math.abs(ry1 - ry0);
    g.rect(0, top, VIEW_W, h);
    g.fill({ color: COLORS.river, alpha: 0.85 });

    for (const bx of BRIDGE_X) {
      const [sx0] = this.toScreen(bx - BRIDGE_HALF_W, 0, myTeam);
      const [sx1] = this.toScreen(bx + BRIDGE_HALF_W, 0, myTeam);
      g.rect(Math.min(sx0, sx1), top, Math.abs(sx1 - sx0), h);
      g.fill(COLORS.bridge);
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
      g.circle(sx, sy, this.pxLen(1200));
      g.stroke({ width: 2, color: COLORS.siteMarker, alpha: 0.35 });
      this.drawMineralPatches(g, sx, sy, 1, 0.25);
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
      this.drawMineralPatches(g, sx, sy, left, 1);
    }
  }

  /** 기지 아래쪽에 미네랄 덩이를 늘어놓는다 */
  private drawMineralPatches(g: Graphics, sx: number, sy: number, count: number, alpha: number): void {
    const gap = PX_PER_TILE * 0.55;
    const y = sy + PX_PER_TILE * 1.15;
    const startX = sx - (gap * (MINERAL_PATCHES - 1)) / 2;
    for (let i = 0; i < count && i < MINERAL_PATCHES; i++) {
      g.rect(startX + gap * i - 4, y - 4, 8, 8);
      g.fill({ color: COLORS.mineral, alpha });
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
    g.clear();
    this.resetLabels();

    for (const e of state.entities) {
      const p = prev.get(e.id);
      const ix = p ? p[0] + (e.x - p[0]) * alpha : e.x;
      const iy = p ? p[1] + (e.y - p[1]) * alpha : e.y;
      const [sx, sy] = this.toScreen(ix, iy, myTeam);
      const mine = e.team === myTeam;
      const teamColor = mine ? COLORS.teamMe : COLORS.teamFoe;

      if (e.kind === 'base') {
        this.drawBase(g, e, sx, sy, teamColor, state);
        continue;
      }

      const u = getUnit(e.unit);
      if (e.kind === 'building') {
        const size = PX_PER_TILE * 1.5;
        g.rect(sx - size / 2, sy - size / 2, size, size);
        g.fill(u.color);
        g.rect(sx - size / 2, sy - size / 2, size, size);
        g.stroke({ width: 3.5, color: teamColor });
        this.hpBar(g, sx, sy - size / 2 - 6, size, e);
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

      g.circle(sx, by, r);
      g.fill(u.color);
      g.circle(sx, by, r);
      g.stroke({ width: 2.5, color: teamColor });

      if (e.flying) {
        g.circle(sx, by, r + 3);
        g.stroke({ width: 1.5, color: 0xffffff, alpha: 0.55 });
      }
      if (e.deploy > 0) {
        g.circle(sx, by, r + 4);
        g.stroke({ width: 2, color: COLORS.deployRing, alpha: 0.9 });
      }
      this.hpBar(g, sx, by - r - 6, PX_PER_TILE * 1.1, e);
    }
  }

  private drawBase(
    g: Graphics,
    e: Entity,
    sx: number,
    sy: number,
    teamColor: number,
    state: GameState,
  ): void {
    const faction = getFaction(state.players[e.team].faction);
    const size = e.isMain ? PX_PER_TILE * 2.4 : PX_PER_TILE * 1.8;
    const building = e.deploy > 0;

    g.rect(sx - size / 2, sy - size / 2, size, size);
    g.fill({ color: faction.color, alpha: building ? 0.4 : 1 });
    g.rect(sx - size / 2, sy - size / 2, size, size);
    g.stroke({ width: 3.5, color: teamColor });

    if (e.isMain) {
      // 본진은 안쪽에 표식을 하나 더 둬서 확장과 즉시 구분되게 한다
      g.rect(sx - size / 6, sy - size / 6, size / 3, size / 3);
      g.fill({ color: 0xffffff, alpha: 0.75 });
    }
    if (building) this.label('건설 중', sx, sy - size / 2 - 12, 10);
    if (e.reserve <= 0) this.label('고갈', sx, sy + size / 2 + 10, 10);

    this.hpBar(g, sx, sy - size / 2 - 7, size, e);
    this.drawWorkers(g, workersAtBase(state, e), sx, sy);
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
      g.circle(wx, wy, 2.6);
      g.fill(COLORS.worker);
    }
  }

  /** 일꾼 애니메이션 위상 (0~1). 렌더 전용 값이라 시뮬과 무관하다 */
  private workerPhase = 0;

  advanceWorkerAnimation(deltaMs: number): void {
    // 1.6초에 한 번 왕복
    this.workerPhase = (this.workerPhase + deltaMs / 1600) % 1;
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
