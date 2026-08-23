# TTS 쉼·말끝·경계 오디오 처리 계획 (Phase 1: 설계 전용)

브랜치: `feature/tts-boundary-pause` (origin/develop `b933ab5`에서 분기).
성격: **설계·감사·합성 재현 전용.** production 코드 수정 없음. 이 문서 + 선택적 test-only synthetic 스캐폴딩만 산출.
관련 계약: `doc/work-in-progress/tts-prosody-integration-contract.md`(pitch/감정/취소 계약 — 이 작업의 상위 계약).
에이전트 역할 분담(이번 사이클): **A=쉼(pause) grammar**, **B(본 문서)=쉼·말끝·경계 오디오 처리**, **C=UI**.

---

## 0. 요약 (사실 우선)

- 현재 파이프라인은 **최종 말끝(tail) 처리가 전혀 없다.** 마지막 chunk의 마지막 샘플 그대로 파일이 끝난다.
  마지막 샘플 진폭이 크면 재생 종료에서 불연속(클릭)이 나 **"칼로 자른 듯"** 들린다 → **증상의 1차 근인.**
- **내부 자동분할 chunk 경계**는 `gap=0`으로 raw 이어붙이기(무음/페이드/zero-cross 없음). 서로 다른 조각의
  진폭이 어긋나면 이음매에서도 미세 클릭 가능(2차 근인 후보).
- **문장/감정 경계**는 `silence_gap` 초의 **디지털 무음**을 삽입한다(이미 구현됨). 이건 "쉼"의 한 형태지만
  전면적(전 경계 동일값)이고, **명시적 [쉼 N] 문법**이나 **감정 전환별 정책**은 없다.
- pitch는 speed·결합이 끝난 **최종 후보에 후처리**로 적용되고 `os.replace`로 원자 교체된다(계약 §6.1 준수).
  **말끝 처리는 이 원자 교체 직전에 끼워야 하며, 이 지점이 A 소유 `pitch_shift.place_final_with_pitch`와 만나는
  핵심 충돌점**이다(§8).
- **구현 가능(now)**: 최종 말끝 padding+조건부 fade, 내부 경계 zero-cross/짧은 crossfade, 온전한 줄 사이 [쉼 N].
  **연구 필요(research)**: 문장 중간 [쉼 N](분할이 생성축 억양에 주는 영향), crossfade가 생성 내용에 주는 영향 실측.

---

## 1. 현재 처리 순서 감사 (file:line)

### 1.1 Qwen 배치 경로 — `python/tts_worker.py::_synthesize_qwen_job` (L856–1063)

| 단계 | 위치 | 내용 |
|---|---|---|
| 장치 선택 | L868–874 | Qwen 전용 VRAM 임계로 cuda/cpu 선택 |
| 참조 품질 게이트 | L879–892 | 모델 로딩 전 참조 판정(10초 초과/무음/손상 차단) |
| **생성(모델)** | L933 `qwen.run_job` | bridge가 per-chunk WAV 생성(mono, 모델 native sr). **bridge에 tail/fade/무음 처리 없음**(grep 확인) |
| chunk 정렬 | L989–991 | `(original_segment_index, chunk_index)`로 정렬 = 원문 순서 |
| **속도(speed atempo)** | L1012–1015 `_atempo_segment` | `speed!=1`이면 **chunk별** ffmpeg atempo(결합 前) |
| 결합 전 검증 | L1019 `_assert_concat_ready` | 전 chunk 동일 sr·mono·finite·non-empty |
| gap 계산 | L1021–1027 | 내부 chunk 경계 `0.0`, **원 segment(줄바꿈) 경계에만 `silence_gap`** |
| **결합** | L1030 `_concat_with_boundaries` | zeros 삽입 + `np.concatenate`. **경계 페이드·zero-cross·최종 말끝 처리 없음** |
| **pitch 후처리 + 원자 교체** | L1036–1039 `pitch_shift.place_final_with_pitch` | 최종 후보(pending) → (pitch) → 검증 → `os.replace(final)` |
| 정리 | L1060–1063 `finally: rmtree(job_dir)` | 실행별 임시폴더 전체 삭제(무손상 계약) |

