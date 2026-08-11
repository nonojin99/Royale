# 이미지 넣는 곳

생성 도구에서 뽑은 **스프라이트 시트를 자르는 것**부터 시작한다.

## 1. 시트 자르기

프레임을 한 장에 나란히 뽑은 시트(가로 배열, 투명 배경)를 그대로 넣으면 안 된다.
게임은 균일한 셀 스트립을 기대하므로 먼저 잘라야 한다.

원본 시트는 이 폴더가 아니라 저장소 최상위 [`art-src/`](../../../../art-src/)에 둔다 —
이 폴더의 파일은 전부 브라우저로 배포되므로 게임이 안 쓰는 원본이 섞이면 안 된다.

**반드시 투명 배경 PNG여야 한다.** JPG는 알파 채널이 없어서 배경을 투명하게 만들 수
없고, JPG를 PNG로 변환만 해도 소용없다 — 변환은 알파 채널을 만들 뿐 배경을 지우지
않으므로 미리보기의 체크무늬가 실제 픽셀로 남는다. 슬라이서가 둘 다 막아 준다.

### 이미 JPG로 받아 버렸다면

`dealpha.mjs`가 구워진 체크무늬를 지워 알파를 복원한다.

```bash
node tools/dealpha.mjs --all ../../art-src      # → art-src/clean/*.png
```

체크무늬는 무채색이고 밝으므로 그 조건에 맞고 **테두리에서 이어진** 픽셀만 지운다.
유닛 안쪽의 흰 하이라이트는 테두리와 이어져 있지 않아 살아남는다. 이펙트에 둘러싸여
고립된 배경 웅덩이는 밝은 칸과 어두운 칸이 번갈아 나타나는 체크무늬 특성으로 따로
잡아낸다.

JPG 압축 탓에 경계에 1~2px 잡티가 남지만, 슬라이서가 원본을 3~5배 축소하므로 화면에서는
거의 보이지 않는다. **그래도 생성 단계에서 투명 PNG로 뽑는 것이 언제나 낫다.**

```bash
cd packages/client
node tools/slice-sheet.mjs ../../art-src/받은시트.png --unit rifleman --anim walk --tier small
```

결과가 `units/rifleman.walk.png`로 저장되고, `manifest.json`에 붙여 넣을 내용이
같이 출력된다.

| 옵션 | 설명 |
|---|---|
| `--unit` | `units.ts`의 유닛 id (필수, 전부 소문자) |
| `--anim` | `walk` / `attack` / `idle` / `death` (기본 `walk`) |
| `--tier` | `small` 55% · `medium` 70% · `large` 90% — 캔버스 대비 크기 |
| `--fps` | 재생 속도 (기본 walk 10, attack 14) |
| `--frames` | 프레임 수 강제 지정 |
| `--dry` | 파일을 쓰지 않고 검출 결과만 본다 |

**먼저 `--dry`로 확인하는 것을 권한다.** 프레임을 몇 개로 검출했는지 출력된다.

### "Frame1 Frame2…" 라벨이 구워져 있으면

생성 도구가 프레임 아래에 라벨을 그려 넣는 경우가 있다. 그대로 자르면 합집합 경계가
라벨까지 삼켜 유닛이 작아지고 발 위치가 어긋난다. 슬라이서가 감지해서 몇 %를
잘라야 하는지 알려 주므로, 그 값으로 다시 만든다.

```bash
node tools/dealpha.mjs ../../art-src/시트.jpg --cropbottom 36
```

### 프레임 수가 틀리게 나오면

공격 시트처럼 섬광이 몸 밖으로 크게 번지면 프레임끼리 알파가 이어져 하나로
뭉친다. `--frames 5`를 주면 전체 폭을 5등분하는 방식으로 바뀐다.

```bash
node tools/slice-sheet.mjs ~/공격시트.png --unit strider --anim attack --frames 5
```

## 2. 매니페스트에 적기

```json
{
  "units": {
    "rifleman": {
      "walk": { "frames": 5, "fps": 10 },
      "attack": { "frames": 5, "fps": 14 }
    }
  },
  "bases": [],
  "worker": false
}
```

적지 않은 파일은 로더가 존재를 모른다 — 없는 파일을 찾느라 매번 404를 내지 않기
위해서다. 반대로 **적었는데 파일이 없으면 콘솔에 경고가 뜬다.**

정지 이미지 한 장만 쓸 때는 배열 형태도 된다: `"units": ["rifleman"]` →
`units/rifleman.png`. 다만 애니메이션이 하나라도 있으면 객체 형태로 통일한다.

