# 표현 사이클 S1 — 공용 scaffold (타입·계약 전용, 동작 변화 0)

기준: feature/tts-expression-integration(D+A+B+C 병합, parser_version=2). 이 단계는 **타입·계약·fixture·계약 테스트만** 추가하고
runtime production behavior를 바꾸지 않는다. 실제 parser/삽입/overlay/합성 배선은 Agent A/B 구현 단계.

## S1 산출물
- 권위 fixture: `test/fixtures/tts-grammar-conformance-v2.json`(draft를 승격, parser_version=2, case id 유일, valid 13/error 8). draft(`doc/work-in-progress/contract/tts-grammar-conformance.draft.json`)는 역사 기록으로 유지.
- shared 문법 타입: `src/shared/ttsGrammar.ts`(TTS_PARSER_VERSION=2, error code union, ParsedEmotionSegment/PauseBoundary/TransitionBoundary/ParsedPlanSummary/ParsedPlan, DualOffset, full sha256 vs sha8 brand 타입). **parser 구현 없음.**
- config 타입 계약: `src/shared/ttsConfig.ts` `TtsInputOptions`에 optional 필드만 추가(§아래). **buildTtsConfig·session·metadata·Python 전달 무변경.**
- 컴포넌트 props 계약: `src/renderer/types/ttsExpression.ts`(EmotionScriptEditor/EmotionReferenceManager/ExpressionControls/TtsVoiceSection props). **빈/가짜 컴포넌트 없음.** 미구현 축은 `ExpressionCapabilities`로 false 표현. smooth/formant/brightness/breathiness/falsetto 타입 없음.
- 계약 테스트(파서 parity 아님): `src/shared/ttsGrammar.contract.test.ts`(TS) + `python/test_tts_grammar_contract.py`(stdlib). 같은 fixture 소비, shape만 단언.

## config 타입 계약(추가된 optional 필드 — 미배선)
`ttsParserVersion?: 2` · `ttsParsedPlanSha256?` · `ttsTailMode?: 'off'|'auto'` · `ttsTailPaddingMs?` · `ttsTailFadeMs?` ·
`ttsEmotionBoundaryMode?: 'immediate'|'pause'` · `ttsEmotionBoundaryPauseMs?` · `ttsExpressionFineTuneEnabled?` ·
`ttsExpressionPresetId?` · `ttsShowSettingHelp?`. **이번 S1에서 buildTtsConfig 반환·기본값·Python config·session·metadata에 반영하지 않는다(동작 0).**

## audio_finishing API 계약 (S1에서 모듈 미생성 — API만 고정)
> 이 계약은 이전 scaffold 보고의 `validate_final(path)`(순수 계산 + 파일 I/O 혼합) 표현을 **supersede**한다.
> 순수 array 함수와 파일 I/O를 분리한다. 실제 `python/audio_finishing.py` 구현은 **Agent B** 담당.

순수 함수(파일 I/O 없음 — array in/out, 결정적):
- `compute_tail_plan(samples: np.ndarray, sr: int, cfg) -> TailPlan`
  - 마지막 최대 5ms 구간 peak ≤ 1e-4 → 이미 무음 판단. 반환: `{ fade_ms, pad_ms, already_silent }`(§추가5 초기값).
- `apply_final_tail(samples: np.ndarray, sr: int, plan: TailPlan) -> np.ndarray`
  - already_silent면 fade 없이 pad만. 아니면 `min(fade_ms, len)` cosine fade-to-zero 후 정확한 0 샘플 pad. 같은 배열에 두 번 적용 금지(호출자 단계 권위).
- `validate_audio_array(samples: np.ndarray, sr: int) -> AudioStats`
  - `{ channels, samplerate, frames, finite, peak }` 순수 계산. **파일 경로를 받지 않는다.**

파일 I/O·원자 교체(호출자 = `tts_worker`, audio_finishing 밖):
- tts_worker가 pending WAV read → array → 위 순수 함수 적용 → write pending → `os.replace(pending, synthesized.wav)`.
- 처리 순서(§D-5 확정): 생성 → chunk speed → 내부 결합 → line/emotion/explicit pause → **전체 pitch** → final conditional fade → final tail padding → 최종 검증(validate_audio_array) → 원자 교체.
- `pitch_shift.py`는 무변경(통합 담당 승인 없이 변경 금지). 내부 crossfade는 S1·B 1차 범위 밖(청취 검증 전 기본 적용 금지).

## 동작 변화 0 근거(S1 검증 대상)
- `buildTtsConfig` 반환 리터럴 무변경(TtsConfig 타입 미변경, 입력 optional 필드는 읽지 않음).
- session 직렬화·result metadata·Python job config 무변경.
- 신규 컴포넌트/DOM 없음. 신규 dependency 없음.

## A/B 구현 시 사용할 정확한 소유 파일
- A(감정 편집기·parser): `src/shared/ttsGrammar.ts`(parser 구현 채우기) · `src/renderer/components/EmotionScriptEditor.tsx`(신규) · TS parser parity 테스트(fixture 소비) · `python/` TS와 동형 parser + `python/test_tts_grammar_parity.py`.
- B(오디오 finishing): `python/audio_finishing.py`(신규, 위 API) · `python/tts_worker.py`(파일 I/O·원자 교체·순서 배선) · synthetic 테스트. `pitch_shift.py`는 통합 승인 필요.
- C(UI/IA): `src/renderer/components/{EmotionReferenceManager,ExpressionControls,TtsVoiceSection}.tsx`(신규) · `src/renderer/components/TTSEditor.tsx`(통합 담당 shell와 협의) · `src/renderer/styles/globals.css`.
- 통합 담당: `src/shared/ttsConfig.ts`(배선) · session/metadata · `TTSEditor.tsx` shell · `ProcessButton.tsx`/`TtsResultInfo.tsx` · `test/fixtures/*` · `pitch_shift.py` 변경 승인.
