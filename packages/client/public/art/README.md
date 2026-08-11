# 이미지 넣는 곳

생성 도구에서 뽑은 **스프라이트 시트를 자르는 것**부터 시작한다.

## 1. 시트 자르기

프레임을 한 장에 나란히 뽑은 시트(가로 배열, 투명 배경)를 그대로 넣으면 안 된다.
게임은 균일한 셀 스트립을 기대하므로 먼저 잘라야 한다.

```bash
cd packages/client
node tools/slice-sheet.mjs ~/받은시트.png --unit rifleman --anim walk --tier small
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
