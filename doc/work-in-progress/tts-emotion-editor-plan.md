# TTS 감정 태그 편집기 · 색상 마커 — Phase 1 설계안

- 상태: **Phase 1 (조사 + 문법 설계 + 프로토타입). 프로덕션 구현 없음.**
- 브랜치: `feature/tts-emotion-editor` (from `origin/develop` b933ab5)
- 담당: Agent A (감정 태그 편집기 · 색상 마커)
- 이 문서는 통합 담당(integration owner)이 계약을 확정하기 전의 설계 제안이다. 여기의
  문법 변경은 **`emotions.ts` ↔ `python/tts_worker.py`가 공유하는 문법을 바꾸므로** 단독
  구현 금지. 계약 확정 후 착수.
- 용어 주의: 색상 그라디언트/전환은 **실제 감정 블렌딩이 아니다.** 백엔드는 참조를
  보간(interpolate)하지 않는다. UI 문구는 **"감정 전환"**만 쓰고 "블렌딩/섞임"은 쓰지 않는다.

---

## 0. 요약(무엇을 만들 것인가)

1. 태그 버튼이 **문서 끝이 아니라 현재 커서/현재 줄**에 적용된다.
2. 감정 태그는 **현재 줄 맨 앞**에 삽입하거나, 그 줄에 이미 있는 선두 태그를 **교체**한다.
3. 쉼(pause) 태그는 **커서의 정확한 위치**에 삽입한다.
4. 삽입 후 textarea **focus/selection/scroll 복원**.
5. 한국어 IME / 키보드 / 단일 undo 계약.
6. 한 줄 다중 감정 문법: `[기쁨] 안녕하세요. [명랑] 오늘 날씨가 좋네요.` → 2개 감정 범위.
   문법 + PURE 파서.
7. 태그부터 다음 태그까지 감정 색상 범위 표시.
8. 등록됨 / 미등록 / 준비되지 않음 상태의 시각 구분.
9. 감정 경계 전환 모드 표시: 즉시 / 부드럽게 / 쉼 후 (표시 전용).
10. 편집기 접근법 비교: plain textarea+overlay vs contenteditable vs CodeMirror → 1개 추천.
11. PURE 파서 + 파서 테스트를 **먼저**, 의존성 설치 없이.

프로토타입 산출물(이미 작성·통과):
- `doc/work-in-progress/prototype/emotion-multi-parser.proto.mjs` — PURE 파서 레퍼런스
- `doc/work-in-progress/prototype/emotion-multi-parser.proto.test.mjs` — 17건, `node --test` 통과

---

## 1. 현행 동작 감사 (file:line)

### 1.1 문법 권위 (2개 소스가 동형이어야 함)
- **TS**: `src/renderer/lib/emotions.ts:127` — `parseUsedEmotionIds`가 줄마다
  `^\[([^\]]+)\]\s*(.+)` 를 실행. 줄 앞 `[태그]` + 본문. 줄당 **1태그**.
- **Python**: `python/tts_worker.py:1069` — `_parse_line`이 동일 정규식
  `^\[([^\]]+)\]\s*(.+)`. `EMOTION_TAGS.get(tag, "default")`.
- 라인 분해: `python/tts_worker.py:1205` `text.strip().split('\n')` 후 빈 줄 제거,
  `_parse_line`을 줄마다 1회(`:1213`).
- 라벨→id 표: `emotions.ts:109` `LABEL_TO_ID`(한글 label + 영문 id alias) ↔
  `tts_worker.py:23` `EMOTION_TAGS`(동일 매핑, 영문 alias 포함).
- 동형 보증: `emotions.ts:2-4` 주석 — id 불일치는 smoke `_check_emotions()`가 FAIL로 잡음
  (색상/그룹/한글 label은 UI 전용, Python 무관).

### 1.2 현행 파싱 규칙(핵심 불변)
- 줄 앞 1태그만 인식. **줄 중간 `[태그]`는 리터럴 텍스트**(정규식 `^` 앵커).
- 태그만 있고 본문 없는 줄(`[기쁨]`)은 `(.+)` 불충족 → 매칭 실패 → 전체가 default 텍스트.
  `parseUsedEmotionIds`는 이런 줄을 "사용"으로 세지 않음 (`emotions.test.ts:29`).