### 1.2 per-segment 경로 — `python/tts_worker.py::synthesize` (L1191–1371)

| 단계 | 위치 | 내용 |
|---|---|---|
| 줄 파싱 | L1205, L1213 `_parse_line` | 줄 단위 split + `[감정] 텍스트` 파싱 |
| 참조 준비 | L1220–1244 | 기본/감정 참조 mono/24k 준비 |
| **생성+속도** | L1276–1295 | 엔진이 `speed`를 합성 시 직접 반영(engine.synthesize_segment) |
| **결합** | L1304–1310 | 단일=후보 그대로 / 복수=`_concat_with_silence(…, silence_gap)` |
| **pitch + 원자 교체** | L1311–1314 | Qwen과 **동일** 공통 함수 `place_final_with_pitch` |
| 정리 | L1315–1326, L1364–1370 | 세그먼트/concat 임시본 + 참조 임시폴더 삭제 |

### 1.3 결합 함수 상세

- `_concat_with_boundaries(paths, gaps_before, output_path)` (L1156–1175): `gaps_before[i]>0`이면 각 파일 **앞**에
  `int(g*target_sr)` 샘플 zeros. 첫 파일 sr을 target으로. **페이드/zero-cross/말끝 없음.**
- `_concat_with_silence(segment_paths, output_path, silence_gap=0.5)` (L1118–1133): 각 세그먼트 뒤에 무음, 마지막 것 pop.
  per-segment 경로 전용. **동일하게 말끝/페이드 없음.**
- `_atempo_segment` (L772–799): ffmpeg atempo, 실패 시 부분출력 삭제 후 예외.

### 1.4 pitch 공통 최종 단계 — `python/pitch_shift.py::place_final_with_pitch` (L144–200)

- `src_candidate`(완성된 최종 후보) → `st!=0`이면 rubberband로 `.pitch-tmp.wav` 생성 → 검증(존재/non-empty/sr/finite)
  → `os.replace(candidate, final_path)`. **유일한 원자 교체 지점.** length·SR 보존, formant=preserved.
- **이 함수가 전 엔진 공통 "최종 후보 → 원자 교체" 병목**이다. 말끝 처리는 이 병목과 협의해 배치돼야 한다(§8).

### 1.5 설정·스키마 흐름

- 렌더러 옵션 → `src/shared/ttsConfig.ts::buildTtsConfig`(L211) → `ttsSilenceGap`(`?? 0.5`), `ttsPitch`(`?? 0.0`).
- `src/main/ipc/audio.ipc.ts::audio:process`(L429)가 config JSON 작성 → `separate.py`.
- `python/separate.py`: L73 `tts_silence_gap`, L79 `tts_pitch` 읽어 L151–156 `synthesize(...)` 호출.
- metadata 고정 키: `tts_worker.py::_METADATA_KEYS`(L802–816)에 `silence_gap`, `pitch_*` 등 존재. **pause 관련 키 없음.**

---

## 2. 증상 재현 (SYNTHETIC WAV — 사용자 음성 미사용)

### 2.1 재현 설계

사용자 음성/파형을 열지 않고 sine+envelope로 **최악 경계 신호**를 합성해 증상을 수치로 재현한다.

- **flat/peak envelope**: 진폭 유지, 마지막 샘플을 peak로 강제(`make_sine(envelope="click_ready")`) →
  재생 종료(암묵적 0)와의 불연속 `edge_step = |마지막 샘플|`이 크다 = **"칼로 자른 듯" 재현.**
- **decay envelope**: 끝에서 0으로 감쇠 → 이미 무음 tail(패딩만 필요, fade 불필요 케이스).
- 지표(순수 stdlib): `edge_step`(끝 불연속), `last_amp`(말끝 win 진폭), `max_boundary_step`(내부 이음매 점프).

### 2.2 픽스처 & 스캐폴딩

