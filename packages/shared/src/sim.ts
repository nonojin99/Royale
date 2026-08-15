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
  ARENA_W_TILES,
  ARENA_H_TILES,
  BASE_SITES,
  BaseSite,
  DEFAULT_MAP_ID,
  Team,
  blockedAt,
  canDeployAt,
  elevAt,
  getMap,
  getSite,
  nearestFreeSite,
  setActiveMap,
} from './arena.js';
import { navStep, pathExists, setBlockers, tileIndex, tileX, tileY } from './nav.js';
import {
  BASE_BUILD_COST,
  BASE_BUILD_TICKS,
  BASE_MINERAL_RESERVE,
  BASE_RADIUS,
  BUILDING_RADIUS,
  DEPLOY_TICKS,
  HIGH_GROUND_DAMAGE_PCT,
  MATCH_TICKS,
  MINERAL_MAX,
  MINERAL_SCALE,
  MINERAL_START,
  OVERTIME_TICKS,
  START_WORKERS,
  UNIT_RADIUS,
  UPGRADE_COSTS,
  UPGRADE_DAMAGE_PCT,
  UPGRADE_MAX,
  UPGRADE_TICKS,
  WORKER_CAP_PER_BASE,
  WORKER_COST,
  WORKER_MINE_PER_TICK,
  WORKER_LOSS_DAMAGE,
  EXPAND_RANGE,
  HASTE_SPEED_PCT,
  HERO_DAMAGE_PER_LEVEL,
  HERO_HP_PER_LEVEL,
  HERO_LEVEL_MAX,
  HERO_RESPAWN_TICKS,
  RUN_STAGES,
  STAGE_WALL_GRANT,
  StageDef,
  SKILL_CHARGE_TICKS,
  SKILL_CAST_RANGE,
  INVASION_FIRST_WAVE_TICKS,
  INVASION_WAVE_TICKS,
  INVASION_WAVE_ACCEL,
  INVASION_WAVE_MIN_TICKS,
  INVASION_BUDGET_START,
  INVASION_BUDGET_GROWTH,
  INVASION_MINE_PCT,
  INVASION_RICH_MINE_PCT,
  INVASION_BOUNTY_PCT,
  TICK_RATE,
  RALLY_ARRIVE,
  INVASION_WALL_START,
  INVASION_WALL_PER_WAVE,
  INVASION_WALL_CAP,
  ORDER_ARRIVE,
  ORDER_MAX_UNITS,
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
  UNIT_IDS,
  INVASION_BUILDINGS,
  HERO_IDS,
  SPAWNED_ONLY,
  UnitDef,
  getUnit,
} from './units.js';
import { Rng, createRng, nextInt } from './rng.js';
import { RELICS, RELIC_BY_ID } from './relics.js';
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
  /** 충전 스킬 게이지 (틱). 스킬 없는 엔티티는 0에 머문다 */
  charge: number;
  /**
   * 능동 특성 상태 (4축, 라운드 35). 뜻은 유닛의 ability.kind가 정한다:
   *   siegemode  제자리에 머문 틱 수 — charge 틱을 넘기면 고정 포대가 된다
   *   그 밖      쓰지 않는다 (게이지는 charge가 센다)
   */
  mode: number;
  /** 남은 가속 틱 (굴착충의 굴착 진동). 0이면 평속 */
  haste: number;
  /**
   * 이동 명령 목적지 (밀리타일). -1이면 명령 없음.
   *
   * 명령 이동 중에도 사거리 안의 적은 쏘지만 **쫓아가지 않는다** — 목적지에
   * 닿으면 스스로 해제되고 기본 행동(대전=전진 / 침공=집결·대기)으로 돌아간다.
   */
  orderX: number;
  orderY: number;

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
  /** 침공 드래프트에서 얻은 유물 id — 효과는 sim 곳곳의 훅에 산다 */
  relics: string[];
  /** 남은 방벽 설치권 (침공 전용) — 파도를 넘길 때마다 조금씩 채워진다 */
  wallCharges: number;
  /**
   * 고른 영웅 id (5축, 침공 전용). 빈 문자열이면 아직 안 골랐다.
   *
   * 영웅은 **런의 서명**이다 — 시작에 셋 중 하나를 고르고, 파도를 넘길
   * 때마다 자라며, 죽어도 런이 끝나지 않고 본진에서 다시 일어선다.
   */
  hero: string;
  /** 영웅 레벨 (0부터). 파도를 넘길 때마다 +1, 상한 HERO_LEVEL_MAX */
  heroLevel: number;
  /** 재소환까지 남은 틱. 0이면 살아 있거나 아직 안 골랐다 */
  heroRespawn: number;
  /**
   * 집결 지점 (침공 전용). 표적 없는 유닛이 여기로 모여 주둔한다.
   * null이면 제자리 대기. 우클릭으로 옮긴다 — 수비 모드의 유일한 컨트롤.
   */
  rally: { x: number; y: number } | null;
  /** 해금된 유닛 id. **항상 오름차순 정렬** (해시 결정론) */
  unlocked: string[];
  /** 연구 중인 유닛과 남은 틱. 동시에 하나만 */
  research: { unit: string; ticks: number } | null;
  /** 완료한 공격 강화 단계 (0~UPGRADE_MAX) */
  upgrade: number;
  /** 진행 중인 강화의 남은 틱. 연구와 별개 채널 — 동시에 하나만 */
  upgrading: { ticks: number } | null;
}

export interface GameState {
  /** 이 경기의 맵 id — step()이 매 틱 활성 맵을 이걸로 맞춘다 */
  mapId: string;
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
  /**
   * 실험장 모드 — 미네랄 무한, 전 유닛 해금, 배치 반경 해제, 승패·시간
   * 제한 없음. 유닛 상성(사거리·속도·데미지)을 부딪혀 보는 관찰실이다.
   * 시뮬 규칙을 바꾸는 플래그이므로 해시에 들어간다.
   */
  sandbox: boolean;
  /**
   * 침공 모드 (로그라이트 1단계) — 팀 1은 사람이 아니라 **파도**다.
   * 예산이 자라는 유닛 무리가 주기적으로 침공자 본진에서 쏟아진다.
   * 점수는 버틴 파도 수. 시간 종료가 없고, 내 본진 함락으로만 끝난다.
   */
  invasion: boolean;
  /** 지금까지 쏟아진 파도 수 */
  wave: number;
  /** 다음 파도 틱 */
  nextWaveTick: number;
  /** 다음 파도 예산 (밀리미네랄) */
  waveBudget: number;
  /** 현재 파도가 아직 살아 있는가 (소탕 보상 판정) */
  waveAlive: boolean;
  /** 이번 파도 소탕 보상 (밀리미네랄) */
  waveReward: number;
  /** 드래프트 제안 (유물 id 또는 'unlock:<unit>'). 비어 있으면 없음 */
  draft: string[];
  /**
   * 영웅 3택1 제안 ('hero:<id>'). 런 시작에 한 번만 찬다 (5축).
   *
   * 파도 보상 드래프트와 **채널을 나눈다** — 한 통에 담았더니 영웅을 안 고른
   * 동안 파도 보상 드래프트가 오지 않았다(테스트가 잡았다). 성격이 다른
   * 선택은 줄도 따로 서야 한다.
   */
  heroDraft: string[];
  /**
   * 런 체인의 현재 무대 (0~2, 로그라이트 3단계 — 라운드 38).
   *
   * 침공이 아니면 늘 0이고 아무 뜻이 없다. 무대가 바뀌면 전장만 갈아엎고
   * 성장(유물·해금·영웅·미네랄)은 그대로 따라간다.
   */
  stage: number;
  /** 3무대의 둥지가 살아 있는가 — 부서지는 순간이 런의 끝(승리)이다 */
  nestAlive: boolean;
}

/** 커맨드 종류 */
export type CommandKind = 'unit' | 'base' | 'tech' | 'worker' | 'upgrade' | 'relic' | 'rally' | 'move';

/**
 * 플레이어 입력. 세 종류를 한 모양에 담는다 —
 * 평평한 구조라야 정렬·직렬화·해시가 단순해진다.
 */
export interface Command {
  execTick: number;
  team: Team;
  kind: CommandKind;
  /** kind가 'unit'이면 생산할 유닛, 'tech'면 해금할 유닛, 그 외('base'/'worker'/'upgrade')는 '' */
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
    relics: [],
    wallCharges: INVASION_WALL_START,
    hero: '',
    heroLevel: 0,
    heroRespawn: 0,
    rally: null,
    unlocked: startingUnlocks(f),
    research: null,
    upgrade: 0,
    upgrading: null,
  };
}

function makeBase(s: GameState, team: Team, site: BaseSite, ready: boolean): Entity {
  const isMain = site.startFor === team;
  const stats0 = isMain ? MAIN_BASE_STATS : EXPANSION_BASE_STATS;
  const hpMul = hasRelic(s.players[team], 'iron_heart') ? 130 : 100;
  const stats = { ...stats0, hp: Math.trunc((stats0.hp * hpMul) / 100) };
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
    charge: 0,
    mode: 0,
    haste: 0,
    orderX: -1,
    orderY: -1,
    siteId: site.id,
    isMain,
    reserve: BASE_MINERAL_RESERVE,
  };
}