- 알 수 없는 태그 → `default`, 결과에서 제외 (`emotions.test.ts:19`).
- `[기본]`/`default` → 게이팅 대상 아님, 제외 (`emotions.test.ts:24`).

### 1.3 현행 태그 삽입 (이미 커서 인식 — 부분 구현됨)
- `TTSEditor.tsx:85` `insertEmotionTag(label)`:
  - `el.selectionStart/selectionEnd`로 커서 위치를 읽음(문서 끝 append 아님) — **목표1 이미 부분 충족**.
  - `before.endsWith('\n')`가 아니면 `\n`을 먼저 넣어 **줄 단위**로 삽입 (`:94`).
  - `requestAnimationFrame`으로 focus + `setSelectionRange(caret, caret)` 복원 (`:100`).
- **현행의 한계(이번 사이클이 메우는 것):**
  - (목표2) 줄 맨 앞 삽입/선두 태그 교체가 아니라, **커서 위치에 새 줄을 쪼개 넣는다.**
    커서가 줄 중간이면 줄이 둘로 갈라짐. "현재 줄의 선두 태그 교체" 개념 없음.
  - (목표3) 쉼 태그 개념 자체가 없음(감정 태그만 삽입).
  - (목표4) scroll 위치 복원 없음(focus/selection만). `requestAnimationFrame` 1프레임 가정 —
    IME 조합 중/제어 컴포넌트 리렌더 타이밍과의 상호작용 미검증.
  - (목표5) IME 조합 중 삽입, 단일 undo 보장 없음. `setTtsText`(제어 컴포넌트 value 교체)는
    브라우저 native undo 스택을 깨서 **삽입이 undo로 되돌려지지 않음**(알려진 제어 textarea 문제).

### 1.4 상태 표시 현행 (목표8 기반 존재)
- `TTSEditor.tsx:158-165` — `registeredEmotions`/`unregisteredEmotions`, `readyCount`,
  `needsConfirmCount`, `usedCount` 집계.
- 배지: 준비됨=cyan(`:283`), 확정 필요=rose(`:284`), 대사에서 사용(`:281`).
- 미등록+대사 사용 → "기본 참조로 합성" 안내(`:251`, `:340`).
- 게이팅 로직: `emotions.ts:154` `planEmotionRefs` — (1)미등록→폴백 (2)등록+준비→전송
  (3)등록+미준비→blockedId (4)미사용→무관. `emotions.test.ts:55-98`이 4불변식 검증.

### 1.5 쉼/무음 현행
- `python/tts_worker.py:1021-1030` — 무음(`silence_gap`)은 **원래 segment(사용자 줄바꿈)
  경계에만** 적용. 자동분할 내부 chunk 사이는 0.
- `silence_gap`은 전역 슬라이더(`TTSEditor.tsx:578`), 값 하나. **줄 안 임의 위치 쉼은 없음.**
- 따라서 "쉼 태그"(목표3)는 **백엔드 신규 기능**이다(문법 + Python 합성 경로 변경 필요).

---

## 2. 다중 감정 문법 스펙 (§6)

### 2.1 BNF-ish (v2)
```
document   := line ( '\n' line )*
line       := segment*                      ; 감정 스코프는 줄 안에서만(line-local)
segment    := ( emotionTag | pauseTag )? text
emotionTag := '[' tagname ']'               ; tagname = 알려진 감정 라벨/영문 id → 그 id로 전환
                                            ;          알 수 없으면 default (현행 동형)
pauseTag   := '[' pauseWord (sep number)? ']'  ; pauseWord ∈ {쉼, pause}
sep        := ' ' | '='
text       := 다음 태그 전까지 / 줄 끝까지의 문자열
```
- 태그 토큰 정규식: `/\[\s*([^\[\]]+?)\s*\]/g`
- 감정 스코프: 한 태그부터 **다음 태그 또는 줄 끝**까지(§7 색상 범위와 동일 규칙).
- **line-local**: 줄바꿈은 감정 스코프를 끝낸다. 다음 줄은 선두 태그가 없으면 default.
  (근거: 백엔드가 줄=segment, 줄 경계=silence_gap 모델이라 line-local이 백엔드 정합.)