`python/test_boundary_pause_synth.py` (본 브랜치 신규, **TEST-ONLY / PROTOTYPE**):
- 순수 stdlib(`wave`/`math`/`array`/`struct`)만 사용 → **이 워크트리에서 그대로 실행됨**(numpy/soundfile 불필요).
  검증: 9 테스트 통과(`python -m unittest python/test_boundary_pause_synth.py`, 로컬 stdlib py 3.14로 확인).
- 정책 프로토타입 포함: `apply_tail_policy`(조건부 fade + padding), `cosine_fade_out`, `zero_cross_trim`.
- **production `_concat_*`/`place_final_*`는 soundfile+numpy 의존** → 그 함수를 직접 부르는 통합 테스트는
  **공유 qwen venv 필요, 여기서는 실행하지 않음**(§7에 실행 조건 명시).

---

## 3. 순서 계약 (생성 → pitch/속도 → 조각 경계 → 문장/감정 간격 → 최종 말끝 → 원자 교체)

확정 순서(전 엔진 공통 목표 형태):

1. **생성(generation)** — 모델이 chunk/segment WAV 산출. (변경 없음)
2. **속도(speed)** — chunk/segment별 atempo. **결합 前**(현재 그대로). 길이 변형 축.
3. **조각 경계(internal chunk boundary)** — 자동분할 내부 이음매. 긴 페이드 금지. zero-cross 또는 5–15ms crossfade.
   **원문 내용·chunk 순서 불변**(§5).
4. **문장/감정 간격(segment/emotion gap)** — 원 segment 경계 무음. 기본 `silence_gap`, [쉼 N]·감정정책으로 재정의(§6·§7).
5. **최종 말끝(final tail)** — 결합·pitch가 끝난 최종 신호에 padding(+조건부 fade). **파일당 1회, 마지막 콘텐츠 변형**(§4).
6. **원자 교체(atomic replace)** — `os.replace(final)`. 유일 교체 지점, 실패는 교체 前 예외로 기존 wav 보존.

> **pitch vs 말끝 순서 결정(§8)**: pitch(rubberband)는 length-preserving·formant-preserved. 말끝 진폭 판정을
> "실제 기록될 신호"에서 하려면 pitch **후**가 이상적이나, 그러면 A 소유 `place_final_with_pitch`를 확장해야 한다.
> **권장(1안)**: 말끝 처리를 **pitch 前** 후보에 적용해 A 모듈 무접촉 유지. ±2반음·formant 보존이라 진폭 변화가
> 미미해 pre-pitch 진폭 판정이 실무상 안전. 이 결정은 integration에서 최종 확정(§8에 1·2안 비교).

---

## 4. 최종 말끝 padding/fade 정책 (임계·근거)

목표: 재생 종료의 불연속 제거 + 말끝이 "숨 쉴 공간"을 갖게. **호흡음 합성 아님 — 무음 padding + 미세 fade만**(§9).

- **tail padding**: 기본 **~120ms** 무음을 최종 신호 끝에 덧붙인다. (근거: 말끝 여운으로 자연스럽되, 문장 간
  `silence_gap`(기본 0.5s)과 겹쳐 과도해지지 않는 값. 파일 끝에만 1회.)
- **조건부 fade**: 마지막 win(**5ms**)의 peak 진폭이 임계 **> 0.02**(≈ -34 dBFS)일 때만 **5–12ms 코사인/equal-power
  fade-out**을 padding 直前에 적용. **이미 무음이면(≤0.02) fade 없이 padding만**(무의미한 신호 변형 회피).
- **길이·정합**: padding·fade는 mono·동일 sr 위에서. 최종 sr은 `place_final_with_pitch` 반환 `output_sample_rate`와 동일.
- **왜 fade가 padding보다 먼저?**: padding(무음)만으로도 끝 값은 0이 되나, flat/peak 신호는 **마지막 유효 샘플→0**
  자체가 급전이(1샘플 클릭). fade가 그 마지막 유효 구간을 0으로 부드럽게 낮춘 뒤 padding이 이어져야 클릭이 사라진다.
  (합성 테스트 `test_tail_policy_removes_click_on_high_tail`에서 `edge_step < 1e-6` 확인.)
