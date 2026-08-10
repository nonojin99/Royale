/**
 * 결정론적 게임 시뮬레이션.
 *
 * ★ 이 파일은 서버(Node)와 클라이언트(브라우저)에서 **같은 코드**가 돈다.
 *   양쪽이 같은 시드 + 같은 커맨드 열을 먹으면 반드시 같은 상태가 나와야 한다.
 *
 * 결정론 규칙 (하나라도 어기면 데스싱크):
 *   1. 부동소수점 산술 금지 — fixed.ts의 정수 연산만 사용
 *   2. Math.random() 금지 — rng.ts의 시드 PRNG만 사용
 *   3. 순회는 항상 id 오름차순 배열로 (Map/Set 순서 의존 금지)
 *   4. 서로를 참조하는 계산은 "전부 읽고 → 전부 쓰기" 2단계로 분리
 *   5. DOM / Date.now() / performance.now() 참조 금지
 */

import {
  ARENA_H,
  ARENA_W,
  BRIDGE_HALF_W,
  BRIDGE_X,
  Lane,
  RIVER_BOT,
  RIVER_MID,
  RIVER_TOP,
  TOWER_SPOTS,
  Team,
  canDeploy,
  inRiver,
  mustCross,
  nearestLane,
} from './arena.js';
import {
  CardDef,
  KING_STATS,
  PRINCESS_STATS,
  TargetPref,
  getCard,
} from './cards.js';
import { DEFAULT_DECK } from './decks.js';
import {
  BUILDING_RADIUS,
  DEPLOY_TICKS,
  DOUBLE_ELIXIR_TICK,
  ELIXIR_MAX,
  ELIXIR_PER_TICK,
  ELIXIR_SCALE,
  ELIXIR_START,
  HAND_SIZE,
  MATCH_TICKS,
  OVERTIME_TICKS,
  UNIT_RADIUS,
} from './constants.js';
import { Rng, createRng } from './rng.js';
import { clamp, dist2, isqrt, tiles } from './fixed.js';

export type EntityKind = 'unit' | 'building' | 'tower';
export type TowerKind = 'none' | 'princess' | 'king';

export interface Entity {
  id: number;
  team: Team;
  /** 카드 id, 또는 타워면 '__princess' / '__king' */
  card: string;
  kind: EntityKind;
  tower: TowerKind;
  /** 타워일 때 소속 레인 (킹은 -1) */
  lane: Lane | -1;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** 남은 공격 쿨다운 (틱) */
  cd: number;
  /** 남은 배치 경직 (틱) */
  deploy: number;
  /** 남은 수명 (틱). -1이면 무한 */
  life: number;
  /** 현재 타겟 엔티티 id. 없으면 -1 */
  target: number;
  /** 킹타워 활성화 여부 (킹 외에는 항상 true) */
  active: boolean;
  /**
   * 공중 유닛인가.
   * 공중은 강·다리를 무시하고 직선으로 날아가며 지상 엔티티와 충돌하지 않는다.
   * 대신 targets가 'ground'인 공격에는 맞지 않는다.
   */
  flying: boolean;
}

export interface PlayerState {
  /** 1/1000 단위 정수 */
  elixir: number;
  /** 8장 순환 큐. 0~3번이 손패, 4번이 "다음 카드" */
  cycle: string[];
  crowns: number;
  /** 이 팀의 좌/우 공주탑이 파괴되었는가 */
  princessDown: [boolean, boolean];
}

export interface GameState {
  tick: number;
  rng: Rng;
  nextId: number;
  /** 항상 id 오름차순 정렬 유지 */
  entities: Entity[];
  players: [PlayerState, PlayerState];
  overtime: boolean;
  over: boolean;
  /** 승자. -1이면 무승부 또는 미결 */
  winner: Team | -1;
}

export interface Command {
  execTick: number;
  team: Team;
  card: string;
  x: number;
  y: number;
}

