# WIP — TTS 참조 구간 선택(긴 참조 3~10초) + GUI/UX

브랜치: `feature/tts-reference-region-ux` (base: 안정 `19f777c`, master는 병합 금지 — 별도 승인)

## 목적
합성 백엔드는 완료. GUI/UX를 보완한다. 특히 10초 초과 참조를 오류로 거부하지 않고 "참조 원본"으로
수용해, 파형에서 3~10초 구간을 골라 그 구간만 mono/24kHz 파생 WAV로 만들어 전사·합성에 쓴다.
원본은 절대 변경하지 않는다.

## 상태
- **완료(커밋됨)**
  - `7e5ba82` — P0 참조 구간 선택 + 게이팅 + 문구 정정.
  - `90a476a` — 파생 참조 임시폴더 수명 관리(refclip-cleanup) + 111초 실파일 재검증.
  - `a17020f` — **P1-1** 결과 재현 메타데이터(session/result, 전사 전문 미기록).
  - `e441fa6` — **P1-2** 결과 GUI(실제 엔진·장치·참조 방식·구간·폴백·소요 시간). ⚠커밋 제목에 `@` 오타(본문 정상, 정책상 amend 안 함).
  - `0f72671` — **P1-3** Qwen preflight 상태 표시(예상값, 실행 결과 metadata가 최종).
  - `fe1f17b` **P1-4** 고급 설정 정리(엔진·속도·간격 → 고급 접이식) + 감정 태그 자주쓰는것+더보기.
  - `da9325b` **초기화 race 수정**: analyze-reference/qwen-preflight를 previewGuard에서 분리(읽기 전용),
    single-flight(preflight 공유 / analyze 파일별). transcriptPreviewGuard·referenceTrimGuard 분리. randomUUID.
  - (새 커밋) **P0 검은 화면 수정 + Electron E2E**: 근본 원인 = `runPreview`가 result에서 `data.transcript`만
    꺼내 analyze/trim/preflight의 최상위 payload를 유실 → `analysis.duration_sec` undefined → `fmt()` 크래시 →
    React 언마운트 → 검은 화면(#0a0a0f). 수정: runPreview가 transcript 래핑 있으면 그것, 없으면 type 제외 전체
    payload를 반환. 방어: fmt null-safe + analyze payload 검증(실패 시 "다시 분석"). renderer ErrorBoundary(검은
    화면 대신 오류 표시, 원인 미은폐). main 진단 로그(did-fail-load/preload-error/render-process-gone/unresponsive/
    console-message). 단일 인스턴스 락(requestSingleInstanceLock + second-instance focus, 방어적). Playwright
    Electron E2E(synthesize 16 assert + single-instance 3 assert) — 프로덕션 빌드 실제 구동으로 검은 화면 회귀 차단.

## 실제 재현/수정 (P0 검은 화면)
- **재현**: Playwright로 프로덕션 앱 구동 → 111초 파일 TTS 진입 → `ReferenceRegionPanel` render 중
  `TypeError: Cannot read properties of undefined (reading 'toFixed')`(fmt) → ErrorBoundary가 없었다면 검은 화면.
- **원인**: runPreview payload 유실(위). analyze/trim/preflight IPC를 transcribe 전용 runPreview에 재사용한 사각지대.
- **검증(수정 후, 프로덕션 빌드)**: E2E 16/16 PASS — 초기 non-empty · analyze+preflight 동시 · 111.08 표시 ·
  구간 확정 · 합성 클릭 audio:process 1회·검은 overlay 0·pageerror/crash 0·processing UI 유지 · 취소 복귀 ·
  모드 전환 후 재진입 · 종료 후 임시폴더 0. single-instance 3/3. dev startup: preload 경로 동일·클린.
  스크린샷: `작업파일/e2e_shots/`(git 비추적).
- **남은 문제(다음 슬라이스)**
  - P1-4 잔여: "감정별 음성 등록" 전체 섹션·"언어 강제/전사문 없이"를 단일 고급 패널로 완전 통합
    (현재 각각 자체 접이식으로 기본 접힘 — 클러터는 해소, 위치 통합은 미완). 기존 감정ID/직렬화/라우팅 불변.
  - GUI 결과 화면에 seed·model revision 등 상세 표시 확장(현재 핵심 필드만).
  - Electron 창 상호작용 UI(업로드·파형 드래그·재생) 실제 클릭 검증 — 자동화 도구로는 미실시.

## 파생 참조 임시폴더 수명 관리 (audioforge_refclip_*)
- 위치: `tmpdir/audioforge_refclip_<ts>/reference_clip_24k.wav`.
- 정리 시점: 재확정(이전 클립) / 새 파일 분석·reset / 합성 성공·오류·취소(runner 'done') /
  앱 시작·종료 방어 스윕.
- 안전 규칙: 합성 worker 사용 중(runner.isRunning)엔 삭제 안 함 / 원본·synthesized.wav·다른 prefix·
  상위 경로 불변 / tmpdir 직속 정확한 prefix 폴더만.
- 코드: `src/main/services/refclip-cleanup.ts`(isRefClipDir/removeRefClipDir/sweepRefClipDirs),
  `audio.ipc.ts`(currentRefClipDir 추적 + analyze/trim/done/release IPC + app start/will-quit).

## 테스트
- python discovery 126 (reference_region 7 포함).
- npm test 35 (refclip-cleanup 3, qwen-cleanup 3 포함).
- tsc node/web 통과(신규 오류 0), build 통과.

## 실측 (실제 파일, git 비추적)
- 파일: `resources/speaker_b.wav` — 48kHz mono PCM16, **111.083초**, ~10.66MB.
  - (이전 보고서의 72.6초 파일은 `작업파일/AudioForge_output/2026-04-12_04-43-15_…권하영…/speaker_b.wav`였음 — 지정 파일 오인, 정정됨.)
- 백엔드 e2e: analyze duration **111.083** → 추천 6.6s/**7.0s**(speech 0.97) → 구간 무음 0.08·클리핑 0·
  in_range → 파생 **24kHz mono PCM16/7.0s** → **원본 sha256 불변**(a876e390…) → 자동전사 파생 클립만
  (ko 35자) → Qwen 파생 클립만 합성 성공(cuda, source=nvidia-smi, 2.48s).

## master 병합 조건 (별도 승인 필요)
1. 위 "남은 문제"의 결과 metadata/session 기록 반영.
2. 실제 Electron 앱에서 사용자 클릭 검증(업로드→추천 재생→범위 변경→확정→파생→합성, 취소 정리) 통과.
3. 전체 회귀(python/npm/tsc/build) 유지.
4. develop 통합 검증 후.
