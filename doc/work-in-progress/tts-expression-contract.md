# TTS 표현 사이클 공용 계약 (D) — design/tts-expression-contract

기준: origin/develop `b933ab5`(검증된 통합 기준선). 안정 릴리스선 = master `ca42b0e` + v1.0.0(불변).
성격: **문서 전용 design 계약**. production src/python 변경 0, A/B/C 브랜치 병합 0. 필요 시 language-neutral JSON conformance fixture 초안만 동반.
이 문서는 A(feature/tts-emotion-editor)·B(feature/tts-boundary-pause)·C(research/tts-expression-ux) phase-1 계획을 취합해 공용 계약으로 확정하기 위한 것이며, 아래 12개 필수 정정이 이전 계획의 상충 표현을 **supersede**한다.

> ★B 계획 root-cause 표현 supersede(권위 문구): **"최종 tail 처리 부재는 코드상 유력한 발생 경로이며 synthetic WAV에서 재현됐다. 실제 사용자 출력과의 동일성은 청취 또는 승인된 진단 전 미확인이다."** B 브랜치 계획 문서의 "root cause" 단정은 이 문구로 대체된다(B 커밋 amend 없음).

---

## 정정 1 — 감정/쉼 태그 삽입 위치 (커서 기준, 대사 무손실)

최신 사용자 요구가 권위. 감정 태그를 무조건 현재 줄 선두에 넣지 않는다. **기본 동작 = 현재 caret 위치 삽입.**
예: `[기쁨] 안녕하세요. |오늘 날씨가 좋아요.` → 명랑 클릭 → `[기쁨] 안녕하세요. [명랑] |오늘 날씨가 좋아요.`

규칙(계약):
- 선택 없음: 정확한 caret 위치에 감정 태그 삽입.
- caret 바로 앞/뒤에 기존 감정 태그가 있으면 **교체**(중복 방지).
- 줄 선두 감정 태그 영역 안에서 선택하면 기존 선두 태그 교체.
- **선택 영역이 있어도 사용자 대사 문자열을 삭제하지 않는다**(A의 기존 "선택 범위 대체" 제안은 대사 손실 위험으로 **기각**).
- 여러 줄 선택 시: 선택된 **비어 있지 않은 각 줄**에 감정 적용(각 줄의 삽입 지점 규칙은 §미결정 D-1에서 확정).
- 쉼 태그도 선택 텍스트를 삭제하지 않고 caret(또는 selection end)에 삽입.
- 태그 버튼 클릭으로 textarea가 blur되기 전에 selection을 보존(mousedown preventDefault 또는 사전 캡처).
- 삽입 후 focus·selection·scroll 복원.
- IME composition 중이면 `compositionend` 후 실행(조합 중 삽입 큐잉).

## 정정 2 — unknown tag 정책 (조용한 default 금지)

`알 수 없는 태그 → default로 조용히 귀결`은 **금지**. 예: `[명란] …`(오타 가능) → 조용히 기본 감정 합성 금지.
- 알려진 감정 태그 = control token. 알려진 쉼 태그 = control token.
- control-tag 형식을 갖췄으나 unknown인 태그 → **UI inline warning + 합성 차단 `UNKNOWN_TTS_TAG`**.
- 닫히지 않은 대괄호 등 일반 malformed 텍스트 → **리터럴 유지**(발음 텍스트로 취급).
- unknown tag를 제거하지도, default로 조용히 바꾸지도, 발음하게 두지도 않는다.
- 오류 payload에는 **tag id와 offset만**. 전체 대사 전문은 로그·metadata에 넣지 않는다.
- (control-tag "형식"의 정의 = `^\[\s*<식별자>(\s+<인자>)?\s*\]` 형태. 식별자가 감정 label/id도 쉼도 아니면 unknown.)

## 정정 3 — parser 권위 (dual parser + fixture parity)