- fade 곡선: equal-power(코사인) 기본. linear는 여전히 약한 기울기 불연속 가능 → 코사인 권장.

임계값은 config로 노출(§10) — 기본값은 위, 통합/실측으로 미세조정 여지.

---

## 5. 내부 자동분할 chunk 경계 정책

전제: 자동분할(`text_segmenter.split_for_generation`)은 **원문 슬라이스만** 사용해 `"".join(chunks)==원문`을 보장하고,
결합은 `(osi, ci)` 순서로 원문 순서를 보존한다. **경계 처리는 이 불변식을 절대 깨선 안 된다.**

- **긴 페이드 금지**: 내부 chunk는 원래 한 문장의 연속이므로 사이에 무음(gap>0)이나 긴 페이드를 넣으면 말이 끊긴다.
  현재 `gap=0`(연속)은 옳다 — 이건 유지.
- **후보 A — zero-cross 정렬**: 각 chunk 끝을 마지막 **~3ms 내** 가장 가까운 zero-cross까지만 트림(내용 대량삭제 없이
  이음매 점프 최소화). `test_internal_boundary_zero_cross_reduces_jump`로 점프 감소·트림 범위 제한 확인.
- **후보 B — 5–15ms crossfade**: 두 chunk를 짧게 겹쳐 equal-power crossfade. 이음매를 확실히 부드럽게 하나
  **경계 샘플을 섞으므로 "내용 불변"의 해석이 미묘**(파형은 바뀜; 텍스트/순서는 불변). → **needs-research**로 분류.
- **권장**: 1차는 **zero-cross 정렬(후보 A)** — 순수·안전·내용 파형 보존. crossfade는 실측으로 클릭이 남을 때만 도입.
- 내부 경계는 **말끝 처리(§4) 대상 아님** — 파일 끝이 아니기 때문. 말끝은 결합 완료본의 진짜 끝에만.

---

## 6. 감정 전환 경계 정책 (즉시 / 부드럽게 / 쉼 후)

원 segment 경계 중 **감정 id가 바뀌는** 경계에 적용할 3가지 모드(경계별 gap/blend 재정의):

- **즉시(immediate)**: gap `0` + (선택) zero-cross 정렬. 대화의 빠른 티키타카·감정 급전환 연출용.
- **부드럽게(smooth)**: gap `0` + 짧은 **crossfade(5–15ms)**. 톤 전환을 매끄럽게. (needs-research: 생성 억양 겹침 실측)
- **쉼 후(pause)**: gap = `silence_gap`(또는 감정전환 전용값). **현재 기본 동작과 동치** → 안전한 기본값.

계약: 감정 전환 경계 정책은 config 1개 값(`emotion_boundary_mode`)으로, 미지정 시 **`pause`(현행)**. 비-감정전환
경계(같은 감정, 단순 줄바꿈)는 항상 §7의 gap 규칙을 따른다. 감정 id는 `EMOTION_TAGS`(tts_worker) ↔ `EMOTION_GROUPS`(TTSEditor)
공유 id를 그대로 쓴다(새 키 체계 금지 — 계약 §4).

---

## 7. 명시적 쉼 문법 `[쉼 N]` (text → per-boundary gap 초)

### 7.1 문법

- 리터럴 토큰: **`[쉼 0.2]` `[쉼 0.5]` `[쉼 1.0]`**(임의 양수 초 허용; UI는 프리셋 제공). 대괄호 안 "쉼 " 접두 + 초.
- **평범한 공백은 시간 간격이 아니다**(하드 제약 8) — 오직 `[쉼 N]` 토큰만 gap을 만든다. 공백은 텍스트로 합성.
- 감정 태그(`[기쁨]` 등 줄 접두)와 **구분**: 쉼 토큰은 값이 수치이고 문장 어디에나 올 수 있다.
  파서 충돌 방지: `_parse_line`의 감정 매칭(`EMOTION_TAGS`)은 태그 문자열이 사전에 있을 때만 → `쉼 N`은 사전에 없어
  감정으로 오인되지 않음. 단 **줄 접두 감정 파싱 前에 쉼 토큰을 먼저 추출**해야 안전(정규식 `\[쉼\s+([0-9]*\.?[0-9]+)\]`).