- 쉼 태그는 감정을 바꾸지 않는다(앞 감정 유지, 그 위치에 무음 삽입).
- 해소: `LABEL_TO_ID[tagname] ?? 'default'`. 알 수 없으면 default(현행), 단 `tagKnown=false`로
  마킹해 UI가 구분 가능(§8).

### 2.2 예시
| 입력 | 파싱 결과(감정 세그먼트) |
|---|---|
| `[기쁨] 안녕하세요. [명랑] 좋네요.` | (happy,"안녕하세요.") (cheerful,"좋네요.") |
| `안녕 [기쁨] 반가워` | (default,"안녕") (happy,"반가워") |
| `[기쁨] 첫 줄\n두 번째 줄` | (happy,"첫 줄") (default,"두 번째 줄") — line-local |
| `안녕[쉼]하세요` | (default,"안녕") **pause 0.5** (default,"하세요") |
| `가[쉼=1.2]나` | (default,"가") **pause 1.2** (default,"나") |

### 2.3 엣지 케이스 + 하위호환 판정
- `[기쁨] text` (선두 1태그): (happy,"text") — **현행과 동일.** ✅
- `text` (무태그): (default,"text") — **현행과 동일.** ✅
- `[기쁨]` (태그만): 무텍스트 → 세그먼트 없음/빈 텍스트 → "사용" 아님 — **현행 계약 유지.** ✅
- `[없는감정] 텍스트` (알 수 없음): (default,"텍스트"), tagKnown=false — used 제외, **현행 유지.** ✅
- `[기본] 평범`: (default,"평범") — used 제외, **현행 유지.** ✅
- **DIVERGENCE-1 (줄 중간 태그):** `안녕 [기쁨] 반가워` — 현행은 리터럴 텍스트(1 default
  세그먼트), v2는 (default,"안녕")(happy,"반가워"). **의도된 변경**(이 기능의 핵심)이나,
  줄 중간에 리터럴 `[...]`를 쓰던 기존 문서가 있으면 깨진다. → §5 마이그레이션/플래그.
- **DIVERGENCE-2 (쉼 태그):** 신규 토큰. 기존 문서엔 없으므로 회귀 위험 낮음. 단 Python
  합성 경로 신규(§1.5). 계약 없이는 UI 표시만(§9) 하고 실제 무음 주입은 보류.
- 닫히지 않은 `[` / 중첩 `[a[b]]`: 정규식 non-greedy로 안쪽만 매칭될 수 있음 → **깨진 태그는
  리터럴로 남김**이 기본 방침(silent 소실 금지). UI는 미인식 대괄호를 경고 색으로 표시(§8).
- 리터럴 대괄호 필요 시 이스케이프(`[[` → `[`)는 **needs-research**(현행 문법에 없음, 도입 시
  Python 동시 변경). 초기 릴리스는 이스케이프 없이 "알려진 태그만 토큰" 규칙으로 충돌 최소화 검토.

### 2.4 PURE 파서 산출 구조
`parseEmotionSegments(text, labelToId?)` → 세그먼트 배열:
- `{kind:'emotion', emotionId, tagKnown, text, textStart, textEnd, line}`
- `{kind:'pause', durationSec, at, line}`
`textStart/textEnd`는 **원본 문자열 오프셋**(§7 색상 오버레이가 이 범위를 칠함).
`parseUsedEmotionIdsV2(text)`가 기존 `parseUsedEmotionIds` 계약(본문 있는 non-default만)을
이 위에서 재현 → 게이팅(`planEmotionRefs`)은 무변경 재사용 가능.

프로토타입에서 위 전부 구현·검증 완료(17/17 통과).

---

## 3. 편집기 접근법 비교 + 추천 (§10)

평가축: 한국어 IME 조합 · 접근성 · selection 복원 · scroll 동기 · 의존성 비용.

