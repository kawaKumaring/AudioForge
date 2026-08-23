# G2 비결정 생성 acceptance 연구 — 세 acceptance 분리 · bounded 검증 규칙 · tail 통계

> 담당: 에이전트 (stochastic acceptance research)
> 브랜치: `research/tts-stochastic-acceptance` (base `feature/tts-expression-integration` @ `0474c3f`)
> 성격: **연구/계획 문서 + test-only 프로토타입.** production 코드·스키마·GPU·실제 합성 변경 없음.
> 작성일: 2026-08-23
> 근거 데이터: **G1/G2 결과 + 기존 calibration(calib3)/holdout 수치만.** 새 합성·측정 없음.

---

## 0. 배경과 이 문서가 푸는 문제

생성 안전장치(계약 A, `python/generation_limit.py`)는 segment별 동적 상한
`compute_max_new_tokens(tok) = clamp(ceil(2.9·tok + 160), 200, 256)` 를 두고, talker 반복이
상한에 닿으면 결과를 폐기하고 구조화 오류(`GENERATION_LIMIT_EXCEEDED`)를 낸다.

핵심 관측(확정): **정상 입력에서도 mode 무관하게 비결정적 장시간 tail(runaway)이 존재한다.**
- holdout: `H2_JA` 동일 정상 입력이 1회 `generation_limit`, 재측정 2회 `completed` → 완료/상한 분기
  (`doc/work-in-progress/tts-prosody-integration.md:77`, `:90`). refgen도 1회 상한 후 1회 완료(`:77`).
- **G2 관측**: `prod_tokens=18` 세그먼트가 적용 상한 `213`(=`ceil(2.9·18+160)`)에서 `iters=213`으로
  `generation_limit` — 정상 envelope 예측 `2.786·18−5.1 ≈ 45.0` 대비 **약 4.73배**(margin 4.7배)를
  넘어 상한에 닿았다. 안전장치는 정상 동작(폐기·원자 보존).

이 tail 때문에 "성공"을 단일 지표로 보면 두 가지가 섞여 판단이 오염된다:
(i) 안전장치가 제대로 막았는가(안전), (ii) 이 입력이 자연 완료됐는가(생성 성공률), (iii) 운율(pitch/감정
참조)이 실제 산출물까지 갔는가(기능 완료). 그리고 비결정성 때문에 **"통과할 때까지 재실행"** 하면
success rate를 인위적으로 부풀리고 tail을 숨길 수 있다(green-hacking).

이 문서는 (1) 세 acceptance를 분리 정의하고, (2) 반복-until-pass를 금지하는 bounded 규칙을 설계하고,
(3) bucket·mode·감정 routing별 통계 보고 형식을 정하고, (4) 필요한 표본 수와 Wilson CI를 제시하고,
(5) 고정 seed가 production 분포를 왜곡하는지 분석한다.

**현재 G2 판정 유지(변경하지 않음)**: generation 안전장치 **PASS** / prosody 종단 **UNVERIFIED** /
비결정 tail **후보**.

---

## 1. 세 가지 acceptance의 분리 정의

각 acceptance는 **서로 다른 것을 측정**하며, 하나의 PASS가 다른 것의 PASS를 함의하지 않는다.
특히 (a)와 (b)는 **상호 배타적 종료 상태**(한 세그먼트는 상한 전 반환 또는 상한 도달 중 하나)이고,
(c)는 (a)/(b)와 **직교**한다(완료됐다고 운율이 산출물까지 갔다는 보장은 아니다).

### (a) completed_before_limit — 상한 전 자연 반환 (생성 성공률)
- **측정**: talker 반복이 동적 상한에 닿기 전에 자연 반환했는가.
  판정식은 `classify_termination(iters, limit)`: `iters < limit → completed_before_limit`
  (`python/generation_limit.py:70-79`).
- **PASS 정의**: 한 세그먼트(정확히는 채택 chunk)에서 `iters < applied_limit`.
- **주의(엄격)**: 이는 **EOS 직접 관측이 아니다.** codec EOS(token 2150)를 본 것이 아니라 "동적 상한 전
  자연 반환"이라는 **운영 상태**일 뿐이다(`generation_limit.py:20`, `tts-prosody-integration.md:36`).
  보고·metadata·GUI에서 "EOS 종료"라고 표현 금지. `has_stop_token`/`effective_lengths` 기반 EOS 판정은
  무효(`tts-prosody-integration.md:28-29`).
