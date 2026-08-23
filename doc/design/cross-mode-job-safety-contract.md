# Cross-Mode Job Safety Contract (DESIGN · DOC ONLY)

브랜치: `design/cross-mode-job-safety-contract` (origin/develop `b933ab5`에서 분기). **문서 전용** — production 코드·테스트·package 수정 없음, expression-integration·develop·master 무병합.

목적: TTS에서 세운 job 안전 불변식(취소 lifecycle K/K2, 원자 교체, bounded cleanup, 비민감 metadata)을 **모든 작업 모드에 공통되는 계약**으로 일반화한다. 특정 모델·구현을 확정하지 않고, 별도 조사 에이전트(음악분리·대화·텍스트추출·영상분할)의 결과를 연결할 **reference 슬롯**을 둔다.

## 0. 표기(사실 등급) — 모든 항목에 적용

- **[F]** 공식 사실: 이 base(b933ab5) 코드에서 직접 확인.
- **[C]** 제작사/기존 문서 주장(예: 계약 문서·changelog).
- **[O]** 제3자/런타임 관측(E2E·측정).
- **[I]** 분석자 추론(설계 판단 — 검증 전 가설).
- **[R]** 후속 research 슬롯(별도 조사 에이전트가 채움).

민감정보 규칙: 이 문서·예시·fixture에 사용자 원문·미디어·전사·prompt를 넣지 않는다.

## 1. 대상 모드 (공통 계약의 적용 범위)

| # | 모드 | separate.py `--mode` [F] | 엔진/자원 [F/I] | 산출물 [F] |
|---|---|---|---|---|
| 1 | 음악 분리 | `music` | Demucs/RoFormer · GPU 선택 | 다중 스템 WAV(트랙 N개) |
| 2 | 대화 처리 | `conversation` | 분리+화자(diarization) · GPU/CPU | 화자별/구간 트랙 |
| 3 | 텍스트 추출 | `transcribe` | Whisper · GPU/CPU | 전사 텍스트/SRT |
| 4 | 영상 분할 | `split` + `track-process` | ffmpeg 중심 · CPU | 분할 구간 산출물 |
| 5 | 음성 합성·표현 | `tts` | Qwen3/GPT-SoVITS 등 · GPU 선택 | synthesized.wav(단일) |
| 6 | 향후 가창(singing) | (미구현) | [R] | [R] |

보조 모드[F]: `qwen-preflight`·`pitch-preflight`(single-flight read-only), `ref-analyze`·`ref-trim`·`ref-transcribe`(참조 준비), `meta-fix`. 이들은 job이 아니라 **prepare/probe** 성격 — §11에서 구분.

## 2. Job 식별·관계 (공통 불변식)

- **불변식 J1**: 모든 job은 `{ jobId, parentJobId?, mode, sourceFingerprint, createdAt }`로 식별된다.
  - 현행[F]: 명시적 `jobId`는 **없다**. 실행마다 `audioforge_config_<ts>.json` 임시 config + `session.json`(mode·options·source·createdAt)만 존재. `sourceFingerprint`는 TTS 참조 지문(§I3/§4)만 형식화됨.
  - 격차[I]: job 단위 식별자·parent/child(예: split→track-process 파생) 관계가 형식화되지 않음 → **P1**(§17).
- **불변식 J2**: parent/child는 tree kill·cleanup 권위가 parent에 있다. child(파생 python/ffmpeg)는 parent runner의 종료 신호에 종속.
  - 현행[F]: `runner`(주 job) + `trackRunner`(track-process) 2개 PythonRunner 인스턴스. 각자 자식 tree를 `PythonRunner.cancel`로 종료(Windows `taskkill /T /F`).

## 3. 상태 DAG (공통)

계약 상태: `queued → preparing → running → cancelling → cleanup → (completed | failed | cancelled)`

- 현행 매핑[F]:
  - renderer store status: `idle | loading | processing | cancelling | done | error`.
  - main: `runner.isRunning`(불리언) + 취소 조정 상태(currentSettle/pendingCancel, K2).
- 매핑 격차[I]:
  - `queued`(직렬화 대기)·`preparing`(모델 로딩/참조 준비)·`cleanup`(정리 단계)이 renderer status에 **독립 상태로 없다**(현재 loading/processing에 흡수). 관측 가능한 별도 단계로 승격 필요 → **P1**.
- **불변식 S1**: 터미널 상태(completed/failed/cancelled)는 **정확히 한 번** 정착한다("최초 정착 승자", K2 settlement guard). [F](TTS) / 타 모드 [I]로 일반화 필요.
- **불변식 S2**: `cancelling`에 진입하면 새 job 시작이 차단된다(`runner.isRunning` 게이트). [F]

