# 크로스-모드 신뢰성 감사 (음악 / 대화 / 텍스트 / 분할)

- 대상 브랜치: `research/cross-mode-reliability-audit` (base `origin/develop` = `b933ab5`)
- 성격: **읽기 전용 감사**. 프로덕션 `src/`·`python/` 미수정. 이 문서만 커밋.
- 기준선(reference bar): TTS(K2) 취소 lifecycle — `audio:cancel`이 터미널 권위, tree-kill 확인, bounded cleanup, before-quit. 네 개의 비-TTS 모드가 이 수준에 도달하는지 감사.
- 표기: **[확정]** = 코드 근거 있음(파일:함수/라인). **[추정]** = 코드로 확증 못 함 / 실측 필요.

---

## 0. 감사 방법과 근거 파일

읽은 파일(읽기 전용):
- `src/main/ipc/audio.ipc.ts` — process/cancel/done/settlement/watchdog/before-quit/track 경로 전부
- `src/main/services/python-runner.ts` — spawn/line-buffer/`cancel`/`CancelResult`/close/error/done
- `src/main/services/run-settlement.ts` — `SettlementGuard`
- `src/main/services/qwen-cleanup.ts` — `sweepQwenJobDirs`/`listQwenJobDirs`
- `python/separate.py` — 모든 모드 엔트리(`music`/`conversation`/`transcribe`/`split`/`track-process`/`meta-fix`)
- `python/music_worker.py`, `python/conversation_worker.py`, `python/transcribe_worker.py`, `python/gpu_policy.py`, `python/audio_utils.py`(`convert_to_wav`)
- `src/renderer/components/ProcessButton.tsx`, `TrackList.tsx`, `src/renderer/stores/app.store.ts`, `src/preload/index.ts`
- `test/e2e/*` (특히 `_e2e-helper.qwenpids.test.mjs`)

핵심 구조 사실 **[확정]**: 메인 프로세스에는 러너 슬롯이 **둘**이다.
- `runner` (audio.ipc:68) — `audio:process`가 사용. **모든** 모드(music/conversation/transcribe/split/tts)가 이 슬롯을 공유. K2 기계(설정 guard, `cancelState`, watchdog, `boundedJobCleanup`, `runnerDoneDeferred`, before-quit)가 전부 붙어 있음.
- `trackRunner` (audio.ipc:69) — `audio:process-track`(TrackList의 트랙별 전사/번역 재실행)이 사용. **K2 기계가 붙어 있지 않음**(아래 P0-1).

즉 "네 모드가 TTS 수준인가"는 두 축으로 갈린다: (A) `runner`를 타는 4모드 자체의 산출·정리·검증, (B) `trackRunner`를 타는 후처리(대화/음악 결과의 트랙별 전사·번역).

---

## 1. 모드별 실제 경로 (파일:함수, 현재 동작)

### 1.1 음악 (music) — `runner`
- 컴포넌트→IPC: `ProcessButton.handleProcess` → `window.api.audio.process(path,'music',opts)` → `audio.ipc:429 audio:process`.
- Python: `separate.py:main` → `mode=='music'` 분기(224-241). `demucsModel`에 따라 `run_music_separation`(Demucs) / `run_roformer_separation`(BS) / `_MELBAND_ENSEMBLE_MODEL`(Mel-Band) / `run_roformer_ensemble`(앙상블). 이후 `_post_process`(255) → trim/전사/포맷변환.
- 자식 프로세스: 단일 python `separate.py`. Demucs·audio-separator·ffmpeg는 in-process 호출.
- 산출: `music_worker`가 각 스템을 `output_dir/{name}.wav`에 **직접** 저장(`save_audio`, music_worker:217-219). RoFormer는 `os.replace(full, clean)`로 개별 파일 원자 교체(music_worker:154-155), 앙상블은 `save_audio`/`os.replace`.

### 1.2 대화 (conversation) — `runner`
- 경로: `separate.py:242` → `conversation_worker.run_conversation_separation(input, output, n_speakers, gpu_policy)` → `_post_process`.
- 특징 **[확정]**: `gpu_policy.select_device`로 WDDM-aware 장치 선택(min_free_mb=1500) + `run_with_oom_retry`(CUDA OOM→CPU 1회 재시도, conversation_worker:174). seeded kmeans(`rng=0`, :223) 결정성. 첫 등장 순 화자 정렬(:382). crossfade 재구성.
- 산출: 화자별 `output_dir/speaker_{a,b,...}.wav` **직접** 저장(conversation_worker:391).

