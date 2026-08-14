/**
 * 클라이언트 엔트리.
 *
 * 구조:
 *   NetClient  — 서버 통신 + 로컬 결정론 시뮬 구동
 *   Renderer   — Pixi로 아레나/엔티티 그리기 (상태를 읽기만 한다)
 *   여기(main) — 입력 처리, HTML HUD 갱신, 프레임 루프
 */

import {
  siteReachable,
  BASE_BUILD_COST,
  DEFAULT_FACTION_ID,
  DEFAULT_MAP_ID,
  FACTION_IDS,
  MAPS,
  GameState,
  MATCH_TICKS,
  MINERAL_MAX,
  MINERAL_SCALE,
  OVERTIME_TICKS,
  TICK_RATE,
  WORKER_COST,
  WORKER_MINE_PER_TICK,
  UPGRADE_COSTS,
  UPGRADE_DAMAGE_PCT,
  UPGRADE_MAX,
  activeWorkers,
  baseCount,
  canDeployAt,
  canResearch,
  canUpgrade,
  getFaction,
  getUnit,
  isUnlocked,
  nearestFreeSite,
  occupiedSites,
  ownBasePositions,
  workerCapacity,
} from '@royale/shared';

import { art } from './art.js';
import { NetClient } from './net.js';
import { sound } from './sound.js';
import { Renderer, VIEW_H, VIEW_W } from './render.js';
import { ReplayStatus, ReplayView, fetchReplay, fetchReplayList } from './replayview.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 없음`);
  return el as T;
};

const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

/* ── 서버 주소 ─────────────────────────────────────────────────────────── */

function serverUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // vite dev(5173)에서는 별도 서버(8787), 배포에서는 페이지를 내준 서버가
  // 곧 게임 서버다 (라운드 12 — 단일 서비스 배포)
  if (import.meta.env.DEV) return `${proto}//${location.hostname}:8787`;
  return `${proto}//${location.host}`;
}

function withSolo(url: string): string {
  const solo = new URLSearchParams(location.search).get('solo');
  if (!solo) return url;
  return url + (url.includes('?') ? '&' : '?') + 'solo=1';
}

/* ── 상태 ──────────────────────────────────────────────────────────────── */

const renderer = new Renderer();
let selectedFaction = new URLSearchParams(location.search).get('faction') ?? DEFAULT_FACTION_ID;
/** 선택된 유닛 id. 없으면 '' */
let selectedUnit = '';
/** 기지 건설 모드 */
let baseMode = false;
let cursor: [number, number] | null = null;
const prevPos = new Map<number, [number, number]>();
let lastFrameMs = performance.now();

const net = new NetClient(serverUrl(), {
  onQueued: () => setStatus('상대를 찾는 중…'),
  onMatch: (_team, opponent) => {
    setStatus('');
    $('overlay').classList.add('hidden');
    $('opponent').textContent = `vs ${opponent}`;
    buildPalette();
    startOnboarding();
  },
  onOver: (winner, bases, mined, replayId) => {
    stopOnboarding();
    const me = net.myTeam;
    const foe = me === 0 ? 1 : 0;
    const text = winner === -1 ? '무승부' : winner === me ? '승리!' : '패배';
    sound.play(winner === -1 ? 'draw' : winner === me ? 'win' : 'lose');
    showOverlay(
      text,
      `기지 ${bases[me]} : ${bases[foe]}\n` +
        `총 채굴 ${Math.floor(mined[me] / MINERAL_SCALE)} : ${Math.floor(mined[foe] / MINERAL_SCALE)}`,
    );
    showOverActions(replayId);
  },
  onOpponentLeft: () => {
    stopOnboarding();
    showOverlay('상대가 나갔습니다', '');
    showOverActions();
  },
  onRoomState: (st) => renderRoom(st),
  onRoomError: (reason) => {
    setStatus(roomErrorText(reason));
    lockLobby(false);
  },
  onReject: (reason) => {
    sound.play('error');
    flash(rejectText(reason));
  },
  onBeforeStep: (s) => {
    prevPos.clear();
    for (const e of s.entities) prevPos.set(e.id, [e.x, e.y]);
  },
});

function rejectText(reason: string): string {
  switch (reason) {
    case 'no-minerals':
      return '미네랄 부족';
    case 'bad-zone':
      return '내 기지 반경 밖입니다';
    case 'locked':
      return '아직 해금되지 않은 유닛';
    case 'no-site':
      return '기지를 세울 자리가 없습니다';
    case 'not-playing':
      return '경기 중이 아님';
    default:
      return '요청 거부됨';
  }
}

/* ── 초기화 ────────────────────────────────────────────────────────────── */

