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
 *
 * ── 게임 구조 ────────────────────────────────────────────────────────────
 * 자원(미네랄)은 시간이 아니라 **기지 수**에서 나온다. 기지의 매장량은 유한해서
 * 한 기지로 버티면 후반에 말라죽는다. 그래서 매 순간 선택이 생긴다:
 * 병력을 뽑을까, 확장할까, 테크를 올릴까.
 */

import {
  ARENA_H,
  ARENA_W,
  BASE_SITES,
  BRIDGE_HALF_W,
  BRIDGE_X,
  BaseSite,
  Lane,
  RIVER_BOT,
  RIVER_MID,
  RIVER_TOP,
  Team,
  canDeployAt,
  getSite,
  inRiver,
  mustCross,
  nearestFreeSite,
  nearestLane,
} from './arena.js';
import {
  BASE_BUILD_COST,
  BASE_BUILD_TICKS,
  BASE_MINERAL_RESERVE,
  BASE_RADIUS,
  BUILDING_RADIUS,
  DEPLOY_TICKS,
  MATCH_TICKS,
  MINERAL_MAX,
  MINERAL_SCALE,
  MINERAL_START,
  OVERTIME_TICKS,
  START_WORKERS,
  UNIT_RADIUS,
  WORKER_CAP_PER_BASE,
  WORKER_COST,
  WORKER_MINE_PER_TICK,
} from './constants.js';
import {
  DEFAULT_FACTION_ID,
  FactionDef,
  findTech,
  getFaction,
  startingUnlocks,
} from './factions.js';
import {
  EXPANSION_BASE_STATS,
  MAIN_BASE_STATS,
  TargetPref,
  UnitDef,
  getUnit,
} from './units.js';
import { Rng, createRng } from './rng.js';
import { clamp, dist2, isqrt, tiles } from './fixed.js';

export type EntityKind = 'unit' | 'building' | 'base';

export interface Entity {
  id: number;
  team: Team;
  /** 유닛 id, 또는 기지면 '__base' */
  unit: string;
  kind: EntityKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** 남은 공격 쿨다운 (틱) */
  cd: number;
  /** 남은 배치/건설 경직 (틱) — 0이 되어야 행동하고 채굴한다 */
  deploy: number;
  /** 남은 수명 (틱). -1이면 무한 */
  life: number;
  /** 현재 타겟 엔티티 id. 없으면 -1 */
  target: number;
  /** 공중 유닛인가 */
  flying: boolean;
  /** 지상 유닛이 강을 건널 때 쓰는 레인 */
  lane: Lane;

  /* ── 기지 전용 ── */
  /** 기지가 선 지점 id. 기지가 아니면 -1 */
  siteId: number;
  /** 본진인가 (파괴되면 패배) */
  isMain: boolean;
  /** 남은 매장량 (미네랄 정수 단위). 기지가 아니면 0 */
  reserve: number;
}