### A. plain textarea + 뒤 겹침 overlay (색상은 겹친 div가 그림)
- **한국어 IME:** ✅ 최고. `<textarea>`는 브라우저 native IME 경로 그대로. 조합(composition)
  이벤트가 정상. 현행이 이미 textarea라 회귀 위험 최소.
- **접근성:** ✅ native textarea = 스크린리더/폼 시맨틱 그대로.
- **selection 복원:** ✅ `selectionStart/End`/`setSelectionRange` 표준 API. 현행이 이미 사용.
- **scroll 동기:** ⚠️ overlay div의 `scrollTop/Left`를 textarea에 맞춰 동기화해야 함(스크롤
  이벤트 리스너). 폰트/line-height/padding **픽셀 정합** 필요. 구현 가능하나 세심함 요구.
- **의존성:** ✅ 0. 색상은 overlay가 파싱 결과(§2.4 오프셋)로 span을 칠함.
- **한계:** textarea 안 텍스트엔 색을 못 넣음 → overlay는 textarea 텍스트를 투명하게 하고
  뒤 div가 색 텍스트를 그리는 "가짜 하이라이트" 패턴. 캐럿/커서는 textarea 것 사용.

### B. contenteditable
- **한국어 IME:** ❌ 위험. contenteditable + React 제어 + IME 조합은 조합 중 DOM 재작성으로
  조합 깨짐/커서 튐이 잦음(대표적 난제). 회피하려면 비제어 + 수동 커밋 등 복잡도 급증.
- **접근성:** ⚠️ ARIA 수동. textarea만큼 견고하지 않음.
- **selection 복원:** ⚠️ Range/Selection API로 노드 기준 복원 — 리렌더 후 노드 동일성 보장 어려움.
- **scroll 동기:** ✅ 텍스트와 색이 같은 요소라 동기 문제 없음.
- **의존성:** ✅ 0. 단 구현 복잡도(IME/undo/선택 복원)가 가장 큼.

### C. CodeMirror 6
- **한국어 IME:** ✅ 좋음(CM6는 IME 조합 처리 성숙).
- **접근성:** ✅ 성숙.
- **selection 복원:** ✅ 문서 위치 기반 트랜잭션 API로 견고.
- **scroll 동기:** ✅ 내장.
- **색상 범위:** ✅ Decoration API가 §2 문법에 자연스럽게 맞음(범위 데코).
- **의존성:** ❌ 신규 npm(`@codemirror/*` 다수). 이 워크트리는 node_modules 없음 →
  **설치 금지 제약.** 번들 크기 증가. Electron 앱에 새 대형 의존성 유입.

### 추천: **A (plain textarea + overlay)**
- 이유:
  1. **한국어 IME가 최우선**(메모리 정책)인데 A만 native 경로를 100% 유지. B는 IME 지뢰밭.
  2. 현행이 이미 textarea(`TTSEditor.tsx:475`)라 **점진 개선**(회귀 최소, 롤백 쉬움).
  3. **의존성 0** — 제약(신규 패키지 금지) 준수. CM6의 이점(데코/스크롤 내장)은 좋지만
     설치 승인 필요 + 번들 비용이 이 규모 기능엔 과함.
  4. 색상은 §2.4 파서 오프셋으로 overlay가 그림 — 파서가 이미 프로토타입으로 검증됨.
- scroll 동기의 픽셀 정합만 신경 쓰면 A로 목표 전부 충족 가능.
- **CodeMirror 6는 "await approval"로 남긴다**(설치 안 함). 향후 대사가 매우 길고 데코/가상
  스크롤 성능이 문제되면 재검토할 대안으로 기록. 지금 설치 요청 아님.

---

## 4. 삽입 / focus / selection / scroll / IME / undo 계약

### 4.1 감정 태그 삽입 (§1·§2) — "현재 줄" 규칙
- 대상 줄 = 커서(selectionStart)가 속한 줄(직전 `\n` ~ 다음 `\n`).
- 그 줄의 **맨 앞**을 검사:
  - 선두에 이미 `[기존태그] ` 가 있으면 → **그 태그만 새 태그로 교체**(줄 나머지 유지).
  - 없으면 → 줄 맨 앞에 `[새태그] ` **삽입**.