/* ── 상태 생성 ─────────────────────────────────────────────────────────── */

function makePlayer(deck: readonly string[]): PlayerState {
  return {
    elixir: ELIXIR_START,
    cycle: deck.slice(),
    crowns: 0,
    princessDown: [false, false],
  };
}

export function createState(
  seed: number,
  decks: readonly [readonly string[], readonly string[]] = [DEFAULT_DECK, DEFAULT_DECK],
): GameState {
  const s: GameState = {
    tick: 0,
    rng: createRng(seed),
    nextId: 1,
    entities: [],
    players: [makePlayer(decks[0]), makePlayer(decks[1])],
    overtime: false,
    over: false,
    winner: -1,
  };

  // 타워는 TOWER_SPOTS 순서대로 생성 → id가 결정론적으로 고정된다
  for (const spot of TOWER_SPOTS) {
    const stats = spot.kind === 'king' ? KING_STATS : PRINCESS_STATS;
    s.entities.push({
      id: s.nextId++,
      team: spot.team,
      card: spot.kind === 'king' ? '__king' : '__princess',
      kind: 'tower',
      tower: spot.kind,
      lane: spot.lane,
      x: spot.x,
      y: spot.y,
      hp: stats.hp,
      maxHp: stats.hp,
      cd: 0,
      deploy: 0,
      life: -1,
      target: -1,
      // 킹타워는 비활성으로 시작한다
      active: spot.kind !== 'king',
      flying: false,
    });
  }
  return s;
}

/* ── 조회 헬퍼 ─────────────────────────────────────────────────────────── */

export function radiusOf(e: Entity): number {
  return e.kind === 'unit' ? UNIT_RADIUS : BUILDING_RADIUS;
}

function statsOf(e: Entity): { damage: number; hitSpeed: number; range: number; splash: number } {
  if (e.tower === 'king') {
    return { ...KING_STATS, splash: 0 };
  }
  if (e.tower === 'princess') {
    return { ...PRINCESS_STATS, splash: 0 };
  }
  const c = getCard(e.card);
  return { damage: c.damage, hitSpeed: c.hitSpeed, range: c.range, splash: c.splash };
}

/** 손패(0~3번)에 해당 카드가 있으면 그 인덱스, 없으면 -1 */
export function handIndexOf(p: PlayerState, card: string): number {
  for (let i = 0; i < HAND_SIZE; i++) {
    if (p.cycle[i] === card) return i;
  }
  return -1;
}

export function hand(p: PlayerState): string[] {
  return p.cycle.slice(0, HAND_SIZE);
}

export function nextCard(p: PlayerState): string {
  return p.cycle[HAND_SIZE];
}

/** 카드를 손패에서 빼고 큐 맨 뒤로 보낸다 (셔플 없는 순환 덱) */
function cycleCard(p: PlayerState, handIdx: number): void {
  const played = p.cycle[handIdx];
  p.cycle[handIdx] = p.cycle[HAND_SIZE];
  p.cycle.splice(HAND_SIZE, 1);
  p.cycle.push(played);
}

/* ── 배치 ──────────────────────────────────────────────────────────────── */

/** count마리를 겹치지 않게 배치하기 위한 고정 오프셋 (RNG를 쓰지 않는다) */
const FORMATION: readonly (readonly [number, number])[] = [
  [0, 0],
  [-500, 0],
  [500, 0],
  [0, -500],
  [0, 500],
  [-500, -500],
  [500, -500],
  [-500, 500],
  [500, 500],
];

function formationOffset(count: number, i: number): readonly [number, number] {
  if (count === 1) return FORMATION[0];
  if (count === 2) return FORMATION[i + 1];
  if (count === 4) return FORMATION[i + 5];
  return FORMATION[i % FORMATION.length];
}