- **성격**: 이것은 **개별 시행의 결과**이지 "품질 게이트"가 아니다. 비결정적이므로 **분포로만** 의미가 있다
  (§3의 success_rate). 단일 시행의 completed 하나로 "이 입력은 통과"라고 결론 금지.

### (b) generation_limit 안전 종료 — 상한 도달 시 폐기·구조화 오류 (안전장치 PASS)
- **측정**: 상한에 닿았을 때(runaway) 안전장치가 규정대로 동작했는가. 이는 **완료 여부와 무관하게**
  평가되는 **결정적 계약**이다.
- **PASS 정의(모두 만족)**:
  1. 분류 정확: `iters ≥ limit → generation_limit`(경계 `iters==limit`도 상한 도달;
     `generation_limit.py:79`, 테스트 `test_generation_limit.py:94-103`).
  2. 잘린 WAV 미채택(폐기).
  3. 기존 `synthesized.wav` **원자 보존**(무손상; `test_generation_limit.py:385-408`).
  4. 구조화 오류 방출 `GENERATION_LIMIT_EXCEEDED`(정수 필드: segment_index/generation_limit/
     generated_iterations/emotion_id; `test_generation_limit.py:340-350`).
  5. 정보 최소화: 오류 메시지에 **감정 ID·chunk index만**, 대사 본문·전사·전체 경로 미포함
     (`test_generation_limit.py:400-403`, `:502-508`).
  6. 정리: `.qwen-job-*` job_dir 잔존 0(`test_generation_limit.py:408`).
- **핵심**: **runaway가 발생하는 것 자체는 실패가 아니다.** runaway가 발생했을 때 위 6개가 지켜지면
  안전장치는 PASS. G2의 `generation 안전장치 PASS`가 바로 이 정의. runaway를 "없애야 할 것"으로 보고
  재실행해 completed로 바꾸는 것은 (b)를 검증하는 것이 아니라 **(b)를 회피**하는 것이다.
- **계측 무결성 전제**: talker step 카운터가 RNG·logits 불변이어서 **측정이 분포를 바꾸지 않는다**
  (`generation_limit.py` 계약, `test_generation_limit.py:223-234`). counter 미측정(0/None)은
  "성공"으로 통과 금지 → 호환성 오류(`test_generation_limit.py:295-300`).

### (c) prosody 기능 완료 — pitch·감정 참조가 실제 WAV/metadata/session까지 산출 (종단)
- **측정**: 요청한 pitch·감정 참조가 **최종 산출물에 실제로 반영**됐는지 — 세 산출 지점 전부:
  1. **WAV**: pitch 후처리가 실제 도달(예: G1에서 "음높이 보정 중 +1.0반음" 관측, peak 클리핑 0,
     WAV mono/24000/finite; `tts-prosody-integration-audit.md:16`, `tts-prosody-integration.md:98`).
  2. **metadata**: `pitch_semitones`/`method`/`post` + `emotion_reference_source_names.*` +
     `emotion_reference_regions.*` 존재(`tts-prosody-integration-audit.md:16`).
  3. **session**: `ttsPitch`·`ttsEmotionRefSources`·`ttsEmotionRefRegions` 저장, 재시작 후
     **파일에서 읽어** 재구성(`tts-prosody-integration-audit.md:16`, `:33-36`).
- **PASS 정의**: 위 세 지점이 renderer==session 일치로 모두 확인 + 산출 WAV 구조 검증 통과.
- **현재 상태(변경 금지)**: **UNVERIFIED**. G1(36/36)은 pitch+감정 라우팅이 WAV/metadata/session까지
  갔음을 **구조·수치로** 보였으나(`tts-prosody-integration.md:98`), **자연스러움·발음·감정·pitch 체감은
  청취 전 미확인**이며(`tts-prosody-integration.md:122`), 실제 사용자 출력과의 동일성도 청취/승인 진단 전
  미확인이다(`tts-expression-contract.md:7`). 즉 "산출 파이프라인 도달"은 근거 있음, "지각적 종단 품질"은
  미검증 → 통합 판정은 UNVERIFIED로 유지.
