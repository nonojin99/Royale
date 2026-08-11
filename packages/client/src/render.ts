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
  BASE_MINERAL_RESERVE,
  BASE_SITES,
  DEPLOY_RADIUS,
  Entity,
  GameState,
  MINERAL_PATCHES,
  SCALE,
  WALLS,
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

/**
 * 유닛 스프라이트가 차지하는 상자 높이.
 *
 * 이미지 안에서 소형은 캔버스의 55%, 대형은 90%를 채우기로 했으므로(ART_PIPELINE
 * §3.3) 이 값 하나로 소형 ~26px, 대형 ~42px가 나온다. 도형일 때의 지름 25px과
 * 소형이 맞아떨어지도록 잡은 값이다.
 */
const UNIT_SPRITE_H = PX_PER_TILE * 2.0;
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

    // 벽 — 지상 유닛이 못 지나가는 지형. 아래쪽에 그림자를 깔아 높이를 준다
    for (const [x0, y0, x1, y1] of WALLS) {
      const [ax, ay] = this.toScreen(x0 * SCALE, y0 * SCALE, myTeam);
      const [bx, by] = this.toScreen((x1 + 1) * SCALE, (y1 + 1) * SCALE, myTeam);
      const rx = Math.min(ax, bx);
      const ry = Math.min(ay, by);
      const rw = Math.abs(bx - ax);
      const rh = Math.abs(by - ay);

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
    const d = this.gDecor;
    g.clear();
    d.clear();
    this.resetLabels();
    this.resetSprites();
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
          this.groundRing(g, sx, sy, size * 0.5, teamColor);
          this.place(tex, sx, sy, PX_PER_TILE * 2.0, 0.85);
        } else {
          g.rect(sx - size / 2, sy - size / 2, size, size);
          g.fill(u.color);
          g.rect(sx - size / 2, sy - size / 2, size, size);
          g.stroke({ width: 3.5, color: teamColor });
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
        // 팀 구분은 발밑 링으로 한다 — 이미지 위에 외곽선을 두르면 그림을 가린다
        if (!e.flying) this.groundRing(g, sx, sy, r, teamColor);
        this.place(tex, sx, by, UNIT_SPRITE_H, 0.88);
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
      }
      this.hpBar(d, sx, by - r - 6, PX_PER_TILE * 1.1, e);
    }
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
  private place(tex: Texture, x: number, y: number, height: number, anchorY: number): Sprite {
    let sp = this.spritePool[this.spriteCount];
    if (!sp) {
      sp = new Sprite();
      this.spritePool.push(sp);
      this.sprites.addChild(sp);
    }
    this.spriteCount++;
    sp.texture = tex;
    sp.anchor.set(0.5, anchorY);
    sp.scale.set(height / tex.height);
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
      g.circle(wx, wy, 2.6);
      g.fill(COLORS.worker);
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

  /** 죽은 엔티티가 남긴 항목을 걷어낸다 — 경기가 길어지면 계속 쌓인다 */
  private pruneAnimState(state: GameState): void {
    if (this.animState.size < state.entities.length * 2 + 32) return;
    const live = new Set(state.entities.map((e) => e.id));
    for (const id of this.animState.keys()) if (!live.has(id)) this.animState.delete(id);
    for (const id of this.prevCd.keys()) if (!live.has(id)) this.prevCd.delete(id);
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
