# WIP 인수인계 — TTS prosody 통합 (pitch + 감정 참조 + 생성 안전장치)

compact 전 체크포인트. 재개 시 이 문서 + `git log`로 상태 복원 후 **A 동적 상한 구현부터** 이어간다.

## 브랜치 상태 (compact 시점)
- 안정선(불변): master `ca42b0e`, tag `v1.0.0`→`ca42b0e`, develop `0788885`
- **integration `feature/tts-prosody-integration` HEAD `034d6fb`** (local==origin, ahead/behind 0/0) — 병합 대상 기준선
- UX 에이전트(통합 후보, **아직 integration 미병합**):
  - 에이전트 1 `feature/tts-prosody-ux-state` `8257e17` — 소유: app.store·App·audio.ipc(클립수명)·preload·shared/ttsConfig·session-restore E2E
  - 에이전트 2 `feature/tts-prosody-editor-ux` `5556035` — 소유: TTSEditor.tsx 단독
  - 에이전트 3 `feature/tts-prosody-accessibility` `f5fa378` — 소유: ProcessButton·ProgressBar·ReferenceRegionPanel·TrackList·TtsResultInfo·globals.css
- 작업트리(integration): `python/generation_limit.py`(A 재개용 신규, **미커밋**), `resources/`(사용자 자산, untracked)

## 완료된 병렬 구현 (integration에 이미 병합됨)
- **A(pitch backend)**: `python/pitch_shift.py`(rubberband 단일, PITCH_UNAVAILABLE), tts_worker pitch 후처리(전 엔진 공통 `place_final_with_pitch`), metadata pitch 3필드. → 통합 배선으로 ttsConfig `ttsPitch`, TTSEditor 슬라이더, TtsResultInfo 표시까지 연결됨.
- **B(감정 참조 UX)**: `ttsEmotionRefs`(effective)·`ttsEmotionRefSources`·`ttsEmotionRefRegions` 3필드, clipKey별 파생 클립 수명, planEmotionRefs 게이팅, 만료 4불변식(UI 1차). Python 수정 0으로 A와 격리.
- **C(research)**: `doc/research/tts-prosody-control.md`. Base는 텍스트 감정 지시 불가(참조+후처리만).
- 통합 배선 커밋: `6637934`(ttsConfig) `a3d4ac0`(pitch UI·전송) `5ad3e65`(metadata·TtsResultInfo) `d50bce6`(Python 2차 방어) `0693338`·`7bd2ecf`·`034d6fb`(prosody E2E 2세션) + 감사문서 `9379325`.

## CUDA 장시간 생성 — 확정 메커니즘
- **원인**: ICL(ref_text 사용) 참조에서 오디오-전사 불일치 시 talker가 codec 토큰을 과다 생성. 정상 talker_iters 10~180(문장 길이 비례) → 불일치 시 계속 증가(무응답). stall 아님(iter 증가 확인).
- **production 재현**: 계측 없는 원본 `qwen_bridge.py`로 대표 불일치(H오디오+D전사) 5/5 무응답(128~156s), 대조 D+D 5/5 정상(16~19s). 진단기 유발 아님.
- x-vector-only·정합 조건은 안정 → ICL ref_text 경로가 관여. 자동 전사 불일치가 주 위험 조건.
- 격리: 참조 전환/2세그먼트 자체는 원인 아님(전환·동일 모두, 단일에서도 발생). 특정 참조가 위험도를 높이는 조건(결정 원인은 ICL 오디오-전사 관계).

## calibration 자료 — 유효/무효 구분
- **유효**: production token 수(`_build_assistant_text` 후 tokenize), talker_iters(=genlen, 실제 생성량), samples, status, language, mode, run/restart tag.
- **무효(사용 금지)**: eos_pos, has_stop_token, effective_lengths 기반 EOS 판정.
- **결정**: 현재 pinned qwen-tts에서 modeling의 `has_stop_token`/`effective_lengths`는 외부에서 EOS 종료 근거로 사용 불가(v8 settrace로 production 내부 직접 관측 → 정상 완료에도 항상 has_stop=False·effective=전체). 실제 종료는 talker.generate 내부(eos_token_id=2150, sequences). **이를 upstream 버그로 단정하거나 vendor site-packages를 수정하지 않는다.** 안전장치는 bridge의 max_new_tokens·iteration 계약으로만 구현.
- calib3 fitting(정상 done, talker_iters<8192, 87건): 공통 upper envelope `iter ≈ 2.786×prod_tokens − 5.1`(resid_max 67·std 27). ICL/xvec 회귀 유사 → 보수적 공통. 무응답 2건(ZH_짧 xvec·KO_긴 ICL)은 재시도 시 정상 done된 비결정 이벤트로, **abnormal로 별도** 보존·정상 fitting 제외.