- **직교성**: (c)는 (a)에 의존하지 않는다. (a) completed여도 pitch/감정이 metadata·session까지 안 갔으면
  (c)는 FAIL. 반대로 (b) generation_limit이면 산출물이 없으므로 (c)는 **평가 대상 아님(N/A)**.

### 세 acceptance 관계 요약
- 한 시행은 (a) XOR (b) 중 하나로 종료된다(배타).
- (b)는 시행이 (a)가 아닐 때 발동하는 **결정적 계약**이며, 발동 자체는 실패가 아니다.
- (c)는 (a)로 완료된 시행에만 평가되고, (a)와 독립적으로 PASS/FAIL이 갈린다.
- **비결정 tail**은 (a)의 실패율(=(b)의 발동률)이 0이 아니고 **입력 고정에도 run마다 갈린다**는 사실이며,
  이것은 (b)를 무효화하지 않는다.

---

## 2. bounded 검증 규칙 — "통과할 때까지 반복" 금지

green-hacking의 정확한 형태: **비결정적 시행을 completed가 나올 때까지 재실행하고 completed만 세는 것.**
이러면 success_rate → 100%로 조작되고 tail rate → 0으로 숨는다. 아래 규칙은 이를 구조적으로 차단한다.

### R1. 사전 등록(pre-registration) — 표본 수 고정
- 검증 시작 **전에** 각 셀(§3의 bucket×mode×emotion) 별 표본 수 `n_cell`을 문서에 고정 기재한다.
- 고정 후에는 결과를 보고 `n`을 늘리거나 줄이지 않는다. (표본 수 근거는 §4.)

### R2. 조기중단 없음(no early stopping)
- 각 셀에서 **정확히 `n_cell`회**를 끝까지 실행한다. 앞쪽이 전부 completed여도 멈추지 않고, 앞쪽에
  generation_limit이 나와도 멈추지 않는다. "충분히 좋아 보여서 중단"·"불안해서 더 돌림" 둘 다 금지.
- 프로토타입은 이를 강제한다: `check_bounded(trials, plan)` 는 셀별 실제 시행 수가 계획 `n_cell`과
  다르면 **예외**를 던진다(초과=추가 재실행 의심, 미달=조기중단 의심).

### R3. 전수 계수(full denominator) — 재실행 금지
- 모든 시행의 `termination_reason`을 기록하고, **분모는 항상 사전 등록 `n_cell`.** generation_limit
  시행을 "없던 일"로 하고 다시 돌려 completed로 대체하는 것 금지.
- 재현/디버깅 목적의 재실행은 허용하되 **별도 레코드**로 남기고 원래 시행을 지우지 않는다
  (holdout의 "1회 상한 → 재측정 completed"는 두 시행 모두 보존됐다: `tts-prosody-integration.md:77`).

### R4. 배타적 제외 기준 사전 정의
- 시행을 표본에서 빼는 유일한 근거는 **사전에 명시한 독립 신호**뿐이다. 유일한 알려진 제외 사유:
  **GPU 포화로 인한 시스템 경합**(정상 CPU generate 24.6s가 GPU 극점유 시 280s+로 늘어남;
  `tts-prosody-integration-audit.md:21-25`). 이때는 nvidia-smi free 같은 **독립 관측**으로 판정하고,
  제외 사유·시각·free를 레코드에 남긴다. "결과가 나빠서" 제외 금지.

### R5. acceptance 분리 계수(§1 강제)
- 한 시행에서 세 값을 각각 기록: `completed`(a) / `safety_ok`(b, generation_limit일 때만 의미) /
  `prosody_ok`(c, completed일 때만 의미). **completed를 (b)의 성공으로, (b)를 completed의 실패로**
  뒤섞어 세지 않는다.
- 안전장치 PASS는 "generation_limit 시행에서 6개 계약 만족 비율"이지 "completed 비율"이 아니다.