## 4. 진행률 권위·단조성

- **불변식 P1**: 진행률 권위는 **main 프로세스**(python emit → main → renderer). renderer는 표시만. [F]
- **불변식 P2**: 한 job 내 progress `valuenow`는 **단조 비감소**. [O] TTS a11y E2E에서 `[6,10,45,90,99]` 확인. 타 모드 [R].
- 모드 차이[I]: 각 모드가 자체 progress 스케일(음악=스템별, 전사=구간별, split=파일별)을 emit → 공통은 "0..100 정규화 + 단조" 규칙만 강제, 세부 스케일은 모드 소유.

## 5. 자식 프로세스 tree 종료·terminal 신호 권위

- **불변식 K1**: 취소의 terminal 신호 권위는 `audio:cancel`. 순서(K2)[F]: `cancelling` → tree kill 확인(taskkill 완료 exit 0 + parent 'close') → runner 'done' 합류 → bounded cleanup(§7) → `audio:cancelled`.
- **불변식 K2**: `PythonRunner.cancel(timeoutMs)`는 `{parentExited, treeKillConfirmed, timedOut, reason}`를 반환하고, 부모 'close' AND taskkill 프로세스 'close' exit 0을 **둘 다** 기다린다. [F]
- **불변식 K3**: 앱 종료(before-quit) 시 bounded tree kill. [F]
- 모드 차이[F]: `audio:cancel`은 `runner`+`trackRunner` 둘 다 `cancel(3000)` 호출. 그러나 **cleanup 스코프는 TTS(`.qwen-job-*`)만 형식화**됨(§7). 비-TTS 자식(demucs/whisper/ffmpeg)의 잔존·부분 산출물 정리는 미형식화 → **P0/P1**.
- **trackRunner 잔존[F/I]**: `trackRunner.on('done', ()=>trackRunner=null)` + 조건부 `trackRunner.cancel()`는 runner의 K2 settlement/bounded-cleanup 합류만큼 엄격하지 않다(fire-and-forget 성격). → **P0**(§17): track-process 취소 시 자식·임시물 잔존 가능성.

## 6. Timeout 구분 (공통)

- **T1 하드 deadline**: preflight/prepare에만 존재[F] — `runPreview(timeoutMs)` preflight 30000ms, ffmpeg trim 120000ms. 주 job(합성/분리/전사)은 **하드 deadline 없음**(완료 또는 취소까지 실행).
- **T2 inactivity timeout**: **현재 없음**[F] — 자식이 진행 없이 멈춰도 자동 종료 없음 → **P1**(모드별 무진행 감지).
- **T3 취소 대기 bounded**: `CLEANUP_DEADLINE_MS=2500`, `cancel(3000)`[F].
- 계약[I]: 모드별로 (a) 하드 deadline(예: 전사 파일 길이×배수), (b) inactivity(진행 이벤트 없는 최대 시간)를 **분리 정의**하고, 초과 시 T3 취소 경로를 재사용.

## 7. 원자 교체·기존 결과 보존 / 임시물 소유·정리

- **불변식 A1**: 최종 산출은 **모든 검증 통과 후 단 한 번의 원자 교체**(`os.replace`, 동일 파일시스템)로 배치. 실패는 교체 前 예외 → 기존 결과 무손상. [F] TTS `_finish_and_place`.
- **불변식 A2**: 중간 산출물은 output_dir 하위 실행 전용 폴더(TTS: `.qwen-job-*`)에 두어 정리/취소 스윕이 걷어가게. [F]
- 모드 차이(핵심 격차)[F/I]:
  - **TTS**: 단일 output(synthesized.wav) → A1 완전 충족(원자 1회).
  - **음악/대화**: **다중 트랙 파일**을 output_dir에 쓴다 → "다중 output의 원자적 publish"(전부 성공 후 일괄 노출 vs 부분 노출)가 **미형식화** → **P1**. 부분 실패 시 일부 트랙만 남는 반쪽 결과 가능.
  - **split/track-process**: 파일 N개 분할 → 동일한 다중 output 원자성 문제 + trackRunner 잔존(§5).
- **정리 소유권**[I]: `.qwen-job-*`(TTS job_dir), `audioforge_refclip_*`(참조 클립), `audioforge_config_*`(config), output_dir/AudioForge_output. 각 임시물의 **소유 모드·정리 시점(성공/실패/취소/재시작)**을 모드별로 못박아야 함 → 공통 표 필요(§17 P1).

## 8. 재시도 (명시 vs 자동)