- 문서 끝 append 금지(현행이 이미 커서 기반이나, "줄 앞/교체" 규칙으로 정밀화).
- 다중 감정(§6)에서 "선두 태그 교체"는 **줄의 첫 태그**만 대상(줄 중간 태그는 건드리지 않음).

### 4.2 쉼 태그 삽입 (§3)
- 감정 태그와 달리 **커서의 정확한 위치**에 `[쉼] ` 삽입(줄 앞 강제 아님). 선택 영역이 있으면
  대체.

### 4.3 focus / selection / scroll 복원 (§4)
- 삽입 후 caret = 삽입 문자열 끝. `textarea.focus()` + `setSelectionRange(caret, caret)`.
- **scroll 복원 신규:** 삽입 전 `scrollTop/scrollLeft` 저장 → 삽입·리렌더 후 복원(단, caret이
  뷰포트 밖이면 caret이 보이도록 우선). 현행은 scroll 미복원.
- 타이밍: 현행 `requestAnimationFrame` 1프레임 가정을 **재검증**. 제어 컴포넌트라 setState →
  리렌더 후 DOM 반영 시점 보장이 필요(useLayoutEffect로 "다음 커밋 후 1회 복원" 패턴 검토).

### 4.4 IME / 키보드 / 단일 undo (§5) — 가장 주의할 계약
- **IME 조합 중 삽입 금지 큐잉:** `compositionstart`~`compositionend` 사이(한글 조합 중) 버튼
  삽입이 들어오면 조합을 깨지 않게 `compositionend` 후 반영(또는 조합 중 버튼 비활성). 조합
  문자 손실/중복 방지.
- **키보드 접근:** 태그 버튼은 실제 `<button>`(Tab 도달, Enter/Space 작동). 삽입 후 focus는
  textarea로(4.3). 버튼→편집 흐름이 키보드만으로 가능해야 함.
- **단일 undo 계약:** 현행 `setTtsText`(value 통째 교체)는 native undo 스택을 깨서 삽입을
  Ctrl+Z로 되돌릴 수 없음. 계약: **한 번의 태그 삽입 = 한 번의 undo로 원복.** 후보:
  - (a) `document.execCommand('insertText')` — native undo에 편입되나 deprecated(동작은 함).
  - (b) 자체 undo 스택(삽입 전/후 스냅샷) + Ctrl+Z 가로채기 — 제어 컴포넌트와 정합, 구현 큼.
  - Phase 1 판정: **needs-research**(실측 후 (a)/(b) 택1). 계약만 못박고 구현은 통합 후.
- **copy-paste:** 붙여넣기 텍스트에 `[태그]`가 섞여도 파서가 동일 규칙으로 처리(특수 경로 없음).
  overlay는 paste 후 재파싱만 하면 됨.

---

## 5. 소유 파일 · 공유/충돌 지점

### 5.1 이번 사이클이 소유(Agent A가 주도 편집 예정 — Phase 2)
- `src/renderer/components/TTSEditor.tsx` — 태그 삽입 로직, 태그 버튼, overlay 편집기,
  색상 범위 표시, 상태 배지, 전환 모드 표시(§9).
- (신규 가능) `src/renderer/components/EmotionTextEditor.tsx` 류 — textarea+overlay 분리 시.
- 프로토타입: `doc/work-in-progress/prototype/*.mjs` (test-only, 프로덕션 아님).

### 5.2 공유 파일 · 충돌 지점 (⚠️ 단독 변경 금지)
- **`src/renderer/lib/emotions.ts` — 최다 공유.**
  - Python `tts_worker.py:_parse_line`/`EMOTION_TAGS`와 **문법 동형 계약**(smoke가 강제).
    다중 감정/쉼 문법으로 바꾸면 **Python도 동시 변경 필수**(줄당 1태그 → 줄 안 N태그, 쉼 무음).
  - `planEmotionRefs`/`parseUsedEmotionIds`는 ProcessButton 게이팅·E2E가 소비. 시그니처 유지
    권장(내부만 v2 파서로 교체, used 계약 보존).
  - **Agent B/C와 공유 가능성**: 이 파일 문법을 다른 에이전트도 건드리면 충돌. 통합 담당이
    문법 단일 소스를 조율해야 함. → **플래그.**