async function boot(): Promise<void> {
  await renderer.init($('arena'));
  buildPalette();
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  // 이미지를 먼저 불러온다. 경기 중에 뒤늦게 도착하면 같은 유닛이 도형이었다가
  // 그림으로 바뀌는 게 눈에 보인다. 이미지가 한 장도 없어도 정상 진행된다.
  const startBtn = $('start') as HTMLButtonElement;
  startBtn.disabled = true;
  setStatus('에셋 불러오는 중…');
  await art.load();
  startBtn.disabled = false;
  setStatus(art.any ? `이미지 ${art.count}장 적용됨` : '');

  const replayId = new URLSearchParams(location.search).get('replay');
  if (replayId) {
    await bootReplay(replayId);
    return;
  }

  // 브라우저 자동재생 정책 — 소리는 첫 입력 이후에만 낼 수 있다
  window.addEventListener('pointerdown', () => sound.unlock());
  window.addEventListener('keydown', () => sound.unlock());
  renderer.onFx = (kind, faction, sx) =>
    sound.play(
      kind === 'death' ? 'death' : (`impact_${faction}` as Parameters<typeof sound.play>[0]),
      (sx / VIEW_W) * 2 - 1,
    );

  const canvas = renderer.canvas;
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', () => {
    cursor = null;
  });
  canvas.addEventListener('pointerdown', onPointerDown);

  buildFactionPicker();
  buildMapPicker();
  wireLevelPicker();

  // 봇전 — 설정 화면(종족·맵)을 거쳐 시작한다 (라운드 11.5)
  $('start').addEventListener('click', () => showSetup('solo'));
  $('btn-solo-start').addEventListener('click', () => {
    net.connect(playerName(), selectedFaction, selectedMap, { solo: true, botLevel: selectedLevel });
    setStatus('접속 중…');
    ($('btn-solo-start') as HTMLButtonElement).disabled = true;
  });

  // 방 만들기 → 코드 공유 → 상대 준비 → 방장 시작 (라운드 11 ③)
  $('btn-create').addEventListener('click', () => {
    net.connect(playerName(), selectedFaction, selectedMap, {
      onOpen: () => net.createRoom(),
    });
    setStatus('방 만드는 중…');
    lockLobby(true);
  });

  $('btn-join').addEventListener('click', () => {
    const code = ($('join-code') as HTMLInputElement).value.trim().toUpperCase();
    if (code.length !== 4) {
      setStatus('4글자 방 코드를 입력하세요');
      return;
    }
    net.connect(playerName(), selectedFaction, selectedMap, {
      onOpen: () => net.joinRoom(code),
    });
    setStatus('참가 중…');
    lockLobby(true);
  });

  $('btn-ready').addEventListener('click', () => {
    myReady = !myReady;
    net.setReady(myReady);
    const b = $('btn-ready');
    b.classList.toggle('on', myReady);
    b.textContent = myReady ? '준비 완료 ✓ (누르면 취소)' : '준비';
  });

  $('btn-start-room').addEventListener('click', () => net.startRoom());

  $('btn-base').addEventListener('click', toggleBaseMode);
  $('btn-upgrade').addEventListener('click', requestUpgrade);
  attachTipHtml(
    $('btn-upgrade'),
    () =>
      `<div class="tt-name">전군 공격 강화</div>` +
      `<div class="tt-row">유닛·방어 건물 공격 +${UPGRADE_DAMAGE_PCT}%/단계 (기지 제외)</div>` +
      `<div class="tt-row">2단계는 1단계 연구 후 · 3단계는 2단계 연구 후</div>` +
      `<div class="tt-row">고정 데미지라 강화가 "몇 방에 죽나"의 문턱을 넘긴다</div>`,
  );

  const muteBtn = $('btn-mute');
  const drawMute = (): void => {
    muteBtn.textContent = sound.muted ? '🔇' : '🔊';
    muteBtn.title = sound.muted ? '소리 켜기 (M)' : '소리 끄기 (M)';
  };
  drawMute();
  muteBtn.addEventListener('click', () => {
    sound.toggleMute();
    drawMute();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'm' || e.key === 'ㅡ') {
      sound.toggleMute();
      drawMute();
    }
    if (e.key === 'b' || e.key === 'ㅠ') toggleBaseMode();
    if (e.key === 'w' || e.key === 'ㅈ') requestWorker();
    if (e.key === 'u' || e.key === 'ㅕ') requestUpgrade();
    if (e.key === 'Escape') {
      selectedUnit = '';
      baseMode = false;
      refreshActionButtons();
    }
    // 숫자 = 생산 선택, Shift+숫자 = 그 칸 연구 시작 (라운드 9 피드백 #4).
    // Shift+숫자는 e.key가 '!','@' 등으로 변하므로 e.code로 읽는다
    const digit = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : Number(e.key);
    if (digit >= 1 && digit <= 8) {
      if (e.shiftKey) {
        const entry = paletteEls[digit - 1];
        if (entry) requestTech(entry.unit);
      } else {
        selectUnitByIndex(digit - 1);
      }
    }
  });

  requestAnimationFrame(frame);
}

function playerName(): string {
  return ($('name') as HTMLInputElement).value.trim() || '플레이어';
}

/** 로비 입력 잠금 — 접속이 시작되면 중복 클릭을 막는다 */
function lockLobby(lock: boolean): void {
  for (const id of ['start', 'btn-create', 'btn-join']) {
    ($(id) as HTMLButtonElement).disabled = lock;
  }
}

let myReady = false;

function roomErrorText(reason: string): string {
  switch (reason) {
    case 'no-room': return '그 코드의 방이 없습니다';
    case 'full': return '방이 가득 찼습니다';
    case 'not-ready': return '상대가 아직 준비하지 않았습니다';
    case 'not-host': return '방장만 시작할 수 있습니다';
    case 'already-in-room': return '이미 방에 있습니다';
    default: return '방 오류';
  }
}

/** 2단 화면 전환 — 'solo'는 방 패널 없이 종족·맵·시작만 보인다 */
function showSetup(mode: 'solo' | 'room'): void {
  $('entry').classList.add('hidden');
  $('setup').classList.remove('hidden');
  $('room-panel').classList.toggle('hidden', mode === 'solo');
  $('btn-solo-start').classList.toggle('hidden', mode !== 'solo');
  if (mode === 'solo') {
    $('btn-ready').classList.add('hidden');
    $('btn-start-room').classList.add('hidden');
    $('map-picker').classList.remove('hidden');
    $('room-map').classList.add('hidden');
  }
  // 봇 난이도는 솔로에서만 의미가 있다 — 방에는 봇이 없다
  $('lobby-label-level').classList.toggle('hidden', mode !== 'solo');
  $('level-picker').classList.toggle('hidden', mode !== 'solo');
  setStatus('');
}