"emotions.ts 단일 권위 + Python 동형"은 성립하지 않음(Python은 TS 파일을 소비하지 않음). 계약:
- **언어 중립 문법 명세가 권위**(이 문서 §문법 명세).
- `parser_version` 명시(예: `1`).
- **공용 JSON conformance fixture가 권위 있는 테스트 벡터**(초안: `doc/work-in-progress/contract/tts-grammar-conformance.draft.json`).
- TS parser와 Python parser는 **각각 구현**하고, **둘 다 동일 fixture를 통과**해야 함.
- 두 구현의 출력이 정확히 일치: **raw offset · spoken text · emotion id · pause(sec) · original line index**.
- **Python parser가 실제 합성 권위.** renderer parser는 시각 preview이며, Python 결과와 parity가 깨지면 **합성 차단**(preview_parity_mismatch).
- metadata에 `parser_version` · `parsed_plan_sha8`(파싱 결과의 정규화 직렬화 해시) · segment 수 · chunk 수 기록. **대사 전문은 metadata에 기록하지 않는다.**

전달 방식 비교(§미결정 D-2에서 확정):
- **A. raw ttsText 전달 + TS/Python dual parser + 공용 fixture parity** — 현재 구조 변경 위험 최소. **1차 권장.** 단 fixture parity가 필수.
- B. canonical parsed plan(JSON) 전달 + Python 검증 — 직렬화 스키마 신설·구조 변경 큼.
→ 1차 권장 A. renderer가 preview를 아예 배포할지(§미결정 D-3)는 별도.

## 정정 4 — 쉼 문법 (모호성 제거)

canonical: `[쉼 0.2]` `[쉼 0.5]` `[쉼 1.0]`.
- 단위 초. 소수점 `.`만(로케일 `,` 불가).
- 허용 범위 **0.05 ~ 5.0초**.
- 범위 밖·NaN·음수·형식 오류 → **`INVALID_PAUSE_TAG`**(조용한 clamp 금지).
- alias: `쉼`/`pause`(둘 다 허용, id는 `pause`).
- 인접 쉼 태그 중복 정책: §미결정 D-4에서 "오류" vs "하나로 정규화" 확정(초안: 인접 중복은 **정규화하지 않고 각각을 명시 pause로 보되, 같은 경계에 2개 이상이면 `INVALID_PAUSE_TAG`**로 제안).
- 명시적 쉼은 **해당 경계의 자동 gap을 대체(override)하며 합산하지 않는다**.
- 일반 space·여러 space는 시간 간격이 아니다.
- metadata: `explicit_pause_count` · `total_pause_ms` 가능. **전체 대사 전문 금지.**

## 정정 5 — 감정 전환 지원 범위 (1차)

1차 실제 지원: **immediate, pause**. 미지원: **smooth/crossfade emotion blending.**
- `부드럽게`는 추가 synthetic 연구 + 청취 검증 전 활성화 금지.
- 색 그라데이션은 실제 음성 혼합으로 표현하지 않음("감정 전환" 표시일 뿐).
- UI 활성: **즉시 전환 / 쉼 후 전환**만. smooth는 숨기거나 `연구 중`으로만 기록, production UI 미노출.

## 정정 6 — 오디오 처리 순서 (최종 tail은 pitch 뒤)

최종 tail은 pitch 앞이 아니라 **모든 pitch/speed 처리 뒤**. 계약 순서:
1. Qwen chunk 생성
2. chunk별 speed 처리
3. 내부 chunk 경계 결합
4. original segment·emotion·explicit pause 적용
5. **전체 결과 pitch 후처리**
6. **최종 tail de-click/fade**
7. **최종 tail padding**
8. sr / mono / non-empty / finite / peak 검증
9. pending → synthesized.wav **원자 교체**

이유: pitch/rubberband가 fade·padding 길이·끝 샘플을 다시 변형하지 않게 하고, 최종 파일의 마지막 샘플을 게시 직전에 검증하기 위함.
구현 위치 비교(§미결정 D-5): 기존 `place_final_with_pitch` 확장 vs 신설 `audio_finishing` 모듈. **1차 권장 = 신설 `python/audio_finishing.py`(통합 담당 소유), `pitch_shift.py`는 무변경.** B는 `pitch_shift.py`를 임의 수정하지 않는다(소유권 통합 담당).

## 정정 7 — 1차 B 구현 범위 축소

1차 production: final tail auto · 조건부 짧은 fade · tail padding · explicit pause · emotion boundary **immediate|pause** · 원자 보존·검증·metadata.
후속 연구: 내부 chunk zero-cross 이동 · 내부 crossfade · smooth emotion transition.
- 내부 crossfade는 음성 중첩·길이 변화·타임스탬프 변화 위험 → **청취 검증 전 기본 적용 금지.**