### 1.3 텍스트 추출 (transcribe) — `runner`
- 경로: `separate.py:218` → `_run_transcribe_only`(320). `convert_to_wav`(임시 wav) → `transcribe_file` → 원본 이름으로 `{base}.txt`/`_timestamps.txt`/`.srt`/`_korean.txt`/`_korean_timeline.txt` 저장(transcribe_worker:`_save_transcription`:474).
- 특징 **[확정]**: 환각 억제 3중(`condition_on_previous_text=False`, `hallucination_silence_threshold=2.0`, 에너지 게이트 `_filter_silent_segments`:84). 임시 wav는 `finally`에서 `os.remove`+`os.rmdir`(separate.py:333-338).
- 장치: `get_device()`(순수 torch scalar 프로브) — `gpu_policy` 미사용(아래 P1-GPU).

### 1.4 분할 (split) — `runner`
- 경로: `separate.py:208` → `_run_split`(437). 타임스탬프 제공 시 `-ss` 입력 시킹 ffmpeg 추출(`_extract_tracks_ffmpeg`:564), 없으면 ffmpeg `silencedetect` 자동 감지 후 동일 추출.
- 산출: 트랙별 `output_dir/{name}.wav` **직접** ffmpeg 추출 + 트랙별 `{name}.json`(source_path/start/end/split_date) + `_tracklist.txt`. 원본은 ASCII 임시경로로 `shutil.copy2` 후 `finally`에서 정리(separate.py:462-498).
- 라벨 파일명화 **[확정]**: `safe_label = "".join(c for c in lbl if c not in r'\/:*?"<>|')`(:482) — 경로 구분자·Windows 금칙 문자 제거.

### 1.5 트랙 후처리 (track-process) — `trackRunner`
- 컴포넌트→IPC: `TrackList.TrackItem.handleTrackProcess` → `window.api.audio.processTrack(track.path, outputDir, {transcribe,translate,srt,translateModel})` → `audio.ipc:659 audio:process-track`.
- Python: `separate.py:213` → `_run_track_process`(362). `{base}.txt`/`_timestamps.txt`/`.srt`/`_korean.txt` **덮어쓰기**(open "w"). 결과는 `audio:track-result`/`audio:track-error`로 반환.
- **K2 미적용**(P0-1).

---

## 2. 확정 결함 vs 개선 아이디어

### 2.1 확정 결함 (코드 근거 있음)

**D1 — trackRunner 취소가 fire-and-forget (터미널 권위 아님). [확정]**
`audio:cancel`(audio.ipc:738)은 `if (trackRunner) { trackRunner.cancel(); trackRunner = null }` 한 줄. `CancelResult`를 **await하지 않고**, `treeKillConfirmed`를 확인하지 않고, 즉시 `null`로 만든다. `audio:cancelling`/`cancelled`/`cancel-failed` 신호도 없다. 코드 주석이 스스로 "이번 K/K2 범위 밖 — 단순 취소 유지(별도 열린 결함으로 문서화)"라고 명시(:737). 결과: 대화/음악 결과에서 '가사'/'번역'을 돌리다 취소·종료하면, taskkill 미확인 상태로 자식이 살아 있을 수 있고 렌더러는 이를 알 방법이 없다. `trackRunner`는 `cancelState`/`cleanupPending` 게이팅에도 포함되지 않아, 살아있는 track 자식과 동시에 새 `runner` 작업이 시작될 수 있다.

**D2 — 비-TTS 임시폴더 잔류(취소/kill 시). [확정]**
`convert_to_wav`(audio_utils:109)는 시스템 tmp에 `audioforge_*` 폴더를 만들고 그 안에 **원본 전체 사본(`shutil.copy2`) + `converted.wav`(pcm_f32le, 대용량)**를 둔다. music(Demucs/RoFormer/앙상블·앙상블은 추가로 `af_ens_*` tmpdir, music_worker:60), conversation, transcribe, split 전부 이 임시폴더를 쓴다. 정리는 Python `finally`에 의존. 그런데 취소는 Windows `taskkill /T /F`(python-runner:168)이라 **finally가 실행되지 않는다**. 부모측 스윕 아날로그가 없다 — `sweepRefClipDirs`는 `audioforge_refclip_*`만, `sweepQwenJobDirs`는 `.qwen-job-*`만 대상. `audioforge_*`/`af_ens_*`는 아무도 치우지 않아 취소·강제종료마다 누적(각 잔류가 원본 사본+wav라 용량이 작지 않음). 취소 정리 게이트도 `isTts && outDir ? boundedJobCleanup : true`(audio.ipc:768)라 비-TTS 취소는 정리를 **아예 하지 않는다**.

