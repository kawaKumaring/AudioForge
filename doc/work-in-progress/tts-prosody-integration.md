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

## Compact 인수인계 2 (2026-08-23) — 공용 마감 진행 중

### A. 현재 통합 사슬 (feature/tts-prosody-integration)
- A `1401d38` 생성 상한 256 / B `3910eee` 다국어 자동분할·gap / C `3001113` 진행률·경로·sr/mono 보완 /
  D `ffa46ed` autosplit 실 Electron E2E / UX-1 `bea909c` 상태·session·fingerprint / UX-2 `7f37274` TTSEditor /
  E `bb8265a` editor UX E2E / F `d8a228f` literal NUL 제거 / G `5269f64` 실제 pitch capability·gate /
  UX-3 `db0e23f` 접근성 병합 / H `b536683` accessibility E2E / **I `d45cdd8` generation metadata 결과 GUI(공용 마감 1 완료)**.
- 이 compact 인수인계 docs-only 커밋 해시: (아래 보고에 기재)

### B. 완료 검증 (수치·상태만)
- generation 안전장치/자동분할 holdout: 정상 입력에서도 mode 무관 **비결정 장시간 tail** 존재. JA 동일조건 재측정에서 완료/상한 분기 → 비결정 확정(공식·상한 불변). `GENERATION_LIMIT_EXCEEDED`는 상한에서 유한 차단·잘린 WAV 미채택·원자 보존.
- CPU C1(강제 CPU, KO xvec 긴줄 자동분할): 최대 무진행 **42.3s**, 전체 **142.8s**(≪280/300).
- Electron autosplit(E1/tts-autosplit): 진행률 30% 시작→45→60→75→90 단조(점프 없음), 4조각 표면화, crash 0.
- UX-1 state/session·UX-2 editor·UX-3 accessibility E2E 통과. 실제 pitch capability preflight: available=rubberband, elapsed 0.19s, single-flight 1회.
- 마지막 통과: **python discovery 221 / npm test 90 / tsc node·web 0 / build OK**. E2E: state·tts-editor-ux·tts-pitch-capability·tts-accessibility·tts-result-metadata 전부 failed 0.

### C. 아직 남은 공용 마감 (I·J·K·K2 + L·GPU 게이트 완료, develop 병합 승인 대기)
> **L 완료**: GPU 없는 전체 회귀(python 221 / npm 90 / tsc node·web 0 / build / Electron E2E 209 PASS·pageerror·crash·console 0 / resources 불변).
> **실 Qwen GPU 게이트**: **G1 PASS(36/36)** — cuda:0(nvidia-smi)·감정 happy 라우팅·pitch+1 rubberband postprocessed·4 chunk completed·renderer==session metadata·WAV mono/24000/finite/peak0.49 no-clip.
> **G2** — 취소 phase DAG·taskkill exit0·cleanup 후 idle·잔존 0 PASS. (재실행으로 고친 qwenVenvPids 실측 포함.)
>
> ★**test-infra 정정(공용 마감 K2-보완, test-only)**: 과거 `qwenVenvPids()`는 `wmic` 의존이었으나 이 Windows 11(26200)엔 wmic가 없어 **항상 [] 반환 = 실제 관측 아님**. 따라서 그간 E2E의 "종료 후 Qwen venv 0" 단언은 이 OS에서 자명통과였다(실검증 아님). **단, 이번 G1/G2 종료 후 '현재 worktree 관련 프로세스 0'과 'taskkill exit 0'은 PowerShell CIM으로 독립 확인한 유효 결과**다. 수정: `wmic`→`powershell -NoProfile -NonInteractive` + `Get-CimInstance Win32_Process`(execFile·구조화 JSON·실패 시 throw), 매칭을 **현재 worktree의 python/qwen_bridge.py 절대경로로 스코프**(다른 AudioForge checkout·ComfyUI 제외). 순수 함수(parseCimProcJson/filterWorktreeQwenPids/normPathForMatch) 단위테스트 11건.
> ★flaky 정정(test-only): tts-cancel-lifecycle 시나리오 9가 "bumpRetry 후 200ms 동안 status=cancelling 유지"를 단언해 flaky했다(synthetic child는 ~40ms에 죽어 취소가 그 창 안에 정상 완료되면 idle이 옳은 동작). transient 상태 지속은 제품 계약이 아니므로 재시도 차단의 **결정적 불변식**으로 교체: cancelling 창을 cleanup 재시도 시임으로 확보한 뒤 **원자적 관측**으로 (retryNonce 불변=store 가드 no-op)·(취소 대상 PID 교체 없음=재합성 spawn 0)·(status processing 미복귀)를 권위로 단언. 연속 5회 PASS.
> ★열린 항목: **trackRunner(대화 분할 후처리) 취소는 여전히 fire-and-forget** — synthesis runner만 완결. 별도 보완 대상.
>
> 이력: **J `8d1e668`**(GENERATION_LIMIT 구조화 재시도), **K `c499c27`** + **K2 `2b893c8`** — 취소 lifecycle.
> K2에서 terminal 권위를 audio:cancel로 이전: cancelling→kill→**tree 종료 확인(taskkill exit 0)**→runner done 합류(deferred)→
> **bounded cleanup(.qwen-job-* 0 확인)**→cancelled→idle. done은 취소 중 신호 억제. cleanupPending·inflight 중 새 실행 거부.
> before-quit 1회 preventDefault→bounded tree kill 확인 후 quit. E2E는 인과 DAG 상대순서 + tree-dead-before-idle + 지연 cleanup 회귀.
> ★열린 항목: **trackRunner(대화 분할 후처리) 취소는 여전히 fire-and-forget** — synthesis runner만 완결. 별도 보완 대상.
> 검증: cancel E2E(phase 포함) 통과 / npm test 90 / python 221 / tsc 0 / build OK / 기존 E2E 회귀 통과. 다음 = L(GPU 없는 전체 회귀 → 중간 보고 → 승인 후 최소 실 Qwen 1회).