function spawnUnit(s: GameState, team: Team, c: CardDef, x: number, y: number): void {
  s.entities.push({
    id: s.nextId++,
    team,
    card: c.id,
    kind: c.kind === 'building' ? 'building' : 'unit',
    tower: 'none',
    lane: nearestLane(x),
    x: clamp(x, 0, ARENA_W - 1),
    y: clamp(y, 0, ARENA_H - 1),
    hp: c.hp,
    maxHp: c.hp,
    cd: 0,
    deploy: DEPLOY_TICKS,
    life: c.lifetime,
    target: -1,
    active: true,
    flying: c.flying,
  });
}

/**
 * 커맨드를 적용한다. 검증 실패(엘릭서 부족 / 손패에 없음 / 배치구역 위반)는
 * 조용히 무시된다 — 서버와 두 클라 모두 같은 상태로 같은 판정을 내리므로
 * 결정론이 깨지지 않는다.
 *
 * @returns 실제로 적용되었으면 true
 */
export function applyCommand(s: GameState, cmd: Command): boolean {
  if (s.over) return false;
  const p = s.players[cmd.team];

  const hi = handIndexOf(p, cmd.card);
  if (hi < 0) return false;

  const c = getCard(cmd.card);
  const cost = c.cost * ELIXIR_SCALE;
  if (p.elixir < cost) return false;

  const enemy = s.players[cmd.team === 0 ? 1 : 0];
  if (!canDeploy(cmd.team, cmd.x, cmd.y, enemy.princessDown)) return false;

  p.elixir -= cost;
  cycleCard(p, hi);

  if (c.kind === 'spell') {
    applySpell(s, cmd.team, c, cmd.x, cmd.y);
    return true;
  }

  for (let i = 0; i < c.count; i++) {
    const [ox, oy] = formationOffset(c.count, i);
    spawnUnit(s, cmd.team, c, cmd.x + ox, cmd.y + oy);
  }
  return true;
}

/** 주문은 즉발 광역. 타워에는 피해를 주지 않는다 (설계 결정 — GAME_DESIGN.md 참조) */
function applySpell(s: GameState, team: Team, c: CardDef, x: number, y: number): void {
  const r2 = c.splash * c.splash;
  for (const e of s.entities) {
    if (e.team === team) continue;
    if (e.kind === 'tower') continue;
    // 지상 전용 주문은 공중을 때리지 못한다 (현재 주문은 모두 'any')
    if (c.targets === 'ground' && e.flying) continue;
    if (c.targets === 'air' && !e.flying) continue;
    if (dist2(e.x, e.y, x, y) <= r2) {
      e.hp -= c.damage;
    }
  }
  reap(s);
}

/* ── 타겟 선정 ─────────────────────────────────────────────────────────── */

/** 감지 범위: 사거리와 5.5타일 중 큰 값 */
function aggroRange(range: number): number {
  const base = tiles(5.5);
  return range > base ? range : base;
}

/**
 * 이 엔티티가 무엇을 때릴 수 있는가.
 * 타워는 지상·공중을 모두 때린다 — 그러지 않으면 공중 유닛만으로 타워를
 * 무한정 부술 수 있어 게임이 성립하지 않는다.
 */
function targetsOf(e: Entity): TargetPref {
  return e.tower !== 'none' ? 'any' : getCard(e.card).targets;
}

function canAttack(e: Entity, target: Entity): boolean {
  switch (targetsOf(e)) {
    case 'buildings':
      return target.kind !== 'unit';
    case 'ground':
      return !target.flying;
    case 'air':
      return target.flying;
    default:
      return true;
  }
}

/**
 * 타겟을 고른다.
 * 동률일 때는 **엔티티 id가 작은 쪽**을 고른다 — 결정론을 위해 필수.
 */