### 7.2 text → gap 매핑 (silence_gap과 구분)

- `silence_gap`: **모든** 원 segment 경계의 **기본** 무음(전역 슬라이더, config `ttsSilenceGap`). 경계마다 동일.
- `[쉼 N]`: **그 위치에만** N초 무음을 만드는 **국소·명시적** 지시. `silence_gap`을 **대체**(합산 아님)한다 —
  사용자가 명시한 곳은 그 값이 권위. 두 값을 더하면 예측 불가 → **명시값 우선(override)** 규칙.
- 매핑 절차(설계):
  1. 각 줄에서 쉼 토큰을 추출·제거해 순수 합성 텍스트 + "이 위치에 gap N" 마커로 변환.
  2. **온전한 줄 사이의 쉼**(줄 자체가 `[쉼 N]`이거나 줄 끝/시작의 쉼) → 그 segment 경계의 `gaps_before`를 N으로 설정.
     `_concat_with_boundaries`의 gap 배열에 그대로 반영(내부 chunk gap=0 규칙 불변). → **구현 가능(now).**
  3. **문장 중간의 쉼** → 그 지점에서 텍스트를 별도 합성 단위로 나누고 사이에 gap N 삽입. 단, 문장을 쪼개면 모델이
     조각에 **문장-종결 억양**을 넣을 수 있어(생성축 부작용) 자연스러움이 흔들린다. → **needs-research**(§11).
- **호흡음 아님**: `[쉼 N]`은 **디지털 무음**만 만든다(§9). "실제 숨소리"는 이 스코프 밖.

### 7.3 A(grammar)와의 경계

A가 **문법 파싱/토큰 사전/우선순위**(무엇이 유효 토큰인가, 어디서 잘리나)를 소유한다면, B는 **파싱 결과(마커 위치+초)를
오디오 gap으로 만드는 신호 처리**를 소유한다. 접점은 **"파서 출력 → per-boundary gap 초 배열" 데이터 구조**(§10 계약).
동일 토큰을 두 곳에서 다르게 해석하면 안 되므로 **파서는 A 단일 소스, B는 그 산출만 소비**로 확정 필요(integration 조율).

---

## 8. 소유 파일 / 공유·충돌 파일

### 8.1 이 브랜치가 소유(생성)하는 파일
- `doc/work-in-progress/tts-boundary-pause-plan.md` (본 문서).
- `python/test_boundary_pause_synth.py` (**test-only synthetic 스캐폴딩/프로토타입**, production 무배선).

### 8.2 공유·충돌 파일 (Phase 1에서 **읽기만**, 수정은 integration에서 조율)

- **`python/tts_worker.py`** — 최다 접점:
  - `_concat_with_boundaries`(L1156) / `_concat_with_silence`(L1118): 경계 gap·crossfade·zero-cross가 여기 배선됨.
    **A의 pause grammar도 여기 gap 배열을 건드릴 수 있어 직접 충돌** → 한 함수의 gap 계산 소유권을 integration이 단일화.
  - `_parse_line`(L1068): `[쉼 N]` 추출이 이 파서(또는 그 앞단)에 들어감. **A grammar와 충돌점.**
  - `_METADATA_KEYS`(L802) / `_build_tts_metadata`(L819): pause·boundary 재현 필드 추가 시(§10).
  - `_synthesize_qwen_job`(L856) L1030·L1039 및 `synthesize` L1309·L1314: 말끝 처리 삽입 지점.