## 어떤 애니메이션이 언제 나오는가

렌더러가 시뮬 상태를 보고 고른다. 시뮬은 이미지의 존재를 모른다.

| 동작 | 조건 |
|---|---|
| `attack` | 공격 쿨다운이 올라간 순간 = 방금 쏨. 한 바퀴만 재생 |
| `walk` | 직전 틱 대비 좌표가 변함 |
| `idle` | 그 외. `idle`이 없으면 `walk` 첫 프레임에서 멈춤 |

`walk`만 넣어도 정상 동작한다. `attack`이 없으면 공격 중에도 걷기가 재생된다.

## 유닛 id 24개

```
기갑단   rifleman  flamer  scoutcar  siegetank  ironwalker  bulwark  gunship  carpetbomb
군체     gnawer  spitter  burrower  devourer  spinetentacle  wingswarm  sporetentacle  tunneler
신념단   zealot  strider  mystic  fusionite  lightpylon  shade  skiff  mindbreak
```

**대소문자가 중요하다.** Windows에서는 `Rifleman.png`도 열리지만 배포되는 Linux
서버에서는 404가 난다.

## 크기 등급을 지켜야 하는 이유

코드는 유닛마다 배율을 따로 주지 않는다. 스프라이트 상자 높이는 전 유닛 고정이고,
덩치 차이는 **이미지 안에서 캔버스를 얼마나 채우는가**로만 표현된다. 물어뜯는것
(2코스트)과 거대포식자(5코스트)가 같은 비율로 나오면 코스트가 시각적으로 전달되지
않는다.

`--tier`가 이 비율을 맞춰 주므로 시트를 자를 때 등급만 제대로 지정하면 된다.

전체 규격은 [docs/ART_PIPELINE.md](../../../../docs/ART_PIPELINE.md).

## 새로 생성할 때 — 한 장에 walk + attack

**동작을 따로 생성하면 캐릭터가 어긋난다.** 실제로 겪은 문제다:

- `gnawer` — walk는 가느다란 거미, attack은 두꺼운 전갈. 아예 다른 생물
- `mystic` — walk와 attack의 갑옷 디자인이 다름
- `devourer` — 같은 생물이지만 **그려진 크기가 달라** 화면 크기가 튐

그래서 **한 장에 2행으로** 뽑는 것을 권한다. 같은 생성에서 나오면 디자인도
크기도 어긋날 수 없다.

```
1행: walk   프레임 5칸
2행: attack 프레임 5칸
```

자를 때는 `--rows`로 행 이름을 준다:

```bash
node tools/slice-sheet.mjs ../../art-src/clean/gnawer.png \
     --unit gnawer --rows walk,attack
```

배율은 **1행(walk)의 0번 프레임**으로 정하고 2행에도 같은 값을 쓴다. 그래서
공격에 들어가도 몸 크기가 그대로다.

### 생성 프롬프트에 넣을 것

- 투명 배경 PNG (JPG 금지 — 체크무늬가 픽셀로 구워진다)
- 2행 5열, 위 걷기 / 아래 공격
- **두 행의 캐릭터 크기를 동일하게**
- 프레임 라벨(Frame1, Frame2…) 넣지 말 것 — 이미지에 구워지면 잘라내야 한다
- 3/4 탑다운, 광원 왼쪽 위, 화면 아래를 향한 자세

### 발밑에 회색 얼룩이 남으면

생성 도구가 바닥 그림자를 그려 넣은 경우다. 그대로 두면 합집합 아래쪽을 "발"로
잡기 때문에 발 위치가 그림자만큼 밀리고, 게임이 그리는 팀 색 링과 겹쳐 지저분해진다.

```bash
node tools/dealpha.mjs ../../art-src/rifleman.png --shadow
```

그림자는 **채도가 낮고 어중간하게 밝다**(소총병 실측: 채도 18 / 밝기 138).
장갑은 채도가 있거나 어둡다(채도 30 / 밝기 67). 그 차이로 구분하되, 여기서도
**이미 지워진 배경과 이어진 것만** 먹어 들어가므로 캐릭터 안쪽 하이라이트는
살아남는다.

기본값은 `채도≤20 밝기≥120`. 캐릭터가 갉아먹히면 `--shadow 16,130` 처럼 조건을
좁히고, 그림자가 남으면 `--shadow 24,110` 으로 넓힌다.