- **불변식 RT1**: **자동 재시도 없음**(조용한 재시도·x-vector 강등·기본 폴백 금지). [F/C]
- **불변식 RT2**: 사용자 명시 재시도만 허용, **1클릭=1회**. [O] TTS generation-retry E2E 확인.
- 예외[F]: CUDA OOM → CPU 1회 **가시적** 재시도(조용한 재시도 아님, progress로 안내). 이는 "자동 재시도"가 아니라 "장치 강등 가시 폴백"으로 분류 → 모드 공통 규칙: 자원 부족 폴백은 **가시적**이어야 함.

## 9. Resume / Checkpoint

- 현행[F]: **resume 없음** — 모든 job은 전체 재실행. session.json은 "설정+결과 트랙 복원"(재분리 없이 UI 상태 복원)이지 job resume이 아니다.
- 계약[I]:
  - **불가 조건**: 생성축(비결정적 TTS/가창), 부분 상태가 최종품질에 영향 주는 모드.
  - **가능 후보**[R]: 파일 단위 독립 산출(split의 개별 구간, 음악의 스템별) → 완료된 산출은 재사용하고 남은 것만 재개. 조건: 산출 원자성(§7) + 결정성 확보 시. 조사 결과로 확정(§16 슬롯).

## 10. 자원(GPU/CPU/VRAM/disk) 예약·경합

- 현행[F]: `select_device(min_free_mb)` — Qwen 전용 VRAM 임계로 cuda/cpu 선택(ComfyUI 병행 안전 목적). 전역 예약 매니저 **없음**. 각 job이 실행 시점 free VRAM으로 장치 결정.
- 관측[O]: 다른 ML(예: ComfyUI)이 GPU 점유 시 free 부족 → CPU 폴백 또는 성능 저하(메모리: Ollama VRAM 스필 락 — 붐빌 때 로드 시 상주 내내 저하).
- 계약[I]:
  - **불변식 RS1**: GPU job은 실행 전 free VRAM·경합을 측정하고, 임계 미달 시 (a) CPU 폴백(가시) 또는 (b) 대기(직렬화). 조용한 성능 저하 금지.
  - disk: 임시물 폭주 방지 — 실행 전 여유 공간 확인·정리 보장(§7).
  - 전역 자원 조정자[R]: 여러 모드 동시 실행 시 예약/경합 정책은 조사·설계 필요.

## 11. 동시 실행 vs 직렬화

- 현행[F]: `audio:process`는 `runner.isRunning`이면 새 job 거부 → **주 job 직렬화**. `trackRunner`(track-process)는 별도 인스턴스(부분 동시성). preflight/prepare(ref-analyze/trim/transcribe)는 `runner.isRunning`이면 거부(주 job과 배타). preflight는 single-flight(중복 subprocess 1회).
- 계약[I]:
  - **불변식 CC1**: 같은 자원(GPU 모델)을 쓰는 무거운 job은 **직렬화**. 경량·독립(prepare/probe, 서로 다른 자원)은 동시 허용 가능하되 명시.
  - **불변식 CC2**: prepare/probe(preflight·analyze·trim)는 job이 아니며 취소 lifecycle 대상이 아니다 — 단, 주 job과 자원 배타는 유지.

## 12. 재시작·crash 후 orphan 감지·복구

- 현행[F]: before-quit bounded tree kill(K3) + `.qwen-job-*` 스윕 + session.json 복원. `qwenVenvPids()`(CIM + worktree 스코프)로 현재 worktree Qwen 자식 열거.
- 격차[I]:
  - crash(정상 종료 아님) 시 자식·임시물 orphan 감지·정리가 **부팅 시 자동화되어 있지 않다** → **P1**. 부팅 시 orphan 스캔(mode별 임시물 prefix + 프로세스) + 사용자 안내/정리.
  - 비-TTS orphan(demucs/whisper/ffmpeg 자식) 열거는 미형식화 → **P1**.

## 13. 민감정보 비노출 (공통, 강한 불변식)

- **불변식 SEC1**: 로그·metadata·오류 payload에 사용자 원문 대사·미디어 바이트·전사 전문·prompt·전체 경로를 넣지 않는다. code·수치·해시(sha8)·비민감 식별자만. [F/O] TTS I1–I4 + 오류 payload code-only + a11y "원시 stack/path/전사 미노출" E2E.
- 모드 일반화[I]: 전사(transcribe)·대화(conversation)는 **본문이 곧 산출물**이라 특히 위험 — 산출은 파일로만, metadata엔 길이/언어/해시만. 각 모드 metadata 화이트리스트 필요(§14).

## 14. Session / Result metadata schema + version