## 정정 8 — legacy/session 호환 (충돌 해소)

"신규 설정 부재 = 현행 동작"과 "새 UI 기본값 tail auto"의 충돌을 구분:
- **legacy session(필드 없음)**: 기존 동작 보존(재현 안정). tail 미적용 상태로 재현 — 조용히 바뀌지 않는다. (또는 명시적 migration 안내; §미결정 D-6.)
- **new session**: `tail_mode = auto` 기본.
- `session_schema_version`(또는 `migration_version`) 기록.
- 구 session을 여는 것만으로 기존 재현 결과가 조용히 바뀌지 않는다.
- 구 session에서 **신규 합성**을 시작할 때 migration 안내 여부는 §미결정 D-6.

## 정정 9 — 빠른 재처리 (1차 미노출)

raw pre-postprocess 결과를 영속 보존하지 않으므로 `빠른 재처리`를 구현된 기능으로 표현하지 않는다.
- pitch/speed/tail은 **이론적으로** 빠른 재처리 가능.
- 실기능화에는 base/raw 결과 수명 · 원자 저장 · session 연결 계약 필요.
- **1차 UI에서 `다시 합성 없이 적용` 버튼 미노출.** 후속 기능으로 분리.

## 정정 10 — 편집기 기술 표현 (IME 100% 금지)

textarea+overlay가 한글 IME를 "100% 보장"한다고 표현하지 않는다. 정확한 표현:
- 실제 입력은 기존 textarea가 담당 → contenteditable보다 IME 위험이 **낮음**.
- overlay의 scroll/wrap/font/zoom 동기화는 **별도 위험**.
- 800×600 · 125/150% · 긴 대사 · 한글 조합 · selection · scroll Electron E2E 통과 전 **채택 확정 금지**.
- CodeMirror 설치는 여전히 **승인 대기 후보**(장문 성능 필요 시).

## 정정 11 — 컴포넌트 소유권

- `EmotionScriptEditor.tsx` — **A**
- `EmotionReferenceManager.tsx` — **C**
- `ExpressionControls.tsx` — **C**
- `TtsVoiceSection.tsx` — **C**
- `TTSEditor.tsx` — **통합 담당**(shell/배선만)
- emotions parser module(`emotions.ts` 등) — **A**
- `globals.css` — **C**
- `ttsConfig` / session / metadata / `ProcessButton.tsx` / `TtsResultInfo.tsx` — **통합 담당**
- `tts_worker` / `audio_finishing` — **B**
- `pitch_shift.py` — **통합 담당 승인 없이 변경 금지**

→ TTSEditor.tsx를 A·C가 동시에 수정하지 않는다(패널 분리로 경계 확정).

## 정정 12 — 통합 방식 (A→B→C 직접 develop 병합 금지)

1. **D 계약 문서 확정**(본 문서 승인).
2. `feature/tts-expression-integration`을 최신 develop `b933ab5`에서 생성.
3. **통합 담당이 공용 scaffold/types/parser fixture를 먼저 구현**(빈 컴포넌트 shell, ttsConfig/metadata 타입, JSON fixture를 실제 테스트 경로로 이동·배선).
4. A/B/C가 scaffold를 받은 뒤 각자 production 구현.
5. A → B → C를 **expression integration에 `--no-ff` 병합**(각 단계 게이트).
6. 전체 Electron·synthetic·회귀·**승인된 실제 Qwen** 검증.
7. 검토·승인 후에만 expression integration → develop(`--no-ff`).
8. master는 별도 릴리스 승인 전 불변.

각 단계 테스트 게이트: A=파서 TS/Python fixture parity 단위 + emotions.test + smoke id parity / B=synthetic tail·경계 단위 + K2 취소·원자보존 회귀 / C=GPU 없는 Electron E2E(IA·a11y·800×600·125/150%) + 기존 회귀 / 최종=전체 회귀 + (tree 비동일 시) 승인 후 최소 실 Qwen.

---

## 문법 명세 (언어 중립, parser_version=1)

