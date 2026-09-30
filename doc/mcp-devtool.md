# 개발툴 MCP — AI 가 AudioForge 를 직접 켜고 조작하며 확인하는 도구 (2026-09-30)

> 개념·원칙·다른 도구에 붙이는 일반 안내는 Spine2DManager 의 `doc/MCP-DEVTOOL.md`(§278)에 있다. 이 문서는 **AudioForge 에서 쓰는 법**과 **무엇이 다른지**만 적는다.

## 무엇인가

**MCP(Model Context Protocol)** 는 AI 가 외부 프로그램의 기능을 "도구"로 불러 쓰게 하는 표준 연결 규약이다.
이 도구를 켜면 AI 가 AudioForge 를 **한 단계씩** 켜고 → 화면을 읽고 → 누르고 → 결과를 값으로 받는다.
미리 다 적어 보내는 검사(`test/e2e/*.mjs`)가 "편지"라면 이것은 "전화"다 — 개발 중 확인에 쓰고, 확인된 동작은 검사로 옮긴다.

- 창은 **화면 밖 · 포커스 없음**으로 뜬다 — 사용자 화면을 가리지 않고 마우스·키보드를 빼앗지 않는다.
- 사용자 설정·작업은 **격리된 임시 폴더**(`_local/tmp/mcp-<번호>/`)를 쓰고, 끝나면 지운다. 사용자 데이터는 그대로다.
- OS 파일 열기·저장 창은 **뜨지 않는다** — 미리 넣어 둔 응답(없으면 취소)으로 바뀐다.
- **네트워크 창구가 없다** — AI 와는 표준입출력으로만, 앱과는 Playwright 로만 이어진다.

## 쓰는 법

**Claude Code 에서(권장)** — 이 저장소 폴더에서 Claude Code 를 연다(상위 폴더에서 열면 `.mcp.json` 을 읽지 않는다).
처음 한 번 "`audioforge-devtool` MCP 서버를 쓸까요?" 확인이 뜨면 승인한다. 이후 AI 가 도구 설명을 스스로 읽고 쓴다.

**MCP 가 연결되지 않은 곳에서** — 같은 규약을 부르는 최소 클라이언트:
```bash
node tools/mcp/client.cjs --list
node tools/mcp/client.cjs steps.json --out _local/tmp/mcp-client
```
`steps.json` 예: `[{"tool":"app_start"},{"tool":"ui_click","args":{"target":"testid:mode-reader"}},{"tool":"ui_screenshot"},{"tool":"app_stop"}]`

**검증** — `npm run test:mcp` (23건 · 사전 `npm run build`).

## 도구

- `app_start` · `app_stop` · `app_status` · `app_reload` — 켜기(소스가 새로우면 자동 빌드) · 끄기(임시 폴더 지움) · 상태 · 새로 고침
- `ui_snapshot` — 화면 구조(접근성 트리) 글. 처음 파악할 때
- `ui_query` · `ui_text` — 보이는 요소 목록(**testid** · ref · 글자 · 비활성 · 값) · 글자
- `ui_click` · `ui_set` · `ui_wait` — 누르기 · 값 넣기(React 가 알아채는 방식) · 조건 대기
- `ui_screenshot` · `window_resize` — 캡처(화면 밖 창도) · 창 크기
- `api_list` · `api_call` — 앱 기능(`window.api`) 목록 · 호출. 이름은 묶음을 점으로 잇는다(`reader.speak`, `cards.builtinVoices`)
- `js_eval` — 화면 JS 평가(점검용)
- `dialog_queue` · `dialog_clear` — 다음 파일 창의 응답 미리 넣기(open=경로 · save=경로 · message=버튼 번호)
- `logs` — main 출력 · 화면 콘솔 · 대화상자 응답 · **앱 동작 기록 파일**(`source:'app'` — `[reader]` `[check]` 같은 꼬리표)

요소는 **`testid:이름`** 으로 지정하는 것이 가장 확실하다(이 앱은 요소마다 `data-testid` 를 단다). `@번호` ref 는 화면이 다시 그려지면 바뀐다.

## Spine2DManager 와 다른 점 — 왜 새로 짰나

- Spine 은 앱을 감싸는 **호스트**가 `require('electron')` 를 가로채 창을 바꿔 끼우고, 127.0.0.1 **제어 창구(토큰)** 로 명령을 받는다.
  AudioForge 본체는 electron-vite 가 하나로 묶은 빌드라 그 가로채기 지점이 다르다.
- AudioForge 에는 이미 **검사 모드(`AF_E2E`)** 가 있다 — 사용자 데이터 격리 · 창을 앞으로 가져오지 않기 · 검사 전용 창구.
  그리고 검사 100여 개가 **Playwright** 로 앱을 띄운다. 그래서 MCP 서버가 Playwright 로 앱을 직접 띄운다 —
  호스트 파일 · 네트워크 포트 · 토큰이 없다.
- 앱에 더한 것은 하나: **`AF_E2E_OFFSCREEN=1`**(`AF_E2E=1` 일 때만) — 창을 화면 밖(-30000)에 두고 가려진 창도 그리게 한다
  (`src/main/services/offscreen.ts`). 보통 실행과 기존 검사는 그대로다.
- 대화상자는 앱을 켠 뒤 본체 안에서 `dialog.showOpenDialog` 등을 응답 큐로 바꿔 끼운다(앱 코드 무수정).
- 가져온 것: 도구 이름·구성, 화면 조작 도우미(`domHelpers.js` — testid 와 묶음 이름을 더했다), 최소 클라이언트, "표준출력은 MCP 메시지 전용" 원칙.

## 한계 · 주의

- **사용자의 음성·영상 파일은 사용자가 허락한 것만 연다**(개인정보 정책). 확인에는 검사용 음원(`test/fixtures/audio`)이나 앱의 기본 목소리를 쓴다.
- GPU 작업(참조 목소리 합성·Qwen)도 부를 수 있다 — 오래 걸리면 `api_call` 의 `timeoutMs` 를 늘리고 `logs` 로 진행을 본다.
- 개발 실행(`npm run dev`, StrictMode) 이 아니라 **빌드된 앱(out/)** 을 띄운다 — 개발 실행에서만 나는 문제는 `*.component.mjs` 검사로 본다.
- 저장소 상위 폴더에서 연 Claude Code 에는 도구가 붙지 않는다 — 그때는 `client.cjs` 로 같은 규약을 쓴다.
  `.mcp.json` 은 세션을 시작할 때 읽힌다 — 이미 열린 세션에는 다시 열어야 붙는다.
