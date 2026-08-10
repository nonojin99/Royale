/**
 * PixiJS 렌더러.
 *
 * 시뮬레이션은 20Hz지만 화면은 60fps로 그린다. 그래서 엔티티 위치는 직전 틱과
 * 현재 틱 사이를 보간한다 — 이 보간이 없으면 눈에 띄게 끊겨 보인다.
 *
 * 렌더러는 시뮬 상태를 **읽기만** 한다. 여기서 상태를 건드리면 그 즉시
 * 결정론이 깨진다.
 */

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';

import {
  ARENA_H,
  ARENA_W,
  BRIDGE_HALF_W,
  BRIDGE_X,
  Entity,
  GameState,
  RIVER_BOT,
  RIVER_TOP,
  SCALE,
  TEAM_COLOR_FOE,
  TEAM_COLOR_ME,
  Team,
  getCard,
} from '@royale/shared';

/** 1 타일당 픽셀 */
const PX_PER_TILE = 30;
export const VIEW_W = (ARENA_W / SCALE) * PX_PER_TILE;
export const VIEW_H = (ARENA_H / SCALE) * PX_PER_TILE;

const COLORS = {
  bg: 0x14532d,
  ground: 0x1a6b3a,
  groundAlt: 0x176034,
  river: 0x1d4ed8,
  bridge: 0x92602e,
  // 팀 색은 shared에 있다 — 카드 색이 팀 색과 겹치지 않는지 테스트가 검사한다
  teamMe: TEAM_COLOR_ME,
  teamFoe: TEAM_COLOR_FOE,
  hp: 0x22c55e,
  hpBg: 0x0f172a,
  deployRing: 0xfacc15,
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
}

export class Renderer {
  readonly app = new Application();
  private readonly world = new Container();
  private readonly gTerrain = new Graphics();
  private readonly gEntities = new Graphics();
  private readonly gOverlay = new Graphics();
  private readonly labels = new Container();
  private readonly labelPool: Text[] = [];
  private terrainDrawn = false;

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
    this.world.addChild(this.gTerrain, this.gEntities, this.gOverlay, this.labels);
    this.app.stage.addChild(this.world);
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /* ── 좌표 변환 ───────────────────────────────────────────────────────── */

  /**
   * 아레나 좌표(밀리타일) → 화면 픽셀.
   * 내 팀이 1이면 화면을 180° 뒤집어 항상 "내 진영이 아래"가 되게 한다.
   */
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

  /* ── 그리기 ──────────────────────────────────────────────────────────── */

  draw(input: RenderInput): void {
    if (!this.terrainDrawn) {
      this.drawTerrain(input.myTeam);
      this.terrainDrawn = true;
    }
    this.drawEntities(input);
    this.drawOverlay(input);
  }

  /** 지형은 매 프레임 다시 그릴 이유가 없다 */
  private drawTerrain(myTeam: Team): void {
    const g = this.gTerrain;
    g.clear();

    // 체크무늬 잔디
    const tiles = PX_PER_TILE;
    for (let ty = 0; ty < ARENA_H / SCALE; ty++) {
      for (let tx = 0; tx < ARENA_W / SCALE; tx++) {
        g.rect(tx * tiles, ty * tiles, tiles, tiles);
        g.fill((tx + ty) % 2 === 0 ? COLORS.ground : COLORS.groundAlt);
      }
    }

    // 강
    const [, ry0] = this.toScreen(0, RIVER_TOP, myTeam);
    const [, ry1] = this.toScreen(0, RIVER_BOT, myTeam);
    const top = Math.min(ry0, ry1);
    g.rect(0, top, VIEW_W, Math.abs(ry1 - ry0));
    g.fill({ color: COLORS.river, alpha: 0.85 });

    // 다리
    for (const bx of BRIDGE_X) {
      const [sx0] = this.toScreen(bx - BRIDGE_HALF_W, 0, myTeam);
      const [sx1] = this.toScreen(bx + BRIDGE_HALF_W, 0, myTeam);
      g.rect(Math.min(sx0, sx1), top, Math.abs(sx1 - sx0), Math.abs(ry1 - ry0));
      g.fill(COLORS.bridge);
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

      if (e.kind === 'tower') {
        const size = e.tower === 'king' ? PX_PER_TILE * 2.4 : PX_PER_TILE * 1.9;
        g.rect(sx - size / 2, sy - size / 2, size, size);
        g.fill({ color: teamColor, alpha: e.active ? 1 : 0.45 });
        g.rect(sx - size / 2, sy - size / 2, size, size);
        g.stroke({ width: 2, color: 0x0f172a, alpha: 0.8 });
        this.hpBar(g, sx, sy - size / 2 - 7, size, e);
        if (e.tower === 'king' && !e.active) {
          this.label('💤', sx, sy, 14);
        }
        continue;
      }

      const card = getCard(e.card);
      if (e.kind === 'building') {
        const size = PX_PER_TILE * 1.5;
        g.rect(sx - size / 2, sy - size / 2, size, size);
        g.fill(card.color);
        // 소속 판별이 즉시 돼야 하므로 팀 테두리를 두껍게 두른다
        g.rect(sx - size / 2, sy - size / 2, size, size);
        g.stroke({ width: 3.5, color: teamColor });
        this.hpBar(g, sx, sy - size / 2 - 6, size, e);
        continue;
      }

      // 유닛. 공중 유닛은 그림자를 지면에 남기고 본체를 위로 띄워서,
      // 지상 유닛과 한눈에 구분되게 한다 (대공 카드를 낼지 판단해야 하므로 중요).
      const r = PX_PER_TILE * 0.42;
      const lift = e.flying ? PX_PER_TILE * 0.55 : 0;
      const by = sy - lift;

      if (e.flying) {
        g.ellipse(sx, sy, r * 0.85, r * 0.4);
        g.fill({ color: 0x000000, alpha: 0.28 });
      }

      g.circle(sx, by, r);
      g.fill(card.color);
      g.circle(sx, by, r);
      g.stroke({ width: 2.5, color: teamColor });

      if (e.flying) {
        // 공중임을 알리는 링
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
    if (!input.cursor) return;
    const [sx, sy] = this.toScreen(input.cursor[0], input.cursor[1], input.myTeam);
    g.circle(sx, sy, PX_PER_TILE * 0.9);
    g.stroke({
      width: 3,
      color: input.cursorValid ? 0x4ade80 : 0xef4444,
      alpha: 0.95,
    });
  }

  /* ── 텍스트 풀 (매 프레임 Text를 새로 만들면 GC가 폭발한다) ──────────── */

  private labelCount = 0;

  private resetLabels(): void {
    for (const t of this.labelPool) t.visible = false;
    this.labelCount = 0;
  }

  private label(text: string, x: number, y: number, size: number): void {
    let t = this.labelPool[this.labelCount];
    if (!t) {
      t = new Text({
        text,
        style: new TextStyle({ fontSize: size, fill: 0xffffff, fontFamily: 'sans-serif' }),
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