- 현행[F]: `session.json` = `{ version:1, session_schema_version:2(TTS 도입), source, sourceName, mode, options, tracks, metadata, createdAt }`. TTS result metadata = `_METADATA_KEYS` 화이트리스트(고정 키만, 대사 전문 없음).
- 계약[I]:
  - **불변식 M1**: 공통 envelope `{ schemaVersion, mode, jobId, source(basename/fingerprint), createdAt, tracks[], metadata(mode별 화이트리스트) }`.
  - **불변식 M2**: metadata는 **모드별 화이트리스트**(비민감)만. 스키마 버전으로 하위호환(구 세션 = 기본/off로 복원, 조용한 변형 금지 — TTS 정정8 일반화).

## 15. 모드별 차이 요약 (cancellation·cleanup·atomicity)

| 항목 | TTS[F] | 음악/대화[I] | split/track-process[F/I] | 전사[I] |
|---|---|---|---|---|
| 취소 tree kill | K2 완전(settlement·합류) | runner.cancel 공통, cleanup 미형식화 | trackRunner fire-and-forget(P0) | runner.cancel 공통 |
| cleanup 스코프 | `.qwen-job-*` bounded 확인 | 부분 스템·임시물 미형식화(P1) | 분할 임시물 미형식화(P1) | 부분 전사 임시물(P1) |
| 산출 원자성 | 단일 os.replace(완전) | 다중 트랙 일괄 publish 미형식화(P1) | 다중 파일(P1) | 텍스트/SRT 원자성(I) |
| 비민감 metadata | I1–I4 형식화 | 미형식화(P1) | 미형식화(P1) | 본문 위험 큼(P0 검토) |
| 비결정성 | 있음(생성 tail) | 대체로 결정적(I) | 결정적(I) | 대체로 결정적(I) |

## 16. Synthetic/mock conformance fixture + E2E 매트릭스 (공통)

- 원칙[F/O]: 사용자 미디어 미사용, **synthetic WAV**(순수 생성) 또는 승인된 fixture. 임시물은 실행 전용 UUID 경로, finally에서 이번 실행 경로만 정리. resources/외부 무접촉.
- 공통 conformance 축(모드 무관): 진입/재진입 검은화면·pageerror·crash 0 / 취소 lifecycle(tree kill·cleanup·idle) / 원자 교체·기존 결과 보존 / orphan·임시물 0 / metadata 비민감 / progress 단조.
- 현행 커버[O]: TTS 계열 E2E(smoke·editor·restore·detail·preview·pitch-capability·generation-retry·cancel-lifecycle·result-metadata·accessibility·editor-ux·emotion-reference·reset-cleanup). 비-TTS 모드 E2E는 **미비** → **P1**(모드별 synthetic conformance 추가).
- **reference 슬롯[R]**: 모드별 조사 에이전트 산출(음악분리·대화·텍스트추출·영상분할)을 여기에 연결. 관련 기존 문서: `research/cross-mode-reliability-audit.md`(별도 audit 브랜치).

## 17. 미해결 P0/P1 (trackRunner fire-and-forget 포함)

- **P0-1 trackRunner 잔존**[F/I]: track-process(영상분할)의 trackRunner는 K2 settlement/bounded-cleanup 합류가 없어, 취소·완료 시 자식 프로세스·부분 산출물 잔존 가능. → runner와 동급의 terminal 권위·정리 합류 필요.
- **P0-2 전사/대화 본문 노출 위험**[I]: 산출 본문이 곧 민감 텍스트 — metadata/로그 화이트리스트를 모드별로 강제하기 전까지 위험.
- **P1-1 다중 output 원자성**: 음악/대화/split의 다중 파일 일괄 publish·부분 실패 처리.
- **P1-2 비-TTS cleanup 스코프**: 각 모드 임시물 소유·정리 시점 형식화.
- **P1-3 job 식별/DAG 상태 승격**: jobId·parent/child·queued/preparing/cleanup 상태.
- **P1-4 inactivity timeout·crash orphan 자동 감지**.
- **P1-5 비-TTS conformance E2E**.

## 18. 소유권·병합 순서 (문서 계약)

- 이 문서는 DOC ONLY. production 반영은 별도 승인·별도 단계.
- 병합 순서(제안)[I]: 이 계약 승인 → 모드별 조사(별도 에이전트) 결과를 §16 슬롯에 연결 → P0부터 production 계약화(각 소유 모드/파일) → 모드별 synthetic conformance E2E → 통합.
- 금지: 이 브랜치에서 production/test/package 수정, develop/master/expression-integration 병합.

## 19. 확정된 공통 불변식 (요약)

