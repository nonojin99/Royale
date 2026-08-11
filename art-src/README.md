# 원본 시트 보관소

생성 도구에서 받은 **자르기 전 시트**를 여기 둔다.

```
art-src/
  gnawer-walk.png       ← 1160×772 같은 원본. 파일명은 자유
  strider-attack.png
```

## 왜 `public/art/` 가 아닌가

`packages/client/public/` 안의 파일은 **전부 그대로 브라우저에 배포된다.** 원본
시트는 장당 100KB가 넘고 24유닛 × 동작 3종이면 70장이 넘는데, 게임은 잘린
스트립만 쓰므로 원본이 배포에 섞이면 아무도 안 받는 파일로 용량만 불어난다.

## 왜 그래도 저장소에 넣는가

크기 등급(`--tier`)이나 프레임 수를 나중에 바꾸려면 **원본에서 다시 잘라야**
한다. 잘린 스트립은 축소된 결과라 되돌릴 수 없다. 원본을 버리면 등급 하나
고치자고 이미지를 다시 생성해야 한다.

## 자르기

```bash
cd packages/client
node tools/slice-sheet.mjs ../../art-src/gnawer-walk.png --unit gnawer --anim walk --tier small
```

자세한 사용법은 [public/art/README.md](../packages/client/public/art/README.md).