function pickTarget(s: GameState, e: Entity): number {
  const st = statsOf(e);
  const aggro = aggroRange(st.range);
  const aggro2 = aggro * aggro;

  let bestUnit = -1;
  let bestUnitD2 = Infinity;
  let bestBuilding = -1;
  let bestBuildingD2 = Infinity;

  for (const o of s.entities) {
    if (o.team === e.team || o.hp <= 0) continue;
    if (!canAttack(e, o)) continue;
    // 비활성 킹타워는 공격받기 전까지도 타겟이 될 수 있다 (그래야 게임이 끝난다)
    const d2 = dist2(e.x, e.y, o.x, o.y);

    if (o.kind === 'unit') {
      // 감지 범위 안의 유닛만
      if (d2 > aggro2) continue;
      if (d2 < bestUnitD2) {
        bestUnitD2 = d2;
        bestUnit = o.id;
      }
      // d2 동률이면 먼저 만난 쪽(= id 작은 쪽)을 유지 → 배열이 id순이므로 자동
    } else {
      if (d2 < bestBuildingD2) {
        bestBuildingD2 = d2;
        bestBuilding = o.id;
      }
    }
  }

  // 타워/건물 유닛은 건물만, 그 외에는 유닛 우선
  if (bestUnit >= 0) return bestUnit;
  return bestBuilding;
}