J1 job 식별 · J2 parent 권위 · S1 단일 정착 · S2 취소 중 신규 차단 · P1 진행 권위=main · P2 단조 · K1 audio:cancel terminal 권위 · K2 tree kill 확인 · K3 종료 시 kill · A1 원자 1회 교체 · A2 실행 전용 임시폴더 · RT1 자동 재시도 금지 · RT2 명시 1클릭=1회 · RS1 가시적 자원 폴백 · CC1 동일자원 직렬화 · SEC1 민감정보 비노출 · M1/M2 공통 metadata envelope+버전.

(현행 완전 충족=TTS. 타 모드는 [I]/[R] — production 계약화는 §17 P0/P1 순서로.)

---

# 후속 보강 (research intake 1차 — 음악·대화·텍스트, DOC ONLY)

조사 문서 3종(§28 reference)을 read-only로 코드 대조 후 반영. 사실 감사[O]: 세 문서의 현행 판독은 develop `b933ab5`와 일치 —
`separate.py` 음악 5 preset + `music_worker.run_roformer_ensemble`, `conversation_worker.py`(Silero VAD+ECAPA+spectral
clustering=argmax 마스킹), `transcribe_worker.py`(Whisper ASR, RMS 0.005, condition_on_previous_text=False,
hallucination_silence_threshold=2.0). 미구현 기능을 구현된 듯 표현한 부분 없음. 영상 분할은 조사 진행 중 → §28 placeholder.

## 20. Job 종류 구분 (kind)

작업을 4종으로 분류하고, kind는 §3 상태 DAG와 **직교**(같은 DAG, 다른 품질 계약)한다.

- **analysis**: 입력에서 구조/라벨 추출 — ASR(텍스트 추출), diarization(대화), (향후) OCR·scene detection. 산출=구조화 artifact + confidence + provenance. **원본을 변형하지 않음.**
- **transformation**: 신호 변형 — 음악 분리, trimming, pitch, audio finishing. 산출=변형된 오디오(길이/sr/채널 보존 계약).
- **generation**: 무→유 생성 — TTS, 향후 singing. 비결정성 가능(생성 tail).
- **composite**: analysis→transformation→generation 파이프라인(예: 대화 분석→화자 분리→다화자 TTS). 각 stage가 자기 kind 계약을 따르고 parent job이 stage DAG를 소유(§2 J2).

[F] 현행 매핑: music/conversation=transformation+analysis 혼재(분리 마스킹+diarization), transcribe=analysis, tts=generation. **불변식 KIND1**: 한 job은 primary kind를 선언하고, composite는 stage별 kind를 명시(analysis 산출을 transformation/generation 산출과 같은 artifact kind로 뭉개지 않음 — §25 대화, §26 텍스트).

## 21. Artifact manifest (공통 산출물 계약)

모든 산출물(임시/부분/최종)은 아래 manifest 항목으로 기술한다. 원문·전사·prompt 본문은 **넣지 않는다**(§4 SEC1, `sensitive_content=true`면 본문은 보호 artifact에만).

```
artifact_id · job_id · parent_job_id · stage · mode · kind(analysis|transformation|generation|composite)
· publish_state(temporary|partial|final) · source_fingerprint · model_config_fingerprint(name·url·sha256·license)
· size · checksum(sha256) · created_at · sensitive_content(bool) · cleanup_owner(job|session|app-quit)
```

- **불변식 ART1**: `final`은 §22 two-phase publish 통과 후에만 부여. `temporary`/`partial`은 final과 **다른 namespace/state**.
- **불변식 ART2**: `cleanup_owner`가 정리 주체·시점을 명시(§7 P1-2 해소 축). manifest 없는 산출물은 orphan(§12).

## 22. 다중 산출물 two-phase publish

TTS 단일 os.replace(§7 A1)를 다중 산출(stem/track/subtitle/chunk)로 일반화.

1. **prepare**: 모든 산출을 job 임시 namespace에 쓰고 manifest(§21) 작성.
2. **validate all**: 전 산출 검증(모드별 §24–§26) — 하나라도 실패면 **final 미노출**, 기존 final 보존, job=failed, 임시물 정리.
3. **atomic manifest publish**: 전부 통과 시 manifest 단위로 원자 노출(개별 파일 부분 노출 금지).
4. **partial**: 부분 성공물은 `partial` state로 별도 namespace 유지(final로 오인 금지). 앱 재시작 시 orphan partial 탐지(§12).

- **불변식 PUB1**: 검증 전 어떤 stem/track/subtitle/chunk도 final로 노출하지 않는다.
- **불변식 PUB2**: 실패 시 기존 final 무손상(A1 계승). cancel(§5)은 publish 직전에도 부분물을 final로 승격하지 않는다.

## 23. Provenance·confidence (analysis 산출)