**D3 — 다중 산출 부분 게시(atomic publish 부재). [확정]**
music/conversation/split은 각 트랙을 `output_dir/{name}.wav`에 **직접** 기록한다(트랜잭션 스테이징 없음). 실패/kill이 루프 중간에 오면 일부 트랙만 디스크에 남고, 이를 표시하는 마커도 없고 정리도 없다. 예: `_extract_tracks_ffmpeg`(separate.py:591)는 트랙 N 실패 시 `emit("error")` 후 `return None` — 그러나 트랙 1..N-1 wav는 이미 남아 있다. `session.json`은 결과 수신 **후** 메인이 쓰므로(audio.ipc:576) 부분 게시 시 session.json은 없지만 고아 wav는 output_dir에 남는다. (완화 요소: 실행마다 새 타임스탬프 output_dir(audio.ipc:472)이므로 **이전 실행 결과를 덮어쓰지는 않는다** — 항목 5 "in-place overwrite" 우려는 낮음. 문제는 실행 **내부** 무원자성.)

**D4 — 소스 변경 후 stale 결과 연결. [확정]**
`audio:find-session`(audio.ipc:801)은 `s.source === sourcePath || s.sourceName === srcName`와 트랙 파일 존재만으로 이전 결과를 복원 후보로 제시한다. **소스 파일 지문(크기/mtime)을 검증하지 않는다.** 사용자가 같은 경로/이름으로 소스를 교체·수정하면 옛 결과가 새(바뀐) 소스의 결과로 제시된다. TTS는 `computeFingerprint`/`buildReferenceFingerprints`(audio.ipc:126-148)로 참조 stale을 폐기하지만, 이 지문 로직은 **비-TTS 소스→결과 연결에는 전혀 적용되지 않는다**. `session.json`에도 소스 지문이 없다.

**D5 — 산출 WAV 무검증. [확정]**
어느 모드도 산출 트랙에 존재/0바이트/디코딩 가능/sr·채널/유한(NaN)·길이 정합 검사를 하지 않는다. 있는 것은 `os.path.exists(out_path)`와 ffmpeg returncode뿐(separate.py:591, :300). 검증 로직 자체는 존재하나(`reference_audio.assess_reference_file` — readable/duration/sr/channels) **TTS 참조 입력에만** 쓰이고 4모드 산출에는 적용되지 않는다.

**D6 — music/transcribe/track의 GPU 정책 부재 + OOM 폴백 부재. [확정]**
`gpu_policy.select_device`(WDDM에서 `nvidia-smi memory.free`를 1차 근거로 쓰고, torch `mem_get_info`가 점유를 신뢰성 있게 반영 못 함을 문서화)는 **conversation만** 사용한다. music Demucs는 `get_device()`(torch `zeros(1)` scalar 프로브, music_worker:179)를 써서 gpu_policy가 명시적으로 "신뢰 불가"라 한 그 방식으로 장치를 고른다 → ComfyUI가 VRAM 점유 중에도 GPU를 골라 OOM 위험. 게다가 Demucs 경로에는 `run_with_oom_retry`가 없다(conversation에만 있음). transcribe/track-process도 `get_device()` naive 프로브 + 임계·OOM 폴백 없음. 즉 per-job VRAM 임계와 WDDM 측정은 conversation 단일 모드에만 존재.

### 2.2 개선 아이디어 (결함 아님 / 낮은 위험)