### R6. 사전 등록 seed 정책(§5와 연동)
- 분포/비율 추정용 시행은 **unseeded(또는 사전 등록된 서로 다른 seed를 1회씩)**. 단일 고정 seed로
  분포를 추정하지 않는다(§5). 재현용 고정 seed 시행은 **별도 목적**으로 분리 기록.

### R7. 불변식 재확인 diff 0
- 검증 중 `python/generation_limit.py` 공식(2.9/160/200/256)·`classify_termination` 경계·production
  280s timeout·자동 재시도/x-vector 강등/기본참조 폴백 금지 정책을 **변경하지 않는다**
  (`tts-prosody-integration.md:48-51`, `:124-127`). 상한을 올려 tail을 "줄이는" 것도 green-hacking.

---

## 3. 통계 보고 형식 — bucket × mode × emotion routing

### 3.1 셀 정의
- **token bucket**(채택 chunk는 항상 `prod_tokens ≤ 33`; `generation_limit.py:59-62`):
  - `B1` `1–13`: 공식값이 MIN 아래 → 상한 clamp `200`(envelope `2.786·13−5.1 ≈ 31`).
  - `B2` `14–33`: 공식 구간 → 상한 `ceil(2.9·tok+160) ∈ [201, 256]`. **G2의 `tok=18`→상한 213이 여기.**
  - `>33`은 자동분할 대상이라 단일 합성 bucket이 아님(계약 B; `generation_limit.py:22-24`).
- **mode**: `xvector`(x_vector_only) / `icl`(ref_text 조건화). ICL 오디오-전사 불일치가 tail 주 위험 조건
  이나 **필요·충분조건은 아니며**(`generation_limit.py:3-4`), x-vector 정상 조건에서도 tail 관측
  (`tts-prosody-integration.md:90`).
- **emotion routing**: `default`/`happy`/`sad`/`angry`/`calm`(감정별 참조 = `ref_cache[emotion_id]`;
  `tts-prosody-control.md:104`).

### 3.2 셀별 보고 항목
각 셀에 대해:
- `n`(사전 등록) / `completed` / `generation_limit`(tail) / `other_error` — 합 == `n`(R3).
- `success_rate = completed/n` + **Wilson 95% CI**.
- `tail_rate = generation_limit/n` + **Wilson 95% CI**(0건이면 rule-of-three 상한 `3/n` 병기).
- `safety_correct_rate` = (generation_limit 시행 중 6계약 만족)/(generation_limit 시행 수). **1.000이 목표.**
  (분모가 0이면 "tail 미관측 — 안전장치 미발동"으로 표기, PASS 아님.)
- iters 분포 요약: `median` / `p95` / `max` / **`max/envelope` margin**(envelope=`2.786·tok−5.1`).
  runaway 특성 확인: tail 시행은 `iters == applied_limit`(상한에 정확히 닿음)여야 하고,
  `elapsed_s`는 타이밍 경계 이내(참고 상수: CPU worst spi 0.763, predicted(256)≈246s<250 기준,
  mismatch@256 실측 151s, GPU@256≈158s; `generation_limit.py:13-15`).

### 3.3 보고 표 형식(프로토타입 출력 예시 스키마)
```
cell(bucket|mode|emotion)  n   comp  tail  err | success_rate[95% CI]      tail_rate[95% CI]        med  p95  max  margin  safety
B2|icl|default             50   47    3     0  | 0.940 [0.838, 0.980]      0.060 [0.021, 0.162]      41   96  213  4.73x   3/3=1.000
B1|xvector|happy           50   50    0     0  | 1.000 [0.929, 1.000]      0.000 [0.000, 0.071(3/n)] 22   29   31  ~1.0x   0/0 n/a
...
집계 주석: 분모는 사전 등록 n. 재실행 대체 없음(R3). 수치는 합성/실측 구분 태그 필수.
```
- **표는 집계 산출물**이며(메모리 규칙상 산문 보고에는 표를 쓰지 않음), 이 프로토타입/도구 출력에 한정.
- 셀별 CI가 넓은 것을 숨기지 않는다 — 넓은 CI는 "이 n으로는 이 정도만 말할 수 있다"는 정직한 신호.

---

## 4. 표본 수와 신뢰구간

