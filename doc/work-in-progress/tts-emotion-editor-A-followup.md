# Agent A 산출 요약 + 통합 검토 인수 노트 (feature/tts-emotion-editor)

기준: S1 scaffold(`66ac44c`)를 `--no-ff` 병합한 뒤 production 구현. parser_version=2. master/v1.0.0·develop 불변, expression-integration 미병합.

## 구현한 것 (owned 파일만)
- `src/shared/ttsGrammar.ts` — 실제 v2 파서 채움(S1 타입/상수 유지). 인라인 다중 감정, 명시적 쉼, escape(`\[`/`\]`/`\\`),
  unknown/ malformed 분류, 빈 감정 구간, dual offset(ui UTF-16 / text code-point 이원화, 혼용 금지),
  경계 우선순위(explicitPause > lineSilenceGap > emotionBoundaryPause > internal, 합산 금지),
  canonical plan 해시(정수 ms·spoken_text 전체 SHA256·UTF-8 byte length·정렬 canonical JSON), 순수 JS SHA-256(무의존).
  감정 vocab은 주입식(`resolveEmotion`), 기본표 `TTS_EMOTION_LABEL_TO_ID`는 tts_worker.EMOTION_TAGS 거울.
- `src/shared/ttsGrammar.test.ts` — fixture parity(valid 13/error 8) + 이모지 surrogate offset + resolver 주입 + 고정 해시 벡터.
- `src/shared/ttsGrammar.parity-hashes.json` — TS==Python 증명용 고정 canonical-hash 벡터(양 언어 테스트가 동일 리터럴 검증).
- `src/renderer/lib/emotions.ts` — `EMOTION_LABEL_TO_ID`/`EMOTION_ID_TO_LABEL` export, `resolveEmotionId`,
  `emotionTagText`, 순수 삽입 helper `insertEmotionTag`/`insertPauseTag`(대사 무손실, 인접 교체, 다중 줄, 인접 중복=오류).
  ttsGrammar는 **타입만** import(런타임 leaf 유지 → node --test 가능).
- `src/renderer/lib/emotions.test.ts` — 삽입/교체/다중 줄 무손실/쉼 삽입/범위·인접 오류 회귀.
- `src/renderer/components/EmotionScriptEditor.tsx` — textarea(입력 권위)+aria-hidden 색상 overlay, IME compositionend flush,
  selection/scroll 복원, 감정 구간 색(혼합 아님), unknown/오류 표시, 사용 감정 범례(+optional refStates 배지). smooth 없음.
- `python/tts_grammar.py` — TS와 동형 파서(stdlib, numpy 불요). `python/test_tts_grammar_parity.py` — fixture + 고정 해시 재현 + ast 드리프트 가드.

## 로컬에서 실제로 RUN한 검증 (이 worktree, 의존성 설치 없음)
- `node --test src/shared/ttsGrammar.test.ts` → 24/24 pass.
- `node --test src/renderer/lib/emotions.test.ts` → 25/25 pass.
- `node --test src/shared/ttsGrammar.contract.test.ts` (S1) → 8/8 pass(회귀 없음).
- `python -m unittest test_tts_grammar_parity` → 8/8 pass(고정 해시 12벡터 TS==Python, tts_worker 감정표 드리프트 가드 포함).
- 순수 SHA-256 == node:crypto(경계 길이·유니코드·이모지 확인).

## 통합 검토가 shared env에서 확인해야 하는 것 (여기서 RUN 불가 — 미claim)
- `npm test` 전체(`src/**/*.test.ts`) + `tsc`(node/web) 타입체크 + build: node_modules 필요.
- `EmotionScriptEditor.tsx` 실제 렌더/동작(React 19): JSX는 node type-strip 대상이 아니라 미실행. 컴포넌트 동작·overlay 정렬·
  IME·800×600·125/150%·스크롤 동기화 E2E는 **D-8 gate로 통합 검토 소유**(채택 확정 전).
- `PARSER_PARITY_MISMATCH`는 런타임 교차검증(renderer full sha256 vs Python 재파싱) — 단위 파싱 케이스 아님. 통합 배선에서 검증.

## 명시적 미완/경계
- **실제 Electron TTSEditor-연결 E2E는 미수행(shell 배선 대기).** 단위/컴포넌트 수준을 "full UX 완료"로 부르지 않음.
- TTSEditor/app.store/ttsConfig/ProcessButton/TtsResultInfo/audio.ipc/tts_worker/audio_finishing/pitch_shift·session/metadata 배선은
  통합 담당/B 소유 — 본 브랜치 미변경.
- 다중 줄 선택 재-selection 범위는 순수 helper 수준 검증만; 실제 textarea undo/paste/스크린리더는 shared env E2E 필요.
