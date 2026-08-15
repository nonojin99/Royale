/**
 * 아트 에셋 로더.
 *
 * 이미지는 **있으면 쓰고 없으면 도형으로 그린다.** 24장이 다 모일 때까지
 * 기다리지 않고 한 장씩 채워 넣을 수 있어야 하기 때문이다.
 *
 * 어떤 이미지가 존재하는지는 `public/art/manifest.json`이 선언한다. 파일을
 * 넣어도 매니페스트에 적지 않으면 로더는 그 존재를 모른다 — 없는 파일을
 * 찾느라 매번 404를 내지 않기 위한 선택이다.
 *
 * 개발 중에는 `?probe=1`로 매니페스트를 무시하고 전 유닛을 시도할 수 있다.
 * 이때 없는 파일은 조용히 무시된다.
 *
 * 렌더 전용 모듈이다. 시뮬레이션은 이미지의 존재를 알지 못하고, 알아서도
 * 안 된다 — 한쪽에만 이미지가 있어도 두 클라이언트의 시뮬은 같아야 한다.
 */

import { Assets, Rectangle, Texture } from 'pixi.js';

import { FACTION_IDS, UNIT_IDS } from '@royale/shared';

/** 애니메이션 한 벌 — 균일 셀 스트립 한 장에 프레임이 가로로 늘어서 있다 */
export interface AnimDef {
  frames: number;
  fps: number;
}

/** `public/art/manifest.json` 스키마 */
export interface ArtManifest {
  /**
   * 이미지가 준비된 유닛.
   *
   * - 배열이면 정지 이미지 한 장씩: `["rifleman"]` → `units/rifleman.png`
   * - 객체면 애니메이션: `{"gnawer": {"walk": {"frames":5,"fps":10}}}`
   *   → `units/gnawer.walk.png`
   *
   * 둘을 섞을 수는 없다. 애니메이션이 하나라도 있으면 객체 형태를 쓴다.
   */
  units?: string[] | Record<string, Record<string, AnimDef>>;
  /**
   * 기지 이미지 — 종족별.
   *
   * `{"steel": ["main", "expansion"], "covenant": ["main"]}` 형태.
   * 파일은 `bases/<종족>.<종류>.png`. 없는 종족·종류는 도형으로 폴백한다.
   * (옛 배열 형태 `["main","expansion"]`도 종족 무관 공용으로 읽는다)
   */
  bases?: string[] | Record<string, string[]>;
  /**
   * 일꾼 — `worker.png`.
   *
   * `true`면 정지 이미지 한 장, 정의를 주면 가로 스트립을 걷기 순환으로 읽는다.
   */
  worker?: boolean | AnimDef;
  /**
   * 미네랄 덩이 — `mineral.png`.
   *
   * 애니메이션이 아니라 **변형 모음**이다. 스트립을 프레임 수만큼 쪼개
   * 덩이마다 다른 칸을 골라 쓴다 (`fps`는 쓰이지 않는다).
   */
  mineral?: boolean | AnimDef;
  /**
   * 이펙트 — `fx.png`.
   *
   * 미네랄처럼 **변형 모음**이다. 4행 6열 시트를 행 우선으로 편 24칸 스트립이고,
   * 몇 번 칸이 무슨 이펙트인지는 렌더러의 FX 표가 안다.
   */
  fx?: boolean | AnimDef;
  /**
   * 지형 타일셋 — `terrain.png`.
   *
   * 역시 변형 모음이다. 4행 6열(잔디/고지/절벽/바위)을 행 우선으로 편
   * 24칸 스트립이고, 칸 배정은 렌더러의 지형 표가 안다.
   */
  terrain?: boolean | AnimDef;
  /**
   * 지형 소품 — `doodads.png`.
   *
   * 역시 변형 모음이다. 24px 정사각 12칸 가로 스트립이고, 몇 번이 무엇인지는
   * 렌더러의 두들 표가 안다 (MAP_RULES §8-3).
   */
  doodads?: boolean | AnimDef;
}

/** 재생 가능한 프레임 묶음 */
export interface Clip {
  textures: Texture[];
  fps: number;
  /** 한 바퀴 도는 데 걸리는 시간(ms) */
  durationMs: number;
}

