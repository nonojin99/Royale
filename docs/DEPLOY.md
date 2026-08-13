# 배포 — 웹 서비스 하나로 끝난다

서버(packages/server)가 빌드된 클라이언트까지 직접 서빙하므로, Node
호스팅에 **웹 서비스 1개**만 올리면 두 플레이어가 같은 주소로 접속해
방을 만들 수 있다.

## Render.com (추천 — 무료, 카드 불필요)

1. https://render.com 가입 (GitHub 계정으로)
2. **New → Blueprint** → 이 저장소(`nonojin99/Royale`) 선택
3. `render.yaml`을 자동으로 읽는다 → **Deploy**
4. 몇 분 뒤 `https://royale-XXXX.onrender.com` 주소가 나온다 — 이게 게임 주소

- 무료 플랜은 15분 유휴 시 잠들고, 다음 접속 때 ~30초 걸려 깨어난다
- `main`에 푸시할 때마다 자동 재배포된다
- 리플레이는 기본 메모리 보관(재시작 시 소실). 유지하려면 디스크를 붙이고
  `REPLAY_DIR` 환경변수를 설정

## 다른 선택지

| 호스팅 | 비고 |
|---|---|
| Railway | 사용량 크레딧제. `pnpm build` 후 `pnpm start` 그대로 동작 |
| Fly.io | 카드 등록 필요. WS 상시 연결에 강함 |
| Vercel/Netlify | **부적합** — 상시 WebSocket 서버를 못 띄운다 |

## 동작 원리

- 빌드: `pnpm build` → shared·client·server 순서로 빌드
- 실행: `node packages/server/dist/index.js` — `PORT` 환경변수(호스팅이
  주입)로 리슨하고, `client/dist`의 페이지·에셋·폰트를 직접 내준다
- 클라이언트는 배포 환경에서 **자기를 내준 서버**로 WebSocket을 연다
  (개발 중에는 vite 5173 + 서버 8787 분리 그대로)

## 로컬에서 배포본 그대로 확인

```
pnpm build
PORT=8899 node packages/server/dist/index.js
# 브라우저에서 http://localhost:8899
```