- 입력 = 단일 `ttsText`(여러 줄, `\n` 구분). 각 줄은 0개 이상의 control token + spoken text.
- control token 형식: `\[\s*<name>(\s+<arg>)?\s*\]`.
  - `<name>`이 감정 label(한글) 또는 감정 id(영문)면 emotion token(id = LABEL_TO_ID[name]).
  - `<name>`이 `쉼` 또는 `pause`면 pause token(arg = 초, 정규식 `^[0-9]+(\.[0-9]+)?$`, 범위 0.05–5.0).
  - control-tag 형식이나 name이 감정·쉼 어느 것도 아니면 → `UNKNOWN_TTS_TAG`(offset·raw name 포함, 합성 차단).
  - pause arg가 형식/범위 위반 → `INVALID_PAUSE_TAG`(offset·raw arg 포함, 합성 차단).
- control-tag 형식을 못 갖춘 `[`, `]` 등 → 리터럴 spoken text.
- emotion token은 이후 다음 emotion token(또는 줄 끝)까지의 spoken text에 적용(§7 색 범위 = 이 구간).
- parsed plan(정규화): 배열 of segment `{ original_line_index, raw_start_offset, raw_end_offset, emotion_id, spoken_text, pauses:[{offset, seconds}] }`. spoken_text는 control token 제거 후 텍스트. `parsed_plan_sha8` = 이 정규화 JSON(offset·id·seconds·line index만; **spoken_text 제외**)의 sha256[:8].
- unknown 감정은 default로 강등하지 않음(정정 2). `default`/`narration` 등 알려진 id만 emotion token.

## metadata 계약(비민감만)

`parser_version` · `parsed_plan_sha8` · `segment_count` · `chunk_count` · `explicit_pause_count` · `total_pause_ms` · `tail_mode` · `tail_pad_ms` · `tail_fade_applied` · `internal_boundary_mode` · `emotion_boundary_mode` · `session_schema_version`. **대사 전문·전사 전문·오디오 바이트 금지.**

## config/session 필드(초안, 기본값=현행 보존)

config: `ttsTailMode`(auto|off, new=auto/legacy=off) · `ttsTailPadMs`(120) · `ttsTailFadeMs`(8) · `ttsInternalBoundary`(join|zerocross, 1차 join) · `ttsEmotionBoundaryMode`(immediate|pause, 기본 pause) · preset id · `세부 조절 사용`(bool) · `설정 설명 표시`(bool).
session: 단일 ttsText(인라인 태그) 유지 + 위 UI 설정 스냅샷 + `session_schema_version`.

---

## 미결정(숨기지 않음 — 승인 필요)

- **D-1 다중 줄 선택 감정 적용**: 각 선택 줄의 삽입 지점(줄 선두 vs 각 줄 caret 상당) 정확 규칙. (초안: 각 줄 선두에 emotion token 삽입/교체, 대사 무손실.)
- **D-2 전달 방식 A vs B**: 1차 권장 A(raw + dual parser + fixture parity). 확정 필요.
- **D-3 renderer preview 배포 여부**: 1차에 live 색-범위 preview를 배포할지, 아니면 Python-only 파싱 + 최소 표시로 parity 위험을 줄일지.
- **D-4 인접 쉼 중복**: 오류 vs 정규화. (초안: 같은 경계 2개↑ → INVALID_PAUSE_TAG.)
- **D-5 audio_finishing 위치**: 신설 모듈(권장) vs place_final_with_pitch 확장.
- **D-6 legacy session tail**: 기존 동작 보존만 vs 신규 합성 시 migration 안내.
- **D-7 parsed_plan_sha8 입력 정의**: 위 §문법 명세의 정규화(spoken_text 제외)로 제안 — 확정 필요.
- **D-8 편집기 채택**: textarea+overlay는 §정정10 E2E 통과 전 미확정. CodeMirror는 승인 대기.
- **D-9 빠른 재처리 base/raw 보존 계약**: 후속 사이클로 분리(1차 미노출) 확정.

## 산출물·불변
- 본 계약 문서 1개 + JSON conformance fixture 초안 1개.
- production 변경 0 · A/B/C 브랜치 변경·병합 0 · 신규 dependency 0.
- master `ca42b0e`·v1.0.0 불변 · develop `b933ab5` 불변.