export interface PlayerState {
  /** 보유 미네랄 (1/1000 단위 정수) */
  minerals: number;
  /** 누적 채굴량 — 동점 판정과 분석에 쓴다 */
  mined: number;
  /**
   * 보유 일꾼 수.
   *
   * 일꾼은 시뮬 엔티티가 아니라 **플레이어 단위 숫자 하나**다. 매 틱 기지들에
   * id 오름차순으로 정원까지 배분되고, 배분된 만큼만 채굴한다. 정원을 넘는
   * 일꾼은 그냥 논다 — 그게 "확장해야 한다"는 신호가 된다.
   */
  workers: number;
  /** 종족 id */
  faction: string;
  /** 해금된 유닛 id. **항상 오름차순 정렬** (해시 결정론) */
  unlocked: string[];
  /** 연구 중인 유닛과 남은 틱. 동시에 하나만 */
  research: { unit: string; ticks: number } | null;
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

/** 커맨드 종류 */
export type CommandKind = 'unit' | 'base' | 'tech' | 'worker';

/**
 * 플레이어 입력. 세 종류를 한 모양에 담는다 —
 * 평평한 구조라야 정렬·직렬화·해시가 단순해진다.
 */
export interface Command {
  execTick: number;
  team: Team;
  kind: CommandKind;
  /** kind가 'unit'이면 생산할 유닛, 'tech'면 해금할 유닛, 'base'/'worker'면 '' */
  id: string;
  x: number;
  y: number;
}

/* ── 상태 생성 ─────────────────────────────────────────────────────────── */

function makePlayer(factionId: string): PlayerState {
  const f = getFaction(factionId);
  return {
    minerals: MINERAL_START,
    mined: 0,
    workers: START_WORKERS,
    faction: f.id,
    unlocked: startingUnlocks(f),
    research: null,
  };
}

function makeBase(s: GameState, team: Team, site: BaseSite, ready: boolean): Entity {
  const isMain = site.startFor === team;
  const stats = isMain ? MAIN_BASE_STATS : EXPANSION_BASE_STATS;
  return {
    id: s.nextId++,
    team,
    unit: '__base',
    kind: 'base',
    x: site.x,
    y: site.y,
    hp: stats.hp,
    maxHp: stats.hp,
    cd: 0,
    deploy: ready ? 0 : BASE_BUILD_TICKS,
    life: -1,
    target: -1,
    flying: false,
    lane: nearestLane(site.x),
    siteId: site.id,
    isMain,
    reserve: BASE_MINERAL_RESERVE,
  };
}

export function createState(
  seed: number,
  factions: readonly [string, string] = [DEFAULT_FACTION_ID, DEFAULT_FACTION_ID],
): GameState {
  const s: GameState = {
    tick: 0,
    rng: createRng(seed),
    nextId: 1,
    entities: [],
    players: [makePlayer(factions[0]), makePlayer(factions[1])],
    overtime: false,
    over: false,
    winner: -1,
  };

  // 본진은 BASE_SITES 순서대로 생성 → id가 결정론적으로 고정된다
  for (const site of BASE_SITES) {
    if (site.startFor === -1) continue;
    s.entities.push(makeBase(s, site.startFor, site, true));
  }
  return s;
}

/* ── 조회 헬퍼 ─────────────────────────────────────────────────────────── */

export function radiusOf(e: Entity): number {
  if (e.kind === 'base') return BASE_RADIUS;
  return e.kind === 'unit' ? UNIT_RADIUS : BUILDING_RADIUS;
}

function statsOf(e: Entity): { damage: number; hitSpeed: number; range: number; splash: number } {
  if (e.kind === 'base') {
    const b = e.isMain ? MAIN_BASE_STATS : EXPANSION_BASE_STATS;
    return { ...b, splash: 0 };
  }
  const u = getUnit(e.unit);
  return { damage: u.damage, hitSpeed: u.hitSpeed, range: u.range, splash: u.splash };
}

/**
 * 팀의 일꾼 정원 — 가동 중이고 매장량이 남은 기지 수 × 기지당 정원.
 *
 * 기지가 고갈되거나 파괴되면 정원이 줄고, 초과분 일꾼은 논다.
 */
export function workerCapacity(s: GameState, team: Team): number {
  let cap = 0;
  for (const e of s.entities) {
    if (e.kind === 'base' && e.team === team && e.deploy === 0 && e.reserve > 0) {
      cap += WORKER_CAP_PER_BASE;
    }
  }
  return cap;
}

/** 실제로 일하고 있는 일꾼 수 (정원을 넘는 분은 놀고 있다) */
export function activeWorkers(s: GameState, team: Team): number {
  const cap = workerCapacity(s, team);
  const have = s.players[team].workers;
  return have < cap ? have : cap;
}

/**
 * 채굴 — 일꾼을 기지에 id 오름차순으로 정원까지 배분하고, 배분된 만큼 캔다.
 *
 * 배분 순서가 고정이라 결정론이 유지되고, 각 기지가 자기 몫만큼만 매장량을
 * 소진하므로 "먼저 세운 기지부터 마른다"는 자연스러운 흐름이 나온다.
 */
function mine(s: GameState): void {
  for (const team of [0, 1] as const) {
    const p = s.players[team];
    let left = p.workers;
    if (left <= 0) continue;

    for (const e of s.entities) {
      if (left <= 0) break;
      if (e.kind !== 'base' || e.team !== team) continue;
      if (e.deploy > 0 || e.reserve <= 0) continue;

      const assigned = left < WORKER_CAP_PER_BASE ? left : WORKER_CAP_PER_BASE;
      left -= assigned;

      const want = assigned * WORKER_MINE_PER_TICK;
      const take = e.reserve < want ? e.reserve : want;
      e.reserve -= take;
      p.mined += take;
      p.minerals += take;
      if (p.minerals > MINERAL_MAX) p.minerals = MINERAL_MAX;
    }
  }
}

/** 살아 있고 가동 중인 팀 기지들의 좌표 */
export function ownBasePositions(s: GameState, team: Team): [number, number][] {
  const out: [number, number][] = [];
  for (const e of s.entities) {
    if (e.kind === 'base' && e.team === team && e.deploy === 0) out.push([e.x, e.y]);
  }
  return out;
}

/** 이미 누군가 차지한 기지 지점 id 집합 */
export function occupiedSites(s: GameState): Set<number> {
  const out = new Set<number>();
  for (const e of s.entities) {
    if (e.kind === 'base') out.add(e.siteId);
  }
  return out;
}

export function baseCount(s: GameState, team: Team): number {
  let n = 0;
  for (const e of s.entities) if (e.kind === 'base' && e.team === team) n++;
  return n;
}

export function isUnlocked(p: PlayerState, unit: string): boolean {
  return p.unlocked.includes(unit);
}

/** 지금 해금을 시작할 수 있는가 (비용은 별도로 확인) */
export function canResearch(p: PlayerState, unit: string): boolean {
  if (p.research !== null) return false;
  if (isUnlocked(p, unit)) return false;
  const node = findTech(getFaction(p.faction), unit);
  if (!node || node.cost <= 0) return false;
  if (node.requires && !isUnlocked(p, node.requires)) return false;
  return true;
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

function spawnUnit(s: GameState, team: Team, u: UnitDef, x: number, y: number): void {
  s.entities.push({
    id: s.nextId++,
    team,
    unit: u.id,
    kind: u.kind === 'building' ? 'building' : 'unit',
    x: clamp(x, 0, ARENA_W - 1),
    y: clamp(y, 0, ARENA_H - 1),
    hp: u.hp,
    maxHp: u.hp,
    cd: 0,
    deploy: DEPLOY_TICKS,
    life: u.lifetime,
    target: -1,
    flying: u.flying,
    lane: nearestLane(x),
    siteId: -1,
    isMain: false,
    reserve: 0,
  });
}

/**
 * 커맨드를 적용한다. 검증 실패(자원 부족 / 미해금 / 배치구역 위반)는 조용히
 * 무시된다 — 서버와 두 클라 모두 같은 상태로 같은 판정을 내리므로 결정론이
 * 깨지지 않는다. 즉 결정론이 곧 치팅 방지 장치다.
 *
 * @returns 실제로 적용되었으면 true
 */
export function applyCommand(s: GameState, cmd: Command): boolean {
  if (s.over) return false;
  switch (cmd.kind) {
    case 'unit':
      return produceUnit(s, cmd);
    case 'base':
      return buildBase(s, cmd);
    case 'tech':
      return startResearch(s, cmd);
    case 'worker':
      return trainWorker(s, cmd);
    default:
      return false;
  }
}

function produceUnit(s: GameState, cmd: Command): boolean {
  const p = s.players[cmd.team];
  if (!isUnlocked(p, cmd.id)) return false;

  let u: UnitDef;
  try {
    u = getUnit(cmd.id);
  } catch {
    return false;
  }

  const cost = u.cost * MINERAL_SCALE;
  if (p.minerals < cost) return false;
  if (!canDeployAt(cmd.x, cmd.y, ownBasePositions(s, cmd.team))) return false;

  p.minerals -= cost;

  if (u.kind === 'spell') {
    applySpell(s, cmd.team, u, cmd.x, cmd.y);
    return true;
  }
  for (let i = 0; i < u.count; i++) {
    const [ox, oy] = formationOffset(u.count, i);
    spawnUnit(s, cmd.team, u, cmd.x + ox, cmd.y + oy);
  }
  return true;
}

function buildBase(s: GameState, cmd: Command): boolean {
  const p = s.players[cmd.team];
  if (p.minerals < BASE_BUILD_COST) return false;

  const site = nearestFreeSite(cmd.x, cmd.y, occupiedSites(s));
  if (!site) return false;

  p.minerals -= BASE_BUILD_COST;
  s.entities.push(makeBase(s, cmd.team, site, false));
  return true;
}

/**
 * 일꾼 생산.
 *
 * 정원을 넘겨서는 살 수 없다 — 정원이 찼다는 것 자체가 "확장할 때"라는 신호이고,
 * 쓸모없는 일꾼에 미네랄을 흘리는 것을 막는다.
 */
function trainWorker(s: GameState, cmd: Command): boolean {
  const p = s.players[cmd.team];
  if (p.minerals < WORKER_COST) return false;
  if (p.workers >= workerCapacity(s, cmd.team)) return false;
  p.minerals -= WORKER_COST;
  p.workers++;
  return true;
}

function startResearch(s: GameState, cmd: Command): boolean {
  const p = s.players[cmd.team];
  if (!canResearch(p, cmd.id)) return false;

  const node = findTech(getFaction(p.faction), cmd.id);
  if (!node) return false;

  const cost = node.cost * MINERAL_SCALE;
  if (p.minerals < cost) return false;

  p.minerals -= cost;
  if (node.researchTicks <= 0) {
    unlock(p, cmd.id);
  } else {
    p.research = { unit: cmd.id, ticks: node.researchTicks };
  }
  return true;
}

function unlock(p: PlayerState, unit: string): void {
  if (p.unlocked.includes(unit)) return;
  p.unlocked.push(unit);
  p.unlocked.sort(); // 해시 결정론을 위해 항상 정렬 상태를 유지한다
}

/** 주문은 즉발 광역. 기지에는 피해를 주지 않는다 (설계 결정) */
function applySpell(s: GameState, team: Team, u: UnitDef, x: number, y: number): void {
  const r2 = u.splash * u.splash;
  for (const e of s.entities) {
    if (e.team === team) continue;
    if (e.kind === 'base') continue;
    if (u.targets === 'ground' && e.flying) continue;
    if (u.targets === 'air' && !e.flying) continue;
    if (dist2(e.x, e.y, x, y) <= r2) e.hp -= u.damage;
  }
  reap(s);
}

/* ── 타겟 선정 ─────────────────────────────────────────────────────────── */

/** 감지 범위: 사거리와 5.5타일 중 큰 값 */
function aggroRange(range: number): number {
  const base = tiles(5.5);
  return range > base ? range : base;
}

/** 이 엔티티가 무엇을 때릴 수 있는가. 기지는 지상·공중 모두 때린다. */
function targetsOf(e: Entity): TargetPref {
  return e.kind === 'base' ? 'any' : getUnit(e.unit).targets;
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
  let bestStruct = -1;
  let bestStructD2 = Infinity;

  for (const o of s.entities) {
    if (o.team === e.team || o.hp <= 0) continue;
    if (!canAttack(e, o)) continue;
    const d2 = dist2(e.x, e.y, o.x, o.y);

    if (o.kind === 'unit') {
      if (d2 > aggro2) continue;
      if (d2 < bestUnitD2) {
        bestUnitD2 = d2;
        bestUnit = o.id;
      }
    } else if (d2 < bestStructD2) {
      bestStructD2 = d2;
      bestStruct = o.id;
    }
  }

  if (bestUnit >= 0) return bestUnit;
  return bestStruct;
}

function findById(s: GameState, id: number): Entity | undefined {
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
  // 공중 유닛은 지형을 무시하고 직선으로 난다.
  if (e.flying) return [tx, ty];
  if (!mustCross(e.y, ty)) return [tx, ty];

  const bx = BRIDGE_X[e.lane];
  const onBridgeColumn = Math.abs(e.x - bx) <= BRIDGE_HALF_W;
  if (!onBridgeColumn) {
    return [bx, e.y < RIVER_MID ? RIVER_TOP - 500 : RIVER_BOT + 500];
  }
  return [bx, e.y < RIVER_MID ? RIVER_BOT + 500 : RIVER_TOP - 500];
}

/* ── 틱 진행 ───────────────────────────────────────────────────────────── */

/**
 * 한 틱을 진행한다. `cmds`는 **이 틱에 실행되도록 예약된** 커맨드 목록이며,
 * 호출자가 sortCommands로 정규화해서 넘겨야 한다.
 */
export function step(s: GameState, cmds: readonly Command[]): void {
  if (s.over) {
    s.tick++;
    return;
  }

  // 1) 예약된 커맨드 실행
  for (const cmd of cmds) applyCommand(s, cmd);

  // 2) 채굴
  mine(s);

  // 3) 연구 진행
  for (const p of s.players) {
    if (!p.research) continue;
    p.research.ticks--;
    if (p.research.ticks <= 0) {
      unlock(p, p.research.unit);
      p.research = null;
    }
  }

  // 4) 수명·쿨다운·경직
  for (const e of s.entities) {
    if (e.life > 0) {
      e.life--;
      if (e.life === 0) e.hp = 0;
    }
    if (e.deploy > 0) e.deploy--;
    if (e.cd > 0) e.cd--;
  }
  reap(s);

  // 5) 타겟 선정 (읽기 전용 패스)
  const n = s.entities.length;
  const targets = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const e = s.entities[i];
    targets[i] = e.deploy > 0 ? -1 : pickTarget(s, e);
  }
  for (let i = 0; i < n; i++) s.entities[i].target = targets[i];

  // 6) 공격 — 피해를 누적만 하고 즉시 적용하지 않는다 (순서 독립성)
  const dmg = new Array<number>(n).fill(0);
  const indexById = new Map<number, number>();
  for (let i = 0; i < n; i++) indexById.set(s.entities[i].id, i);

  for (let i = 0; i < n; i++) {
    const e = s.entities[i];
    if (e.deploy > 0 || e.target < 0) continue;
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
        if (!canAttack(e, o)) continue;
        if (dist2(o.x, o.y, t.x, t.y) <= sp2) dmg[j] += st.damage;
      }
    } else {
      dmg[ti] += st.damage;
    }
  }

  // 7) 이동 — 현재 위치 스냅샷을 읽고 전부 계산한 뒤 한꺼번에 적용
  const nx = new Array<number>(n);
  const ny = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const e = s.entities[i];
    nx[i] = e.x;
    ny[i] = e.y;
    if (e.kind !== 'unit' || e.deploy > 0) continue;

    const u = getUnit(e.unit);
    if (u.speed <= 0) continue;

    let gx: number;
    let gy: number;
    if (e.target >= 0) {
      const t = findById(s, e.target);
      if (!t) continue;
      const st = statsOf(e);
      if (dist2(e.x, e.y, t.x, t.y) <= (st.range + radiusOf(t)) ** 2) continue;
      [gx, gy] = moveGoal(e, t.x, t.y);
    } else {
      // 타겟이 없으면 적 진영 방향으로 전진
      [gx, gy] = moveGoal(e, e.x, e.team === 0 ? 0 : ARENA_H);
    }

    const dx = gx - e.x;
    const dy = gy - e.y;
    const d = isqrt(dx * dx + dy * dy);
    if (d === 0) continue;
    const stepLen = u.speed < d ? u.speed : d;
    nx[i] = e.x + Math.trunc((dx * stepLen) / d);
    ny[i] = e.y + Math.trunc((dy * stepLen) / d);

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

  // 8) 겹침 해소
  separate(s);

  // 9) 피해 적용 + 사망 처리
  for (let i = 0; i < n; i++) {
    if (dmg[i] > 0) s.entities[i].hp -= dmg[i];
  }
  resolveDeaths(s);

  // 10) 종료 조건
  s.tick++;
  checkEnd(s);
}