## 최종 동적 상한 계약 (A)
- `python/generation_limit.py`(작성됨, 미커밋): `compute_max_new_tokens(prod_tokens) = clamp(ceil(2.9×tok + 160), MIN_LIMIT=200, ABS_LIMIT=1024)`. 근거: calib3 회귀 + margin(resid_max+3σ) 보수적 상향. 정상 87/87이 상한 아래. ABS 1024 = 정상 최대 iter 183의 ~5.6배(8192보다 낮되 정상 근거).
- `classify_termination(iters, limit)`: iters≥limit → `generation_limit` / iters<limit → `completed_before_limit`.
- 판정 기준: **talker_iters vs 동적 max_new_tokens**. v9(codec 2150 직접 관측)은 범위 밖.
- `completed_before_limit`은 **EOS 직접 관측이 아님** — "동적 상한 전 자연 반환"이라는 운영 상태. 보고·GUI·metadata에서 EOS 종료라 표현 금지.

## metadata 3필드 (정정된 값)
- `generation_limit`: int / `generated_iterations`: int / `termination_reason`: **`completed_before_limit` | `generation_limit`** (기존 `eos|limit` 폐기).
- 성공=`completed_before_limit`, 구조화 오류=`generation_limit`. Python 구현 후 공용 TS 타입·main result·결과 GUI 연결은 **UX 브랜치 통합 뒤 별도 공용 커밋**.

## 다음 작업 순서 (재개)
1. A 구현(Python only, integration): (a) qwen_bridge — segment별 `max_new_tokens` 수신·전달 + talker 생성 iteration counter(RNG/logits 불변) + termination 판정. (b) tts_worker — `_build_assistant_text` preflight(부재·호출 실패 시 8192 폴백 금지·명확한 호환성 오류) + production token 계산 + `generation_limit.compute_max_new_tokens` + segment 전달 + `generation_limit` 시 잘린 WAV 폐기 + `GENERATION_LIMIT_EXCEEDED` 구조화 오류(감정 ID만, 전사·문장·전체경로 금지) + 기존 synthesized.wav 원자 보존 + segment·pending·자식·VRAM·임시 정리. (c) metadata 3필드.
2. 경계 단위 테스트: iters<limit→completed / iters==limit→generation_limit / limit 도달 파일 폐기+오류 / counter 미측정→성공 통과 금지·호환성 오류 / `_build_assistant_text` 부재→호환성 오류 / 기존 synthesized marker 오류 후 불변 / counter가 RNG·logits 불변.
3. holdout 검증(GPU): calibration 미사용 synthetic 문장(언어×mode 짧/중/긴 + 숫자·약어·구두점·줄임표) — 정상은 limit 전 completed·잘림 없음·finite·기존 보존; 대표 불일치는 계산된 상한에서 GENERATION_LIMIT_EXCEEDED(120s보다 짧고 유한)·부분 WAV 미채택·잔존 0.
4. UX 통합: A→에이전트1→에이전트2→에이전트3 순으로 integration 병합 + 공용 TS 연결 커밋 + 통합 E2E(2층: GUI는 mock/synthetic worker GPU 없이 / 실제 pitch+감정 Qwen 종단은 GPU).

## 금지 사항
- timeout 증가 / 자동 재시도 / x-vector 자동 강등 / 기본 참조 폴백 / production 280초 변경 — 전부 금지.
- vendor site-packages(qwen_tts) 수정 금지. 기존 원격 커밋 amend/rebase/force-push 금지.
- **develop/master 병합 금지**(별도 승인). UX 브랜치는 완성·검토·승인 전 미병합.