- **`python/pitch_shift.py::place_final_with_pitch`(L144)** — **A(pitch) 소유 모듈.** 말끝 처리를 pitch 後에 두려면
  이 함수 확장 필요 → **핵심 충돌점.** 권장(1안): 말끝을 pitch 前 후보에 적용해 이 모듈 **무접촉** 유지.
  대안(2안): 공통 함수를 `place_final_with_prosody(candidate, final, pitch, tail_policy, work_dir)`로 확장(교체 1회 유지).
  **결정은 integration이 A와 협의.** 어느 안이든 **원자 교체 1회·실패 시 기존 wav 보존** 불변.
- **`python/text_segmenter.py`** — 자동분할. 내부 경계 정책은 분할 결과를 소비만 하고 **분할 로직·내용 불변식은 불변**.
- **`python/chunk_paths.py`** — 경로 규칙. 불변(경계 처리는 경로를 새로 만들지 않음).
- **`src/shared/ttsConfig.ts`** — **integration 단독 소유(계약 §9).** boundary/pause config 필드는 여기 추가(§10).
  **A(pause)·C(UI)와 동일 파일 편집 → integration 한 곳에서만.**
- **`python/separate.py`** — config 수신(L73/79/151). 신규 boundary/pause 필드 수신 배선(integration).
- **`src/main/ipc/audio.ipc.ts`** — **읽기 전용, 편집 금지.** 아래 K2 계약을 반드시 보존.

### 8.3 K2 취소/정리 계약 — must-not-break (audio.ipc.ts)

- `audio:cancel`(L736)이 취소의 **terminal 신호 권위**: cancelling → tree kill 확인 → runner done 합류 →
  bounded cleanup(`.qwen-job-*` 0 확인) → `audio:cancelled`. `done` 핸들러(L609)는 취소 중엔 runner만 free.
- **무손상 원자 보존**: 말끝/경계/쉼 처리는 전부 **`os.replace(final)` 이전**의 job_dir/output_dir 내부 임시본에서만
  일어나야 한다. 어떤 신규 처리도 (a) 최종 교체 지점을 하나로 유지, (b) 실패 시 교체 前 예외로 기존 `synthesized.wav`
  보존, (c) 중간 산출물을 job_dir(정리 대상) 안에 둬 취소/정리 스윕이 걷어가게 — 이 셋을 깨면 K2 위반.
- 말끝 padding용 임시본을 output_dir 밖(예: tmpdir)에 두면 **동일 파일시스템 원자 이동이 깨지고** cleanup 스윕
  범위를 벗어난다 → **금지.** 반드시 job_dir(Qwen) / output_dir(per-segment) 내부.

---

## 9. 무음 쉼 vs 실제 호흡음 (스코프 경계)

- **이 스코프 = 무음(silence) 쉼만.** `[쉼 N]`·`silence_gap`·감정경계 gap·tail padding은 전부 **디지털 무음**(zeros).
- **실제 호흡음(숨소리) 삽입은 스코프 밖**(생성축/샘플 라이브러리 문제). 무음과 호흡을 혼동해 "쉼=숨소리"로 확장하지 않는다.
- fade는 신호를 **줄이는** 처리일 뿐 새 소리를 만들지 않으므로 스코프 내(무음 경계를 매끄럽게 하는 수단).

---

## 10. config / session / metadata 계약 추가 필요분

**모두 integration이 `ttsConfig.ts`/`separate.py`/metadata에 단일 반영. 이 브랜치는 스키마 제안만.**

### 10.1 config 신규 필드(제안, 기본값 = 현행 동작 보존)
- `ttsTailPadMs: number` — 최종 말끝 무음 padding(ms). 기본 **120**. `0`이면 padding 없음(현행과 동일).
- `ttsTailFadeMs: number` — 조건부 fade 길이(ms). 기본 **8**(5–12 범위). `0`이면 fade 없음.
- `ttsInternalBoundary: 'none' | 'zero_cross' | 'crossfade'` — 내부 chunk 경계. 기본 **`zero_cross`**(안전) 또는
  `none`(완전 현행 보존) — integration이 회귀 위험 보고 선택.