- **불변식 PROV1**: 전사·화자·OCR·scene boundary 등 analysis 결과값은 **confidence·provenance와 분리 저장하지 않는다**(한 레코드에 값+점수+출처 동반).
- **불변식 PROV2**: metadata envelope(§14)에는 count·hash·version·status만. 원문·전사 본문은 **보호된 결과 artifact** 안에만(§4 SEC1).
- 공통 필드[I]: `{ value, raw_scores, calibrated_score?, provenance{source_kind, source_interval, engine, model_config_fingerprint, timing_source}, decision(accept|review|suppress)+reasons }`.

## 24. 음악 분리 계약 (transformation)

[F 근거: music-separation-techniques.md §2.2 위험 + 코드 대조]

- **MUS1 앙상블 입력 정합**: 앙상블/합성 전 sample rate·channel·length·offset·polarity·gain 일치 검증. 불일치 시 **조용한 truncate/평균 금지** — 단일 모델 fallback 또는 명시 실패(현행은 최소 길이·채널로 잘라 평균 → P0).
- **MUS2 stem 검증**: stem별 finite·peak·length 보존. mixture consistency(`‖mixture − Σstems‖`) 측정.
- **MUS3 품질 metric ≠ 상태 DAG**: leakage·phase·transient·chunk seam은 **품질 metric**이며 §3 상태 DAG와 분리(promotion gate용, job 성공/실패 판정과 별개).
- **MUS4 provenance**: model URL·SHA-256·config·license manifest(§21). 자동 다운로드를 production 기본으로 두지 않음.
- 다중 stem 산출은 §22 two-phase publish 대상(부분 stem 노출 금지).

## 25. 대화 처리 계약 (analysis; 분리 아님)

[F 근거: dialogue-processing-techniques.md §1·§2.1 + `conversation_worker.py` 코드 대조]

- **DLG1 [F]**: 현행 conversation은 **실제 source separation이 아니라 frame당 단일 화자 argmax 마스킹**이다. 산출을 "분리"로 표현하지 않는다.
- **DLG2 overlap 다중 라벨**: `speaker_label: scalar` → `active_speakers[] + posteriors`. 겹침 프레임을 손실 없이 다중 라벨로 표기(argmax 전 posterior 보존).
- **DLG3 UNKNOWN/REVIEW**: 낮은 posterior margin·부족한 순수 발화는 억지 귀속 대신 `UNKNOWN`/`REVIEW` 상태.
- **DLG4 word-level attribution**: 원본 1회 전사+정렬 후 diarization posterior와 단어 구간 결합(§23 PROV).
- **DLG5 구조화 artifact**: RTTM·CTM·canonical JSON(session/turn/word/source interval/version/confidence). TXT/SRT는 파생.
- **DLG6 kind 분리**: diarization 분석과 다화자 TTS 생성은 **별도 job kind**(analysis vs generation). 분석 speaker_id를 자동으로 TTS 참조로 넘기지 않음(동의 경계).

## 26. 텍스트 추출 계약 (analysis)

[F 근거: text-extraction-techniques.md §1·§2 + `transcribe_worker.py` 코드 대조]

- **TXT1 [F]**: 현행 "텍스트 추출"은 **이미지 OCR이 아니라 Whisper 기반 오디오 ASR**이다. artifact kind를 OCR과 뭉개지 않는다.
- **TXT2 canonical segment**: Whisper raw 세그먼트·단어 시간·점수(avg_logprob·no_speech_prob·compression_ratio·word prob)·filter 사유를 **하나의 canonical segment list + provenance sidecar**에 보존. TXT/timeline/SRT/translation/UI는 이 단일 소스에서 파생.
- **TXT3 SRT publish sanitizer**: 겹침·역전·0길이 cue 금지, 문장부호·침묵·CPS·CJK grapheme·최대 2줄로 재분할. 번역은 원문 cue ID/time 유지(모델이 cue 수 변경 금지).
- **TXT4 향후 video OCR = 별도 analysis stage**: ASR transcript와 OCR text를 같은 artifact kind로 뭉개지 않음. video OCR은 temporal dedupe·reading order·subtitle timing(§28 영상 계약)을 자기 계약에 포함.
- **TXT5 민감**: transcript 본문은 metadata가 아니라 보호 artifact로만(§23 PROV2). RMS 저음량 오삭제는 품질 metric(§8 fixture)으로 별도 측정.

## 27. 공통 conformance fixture 초안 (synthetic/mock, GPU·사용자 미디어 없음)

모드 무관 공통 시나리오(각 모드가 자기 검증을 추가). 실행 전용 임시 경로, finally 정리, resources/외부 무접촉.