export function createState(
  seed: number,
  factions: readonly [string, string] = [DEFAULT_FACTION_ID, DEFAULT_FACTION_ID],
  mapId: string = DEFAULT_MAP_ID,
  sandbox = false,
  invasion = false,
): GameState {
  setActiveMap(mapId);
  const s: GameState = {
    mapId: getMap(mapId).id,
    tick: 0,
    rng: createRng(seed),
    nextId: 1,
    entities: [],
    players: [makePlayer(factions[0]), makePlayer(factions[1])],
    overtime: false,
    over: false,
    winner: -1,
    sandbox,
    invasion,
    wave: 0,
    nextWaveTick: INVASION_FIRST_WAVE_TICKS,
    waveBudget: INVASION_BUDGET_START,
    waveAlive: false,
    waveReward: 0,
    draft: [],
    heroDraft: [],
    stage: 0,
    nestAlive: false,
  };
  if (sandbox) {
    // **전 종족** 전 유닛 해금 + 미네랄 만땅 — 실험장의 존재 이유는 종족을
    // 가로지르는 매치업(소총병 vs 물어뜯는것)이다. 준비 시간도 0으로
    for (const p of s.players) {
      for (const id of UNIT_IDS) {
        if (SPAWNED_ONLY.includes(id)) continue; // 능동기가 낳는 것들은 카드가 없다
        if (!p.unlocked.includes(id)) p.unlocked.push(id);
      }
      p.unlocked.sort();
      p.minerals = MINERAL_MAX;
    }
  }

  // 런 시작 3택1 — 영웅부터 고른다 (5축). 파도 보상 드래프트와 같은 통로를
  // 쓰므로 UI도 커맨드도 새로 만들 것이 없다
  if (invasion) s.heroDraft = HERO_IDS.map((id) => 'hero:' + id);

  // 본진은 BASE_SITES 순서대로 생성 → id가 결정론적으로 고정된다.
  // 침공 모드의 팀 1은 기지가 없다 — 파도는 모서리에서 온다. 기지를 남기면
  // 아군 전체가 그걸 전역 표적으로 삼아 맵 끝까지 행군한다 (라운드 24 실전)
  for (const site of BASE_SITES) {
    if (site.startFor === -1) continue;
    if (invasion && site.startFor === 1) continue;
    s.entities.push(makeBase(s, site.startFor, site, true));
  }
  return s;
}

/* ── 조회 헬퍼 ─────────────────────────────────────────────────────────── */

export function radiusOf(e: Entity): number {
  if (e.kind === 'base') return BASE_RADIUS;
  return e.kind === 'unit' ? UNIT_RADIUS : BUILDING_RADIUS;
}

function statsOf(
  s: GameState,
  e: Entity,
): {
  damage: number;
  hitSpeed: number;
  range: number;
  splash: number;
  siege: number;
} {
  if (e.kind === 'base') {
    const b = e.isMain ? MAIN_BASE_STATS : EXPANSION_BASE_STATS;
    return { ...b, splash: 0, siege: 100 };
  }
  const u = getUnit(e.unit);
  const t = traitMod(s.players[e.team], e.unit);
  // 시즈모드 — 자리를 잡은 대가로 사거리와 화력을 받는다 (4축, 침공 전용)
  const sm = inSiegeMode(s, e) ? u.ability! : null;
  // 영웅 성장 — 레벨당 공격 +8%. 체력은 소환 시점에 한 번 얹는다(summonHero)
  const lv = u.hero ? s.players[e.team].heroLevel * HERO_DAMAGE_PER_LEVEL : 0;
  const pct = t.damagePct + (sm?.power ?? 0) + lv;
  return {
    damage: pct ? Math.trunc((u.damage * (100 + pct)) / 100) : u.damage,
    hitSpeed: u.hitSpeed,
    range: u.range + t.rangeAdd + (sm?.rangeAdd ?? 0),
    splash: u.splash,
    siege: u.siege,
  };
}

/**
 * 실제 피해량 — 세 배율이 곱해진다 (정수 유지):
 *   1. 강화 — 공격자 팀의 강화 단계 ×10% (기지는 제외 — 기지가 강해지면
 *      수비가 공짜가 된다. 주문은 이 경로를 타지 않는다)
 *   2. siege — 피격자가 구조물이면
 *   3. 언덕 — 지상 공격자가 저지에서 고지의 지상 대상을 때리면 70%
 *      (공중은 어느 쪽이든 지형 무관)
 */