- **I1** — 비-TTS 오류는 전부 평문 문자열(`emit("error", message=...)`); 구조화 `code`는 TTS 전용(GENERATION_LIMIT_EXCEEDED/CANCEL_FAILED). 렌더러가 비-TTS 오류 유형으로 분기 못 함. 그리고 비-TTS 오류 카드의 '다시 시도'는 `clearError`(TrackList:410)라 **실제 재실행이 아님**(재설정 후 수동 재클릭 필요). TTS만 `retryNonce`/`bumpRetry`로 명시 재시도. **[확정]**
- **I2** — hard/absolute deadline 없음. 5분 no-progress watchdog(WATCHDOG_MS=300000, 모든 모드)만 있어 progress를 계속 뿜는 hang은 영원히 안 죽는다. **[확정]**
- **I3** — `before-quit`(audio.ipc:194)은 refclip만 스윕. 비-TTS `audioforge_*`/`af_ens_*`나 `.qwen-job-*`는 종료 시 정리 안 함(D2와 동일 성격). 단, before-quit은 `runner`·`trackRunner` **둘 다** kill하고 3.5s backstop 대기하므로 프로세스 자체 정리는 양호. **[확정]**
- **I4** — track-process는 `{base}.txt`/`_korean.txt`를 in-place 덮어쓰기(open "w") — kill 중 절단 가능. 낮은 빈도. **[확정]**
- **I5** — split 라벨 파일명화는 경로 구분자·금칙문자는 제거하나 선행 `.`이나 Windows 예약 디바이스명(CON/PRN 등)은 안 막음. 위험 낮음(로컬 앱). **[확정]**
- **I6** — 세션/결과 재현 메타데이터: 비-TTS는 `session.metadata=null`(metadata는 tts에서만 채움). 사용 device/엔진 버전/seed 미기록(conversation kmeans는 결정적이나 기록 안 됨). split은 트랙별 json에 source_path/시각 있음. **[확정]**
- **I7** — 자동 폴백들(포맷 변환 실패→WAV 유지 separate.py:300 / Google→NLLB / LLM 세그 불일치→NLLB / conversation OOM→CPU)은 대체로 온당한 graceful degradation이나 **조용함**(구조화 알림 없음). **[확정/일부 추정]** 사용자 인지 필요 여부는 추정.
- **I8** — StrictMode/더블클릭: 쓰기 작업은 `runner?.isRunning`/`trackRunner?.isRunning` throw로 이중 subprocess는 막힘. 단 audio:process에 명시적 single-flight는 없어 2번째 클릭이 throw→`setError`로 진행 중 UI를 잠깐 덮을 수 있음(이중 실행은 아님). 읽기 작업(analyze/preflight)은 single-flight 보유. **[확정]**

---

## 3. 우선순위 (P0/P1/P2)

**P0 (신뢰성 치명, 지금 조치 권고)**
- **P0-1 [확정]** D1: `trackRunner` 취소를 K2 터미널 권위로 승격.
- **P0-2 [확정]** D2: 비-TTS 임시폴더(`audioforge_*`/`af_ens_*`) 취소/kill 잔류 → 부모측 bounded 스윕 아날로그.
- **P0-3 [확정]** D3: 다중 산출 atomic publish(스테이징→검증→원자 이동/매니페스트).
- **P0-4 [확정]** D4: 소스 지문 기반 stale 결과 연결 차단(find-session/session.json).
- **P0-5 [확정]** D5: 산출 WAV 검증 게이트(존재/0바이트/디코딩/sr·채널/NaN/길이).

**P1**
- **P1-1 [확정]** D6: music/transcribe/track에 `gpu_policy` + OOM 폴백 적용. (단 임계값은 실측 필요 — §8)
- **P1-2 [확정]** I1: 비-TTS 구조화 오류 코드 + 실제 재시도 배선.
- **P1-3 [확정]** I2: hard deadline(모드별 상한) 추가.
- **P1-4 [확정]** I3: quit 시 비-TTS temp 스윕 포함.
- **P1-5 [확정]** §7: 4모드 + track-process E2E 부재 → 합성 E2E 신설.

**P2**
- **P2-1 [확정]** I4: track-process 산출 in-place 원자화.
- **P2-2 [확정]** I6: 재현 메타데이터(device/엔진/seed/소스 지문) 기록.
- **P2-3 [확정]** I8: audio:process single-flight(방어).
- **P2-4 [확정]** I5: split 라벨 예약명/선행점 가드.

---

## 4. 공통 추상화 후보