| ID | 시나리오 | 핵심 단언 |
|---|---|---|
| CF01 | 성공 | 전 산출 final publish + manifest 정합 |
| CF02 | prepare 실패 | job=failed, final 무변경, 임시물 0 |
| CF03 | 일부 artifact 생성 후 실패 | partial state 유지, final 미노출, 기존 final 보존 |
| CF04 | validation 실패 | two-phase publish 중단, final 미노출 |
| CF05 | publish 직전 cancel | 부분물 final 승격 안 함, cancelled 상태, tree kill+cleanup |
| CF06 | publish 후 cleanup | 임시물 0, final·manifest 잔존 |
| CF07 | 앱 crash 후 orphan | 부팅 시 orphan partial/프로세스 탐지·표시 |
| CF08 | 동일 job retry | 사용자 명시 1클릭=1회, 자동 재시도 0 |
| CF09 | parent cancel | 모든 child stage 종료, 잔존 0 |
| CF10 | GPU unavailable | 가시적 CPU 폴백 또는 대기(조용한 저하 금지) |
| CF11 | disk full | 실행 전/중 감지, 명시 실패, 임시물 정리 |
| CF12 | metadata 민감정보 거부 | 원문·전사·prompt가 envelope에 없음(있으면 실패) |
| CF13 | checksum mismatch | 산출 검증 실패 → publish 중단 |
| CF14 | multi-output 한 개 누락 | 전체 publish 실패(부분 노출 금지) |
| CF15 | progress 역행 | 단조 위반 거부(P2) |

## 28. 영상 분할 — placeholder / reference slot [R]

영상 분할 조사는 **진행 중**. 문서 도착 시 별도 후속 DOC ONLY 커밋으로 반영:
- trackRunner fire-and-forget(§17 P0-1) 해소 · shot/scene/event 경계 · 부분 산출물 two-phase publish(§22) · resume/checkpoint(§9) · cleanup(§7).
- burned-in subtitle는 §26 TXT4(video OCR analysis stage)와 연결.

### Reference 문서 (research intake 소스)
- 음악 분리: `apps/development/AudioForge/doc/references/music-separation-techniques.md`
- 대화 처리: `apps/development/AudioForge/doc/references/dialogue-processing-techniques.md`
- 텍스트 추출: `_af_worktrees/integration/doc/references/text-extraction-techniques.md`
- 영상 분할: `doc/references/video-segmentation-techniques.md`(통합 완료 — §29·§30 반영)
- 기존 audit: `research/cross-mode-reliability-audit.md`(별도 브랜치)
- intake 요약표: `doc/design/cross-mode-research-intake.md`(동반 문서)

> §28은 영상 분할 조사 완료로 §29(계약)·§30(fixture)에서 확정됨. 이하는 그 반영분.

## 29. 영상 분할 계약 (오디오 트랙 분할 = 현행; 영상 shot/scene = 미래 별도 job)

[F 근거: video-segmentation-techniques.md §2 + `separate.py::_run_split`·`silencedetect=noise=-35dB:d=1.5`·`_save_tracklist`,
`audio.ipc.ts::audio:process-track`(fire-and-forget)·`trackRunner`(WATCHDOG_MS=300000)·`SplitEditor.tsx` 코드 대조]

