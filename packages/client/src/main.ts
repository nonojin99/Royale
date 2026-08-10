/**
 * 클라이언트 엔트리.
 *
 * 구조:
 *   NetClient  — 서버 통신 + 로컬 결정론 시뮬 구동
 *   Renderer   — Pixi로 아레나/엔티티 그리기 (상태를 읽기만 한다)
 *   여기(main) — 입력 처리, HTML HUD 갱신, 프레임 루프
 */

import {
  ELIXIR_SCALE,
  GameState,
  HAND_SIZE,
  MATCH_TICKS,
  OVERTIME_TICKS,
  TICK_RATE,
  canDeploy,
  getCard,
} from '@royale/shared';

import { NetClient } from './net.js';
import { Renderer, VIEW_H, VIEW_W } from './render.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 없음`);
  return el as T;
};

/* ── 서버 주소 ─────────────────────────────────────────────────────────── */

function serverUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.hostname}:8787`;
}

/** ?solo=1 이면 서버가 봇과 즉시 매칭해준다 */
function withSolo(url: string): string {
  const solo = new URLSearchParams(location.search).get('solo');
  if (!solo) return url;
  return url + (url.includes('?') ? '&' : '?') + 'solo=1';
}

/* ── 상태 ──────────────────────────────────────────────────────────────── */

const renderer = new Renderer();
let selectedHand = -1;
let cursor: [number, number] | null = null;
/** 직전 틱의 엔티티 위치 — 렌더 보간용 */
const prevPos = new Map<number, [number, number]>();

const net = new NetClient(withSolo(serverUrl()), {
  onQueued: () => setStatus('상대를 찾는 중…'),
  onMatch: (team, opponent) => {
    setStatus('');
    $('overlay').classList.add('hidden');
    $('opponent').textContent = `vs ${opponent}`;
    void team;
  },
  onOver: (winner, crowns) => {
    const me = net.myTeam;
    const text =
      winner === -1 ? '무승부' : winner === me ? '승리!' : '패배';
    showOverlay(`${text}`, `왕관 ${crowns[me]} : ${crowns[me === 0 ? 1 : 0]}`);
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
    case 'no-elixir':
      return '엘릭서 부족';
    case 'bad-zone':
      return '배치할 수 없는 위치';
    case 'not-in-hand':
      return '손패에 없는 카드';
    case 'not-playing':
      return '경기 중이 아님';
    default:
      return '요청 거부됨';
  }
}

/* ── 초기화 ────────────────────────────────────────────────────────────── */

async function boot(): Promise<void> {
  await renderer.init($('arena'));
  // 손패 카드를 먼저 만들어야 하단 패널 높이가 확정되고, 그래야 캔버스를 정확히 맞춘다
  ensureHandEls();
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  const canvas = renderer.canvas;
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', () => {
    cursor = null;
  });
  canvas.addEventListener('pointerdown', onPointerDown);

  $('start').addEventListener('click', () => {
    const name = ($('name') as HTMLInputElement).value.trim() || '플레이어';
    net.connect(name);
    setStatus('접속 중…');
    ($('start') as HTMLButtonElement).disabled = true;
  });

  window.addEventListener('keydown', (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= HAND_SIZE) selectHand(n - 1);
  });

  requestAnimationFrame(frame);
}

/**
 * 캔버스를 화면 크기에 맞춰 CSS로 스케일한다 (내부 해상도는 고정).
 * 남는 높이를 상수로 가정하면 기기마다 UI가 잘리므로, 실제 패널 높이를 측정한다.
 */
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
  if (!s || selectedHand < 0) return;
  const [x, y] = pointerToArena(ev);
  cursor = [x, y];

  const card = s.players[net.myTeam].cycle[selectedHand];
  if (!card) return;

  if (!deployable(s, x, y)) {
    flash('배치할 수 없는 위치');
    return;
  }
  if (s.players[net.myTeam].elixir < getCard(card).cost * ELIXIR_SCALE) {
    flash('엘릭서 부족');
    return;
  }

  net.play(card, x, y);
  selectedHand = -1;
}

function deployable(s: GameState, x: number, y: number): boolean {
  const enemy = s.players[net.myTeam === 0 ? 1 : 0];
  return canDeploy(net.myTeam, x, y, enemy.princessDown);
}

function selectHand(i: number): void {
  selectedHand = selectedHand === i ? -1 : i;
}

/* ── 프레임 루프 ───────────────────────────────────────────────────────── */

function frame(): void {
  net.update();

  const s = net.state;
  if (s) {
    renderer.draw({
      state: s,
      myTeam: net.myTeam,
      prev: prevPos,
      alpha: net.alpha(),
      cursor: selectedHand >= 0 ? cursor : null,
      cursorValid: cursor ? deployable(s, cursor[0], cursor[1]) : false,
    });
    updateHud(s);
  }
  requestAnimationFrame(frame);
}

/* ── HUD ───────────────────────────────────────────────────────────────── */

let handEls: HTMLElement[] = [];

function ensureHandEls(): void {
  if (handEls.length) return;
  const root = $('hand');
  for (let i = 0; i < HAND_SIZE; i++) {
    const el = document.createElement('button');
    el.className = 'card';
    el.innerHTML = `<span class="cname"></span><span class="ccost"></span>`;
    el.addEventListener('click', () => selectHand(i));
    root.appendChild(el);
    handEls.push(el);
  }
}

function updateHud(s: GameState): void {
  ensureHandEls();
  const me = s.players[net.myTeam];
  const foe = s.players[net.myTeam === 0 ? 1 : 0];

  // 엘릭서
  const elixir = me.elixir / ELIXIR_SCALE;
  $('elixir-fill').style.width = `${(elixir / 10) * 100}%`;
  $('elixir-num').textContent = String(Math.floor(elixir));

  // 손패
  for (let i = 0; i < HAND_SIZE; i++) {
    const id = me.cycle[i];
    const el = handEls[i];
    const card = getCard(id);
    el.querySelector<HTMLElement>('.cname')!.textContent = card.name;
    el.querySelector<HTMLElement>('.ccost')!.textContent = String(card.cost);
    el.style.setProperty('--card-color', `#${card.color.toString(16).padStart(6, '0')}`);
    el.classList.toggle('selected', selectedHand === i);
    el.classList.toggle('unaffordable', me.elixir < card.cost * ELIXIR_SCALE);
  }
  const nextId = me.cycle[HAND_SIZE];
  $('next-card').textContent = nextId ? `다음: ${getCard(nextId).name}` : '';

  // 시간
  const limit = s.overtime ? MATCH_TICKS + OVERTIME_TICKS : MATCH_TICKS;
  const left = Math.max(0, Math.ceil((limit - s.tick) / TICK_RATE));
  $('timer').textContent =
    `${s.overtime ? '연장 ' : ''}${String(Math.floor(left / 60)).padStart(1, '0')}:${String(left % 60).padStart(2, '0')}`;

  // 왕관
  $('crowns').textContent = `👑 ${me.crowns} : ${foe.crowns}`;

  // 넷 계기판 — 데스싱크가 0이 아니면 시뮬에 버그가 있다는 뜻이다
  const st = net.stats();
  $('netinfo').textContent =
    `${st.rttMs}ms · tick ${st.simTick}/${st.leadTick} · desync ${st.desyncs}`;
  $('netinfo').classList.toggle('bad', st.desyncs > 0);
}

/* ── 오버레이 / 토스트 ─────────────────────────────────────────────────── */

function setStatus(text: string): void {
  $('status').textContent = text;
}

function showOverlay(title: string, sub: string): void {
  $('overlay').classList.remove('hidden');
  $('overlay-title').textContent = title;
  $('status').textContent = sub;
  ($('start') as HTMLButtonElement).style.display = 'none';
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;
function flash(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

boot().catch((err) => {
  console.error(err);
  setStatus(`초기화 실패: ${String(err)}`);
});