### 4.1 공통 JobController 후보
현재 K2 lifecycle은 `runner`에만 완비, `trackRunner`는 맨몸(`.cancel()` fire-and-forget). 두 슬롯을 하나의 **터미널 권위 lifecycle**로 통합:
- 구성요소(이미 대부분 mode-agnostic): `SettlementGuard`(run-settlement) + `cancelState('none'|'inflight'|'failed')` + `PythonRunner.cancel(timeoutMs)`의 `treeKillConfirmed` 확인 + `runnerDoneDeferred` 합류 + `cancelling`/`cancelled`/`cancel-failed` 신호 + watchdog + before-quit 등록.
- **핵심**: cleanup 대상을 파라미터화(콜백)해 `mode==='tts'` 하드게이트 제거. TTS는 `.qwen-job-*` 스윕을, 비-TTS는 temp-dir 스윕을(4.3), track-process는 산출 원자화를 각자 주입.
- 산출: `createJobController({ onCleanup, isTts, outputDir })` 형태로 `runner`/`trackRunner` 양쪽 재사용.

### 4.2 공통 AudioValidation 후보
산출 트랙을 `emit("result")` 직전 검증하는 mode-agnostic 검사기(Python). `reference_audio.assess_*`의 기존 primitive(readable/duration/sr/channels) 재사용 + NaN/inf 유한성 + 0바이트 + 기대 길이 근사 대조. soundfile만 쓰면 torch/GPU 불필요 → 지금 구현 가능. 실패 트랙은 결과에서 제외하거나 구조화 오류로 표면화.

### 4.3 공통 atomic publish + cleanup 후보
- 실행마다 `output_dir/.af-job-<uid>/`(또는 시스템 temp)에 스테이징 → 검증 → 최종 output_dir로 **원자 이동**(또는 `_manifest.json`/`_complete` 마커를 마지막에 기록). 실패/취소 시 스테이징 스윕.
- `sweepQwenJobDirs`/`listQwenJobDirs`를 mode-agnostic `.af-job-*` 규약으로 일반화(또는 `.qwen-job-*` 유지 + 아날로그 추가).
- 시스템 tmp의 `audioforge_*`/`af_ens_*`는 blind prefix 스캔 대신 `refClipDirs`(audio.ipc:122) Map처럼 **생성 경로를 추적**해 정확히 그 폴더만 스윕(오삭제 방지, sweepRefClipDirs 안전 규약과 동일 철학).

---

## 5. 모드별 반드시 보존할 고유 동작

- **music**: RoFormer/앙상블 스템 명명 정규화 + `os.replace`로 canonical `{name}.wav`; 노래방(KaraokeButton)은 vocals+반주 세트 전제; music만 보컬 트랙 한정 전사(`_post_process`:282, 드럼/베이스 전사 배제).
- **conversation**: seeded kmeans(`rng=0`) 결정성; `gpu_policy` + OOM CPU 재시도; 첫 등장 순 화자 정렬; crossfade 재구성; 최소 발화비율/윈도우 게이팅.
- **transcribe**: 환각 억제(condition_on_previous_text=False + hallucination_silence_threshold + `_filter_silent_segments` 에너지 게이트 + 과삭제 가드); 언어 강제; 타임라인 1:1 번역; **converted.wav가 아닌 원본 이름**으로 출력.
- **split**: `-ss` 입력 시킹 고속 추출(전체 디코딩 회피); 타임스탬프 vs silencedetect 두 모드; 트랙별 `.json`+`_tracklist.txt`; meta-fix 리네임/재태깅(`os.replace(tmp,new)`); 샘플 정확 재인코딩; 라벨 파일명화.
- **track-process**: 결과 name 매칭(TrackList:151-154, 크로스-트랙 혼동 방지); 트랙 개별 전사/번역 재실행.

---

## 6. 권장 후속 feature-branch 분할