- **VID1 명칭 정정 [F]**: 현행 `split`은 영상 frame 기반 shot/scene 분할이 아니라 **오디오 기반 트랙 분할**(수동 timestamp `splitMarkers` 또는 무음 감지)이다. UI/문서에서 `오디오 트랙 분할`로 표기하고, 미래 **영상 shot/scene/event 분할은 별도 job/stage**로 구분한다(같은 이름으로 뭉치지 않음).
- **VID2 무음 규칙 provenance [F]**: UI(adaptive RMS·1초·첫 채널)와 Python(고정 `-35dB`·1.5초·FFmpeg mix)의 무음 판정이 **서로 다르다**. detector/version/config를 manifest에 기록하고 `interactive-preview`/`batch`로 구분(조용한 결과 차이 금지).
- **VID3 marker 검증**: 경계 생성 전 main·worker 양쪽에서 finite · `0 < t < duration` · strictly increasing · epsilon 중복 병합 · min-gap · label cardinality 검증(현행 없음 → P0). 빈/0-duration probe는 명시적 실패로 정착.
- **VID4 detector ≠ export 경계**: detector 경계(`requestedPts`)와 실제 export 경계(`exportedStartPts/EndPts`)를 분리 기록. keyframe snap/encoder rounding을 숨기지 않고, 초 metadata가 아니라 실제 첫/마지막 sample·PTS·duration으로 검증.
- **VID5 시간축 권위**: 원본 time base의 integer PTS를 권위로(UI만 초 변환). PTS·timebase·keyframe·source fingerprint를 산출 metadata에 기록.
- **VID6 staging + two-phase publish**: 복수 WAV/JSON/`_tracklist`를 실행 전용 staging에 전량 생성·검증 후 **manifest 단위 전체 세대 원자 publish**(§22). 개별 파일 순차 publish·이전 세대 혼입 금지(현행은 output에 즉시 순차 write → P0). track-process의 `.txt/_timestamps.txt/.srt/_korean.txt`도 동일 publish 계약.
- **VID7 terminal event 분리 [F]**: `trackRunner`는 **실행 가드·5분 inactivity watchdog·PythonRunner tree cancel을 이미 갖는다**(전무 아님). 그러나 `audio:process-track` IPC는 spawn 직후 성공 반환(fire-and-forget)이라 clean-no-result·전역 cancel 시 TrackList 행에 terminal event가 없어 `processing` 고착 가능. → `accepted(jobId)`(spawn 확인)와 `completed|failed|cancelled(jobId)`(terminal)를 **분리**하고, renderer는 terminal event로만 행 상태를 끝낸다. **IPC return은 completion 신호가 아니다.**
- **VID8 timeout 구분**: inactivity timeout(현행 5분 watchdog) · per-stage timeout · 전체 hard deadline을 분리. 긴 무음·긴 scene 자체는 inactivity가 아니며 worker heartbeat/progress 권위(§4)를 정의.
- **VID9 cancel 정리**: cancel 시 worker/FFmpeg tree 종료 **확인 후**, job manifest가 소유한 정확한 staging만 정리(다른 세대·기존 결과 무접촉).
- **VID10 crash orphan**: 앱 재시작 시 running manifest는 orphan으로 판정하되 source/result를 삭제하지 않고 staging 검증 후 resume 가능/폐기 가능 상태로 노출. config는 현행 done에서만 삭제 → crash 후 orphan 규칙 필요(P0).
- **VID11 partial ≠ final**: 부분 결과는 final과 다른 namespace/state(§22). resume은 `source fingerprint · detector config · boundary plan`이 **모두 같을 때만** 허용(feature/index·미publish 결과까지만 재사용).
- **VID12 민감정보**: 원본 절대 경로·자막/전사 본문은 progress/log/telemetry/metadata에서 제외. source ID/fingerprint와 allowlisted metadata만(§4 SEC1·§23).
- **VID13 parent/child 구조**: `split` parent 아래 detector/index/extract/publish child. parent cancel은 모든 child를 terminal 상태로 만든 뒤에만 완료(§2 J2).

## 30. 영상 분할 conformance fixture (synthetic/mock, GPU·사용자 미디어 없음)

FFmpeg test source/color/sine/noise로 생성, 실행 전용 임시 경로·finally 정리·resources 무접촉. boundary JSON뿐 아니라
각 segment 첫/마지막 sample·PTS, 합계 duration, gap/overlap, A/V sync, decode 가능성, manifest hash를 검사.

| ID | 시나리오 | 핵심 단언 |
|---|---|---|
| VF01 | marker NaN/inf | 경계 생성 전 거부(VID3) |
| VF02 | 음수·duration 초과 marker | 범위 밖 거부 |
| VF03 | 정렬 역전·중복 marker | strictly increasing·중복 병합, 조용한 통과 금지 |
| VF04 | segment N개 중 N−1 생성 후 실패 | final 미노출, 기존 세대 보존, staging만 정리(VID6/VID9) |
| VF05 | publish 직전 cancel | 부분물 final 승격 금지, cancelled terminal event(VID7) |
| VF06 | clean-no-result | 행이 `processing` 고착 없이 terminal(완료 계약, VID7) |
| VF07 | 전역 cancel | 모든 TrackList 행 terminal event, 잔존 0 |
| VF08 | child exit 후 terminal event 누락 | accepted↔completed 분리로 행 정착(VID7) |
| VF09 | 앱 crash 후 orphan staging | 재시작 시 orphan 판정·source 무삭제(VID10) |
| VF10 | VFR·non-zero PTS·long GOP | requested/exported PTS 분리 검증(VID4/VID5) |
| VF11 | exported boundary 오차 | detector 오차와 exporter 오차 분리 측정 |
| VF12 | 고정 chunk N±1 overlap transition | 중복·누락 없이 valid region만 정착 |
| VF13 | A/V offset·drift | 보정/경고, 불명확 시 fusion off(§3.5 근거) |
| VF14 | flash·camera motion·fade/dissolve | flash 과검출 억제·fade는 interval로(향후 visual detector) |
| VF15 | 동일 source/config resume | fingerprint 일치 시에만 재개, 중복 연산 최소 |
| VF16 | source fingerprint 변경 후 resume | resume 거부(VID11) |