function findById(s: GameState, id: number): Entity | undefined {
  // entities는 id 오름차순이므로 이진탐색 가능
  let lo = 0;
  let hi = s.entities.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = s.entities[mid].id;
    if (v === id) return s.entities[mid];
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/* ── 이동 ──────────────────────────────────────────────────────────────── */

/** 목표까지 가기 위해 지금 향해야 할 지점 (강을 건너야 하면 다리를 경유) */
function moveGoal(e: Entity, tx: number, ty: number): [number, number] {
  // 공중 유닛은 지형을 무시하고 직선으로 난다. 다리를 우회하지 않는 것이
  // 공중의 핵심 이점이자, 대공 수단을 반드시 덱에 넣어야 하는 이유다.
  if (e.flying) return [tx, ty];
  if (!mustCross(e.y, ty)) return [tx, ty];

  const lane = e.lane === -1 ? nearestLane(e.x) : e.lane;
  const bx = BRIDGE_X[lane];
  const onBridgeColumn = Math.abs(e.x - bx) <= BRIDGE_HALF_W;

  if (!onBridgeColumn) {
    // 아직 다리 앞이 아니면 우선 다리 입구로
    return [bx, e.y < RIVER_MID ? RIVER_TOP - 500 : RIVER_BOT + 500];
  }
  // 다리 위 — 반대편으로 건넌다
  return [bx, e.y < RIVER_MID ? RIVER_BOT + 500 : RIVER_TOP - 500];
}

/* ── 틱 진행 ───────────────────────────────────────────────────────────── */

/**
 * 한 틱을 진행한다. `cmds`는 **이 틱에 실행되도록 예약된** 커맨드 목록이며,
 * 호출자가 execTick 오름차순(동률이면 team 오름차순)으로 정렬해서 넘겨야 한다.
 */
export function step(s: GameState, cmds: readonly Command[]): void {
  if (s.over) {
    s.tick++;
    return;
  }

  // 1) 예약된 커맨드 실행
  for (const cmd of cmds) {
    applyCommand(s, cmd);
  }

  // 2) 엘릭서 회복
  const rate = s.tick >= DOUBLE_ELIXIR_TICK || s.overtime ? ELIXIR_PER_TICK * 2 : ELIXIR_PER_TICK;
  for (const p of s.players) {
    p.elixir = p.elixir + rate;
    if (p.elixir > ELIXIR_MAX) p.elixir = ELIXIR_MAX;
  }

  // 3) 수명 감소
  for (const e of s.entities) {
    if (e.life > 0) {
      e.life--;
      if (e.life === 0) e.hp = 0;
    }
    if (e.deploy > 0) e.deploy--;
    if (e.cd > 0) e.cd--;
  }
  reap(s);

  // 4) 타겟 선정 (읽기 전용 패스)
  const n = s.entities.length;
  const targets = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const e = s.entities[i];
    targets[i] = e.deploy > 0 || !e.active ? -1 : pickTarget(s, e);
  }
  for (let i = 0; i < n; i++) s.entities[i].target = targets[i];

  // 5) 공격 판정 — 피해를 누적만 하고 즉시 적용하지 않는다 (순서 독립성)
  const dmg = new Array<number>(n).fill(0);
  const indexById = new Map<number, number>();
  for (let i = 0; i < n; i++) indexById.set(s.entities[i].id, i);

  for (let i = 0; i < n; i++) {
    const e = s.entities[i];
    if (e.deploy > 0 || !e.active || e.target < 0) continue;
    const ti = indexById.get(e.target);
    if (ti === undefined) continue;
    const t = s.entities[ti];
    const st = statsOf(e);
    const reach = st.range + radiusOf(t);
    if (dist2(e.x, e.y, t.x, t.y) > reach * reach) continue;
    if (e.cd > 0) continue;

    e.cd = st.hitSpeed;
    if (st.splash > 0) {
      const sp2 = st.splash * st.splash;
      for (let j = 0; j < n; j++) {
        const o = s.entities[j];
        if (o.team === e.team) continue;
        // 지상 전용 광역은 범위 안이어도 공중을 때리지 못한다
        if (!canAttack(e, o)) continue;
        if (dist2(o.x, o.y, t.x, t.y) <= sp2) dmg[j] += st.damage;
      }
    } else {
      dmg[ti] += st.damage;
    }
  }

  // 6) 이동 — 현재 위치 스냅샷을 읽고 전부 계산한 뒤 한꺼번에 적용
  const nx = new Array<number>(n);
  const ny = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const e = s.entities[i];
    nx[i] = e.x;
    ny[i] = e.y;
    if (e.kind !== 'unit' || e.deploy > 0) continue;

    const c = getCard(e.card);
    if (c.speed <= 0) continue;

    let gx: number;
    let gy: number;
    if (e.target >= 0) {
      const t = findById(s, e.target);
      if (!t) continue;
      const st = statsOf(e);
      if (dist2(e.x, e.y, t.x, t.y) <= (st.range + radiusOf(t)) ** 2) continue; // 사거리 안이면 정지
      [gx, gy] = moveGoal(e, t.x, t.y);
    } else {
      // 타겟이 없으면 적 진영 방향으로 전진
      [gx, gy] = moveGoal(e, e.x, e.team === 0 ? 0 : ARENA_H);
    }

    const dx = gx - e.x;
    const dy = gy - e.y;
    const d = isqrt(dx * dx + dy * dy);
    if (d === 0) continue;
    const stepLen = c.speed < d ? c.speed : d;
    // (dx/d) * stepLen 을 정수로. dx*stepLen 은 최대 ~3.2e4 * 1e2 = 3.2e6 이라 안전.
    nx[i] = e.x + Math.trunc((dx * stepLen) / d);
    ny[i] = e.y + Math.trunc((dy * stepLen) / d);

    // 강 위로는 못 간다 (다리 밖). 축별로 되돌린다. 공중은 해당 없음.
    if (!e.flying && inRiver(nx[i], ny[i])) {
      if (!inRiver(e.x, ny[i])) nx[i] = e.x;
      else if (!inRiver(nx[i], e.y)) ny[i] = e.y;
      else {
        nx[i] = e.x;
        ny[i] = e.y;
      }
    }
    nx[i] = clamp(nx[i], 0, ARENA_W - 1);
    ny[i] = clamp(ny[i], 0, ARENA_H - 1);
  }
  for (let i = 0; i < n; i++) {
    s.entities[i].x = nx[i];
    s.entities[i].y = ny[i];
  }

  // 7) 겹침 해소 — 역시 읽기 패스 후 일괄 적용
  separate(s);

  // 8) 피해 적용 + 사망 처리
  let kingHit0 = false;
  let kingHit1 = false;
  for (let i = 0; i < n; i++) {
    if (dmg[i] <= 0) continue;
    const e = s.entities[i];
    e.hp -= dmg[i];
    if (e.tower === 'king') {
      if (e.team === 0) kingHit0 = true;
      else kingHit1 = true;
    }
  }
  // 킹타워는 피격당하면 활성화된다
  for (const e of s.entities) {
    if (e.tower === 'king' && !e.active) {
      if ((e.team === 0 && kingHit0) || (e.team === 1 && kingHit1)) e.active = true;
    }
  }

  resolveDeaths(s);

  // 9) 종료 조건
  s.tick++;
  checkEnd(s);
}