- **`python/tts_worker.py`** — `_parse_line:1069`, `EMOTION_TAGS:23`, 무음 경로
  `:1021-1030`. Agent A는 **읽기 전용**(제약). 문법/쉼 변경의 Python 반영은 통합 담당 또는
  지정 에이전트. 동기 의무를 계약에 명시.
- **`src/renderer/stores/app.store.ts`** — `ttsText`, `ttsEmotionRefState`,
  `ttsSilenceGap`, `registerEmotionRef`/`setEmotionRefState`. 쉼 태그가 텍스트에 인라인되면
  `silence_gap` 슬라이더와의 관계 재정의 필요(전역 gap vs 인라인 쉼). → 계약 항목.
- **smoke/E2E 테스트** — `_check_emotions()` id 파리티, 게이팅 불변식. 문법 변경 시 회귀 갱신.

---

## 6. 이 기능이 필요로 하는 파서/설정/세션/메타데이터 계약

- **파서 계약:** `parseEmotionSegments`(오프셋 포함) + `parseUsedEmotionIdsV2`(기존 used 계약
  보존)를 emotions.ts의 단일 소스로. TS↔Python 동형. `LABEL_TO_ID`는 `ALL_EMOTIONS` 파생을
  주입(프로토타입 미러 아님). 쉼 토큰 별칭(`쉼`/`pause`)·기본 초·초 지정 문법을 양쪽 합의.
- **설정(config) 계약:** 쉼 기본 길이(현재 프로토타입 0.5s)와 전역 `silence_gap`(줄 경계)의
  관계. 인라인 쉼이 생기면 "줄 경계 gap"과 "인라인 쉼"이 별개 축임을 명문화.
- **세션/직렬화 계약:** 대사는 `ttsText` 문자열 하나에 태그 인라인 → **세션 저장/복원은 문자열
  그대로**면 추가 스키마 불필요(장점). 단 쉼 태그가 세션에 남으므로 구버전 앱이 열면 리터럴로
  보임(하위호환 주의). 파생 상태(색상 범위)는 저장 안 함(파싱으로 재생성).
- **메타데이터 계약:** 결과 metadata에 실제 사용된 감정/쉼 반영 여부(§1.4 게이팅과 별개).
  `_METADATA_KEYS`(`tts_worker.py:802`)에 쉼/다중감정 관련 키 추가가 필요한지 통합 담당 판단.
- **전환 모드(§9) 계약:** "즉시/부드럽게/쉼 후"는 **표시 전용**. 백엔드는 참조 보간 안 함
  (블렌딩 아님). "부드럽게"조차 실제 크로스페이드가 없으면 **표시만** 하거나, 오디오 후처리
  크로스페이드로만 근사할지 통합 담당이 결정. Phase 1은 표시 UI만 설계, 실제 오디오 효과는
  **needs-research**.

---

## 7. 테스트 계획 (§11 필수 목록 전수)

파서 케이스(프로토타입에 구현된 것 = ✅ 통과, 나머지 = Phase 2 편집기 통합 테스트):

- **첫 줄 삽입** — 커서 문서 맨 앞, 태그가 첫 줄 앞에. (편집기 테스트)
- **중간 줄 삽입** — 커서가 중간 줄, 그 줄 앞에 삽입/교체. (편집기)
- **마지막 줄 삽입** — 커서 마지막 줄. (편집기)
- **문장 중간 커서(mid-sentence)** — 감정 태그는 줄 앞으로, 쉼 태그는 그 자리. (편집기)
- **빈 줄** — 빈 줄에서 삽입 시 `[태그] `만. (편집기)
- **기존 선두 태그 교체** — `[기쁨] …`에서 다른 감정 버튼 → `[명랑] …`(중복 태그 안 쌓임). (편집기)
- **다중 줄 선택(multi-line selection)** — 선택 범위 걸친 삽입 동작 정의(첫 줄 앞 적용 등). (편집기)
- **한 줄 다중 감정(§6)** — `[기쁨] … [명랑] …` → 2 범위. ✅ 프로토타입 통과.
- **쉼 정확 위치(§3)** — `안녕[쉼]하세요` 정확 오프셋 + 감정 유지. ✅ 통과.
- **focus/selection/scroll 복원(§4)** — 삽입 후 caret·focus·scrollTop 복원. (편집기, jsdom/e2e)
- **키보드** — 버튼 Tab/Enter 도달, 삽입 후 textarea focus. (편집기, e2e)
- **한국어 IME 조합** — 조합 중 버튼 삽입이 조합을 깨지 않음, 조합 문자 손실/중복 없음. (e2e)
- **copy-paste** — `[태그]` 포함 붙여넣기 후 재파싱 정상. (편집기 + ✅ 파서는 문자열만 봄)
- **단일 undo** — 태그 삽입 1회가 Ctrl+Z 1회로 원복. (편집기, needs-research 구현)
- **알 수 없는/깨진 태그** — 미인식 태그 tagKnown=false·default 귀결, 닫히지 않은 `[`는
  리터럴. ✅ 프로토타입 통과.

