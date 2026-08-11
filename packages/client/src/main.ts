/**
 * 클라이언트 엔트리.
 *
 * 구조:
 *   NetClient  — 서버 통신 + 로컬 결정론 시뮬 구동
 *   Renderer   — Pixi로 아레나/엔티티 그리기 (상태를 읽기만 한다)
 *   여기(main) — 입력 처리, HTML HUD 갱신, 프레임 루프
 */

import {
  BASE_BUILD_COST,
  DEFAULT_FACTION_ID,
  FACTION_IDS,
  GameState,
  MATCH_TICKS,
  MINERAL_MAX,
  MINERAL_SCALE,
  OVERTIME_TICKS,
  TICK_RATE,
  WORKER_COST,
  WORKER_MINE_PER_TICK,
  activeWorkers,
  baseCount,
  canDeployAt,
  canResearch,
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
  return `${proto}//${location.hostname}:8787`;
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
let techOpen = false;
let cursor: [number, number] | null = null;
const prevPos = new Map<number, [number, number]>();
let lastFrameMs = performance.now();

const net = new NetClient(withSolo(serverUrl()), {
  onQueued: () => setStatus('상대를 찾는 중…'),
  onMatch: (_team, opponent) => {
    setStatus('');
    $('overlay').classList.add('hidden');
    $('opponent').textContent = `vs ${opponent}`;
    buildPalette();
    buildTechPanel();
  },
  onOver: (winner, bases, mined) => {
    const me = net.myTeam;
    const foe = me === 0 ? 1 : 0;
    const text = winner === -1 ? '무승부' : winner === me ? '승리!' : '패배';
    showOverlay(
      text,
      `기지 ${bases[me]} : ${bases[foe]}\n` +
        `총 채굴 ${Math.floor(mined[me] / MINERAL_SCALE)} : ${Math.floor(mined[foe] / MINERAL_SCALE)}`,
    );
  },
  onOpponentLeft: () => showOverlay('상대가 나갔습니다', '새로고침하면 다시 시작합니다'),
  onReject: (reason) => flash(rejectText(reason)),
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

  const canvas = renderer.canvas;
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', () => {
    cursor = null;
  });
  canvas.addEventListener('pointerdown', onPointerDown);

  buildFactionPicker();

  $('start').addEventListener('click', () => {
    const name = ($('name') as HTMLInputElement).value.trim() || '플레이어';
    net.connect(name, selectedFaction);
    setStatus('접속 중…');
    ($('start') as HTMLButtonElement).disabled = true;
  });

  $('btn-worker').addEventListener('click', requestWorker);
  $('btn-base').addEventListener('click', toggleBaseMode);
  $('btn-tech').addEventListener('click', () => {
    techOpen = !techOpen;
    $('tech-panel').classList.toggle('hidden', !techOpen);
    $('btn-tech').classList.toggle('open', techOpen);
    fitCanvas();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'b' || e.key === 'ㅠ') toggleBaseMode();
    if (e.key === 'w' || e.key === 'ㅈ') requestWorker();
    if (e.key === 'Escape') {
      selectedUnit = '';
      baseMode = false;
      refreshActionButtons();
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 8) selectUnitByIndex(n - 1);
  });

  requestAnimationFrame(frame);
}

/** 캔버스를 남는 높이에 맞춘다 (패널 높이를 실측한다) */
function fitCanvas(): void {
  const host = $('arena');
  const reserved = $('topbar').offsetHeight + $('bottom').offsetHeight + 16;
  const availH = Math.max(200, window.innerHeight - reserved);
  const availW = Math.min(window.innerWidth - 24, 520);
  const scale = Math.min(availW / VIEW_W, availH / VIEW_H);
  host.style.width = `${VIEW_W * scale}px`;
  host.style.height = `${VIEW_H * scale}px`;
  renderer.canvas.style.width = `${VIEW_W * scale}px`;
  renderer.canvas.style.height = `${VIEW_H * scale}px`;
}

/* ── 종족 선택 ─────────────────────────────────────────────────────────── */