/**
 * 유닛끼리 겹치면 서로 밀어낸다. 읽기 → 쓰기 2단계라 순회 순서에 의존하지 않는다.
 *
 * 공중과 지상은 서로 다른 층에 있다 — 겹쳐도 밀어내지 않고, 공중 유닛은
 * 건물·타워 위를 그대로 지나간다.
 */
function separate(s: GameState): void {
  const n = s.entities.length;
  const px = new Array<number>(n).fill(0);
  const py = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const a = s.entities[i];
    if (a.kind !== 'unit' || a.deploy > 0) continue;
    for (let j = i + 1; j < n; j++) {
      const b = s.entities[j];
      if (b.deploy > 0) continue;
      if (b.kind !== 'unit' && b.kind !== 'building' && b.kind !== 'tower') continue;
      // 층이 다르면 충돌하지 않는다 (공중 vs 지상, 공중 vs 건물)
      if (a.flying !== b.flying) continue;

      const minD = radiusOf(a) + radiusOf(b);
      const d2 = dist2(a.x, a.y, b.x, b.y);
      if (d2 >= minD * minD) continue;

      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d = isqrt(d2);
      if (d === 0) {
        // 정확히 겹친 경우 id로 방향을 결정한다 (RNG를 쓰면 안 되므로)
        dx = a.id < b.id ? -100 : 100;
        dy = 0;
        d = 100;
      }
      const overlap = minD - d;
      // 유닛-유닛이면 절반씩, 유닛-정적물이면 유닛만 전부 밀린다
      const bMovable = b.kind === 'unit';
      const aShare = bMovable ? Math.trunc(overlap / 2) : overlap;
      px[i] += Math.trunc((dx * aShare) / d);
      py[i] += Math.trunc((dy * aShare) / d);
      if (bMovable) {
        const bShare = overlap - aShare;
        px[j] -= Math.trunc((dx * bShare) / d);
        py[j] -= Math.trunc((dy * bShare) / d);
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (px[i] === 0 && py[i] === 0) continue;
    const e = s.entities[i];
    const cx = clamp(e.x + px[i], 0, ARENA_W - 1);
    const cy = clamp(e.y + py[i], 0, ARENA_H - 1);
    // 밀려나다가 강에 빠지지는 않는다 (공중은 예외)
    if (e.flying || !inRiver(cx, cy)) {
      e.x = cx;
      e.y = cy;
    }
  }
}

/** hp<=0 인 비(非)타워 엔티티만 즉시 제거한다 (주문 등 즉발 피해 처리용) */
function reap(s: GameState): void {
  let hasDead = false;
  for (const e of s.entities) {
    if (e.hp <= 0 && e.kind !== 'tower') {
      hasDead = true;
      break;
    }
  }
  if (!hasDead) return;
  s.entities = s.entities.filter((e) => e.hp > 0 || e.kind === 'tower');
}

/** 사망 처리 + 타워 파괴에 따른 왕관/활성화 갱신 */
function resolveDeaths(s: GameState): void {
  const survivors: Entity[] = [];
  for (const e of s.entities) {
    if (e.hp > 0) {
      survivors.push(e);
      continue;
    }
    if (e.kind === 'tower') {
      const attacker: Team = e.team === 0 ? 1 : 0;
      s.players[attacker].crowns += e.tower === 'king' ? 3 : 1;
      if (e.tower === 'princess' && e.lane !== -1) {
        s.players[e.team].princessDown[e.lane] = true;
      }
      if (e.tower === 'king') {
        s.over = true;
        s.winner = attacker;
      }
    }
    // 타워든 유닛이든 hp<=0이면 사라진다
  }
  if (survivors.length !== s.entities.length) {
    s.entities = survivors;
    // 공주탑이 하나라도 무너진 팀의 킹타워를 활성화한다
    for (const e of s.entities) {
      if (e.tower === 'king' && !e.active) {
        const p = s.players[e.team];
        if (p.princessDown[0] || p.princessDown[1]) e.active = true;
      }
    }
  }
}

function checkEnd(s: GameState): void {
  if (s.over) return;
  const [a, b] = s.players;

  if (!s.overtime) {
    if (s.tick >= MATCH_TICKS) {
      if (a.crowns !== b.crowns) {
        s.over = true;
        s.winner = a.crowns > b.crowns ? 0 : 1;
      } else {
        s.overtime = true;
      }
    }
    return;
  }

  // 연장전: 왕관 차이가 생기는 순간 종료
  if (a.crowns !== b.crowns) {
    s.over = true;
    s.winner = a.crowns > b.crowns ? 0 : 1;
    return;
  }
  if (s.tick >= MATCH_TICKS + OVERTIME_TICKS) {
    s.over = true;
    s.winner = -1; // 무승부
  }
}

/* ── 스냅샷 / 해시 ─────────────────────────────────────────────────────── */

export function snapshot(s: GameState): GameState {
  return JSON.parse(JSON.stringify(s)) as GameState;
}

export function restore(target: GameState, snap: GameState): void {
  const fresh = JSON.parse(JSON.stringify(snap)) as GameState;
  target.tick = fresh.tick;
  target.rng = fresh.rng;
  target.nextId = fresh.nextId;
  target.entities = fresh.entities;
  target.players = fresh.players;
  target.overtime = fresh.overtime;
  target.over = fresh.over;
  target.winner = fresh.winner;
}

/**
 * 상태 해시 (FNV-1a 32bit).
 * 데스싱크 감지용. 렌더링에만 쓰이는 값은 포함하지 않는다.
 */
export function hashState(s: GameState): number {
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };

  mix(s.tick);
  mix(s.rng.s);
  mix(s.nextId);
  mix(s.entities.length);
  for (const e of s.entities) {
    mix(e.id);
    mix(e.team);
    mix(e.x);
    mix(e.y);
    mix(e.hp);
    mix(e.cd);
    mix(e.deploy);
    mix(e.life);
    mix(e.target);
    mix(e.active ? 1 : 0);
  }
  for (const p of s.players) {
    mix(p.elixir);
    mix(p.crowns);
    mix(p.princessDown[0] ? 1 : 0);
    mix(p.princessDown[1] ? 1 : 0);
    for (const c of p.cycle) {
      for (let i = 0; i < c.length; i++) mix(c.charCodeAt(i));
    }
  }
  mix(s.overtime ? 1 : 0);
  mix(s.over ? 1 : 0);
  mix(s.winner);
  return h >>> 0;
}

/** 편의: 커맨드 목록을 execTick 기준으로 안정 정렬한다 (동률이면 team, 그다음 card) */
export function sortCommands(cmds: Command[]): Command[] {
  return cmds.slice().sort((a, b) => {
    if (a.execTick !== b.execTick) return a.execTick - b.execTick;
    if (a.team !== b.team) return a.team - b.team;
    if (a.card !== b.card) return a.card < b.card ? -1 : 1;
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });
}