추가로 프로토타입이 이미 커버(하위호환 회귀): 한글/영문 태그, 태그만 있는 줄, `[기본]`,
무태그, 중복 태그, 빈/undefined 입력, 색상 오프셋 원문 정합, 복합 시나리오. (총 17/17)

---

## 8. 지금 구현 가능 vs 추가 조사 필요

### 지금 구현 가능(계약 확정만 되면)
- PURE 다중 감정 파서 + used 계약 재현(프로토타입 검증 완료).
- 태그 버튼 → 현재 줄 앞 삽입 / 선두 태그 교체(§1·§2). 현행 커서 기반 로직의 정밀화.
- 쉼 태그 커서 위치 삽입(§3) — **문자열 삽입까지**(백엔드 무음 주입은 별도).
- focus/selection/scroll 복원(§4) — textarea 표준 API.
- textarea + overlay 색상 범위(§7) — 파서 오프셋 기반, 의존성 0.
- 등록/미등록/미준비 상태 배지(§8) — 현행 확장.
- 전환 모드 UI(§9) — **표시 전용**.

### 추가 조사 필요(needs-research)
- **단일 undo 계약(§5)** — execCommand(deprecated) vs 자체 undo 스택. 실측 필요.
- **IME 조합 중 삽입 큐잉 정확 동작** — 브라우저/Electron 실측.
- **쉼 태그 백엔드 무음 주입** — `_parse_line`/합성 경로 변경(Python), 인라인 쉼 vs 전역
  `silence_gap` 관계. 통합 담당·Python 담당 필요.
- **DIVERGENCE-1(줄 중간 태그) 마이그레이션** — 기존 문서 리터럴 `[...]` 충돌 범위 조사,
  이스케이프 도입 여부.
- **전환 모드 "부드럽게"의 실제 오디오 효과** — 보간 없음(블렌딩 아님). 후처리 크로스페이드로
  근사할지 여부. 기본은 표시 전용.
- **CodeMirror 6 채택 여부** — 지금은 미채택. 초장문/성능 이슈 시 재검토(설치 승인 필요).

---

## 9. 감정 경계 전환 모드 (§9) — 표시 전용 설계

- 모드: **즉시 / 부드럽게 / 쉼 후.**
- 색상 오버레이에서 감정 범위 경계에 모드 표식을 보임(예: 즉시=날카로운 경계선,
  부드럽게=짧은 그라디언트 표식, 쉼 후=쉼 아이콘).
- **경고:** 색 그라디언트는 시각 표현일 뿐 **실제 감정 블렌딩이 아니다.** 백엔드는 참조를
  보간하지 않는다. UI 문구는 "감정 전환"만 사용. "부드럽게"는 표시이며, 실제 오디오 크로스페이드
  적용 여부는 계약/추가 조사 대상(§6·§8).

---

## 10. 승인 요청 의존성

- **CodeMirror 6 (`@codemirror/*`)** — 채택 **안 함**(추천 A는 의존성 0). 기록만: 향후 초장문
  편집/데코 성능이 문제되면 대안. 지금 **설치 요청 아님(await approval).**
- 그 외 신규 npm/Python 패키지 **없음.**