/** 방 상태를 로비에 그린다 — 코드·맵·참가자·준비 상태 */
function renderRoom(st: { code: string; host: boolean; mapId: string;
  players: { name: string; factionId: string; ready: boolean; host: boolean }[] }): void {
  showSetup('room');
  $('room-code').textContent = st.code;
  const map = MAPS.find((m) => m.id === st.mapId);
  // 맵은 방장이 고른다 — 손님에게는 선택 결과만 보인다
  $('map-picker').classList.toggle('hidden', !st.host);
  const rm = $('room-map');
  rm.classList.toggle('hidden', st.host);
  rm.textContent = `맵: ${map?.name ?? st.mapId} (방장 선택)`;
  if (!st.host && MAPS.some((m) => m.id === st.mapId)) {
    selectedMap = st.mapId;
    refreshMapPicker();
  }

  const list = $('room-players');
  list.replaceChildren();
  for (const p of st.players) {
    const row = document.createElement('div');
    row.className = 'room-p' + (p.ready ? ' ready' : '');
    const f = getFaction(p.factionId);
    row.innerHTML = `<span></span><span class="rp-state"></span>`;
    row.querySelector('span')!.textContent = `${p.host ? '👑 ' : ''}${p.name} (${f.name})`;
    row.querySelector<HTMLElement>('.rp-state')!.textContent =
      p.host ? '방장' : p.ready ? '준비 완료' : '대기 중';
    list.appendChild(row);
  }
  if (st.players.length < 2) {
    const row = document.createElement('div');
    row.className = 'room-p';
    row.innerHTML = `<span>상대를 기다리는 중…</span><span class="rp-state">코드를 공유하세요</span>`;
    list.appendChild(row);
  }

  const readyBtn = $('btn-ready') as HTMLButtonElement;
  const startBtn = $('btn-start-room') as HTMLButtonElement;
  readyBtn.classList.toggle('hidden', st.host);
  startBtn.classList.toggle('hidden', !st.host);
  const guestReady = st.players.some((p) => !p.host && p.ready);
  startBtn.disabled = !guestReady;
  startBtn.textContent = guestReady ? '경기 시작' : '상대의 준비를 기다리는 중…';
}

/** 캔버스를 남는 높이에 맞춘다 (패널 높이를 실측한다) */
function fitCanvas(): void {
  const host = $('arena');
  // 사이드바 폭은 CSS가 정한다(--sidebar-w). 0이면 세로 스택(모바일) 배치다.
  const sidebar =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 0;
  const wide = sidebar > 0;

  const reserved = wide
    ? $('topbar').offsetHeight + 16
    : $('topbar').offsetHeight + $('bottom').offsetHeight + 16;
  const availH = Math.max(200, window.innerHeight - reserved);
  // 좁은 화면에서는 520px로 묶어 두지만, 넓은 화면에서는 남는 가로를 다 쓴다
  const availW = wide
    ? Math.max(200, window.innerWidth - sidebar - 24)
    : Math.min(window.innerWidth - 24, 520);
  const scale = Math.min(availW / VIEW_W, availH / VIEW_H);
  host.style.width = `${VIEW_W * scale}px`;
  host.style.height = `${VIEW_H * scale}px`;
  renderer.canvas.style.width = `${VIEW_W * scale}px`;
  renderer.canvas.style.height = `${VIEW_H * scale}px`;
}

/* ── 종족 선택 ─────────────────────────────────────────────────────────── */

let selectedMap =
  new URLSearchParams(location.search).get('map') ?? DEFAULT_MAP_ID;

/** 맵 선택 — 종족 픽커와 같은 문법의 카드 줄 */
/** 솔로 봇 난이도 — 픽커에서 고르고 hello로 보낸다 */
let selectedLevel = 'normal';

function wireLevelPicker(): void {
  const root = document.getElementById('level-picker');
  if (!root) return;
  root.querySelectorAll<HTMLButtonElement>('.lvl').forEach((b) => {
    b.addEventListener('click', () => {
      selectedLevel = b.dataset.level ?? 'normal';
      root.querySelectorAll('.lvl').forEach((x) => x.classList.toggle('selected', x === b));
    });
  });
}

function buildMapPicker(): void {
  const root = document.getElementById('map-picker');
  if (!root) return;
  root.replaceChildren();
  for (const m of MAPS) {
    const el = document.createElement('button');
    el.className = 'faction mappick';
    el.innerHTML =
      `<span class="mthumb"></span><span class="mtext">` +
      `<span class="fname"></span><span class="ftag"></span></span>`;
    el.querySelector<HTMLElement>('.mthumb')!.style.backgroundImage =
      `url('${import.meta.env.BASE_URL}art/maps/${m.id}.png')`;
    el.querySelector<HTMLElement>('.fname')!.textContent = m.name;
    el.querySelector<HTMLElement>('.ftag')!.textContent = m.tagline;
    el.addEventListener('click', () => {
      selectedMap = m.id;
      refreshMapPicker();
      net.setLoadout({ mapId: m.id }); // 방장의 선택이 방 전체에 퍼진다
    });
    root.appendChild(el);
  }
  refreshMapPicker();
}

function refreshMapPicker(): void {
  const root = document.getElementById('map-picker');
  if (!root) return;
  const buttons = root.children;
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle('selected', MAPS[i].id === selectedMap);
  }
}

function buildFactionPicker(): void {
  const root = $('faction-picker');
  root.replaceChildren();

  // 종족의 얼굴 — 시작 유닛의 초상을 카드 오른쪽에 얹는다 (인게임 아트 재사용)
  const FACTION_FACE: Record<string, string> = {
    steel: 'rifleman',
    swarmhive: 'gnawer',
    covenant: 'zealot',
  };
  for (const id of FACTION_IDS) {
    const f = getFaction(id);
    const el = document.createElement('button');
    el.className = 'faction';
    el.style.setProperty('--f-color', hex(f.color));
    el.innerHTML =
      `<span class="fface"></span>` +
      `<span class="fname"></span><span class="ftag"></span>`;
    const face = el.querySelector<HTMLElement>('.fface')!;
    const unit = FACTION_FACE[id];
    if (unit) {
      // 5프레임 스트립의 0번 프레임만 확대해 보여주는 배경 트릭 (nodeIcon과 동일)
      const w = 64 * 2.1;
      face.style.backgroundImage =
        `url('${import.meta.env.BASE_URL}art/units/${unit}.walk.png')`;
      face.style.backgroundSize = `${w * 5}px ${w}px`;
      face.style.backgroundPosition = `${(64 - w) / 2}px ${(64 - w) * 0.25}px`;
    }
    el.querySelector<HTMLElement>('.fname')!.textContent = f.name;
    el.querySelector<HTMLElement>('.ftag')!.textContent = f.tagline;
    el.addEventListener('click', () => {
      selectedFaction = id;
      refreshFactionPicker();
      net.setLoadout({ factionId: id }); // 방에 있으면 상대에게도 보인다
    });
    root.appendChild(el);
  }
  refreshFactionPicker();
}

