# WIP 인수인계 — TTS 참조 구간 선택(긴 참조 3~10초) + GUI/UX

브랜치: `feature/tts-reference-region-ux` — master/develop 병합 금지(별도 승인).

## 브랜치 상태 (compact 시점)
- **master 안정선**: `19f777c` (로컬=원격, 불변)
- **feature HEAD**: `aa0a113` (로컬 == origin/feature/tts-reference-region-ux)
- 작업트리: clean (untracked `resources/`만 — 사용자 자산, 커밋/스테이지 안 함)
- 안정선(19f777c) 이후 feature 12커밋(아래).

## 목적
합성 백엔드는 완료. GUI/UX 보완. 특히 10초 초과 참조를 오류 거부하지 않고 "참조 원본"으로 수용해,
파형에서 3~10초 구간을 골라 그 구간만 mono/24kHz 파생 WAV로 만들어 전사·합성에 쓴다. 원본 불변.

## 완료 기능 + 커밋 해시 (7e5ba82 → aa0a113)
- `7e5ba82` — 긴 참조 3~10초 구간 선택(파형·추천·재생·확정→파생 클립) + 합성 게이팅 + 문구 정정.
- `90a476a` — 파생 참조 임시폴더 수명 관리(refclip-cleanup) + 111초 실파일 재검증.
- `a17020f` — P1-1 결과 재현 메타데이터(session/result, 전사 전문 미기록: 언어/글자수/sha8만).
- `e441fa6` — P1-2 결과 GUI(실제 엔진·장치·참조 방식·구간·폴백·소요 시간). ⚠커밋 '제목'에 `@` 오타(본문 정상, 이미 push라 정책상 미수정 — 병합 방식으로 정리 가능).
- `0f72671` — P1-3 Qwen preflight 상태 표시(예상값; 실행 결과 metadata가 최종 권위).
- `fe1f17b` — P1-4 고급 설정 정리(엔진·속도·간격 → 고급 접이식) + 감정 태그 자주쓰는것+더보기.
- `da9325b` — 초기화 race: analyze-reference/qwen-preflight를 previewGuard에서 분리(읽기 전용) +
  single-flight(preflight 공유 / analyze 파일별). transcriptPreviewGuard·referenceTrimGuard 분리. cfg randomUUID.
- `24c0338` — **P0 검은 화면 근본 수정** + Electron E2E. 원인: `runPreview`가 result에서 `data.transcript`만
  꺼내 analyze/trim/preflight의 최상위 payload 유실 → `analysis.duration_sec` undefined → `fmt()` 크래시 →
  React 언마운트 → 검은 화면. 수정: transcript 래핑 없으면 type 제외 전체 payload 반환. + fmt null-safe,
  analyze payload 검증("다시 분석"), renderer ErrorBoundary, main 진단 로그, 단일 인스턴스 락(방어적).
- `f1bf069` — P0 검증 강화(runPreview payload 회귀, 완료 E2E, 엄격 취소 검증, 증거 정정).
- `d3791cc` — **파생 참조 클립 수명**: 합성 성공/오류/취소 후에도 클립 유지(재합성 가능), 삭제는 새 파일/
  reset/재확정/앱 종료에서만. override 만료 시 원본 폴백 금지(resolve_reference_input). 긴 원본/긴 감정참조는
  모델 로딩 전 차단(감정 ID·파일명·구간 안내).
- `59ee4bd` — reset()에서 파생 참조 실제 정리 구현 + E2E를 resources 격리(tmp UUID 복사)로 안전화.
- `aa0a113` — **결과 직후 재합성 race 제거**(아래 "최근 해결").

## 최근 해결 (aa0a113) — result/runner-done 재합성 backend-ready race
- 증상(이전 미해결): 첫 result가 UI 표시된 뒤 Python runner의 done/exit 전 재합성/재처리 클릭 시
  "이미 처리 중" 발생(result 표시와 backend ready 미분리). 사용자가 결과 직후 재처리 누르면 재현되는 real race.