### 4.1 Wilson score interval (권장; 정규근사보다 극단비율에서 정확)
`p̂ = x/n`, `z`(95%→1.96):
```
center = (p̂ + z²/(2n)) / (1 + z²/n)
half   = (z / (1 + z²/n)) · sqrt( p̂(1−p̂)/n + z²/(4n²) )
CI     = [center − half, center + half]
```
정규(Wald) CI `p̂ ± z·sqrt(p̂(1−p̂)/n)`는 tail처럼 `p̂`가 0에 가깝거나 `n`이 작을 때 하한이 음수가 되거나
0폭이 되어 **부적합**. tail 비율 추정에는 Wilson을 쓴다.

### 4.2 0건일 때(rule of three)
tail이 `n`회 중 0건이면 정확한 상한: `p_upper ≈ 3/n` (95%). 예: `n=50 → ≤6%`, `n=300 → ≤1%`,
`n=30 → ≤10%`. **"0건 관측"은 "tail rate 0"이 아니다** — `3/n`까지 열려 있다(R5의 정직성).

### 4.3 필요한 n — 두 목적별
- **(정상 완료율 추정)** 원하는 절대 margin `E`(95%, 최악 `p=0.5`):
  `n ≈ z²/(4E²) = 0.9604/E²`. 예: `E=0.10 → n≈96`, `E=0.05 → n≈385`, `E=0.02 → n≈2401`.
- **(비결정 tail 상한 확립)** tail이 드물다고 가정하고 "상한 ≤ `u`"를 0건으로 보이려면 rule-of-three:
  `n ≈ 3/u`. 예: 상한 ≤5% → `n≈60`, ≤1% → `n≈300`.
  tail이 실제로 관측될 것으로 보면(예상 `p≈0.03~0.06`, G2/holdout 시사) Wilson 폭 `≈E`를 원할 때
  `n ≈ z²·p(1−p)/E²`. 예: `p=0.05, E=0.03 → n≈203`.

### 4.4 데이터 기반 권고(GPU 비용 현실 반영)
- holdout·G2는 tail이 **존재하지만 드묾**을 시사한다(H2_JA 1/3, refgen 1/2는 표본 극소라 점추정 무의미;
  `tts-prosody-integration.md:77`). 따라서 **점추정이 아니라 상한 확립**이 1차 목표.
- **2단계(tiered) 권고**:
  1. **스크리닝**: 위험 셀(특히 `B2|icl`) `n_cell=50`, 안정 셀 `n_cell=30`. 목적=safety 계약(§1b)
     6항목이 **관측된 모든 tail에서 100%**인지 + tail 상한(`3/50=6%`, `3/30=10%`) 확인.
  2. **확증**: 스크리닝에서 tail이 1건 이상 나온 셀만 `n_cell=300`으로 승격 → tail rate Wilson CI를
     `±3~4%` 수준으로 좁히고 상한 ≤1% 여부 판정.
- **모든 n은 R1로 사전 고정**하고, tail이 나왔다고 스크리닝 셀을 도중에 늘리지 않는다(확증은 별도 라운드).
- 어떤 라운드도 GPU 실합성이므로 직렬(§GPU 규칙); 이 문서는 **수치 설계만** 제공하고 실행은 승인·GPU 게이트
  하에서만.

---

## 5. 고정 seed가 production 분포를 왜곡하는가 — 분석

### 5.1 production은 진짜 비결정적이다
- bridge는 샘플링 인자·seed를 **전혀 넘기지 않아** generation_config 기본(do_sample=true,
  temperature 0.9, top_p 1.0, top_k 50, rep_penalty 1.05)으로 매 run 새로 샘플링한다
  (`tts-prosody-control.md:55-60`, `:100`). metadata `seed_supported=False`(`tts-prosody-control.md:249`).
- 따라서 같은 입력이라도 run마다 talker 반복이 달라지고, 이것이 관측된 비결정 tail의 원천이다
  (G2: 동일 계열 입력이 완료/상한으로 갈림; H2_JA 재현).

### 5.2 seed를 하나로 고정하면 분포가 점질량으로 붕괴한다
- 고정 seed `s`에서 talker 궤적은 결정적이 되어 특정 입력의 결과가 `{completed}` 또는
  `{generation_limit}` 중 **하나로 고정**된다. 즉 `P(tail | seed=s) ∈ {0, 1}`.