/**
 * 유닛끼리 겹치면 서로 밀어낸다. 읽기 → 쓰기 2단계라 순회 순서에 의존하지 않는다.
 * 공중과 지상은 서로 다른 층이라 밀어내지 않는다.
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
    if (e.flying || !inRiver(cx, cy)) {
      e.x = cx;
      e.y = cy;
    }
  }
}

/** hp<=0 인 비(非)기지 엔티티만 즉시 제거한다 (주문 등 즉발 피해 처리용) */
function reap(s: GameState): void {
  let hasDead = false;
  for (const e of s.entities) {
    if (e.hp <= 0 && e.kind !== 'base') {
      hasDead = true;
      break;
    }
  }
  if (!hasDead) return;
  s.entities = s.entities.filter((e) => e.hp > 0 || e.kind === 'base');
}

/** 사망 처리 + 본진 파괴 판정 */
function resolveDeaths(s: GameState): void {
  const survivors: Entity[] = [];
  let changed = false;
  for (const e of s.entities) {
    if (e.hp > 0) {
      survivors.push(e);
      continue;
    }
    changed = true;
    if (e.kind === 'base' && e.isMain) {
      s.over = true;
      s.winner = e.team === 0 ? 1 : 0;
    }
  }
  if (changed) s.entities = survivors;
}