1. `feat/job-controller-unify` — D1(trackRunner→K2). `audio.ipc.ts` + `python-runner.ts`. **TTS 사이클과 충돌 최상**(§9).
2. `feat/atomic-publish-cleanup` — D2+D3. `separate.py`(비-TTS 분기)·워커 + `qwen-cleanup.ts` 일반화. TTS 분기와 대체로 disjoint.
3. `feat/audio-output-validation` — D5. Python 검증 모듈(reference_audio 재사용) + separate.py emit 게이트.
4. `feat/source-fingerprint-linkage` — D4. `audio.ipc.ts`(find-session/session.json) + store restore.
5. `feat/gpu-policy-music-transcribe` — D6/P1-1. 워커(music/transcribe/track에 gpu_policy+OOM). **임계값 실측 선행 필수**.
6. `feat/nontts-error-codes-retry` — I1. Python emit 코드 + 렌더러 분기/재시도.
7. `test/nontts-e2e` — §7. 4모드+track-process 합성 E2E.

권장 순서: (1)을 TTS 사이클 착지와 **의도적으로 조율**해 순차 머지, 이후 (2)(3)(4) 병렬 가능, (5)는 실측 게이트, (6)(7)은 상시.

---

## 7. 기존 E2E가 실제로 검증하는 것 vs 맹목 단언

- **[확정]** `test/e2e/*`의 실행 시나리오는 **전부 TTS**(synthesize*, tts-cancel-lifecycle, prosody, session-restore 등). grep 결과 `track-process`/`process-track`/`processTrack`/`mode:'conversation'|'split'|'transcribe'`/`nSpeakers`/`splitMarkers` 실행 구동은 **0건**. 즉 music/conversation/transcribe/split/track-process의 취소·잔류·부분게시·검증은 **완전 미검증**.
- **[확정]** `_e2e-helper.qwenpids.test.mjs`는 `filterWorktreeQwenPids`/`parseCimProcJson`의 **순수 함수** 단위테스트(합성 CIM JSON). MEMORY의 "qwenVenvPids가 wmic-blind였다" 교훈 대비 현재는 CIM+worktree 경로 필터로 개선됐고 잘못된 JSON은 throw(조용한 `[]` 금지)까지 검증. 단 이는 **PID 필터 로직**만 검증할 뿐, 실제 프로세스 트리 열거가 살아있는 자식을 잡는지는 이 테스트로는 보장 안 됨(그리고 TTS 전용). 비-TTS에는 프로세스 잔류 단언 자체가 없음.

---

## 8. 지금 구현 가능 vs 실측 필요

**지금 가능(GPU/모델 불필요)**: P0-1(trackRunner→K2), P0-2(temp 스윕), P0-3(atomic publish/스테이징), P0-4(소스 지문), P0-5(구조적 WAV 검증 — soundfile), I1(오류 코드/재시도 배선), I2(hard deadline), I3(quit 스윕), 비-TTS 합성 E2E.

**실측 필요(실 GPU/CUDA)**: P1-1의 실제 VRAM 임계값 — TTS 4000MB/conversation 1500MB가 실측으로 정해진 것처럼 Demucs/Whisper의 peak를 실측해야 `min_free_mb`를 정할 수 있음; 실 CUDA에서 OOM 폴백 거동; 실제 device-busy 상황에서 WDDM(nvidia-smi) 측정 검증.

---

## 9. 예상 변경 파일 + 충돌 지점 (특히 TTS 표현/prosody 사이클 브랜치 대비)

- **`src/main/ipc/audio.ipc.ts` — 최고 충돌 위험 (핫 파일).**
  - `runner.on('result')` metadata 병합 블록(534-559) — TTS 사이클이 자주 건드림. P0-4(session.json 지문)도 이 근처를 만짐.
  - `audio:cancel` 핸들러(736-783) — P0-1이 대수술. TTS 사이클이 취소 신호/문구를 만지면 충돌.
  - `mode==='tts'` cleanup 분기(476, 624-628, 768) — P0-2/P0-3이 이 게이트를 일반화하면 정면 충돌.
- **`src/main/services/python-runner.ts`** — `cancel`/`CancelResult` 의미를 TTS 사이클이 만지면 충돌(비교적 안정적이라 위험 중간).
- **`src/main/services/qwen-cleanup.ts`** — P0-3 일반화 시, TTS 사이클이 job-dir 규약을 만지면 충돌.
- **`python/separate.py`** — 모드 디스패치. atomic-publish/검증은 비-TTS 분기(music/conversation/split/transcribe/`_post_process`)를 만지고 TTS 사이클은 tts 분기를 만짐 → **대체로 disjoint, 충돌 낮음**.

