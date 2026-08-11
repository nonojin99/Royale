# 이미지 넣는 곳

여기에 PNG를 넣고 `manifest.json`에 id를 적으면 화면에 나온다. 코드는 건드릴 필요 없다.

```
units/rifleman.png      ← 파일명 = units.ts의 id (전부 소문자)
bases/main.png
bases/expansion.png
worker.png
```

## 넣는 순서

1. PNG를 해당 폴더에 넣는다
2. `manifest.json`의 배열에 id를 추가한다

```json
{ "units": ["rifleman", "gnawer"], "bases": ["main"], "worker": false }
```

매니페스트에 적지 않은 파일은 로더가 존재를 모른다. 없는 파일을 찾느라 매번 404를
내지 않기 위한 것이다. 반대로 **적었는데 파일이 없으면 콘솔에 경고가 뜬다** — 오타를
바로 잡기 위해서다.

전부 시도해 보려면 `?probe=1`을 붙인다. 매니페스트를 무시하고 24유닛 전부를
찾아보며, 없는 파일은 조용히 넘어간다.

## 유닛 id 24개

```
기갑단   rifleman  flamer  scoutcar  siegetank  ironwalker  bulwark  gunship  carpetbomb
군체     gnawer  spitter  burrower  devourer  spinetentacle  wingswarm  sporetentacle  tunneler
신념단   zealot  strider  mystic  fusionite  lightpylon  shade  skiff  mindbreak
```

**대소문자가 중요하다.** Windows에서는 `Rifleman.png`도 열리지만 배포되는 Linux
서버에서는 404가 난다.

## 규격 요약

| 대상 | 원본 크기 | 캔버스 대비 크기 |
|---|---|---|
| 유닛 | 128 × 128 | 소형 55% · 중형 70% · 대형 90% |
| 건물 | 192 × 192 | — |
| 기지 | 256 × 256 | — |

투명 배경 PNG, 3/4 탑다운, 광원은 왼쪽 위, 발이 아래에서 12% 지점.
전체 규격은 [docs/ART_PIPELINE.md](../../../../docs/ART_PIPELINE.md).