/**
 * 스트립 한 장을 균일 셀로 쪼갠다.
 *
 * 셀 크기를 상수로 박지 않고 텍스처 폭에서 나눈다 — 나중에 128이 아닌 규격을
 * 쓰더라도 도구와 로더가 따로 놀지 않게 하기 위해서다.
 */
function sliceStrip(sheet: Texture, frames: number, fps: number): Clip {
  const cell = Math.round(sheet.width / frames);
  const textures: Texture[] = [];
  for (let i = 0; i < frames; i++) {
    textures.push(
      new Texture({
        source: sheet.source,
        frame: new Rectangle(i * cell, 0, cell, sheet.height),
      }),
    );
  }
  return { textures, fps, durationMs: (frames / fps) * 1000 };
}

/** 정적 호스팅 하위 경로(GitHub Pages 등)에서도 맞도록 base를 붙인다 */
function artUrl(rel: string): string {
  return `${import.meta.env.BASE_URL}art/${rel}`;
}

class ArtLibrary {
  private readonly tex = new Map<string, Texture>();
  private readonly clips = new Map<string, Clip>();
  private loaded = false;

  /** 실제로 불러온 이미지 수 — 로딩 문구에 쓴다 */
  count = 0;

  /**
   * 매니페스트를 읽고 선언된 이미지를 전부 불러온다.
   *
   * **어떤 실패도 게임을 막지 않는다.** 매니페스트가 없으면(아직 이미지를
   * 하나도 안 올린 상태) 그냥 도형으로 시작한다.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    const probe = new URLSearchParams(location.search).get('probe') === '1';
    const manifest = probe ? null : await this.fetchManifest();

    /** [저장 키, URL, 애니메이션이면 정의] */
    const wanted: Array<[string, string, AnimDef | null]> = [];

    const units = manifest?.units;
    if (probe) {
      for (const id of UNIT_IDS) wanted.push([`unit:${id}`, artUrl(`units/${id}.png`), null]);
    } else if (Array.isArray(units)) {
      for (const id of units) wanted.push([`unit:${id}`, artUrl(`units/${id}.png`), null]);
    } else if (units) {
      for (const [id, anims] of Object.entries(units)) {
        for (const [name, def] of Object.entries(anims)) {
          wanted.push([`clip:${id}:${name}`, artUrl(`units/${id}.${name}.png`), def]);
        }
      }
    }

    const bases = manifest?.bases;
    if (probe) {
      for (const f of FACTION_IDS) {
        for (const kind of ['main', 'expansion']) {
          wanted.push([`base:${f}:${kind}`, artUrl(`bases/${f}.${kind}.png`), null]);
        }
      }
    } else if (Array.isArray(bases)) {
      // 옛 형태 — 종족 무관 공용
      for (const kind of bases) wanted.push([`base:*:${kind}`, artUrl(`bases/${kind}.png`), null]);
    } else if (bases) {
      for (const [f, kinds] of Object.entries(bases)) {
        for (const kind of kinds) {
          wanted.push([`base:${f}:${kind}`, artUrl(`bases/${f}.${kind}.png`), null]);
        }
      }
    }

    // 일꾼·미네랄은 유닛이 아니라서 매니페스트 항목이 따로다.
    // `true`면 한 장, 정의가 오면 스트립으로 읽는다.
    for (const name of ['worker', 'mineral', 'fx', 'terrain', 'doodads'] as const) {
      const def = manifest?.[name];
      if (probe || def === true) wanted.push([name, artUrl(`${name}.png`), null]);
      else if (def) wanted.push([`clip:${name}:all`, artUrl(`${name}.png`), def]);
    }

    if (!wanted.length) return;