- 수정: main이 `result`/`error`를 즉시 보내지 않고 버퍼링 → runner `'done'`(자식 종료 = backend free)에서
  `runner=null` 이후에 전달. → renderer가 완료/재처리를 보는 시점엔 이미 backend free → 정상 1회 클릭 재합성,
  "이미 처리 중" 미노출. abnormal exit는 settle.finish가 오류로 마감(UI 안 멈춤).
- 검증: resynthesize E2E 15/15(강제 status 변경·재클릭 없이 1회 클릭 2회차 진입, "이미 처리 중" 0).
- 상태: **수정·검증 완료**. 잔여 모니터링 포인트: 실제 사용자 클릭 감으로 최종 확인(사용감).

## 통과한 테스트 (aa0a113 기준)
- 단위: python discovery **136** · npm test **41** · tsc node/web 통과(신규 오류 0) · build 통과.
- Electron E2E(실 앱 구동, `npm run test:e2e` / `test:e2e:complete`):
  - synthesize **20/20**(검은화면/크래시/overlay 0, audio:process 1회, 취소 후 worker·임시폴더 정리)
  - single-instance **3/3** · reset-cleanup **6/6**(reset→파생 폴더 실제 삭제)
  - complete **10/10**(실제 Qwen 완료 → wav 디코딩·NaN 없음·peak>0 → resultMetadata·결과 GUI)
  - resynthesize **15/15**(같은 클립 2회 합성, 1회 클릭 재합성, race 0)
  - 모든 E2E: 입력을 `tmpdir/audioforge_e2e_<UUID>/`로 격리, finally 정리, resources/ 스냅샷 불변 단언.
- 실측 파일: `resources/speaker_b.wav`(48kHz mono PCM16, **111.083초**). 백엔드 e2e: 추천 6.6/7.0s → 파생
  24kHz mono PCM16/7.0s → 원본 sha256 불변 → 파생 클립만 전사·합성.

## 현재 미해결 / 다음 슬라이스 (P1 잔여)
- P1-4 잔여: "감정별 음성 등록" 전체·"언어 강제/전사문 없이"를 단일 고급 패널로 완전 통합(현재 각각 자체
  접이식으로 기본 접힘 — 클러터는 해소, 위치 통합 미완). 기존 감정 ID/직렬화/라우팅 불변 유지.
- 감정별 참조도 10초 초과 시 UI에서 구간 선택 지원(현재는 백엔드가 감정 ID·파일명으로 차단만, 전용 UI 없음).
- 결과 GUI 상세 확장: seed·model revision 등(현재 핵심 필드만 표시).
- (해결됨) result/runner-done 재합성 race → aa0a113. 실사용 사용감 최종 확인만 남음.

## master 병합 조건
1. 전체 회귀 유지: python discovery · npm test · tsc(node/web) · build.
2. Electron E2E 전부 PASS: synthesize / single-instance / reset-cleanup / complete / resynthesize.
3. 병합 대상 diff에 금지 경로(resources/·작업파일/·venv·모델·*.wav) 0 (현재 clean).
4. develop 통합 검증 후 master 승인(정책: master 직접 push 금지, 병합 별도 승인).
5. (선택) `e441fa6` 제목 `@` 오타 정리 방식 결정(squash merge 시 자연 해소).

## 병합 후 병렬 작업 계획 (pitch / emotion)
- 병합 후 안정선에서 각각 독립 feature 브랜치를 분기(서로 격리, 상호 의존 없음):
  - `feature/tts-pitch` — 합성 결과 pitch 조정(후처리 또는 엔진 파라미터). speed(atempo)와 유사하게 결과에만
    적용하고 참조/라우팅/직렬화 불변. metadata에 pitch·pitch_postprocessed 필드 추가(P1-1 스키마 확장).
  - `feature/tts-emotion` — 감정별 참조 구간 선택 UI(위 "감정별 참조 10초 초과" 항목 흡수) + 감정 라우팅 강화.
    기존 감정 ID/직렬화 불변 필수. P1-4 고급 패널 통합과 함께 진행 가능.