function damageTo(
  attacker: Entity,
  st: { damage: number; siege: number },
  victim: Entity,
  upgrade: number,
): number {
  let d = st.damage;
  if (attacker.kind !== 'base' && upgrade > 0) {
    d = Math.trunc((d * (100 + UPGRADE_DAMAGE_PCT * upgrade)) / 100);
  }
  if (victim.kind !== 'unit') d = Math.trunc((d * st.siege) / 100);
  if (
    !attacker.flying &&
    !victim.flying &&
    elevAt(attacker.x, attacker.y) < elevAt(victim.x, victim.y)
  ) {
    d = Math.trunc((d * HIGH_GROUND_DAMAGE_PCT) / 100);
  }
  return d;
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
 * 이 기지에 배치된 일꾼 수.
 *
 * 배분 규칙(id 오름차순, 정원까지)을 렌더러가 따로 복제하면 언젠가 어긋난다.
 * 그래서 규칙은 여기 한 곳에만 두고 조회로 노출한다.
 */
export function workersAtBase(s: GameState, base: Entity): number {
  if (base.kind !== 'base' || base.deploy > 0 || base.reserve <= 0) return 0;
  let left = s.players[base.team].workers;
  for (const e of s.entities) {
    if (e.kind !== 'base' || e.team !== base.team) continue;
    if (e.deploy > 0 || e.reserve <= 0) continue;
    const assigned = left < WORKER_CAP_PER_BASE ? left : WORKER_CAP_PER_BASE;
    if (e.id === base.id) return assigned;
    left -= assigned;
    if (left <= 0) return 0;
  }
  return 0;
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

      // 침공 2.0: 채굴은 절반 — 주 수입은 파도 소탕 보상이다 ("파도가 곧 자원")
      const minePct =
        s.invasion && team === 0
          ? hasRelic(p, 'rich_veins')
            ? INVASION_RICH_MINE_PCT
            : INVASION_MINE_PCT
          : 100;
      const want = Math.trunc((assigned * WORKER_MINE_PER_TICK * minePct) / 100);
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

/**
 * 다음 강화 단계를 지금 시작할 수 있는가 (비용은 별도로 확인).
 *
 * 단계 k는 k-1단계 열의 연구를 하나라도 마쳐야 열린다:
 * 1단계는 시작부터, 2단계는 1단계 연구 후, 3단계는 2단계 연구 후.
 */
export function canUpgrade(p: PlayerState): boolean {
  if (p.upgrading !== null) return false;
  if (p.upgrade >= UPGRADE_MAX) return false;
  const needTier = p.upgrade; // 다음 단계 = upgrade+1, 요구 열 = upgrade
  if (needTier === 0) return true;
  const f = getFaction(p.faction);
  return f.tech.some((n) => n.tier === needTier && n.cost > 0 && p.unlocked.includes(n.unit));
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
  const owner = s.players[team];
  const isBld = u.kind === 'building';
  // 특성(체력)과 강철 심장은 곱이 아니라 합으로 얹는다 — 곱하면 후반에 폭주한다
  const hpMul =
    (isBld && hasRelic(owner, 'iron_heart') ? 130 : 100) +
    (isBld ? 0 : traitMod(owner, u.id).hpPct);
  const lifeMul = isBld && hasRelic(owner, 'deep_roots') ? 2 : 1;
  const depTicks = hasRelic(owner, 'fast_deploy')
    ? Math.trunc(DEPLOY_TICKS / 2)
    : DEPLOY_TICKS;
  s.entities.push({
    id: s.nextId++,
    team,
    unit: u.id,
    kind: u.kind === 'building' ? 'building' : 'unit',
    x: clamp(x, 0, ARENA_W - 1),
    y: clamp(y, 0, ARENA_H - 1),
    hp: Math.trunc((u.hp * hpMul) / 100),
    maxHp: Math.trunc((u.hp * hpMul) / 100),
    cd: 0,
    deploy: depTicks,
    life: u.lifetime > 0 ? u.lifetime * lifeMul : u.lifetime,
    target: -1,
    flying: u.flying,
    charge: 0,
    mode: 0,
    haste: 0,
    orderX: -1,
    orderY: -1,
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
    case 'upgrade':
      return startUpgrade(s, cmd);
    case 'relic':
      return pickRelic(s, cmd);
    case 'rally':
      return setRally(s, cmd);
    case 'move':
      return orderMove(s, cmd);
    default:
      return false;
  }
}

function startUpgrade(s: GameState, cmd: Command): boolean {
  const p = s.players[cmd.team];
  if (!canUpgrade(p)) return false;
  const cost = UPGRADE_COSTS[p.upgrade];
  if (p.minerals < cost) return false;
  p.minerals -= cost;
  p.upgrading = { ticks: UPGRADE_TICKS[p.upgrade] };
  return true;
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

  let cost = u.cost * MINERAL_SCALE;
  if (u.kind === 'building' && hasRelic(p, 'cheap_walls')) {
    cost = Math.max(MINERAL_SCALE, cost - MINERAL_SCALE);
  }
  if (p.minerals < cost) return false;
  // 주문은 전장 어디든 떨어진다 — 기지 반경에 묶으면 공격 주문을 자기
  // 앞마당에만 쓸 수 있어 사실상 죽은 콘텐츠가 된다 (협의회 라운드 1 안건 D)
  if (u.kind === 'spell') {
    if (cmd.x < 0 || cmd.y < 0 || cmd.x >= ARENA_W || cmd.y >= ARENA_H) return false;
    p.minerals -= cost;
    applySpell(s, cmd.team, u, cmd.x, cmd.y);
    return true;
  }
  // 실험장은 기지 반경을 묻지 않는다 — 자기 위치를 기지로 속이면 반경
  // 검사가 0이 되고, 경계·지형(물·벽) 검사는 canDeployAt 안에 그대로 남는다
  const zone = s.sandbox ? ([[cmd.x, cmd.y]] as const) : ownBasePositions(s, cmd.team);
  if (!canDeployAt(cmd.x, cmd.y, zone)) return false;

  // 방벽은 지형이 된다 — 완전 봉쇄가 되는 자리는 거절한다 (라운드 29, 침공 전용)
  if (s.invasion && u.kind === 'building') {
    // 설치권이 없으면 미네랄이 넘쳐도 못 세운다 (라운드 30)
    if (p.wallCharges <= 0) return false;
    const probe: number[] = [];
    blockerTilesOf(
      { x: cmd.x, y: cmd.y } as Entity,
      probe,
    );
    if (wouldSealOff(s, cmd.team, probe)) return false;
  }

  p.minerals -= cost;
  if (s.invasion && u.kind === 'building') p.wallCharges--;
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
  if (!siteReachable(s, cmd.team, site)) return false;

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
  // 침공의 해금은 드래프트로만 — 연구가 열려 있으면 드래프트가 장식이 된다
  if (s.invasion) return false;
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

/**
 * 침공 파도 하나를 쏟아낸다 (침공 모드 전용).
 *
 * 예산을 침공 종족의 유닛 목록(코스트 순)에 결정론적으로 쓴다 — 파도
 * 번호에 따라 상위 유닛이 섞이기 시작해 "다음 파도는 뭐가 올까"가 생긴다.
 * 위치는 침공자 본진 둘레, 시뮬 RNG 사용(상태에 포함되므로 결정론 안전).
 */
function spawnWave(s: GameState): void {
  s.wave++;
  const interval = Math.max(
    INVASION_WAVE_MIN_TICKS,
    INVASION_WAVE_TICKS - (s.wave - 1) * INVASION_WAVE_ACCEL,
  );
  s.nextWaveTick = s.tick + Math.trunc(interval);

  // 스폰 모서리 로테이션 — 파도마다 다른 방향에서 온다 ("사방에서 쏟아진다").
  // 내 본진에서 가장 먼 세 모서리를 돌아가며 쓴다
  const myMain = s.entities.find((e) => e.kind === 'base' && e.team === 0 && e.isMain);
  const M = 5000;
  const corners: Array<[number, number]> = [
    [M, M],
    [ARENA_W - M, M],
    [M, ARENA_H - M],
    [ARENA_W - M, ARENA_H - M],
  ];
  if (myMain) {
    corners.sort(
      (a, b) =>
        dist2(b[0], b[1], myMain.x, myMain.y) - dist2(a[0], a[1], myMain.x, myMain.y),
    );
    corners.length = 3; // 내 본진 코앞 모서리는 제외
  }
  const anchor = corners[(s.wave - 1) % corners.length];
  // 모서리가 물·벽이면 곁의 통행 타일로 (고정 나선 — 결정론)
  let [cx, cy] = anchor;
  {
    const tx0 = Math.trunc(cx / 1000);
    const ty0 = Math.trunc(cy / 1000);
    outer: for (let r = 0; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const cheb = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy);
          if (cheb !== r) continue;
          if (!blockedAt((tx0 + dx) * 1000 + 500, (ty0 + dy) * 1000 + 500)) {
            cx = (tx0 + dx) * 1000 + 500;
            cy = (ty0 + dy) * 1000 + 500;
            break outer;
          }
        }
      }
    }
  }

  // 파도 타입 — 5파도마다 특수(공중/공성/러시), 10파도마다 보스.
  // 예고(waveTypeOf)와 같은 함수를 쓰므로 HUD가 거짓말하지 않는다
  const type = waveTypeOf(s.wave);
  const f = getFaction(s.players[1].faction);
  const all = f.tech
    .map((n) => n.unit)
    .filter((id) => getUnit(id).kind === 'unit')
    .sort((a, b) => getUnit(a).cost - getUnit(b).cost || (a < b ? -1 : 1));
  if (all.length === 0) return;

  let pool = all;
  if (type === 'air') {
    const air = all.filter((id) => getUnit(id).flying);
    if (air.length > 0) pool = air;
  } else if (type === 'siege') {
    const rng4 = all.filter((id) => {
      const u = getUnit(id);
      return !u.flying && (u.siege >= 100 || u.range >= 4000);
    });
    if (rng4.length > 0) pool = rng4;
  } else if (type === 'rush') {
    pool = [all[0]]; // 최저가 물량전
  }

  let budget = s.waveBudget;
  const initial = budget;
  // 다음 파도 예산 — 정수 백분율 곱 (부동소수점 금지)
  s.waveBudget = Math.trunc((s.waveBudget * INVASION_BUDGET_GROWTH) / 100);

  // 보스: 최고가 유닛 1기를 체력 3배로 앞세우고, 남은 예산은 호위
  if (type === 'boss') {
    const bossU = getUnit(all[all.length - 1]);
    const before = s.entities.length;
    for (let i = 0; i < bossU.count; i++) {
      const [fx, fy] = formationOffset(bossU.count, i);
      spawnUnit(s, 1, bossU, cx + fx, cy + fy);
    }
    for (let i = before; i < s.entities.length; i++) {
      const b = s.entities[i];
      b.hp *= 3;
      b.maxHp *= 3;
    }
    budget -= bossU.cost * MINERAL_SCALE;
    pool = [all[0]];
  }

  // 3파도마다 시작 지점을 한 단계 올린다 — 후반 파도는 고급 유닛 위주
  let idx = Math.min(pool.length - 1, Math.trunc((s.wave - 1) / 3));
  let guard = 64;
  while (budget > 0 && guard-- > 0) {
    const u = getUnit(pool[idx]);
    const cost = u.cost * MINERAL_SCALE;
    if (cost <= budget) {
      budget -= cost;
      const ox = nextInt(s.rng, 4000) - 2000;
      const oy = nextInt(s.rng, 4000) - 2000;
      for (let i = 0; i < u.count; i++) {
        const [fx, fy] = formationOffset(u.count, i);
        spawnUnit(s, 1, u, cx + ox + fx, cy + oy + fy);
      }
      // 다음 구매는 풀을 한 칸 내려가 저렴한 것을 섞는다
      idx = idx > 0 ? idx - 1 : Math.min(pool.length - 1, Math.trunc((s.wave - 1) / 3));
    } else {
      idx = idx > 0 ? idx - 1 : 0;
      if (idx === 0 && getUnit(pool[0]).cost * MINERAL_SCALE > budget) break;
    }
  }

  // 소탕 보상 — 실제로 쏟아진 예산 기준. "빨리 지울수록 부유해진다"
  s.waveAlive = true;
  s.waveReward = Math.trunc(((initial - budget) * INVASION_BOUNTY_PCT) / 100);
}

/**
 * 드래프트 제안 3장 — 미보유 유물 + 미해금 유닛(unlock:) 풀에서 시뮬 RNG로.
 * 침공의 성장 축: 연구는 봉인되어 있고, 해금은 오직 여기서 온다.
 */
function offerDraft(s: GameState): void {
  const p = s.players[0];
  const pool: string[] = [];
  for (const r of RELICS) {
    if (hasRelic(p, r.id)) continue;
    // 겨냥한 유닛이 없으면 죽은 카드다 — 3택1이 2택1로 줄어든다
    if (r.unit && !p.unlocked.includes(r.unit)) continue;
    pool.push(r.id);
  }
  for (const node of getFaction(p.faction).tech) {
    const u = getUnit(node.unit);
    if (u.kind === 'spell') continue;
    if (!p.unlocked.includes(node.unit)) pool.push('unlock:' + node.unit);
  }
  // 침공 전용 지원 건물 — 종족 트리에 없으므로 여기서만 들어온다
  for (const id of INVASION_BUILDINGS) {
    if (!p.unlocked.includes(id)) pool.push('unlock:' + id);
  }
  if (pool.length === 0) return;
  const picks: string[] = [];
  let guard = 24;
  while (picks.length < 3 && picks.length < pool.length && guard-- > 0) {
    const c = pool[nextInt(s.rng, pool.length)];
    if (!picks.includes(c)) picks.push(c);
  }
  s.draft = picks;
}

/**
 * 이동 명령 — `id`에 대상 엔티티 id를 쉼표로 잇는다.
 *
 * Command를 평평하게 유지하려는 선택이다(정렬·직렬화·리플레이가 그대로 산다).
 * 남의 유닛·건물·기지는 조용히 걸러지므로 위조해도 남을 조종할 수 없다.
 */
function orderMove(s: GameState, cmd: Command): boolean {
  if (cmd.x < 0 || cmd.y < 0 || cmd.x >= ARENA_W || cmd.y >= ARENA_H) return false;
  if (blockedAt(cmd.x, cmd.y)) return false;
  let moved = false;
  let count = 0;
  for (const part of cmd.id.split(',')) {
    if (++count > ORDER_MAX_UNITS) break;
    const id = Number(part);
    if (!Number.isInteger(id)) continue;
    const e = findById(s, id);
    if (!e || e.kind !== 'unit' || e.team !== cmd.team) continue;
    e.orderX = cmd.x;
    e.orderY = cmd.y;
    moved = true;
  }
  return moved;
}

/**
 * 집결 지점 지정 (침공 전용).
 *
 * 같은 자리를 다시 찍으면 해제 — 우클릭 한 번으로 "모여라/흩어져라"가 된다.
 * 지형 위(물·벽)는 거절: 갈 수 없는 곳에 깃발을 꽂으면 전군이 벽에 붙는다.
 */
function setRally(s: GameState, cmd: Command): boolean {
  if (!s.invasion || cmd.team !== 0) return false;
  if (cmd.x < 0 || cmd.y < 0 || cmd.x >= ARENA_W || cmd.y >= ARENA_H) return false;
  if (blockedAt(cmd.x, cmd.y)) return false;
  const p = s.players[0];
  if (p.rally && dist2(p.rally.x, p.rally.y, cmd.x, cmd.y) <= RALLY_ARRIVE * RALLY_ARRIVE) {
    p.rally = null; // 같은 자리 재지정 = 해제
    return true;
  }
  p.rally = { x: cmd.x, y: cmd.y };
  return true;
}

/** 드래프트 선택 — 제안에 있는 카드만 유효하다 */
function pickRelic(s: GameState, cmd: Command): boolean {
  if (!s.invasion || cmd.team !== 0) return false;
  const p = s.players[0];
  if (cmd.id.startsWith('hero:')) {
    if (!s.heroDraft.includes(cmd.id) || p.hero) return false;
    p.hero = cmd.id.slice(5);
    summonHero(s, 0);
    s.heroDraft = [];
    return true;
  }
  if (!s.draft.includes(cmd.id)) return false;
  if (cmd.id.startsWith('unlock:')) {
    unlock(p, cmd.id.slice(7));
  } else {
    p.relics.push(cmd.id);
  }
  s.draft = [];
  return true;
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

/** 확장 인접 제약 — 보유 기지에서 EXPAND_RANGE 안의 지점만 지을 수 있다 */
export function siteReachable(
  s: GameState,
  team: Team,
  site: { x: number; y: number },
): boolean {
  const r2 = EXPAND_RANGE * EXPAND_RANGE;
  for (const e of s.entities) {
    if (e.kind !== 'base' || e.team !== team || e.deploy > 0) continue;
    if (dist2(e.x, e.y, site.x, site.y) <= r2) return true;
  }
  return false;
}

/* ── 방벽 = 지형 (라운드 29) ───────────────────────────────────────────── */

const EMPTY_BLOCKERS: readonly number[] = [];

/**
 * 건물 하나가 막는 타일 — 중심 칸과 직교 이웃 4칸(십자).
 *
 * 물리적 근거: 건물 반경 900 + 유닛 반경 400 = 1300. 즉 건물 중심에서
 * 1.3타일 안으로는 유닛의 몸이 들어가지 못한다. 이웃 칸(거리 1.0)까지
 * 막아야 길찾기와 충돌이 어긋나지 않는다 — 어긋나면 유닛이 "지나갈 수
 * 있다고 믿고" 들어갔다가 끼는 라운드 19식 사고가 난다.
 */
function blockerTilesOf(e: Entity, out: number[]): void {
  const tx = tileX(e.x);
  const ty = tileY(e.y);
  for (const [dx, dy] of [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const i = tileIndex(tx + dx, ty + dy);
    if (i >= 0) out.push(i);
  }
}

/**
 * 건물 목록 → 길찾기 장애물 격자. 매 틱 호출되지만 서명이 같으면 공짜다.
 * 기지는 제외한다 — 고정 지점이라 막으면 기존 맵의 통로가 닫힌다.
 */
function syncBlockers(s: GameState): void {
  // **침공 전용이다.** 대전에 켜 보니 방어 건물이 접근로를 닫아 삼각이
  // 무너졌다 (하네스 실측: RUSH vs TECH 58% → 38%). 대전 도입은 방어
  // 건물 재튜닝을 끝낸 뒤 별도 라운드로 — 기존 모드는 건드리지 않는다
  if (!s.invasion) {
    setBlockers(EMPTY_BLOCKERS, 0);
    return;
  }
  const tiles: number[] = [];
  let sig = 0x811c9dc5;
  for (const e of s.entities) {
    if (e.kind !== 'building') continue;
    if (getUnit(e.unit).mine) continue; // 묻은 것은 길을 막지 않는다
    const before = tiles.length;
    blockerTilesOf(e, tiles);
    for (let i = before; i < tiles.length; i++) {
      sig ^= tiles[i];
      sig = Math.imul(sig, 0x01000193) >>> 0;
    }
  }
  setBlockers(tiles, sig);
}

/**
 * 이 건물을 지으면 적이 내 본진에 닿을 길이 하나도 없어지는가.
 *
 * 완전 봉쇄 금지 — 미로와 막다른 길은 허용하되 전면 폐쇄는 거절한다.
 * 지금 길이 있는 출발점만 검사한다(원래 막혀 있던 섬 때문에 배치가
 * 거절되면 안 된다).
 */
function wouldSealOff(s: GameState, team: Team, extra: readonly number[]): boolean {
  const home = s.entities.find((e) => e.kind === 'base' && e.team === team && e.isMain);
  if (!home) return false;
  const gx = tileX(home.x);
  const gy = tileY(home.y);

  const sources: Array<[number, number]> = [
    [1, 1],
    [ARENA_W_TILES - 2, 1],
    [1, ARENA_H_TILES - 2],
    [ARENA_W_TILES - 2, ARENA_H_TILES - 2],
  ];
  const foe = s.entities.find((e) => e.kind === 'base' && e.team !== team && e.isMain);
  if (foe) sources.push([tileX(foe.x), tileY(foe.y)]);

  for (const [sx, sy] of sources) {
    // 지금도 못 오는 출발점은 따지지 않는다
    if (!pathExists(sx, sy, gx, gy)) continue;
    if (!pathExists(sx, sy, gx, gy, extra)) return true;
  }
  return false;
}

/**
 * 이 지점에 걸린 지원 오라의 세기 합 (라운드 31).
 *
 * 겹치면 더해진다 — 겹치는 자리를 만드는 것이 성 설계의 묘미다. 다만
 * 감속은 90%에서 자른다: 완전 정지는 파도를 영구히 세워 게임을 멈춘다.
 */
/** 지휘탑 오라 — 유닛의 공격만 키운다 (건물·기지는 제외: 성이 성을 키우면 무한) */
function withRally(s: GameState, attacker: Entity, dmg: number): number {
  if (attacker.kind !== 'unit') return dmg;
  const pct = auraPower(s, 'rally', attacker.team, attacker.x, attacker.y);
  return pct > 0 ? Math.trunc((dmg * (100 + pct)) / 100) : dmg;
}

function auraPower(
  s: GameState,
  kind: 'chill' | 'rally' | 'mend',
  team: Team,
  x: number,
  y: number,
): number {
  let sum = 0;
  for (const e of s.entities) {
    if (e.kind !== 'building' || e.team !== team || e.deploy > 0) continue;
    const a = getUnit(e.unit).aura;
    if (!a || a.kind !== kind) continue;
    if (dist2(e.x, e.y, x, y) <= a.radius * a.radius) sum += a.power;
  }
  return kind === 'chill' ? (sum > 90 ? 90 : sum) : sum;
}

/* ── 능동 특성 (4축, 라운드 35) ────────────────────────────────────────── */

/**
 * 이 엔티티의 능동 특성 — **침공에서만 켜진다**.
 *
 * 문지기가 여기 하나뿐이라, 대전·실험장으로 새는 길이 구조적으로 없다.
 * 대전 도입은 삼각(RUSH/TECH 58%)을 다시 재고 나서 별도 라운드로 한다.
 */
function abilityOf(s: GameState, e: Entity): UnitDef['ability'] {
  if (!s.invasion || e.kind === 'base' || e.deploy > 0) return undefined;
  return getUnit(e.unit).ability;
}

/** 게이지가 다 차는 데 걸리는 틱 — 능동 특성은 저마다 다르다 */
export function chargeTicksOf(u: UnitDef): number {
  return u.ability?.charge ?? SKILL_CHARGE_TICKS;
}

/**
 * 지금 숨어 있는가.
 *
 * 지뢰는 늘 숨어 있고, 은신 유닛은 게이지가 만충일 때만 숨는다 — 때리면
 * 게이지가 0이 되므로 **공격은 곧 노출**이다. 디텍터가 없는 상대에게도
 * 맞받아칠 길이 남아야 "은신을 만나면 진다"는 잠금이 생기지 않는다.
 */
function isCloaked(s: GameState, e: Entity): boolean {
  if (!s.invasion || e.kind === 'base') return false;
  const u = getUnit(e.unit);
  if (u.mine) return true;
  if (u.ability?.kind !== 'cloak') return false;
  return e.charge >= chargeTicksOf(u);
}

/**
 * 디텍터 목록 캐시 — 틱당 한 번만 훑는다.
 *
 * 은신 판정은 (공격자 × 은신 대상)마다 불린다. 지뢰밭이 깔린 후반에는 그
 * 곱이 수만 번이 되는데, 매번 전체 엔티티를 훑으면 틱 예산이 무너진다
 * (실측: 1877 엔티티에서 최악 84ms → 캐시 후 16ms). 디텍터는 보통 0~2기라
 * 목록만 만들어 두면 판정이 사실상 공짜가 된다.
 *
 * 무효화는 (상태 · 틱 · 엔티티 수) 삼중 확인 — 렌더러가 틱 사이에 물어도
 * 안전하고, 한 틱 안에서 시체가 걷혀도 다시 만든다.
 */
let detState: GameState | null = null;
let detTick = -1;
let detCount = -1;
const detCache: [Entity[], Entity[]] = [[], []];

function detectorsOf(s: GameState, team: Team): Entity[] {
  if (detState !== s || detTick !== s.tick || detCount !== s.entities.length) {
    detCache[0] = [];
    detCache[1] = [];
    for (const e of s.entities) {
      if (e.kind === 'base' || e.deploy > 0) continue;
      if (getUnit(e.unit).ability?.kind === 'detect') detCache[e.team].push(e);
    }
    detState = s;
    detTick = s.tick;
    detCount = s.entities.length;
  }
  return detCache[team];
}

/** 이 지점이 team의 디텍터에 잡히는가 */
function detectedBy(s: GameState, team: Team, x: number, y: number): boolean {
  for (const d of detectorsOf(s, team)) {
    const r = getUnit(d.unit).ability?.radius ?? 0;
    if (dist2(d.x, d.y, x, y) <= r * r) return true;
  }
  return false;
}

/**
 * viewer 팀이 target을 때릴 수 있는가 — 은신 판정.
 *
 * 숨은 것을 보려면 디텍터가 필요하다. 스플래시는 이 관문을 타지 않는다:
 * 위치를 모른 채 쏜 광역에 우연히 맞는 것까지 막으면 지뢰가 무적이 된다.
 */
function visibleTo(s: GameState, viewer: Team, target: Entity): boolean {
  if (!isCloaked(s, target)) return true;
  return detectedBy(s, viewer, target.x, target.y);
}

/**
 * 이 엔티티가 viewer에게 **보이지 않는가** — 렌더러가 쓰는 공개 판정.
 *
 * 화면과 시뮬이 같은 함수로 판단해야 "보이는데 못 때린다"가 생기지 않는다.
 */
export function isHiddenFrom(s: GameState, viewer: Team, e: Entity): boolean {
  if (e.team === viewer) return false;
  return !visibleTo(s, viewer, e);
}

/** 내 은신 유닛인가 — 반투명으로 그려 "지금 숨어 있다"를 알린다 */
export function isCloakedNow(s: GameState, e: Entity): boolean {
  return isCloaked(s, e);
}

/** 시즈모드에 들어갔는가 — 제자리에 charge 틱 이상 머문 공성 유닛 */
export function inSiegeMode(s: GameState, e: Entity): boolean {
  const a = abilityOf(s, e);
  if (a?.kind !== 'siegemode') return false;
  return e.mode >= (a.charge ?? SKILL_CHARGE_TICKS);
}

/* ── 영웅 (5축, 라운드 37) ─────────────────────────────────────────────── */

/** 지금 살아 있는 내 영웅 엔티티 (없으면 undefined) */
function heroEntity(s: GameState, team: Team): Entity | undefined {
  const id = s.players[team].hero;
  if (!id) return undefined;
  for (const e of s.entities) if (e.team === team && e.unit === id) return e;
  return undefined;
}

/** 영웅을 본진 곁에 세운다 — 레벨만큼 체력을 얹어서 */
function summonHero(s: GameState, team: Team): void {
  const p = s.players[team];
  if (!p.hero) return;
  const main = s.entities.find((e) => e.kind === 'base' && e.team === team && e.isMain)
    ?? s.entities.find((e) => e.kind === 'base' && e.team === team);
  if (!main) return;
  const u = getUnit(p.hero);
  // 본진 위 3타일 — 기지 스프라이트(2.5타일)에 가리지 않는 거리다.
  // 통행 가능한 자리는 고정 나선으로 찾는다(결정론)
  let hx = main.x;
  let hy = main.y - 3000;
  if (blockedAt(hx, hy)) {
    outer: for (let r = 1; r < 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue; // 기지에 겹치지 않게
          const cx = main.x + dx * 1000;
          const cy = main.y + dy * 1000;
          if (cx < 0 || cy < 0 || cx >= ARENA_W || cy >= ARENA_H) continue;
          if (!blockedAt(cx, cy)) {
            hx = cx;
            hy = cy;
            break outer;
          }
        }
      }
    }
  }
  const before = s.entities.length;
  spawnUnit(s, team, u, hx, hy);
  // 성장 — 레벨당 체력 +10%. 공격력은 statsOf가 매 틱 얹는다
  for (let i = before; i < s.entities.length; i++) {
    const h = s.entities[i];
    const mul = 100 + p.heroLevel * HERO_HP_PER_LEVEL;
    h.hp = Math.trunc((h.hp * mul) / 100);
    h.maxHp = Math.trunc((h.maxHp * mul) / 100);
  }
}

/**
 * 영웅의 생사를 지킨다 — 매 틱 한 번.
 *
 * 죽음을 이벤트로 잡지 않고 **존재 여부로 유도한다**: 시체를 걷어가는 길이
 * 둘(reap·resolveDeaths)이라 한쪽에 훅을 달면 반드시 빠뜨린다 (라운드 32에서
 * 불안정 노심이 그랬다).
 */
function tickHero(s: GameState): void {
  const p = s.players[0];
  if (!p.hero) return;
  if (heroEntity(s, 0)) {
    p.heroRespawn = 0;
    return;
  }
  if (p.heroRespawn === 0) {
    // 방금 쓰러졌다 — 레벨 하나를 잃고 시계를 건다
    p.heroLevel = p.heroLevel > 0 ? p.heroLevel - 1 : 0;
    p.heroRespawn = HERO_RESPAWN_TICKS;
    return;
  }
  p.heroRespawn--;
  if (p.heroRespawn <= 0) {
    p.heroRespawn = 0;
    summonHero(s, 0);
  }
}

/* ── 런 체인 (로그라이트 3단계, 라운드 38) ─────────────────────────────── */

/** 이 무대의 규칙 */
export function stageOf(s: GameState): StageDef {
  return RUN_STAGES[s.stage] ?? RUN_STAGES[RUN_STAGES.length - 1];
}

/** 이 무대를 넘기려면 몇 파도까지 버텨야 하는가 (둥지 무대는 0) */
export function stageGoal(s: GameState): number {
  let sum = 0;
  for (let i = 0; i <= s.stage && i < RUN_STAGES.length; i++) sum += RUN_STAGES[i].waves;
  return sum;
}

/**
 * 다음 무대로 넘어간다 — **전장만 갈아엎고 성장은 데려간다**.
 *
 * 새 GameState를 만들지 않는다: 유물·해금·영웅 레벨·미네랄은 그대로 두고
 * 엔티티와 맵만 바꾼다. 그래야 "같은 런이 이어진다"는 감각이 산다.
 * nextId는 이어서 쓴다 — 재사용하면 리플레이의 id가 겹친다.
 */
function advanceStage(s: GameState): void {
  s.stage++;
  const def = stageOf(s);
  if (def.map) {
    setActiveMap(def.map);
    s.mapId = def.map;
  }

  const p = s.players[0];
  p.rally = null;
  // 성은 두고 왔다 — 새 전장에서 다시 짓는다
  p.wallCharges = STAGE_WALL_GRANT;
  if (p.workers > WORKER_CAP_PER_BASE) p.workers = WORKER_CAP_PER_BASE;

  s.entities = [];
  syncBlockers(s);
  for (const site of BASE_SITES) {
    if (site.startFor !== 0) continue;
    s.entities.push(makeBase(s, 0, site, true));
  }
  // 3무대의 둥지 — 침공자 시작 지점에 선다. "적 본진 자리"라는 읽기가
  // 그대로 목적지가 된다
  if (def.nest) {
    const lair = BASE_SITES.find((b) => b.startFor === 1);
    if (lair) {
      spawnUnit(s, 1, getUnit('nest'), lair.x, lair.y);
      const n = s.entities[s.entities.length - 1];
      n.deploy = 0;
      s.nestAlive = true;
    }
  }
  // 영웅은 무대를 따라온다 (레벨 그대로)
  if (p.hero) {
    p.heroRespawn = 0;
    summonHero(s, 0);
  }
  s.waveAlive = false;
  s.nextWaveTick = s.tick + INVASION_FIRST_WAVE_TICKS;
}

/**
 * 무대 판정 — 매 틱 한 번.
 *   방어 무대: 목표 파도까지 넘기고 전장이 비면 다음 무대로
 *   둥지 무대: 둥지가 부서지면 런 승리
 */
function tickStage(s: GameState): void {
  if (s.over) return;
  const def = stageOf(s);
  if (def.nest) {
    if (s.nestAlive && !s.entities.some((e) => e.team === 1 && e.unit === 'nest')) {
      s.nestAlive = false;
      s.over = true;
      s.winner = 0; // 런 완주 — 로그라이트의 유일한 승리 조건
    }
    return;
  }
  if (s.wave < stageGoal(s) || s.waveAlive) return;
  if (s.entities.some((e) => e.team === 1 && e.kind === 'unit')) return;
  advanceStage(s);
}

/* ── 침공 파도 타입·유물 ───────────────────────────────────────────────── */

export type WaveType = 'normal' | 'air' | 'siege' | 'rush' | 'boss';

/** 파도 번호 → 타입. 클라이언트가 **다음 파도 예고**에 같은 함수를 쓴다 */
export function waveTypeOf(n: number): WaveType {
  if (n <= 0) return 'normal';
  if (n % 10 === 0) return 'boss';
  if (n % 5 === 0) return (['air', 'siege', 'rush'] as const)[Math.trunc(n / 5) % 3];
  return 'normal';
}

export function hasRelic(p: PlayerState, id: string): boolean {
  return p.relics.includes(id);
}

/**
 * 이 유닛에 걸린 특성 보정의 합 (3축, 라운드 32).
 *
 * 유물이 없을 때는 곧바로 빠져나온다 — statsOf는 매 틱 엔티티마다 불린다.
 */
function traitMod(p: PlayerState, unitId: string): {
  damagePct: number;
  rangeAdd: number;
  hpPct: number;
  speedPct: number;
} {
  const out = { damagePct: 0, rangeAdd: 0, hpPct: 0, speedPct: 0 };
  if (p.relics.length === 0) return out;
  for (const id of p.relics) {
    const r = RELIC_BY_ID.get(id);
    if (!r?.mod) continue;
    if (r.unit && r.unit !== unitId) continue;
    out.damagePct += r.mod.damagePct ?? 0;
    out.rangeAdd += r.mod.rangeAdd ?? 0;
    out.hpPct += r.mod.hpPct ?? 0;
    out.speedPct += r.mod.speedPct ?? 0;
  }
  return out;
}

/** 사기 충천은 유효 강화 +1 — 같은 +10% 문법이라 damageTo를 재사용한다 */
function effUpgrade(p: PlayerState): number {
  return p.upgrade + (hasRelic(p, 'war_drums') ? 1 : 0);
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
  const st = statsOf(s, e);
  const aggro = aggroRange(st.range);
  const aggro2 = aggro * aggro;

  let bestUnit = -1;
  let bestUnitD2 = Infinity;
  let bestStruct = -1;
  let bestStructD2 = Infinity;

  for (const o of s.entities) {
    if (o.team === e.team || o.hp <= 0) continue;
    if (!canAttack(e, o)) continue;
    // 숨은 것은 겨냥할 수 없다 — 디텍터가 있어야 표적이 된다 (4축)
    if (!visibleTo(s, e.team, o)) continue;
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

/**
 * 목표까지 가기 위해 지금 향해야 할 지점.
 *
 * 지형을 아는 것은 `nav` 뿐이다. 여기서는 "날면 직선, 아니면 길을 물어본다"만
 * 판단한다. 그래서 맵이 바뀌어도 이 함수는 손댈 필요가 없다.
 */
function moveGoal(e: Entity, tx: number, ty: number): [number, number] {
  // 공중 유닛은 지형을 무시하고 직선으로 난다.
  if (e.flying) return [tx, ty];
  return navStep(e.x, e.y, tx, ty);
}

/* ── 틱 진행 ───────────────────────────────────────────────────────────── */

/**
 * 한 틱을 진행한다. `cmds`는 **이 틱에 실행되도록 예약된** 커맨드 목록이며,
 * 호출자가 sortCommands로 정규화해서 넘겨야 한다.
 */
export function step(s: GameState, cmds: readonly Command[]): void {
  // 서로 다른 맵의 경기를 번갈아 시뮬해도 안전하게 — 매 틱 활성 맵을 맞춘다
  setActiveMap(s.mapId);
  if (s.over) {
    s.tick++;
    return;
  }

  // 1) 예약된 커맨드 실행
  for (const cmd of cmds) applyCommand(s, cmd);

  // 1.2) 방벽 = 지형 — 건물이 길찾기 격자를 바꾼다 (서명이 같으면 공짜)
  syncBlockers(s);

  // 1.5) 침공 파도 — 예산이 자라는 무리가 침공자 본진에서 쏟아진다
  // 무대 목표를 채웠으면 더 부르지 않는다 — 마지막 파도가 그 무대의 끝이다.
  // (이게 없으면 후반 간격 10초가 앞 파도를 다 잡기 전에 다음을 불러
  //  전장이 영영 비지 않고, 무대가 넘어가지 않는다 — 라운드 38 실측)
  const staged = s.invasion && !stageOf(s).nest && s.wave >= stageGoal(s);
  if (s.invasion && !staged && s.tick >= s.nextWaveTick && !s.over) spawnWave(s);

  // 2) 채굴
  mine(s);
  // 실험장 — 자원 걱정 없이 아무거나 계속 배치할 수 있게 상시 보충
  if (s.sandbox) for (const p of s.players) p.minerals = MINERAL_MAX;

  // 3) 연구·강화 진행
  for (const p of s.players) {
    if (p.research) {
      p.research.ticks--;
      if (p.research.ticks <= 0) {
        unlock(p, p.research.unit);
        p.research = null;
      }
    }
    if (p.upgrading) {
      p.upgrading.ticks--;
      if (p.upgrading.ticks <= 0) {
        p.upgrade++;
        p.upgrading = null;
      }
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

  // 4.5) 충전 스킬 — 게이지가 차면 사거리 안 가장 가까운 적에게 자동 발사.
  // 읽기 패스로 발사 목록을 모은 뒤 한꺼번에 적용한다 (reap이 배열을 바꾸므로)
  const casts: Array<{ team: Team; spell: UnitDef; x: number; y: number; caster: Entity }> = [];
  for (const e of s.entities) {
    if (e.kind !== 'unit' || e.deploy > 0) continue;
    const spellId = getUnit(e.unit).charges;
    if (!spellId) continue;
    if (e.charge < SKILL_CHARGE_TICKS) {
      e.charge += hasRelic(s.players[e.team], 'focus') ? 2 : 1;
      if (e.charge > SKILL_CHARGE_TICKS) e.charge = SKILL_CHARGE_TICKS;
      continue;
    }
    const spell = getUnit(spellId);
    let bx = 0;
    let by = 0;
    let bestD2 = SKILL_CAST_RANGE * SKILL_CAST_RANGE + 1;
    for (const o of s.entities) {
      if (o.team === e.team || o.kind === 'base' || o.deploy > 0) continue;
      if (spell.targets === 'ground' && o.flying) continue;
      if (spell.targets === 'air' && !o.flying) continue;
      const d2 = dist2(e.x, e.y, o.x, o.y);
      // 엄격 부등호 + id 오름차순 순회 = 동률이면 id 작은 쪽 (결정론)
      if (d2 < bestD2) {
        bestD2 = d2;
        bx = o.x;
        by = o.y;
      }
    }
    if (bestD2 <= SKILL_CAST_RANGE * SKILL_CAST_RANGE) {
      casts.push({ team: e.team, spell, x: bx, y: by, caster: e });
    }
  }
  for (const c of casts) {
    applySpell(s, c.team, c.spell, c.x, c.y);
    c.caster.charge = 0;
  }

  // 4.6) 능동 특성 (4축) — 침공 전용. 게이지를 채우고, 다 차면 **상태를 바꾼다**.
  // 주문 패스와 나란히 두되 섞지 않는다: 저쪽은 피해를 쏘고 이쪽은 판을 바꾼다
  if (s.invasion) {
    const plants: Array<{ team: Team; x: number; y: number }> = [];
    const births: Array<{ team: Team; x: number; y: number; n: number; r: number }> = [];
    const sprints: Array<{ team: Team; x: number; y: number; r2: number; ticks: number }> = [];
    for (const e of s.entities) {
      if (e.haste > 0) e.haste--;
      const a = abilityOf(s, e);
      if (!a) continue;
      const full = a.charge ?? SKILL_CHARGE_TICKS;
      if (a.kind === 'cloak') {
        // 게이지가 곧 은신이다 — 때리면 0이 되고(공격 패스), 다시 차오르면 숨는다
        if (e.charge < full) e.charge++;
        continue;
      }
      // detect·siegemode는 게이지가 없다
      if (a.kind !== 'mine' && a.kind !== 'sprint' && a.kind !== 'spawn' && a.kind !== 'heal') {
        continue;
      }
      if (e.charge < full) {
        e.charge++;
        continue;
      }
      if (a.kind === 'spawn') {
        // 산란 — 새끼를 낳는다. 수명이 짧아 무한히 쌓이지 않는다
        e.charge = 0;
        births.push({ team: e.team, x: e.x, y: e.y, n: a.power ?? 1, r: a.radius ?? 1000 });
        continue;
      }
      if (a.kind === 'heal') {
        // 치유의 빛 — 둘레 아군 유닛을 일으킨다. 건물·기지는 정비고의 몫이다
        e.charge = 0;
        const hr = a.radius ?? 0;
        const amount = a.power ?? 0;
        for (const o of s.entities) {
          if (o.kind !== 'unit' || o.team !== e.team || o.hp <= 0) continue;
          if (dist2(o.x, o.y, e.x, e.y) > hr * hr) continue;
          o.hp = o.hp + amount > o.maxHp ? o.maxHp : o.hp + amount;
        }
        continue;
      }
      if (a.kind === 'sprint') {
        e.charge = 0;
        const r = a.radius ?? 0;
        sprints.push({ team: e.team, x: e.x, y: e.y, r2: r * r, ticks: a.ticks ?? 0 });
        continue;
      }
      // 지뢰 — 둘레 상한(power기)을 넘지 않는다. 벽 하나가 지뢰밭이 되면 안 된다
      const r = a.radius ?? 0;
      let near = 0;
      for (const o of s.entities) {
        if (o.team !== e.team || o.kind === 'base' || !getUnit(o.unit).mine) continue;
        if (dist2(o.x, o.y, e.x, e.y) <= r * r) near++;
      }
      if (near >= (a.power ?? 1)) continue;
      // 고정 8방 링에서 시작 방향만 rng로 고른다 (rng는 상태에 있으므로 결정론)
      const k = nextInt(s.rng, 8);
      const RING = 2000;
      const DX = [0, 1, 1, 1, 0, -1, -1, -1];
      const DY = [-1, -1, 0, 1, 1, 1, 0, -1];
      for (let i = 0; i < 8; i++) {
        const d = (k + i) % 8;
        const px = clamp(e.x + DX[d] * RING, 0, ARENA_W - 1);
        const py = clamp(e.y + DY[d] * RING, 0, ARENA_H - 1);
        if (blockedAt(px, py)) continue;
        e.charge = 0;
        plants.push({ team: e.team, x: px, y: py });
        break;
      }
    }
    // 생성·부여는 순회가 끝난 뒤에 (배열을 순회 중에 늘리지 않는다)
    for (const pl of plants) spawnUnit(s, pl.team, getUnit('landmine'), pl.x, pl.y);
    const brood = getUnit('broodling');
    for (const b of births) {
      for (let i = 0; i < b.n; i++) {
        const [ox, oy] = formationOffset(b.n, i);
        spawnUnit(s, b.team, brood, b.x + ox, b.y + oy + b.r / 2);
      }
    }
    for (const sp of sprints) {
      for (const o of s.entities) {
        if (o.kind !== 'unit' || o.team !== sp.team || o.flying) continue;
        if (dist2(o.x, o.y, sp.x, sp.y) <= sp.r2) o.haste = sp.ticks;
      }
    }
  }

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
    const st = statsOf(s, e);
    const reach = st.range + radiusOf(t);
    if (dist2(e.x, e.y, t.x, t.y) > reach * reach) continue;
    if (e.cd > 0) continue;

    e.cd = st.hitSpeed;
    // 은신은 때리는 순간 풀리고(게이지 0), 지뢰는 밟히는 순간 함께 사라진다.
    // 여기 한 줄이 "은신 상대에게는 손도 못 쓴다"를 막는 안전판이다 (4축)
    const ab = abilityOf(s, e);
    if (ab?.kind === 'cloak') e.charge = 0;
    if (s.invasion && e.kind !== 'base' && getUnit(e.unit).mine) e.hp = 0;
    if (st.splash > 0) {
      const sp2 = st.splash * st.splash;
      for (let j = 0; j < n; j++) {
        const o = s.entities[j];
        if (o.team === e.team) continue;
        if (!canAttack(e, o)) continue;
        if (dist2(o.x, o.y, t.x, t.y) <= sp2) {
          dmg[j] += withRally(s, e, damageTo(e, st, o, effUpgrade(s.players[e.team])));
        }
      }
    } else {
      dmg[ti] += withRally(s, e, damageTo(e, st, t, effUpgrade(s.players[e.team])));
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
    // 시즈모드 — 자리를 잡은 포는 움직이지 않는다. 이동 명령이 오면 포를 접는다
    const abil = abilityOf(s, e);
    if (abil?.kind === 'siegemode') {
      if (e.orderX >= 0) e.mode = 0;
      else if (e.mode >= (abil.charge ?? SKILL_CHARGE_TICKS)) continue;
    }
    // 냉각탑 — 적 진영의 감속 오라. 킬존에 가두는 장치다
    const chill = auraPower(s, 'chill', e.team === 0 ? 1 : 0, e.x, e.y);
    const boost = traitMod(s.players[e.team], e.unit).speedPct + (e.haste > 0 ? HASTE_SPEED_PCT : 0);
    const base = boost ? Math.trunc((u.speed * (100 + boost)) / 100) : u.speed;
    const speed = chill > 0 ? Math.trunc((base * (100 - chill)) / 100) : base;
    if (speed <= 0) continue;

    let gx: number;
    let gy: number;
    if (e.orderX >= 0) {
      // 명령 이동 — 도착하면 스스로 해제하고 기본 행동으로 돌아간다
      if (dist2(e.x, e.y, e.orderX, e.orderY) <= ORDER_ARRIVE * ORDER_ARRIVE) {
        e.orderX = -1;
        e.orderY = -1;
        continue;
      }
      [gx, gy] = moveGoal(e, e.orderX, e.orderY);
    } else if (e.target >= 0) {
      const t = findById(s, e.target);
      if (!t) continue;
      const st = statsOf(s, e);
      if (dist2(e.x, e.y, t.x, t.y) <= (st.range + radiusOf(t)) ** 2) continue;
      [gx, gy] = moveGoal(e, t.x, t.y);
    } else {
      if (s.invasion && e.team === 0) {
        // 침공 수비군: 집결 깃발이 있으면 거기로 행군해 주둔한다.
        // 깃발이 없으면 제자리 — 전진 본능을 되살리면 파도 소탕 후
        // 전군이 스폰 지점으로 순례를 떠난다 (라운드 24 사고)
        const r = s.players[0].rally;
        if (!r) continue;
        // 깃발 둘레 2타일 안이면 도착 — 서로 밀치며 진동하지 않게 한다
        if (dist2(e.x, e.y, r.x, r.y) <= RALLY_ARRIVE * RALLY_ARRIVE) continue;
        [gx, gy] = moveGoal(e, r.x, r.y);
      } else {
        // 타겟이 없으면 적 진영 방향으로 전진
        [gx, gy] = moveGoal(e, e.x, e.team === 0 ? 0 : ARENA_H);
      }
    }

    const dx = gx - e.x;
    const dy = gy - e.y;
    const d = isqrt(dx * dx + dy * dy);
    if (d === 0) continue;
    const stepLen = speed < d ? speed : d;
    nx[i] = e.x + Math.trunc((dx * stepLen) / d);
    ny[i] = e.y + Math.trunc((dy * stepLen) / d);

    if (!e.flying && blockedAt(nx[i], ny[i])) {
      if (!blockedAt(e.x, ny[i])) nx[i] = e.x;
      else if (!blockedAt(nx[i], e.y)) ny[i] = e.y;
      else {
        nx[i] = e.x;
        ny[i] = e.y;
      }
    }
    nx[i] = clamp(nx[i], 0, ARENA_W - 1);
    ny[i] = clamp(ny[i], 0, ARENA_H - 1);
  }
  for (let i = 0; i < n; i++) {
    const e = s.entities[i];
    // 시즈 자세는 "제자리에 머문 틱"으로 잰다 — 한 걸음이라도 걸으면 처음부터
    if (abilityOf(s, e)?.kind === 'siegemode') {
      if (e.x === nx[i] && e.y === ny[i]) e.mode++;
      else e.mode = 0;
    }
    e.x = nx[i];
    e.y = ny[i];
  }

  // 8) 겹침 해소
  separate(s);

  // 9) 피해 적용 + 사망 처리
  for (let i = 0; i < n; i++) {
    if (dmg[i] <= 0) continue;
    const e = s.entities[i];
    // 기지 포격은 일꾼도 갈아낸다 — 누적 피해가 문턱을 넘을 때마다 1기.
    // (maxHp - hp) 문턱에서 유도하므로 상태 추가 없이 결정적이다
    if (e.kind === 'base') {
      const before = Math.trunc((e.maxHp - e.hp) / WORKER_LOSS_DAMAGE);
      const after = Math.trunc((e.maxHp - (e.hp - dmg[i])) / WORKER_LOSS_DAMAGE);
      const p = s.players[e.team];
      p.workers = Math.max(0, p.workers - Math.max(0, after - before));
    }
    e.hp -= dmg[i];
  }
  resolveDeaths(s);

  // 9.4) 정비고 — 주변 아군 건물·기지를 되살린다. 초당 power를 틱으로 나눠
  // 정수로 흘린다(부동소수점 금지): tick % TICK_RATE 로 분배
  for (const e of s.entities) {
    if (e.kind === 'unit' || e.hp >= e.maxHp || e.hp <= 0) continue;
    const heal = auraPower(s, 'mend', e.team, e.x, e.y);
    if (heal <= 0) continue;
    const per = Math.trunc(heal / TICK_RATE);
    const rem = heal - per * TICK_RATE;
    const give = per + (s.tick % TICK_RATE < rem ? 1 : 0);
    e.hp = Math.min(e.maxHp, e.hp + give);
  }

  // 9.45) 영웅 — 쓰러졌으면 시계를 걸고, 시계가 다 되면 다시 세운다 (5축)
  if (s.invasion) tickHero(s);

  // 9.5) 침공: 파도 소탕 → 보상 지급 + 드래프트 제안
  if (s.invasion && s.waveAlive) {
    let alive = false;
    for (const e of s.entities) {
      if (e.team === 1 && e.kind === 'unit') {
        alive = true;
        break;
      }
    }
    if (!alive) {
      s.waveAlive = false;
      const p = s.players[0];
      let reward = s.waveReward;
      if (hasRelic(p, 'reserves')) reward = Math.trunc((reward * 130) / 100);
      p.minerals += reward;
      if (p.minerals > MINERAL_MAX) p.minerals = MINERAL_MAX;
      // 파도를 넘겼으니 설치권 보충 — 성은 파도를 견딘 만큼 자란다
      p.wallCharges = Math.min(INVASION_WALL_CAP, p.wallCharges + INVASION_WALL_PER_WAVE);
      // 영웅은 파도를 넘길 때마다 자란다 — 런이 길어질수록 손맛이 커진다
      if (p.hero && p.heroLevel < HERO_LEVEL_MAX) p.heroLevel++;
      // 드래프트 — 이전 제안을 아직 안 골랐으면 새로 만들지 않는다
      if (s.draft.length === 0) offerDraft(s);
    }
  }

  // 9.6) 런 체인 — 무대를 넘기거나, 둥지를 부쉈으면 런이 끝난다 (3단계)
  if (s.invasion) tickStage(s);

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
    if (e.flying || !blockedAt(cx, cy)) {
      e.x = cx;
      e.y = cy;
    } else if (!blockedAt(cx, e.y)) {
      // 벽 방향 밀기를 통째로 버리면 혼잡 속 유닛이 벽에 고정된다 —
      // 이동 코드와 같은 축 분해 슬라이드로 벽을 따라 흐르게 한다 (라운드 19)
      e.x = cx;
    } else if (!blockedAt(e.x, cy)) {
      e.y = cy;
    }
  }
}

/**
 * 죽는 유닛이 남길 폭발을 모은다 (3축 '불안정 노심').
 *
 * 시체를 걷어가는 길이 둘이라(reap·resolveDeaths) 양쪽에서 같은 함수를
 * 부른다 — 한쪽만 처리했더니 수명·주문으로 죽은 유닛은 조용히 안 터졌다.
 */
function collectBlasts(s: GameState, dead: Entity): Blast[] {
  if (dead.kind !== 'unit') return [];
  const out: Blast[] = [];
  for (const id of s.players[dead.team].relics) {
    const r = RELIC_BY_ID.get(id);
    if (r?.onDeath && r.unit === dead.unit) {
      out.push({ x: dead.x, y: dead.y, team: dead.team, damage: r.onDeath.damage, radius: r.onDeath.radius });
    }
  }
  return out;
}

interface Blast {
  x: number;
  y: number;
  team: Team;
  damage: number;
  radius: number;
}

/** 모은 폭발을 터뜨린다. 연쇄는 다음 정리로 넘긴다(무한 연쇄 방지) */
function detonate(s: GameState, blasts: readonly Blast[]): void {
  if (blasts.length === 0) return;
  for (const b of blasts) {
    const r2 = b.radius * b.radius;
    for (const o of s.entities) {
      if (o.team === b.team || o.kind === 'base') continue;
      if (dist2(o.x, o.y, b.x, b.y) <= r2) o.hp -= b.damage;
    }
  }
  s.entities = s.entities.filter((e) => e.hp > 0 || e.kind === 'base');
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
  const blasts: Blast[] = [];
  for (const e of s.entities) {
    if (e.hp <= 0 && e.kind !== 'base') blasts.push(...collectBlasts(s, e));
  }
  s.entities = s.entities.filter((e) => e.hp > 0 || e.kind === 'base');
  detonate(s, blasts);
}

/** 사망 처리 + 본진 파괴 판정 */
function resolveDeaths(s: GameState): void {
  const survivors: Entity[] = [];
  let changed = false;
  // 죽을 때 터지는 특성 — 시체가 남긴 폭발은 **이번 정리 중 확정된 것만**
  // 대상으로 한다(연쇄가 무한히 이어지지 않게 다음 틱으로 넘긴다)
  const blasts: Blast[] = [];
  for (const e of s.entities) {
    if (e.hp > 0) {
      survivors.push(e);
      continue;
    }
    blasts.push(...collectBlasts(s, e));
    changed = true;
    if (e.kind === 'base' && e.isMain && !s.sandbox) {
      // 침공 모드: 침공자(팀1) 본진은 파괴돼도 파도가 계속 온다 — 끝은
      // 오직 내 본진 함락. (원정 격파는 3단계 런 체인의 보스전 몫)
      if (s.invasion && e.team === 1) continue;
      s.over = true;
      s.winner = e.team === 0 ? 1 : 0;
    }
  }
  if (changed) s.entities = survivors;
  detonate(s, blasts);
}

function checkEnd(s: GameState): void {
  if (s.over || s.sandbox || s.invasion) return;

  const limit = s.overtime ? MATCH_TICKS + OVERTIME_TICKS : MATCH_TICKS;
  if (s.tick < limit) return;

  // 정규 시간 종료 — 기지 수가 다르면 그걸로 끝, 같으면 연장전
  const b0 = baseCount(s, 0);
  const b1 = baseCount(s, 1);
  if (b0 !== b1) {
    s.over = true;
    s.winner = b0 > b1 ? 0 : 1;
    return;
  }
  if (!s.overtime) {
    s.overtime = true;
    return;
  }

  // 연장 종료 — 남은 기지 총 HP로 가린다. "누가 더 때렸는가"를 그대로 반영하고
  // 조작이 불가능하다. 채굴량 비교는 그다음이다 — 확장 없는 장기전은 양쪽 다
  // 매장량을 정확히 다 캐서 채굴량이 같아지므로(REVIEW.md P0-2) 단독으로는
  // 기계적 무승부를 낳는다.
  const hp0 = baseHpTotal(s, 0);
  const hp1 = baseHpTotal(s, 1);
  if (hp0 !== hp1) {
    s.over = true;
    s.winner = hp0 > hp1 ? 0 : 1;
    return;
  }
  const m0 = s.players[0].mined;
  const m1 = s.players[1].mined;
  if (m0 !== m1) {
    s.over = true;
    s.winner = m0 > m1 ? 0 : 1;
    return;
  }
  s.over = true;
  s.winner = -1;
}

/** 팀의 남은 기지 HP 합 (건설 중 포함 — 이미 지불한 자산이다) */
export function baseHpTotal(s: GameState, team: Team): number {
  let sum = 0;
  for (const e of s.entities) {
    if (e.kind === 'base' && e.team === team) sum += e.hp;
  }
  return sum;
}

/* ── 스냅샷 / 해시 ─────────────────────────────────────────────────────── */

export function snapshot(s: GameState): GameState {
  return JSON.parse(JSON.stringify(s)) as GameState;
}

export function restore(target: GameState, snap: GameState): void {
  const fresh = JSON.parse(JSON.stringify(snap)) as GameState;
  target.mapId = fresh.mapId;
  target.tick = fresh.tick;
  target.rng = fresh.rng;
  target.nextId = fresh.nextId;
  target.entities = fresh.entities;
  target.players = fresh.players;
  target.overtime = fresh.overtime;
  target.over = fresh.over;
  target.winner = fresh.winner;
  target.sandbox = fresh.sandbox;
  target.invasion = fresh.invasion;
  target.wave = fresh.wave;
  target.nextWaveTick = fresh.nextWaveTick;
  target.waveBudget = fresh.waveBudget;
  target.waveAlive = fresh.waveAlive;
  target.waveReward = fresh.waveReward;
  target.draft = fresh.draft;
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

  mixStr(s.mapId);
  mix(s.sandbox ? 1 : 0);
  mix(s.invasion ? 1 : 0);
  mix(s.wave);
  mix(s.nextWaveTick);
  mix(s.waveBudget);
  mix(s.waveAlive ? 1 : 0);
  mix(s.waveReward);
  mix(s.draft.length);
  for (const d of s.draft) mixStr(d);
  mix(s.heroDraft.length);
  for (const d of s.heroDraft) mixStr(d);
  mix(s.stage);
  mix(s.nestAlive ? 1 : 0);
  mix(s.tick);
  mix(s.rng.s);
  mix(s.nextId);
  mix(s.entities.length);
  for (const e of s.entities) {
    mix(e.id);
    mix(e.team);
    mix(e.charge);
    mix(e.mode);
    mix(e.haste);
    mix(e.orderX);
    mix(e.orderY);
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
    mix(p.relics.length);
    for (const r of p.relics) mixStr(r);
    mix(p.wallCharges);
    mixStr(p.hero);
    mix(p.heroLevel);
    mix(p.heroRespawn);
    mix(p.rally ? p.rally.x : -1);
    mix(p.rally ? p.rally.y : -1);
    if (p.research) {
      mixStr(p.research.unit);
      mix(p.research.ticks);
    } else {
      mix(-1);
    }
    mix(p.upgrade);
    mix(p.upgrading ? p.upgrading.ticks : -1);
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
