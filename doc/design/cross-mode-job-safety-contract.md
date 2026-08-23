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