function refreshFactionPicker(): void {
  const buttons = $('faction-picker').children;
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle('selected', FACTION_IDS[i] === selectedFaction);
  }

  // 시작 해금은 초록 테두리로 구분한다 — 무엇으로 시작하는지가 가장 중요한 정보다
  const detail = $('faction-detail');
  detail.replaceChildren();
  for (const node of getFaction(selectedFaction).tech) {
    const u = getUnit(node.unit);
    const chip = document.createElement('span');
    chip.className = node.cost === 0 ? 'chip start' : 'chip';
    chip.style.setProperty('--chip-color', hex(u.color));
    chip.textContent = u.name + (u.flying ? ' ✈' : '');
    const cost = document.createElement('span');
    cost.className = 'cc';
    cost.textContent = node.cost === 0 ? '시작' : `T${node.tier}`;
    chip.appendChild(cost);
    detail.appendChild(chip);
  }
}

/* ── 유닛 팔레트 / 테크 패널 ───────────────────────────────────────────── */

let paletteEls: { el: HTMLElement; unit: string }[] = [];
/** 트리 '시작' 열의 일꾼 카드 — 유닛 노드와 같은 얼굴, 다른 명령 */
let workerNode: HTMLElement | null = null;

function factionOfMe(): ReturnType<typeof getFaction> {
  const s = net.state;
  return getFaction(s ? s.players[net.myTeam].faction : selectedFaction);
}

/**
 * 통합 테크트리 — 연구와 생산이 한 판이다.
 *
 * 열 = 단계(시작/1단계/2단계), 노드 = 유닛 초상 카드. 해금된 노드를 누르면
 * 생산 선택, 잠긴 노드를 누르면 연구다. 선행 관계는 연결선으로 그린다.
 * 글자 대신 그림으로 고르게 하는 것이 목적이므로 초상이 카드의 주인공이다.
 */
const ICON_ZOOM = 1.5; // 프레임 0을 확대해 몸통·얼굴이 카드를 채우게
const ICON_PX = 46;

function nodeIcon(el: HTMLElement, unitId: string): void {
  const u = getUnit(unitId);
  const icon = el.querySelector<HTMLElement>('.nicon')!;
  // 주문은 걷는 몸이 없다 — 전용 아이콘 한 장(units/<id>.icon.png)을 쓴다
  if (art.clip(unitId, 'icon')) {
    icon.textContent = '';
    icon.style.backgroundImage =
      `url('${import.meta.env.BASE_URL}art/units/${unitId}.icon.png')`;
    icon.style.backgroundSize = `${ICON_PX}px ${ICON_PX}px`;
    icon.style.backgroundPosition = '0 0';
    return;
  }
  const anim = u.kind === 'building' ? 'idle' : 'walk';
  if (!art.clip(unitId, anim) && !art.clip(unitId, 'attack')) {
    icon.textContent = u.name[0]; // 이미지가 없으면 첫 글자
    return;
  }
  const used = art.clip(unitId, anim) ? anim : 'attack';
  const w = ICON_PX * ICON_ZOOM;
  icon.style.backgroundImage =
    `url('${import.meta.env.BASE_URL}art/units/${unitId}.${used}.png')`;
  // 스트립 5프레임 중 0번만, 위쪽(얼굴)에 살짝 치우쳐 확대
  icon.style.backgroundSize = `${w * 5}px ${w}px`;
  icon.style.backgroundPosition = `${(ICON_PX - w) / 2}px ${(ICON_PX - w) * 0.3}px`;
}

function buildPalette(): void {
  const root = $('palette');
  root.replaceChildren();
  paletteEls = [];

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'tree-links';
  root.appendChild(svg);

  const cols = new Map<number, HTMLElement>();
  for (const [tier, label] of [[0, '시작'], [1, '1단계'], [2, '2단계']] as const) {
    const col = document.createElement('div');
    col.className = 'tcol';
    col.innerHTML = `<div class="tcol-head">${label}</div>`;
    cols.set(tier, col);
    root.appendChild(col);
  }

  // 일꾼 카드 — 별도 버튼은 "일꾼도 생산의 한 수"라는 사실을 가렸다
  // (라운드 9 피드백: 일꾼 생산을 유닛으로 합병). 트리의 첫 칸에 앉힌다
  const wEl = document.createElement('button');
  wEl.className = 'tnode worker-node';
  wEl.innerHTML =
    `<span class="ukey">W</span><span class="nlock"></span>` +
    `<span class="nicon"></span><span class="nname">일꾼</span>` +
    `<span class="ncost"></span><span class="nprog"><i></i></span>`;
  const wicon = wEl.querySelector<HTMLElement>('.nicon')!;
  const ww = ICON_PX * ICON_ZOOM;
  wicon.style.backgroundImage = `url('${import.meta.env.BASE_URL}art/worker.png')`;
  wicon.style.backgroundSize = `${ww * 5}px ${ww}px`;
  wicon.style.backgroundPosition = `${(ICON_PX - ww) / 2}px ${(ICON_PX - ww) * 0.3}px`;
  wEl.querySelector<HTMLElement>('.ncost')!.textContent = String(WORKER_COST / MINERAL_SCALE);
  wEl.addEventListener('click', requestWorker);
  attachTipHtml(
    wEl,
    () =>
      `<div class="tt-name">일꾼 <span class="tt-cost">${WORKER_COST / MINERAL_SCALE}</span></div>` +
      `<div class="tt-row">초당 0.12 채굴 — 수입의 전부</div>` +
      `<div class="tt-row">정원 = 기지당 8 · 정원이 차면 확장할 때</div>`,
  );
  workerNode = wEl;
  cols.get(0)!.appendChild(wEl);

  // 읽는 법 한 줄 — "잠긴 유닛은 어떻게 뽑나"라는 질문이 나오지 않게
  const legend = document.createElement('div');
  legend.id = 'tree-legend';
  legend.innerHTML =
    '🔒 잠김 카드는 클릭(또는 <kbd>Shift</kbd>+숫자)하면 연구 시작 — ' +
    '연구가 끝나면 바로 생산할 수 있고, 선행 유닛을 뽑을 필요는 없습니다';
  root.appendChild(legend);

  let key = 0;
  for (const node of factionOfMe().tech) {
    const u = getUnit(node.unit);
    const el = document.createElement('button');
    el.className = 'tnode';
    el.dataset.unit = node.unit;
    el.style.setProperty('--unit-color', hex(u.color));
    el.innerHTML =
      `<span class="ukey"></span><span class="nlock"></span>` +
      `<span class="nicon"></span><span class="nname"></span>` +
      `<span class="ncost"></span><span class="nprog"><i></i></span>`;
    el.querySelector<HTMLElement>('.nname')!.innerHTML = u.name + (u.flying ? ' ✈' : '');
    nodeIcon(el, node.unit);
    key++;
    el.querySelector<HTMLElement>('.ukey')!.textContent = key <= 8 ? String(key) : '';
    el.addEventListener('click', () => {
      const st = net.state;
      const me = st ? st.players[net.myTeam] : null;
      if (me && isUnlocked(me, node.unit)) selectUnit(node.unit);
      else requestTech(node.unit);
    });
    attachTip(el, node.unit);
    (cols.get(node.tier) ?? cols.get(2))!.appendChild(el);
    paletteEls.push({ el, unit: node.unit });
  }

  // 선행 관계 연결선 — 카드 배치가 끝난 뒤 좌표를 실측해 그린다
  requestAnimationFrame(() => drawTreeLinks(root, svg));
  window.addEventListener('resize', () => drawTreeLinks(root, svg));
}