    // 한 장이 실패해도 나머지는 살린다
    const results = await Promise.allSettled(
      wanted.map(
        async ([key, url, def]) => [key, await Assets.load<Texture>(url), def] as const,
      ),
    );
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const [key, texture, def] = r.value;
      if (def) this.clips.set(key, sliceStrip(texture, def.frames, def.fps));
      else this.tex.set(key, texture);
    }
    this.count = this.tex.size + this.clips.size;

    const failed = results.length - this.count;
    if (failed > 0 && !probe) {
      // 매니페스트에 적혔는데 없는 파일 = 오타이거나 빠뜨린 파일이다. 조용히
      // 넘기면 "왜 안 나오지"로 시간을 버리게 되므로 반드시 알린다.
      console.warn(`[art] 매니페스트에 선언됐지만 불러오지 못한 이미지 ${failed}장`);
    }
  }

  /** 유닛의 특정 애니메이션. 없으면 null */
  clip(unitId: string, anim: string): Clip | null {
    return this.clips.get(`clip:${unitId}:${anim}`) ?? null;
  }

  private async fetchManifest(): Promise<ArtManifest | null> {
    try {
      const res = await fetch(artUrl('manifest.json'), { cache: 'no-cache' });
      if (!res.ok) return null;
      return (await res.json()) as ArtManifest;
    } catch {
      return null; // 아직 아무 이미지도 없는 상태 — 정상이다
    }
  }

  /**
   * 유닛의 정지 이미지.
   *
   * 애니메이션만 있는 유닛이면 걷기(없으면 아무거나)의 첫 프레임을 돌려준다.
   * 덕분에 호출부는 "이 유닛에 그림이 있는가"만 물으면 된다.
   */
  unit(id: string): Texture | null {
    const still = this.tex.get(`unit:${id}`);
    if (still) return still;
    const walk = this.clip(id, 'walk') ?? this.clip(id, 'idle');
    if (walk) return walk.textures[0];
    for (const [key, clip] of this.clips) {
      if (key.startsWith(`clip:${id}:`)) return clip.textures[0];
    }
    return null;
  }

  base(faction: string, isMain: boolean): Texture | null {
    const kind = isMain ? 'main' : 'expansion';
    return this.tex.get(`base:${faction}:${kind}`) ?? this.tex.get(`base:*:${kind}`) ?? null;
  }

  /**
   * 일꾼의 걷기 프레임.
   *
   * `phase`(0~1)로 프레임을 고른다 — 렌더러가 일꾼마다 위상을 어긋나게 주고
   * 있어서, 같은 값을 쓰면 다리도 저절로 따로 논다.
   */
  worker(phase = 0): Texture | null {
    const still = this.tex.get('worker');
    if (still) return still;
    const clip = this.clips.get('clip:worker:all');
    if (!clip) return null;
    const n = clip.textures.length;
    return clip.textures[Math.min(n - 1, Math.floor(phase * n))];
  }

  /** 미네랄 덩이. 덩이 번호마다 다른 변형을 돌려준다 */
  mineral(variant = 0): Texture | null {
    const still = this.tex.get('mineral');
    if (still) return still;
    const clip = this.clips.get('clip:mineral:all');
    if (!clip) return null;
    return clip.textures[variant % clip.textures.length];
  }

  /** 이펙트 칸. 번호는 렌더러의 FX 표가 정한다. 시트가 없으면 null */
  fx(index: number): Texture | null {
    return this.cellOf('fx', index);
  }

  /** 지형 소품 칸 (§8-3). 시트가 없으면 null — 소품 없이 그려진다 */
  doodad(index: number): Texture | null {
    return this.cellOf('doodads', index);
  }

  /** 텍셀 번짐을 막은 지형 타일 텍스처 캐시 */
  private readonly terrainTex = new Map<number, Texture>();

  /** 지형 타일 칸. 번호는 렌더러의 지형 표가 정한다. 시트가 없으면 null */
  terrain(index: number): Texture | null {
    const hit = this.terrainTex.get(index);
    if (hit) return hit;
    const base = this.cellOf('terrain', index);
    if (!base) return null;
    // 타일은 화면에서 빈틈없이 이어 붙는다. 스트립에서 이웃 칸과 맞닿은
    // 가장자리 텍셀이 선형 보간으로 새어 들어오면 타일마다 줄눈이 생기므로,
    // 한 텍셀 안쪽만 쓴다.
    const f = base.frame;
    const tex = new Texture({
      source: base.source,
      frame: new Rectangle(f.x + 1, f.y + 1, f.width - 2, f.height - 2),
    });
    this.terrainTex.set(index, tex);
    return tex;
  }

  private cellOf(name: string, index: number): Texture | null {
    const clip = this.clips.get(`clip:${name}:all`);
    if (!clip || index < 0 || index >= clip.textures.length) return null;
    return clip.textures[index];
  }

  /** 이미지가 한 장이라도 있는지 */
  get any(): boolean {
    return this.tex.size > 0 || this.clips.size > 0;
  }
}

export const art = new ArtLibrary();