- production의 진짜 tail rate는 `p = P(tail) = E_seed[ 1{tail(seed)} ]` (seed에 대한 기댓값).
  단일 고정 seed는 이 기댓값을 **0% 또는 100%로 오보고**한다 — 어느 쪽이든 틀렸다.
- 결론: **단일 고정 seed로 얻은 success/tail rate는 production 분포를 대표하지 못한다(왜곡).**
  "고정 seed로 100회 돌려 tail 0" 같은 결과는 100회가 아니라 **사실상 1개 표본**이다(같은 궤적 반복).

### 5.3 그러나 seed 고정은 tail *재현*에는 유효하다
- 일단 관측된 runaway를 고정 seed로 못박으면 **결정적으로 재현**되어 디버깅·회귀 고정에 쓸 수 있다.
- 계측이 RNG 불변이므로(`test_generation_limit.py:223-234`) seed 고정 재현이 계측 때문에 흔들리지 않는다.

### 5.4 권고(§2 R6와 일치)
- **분포·비율 추정**: unseeded 시행, 또는 사전 등록한 **서로 다른** seed를 1회씩(각 seed=독립 draw,
  seed 목록·결과 기록). 이때 seed 고정은 **재현성**만 주고 분포 대표성은 unseeded와 동등.
- **재현/회귀**: 관측된 tail을 특정 seed로 고정해 별도 트랙에 보존. 이 트랙의 결과를 분포 추정 분모에
  섞지 않는다.
- **금지**: 단일 고정 seed 결과로 "tail이 없다/드물다"를 주장(§2 green-hacking의 seed 판) — 선택된 seed가
  completed 궤적이면 tail을 구조적으로 못 본다.
- 요약: **seed 고정 = tail 재현성 O, production 비결정성 대표성 X.** 두 목적을 분리해야 왜곡이 없다.

---

## 6. 산출물과 후속 배선 지점(공용 파일 — 구현하지 않고 보고만)

### 6.1 이 브랜치 산출물(소유 경계 안)
- 본 문서 `doc/research/tts-stochastic-acceptance.md`.
- test-only 프로토타입 `python/stochastic_acceptance_proto.py` + 단위테스트
  `python/test_stochastic_acceptance_proto.py`. **합성 수치 입력만**, 실제 합성·GPU·모델 없음.
  `generation_limit`의 순수 함수만 read-only import(공식·경계 재사용), production 수정 0.

### 6.2 후속 production 배선 지점(별도 승인·소유자 몫 — 여기서 구현 금지)
- **W1 (metadata 확장)**: 시행별 `seed`(현재 `seed_supported=False`)·`elapsed_s`·`mode`·`emotion_id`를
  집계 가능한 형태로 남기려면 metadata 스키마(공용 TS `ttsConfig`/main result/session) 확장 필요 →
  통합 소유자 몫. 현재는 `generation_limit`/`generated_iterations`/`termination_reason`/
  `generation_chunks`만 관통(`tts-prosody-integration.md:112`).
- **W2 (bounded 실행 harness)**: 셀별 사전 등록 `n`을 GPU 게이트에서 직렬 실행하고 시행 레코드를 수집하는
  실측 harness는 **GPU·실합성**이라 이 브랜치 범위 밖. 프로토타입은 그 레코드를 받는 **집계 계약**만 정의.
- **W3 (UX)**: `GENERATION_LIMIT_EXCEEDED` 사용자 클릭 재시도(자동 재시도·강등·폴백 금지)는 J 항목으로
  이미 설계됨(`tts-prosody-integration.md:113-120`) — 재시도는 **분포 추정 재실행이 아니라 사용자 선택**임을
  §2 R3와 구분해 유지.

### 6.3 잔존 제한
- tail rate 실측치는 **아직 없다**(표본 극소). 이 문서는 추정을 위한 **설계**만 제공.
- prosody 종단(c)은 **UNVERIFIED 유지** — 청취·승인 진단 전 지각 품질 미확인.
- 모든 실행은 GPU 게이트·미디어 정책·직렬 규칙 하에서만. 이 문서/프로토타입은 그 전 단계의 **계획·형식**.