function drawTreeLinks(root: HTMLElement, svg: SVGSVGElement): void {
  const base = root.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
  svg.replaceChildren();
  for (const node of factionOfMe().tech) {
    if (!node.requires) continue;
    const from = root.querySelector<HTMLElement>(`[data-unit="${node.requires}"]`);
    const to = root.querySelector<HTMLElement>(`[data-unit="${node.unit}"]`);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x1 = a.right - base.left;
    const y1 = a.top + a.height / 2 - base.top;
    const x2 = b.left - base.left;
    const y2 = b.top + b.height / 2 - base.top;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const mx = (x1 + x2) / 2;
    path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#334155');
    path.setAttribute('stroke-width', '2');
    svg.appendChild(path);
  }
}

function selectUnit(unit: string): void {
  sound.play('ui');
  baseMode = false;
  selectedUnit = selectedUnit === unit ? '' : unit;
  refreshActionButtons();
}

function selectUnitByIndex(i: number): void {
  const entry = paletteEls[i];
  if (entry) selectUnit(entry.unit);
}

/** 일꾼 생산 — 정원이 차 있으면 확장하라는 뜻이므로 그렇게 알린다 */
function requestWorker(): void {
  const s = net.state;
  if (!s) return;
  const me = s.players[net.myTeam];
  if (me.workers >= workerCapacity(s, net.myTeam)) {
    flash('일꾼 정원이 찼습니다 — 확장하세요');
    return;
  }
  if (me.minerals < WORKER_COST) {
    flash('미네랄 부족');
    return;
  }
  net.act('worker', '');
  sound.play('ui');
}

/** 전군 공격 강화 — 막힌 이유를 그대로 말해준다 */
function requestUpgrade(): void {
  const s = net.state;
  if (!s) return;
  const me = s.players[net.myTeam];
  if (me.upgrading) {
    flash('이미 강화 중입니다');
    return;
  }
  if (me.upgrade >= UPGRADE_MAX) {
    flash('강화가 최대 단계입니다');
    return;
  }
  if (!canUpgrade(me)) {
    flash(`${me.upgrade}단계 연구를 하나 마쳐야 ${me.upgrade + 1}단계 강화가 열립니다`);
    return;
  }
  if (me.minerals < UPGRADE_COSTS[me.upgrade]) {
    flash('미네랄 부족');
    return;
  }
  net.act('upgrade', '');
  sound.play('tech');
}

function toggleBaseMode(): void {
  baseMode = !baseMode;
  if (baseMode) selectedUnit = '';
  refreshActionButtons();
}

function refreshActionButtons(): void {
  $('btn-base').classList.toggle('active', baseMode);
}

function requestTech(unit: string): void {
  const s = net.state;
  if (!s) return;
  const me = s.players[net.myTeam];
  if (isUnlocked(me, unit)) return;
  if (!canResearch(me, unit)) {
    flash(me.research ? '이미 연구 중입니다' : '선행 연구가 필요합니다');
    return;
  }
  const node = factionOfMe().tech.find((n) => n.unit === unit);
  if (node && me.minerals < node.cost * MINERAL_SCALE) {
    flash('미네랄 부족');
    return;
  }
  net.act('tech', unit);
  sound.play('tech');
}

/* ── 유닛 툴팁 ─────────────────────────────────────────────────────────── */

/**
 * 유닛 스탯 툴팁 — 게임 안 어디에도 스탯이 없던 문제(REVIEW P1)의 답.
 *
 * 특히 "정찰차는 유닛을 못 때린다" 같은 대상 제한은 화면에서 알아낼 방법이
 * 없었다. 팔레트와 테크 패널 양쪽에서 같은 툴팁을 쓴다.
 */