완화: `feat/job-controller-unify`는 audio.ipc의 취소 핸들러/게이트를 재작성하므로 **TTS 표현 사이클과 같은 시기에 audio.ipc를 만지지 않도록 착지 순서를 명시 조율**할 것.

---

## 10. 테스트 계획 (GPU-free, 합성)

- **합성 프로세스 하네스**: 기존 `AF_E2E`/`AF_E2E_TTS_SCRIPT`(audio.ipc:460) 패턴을 비-TTS로 확장 — audio:process가 합성 스크립트를 띄워 (a) progress emit, (b) 가짜 wav N개 기록, (c) 선택적으로 hang/부분기록 후 종료 하도록. 모델 없이 취소/잔류/부분게시 단언.
- **단위(node --test)**: (1) 일반화 sweep(`audioforge_*`/`af_ens_*` 추적-폴더 스윕) 순수 fs 테스트(qwen-cleanup 테스트와 동형). (2) atomic-publish 스테이징→이동 로직 tmp fs 테스트. (3) 소스 지문 비교 — 크기/mtime 변경 시 find-session 후보 거부.
- **Python(pytest, torch 불필요)**: (1) WAV 검증기 — 합성 wav(정상/0바이트/절단/NaN 주입/잘못된 sr)를 soundfile로. (2) split 라벨 파일명화 엣지. (3) `_extract_tracks_ffmpeg` 부분 실패 시 고아 미잔류(스테이징 적용 후).
- **취소/잔류**: `audioforge_*` temp를 만들고 sleep하는 합성 자식 → audio:cancel 구동 → temp 스윕 + (신규) cancelled 신호 단언. tts-cancel-lifecycle E2E를 비-TTS로 미러.

---

## 부록 A — 항목별 감사 요약 (지침 1~18)

1. 엔트리→IPC→러너→자식: §1 (runner 4모드 공유 / trackRunner 후처리). **[확정]**
2. 취소→종료→정리→idle 권위: runner는 K2 완비, trackRunner는 fire-and-forget(D1). **[확정]**
3. trackRunner fire-and-forget 사용처·영향: audio.ipc:738, D1. **[확정]**
4. per-job temp·잔류: `audioforge_*`/`af_ens_*` 취소 시 잔류(D2). **[확정]**
5. in-place 덮어쓰기 vs 원자 교체: 실행마다 새 타임스탬프 dir이라 이전 결과 보존; 실행 내부는 무원자(D3); track-process는 in-place(I4). **[확정]**
6. 부분 다중 산출 게시: 가능(D3). **[확정]**
7. WAV 검증: 없음(D5). **[확정]**
8. 경로 검증/상위 탈출: split 라벨 sanitize 양호, 예약명 미가드(I5); output_dir는 basename 유래라 탈출 낮음. **[확정]**
9. 입력 지문·stale 재사용: 비-TTS 미적용(D4). **[확정]**
10. StrictMode/더블런/single-flight: isRunning throw로 이중 subprocess 방지, audio:process single-flight 없음(I8). **[확정]**
11. progress/no-progress timeout/hard deadline: 5분 watchdog 있음, hard deadline 없음(I2). **[확정]**
12. 오류 문자열 vs 구조화 코드: 비-TTS 평문뿐(I1). **[확정]**
13. 명시 재시도 vs 자동 폴백: 비-TTS 실제 재시도 없음(I1); 자동 폴백 다수·조용함(I7). **[확정/일부 추정]**
14. 세션/결과 재현 메타데이터: 비-TTS metadata=null, device/seed 미기록(I6). **[확정]**
15. WDDM GPU 측정·per-job VRAM 임계: conversation만 gpu_policy, music/transcribe/track는 naive+무OOM폴백(D6); 임계값 실측 필요. **[확정 + 실측필요]**
16. 앱 종료 정리: runner·trackRunner 둘 다 kill(양호), 비-TTS temp 스윕 누락(I3). **[확정]**
17. 기존 E2E 실검증 vs 맹목: TTS 전용, 비-TTS 0건(§7). **[확정]**
18. TTS와 공유 가능 vs 재사용 금지: 공유=PythonRunner/SettlementGuard/watchdog/single-flight/sendError; 금지=`.qwen-job-*` 규약·buildTtsConfig·감정참조/지문 machinery·`mode==='tts'` cleanup 게이트(§4/§9). **[확정]**
