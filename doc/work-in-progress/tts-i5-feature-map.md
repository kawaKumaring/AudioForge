# I5-a — 현재 TTSEditor 기능 지도 (재조립 무손실 기준)

목적: TTSEditor(634줄) 모놀리스를 4-flow shell(Voice / Script / Expression / Synthesize)로 재조립할 때
**어떤 기능도 삭제되지 않도록** 현재의 모든 기능·상태·effect·핸들러를 목록화하고, 각 항목이 옮겨갈 대상 컴포넌트를 못박는다.
이 문서가 I5-a~c 구현의 체크리스트다. (컴포넌트 소유: A=EmotionScriptEditor / C=TtsVoiceSection·EmotionReferenceManager·ExpressionControls / 통합=TTSEditor shell·ProcessButton·session·metadata.)

## 1. 로컬 상태 (useState)
- `ttsText` / `ttsSpeed` / `ttsSilenceGap` / `ttsPitch` / `ttsEngine` — store로 동기(effect L39). **직렬화·동기 유지.**
- `showEmotionSetup` / `showRefPrompts` / `showAdvanced` / `showAllTags` / `showUnregistered` — 접기 상태(패널 펼침). I5-c에서 "고급 기능 활성화"와 "패널 펼치기"를 별도 상태로 취급.
- `refPrompts`(Record<id,TtsReferenceEntry>) — 참조 전사 override. store.ttsReferencePrompts로 동기.
- `txLoading`(전사 중 id) / `preflight`(Qwen 상태) / `collapsedRefs`(감정별 구간 패널 접힘).
- `textareaRef` — caret/selection/scroll 권위(입력 textarea). I5-b 편집기 동작의 핵심.
- `pitchCap`(=store.ttsPitchCapability, 단일 소스) / `disabled`(status==='processing').

## 2. store 연결 (읽기/쓰기)
- 읽기: mode, status, fileInfo, ttsEmotionRefState, ttsPitchCapability.
- 쓰기/액션: registerEmotionRef, removeEmotionRef, setEmotionRefState, setTtsRefState, setTtsPitchCapability.
- effect(L39): ttsText/Speed/SilenceGap/Pitch/refPrompts/Engine → store.setState. **single source·session restore와 충돌 금지.**
- I3 신규: ttsTailMode/PaddingMs/FadeMs/EmotionBoundaryMode/EmotionBoundaryPauseMs + setTtsExpression (ExpressionControls가 바인딩).

## 3. effect
- preflight(L44, mount 1회, mode==='tts'): window.api.audio.qwenPreflight → 예상 상태 배지.
- pitch capability(L55): window.api.audio.pitchPreflight → setTtsPitchCapability(정규화 금지, 직접 소비).
- store 동기(L39).

## 4. 핸들러 (기능 — 삭제 금지)
- `insertEmotionTag(label)`(L85): caret/선택 위치에 `[label] ` 삽입, 줄 선두 보정, rAF로 focus+selection 복원. → **I5-b: A의 EmotionScriptEditor onInsertEmotion으로 이동(caret 권위 유지, 문서 끝/항상 줄선두 금지).**
- `stampFingerprint(id, source)`(L76): 수동 전사 확정 시 source 지문 stamp(§4 stale 방지).
- `autoTranscribe(id, path)`(L108): window.api.audio.transcribeReference → autoText/autoLang/autoStatus. 실패 UI 표시.
- `useAutoAsManual(id, source)`(L134): 자동→수동 복사 + mode manual + stamp.
- `onManualEdit(id, text)`(L140): manualText 편집, 비면 auto 복귀.
- `onRefFreeToggle(id, checked)`(L144): ref_free 토글.
- `handleEmotionFile(emotionId)`(L150): window.api.audio.selectFile → registerEmotionRef. → **EmotionReferenceManager.requestSource 주입.**
- `toggleCollapse(id)`(L167): 감정별 구간 패널 접힘.
- `updateRef(id, patch)`(L70): refPrompts 병합.

## 5. 파생/계산
- usedIds(parseUsedEmotionIds), registered/unregistered/used 감정 집계, registeredCount/readyCount/needsConfirmCount/usedCount.
- pitch gate: pitchSupported/pitchProbedUnsupported/pitchUnknown/pitchDisabled (capability=false면 슬라이더 비활성+사유). **보존(계약 G).**

## 6. 렌더 블록 → 4-flow 배치 (무손실 매핑)
| 현재 블록(줄) | 기능 | → flow / 컴포넌트 |
|---|---|---|
| 기본 ReferenceRegionPanel(L180) | 기본 참조 분석·3~10초 구간·파생 클립 | **Voice** / TtsVoiceSection + renderRegionEditor(ReferenceRegionPanel 재사용) |
| Guide(L190) | 참조 음성 설명 | **Voice** / TtsVoiceSection showSettingHelp(접기·도움말) |
| preflight 배지(L201) | Qwen 예상 상태 | **Voice** 또는 Synthesize 상단 정보 |
| 감정별 음성 등록(L221~357) | 등록/미등록·구간 패널·상태 요약 | **Voice**(또는 Script 인접) / EmotionReferenceManager + renderRegionEditor |
| 참조 전사(L361~456) | auto/manual/ref-free·언어 | **Voice** / TtsVoiceSection 하위(전사 서브패널) — 소유 경계상 shell이 배치 |
| 대사 입력 textarea + 태그 삽입(L458~524) | 대사·감정 태그 삽입·예문 | **Script** / A EmotionScriptEditor(onChange/onInsertEmotion/onInsertPause/parsedPreview/parseErrors) |
| 고급 설정: 엔진(L533) | 엔진 직접 선택 | **Expression** 또는 Synthesize 고급 / ExpressionControls 인접(엔진은 표현축 아님 — shell가 별도 배치) |
| 고급: 속도·간격·음높이(L558~629) | speed/silence_gap/pitch + capability gate | **Expression** / ExpressionControls values(speed·sentenceGap·pitch) + I3 tail/emotion-boundary 신규 축 |

## 7. 무손실 주의 (계약 §"기능 삭제 금지")
- 참조 전사(auto/manual/ref-free·언어·지문 stamp)는 신규 패널 props에 직접 대응이 없다 → **shell이 TtsVoiceSection 하위에 그대로 배치**(삭제·통합 금지). 소유 경계상 판단 불가 지점이면 중단 보고.
- 엔진 직접 선택은 표현축(ExpressionControls)이 아님 → shell이 고급 영역에 별도 배치.
- pitch capability gate·generation retry·cancel lifecycle·single-flight·reset·session restore·참조 클립 수명 = **무변경**.
- preflight/전사/감정참조 파일선택은 기존 window.api 흐름 재사용(requestSource/renderRegionEditor 주입).

## 8. 진행 순서 (각 단계 = 작은 독립 커밋 + npm test·tsc·build·관련 E2E)
- I5-a: 이 지도 + shell 배치·배선(편집 동작 신규 추측 금지, A/C 컴포넌트 실제 props 연결).
- I5-b: 편집기 동작(caret/선택/인접교체/다중줄/IME/focus·scroll 복원/aria/gradient 문구/오류 code).
- I5-c: 반응형·접근성·정보 정리(고급≠펼침, capability=false 비활성+사유, smooth/formant/가성/가창/빠른재처리 미노출).
- PHASE 4: GPU-free Electron E2E 매트릭스.