function unitTipHtml(id: string): string {
  const u = getUnit(id);
  const rows: string[] = [];
  const tile = (mt: number) => (mt / 1000).toFixed(1).replace(/\.0$/, '');

  if (u.kind === 'spell') {
    rows.push(`즉발 광역 — 반경 ${tile(u.splash)}타일에 ${u.damage} 피해`);
    rows.push(`<span class="tt-warn">기지에는 피해 없음</span>`);
  } else {
    rows.push(
      `체력 ${u.hp}${u.count > 1 ? ` ×${u.count}` : ''}` +
        (u.speed > 0 ? ` · 속도 ${((u.speed * TICK_RATE) / 1000).toFixed(1)}` : ' · 고정'),
    );
    const per = (u.hitSpeed / TICK_RATE).toFixed(1);
    rows.push(
      `공격 ${u.damage}${u.count > 1 ? ` ×${u.count}` : ''} / ${per}초 · 사거리 ${tile(u.range)}`,
    );
    const target =
      u.targets === 'any' ? '지상+공중'
      : u.targets === 'ground' ? '지상만'
      : u.targets === 'air' ? '공중만'
      : '건물만 (유닛 무시)';
    rows.push(`대상 ${target}${u.splash > 0 ? ' · 광역' : ''}`);
    if (u.siege !== 100) {
      rows.push(
        u.siege > 100
          ? `<span class="tt-warn">건물 데미지 ${u.siege}% — 공성</span>`
          : `건물 데미지 ${u.siege}%`,
      );
    }
    if (u.kind === 'building' && u.lifetime > 0) {
      rows.push(`수명 ${Math.round(u.lifetime / TICK_RATE)}초`);
    }
  }

  // 해금 조건 — "선행 유닛을 뽑아야 하나?"라는 혼동(라운드 9 피드백)의 답:
  // 연구만 하면 된다. 선행 조건은 '연구 완료'지 '유닛 생산'이 아니다
  const st = net.state;
  const viewer = st ? st.players[net.myTeam] : null;
  const node = factionOfMe().tech.find((n) => n.unit === id);
  if (viewer && node && !isUnlocked(viewer, id)) {
    rows.push(
      node.requires
        ? `<span class="tt-warn">🔒 ${getUnit(node.requires).name} 연구 후 → 연구 ${node.cost}로 해금</span>`
        : `<span class="tt-warn">🔬 연구 ${node.cost}로 해금 (클릭 또는 Shift+숫자)</span>`,
    );
    rows.push('해금되면 바로 생산 — 선행 유닛을 뽑을 필요는 없다');
  }

  return (
    `<div class="tt-name">${u.name}${u.flying ? ' ✈' : ''} ` +
    `<span class="tt-cost">${u.cost}</span></div>` +
    rows.map((r) => `<div class="tt-row">${r}</div>`).join('')
  );
}

function attachTip(el: HTMLElement, unitId: string): void {
  attachTipHtml(el, () => unitTipHtml(unitId));
}