- `ttsEmotionBoundaryMode: 'immediate' | 'smooth' | 'pause'` — §6. 기본 **`pause`**(현행 동치).
- pause grammar 필드(**A와 조율**): `[쉼 N]`은 `ttsText` 인라인 토큰이라 별도 config 불필요할 수 있음. 단
  파서 산출(경계별 gap 초)을 Python에 넘길 중간 표현이 필요하면 A가 정의, B가 소비.

### 10.2 metadata 신규 키(제안, `_METADATA_KEYS`에 append)
- `tail_pad_ms`(int), `tail_fade_ms`(int|null), `tail_fade_applied`(bool) — 말끝 처리 재현.
- `internal_boundary_mode`(str), `emotion_boundary_mode`(str) — 경계 정책 재현.
- `explicit_pauses`(list) — `[{segment_index, gap_sec}]` 형태의 **비민감** 배열(대사·전사·경로 없음, 계약 미디어 정책 준수).
- 기존 `silence_gap` 키는 불변(전역 기본 gap의 의미 유지).

### 10.3 session 재현
- 위 config 필드는 `audio.ipc.ts` result 핸들러가 저장하는 `session.json.options`에 자동 포함(현 buildTtsConfig 흐름).
  추가 저장 로직 불필요 — 필드가 config에 들어가면 세션 복원이 그대로 커버.

---

## 11. 구현 가능(now) vs 연구 필요(research)

### 구현 가능 (설계 확정, 순수/안전, venv에서 바로 단위테스트 가능)
- 최종 말끝 padding + 조건부 코사인 fade(§4). 진폭 임계 판정 순수 로직.
- 내부 chunk 경계 **zero-cross 정렬**(§5 후보 A) — 내용 파형 보존, 순수.
- 감정 전환 경계 **`pause`/`immediate`** 모드(§6) — gap 값 재정의만.
- **온전한 줄 사이 `[쉼 N]`**(§7.2-2) — 기존 gap 배열에 값 주입, 내부 chunk gap=0 불변.
- config/metadata 신규 필드(§10) — 기본값이 현행 보존이라 회귀 위험 낮음.

### 연구 필요 (실측/판정 선행)
- 내부 경계 **crossfade**(§5 후보 B) — 파형 혼합이 자연스러움에 실제로 필요한지 + "내용 불변" 해석. 실측: zero-cross만으로
  클릭이 남는지 SYNTHETIC + 실 합성으로 확인 후 결정.
- **문장 중간 `[쉼 N]`**(§7.2-3) — 문장 분할이 생성축(문장-종결 억양)에 주는 부작용. 조각 억양이 부자연스러우면 대안
  (모델 미분할 + 후처리 무음 삽입 불가 → 사실상 분할 필요)까지 포함해 판정.
- 감정 전환 **`smooth`(crossfade)** — 서로 다른 참조/감정의 톤 겹침이 어색한지 실측.
- pitch vs 말끝 **순서 최종 결정**(§3·§8 1안/2안) — pre/post-pitch 진폭 판정 차이 실측(±2반음에서 무시 가능 추정 검증).
- tail padding 기본값 **120ms**·fade 임계 **0.02**의 청감 튜닝 — 합성 지표는 통과, 실제 청취 미세조정 여지.

---

## 12. 승인 대기 의존성

- **신규 패키지 없음.** 말끝/경계/쉼 전부 기존 스택(soundfile/numpy는 이미 tts_worker 결합부에서 사용, ffmpeg atempo/rubberband
  기존)만으로 구현 가능. crossfade·zero-cross·padding·fade는 numpy 벡터 연산으로 충분 → **추가 의존성 불필요, 승인 대기 없음.**
- 단, §8.2의 **공통 최종 함수(pitch) 확장 여부(1안/2안)**는 A(pitch 소유)와의 **조율 승인 필요** — integration 계약에서 확정.
- production 배선(tts_worker/ttsConfig/separate.py 수정)은 **integration 단계 승인 후** 진행. Phase 1은 여기서 정지.
