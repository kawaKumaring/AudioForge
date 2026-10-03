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

**검증** — `npm run test:mcp` (39건 · 사전 `npm run build`) · 규칙 계약 5건(`npm test` 안).

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

### AudioForge 에 맞춘 도구 (같은 날 개량 — "해당 툴에 맞게 사용할 수 있도록")

AudioForge 는 소리를 다루고(AI 는 들을 수 없다), 작업이 길고(합성·분리), 개인정보 규칙이 엄격하다. 그래서 더했다 —
- `app_state` — 한 번에: 작업 · 처리 상태 · 오류 · 합성이 막히는 사유 · 떠 있는 대화창·경고 · 생성 카드(개수·생성본 수·진행 중) · 낭독(책·문단 자리·목소리·읽는 중·상태 글) · 울리는 소리 수
- `app_mode` — 작업 화면 바꾸기(`reader` 또는 '낭독' 처럼 한국어로). 처리 중이면 바뀌지 않는다고 알려 준다
- `audio_now` — **무엇이 울리나**: 파일 이름 · 위치 · 멈춤/끝남 · 재생 빠르기 · 음량 · 앱 안 경로(낭독 소리 요소는 화면에 없어 틀기 시작할 때 붙잡는다)
- `audio_inspect` — 만든 소리(WAV)를 수치로: 길이 · 최고/평균 크기(dBFS) · 잘린 표본 · 조용한 비율 · 앞뒤 조용함 · 가장 긴 틈 · 비었는지
- `wait_idle` — 긴 작업이 끝날 때까지(처리 상태 · 카드 작업 · 합성 막힘 · 낭독 "만드는 중" 이 모두 비고 1초 유지)
- `test_input` — **사용자 파일 대신 쓰는 재료**를 이 실행의 임시 폴더에: 글 파일(UTF-8·UTF-16·CP949) · 사인파 · 기본 목소리로 만든 말소리(참조 목소리 검사용) · 저장소 검사용 음원 복사
- `errors` — 문제만: 화면 오류·경고 · 본체 오류 줄 · 앱 기록 WARN/ERROR. 검사 모드에서만 나는 알려진 경고(화면 정책의 eval — 검사 도구 때문)는 따로 센다
- `app_mode` 의 `force:true` — 화면에 단추가 없는 작업(`dialogue-rebuild` 는 대화 분리 결과에서 들어가고, `lab` 은 목록에 없다)도 점검용으로 연다. 없이 부르면 왜 안 되는지 알려 준다
- `app_restart` — 같은 사용자 데이터로 다시 켠다(껐다 켜도 남는지 확인). 처음 켤 때 고른 `prep` 을 그대로 쓴다
- `app_start` 의 `prep`(2026-10-03) — 기본 `test` 는 **낭독 미리 준비를 끈다**(목록을 열 때 Qwen 실행기 띄우기·모델 파일 미리 읽기, 고를 때 모델 열기·첫 생성 준비, 켤 때 합성 라이브러리 미리 읽기).
  성능을 잴 때는 `prep:"normal"`(= `AF_E2E_NORMAL_PREP=1`, GPU 사용) — 보통 실행과 같은 준비. ★`test` 로 잰 수치를 보통 실행 성능으로 보고하지 않는다.
  그 밖에 검사 실행이 보통 실행과 다른 점: 사용자 데이터가 새 임시 폴더(낭독 캐시 빈 상태로 시작) · 창 소리 끔(시각·값은 그대로) · 화면 밖 창(그리기 멈춤 해제 스위치를 켬)
- `reader_trace`(2026-10-03) — 낭독 관측 기록(최근 500개, `performance.now()` 단조 ms, `mode` 에 실행 방식). `clear:true` 면 읽고 비운다.
  사건: `play-request`(readyAtRequest) · `gen-request`(req·gen·chunk·글자 수) · `gen-start`(본체 생성 시작 — 응답 시각 − 생성 길이, derived) ·
  `gen-done`(ok·cached·shared·modelOpened·waitMs 줄 대기·makeMs 생성·engine·accepted) · `play-start`(소리 요소 **playing** 사건 — via·sinceRequestMs·gapMs) ·
  `buffer-low-start`/`buffer-low-end`(lowMs, initial=시작 직후 첫 소리 대기) · `seek-request` · `resplit` · `voice-change` · `stop`. 본문·경로·전사 없음.
  측정 순서는 `doc/performance-handoff-2026-10-03.md` 6절
- `ui_drop_files` — 파일 끌어 놓기(숨긴 파일 입력칸으로 경로를 넣으면 Electron 이 진짜 경로를 안다 → 대상 가운데 아래 가장 안쪽 요소에 놓는다). 개인정보 가드를 탄다
- `ui_key` · `ui_pointer`(요소 안 비율 위치 · 누르기/끌기 — 끝에서 1px 안쪽) · `ui_scroll`
- `ui_audit` — 화면 결함을 글과 숫자로: 이름 없는 단추 · 이유 없는 비활성 · 창 밖 · 가림 · 잘린 글 · 작은 글씨(11px 미만) · 가로 스크롤.
  ★대화창이 떠 있으면 **맨 위 대화창 안만** 본다(`role=dialog` 와 브라우저 기본 `<dialog open>` 둘 다 — 설정·목소리 고르기는 후자라 처음엔 뒤 화면까지 세어 "가림" 27건을 냈다).
  ★굴림 칸 밖으로 굴러 나간 것은 가림으로 세지 않는다(낭독 본문 아래쪽 문단이 아래 막대에 "가려진" 것으로 나오던 헛경보)
- 설명서(instructions)에 **화면 지도**(작업 9개 · 주요 testid)를 실어 AI 가 매번 더듬지 않게 했다(`tools/mcp/audioforge.cjs` — 작업 목록이 ModeSelector 와 같은지 계약 검사가 본다)

### 개인정보 가드 — 도구가 직접 막는다

`dialog_queue` · `api_call` · `js_eval` · `audio_inspect` 에 넘기는 값 안에 **검사용 자리 밖의 미디어 경로**(소리·영상·이미지)가 있으면 멈추고 사유를 말한다.
검사용 자리 = `test/fixtures/audio` · `_local/tmp` · 이 실행의 임시 폴더. 사용자가 **그 파일·그 작업을 명시적으로 허락했을 때만** `userApproved:true` 로 다시 부른다.
대신 쓸 재료는 `test_input` 이 만든다. (`..` 로 빠져나가는 경로 · 문자열 안에 묻힌 경로도 막는다 — `src/main/services/mcpDevtool.contract.test.ts`)

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