- **I (완료 `d45cdd8`)**: generation metadata shared/main/store/session/TtsResultInfo(기본 요약 + details, generation_limit/generated_iterations/termination_reason/generation_chunks). 데이터 경로는 이미 verbatim 관통했었고 GUI만 연결.
- **J (미완, 재개 지점)**: GENERATION_LIMIT_EXCEEDED 사용자 명시 재시도.
  - 설계(합의): 구조화 오류 code+필드를 Python→renderer까지 관통(문자열 prefix 추론 금지).
    경로 손실 3지점 = `python-runner.ts:57`(msg.message만 forward), `separate.py`(message만 emit), `tts_worker`(RuntimeError 문자열 변환).
  - **J-WIP는 compact 위해 revert함**(tts_worker error_payload + separate.py 구조화 emit 편집을 되돌려 트리를 I 상태로 정리). 재개 시 다시:
    tts_worker `_synthesize_qwen_job`가 raise하는 RuntimeError에 `.error_payload`(code/segment_index/chunk_index/emotion_id/generated_iterations/generation_limit; TEXT_SEGMENT는 production_tokens/allowed) 부착 → separate.py except가 payload 있으면 `emit("error", message, **payload)` → python-runner가 `emit('error', msg)` 전체 객체 forward → audio.ipc가 audio:error로 전체 전달 → store `errorInfo`(구조화)+`setError(msg, info)` → TrackList 오류 카드가 code로 분기.
  - UI: 제목 "생성이 비정상적으로 길어 안전하게 중단됐습니다." / 설명 "참조 음성과 전사문이 일치하는지 확인하거나 다시 시도하세요." / 버튼 [다시 시도][참조 전사 확인][닫기].
  - 재시도 계약: 1클릭=1 audio:process, 자동/타이머 재시도 0, x-vector 자동 강등 0, 기본참조 폴백 0, 현재 store 설정으로 재구성, stale fingerprint면 차단·참조 확인 유도, backend 미종료면 버튼 비활성, 기존 synthesized.wav 유지, 성공 시 오류 제거·새 metadata, 실패 시 새 오류 1회, 중복 클릭/Enter에도 1회. mock Electron E2E + 커밋 J.
  - 배선안: store `retryNonce`+`bumpRetry()`(=clearError+nonce++). ProcessButton useEffect([retryNonce])에서 status!=='processing' && fileInfo && !ttsBlockReason일 때만 handleProcess() 1회(ref로 dedup). 카드 "다시 시도"는 processing 중 비활성.
- **K (미완)**: cancel lifecycle. synthetic child runner로 timestamp 측정(click→cancelling→child exit→runner done→settlement→idle). 불변식: child 생존 중 idle 금지, cancelling 중 새 합성 금지, kill 실패 시 "취소하지 못했습니다" 오류(조용한 idle 금지). Electron E2E(정상/중복/직후/result 직전 race/kill 실패 mock/앱 종료 중/취소 후 새 합성). Agent 3 cancelling 스타일·ARIA를 이 실측 상태머신에만 연결. 커밋 K.
- **L (미완)**: GPU 없는 전체 회귀(python discovery·npm·tsc·build·state·editor-ux·pitch-capability·accessibility·result-metadata·generation-retry·cancel-lifecycle·single-instance·reset-cleanup·반응형·Tab) → 중간 보고(I/J/K 해시·diff·cancel timestamp·retry 호출수·metadata/GUI·남은 결함·Git) → **최소 실제 Qwen E2E 1회 승인 대기**(긴줄 자동분할+matched-ICL 감정+pitch+1, WAV 구조·finite·sr·peak; 자연스러움/발음/감정/pitch 체감은 청취 전 미확인; WDDM 사용량 집계만·PID 귀속 단정 금지). develop 병합은 그 뒤 별도 승인.

### D. 불변 정책 (전 단계)
- 공통 generation ABS=256. CPU worst spi 0.763 유지. timeout 증가·자동 재시도·자동 x-vector 강등·기본 참조 silent fallback 금지.
- 사용자 미디어·전사 전문·오디오 바이트·ComfyUI prompt 내용 출력 금지. resources/·작업파일/·externals·WAV·모델·로그 커밋 금지.
- 기존 공유 커밋(A~I·UX 병합) amend/rebase/squash/force-push 금지. develop/master/v1.0.0(tag object 810e448·peeled ca42b0e) 불변.