- 두 브랜치는 이 feature가 develop/master에 병합된 뒤 그 안정선에서 분기해 충돌 최소화. 각자 feature/* →
  develop 통합 검증 → master 승인의 동일 흐름. 공용 변경(metadata 스키마 등)은 먼저 develop에 반영 후 rebase.
- 공유 지점 주의: 둘 다 `TtsResultInfo`(결과 GUI)·metadata 스키마·`_synthesize_qwen_job`을 건드릴 수 있어,
  스키마/결과 GUI 확장은 한쪽에서 먼저 develop에 넣고 다른 쪽이 받아가는 순서로.

## 실제 합성 E2E 타임아웃 감사 (2026-08-22, develop) — 결론: 테스트 계층 결함, production 결함 아님
develop 병합 검증 중 `synthesize-complete` E2E가 1회 240초 타임아웃(EXCEPTION)했다. 원인 감사:

- **타임아웃 계층 대조**: E2E 완료 대기 240초 < Qwen 무응답 280초(`tts_worker.py:_QWEN_INACTIVITY_SEC`,
  bridge stdout 한 줄 무응답 기준) < Electron watchdog 300초(`audio.ipc.ts:WATCHDOG_MS`, progress마다 리셋되는
  무진행 기준). 즉 **E2E가 production 내부 안전장치보다 먼저 포기**해, 완료도 명확한 오류(280초 무응답/300초
  watchdog)도 관측하지 못하고 Playwright Timeout만 났다. 코드 결함이 아니라 테스트 대기창이 너무 짧았던 것.
- **첫 실패 로그 소실**: 당시 `synthesize-complete`가 main stdout/마지막 progress를 파일로 남기지 않아 device·
  source·마지막 단계를 사후 확인 불가였다. → E2E 보강으로 재발 방지.
- **조치(테스트 보완만, production timeout 불변)**:
  - 완료 대기 240→**350초**(watchdog 300 + 여유). 근거를 두 E2E 주석에 명시.
  - `synthesize-complete`를 완료-폴링 루프로 바꿔 매 초 store(status/progress/progressMessage) 스냅샷 →
    타임아웃 시 device/source/최종 단계와 nvidia-smi(used/free)를 로그로 남긴다(`작업파일/e2e_shots/e2e_complete_log.txt`).
  - 타임아웃/완료 무관하게 종료 후 **Qwen venv 자식 0 · `.qwen-job-*` 0 · refclip 0** 단언
    (`_e2e-helper.mjs`: `qwenVenvPids`/`qwenJobDirs`/`refClipDirs`/`nvidiaSmiGpu0`). resynthesize도 동일 적용.
- **GPU 여유/경합 실측(짧은 합성 각 1회, source=nvidia-smi로 WDDM 측정 출처 분리 수정 동작 확인)**:
  - 경합(nvidia-smi free 1230 < 임계 4000): `device=cpu, source=nvidia-smi` → 완료, 잔존 0.
  - 여유(free 8795 > 4000): `device=cuda:0, source=nvidia-smi` → 완료, 잔존 0.
  - 취소는 device-독립 경로(runner.cancel→taskkill)라 `synthesize` E2E가 이미 단언(양 상태 공통).
  - 정황: 첫 240초 실패는 경합 상황에서 cpu 경로가 240초를 넘겼으나 350초 내 완료되는 케이스로 유력하다
    (첫 실패 로그가 소실돼 device는 정황 추정 — 이후 350초·로그 캡처로 재현 시 확정 가능).
- **무진행 상태 표시(요구 6 점검)**: model load는 진입 시 10% "모델 로딩 중..." emit 후 완료(25%)까지 중간
  progress가 없다(HF `from_pretrained`가 원자적). 로딩이 길면 진행률이 10%에 정체하나 **메시지는 표시되고**,
  정말 멈추면 280초에 "Qwen 무응답 280s 초과" 명확한 오류로 마감된다 → 상태 미표시 방치/데이터 결함 아님.
  다만 로딩 단계 경과 표시(스피너/경과 초)는 사용감 개선 후보로 이관.