## 미디어 취급 정책 (요약)
- 사용자 미디어(WAV 등)의 열람·전사·분석·복사·합성·파생 생성은 **파일·작업·이유·파생물·저장위치·보존기간·외부전송(없음)을 먼저 보고하고 해당 파일·목적·작업 단위 승인** 후에만.
- 승인돼도 실제 오디오 바이트·전사 전문은 Claude에 출력 안 함. Whisper 전사는 로컬 프로세스 내부만, stdout·로그·context 미출력. Claude에는 길이·해시·오류코드·성공여부·token/iteration 등 수치만.
- `SendUserFile` 등 대화 인터페이스 미디어 전달 중단(경로만 안내, 개인경로는 basename). 외부 API·클라우드 업로드 금지. Git에 미디어·전사·개인 절대경로 금지.
- 현재 승인 범위: 기존 `resources/speaker_b.wav` + 기존 파생 clip + calib WAV로 CUDA/생성 진단·holdout. 이 승인은 다른 프로젝트·새 미디어로 확대 금지.

## GPU 실험 통지 규칙
- GPU 실합성·계측 시작 시 "GPU 실험 시작"(시각·free) 알림. 종료 시 Qwen/Whisper/ffmpeg 자식 0·VRAM 회수·임시파일 정리 확인 + "GPU 사용 가능" 명시. GPU 공유 금지(직렬).

## 진단 산출물 로컬 위치 (커밋 금지, 민감정보 없음)
- 진단 스크립트/checkpoint: 세션 scratchpad(`.../scratchpad/diag_*.py`, `calib3_checkpoint.json`) — Git 미추적.
- 진단 WAV/스크린샷/로그: 각 worktree `작업파일/e2e_shots/`(gitignore 성격, 미커밋). happy/default 파생 clip·pitch 청취본·prosody 스크린샷 등. 삭제·이동하지 않음.

## integration → develop 병합 게이트
1. A 구현 + 단위 + holdout(정상 completed·불일치 generation_limit) 통과. 2. UX 1·2·3 병합 + 공용 TS 연결. 3. 전체 회귀(python discovery·npm·tsc·build) + Electron E2E(GUI mock + 실제 Qwen 종단) + 창크기·배율·Tab/slider. 4. 금지 경로 diff 0. 5. 별도 승인 후 develop `--no-ff`. master는 그 다음 별도 승인.

## optional slow E2E — tts-autosplit (커밋 D)
- `test/e2e/tts-autosplit-complete.e2e.mjs` + `npm run test:e2e:tts-autosplit`. **실제 Qwen·GPU·참조 자산 필요**하므로 기본 `npm test`·빠른 `test:e2e`에 **미포함**(수 분·GPU).
- 검증: 긴 한 줄 자동분할(계약 B)·진행률 시작 즉시 90% 점프 없음·chunk 시작/완료 표면화·결과 카드('합성 정보')·엔진(Qwen3)·검은화면/ErrorBoundary/pageerror/crash 0·종료 후 프로세스/job/refclip/pending 0·resources 불변.
- 참조 자산: `AF_E2E_REFERENCE` 경로 우선, 없으면 `resources/speaker_b.wav` fallback, 둘 다 없으면 prerequisite 오류. 사용자 경로 하드코딩 금지. 출력/스크린샷/로그는 gitignore된 `작업파일/e2e_shots/`만.
- chunk 시작/완료 진행의 완전 단조·경계 단언은 `python/test_autosplit_bridge.py`(단위)에서 고정; E2E는 UI 표면화만 확인.

## holdout 실측 요약 (커밋 없음 — 결함 미발견)
- 최소 holdout 완료(승인된 중단·판정 절차 경유). GPU H1/H2_EN/H2_ZH·H3(matched-ICL)·H4(감정+pitch+1) completed. CPU C1 최대 무진행 42.3s(≪280). E1/tts-autosplit 실앱 통과.
- H2_JA 정상 입력에서 generation_limit 중단 조건 1회 관측 → 승인된 동일 조건 2회 재측정 completed → 같은 입력이 완료/상한으로 갈리는 **비결정 tail 확인**(공식·상한 불변). refgen도 generation_limit 1회 후 승인된 재실행 1회 completed. 안전장치·미채택·원자 보존·정리 모두 정상.
- 확정 특성: `GENERATION_LIMIT_EXCEEDED`는 유효 입력에서도 비결정적으로 발생 가능 → 후속 UX(§공용배선 B)에 안전중단 안내 + **사용자 클릭 재시도**(자동 재시도·x-vector 강등·기본참조 폴백 금지).