function buildFactionPicker(): void {
  const root = $('faction-picker');
  root.replaceChildren();

  for (const id of FACTION_IDS) {
    const f = getFaction(id);
    const el = document.createElement('button');
    el.className = 'faction';
    el.style.setProperty('--f-color', hex(f.color));
    el.innerHTML = `<span class="fname"></span><span class="ftag"></span>`;
    el.querySelector<HTMLElement>('.fname')!.textContent = f.name;
    el.querySelector<HTMLElement>('.ftag')!.textContent = f.tagline;
    el.addEventListener('click', () => {
      selectedFaction = id;
      refreshFactionPicker();
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

function factionOfMe(): ReturnType<typeof getFaction> {
  const s = net.state;
  return getFaction(s ? s.players[net.myTeam].faction : selectedFaction);
}

function buildPalette(): void {
  const root = $('palette');
  root.replaceChildren();
  paletteEls = [];

  for (const node of factionOfMe().tech) {
    const u = getUnit(node.unit);
    const el = document.createElement('button');
    el.className = 'unit';
    el.style.setProperty('--unit-color', hex(u.color));
    el.innerHTML = `<span class="uname"></span><span class="ucost"></span>`;
    el.querySelector<HTMLElement>('.uname')!.innerHTML =
      u.name + (u.flying ? ' <span class="air">✈</span>' : '');
    el.querySelector<HTMLElement>('.ucost')!.textContent = String(u.cost);
    el.addEventListener('click', () => selectUnit(node.unit));
    root.appendChild(el);
    paletteEls.push({ el, unit: node.unit });
  }
}

function selectUnit(unit: string): void {
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
}

function toggleBaseMode(): void {
  baseMode = !baseMode;
  if (baseMode) selectedUnit = '';
  refreshActionButtons();
}

function refreshActionButtons(): void {
  $('btn-base').classList.toggle('active', baseMode);
}

function buildTechPanel(): void {
  const root = $('tech-panel');
  root.replaceChildren();
  const f = factionOfMe();

  for (const tier of [1, 2]) {
    const nodes = f.tech.filter((n) => n.tier === tier);
    if (!nodes.length) continue;
    const head = document.createElement('div');
    head.className = 'tech-tier';
    head.textContent = `${tier}단계`;
    root.appendChild(head);

    const row = document.createElement('div');
    row.className = 'tech-row';
    for (const node of nodes) {
      const u = getUnit(node.unit);
      const el = document.createElement('button');
      el.className = 'tech';
      el.dataset.unit = node.unit;
      el.style.setProperty('--unit-color', hex(u.color));
      el.innerHTML = `<span class="tname"></span><span class="tmeta"></span>`;
      el.querySelector<HTMLElement>('.tname')!.textContent = u.name;
      el.addEventListener('click', () => requestTech(node.unit));
      row.appendChild(el);
    }
    root.appendChild(row);
  }
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
    if (!nearestFreeSite(x, y, occupiedSites(s))) {
      flash('근처에 빈 기지 자리가 없습니다');
      return;
    }
    net.act('base', '', x, y);
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
  if (!deployable(s, x, y)) {
    flash('내 기지 반경 안에만 배치할 수 있습니다');
    return;
  }
  net.act('unit', selectedUnit, x, y);
  selectedUnit = '';
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

  // 유닛 팔레트
  for (const { el, unit } of paletteEls) {
    const u = getUnit(unit);
    const unlocked = isUnlocked(me, unit);
    const affordable = me.minerals >= u.cost * MINERAL_SCALE;
    el.classList.toggle('selected', selectedUnit === unit);
    el.classList.toggle('unaffordable', !unlocked || !affordable);
    el.title = unlocked ? '' : '테크트리에서 해금이 필요합니다';
  }

  // 일꾼 버튼
  const workerBtn = $('btn-worker') as HTMLButtonElement;
  workerBtn.disabled = me.minerals < WORKER_COST || me.workers >= cap;
  workerBtn.textContent = `일꾼 (${WORKER_COST / MINERAL_SCALE})`;

  // 기지 건설 버튼
  const baseBtn = $('btn-base') as HTMLButtonElement;
  baseBtn.disabled = me.minerals < BASE_BUILD_COST;
  baseBtn.textContent = baseMode
    ? '자리를 클릭하세요'
    : `기지 건설 (${BASE_BUILD_COST / MINERAL_SCALE})`;

  // 테크 패널
  if (techOpen) updateTechPanel(me);

  $('research').textContent = me.research
    ? `연구 중: ${getUnit(me.research.unit).name} ${Math.ceil(me.research.ticks / TICK_RATE)}초`
    : '';

  const st = net.stats();
  $('netinfo').textContent = `${st.rttMs}ms · tick ${st.simTick}/${st.leadTick} · desync ${st.desyncs}`;
  $('netinfo').classList.toggle('bad', st.desyncs > 0);
}

function updateTechPanel(me: GameState['players'][number]): void {
  const f = factionOfMe();
  for (const el of Array.from($('tech-panel').querySelectorAll<HTMLElement>('.tech'))) {
    const unit = el.dataset.unit!;
    const node = f.tech.find((n) => n.unit === unit);
    if (!node) continue;

    const done = isUnlocked(me, unit);
    const active = me.research?.unit === unit;
    const available = canResearch(me, unit) && me.minerals >= node.cost * MINERAL_SCALE;

    el.classList.toggle('done', done);
    el.classList.toggle('researching', active);
    el.classList.toggle('locked', !done && !active && !available);

    const meta = el.querySelector<HTMLElement>('.tmeta')!;
    if (done) meta.textContent = '해금됨';
    else if (active) meta.textContent = `${Math.ceil(me.research!.ticks / TICK_RATE)}초 남음`;
    else if (node.requires && !isUnlocked(me, node.requires))
      meta.textContent = `선행: ${getUnit(node.requires).name}`;
    else meta.textContent = `${node.cost} · ${Math.round(node.researchTicks / TICK_RATE)}초`;
  }
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
  $('faction-picker').style.display = 'none';
  $('faction-detail').style.display = 'none';
  ($('start') as HTMLButtonElement).style.display = 'none';
  ($('name') as HTMLInputElement).style.display = 'none';
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