function checkEnd(s: GameState): void {
  if (s.over) return;

  const limit = s.overtime ? MATCH_TICKS + OVERTIME_TICKS : MATCH_TICKS;
  if (s.tick < limit) return;

  // 시간 초과 — 기지 수로 가리고, 같으면 누적 채굴량으로 가린다
  const b0 = baseCount(s, 0);
  const b1 = baseCount(s, 1);
  if (b0 !== b1) {
    s.over = true;
    s.winner = b0 > b1 ? 0 : 1;
    return;
  }
  const m0 = s.players[0].mined;
  const m1 = s.players[1].mined;
  if (m0 !== m1) {
    s.over = true;
    s.winner = m0 > m1 ? 0 : 1;
    return;
  }
  if (!s.overtime) {
    s.overtime = true;
    return;
  }
  s.over = true;
  s.winner = -1;
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
  const mixStr = (str: string): void => {
    for (let i = 0; i < str.length; i++) mix(str.charCodeAt(i));
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
    mix(e.reserve);
    mix(e.siteId);
  }
  for (const p of s.players) {
    mix(p.minerals);
    mix(p.mined);
    mix(p.workers);
    mixStr(p.faction);
    mix(p.unlocked.length);
    for (const u of p.unlocked) mixStr(u);
    if (p.research) {
      mixStr(p.research.unit);
      mix(p.research.ticks);
    } else {
      mix(-1);
    }
  }
  mix(s.overtime ? 1 : 0);
  mix(s.over ? 1 : 0);
  mix(s.winner);
  return h >>> 0;
}

/** 커맨드 목록을 안정 정렬한다 — 같은 틱 안의 순서까지 완전히 결정한다 */
export function sortCommands(cmds: Command[]): Command[] {
  return cmds.slice().sort((a, b) => {
    if (a.execTick !== b.execTick) return a.execTick - b.execTick;
    if (a.team !== b.team) return a.team - b.team;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });
}

/* ── 편의 ──────────────────────────────────────────────────────────────── */

export { canDeployAt, getSite, nearestFreeSite };
export type { BaseSite, FactionDef };