function attachTipHtml(el: HTMLElement, html: () => string): void {
  const tip = $('tooltip');
  const move = (ev: MouseEvent) => {
    const pad = 14;
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  el.addEventListener('mouseenter', (ev) => {
    tip.innerHTML = html();
    tip.classList.remove('hidden');
    move(ev as MouseEvent);
  });
  el.addEventListener('mousemove', move);
  el.addEventListener('mouseleave', () => tip.classList.add('hidden'));
}

/* ── 입력 ──────────────────────────────────────────────────────────────── */

function pointerToArena(ev: PointerEvent): [number, number] {
  const rect = renderer.canvas.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * VIEW_W;
  const py = ((ev.clientY - rect.top) / rect.height) * VIEW_H;
  return renderer.toArena(px, py, net.myTeam);
}

function onPointerMove(ev: PointerEvent): void {
  cursor = pointerToArena(ev);
}

function onPointerDown(ev: PointerEvent): void {
  const s = net.state;
  if (!s) return;
  const [x, y] = pointerToArena(ev);
  cursor = [x, y];

  if (baseMode) {
    const me = s.players[net.myTeam];
    if (me.minerals < BASE_BUILD_COST) {
      flash('미네랄 부족');
      return;
    }
    const site = nearestFreeSite(x, y, occupiedSites(s));
    if (!site) {
      flash('근처에 빈 기지 자리가 없습니다');
      return;
    }
    if (!siteReachable(s, net.myTeam, site)) {
      flash('확장은 내 영토에서 이어져야 합니다 (기지에서 11타일 안)');
      return;
    }
    net.act('base', '', x, y);
    sound.play('build');
    baseMode = false;
    refreshActionButtons();
    return;
  }

  if (!selectedUnit) return;
  const me = s.players[net.myTeam];
  if (!isUnlocked(me, selectedUnit)) {
    flash('해금되지 않은 유닛');
    return;
  }
  if (me.minerals < getUnit(selectedUnit).cost * MINERAL_SCALE) {
    flash('미네랄 부족');
    return;
  }
  // 주문은 전장 어디든 떨어진다 — 반경 검사는 유닛·건물에만
  if (getUnit(selectedUnit).kind !== 'spell' && !deployable(s, x, y)) {
    flash('내 기지 반경 안에만 배치할 수 있습니다');
    return;
  }
  net.act('unit', selectedUnit, x, y);
  sound.play('deploy');
  // 선택을 유지한다 — 물량전에서 매번 다시 고르게 하면 클릭이 2배가 된다.
  // 해제는 Esc 또는 카드 재클릭(토글).
}

function deployable(s: GameState, x: number, y: number): boolean {
  return canDeployAt(x, y, ownBasePositions(s, net.myTeam));
}

/* ── 프레임 루프 ───────────────────────────────────────────────────────── */

function frame(): void {
  const now = performance.now();
  renderer.advanceAnimations(now - lastFrameMs);
  lastFrameMs = now;

  net.update();

  const s = net.state;
  if (s) {
    const site = baseMode && cursor ? nearestFreeSite(cursor[0], cursor[1], occupiedSites(s)) : null;
    renderer.draw({
      state: s,
      myTeam: net.myTeam,
      prev: prevPos,
      alpha: net.alpha(),
      cursor: selectedUnit ? cursor : null,
      cursorValid: cursor ? deployable(s, cursor[0], cursor[1]) : false,
      pendingSite: site ? { x: site.x, y: site.y } : null,
      showDeployZone: Boolean(selectedUnit),
    });
    updateHud(s);
  }
  requestAnimationFrame(frame);
}

/* ── HUD ───────────────────────────────────────────────────────────────── */

function updateHud(s: GameState): void {
  const me = s.players[net.myTeam];
  const foe = net.myTeam === 0 ? 1 : 0;

  const minerals = me.minerals / MINERAL_SCALE;
  $('mineral-fill').style.width = `${(me.minerals / MINERAL_MAX) * 100}%`;
  $('mineral-num').textContent = `${Math.floor(minerals)} / ${MINERAL_MAX / MINERAL_SCALE}`;

  // 초당 수입 = 실제로 일하는 일꾼 수 × 일꾼당 채굴 × 틱레이트
  const working = activeWorkers(s, net.myTeam);
  const cap = workerCapacity(s, net.myTeam);
  const perSec = (working * WORKER_MINE_PER_TICK * TICK_RATE) / MINERAL_SCALE;
  $('income').textContent = `+${perSec.toFixed(2)}/s`;
  // 정원이 찼다는 것은 곧 확장 신호다 — 색으로 알린다
  $('workers').textContent = `⛏ ${me.workers}/${cap}`;
  $('workers').classList.toggle('full', cap > 0 && me.workers >= cap);

  $('score').textContent = `🏠 ${baseCount(s, net.myTeam)} : ${baseCount(s, foe)}`;

  const limit = s.overtime ? MATCH_TICKS + OVERTIME_TICKS : MATCH_TICKS;
  const left = Math.max(0, Math.ceil((limit - s.tick) / TICK_RATE));
  $('timer').textContent =
    `${s.overtime ? '연장 ' : ''}${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  // 통합 트리 — 해금 노드는 생산 카드, 잠긴 노드는 연구 카드로 갱신한다
  const f = factionOfMe();
  for (const { el, unit } of paletteEls) {
    const u = getUnit(unit);
    const node = f.tech.find((n) => n.unit === unit)!;
    const unlocked = isUnlocked(me, unit);
    const researching = me.research?.unit === unit;
    const researchable =
      !unlocked && !researching && canResearch(me, unit);

    el.classList.toggle('selected', selectedUnit === unit);
    el.classList.toggle(
      'unaffordable',
      unlocked && me.minerals < u.cost * MINERAL_SCALE,
    );
    el.classList.toggle('locked', !unlocked && !researching && !researchable);
    el.classList.toggle('researchable', researchable);
    el.classList.toggle('researching', researching);

    const lock = el.querySelector<HTMLElement>('.nlock')!;
    lock.textContent = unlocked || researching ? '' : researchable ? '🔬' : '🔒';

    const cost = el.querySelector<HTMLElement>('.ncost')!;
    // 잠긴 카드의 숫자는 생산비가 아니라 연구비다 — 🔬로 구분한다
    cost.textContent = unlocked ? String(u.cost) : `🔬${node.cost}`;

    if (researching && me.research) {
      const frac = 1 - me.research.ticks / node.researchTicks;
      el.querySelector<HTMLElement>('.nprog i')!.style.width =
        `${Math.round(frac * 100)}%`;
    }
  }

  // 일꾼 카드 (트리 '시작' 열)
  if (workerNode) {
    const full = cap > 0 && me.workers >= cap;
    workerNode.classList.toggle('unaffordable', me.minerals < WORKER_COST || full);
    workerNode.querySelector<HTMLElement>('.nname')!.textContent = full ? '정원 참' : '일꾼';
  }

  // 기지 건설 버튼
  const baseBtn = $('btn-base') as HTMLButtonElement;
  baseBtn.disabled = me.minerals < BASE_BUILD_COST;
  baseBtn.innerHTML = baseMode
    ? '자리를 클릭하세요'
    : `기지 건설 (${BASE_BUILD_COST / MINERAL_SCALE}) <kbd>B</kbd>`;

  // 강화 버튼 — 단계·비용·진행·잠금 사유를 버튼 하나가 다 말한다
  const upBtn = $('btn-upgrade') as HTMLButtonElement;
  upBtn.classList.toggle('working', !!me.upgrading);
  if (me.upgrading) {
    upBtn.disabled = true;
    upBtn.innerHTML = `⚔ 강화 중… ${Math.ceil(me.upgrading.ticks / TICK_RATE)}초`;
  } else if (me.upgrade >= UPGRADE_MAX) {
    upBtn.disabled = true;
    upBtn.innerHTML = `⚔ 강화 완료 Lv${UPGRADE_MAX}`;
  } else if (!canUpgrade(me)) {
    upBtn.disabled = true;
    upBtn.innerHTML = `⚔ 강화 Lv${me.upgrade + 1} 🔒 ${me.upgrade}단계 연구 필요`;
  } else {
    const c = UPGRADE_COSTS[me.upgrade] / MINERAL_SCALE;
    upBtn.disabled = me.minerals < UPGRADE_COSTS[me.upgrade];
    upBtn.innerHTML =
      `⚔ 강화 Lv${me.upgrade + 1} (${c}) <kbd>U</kbd>` +
      (me.upgrade > 0 ? ` <span class="uplv">현재 +${me.upgrade * UPGRADE_DAMAGE_PCT}%</span>` : '');
  }

  $('research').textContent = me.research
    ? `연구 중: ${getUnit(me.research.unit).name} ${Math.ceil(me.research.ticks / TICK_RATE)}초`
    : '';

  const st = net.stats();
  $('netinfo').textContent = `${st.rttMs}ms · tick ${st.simTick}/${st.leadTick} · desync ${st.desyncs}`;
  $('netinfo').classList.toggle('bad', st.desyncs > 0);
}


/* ── 리플레이 모드 ─────────────────────────────────────────────────────── */

let replayView: ReplayView | null = null;

async function bootReplay(id: string): Promise<void> {
  document.body.classList.add('replay');
  setStatus('리플레이 불러오는 중…');

  let replay;
  try {
    replay = await fetchReplay(withSolo(serverUrl()), id);
  } catch (err) {
    const list = await fetchReplayList(serverUrl()).catch(() => []);
    const hint = list.length
      ? `\n최근 리플레이: ${list.slice(0, 5).map((e) => e.id).join(', ')}`
      : '\n서버에 저장된 리플레이가 없습니다.';
    showOverlay('리플레이를 불러오지 못했습니다', `${String(err)}${hint}`);
    return;
  }

  $('overlay').classList.add('hidden');
  $('replay-bar').classList.remove('hidden');
  $('opponent').textContent = '리플레이';

  replayView = new ReplayView(replay, {
    onFrame: (state, viewTeam) => {
      renderer.draw({
        state,
        myTeam: viewTeam,
        // 리플레이는 틱 단위로 상태를 재구성하므로 보간 없이 그린다
        prev: prevPos,
        alpha: 1,
        cursor: null,
        cursorValid: false,
        pendingSite: null,
        showDeployZone: false,
      });
      $('score').textContent = `🏠 ${baseCount(state, viewTeam)} : ${baseCount(state, viewTeam === 0 ? 1 : 0)}`;
    },
    onStatus: renderReplayStatus,
  });

  const seek = $('rb-seek') as HTMLInputElement;
  seek.max = String(replayView.totalTicks);
  seek.addEventListener('input', () => replayView?.seek(Number(seek.value)));
  $('rb-play').addEventListener('click', () => replayView?.togglePlay());
  $('rb-speed').addEventListener('click', () => replayView?.cycleSpeed());
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      replayView?.togglePlay();
    }
  });

  fitCanvas();
  replayView.start();
}

function renderReplayStatus(s: ReplayStatus): void {
  $('rb-play').textContent = s.playing ? '❚❚' : '▶';
  $('rb-speed').textContent = `${s.speed}×`;
  $('rb-title').textContent = s.title;
  $('rb-time').textContent = s.timeText;
  const seek = $('rb-seek') as HTMLInputElement;
  if (document.activeElement !== seek) seek.value = String(s.tick);
  $('timer').textContent = s.timeText.split(' / ')[0];
}

/* ── 오버레이 / 토스트 ─────────────────────────────────────────────────── */

function setStatus(text: string): void {
  $('status').textContent = text;
}

function showOverlay(title: string, sub: string): void {
  $('overlay').classList.remove('hidden');
  $('overlay-title').textContent = title;
  $('status').textContent = sub;
  // 로비 안내문은 경기 결과 화면과 무관하다
  $('intro').style.display = 'none';
  $('faction-picker').style.display = 'none';
  $('faction-detail').style.display = 'none';
  ($('start') as HTMLButtonElement).style.display = 'none';
  ($('name') as HTMLInputElement).style.display = 'none';
}

/**
 * 종료 화면 액션 — 다시 하기 + 리플레이 보기.
 *
 * "다시 하기"는 새로고침이다. 세션·매치·리플레이 상태를 전부 처음부터 다시
 * 만드는 것이 부분 초기화를 유지보수하는 것보다 훨씬 안전하다. 종족 선택은
 * URL 쿼리에 실려 있어 그대로 살아남는다.
 */
function showOverActions(replayId?: string): void {
  const root = $('over-actions');
  root.replaceChildren();
  root.classList.remove('hidden');

  const again = document.createElement('button');
  again.id = 'btn-again';
  again.textContent = '다시 하기';
  again.addEventListener('click', () => {
    const url = new URL(location.href);
    url.searchParams.set('faction', selectedFaction);
    url.searchParams.delete('replay');
    location.href = url.toString();
  });
  root.appendChild(again);

  if (replayId) {
    const view = document.createElement('a');
    view.id = 'btn-replay';
    view.textContent = '리플레이 보기';
    const url = new URL(location.href);
    url.searchParams.set('replay', replayId);
    view.href = url.toString();
    root.appendChild(view);
  }
}

/* ── 첫 판 온보딩 ──────────────────────────────────────────────────────── */

const ONBOARD_KEY = 'royale-onboarded';
let onboardTimers: ReturnType<typeof setTimeout>[] = [];

/**
 * 처음 하는 사람에게만, 경기 초반에 힌트 4개를 순서대로 보여준다.
 *
 * 미네랄 정원·확장 강제 같은 구조는 화면만 봐서는 알 수 없는데, 이걸 모르면
 * 첫 판이 "왜 돈이 안 늘지?"로 끝난다. 한 번 본 사람에게는 다시 보여주지
 * 않는다 — 힌트는 두 번째부터는 소음이다.
 */
function startOnboarding(): void {
  if (localStorage.getItem(ONBOARD_KEY) === '1') return;
  const hints: Array<[number, string]> = [
    [2000, '1~8 키로 유닛을 고르고, 내 기지 반경(밝은 원) 안을 클릭해 배치합니다'],
    [12000, '기지가 미네랄을 캡니다 — 일꾼(W)을 뽑아 수입을 늘리세요'],
    [24000, '미네랄은 마릅니다 — 기지 건설(B)로 확장해야 전진할 수 있습니다'],
    [38000, '언덕 아래에서 위로 쏘면 데미지가 30% 깎입니다 — 고지를 차지하세요'],
  ];
  for (const [at, text] of hints) onboardTimers.push(setTimeout(() => hint(text), at));
  onboardTimers.push(
    setTimeout(() => localStorage.setItem(ONBOARD_KEY, '1'), hints[hints.length - 1][0]),
  );
}

function stopOnboarding(): void {
  for (const t of onboardTimers) clearTimeout(t);
  onboardTimers = [];
  $('hint').classList.remove('show');
}

let hintTimer: ReturnType<typeof setTimeout> | null = null;
function hint(text: string): void {
  const el = $('hint');
  el.textContent = text;
  el.classList.add('show');
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove('show'), 6500);
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;
function flash(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

boot().catch((err) => {
  console.error(err);
  setStatus(`초기화 실패: ${String(err)}`);
});
