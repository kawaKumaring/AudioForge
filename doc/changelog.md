# AudioForge Changelog

## 2026-09-05 — 참조 길이 정책을 엔진별로 분리 (Qwen 에 GPT-SoVITS 10초 상한을 적용하지 않는다)

배경: 참조 3~10초 제한은 GPT-SoVITS 벤더 추론 코드의 실제 입력 조건이었는데, 판정 정책·구간 추천/확정·정렬 상수·화면
문구 네 곳에 복제돼 Qwen3-TTS 경로에도 그대로 적용되고 있었다. Qwen 벤더 코드에는 참조 길이 제한이 없다(무제한 지원의
근거로 삼지는 않는다). 상세: doc/script-scene-architecture.md §18.

- **정책 모델**(`reference_audio.ReferencePolicy`): 필수(차단)와 권장(경고)을 분리. GPT-SoVITS 필수 3~10초 유지.
  `QWEN3_POLICY` 신설 — 길이 필수 한계 없음, 권장 3~10초(이 앱이 검증한 범위), 처리 불가 조건은 계속 차단.
  `resolve_policy_engine`: auto → Qwen 런타임 있으면 qwen3, 없으면 gptsovits. f5tts/kokoro 는 기존 표시 유지.
- **단일 파생**: reference_region(추천·판정·확정)·reference_alignment·separate.py(ref-analyze/ref-trim, 화면이 보낸 ttsEngine 으로
  정책 선택)·tts_worker Qwen 게이트·화면(`shared/referencePolicy`)이 같은 정책에서 길이 조건을 읽는다. 모듈 안 3.0/10.0 하드코딩 제거.
- **화면**: 헤더에 필수/권장 구분, 구간 안내를 "그대로 쓸 수 없음(필수)" 과 "추천 구간·더 긴 구간 가능·미검증(권장)" 으로 구분,
  슬라이더 상한 = 필수 상한 없으면 원본 전체, 권장 밖 길이는 경고만. 카드에 실제 사용 구간(`26.5초부터 6.6초`/`원본 전체`) 표시.
  엔진 전환 시 사용 중 구간은 지우지 않고 새 엔진의 필수 조건 밖일 때만 준비를 내려 사유·수정 동작 안내.
- **참조 예산**: qwen_bridge 의 고정 83(≈6.9초 참조 재발화 가정)을 유효 참조의 실측 codec 프레임으로 대체. native ICL 은
  prompt(참조 프레임+전사 토큰)·replay 0, controlled-prefix 만 replay=실측 프레임. 출력 상한·재시도 횟수 불변.
- 검증: Python 표적 320여 건(reference_policy 13·region_policy 17·policy_wiring 5·reference_budget 10 신설 + 기존 audio/region/
  autosnap/alignment/block_integration/conditioning/degradation/speaker_refs/budget/bridge/generation_limit) 통과, node --test
  194건(referencePolicy 7·UI 계약 6 신설) 통과, tsc web/node 0 오류. GPU 추가 검증은 하지 않았다(별도 승인).
- 기타: test_generation_limit SynthJobSafetyTest 7건이 parsed 2-튜플 fixture 로 HEAD 에서부터 깨져 있던 것을 복구(제품 코드 무관).
- **GPU 재검증(정책 변경 전 코드)**: 사용자 제공 인물 3명(A·B·C)으로 다화자 1회·장문 1회 CUDA 실행, 라우팅·참조 id·종료
  사유 전부 정상. 장문은 분할·재분할이 일어나지 않아 재분할 경로는 실제 실행 미검증. 산출물 `_local/artifacts/diagnostics/
  gpu-reverify-20260905/`. 최종 판정은 사용자 청취.

## 2026-09-02 — v1.3 PHASE 0~3: 대본을 한 번만 읽는 공용 계획과 읽기 전용 미리보기

정식 `v1.2.0` 을 기준선으로 두고 `1.3.0-dev` 로 넘어갔다. 이번 범위는 **공용 Script/Scene
Plan 과 읽기 전용 미리보기**뿐이다 — 다화자 생성·환경음·언어 변환·가창은 손대지 않았다.

**왜.** 지금까지는 기능마다 대본을 따로 읽었다. 감정은 파서가, 분할은 splitter 가, 예상
시간은 estimator 가 각자 읽었다. 화자·환경음·공간 지시가 들어오면 이 방식은 반드시 갈라져
같은 대본에 서로 다른 해석이 여러 개 생기고, 화면과 생성 결과가 어긋난다. 그래서 해석
경로를 하나로 모았다. 설계 권위는 [script-scene-architecture.md](script-scene-architecture.md).

- **새 `python/script_plan.py`** — 대본을 한 번 읽어 만드는 계획. 문단·발화·감정 구간·쉼·
  사전 경고를 각각 다른 배열로 담고, 좌표는 전부 사용자가 입력한 **원문 기준**이다.
  대사 원문은 담지 않는다(화면이 offset 으로 자기 textarea 에서 잘라 쓴다).
  `input_analysis.analyze()` 가 그 위에 Python 권위 층(문장 경계·생성 묶음)을 얹어 `plan`
  으로 실어 보낸다(schema 4 → 5). 최상위 `segments`·`chunks`·`source_paragraphs` 는 기존
  소비자를 위한 별칭으로 남는다 — `plan.utterances[i]` 와 `segments[i]` 는 같은 행이다.
- **파서는 새로 만들지 않고 기존 `tts_grammar` 를 넓혔다.** `unclosed_tag_offsets()` 로
  닫히지 않은 `[` 의 위치를 낸다(파서는 그것을 리터럴로 지나가므로 오류가 아니지만, 조용히
  대괄호가 대사에 남는 것은 알려야 한다). 브래킷 규칙이 두 곳에 생기지 않게 판정은
  토크나이저 안에서 한다. 구조 해시용 직렬화(`canonical_json`)도 공개했다 — 직렬화가 두
  곳에 있으면 parity 가 아니라 우연이 된다.
- **실측 결함 둘을 함께 고쳤다.** ① 파싱 실패 경로의 오류 좌표가 정규화 좌표로 나가
  CRLF 입력에서 위치가 어긋났다(경고가 원문 좌표를 말해야 하므로 결함이다).
  ② 문단 좌표를 UTF-16·code point 한 커서로 세어 이모지 앞뒤에서 좌표가 밀렸다 —
  두 map 은 서로 다른 좌표계로 색인된다. 둘 다 회귀 테스트가 있다.
- **사전 경고 다섯 가지** — 닫히지 않은 표기 / 해석할 수 없는 표기 / 말이 없는 지시 /
  연속 지시 충돌 / 말이 없는 문단. 경고는 **합성을 막지도, 원문을 고치지도 않는다.**
  위치는 원문 좌표(줄 또는 글자)로 말한다. 파서가 물러나면(fail-open) 줄 단위 근사가 되고
  그 사실을 `parser_authority` 와 화면 문구로 밝힌다.
- **읽기 전용 미리보기** — 기존 `대사 분석` 패널이 세 축의 관계(`문단 2 · 발화 3 · 생성 묶음 3`),
  문단 아래의 발화, 감정 구간, 실제 분할 경계, 경고와 원문 위치, 그리고 앞으로 지시가
  들어올 여섯 축을 값 0 으로 보여 준다. **화면은 계획을 다시 해석하지 않는다** —
  `InputAnalysisPanel.contract.test.ts` 가 소스를 읽어 그것을 고정한다(파서 재호출 금지,
  원문에 허용된 연산은 미리보기 slice 뿐, 집계는 wording 모듈 소유, 합성을 막는 장치 없음).

**TS 와의 parity.** `src/shared/scriptPlan.parity-hashes.json`(35 case)을 양쪽이 같이 읽는다.
TS 거울은 `scriptPlan.parity.test.ts` 안에 둔다 — 앱이 필요한 것은 매퍼뿐이고(생성 권위는
Python), production 경로에 두 번째 파서를 두면 언젠가 그것이 진짜처럼 쓰이기 시작한다.

**하위 호환.** 기존 문법만 쓴 대본은 계획도 예상값도 v1.2.0 과 같다. 줄 끝 표기(LF/CRLF/CR)는
파서가 본 문자열을 바꾸지 않으므로 뜻이 같고, 좌표와 원문 신원만 입력대로 달라진다.

**확인.** 개발 실행 경로(run.bat → npm run dev)에서 세 대본으로 화면과 계획을 맞췄다.
정상 구조(문단 2·발화 3·묶음 3·감정 구간 2·쉼 1), 경고 있음(문단 3·발화 2, 경고 2건),
파서 물러남(근사 안내 표시) 전부 화면 = 계획. 표적 테스트는 python 29+23+16+16, node 441+29,
`tsc --noEmit` 두 config 오류 0.


## 2026-08-29 (7) — B envelope 1단계: 조립 중 열리는 segment 경계에만 fade

경계 fade 는 지금까지 **최종 파일의 바깥 시작·끝** 한 곳에만 걸렸다(`_finish_and_place`).
문장과 문장 사이, 즉 독립 생성된 조각을 이어 붙이며 휴지가 생기는 자리는 여전히 딱 켜지고 꺼졌다.

**경계 정보는 이미 계산되는데 버려지고 있었다.** `classify_plan_boundaries()` 가 segment 마다
`kind ∈ {internal, emotion, line, paragraph, explicitPause}` 를 내는데
`_boundary_gaps_from_plan` 이 `gap_sec` 만 꺼내고 kind 를 버렸다. 그래서 오디오 조립 단계에
"진짜 문장 경계"와 "문장 내부 자동 chunk 경계"를 구분할 재료가 아예 없었다. 이번 변경의 절반은
그 값을 3번째 반환값으로 함께 돌려주는 것뿐이다.
※ `original_segment_index` 는 문장이 아니다 — 파서가 끊는 지점은 줄바꿈 / 감정 태그 / `[쉼 N]`
셋뿐이고 마침표·물음표·쉼표는 파서에 없다.

**적용 규칙(사용자 확정).** `line`/`paragraph`/`explicitPause` 경계에서만 **앞 segment 의 마지막
chunk 끝**에 inverted ease-out, **뒤 segment 의 첫 chunk 시작**에 ease-in. `internal`·`emotion` 과
문장 내부 chunk 경계는 **적용 0**. 마침표마다 chunk 를 강제로 나누는 일(2단계)은 하지 않았다.
텍스트를 다시 파싱하거나 문장부호 규칙을 새로 만들지 않는다 — 판정 재료는 파서 kind 하나뿐이다.

**중복은 구조적으로 막힌다.** 경계는 segment 그룹과 그룹 '사이'에만 존재하므로 첫 그룹의 시작과
마지막 그룹의 끝은 후보 집합에 들어갈 수 없다. 조건문이 아니라 자료구조가 그렇다. 새 헬퍼가 그
사실을 실제로 단언하고, 그 두 자리는 `_finish_and_place` 단일 권위로 남는다.

- 새 헬퍼 `_apply_segment_envelopes` 를 `_concat_with_boundaries` **직전**에 부른다(조각이 아직
  개별 파일인 마지막 자리). `_concat_with_boundaries`·`_finish_and_place` 는 **무변경**.
- 창·곡선·길이 **무변경**(onset 10 ms / offset 20 ms / smoothstep). gain 곱셈뿐이라 길이 불변 →
  `frames`/`gap_before_samples`/`start_sample` 진단과 pause 값이 그대로다.
- 원본 chunk 파일을 덮어쓰지 않고 수정본을 새로 쓴다(정렬·진단 산출물 보존). subtype 을 보존하므로
  창 **밖**은 PCM_16 에서도 비트 단위로 같다(왕복 무손실 실측).
- metadata 추가: `segment_envelope_onset_count` / `_offset_count` / `_kind_counts` / `_applied`.

**GPU 실측**(2 segment / 9 chunk, ICL auto, 직전과 같은 입력). 적용 onset 1 · offset 1 ·
`{"line": 1}` — 좌표 offset=`[0,3]` / onset=`[1,0]` 으로 첫 chunk 시작과 마지막 chunk 끝은 기록에
등장하지 않는다(중복 0). 경계 직전 480샘플 peak `0.000031`(envelope 없던 직전 실행은 `0.005280`),
`sample_jump` 0.00000. 경계 직후 onset 창 안 peak `0.000275`, 첫 유의 신호는 810샘플(33.8 ms) 뒤라
10 ms 창이 첫 자음에 닿지 않는다. 선언 gap 은 두 실행 모두 9600샘플(400 ms)로 동일하다.
길이 633,504 + tail padding 2,880 = 636,384, 비유한 0. 상세는
`doc/boundary-envelope-2026-08-28.md` §10.

**회귀** `python/test_segment_envelope.py` 13건 — 한 문장 여러 chunk→시작1·끝1 / 여러 문장→각 1회 /
내부 chunk 0회 / 쉼표 0회 / 감정 태그 0회 / 줄바꿈·문단·명시적 쉼 적용 / 최종 파일 양 끝 무접촉을
인덱스로 단언 / 8 ms 자음 버스트 보존 / pause layout 동일 / 곡선 시작0·역곡선 끝0(창 함수의 실제
끝값 특성 존중) / PCM_16 창 밖 비트 동일 / NaN·clipping·길이 변화 없음. 쉼표·감정 케이스는 kind 가
각각 `internal`/`emotion` 임을 **먼저 단언**한 뒤 결과 배열의 기울어진 구간을 센다.

**남은 것** 실청취 미확인. 문단·명시적 쉼 경계와 경계가 여러 개인 장문은 SYNTHETIC 단위테스트로만
고정돼 있고 GPU 산출물로 재지 않았다. 2단계(마침표 문장 분리)는 범위 밖이다.

## 2026-08-29 (6) — 여백이 15ms 라고 포기하지 않는다(보조 절단 후보) + 실패 진단에 앞 chunk 보존

P1/P2/P4 를 넣고 GPU 로 실제 생성해 보니 9개 chunk 중 **6개가 정렬에 성공**하고 7번째
(`s1-c2`)에서 `PREFIX_BOUNDARY_LEAD_TOO_SHORT` 로 막혀 job 전체가 안정 방식(safe_xvector)으로
넘어갔다. 보존 진단의 수치는 이랬다 — `tail_end 202440` / **최저 골 203040** / `onset 203400`,
즉 여백 **360샘플(15ms)** 로 요구치 480샘플(20ms)에 120샘플 모자랐다.

**그런데 그 구간에는 안전한 자리가 실제로 있었다.** 보존된 raw 의 프레임 RMS 를 재 보니
`202920` 은 **-66.50 dBFS** 로 최저 골(-66.52 dB)과 **0.02 dB** 차이(실질 같은 조용함)이고,
잡음 바닥(-63.78 dB)보다 **2.72 dB 더** 조용하며, 여백은 정확히 **480샘플(20.0ms)** 이다.
문제는 신호가 아니라 규칙이었다 — **가장 조용한 한 점만 보느라 20ms 앞의 같은 침묵을 못 봤다.**

**1) 보조 절단 후보(§B5-1).** 기본 규칙(= [tail_end, onset) 최저 RMS 골)이 최소 여백을
**만족하면 예전과 완전히 같다** — 보조 탐색은 아예 실행되지 않고 값도 경로도 그대로다.
**어길 때만** `[tail_end, onset − 20ms]` 안에서 다시 찾되, 고르는 것은 **잡음 바닥 이하인 가장
늦은 프레임**이다. 늦을수록 참조 잔여를 더 걷어내고, 여백은 범위 정의상 언제나 20ms 이상이라
첫 자음은 그대로 남는다. 후보가 없으면 **예전 그대로 fail-closed**(`LEAD_TOO_SHORT` 유지).
- 최소 여백 20ms **무변경**. noise floor·flux·ZCR 임계 **무변경**. 15ms 예외 없음.
- 새 상수 0 · 고정 sample offset 0 — 조용함 기준은 그 창의 noise floor(여유 0)이고, 이는
  `tail_end` 가 쓰는 floor+3dB 보다 **오히려 엄격**하다. 임계를 낮춰 구제한 것이 아니다.
- 클릭 안전의 근거는 최저 골을 자를 때와 **같다**(그 지점이 창의 침묵 수준이라는 사실).
  별도 클릭 임계를 새로 만들지 않았다.
- `valley_sample`/`valley_dbfs` 는 '최저 RMS 관측값' 그대로 두고 `cut_sample`/`lead_samples`
  만 채택 후보로 바꾼다 — 사후에 **왜 보조로 갔는지**가 수치로 보여야 하기 때문이다.
  `lead_fallback_applied/candidates/cut_sample/cut_dbfs` 가 진단·metadata 에 함께 남는다.
- ※ 정직한 범위: `tail_end` 는 30ms(6프레임) 연속 무음의 첫 프레임이고 개시는 그 무음 안에서
  성립할 수 없으므로 `onset ≥ tail_end+6` 이다. 즉 **후보 구간이 비는 경우는 파형 경로에서
  사실상 나오지 않는다** — 실제로 보조 탐색을 막는 것은 '구간이 비어서'가 아니라 '그 구간이
  아직 바닥에 안 닿아서'다(회귀로 둘 다 고정).

**2) 실패 진단에 앞 chunk 보존.** 지금까지 남는 것은 **막힌 그 chunk 하나**뿐이라, 앞에서
성공한 6개가 어떤 anchor 로 어디를 잘랐는지는 실패와 함께 사라졌다. 이제 진단 JSON 에
`chunks` 누적 요약이 붙는다: segment/chunk 번호 · 성공 여부 · 사유 코드 · anchor 종류 ·
정렬 단계 · `tail_end/onset/valley/cut` · `lead_samples` · 보조 탐색 사용 여부.
**필터는 기존 것을 그대로 재사용**한다(수치와 대문자 enum 만 통과) — 전사 원문·목표 대사·
참조 대사·절대경로는 여전히 한 글자도 남지 않는다. 성공 chunk 의 **WAV 보존은 이번 범위 밖**이다.

**회귀.** 기존 성공 픽스처의 `cut_sample` 불변(4200) · 보조 후보 채택 시 여백 정확히 480샘플 ·
에너지 조건 미달 시 fail-closed · 후보 구간 공집합 시 None · `tail_end` 이하 후보 거부 ·
첫 자음(고역 버스트) 보존 · 실측 표본(`s1-c2`)의 프레임 dBFS 로 **202920 이 실제로 선택되는지**
단위 재현 · 누적 요약에 민감 문자열/절대경로 0 · 실패 시 결과 파일 발행 0.

## 2026-08-29 (5) — 참조 꼬리로 경계 찾기 + 정렬 진단 수치 + 창 오른쪽 끝 보정

참조 억양 반영(ICL)이 실제 생성에서 계속 안정 방식으로 밀려났다. 보존 진단
(`.af-icl-diagnostics/20260829-053822-s0-c0`)을 열어 보니 사유는 `PREFIX_ALIGN_ANCHOR_NOT_FOUND`
였고, `detection`은 비어 있었다 — 경계 검출까지 가 보지도 못했다는 뜻이다.

**원인은 임계값이 아니라 anchor 를 걸 자리였다.** 그 chunk 의 목표 대사는 **9음절**뿐인데 ASR
오류가 하필 **머리**에 몰렸다(index 2 삭제 · 3 치환, index 4부터는 전부 일치). 목표 머리
n-gram 매치는 n=1→3건, n=2→1건, **n≥3→0건**으로 무너진다. 즉 머리 anchor 는 어떤 임계값을
만져도 못 잡는다. 반면 같은 스트림에서 **참조 58음절 재발화의 편집거리는 1/58** 로 정확했고,
참조 마지막 단어 끝(8.58초)을 기준점으로 주면 같은 파형 규칙이 그대로 풀렸다
(cut 209760 · onset 211080 · tail_end 207960 · lead 1320샘플).

**1) 참조 꼬리 보조 anchor(2차 경로).** 기존 목표 머리 anchor 가 1차 경로 그대로다. 1차가
실패했을 때만, 참조 전사의 **꼬리**가 인식 스트림에서 유일할 때 그 **끝점**을 창 기준점으로
쓴다. 아래가 전부 충족될 때만이다 — 하나라도 어긋나면 **예전과 똑같이 실패**한다.
- 꼬리 문구가 **목표 대사에도** 나오면 안 된다(그러면 참조 끝인지 목표 안인지 내용상 못 가린다)
- 스트림 매치가 **정확히 하나**여야 한다(0=미검출 · 2 이상=중복)
- 꼬리 뒤에 실제 발화가 이어져야 한다(참조만 말하고 끝난 생성물은 자를 이유가 없다)
- 검출된 cut 이 참조 마지막 단어 끝보다 여유값 이상 앞이면 거부(참조 안을 자르면 잔여가 남는다)

임계값 완화·시간 고정 절단·fade 은폐는 **하나도 없다**. `prefix_alignment` 의 안전 판정과 임계값도
그대로다. 2차가 막히면 올라가는 사유 코드는 **1차의 것**이라 상위 계약(auto 전환·오류 payload)은
불변이고, 2차에서 무슨 일이 있었는지는 진단 수치(`align_ref_tail_reason`)가 말한다 —
미검출/중복/목표중복/뒤에 발화 없음을 각각 구분한다.

**2) 비민감 정렬 진단.** 실패 진단 JSON 에 수치와 canonical enum 만 더 남긴다: ASR 스트림·목표·
참조 **음절 길이**, 목표 머리와 참조 꼬리의 **길이별 매치 개수**와 최장 일치 길이, 선택된 anchor
**종류**(`TARGET_HEAD` / `REFERENCE_TAIL`)·위치·시각, 그리고 **최종 실패 단계**. 전사 원문·목표
대사·참조 대사·절대경로는 여전히 한 글자도 남지 않는다(기존 개인정보 필터를 **느슨하게 만들지
않고** 통과하는 형태만 쓴다). metadata 의 `reference_alignment` 에는 chunk 별 `cut_samples` 와
`anchor_kinds` 가 순서대로 붙어 어떤 chunk 가 보조 경로로 풀렸는지 사후에 보인다.

**3) 창 오른쪽 끝 off-by-one.** 개시가 창의 마지막 허용 위치에 걸리면 지속 판정에 필요한 뒤
프레임이 창 밖으로 밀려 "개시 없음"으로 보고됐다 — 실제로는 못 찾은 게 아니라 **확인할 자료가
잘린** 것이다. 이제 창 바로 오른쪽 프레임의 **레벨만** 지속 판정에 넘긴다. 창·noise floor·지역
조용 기준·개시 후보 집합·허용 오차·음향 임계는 전부 무변경이라 **기존 성공 표본의 cut 은 한
샘플도 달라지지 않는다**(회귀로 고정).
※ 정직한 범위: 기본 상수(SR 24000, trail = 허용오차 + 지속구간)에서는 이 구간이 어차피 허용
오차 밖이라 **거부→통과로 바뀌지는 않는다**. 바뀌는 것은 **사유의 정확성**이다
(`ONSET_NOT_FOUND` → `ONSET_OFF_ANCHOR`). 예전 사유는 다음 조사자를 음향 임계값 쪽으로
잘못 보낸다.

**폐기된 가설 정정.** "문장 내부 chunk 마다 앱이 0.4초 무음을 삽입한다"는 **사실이 아니다.**
결합 layout 실측에서 `gap_before_samples` 가 0 이 아닌 자리는 원 segment 경계 한 곳뿐이었고,
내부 7곳은 전부 0 이었다. 코드도 같은 말을 한다(내부 chunk 경계 gap 은 언제나 `0.0`).
그렇게 읽힐 여지가 있던 문구 두 곳을 고쳤다 — `_synthesize_qwen_job` docstring 의
"세그먼트별 atempo 후 사용자 silence_gap 으로 결합", 그리고 `tts-pitch-backend-plan.md` 가
이 경로를 `_concat_with_silence`(항목마다 무음)로 적어 둔 부분.

**후속 작업(이번에 하지 않음).**
- **chunk 개별 미리듣기** — 어떤 chunk 가 어떤 anchor 로 잘렸는지 수치로는 보이지만 귀로는
  확인할 길이 없다. chunk 단위 재생 UI 는 별도 작업으로 다룬다.
- 무음 예산 배선(P3), overlap/context·semantic planner production 배선은 이번 범위 밖이다.

## 2026-08-29 (4) — PHASE B: 기본 화면을 네 단계로(목소리 → 대사 → 말하는 느낌 → 음성 만들기)

기본 화면에 **여덟 개 남짓한 패널**이 한 줄로 늘어서 있었다. 보관함·전사·감정 참조·감정 샘플러·
표현·세부 표현·엔진 preflight·엔진 선택이 전부 같은 층위였고, 그중 상당수는 내부 용어(requested/
effective region, snap, capability, ready)로 말했다. 처음 여는 사람이 무엇부터 눌러야 하는지 알 수
없는 화면이었다.

**기본 화면은 네 단계뿐이다.**
1. **목소리** — 지금 쓰는 목소리 + ▶ 재생 / 다른 목소리 선택 / 사용 구간 바꾸기, 그리고 참조 방식
   (자동(추천) · 안정 우선) 두 칸. 그 외에는 아무것도 없다.
2. **대사** — 감정 태그 팔레트 + 편집기(그대로). 전용 목소리가 없는 감정은 한 줄로만 알린다.
3. **말하는 느낌** — 프리셋(자연스럽게 · 차분하게 · 밝게 · 무겁게) + 음높이 · 속도, 그리고 감정 미리듣기.
4. **음성 만들기** — 단계 표시만 두고 실제 버튼은 예전과 **같은 한 자리**(ProcessButton)에 그대로 있다.

**구간은 앱이 고른다.** 10초를 넘는 원본이면 분석이 추천한 안전 구간으로 **파일당 1회** 자동
확정한다. 실패하면 재시도하지 않고 사유(말 도중 절단 · 너무 짧음/긺 · 전사 실패 · 대사 불일치)만
쉬운 말로 올린다. 파형·슬라이더·확정 버튼은 '사용 구간 바꾸기'를 눌렀을 때 예전 그대로 나온다.

**감정 미리듣기(기쁨 · 화남 · 슬픔)** 는 목소리가 준비되면 버튼이 켜지지만 **누르기 전에는 아무것도
만들지 않는다.** 누르면 보관함 저장·전사 확보를 앱이 조용히 처리한 뒤 셋을 **직렬**로 만들고 캐시한다.
다음부터는 감정별 재생 버튼이다. 미지원·미검증 표현과 capability 상태는 고급 설정 > 표현의 전체
목록(EmotionSamplerPanel)에 그대로 있다.

**고급 설정 하나로 모았다(탭 4개).**
- **음성** — 감정별 목소리 등록, 참조 목소리 보관함, 참조 전사, 참조 안내
- **표현** — 세부 조절 스위치 · 문장 간격 · 미지원 축 안내, 감정·표현 미리듣기 전체 목록
- **출력** — 말끝 다듬기 · 끝 여백 · 페이드 · 감정 전환 간격, 결과 형식 안내
- **엔진·진단** — 엔진 직접 선택, Qwen preflight 배지, 음높이 지원 사유, 참조 방식의 내부 동작(ICL·
  ASR 정렬·x-vector)

**결과 화면**은 '무슨 일이 있었는가'(헤드라인 · 전환 안내 · 폴백 사유)만 펼쳐 두고, 합성 정보 배지
전체(실제 엔진 · 장치 · 참조 구간 · 샘플레이트 · 소요 · 파서 해시 · 전환 사유 코드 · 조각별 수치)는
기존 접힌 **상세 정보** 안으로 들어갔다.

**숨긴 것이지 없앤 것이 아니다.** 참조 안전 검증(fail-closed) · blocking 코드 해석 · 합성 게이팅 ·
metadata 10키 · 감정 참조 계약 · 샘플러 capability 판정은 모두 그대로다. 화면에서 사라진 패널은
전부 고급 설정 안에서 같은 컴포넌트로 살아 있다.

**막다른 길을 두 곳 막았다.**
- 음높이를 못 쓰는 환경에서 저장된 값이 0이 아니면 합성이 막히는데, 슬라이더도 되돌리기 버튼도
  고급 안으로 숨으면 빠져나올 길이 없다 → **실제로 막혔을 때만** 되돌리기 버튼을 기본 화면에 남긴다.
- 결과 오류 카드의 '참조 전사 확인'은 접힌 고급 안의 요소를 스크롤 대상으로 삼고 있었다 →
  `lib/ttsAdvancedOpen.ts`(얇은 등록소)로 그 자리를 먼저 열고 스크롤한다.

**프리셋 이름·값**: `original→자연스럽게`, `calm_low→차분하게`, `bright_light→밝게`, 그리고 값이
`original`과 완전히 같아 죽어 있던 `neutral(중성적)`을 실제로 다른 소리를 내는
`heavy_slow(무겁게: -1반음 · 0.9x · 700ms)`로 교체했다. pitch ±1 이내 규칙은 유지.

**전사·파일명 노출 제거**: 참조 전사 패널이 자동 전사 결과 30자와 파일명을 그대로 찍고 있었다 →
언어·글자 수만 남겼다(수동 입력 textarea는 사용자 본인 입력이라 그대로).

## 2026-08-29 (3) — 참조 사용 방식 '자동': ICL 먼저, 안 되면 안정 방식으로 딱 한 번

'참조 억양 반영(ICL)'은 경계 정렬에 실패하면 **결과를 발행하지 않고 작업 전체를 실패**시켰다.
정렬 실패는 실제 생성에서 관측된 일이라, 사용자는 "다시 안전 모드를 골라 처음부터"를 반복해야 했다.

**선택지를 두 가지 의미로 정리했다.**
- **자동(추천)** — ICL 로 먼저 만들어 보고, 경계 정렬이 실패하면 그 결과를 **버리고** 같은 작업 안에서
  안정 방식으로 **정확히 1회** 전환해 결과를 만든다.
- **안정 우선** — 처음부터 안전 음성 복제. ICL·ASR 정렬은 호출조차 하지 않는다(기존 경로 그대로).

`high_quality_icl` 은 계약값으로 남아 있지만 UI 선택지가 아니다. 구 세션에 저장된 그 값은 복원 시
`auto` 로 옮긴다 — 의도(ICL 먼저)는 그대로고, 정렬 실패가 오류 대신 안정 방식 결과로 끝날 뿐이다.

**지키는 선.**
- 잘리지 않은(참조 대사가 섞였을 수 있는) ICL 결과는 **어느 경우에도 발행하지 않는다.** 시간 고정
  절단·페이드로 덮지 않는다. 정렬 실패분은 job_dir 과 함께 폐기된다.
- 전환은 **작업당 최대 1회**. 안정 방식까지 실패하면 그대로 실패한다(재시도 루프 없음).
  전환 방아쇠는 `ICL_BOUNDARY_ALIGNMENT_FAILED` / `ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE` 둘뿐이다 —
  생성 상한 초과·문장 과길이·참조 품질 게이트처럼 **모드를 바꿔도 해결되지 않는** 실패는 전환하지
  않는다. 넓히면 원인이 사용자에게서 사라지고 시간만 두 배가 된다.
- terminal(result/error)은 여전히 정확히 1회.

**사용자에게 보이는 문구는 하나다** — "목소리 느낌을 더 살리는 데 실패해 안정 방식으로 만들었습니다."
내부 코드(`ICL_BOUNDARY_ALIGNMENT_FAILED` 등)와 `요청→실제` 모드는 완료 화면의 접힌 '상세 정보'
안에만 있다. 진행 로그·오류 메시지 경로로는 나가지 않는다.

**metadata 재현 필드**(비민감, 모든 키 상시 존재)
`reference_conditioning_mode_requested` / `..._effective` / `..._degraded` / `..._failure_code` /
`..._constraints` 에 더해 `..._icl_attempted` · `..._icl_published` · `..._auto_fallback` ·
`..._attempts` · `..._notice`. `icl_published` 가 "참조 대사가 섞였을 수 있는 결과가 나갔는가"를
사후에 판정하는 필드이고, `attempts` 가 2 를 넘으면 그 자체가 계약 위반의 증거다.

**감시기에 재시작 축을 더했다(④).** 2회차는 1회차와 **같은 조각 번호**를 다시 낸다. 조각 원장은
단조 증가라 그 완료들을 전부 '재전송'으로 보고, 그러면 2회차 내내 forward 축이 갱신되지 않아 긴
작업이 무진행(stall, 630s)으로 오판돼 죽는다. 그래서 Python 이 전환 시 `job_restarted` 를 실어
보내고, 감시기는 원장을 비우고 세 축을 그 시점부터 다시 잰다. 인정 횟수는 `MAX_JOB_RESTARTS = 1` —
Python 의 '전환 최대 1회' 와 같은 천장을 두 계층이 함께 갖는다.


## 2026-08-29 (2) — 런타임을 작업 트리 밖, 본체 저장소 밑으로

바로 아래 항목의 설치는 성공했지만 **잘못된 곳에 앉아 있었다.** `runtime_root()`가
`<이 체크아웃>/externals`였기 때문에, 작업 트리에서 설치기를 돌리면 3.58 GiB짜리
venv가 그 작업 트리 안에 생겼다. 작업 트리는 지우라고 만드는 것이므로 그 런타임은
처음부터 수명이 잘못 잡혀 있었다.

**위치를 두 종류로 나눠 이름을 붙였다**
- `runtime_root()` = `<본체 저장소>/externals/runtime` — **앱 소유**. 전용 파이썬,
  전용 venv, `runtime.json`. 설치기가 만들고 고칠 수 있는 유일한 영역.
- `assets_root()` = `<본체 저장소>/externals` — **외부 참조**. GPT-SoVITS 코드·모델,
  Qwen, 분리 모델. 읽기만 한다.

본체는 `.git` 하나로 판별한다(디렉터리면 여기가 본체, `gitdir: .../.git/worktrees/<이름>`
파일이면 그 앞부분이 본체의 `.git`). git 명령을 부르지 않는다 — 아직 아무것도 설치되지
않은 부트스트랩에서도 답해야 하기 때문. `AUDIOFORGE_RUNTIME_ROOT`가 있으면 그쪽이 우선.

**"먼저 발견한 것"으로 경로를 정하지 않는다** — `_find_repo`가 형제 디렉터리를 훑다가
공용 `externals`를 가리키는 junction을 먼저 만나 그 경유 경로를 기록하던 문제를 없앴다.
이제 명시된 네 곳(환경변수 → 기록 → `assets_root()` → `runtime_root()`)만 보고,
찾은 것은 `realpath`로 풀어 실체만 기록한다.

**연결 기록이 소유권을 말한다** — `owned`(managed: true, 재설치·삭제 대상)와
`external`(managed: false, 손대지 않음)을 나눠 적고, `recorded_on.host`도 남긴다.
다른 PC의 기록이 무효일 때 조용히 예전 경로로 미끄러지는 대신
`RECORDED_ON_OTHER_HOST`로 호스트 이름과 함께 알린다.

**지문의 한계를 문서에 적었다** — `venv_fingerprint`는 dist-info 목록과 인터프리터를
본다. 패키지가 통째로 사라진 것은 잡지만 **dist-info는 남고 본문만 손상된 것은 못 잡는다.**
그건 `app_env_verify.py`의 실제 import·모델 로딩이 하는 일이고 설치 직후와 `verify`에서만
돈다. `--check` 통과 = "지난번 그 설치가 그대로 있어 보인다"이지 "지금 import가 된다"가 아니다.

**재다운로드 방지** — 파이썬 설치 파일을 sha256 확인 후
`<runtime_root>/.cache/downloads/`에 보관하고, 다음 설치에서 sha256이 맞을 때만 재사용한다.
pip은 자기 캐시를 그대로 쓴다.

**Node/Python 일치 고정** — `af-launch.mjs`는 같은 위치 규칙을 Node로 한 번 더 구현한다
(파이썬을 어디에 내려받을지 정하려면 파이썬이 없는 시점에 답이 필요하다). 어긋나면
파이썬은 A에 깔리고 판정은 B를 보므로, `--where`(내려받지 않고 위치만 출력)를 두고
`test_app_runtime.py`가 두 구현의 답이 같은지 검사한다.

**실측(재구축)** — 공용 위치에 **새 venv를 새로 만들었다**(기존 venv 이동·복사 없음).
272초 / 114 패키지 / 3.58 GiB. 지문 `9d0d26bc…67cc62`로 직전 환경과 **동일** — 같은
명세가 같은 결과를 낸다는 뜻. import 32/32, 모델 로딩 4.0초, production 브리지 한국어
합성 1회 성공(27.6초 → 3.94초 / 32 kHz / mono). 재실행 시 내려받기·재설치 0.
작업 트리의 직전 성공 환경과 손상된 `externals/gptsovits_venv` **둘 다 보존**.

**테스트** — `test_app_runtime.py` 21건 → 34건(작업 트리 해석 7건, 앱 소유/외부 구분 2건,
다른 PC 안내 2건, Node↔Python 일치 1건, 자산 루트 폴백 1건 추가).

## 2026-08-29 (1) — 앱 전용 환경 설치·연결 (`run.bat` 한 번으로 재구축)

`run.bat`이 3줄(`cd` + `npm run dev`)이라 환경이 없으면 앱이 그냥 죽었다. 이제
**환경 검사 → 설치 → 검증 → 연결 → 실행**을 스스로 한다. 상세는 `doc/app-runtime-installer.md`.

**계기** — 작업 트리 정리 중 재귀 삭제가 junction을 따라가 공용 `externals/gptsovits_venv`의
`site-packages` 중 `a`~`mo` 구간이 사라졌다. 실측 결과 28개 모듈이 import 불가
(librosa·einops·jieba·g2pk2·ko_pron·fast_langdetect·huggingface_hub·accelerate 등).
**디렉터리도 `python.exe`도 멀쩡히 남아 있었다** — "폴더가 있으니 정상"이라는 판정이 이 상태를
통과시킨다는 것이 진짜 문제였다.

**판정 규칙을 바꿨다**
- 연결은 파일 모양이 아니라 `externals/runtime.json`의 **기록**이다. 기록이 가리키지 않는
  환경은 존재하더라도 앱에게는 없는 것이다.
- 기록에 **지문**을 붙인다. venv의 `*.dist-info` 목록 + 인터프리터 크기로 계산하므로
  패키지가 사라지면 다음 점검에서 `FINGERPRINT_MISMATCH`로 잡힌다. 위 사고가 잡히는 지점.
- 경로는 `realpath`로 junction을 풀어 기록한다. junction 경유 경로를 남기는 것이 사고의 씨앗이었다.

**신규**
- `python/runtime_spec.json` — 설치 명세(선언). 인터프리터 태그·sha256·패키지 핀·라이선스·제외 사유.
- `python/app_runtime.py` — 경로 해석·연결 기록·지문·빠른 점검. 표준 라이브러리만.
- `python/app_env_installer.py` — 계획 → 동의 → venv → 패키지 → shim → 검증 → 연결.
- `python/app_env_verify.py` — 설치된 venv 안에서 실제 import + `TTS(cfg)` 모델 로딩 +
  `clean_text(..., "ko")` 통과까지. **파일 존재로 판정하지 않는다.**
- `scripts/af-launch.mjs` — 앱 전용 파이썬 확보(여기서만 내려받음) → 판정은 파이썬에 위임 → 앱 실행.
- `python/test_app_runtime.py` — 21건. 사고 상황(디렉터리는 남고 패키지만 소실) 재현 포함,
  공백+한글 경로에서 GPU·모델·네트워크 없이 돈다.

**변경**
- `run.bat` — ASCII + CRLF 유지(한글 안내는 전부 Node/Python 쪽). `chcp 65001`로 한글 출력 보장.
  실패 시 앱을 띄우지 않고 원인·재개 방법을 보여 준다. 종료코드 0/1/2/3.
- `python/tts_worker.py` `GPTSoVITSEngine.load()` — 하드코딩 상대경로 대신 `app_runtime`이 해석.
- `python/gptsovits_bridge.py` — 코드 폴더도 `app_runtime`이 해석(작업 트리에 `externals`가 없어도 됨).
- `.gitattributes` 신규 — `*.bat eol=crlf` 고정.

**설치 내용(실측)** — CPython 3.12.14(python-build-standalone 20260825, sha256 대조),
torch/torchaudio 2.11.0+cu130, 총 114 패키지 / venv 3.58 GiB / 277초.
코드·모델(1.1 GiB)은 이미 받아 둔 것을 재사용해 재다운로드 0.
손상된 `gptsovits_venv`는 **수리·삭제하지 않고 그대로 보존**하고 옆에 `gptsovits_venv_app`을 새로 만들었다.
일본어 전용 `pyopenjtalk`는 명세에서 명시적으로 제외(빌드 필요, 이번 범위 밖).

**검증** — import 32/32, CUDA(RTX 5070 Ti)에서 모델 4장 로딩 4.3초, GPU 없는 조건(CPU 폴백)에서도
2.8초로 통과. 실제 한국어 합성 1회 성공(3.56초/32 kHz/227,884 B). 재실행 시 재설치 없음(0.23초).
`test_app_runtime.py` 21건 + 인접 기존 테스트 84건 통과.

## 2026-08-28 — 경계 envelope: 시작·끝 급절단(클릭) 수정

사용자 청취로 확정된 결함: 합성 음성이 **S자 없이 딱 켜지고 딱 꺼진다.** 상세 계측·선택 근거는
`doc/boundary-envelope-2026-08-28.md`. 여기엔 요약만 남긴다.

**원인** — 합성 산출은 sample 0 부터 이미 소리를 담고 있다(앞 10ms RMS −29~−32 dBFS, 첫 2ms 프레임이
최대 프레임의 3.9~8.8%). 디지털 무음에서 한 샘플 만에 켜진다. 실제 녹음은 같은 자리가 0.4% 라
켜짐이 들리지 않는다. DC 계단이 아니라 **envelope 의 계단**이 원인이다.

**창 길이(실측 확정, 추측 아님)** — 기준은 "경계가 '경계 없는 같은 소재'보다 날카롭지 않을 것".
발화 한복판을 잘라 최악의 계단을 만들고 무경계 같은 지점과 대조했다.
- **onset 10ms(240 sample @24k)**: 계단 잔여 −15.7~−19.1 dB, 자연 경계비 −22.0~−23.4 dB.
  여기서 멈추는 이유는 자음 — 실측된 가장 이른 고역 버스트(8ms)의 감쇠가 0.95 dB 로 1 dB 안이다.
  12ms 면 2.6 dB 로 커진다. **자음 보존이 최우선 제약이라 이 값이 상한이다.**
- **offset 20ms(480 sample @24k)**: 계단 잔여 −26.3~−28.0 dB. 40ms 로 늘리면 계단은 11 dB 더 줄지만
  말끝 20ms 에너지를 5~8 dB 더 지운다.
- 전체 에너지 손실 0.0003~0.0008 dB. **길이·sample rate·cache key 불변.**

**구현**
- `audio_finishing.py`: `compute_boundary_plan` / `apply_boundary_envelope` + smoothstep 창
  (`3u²−2u³` / `1−smoothstep`, 양 끝점 정확히 0). 이중 적용은 `BOUNDARY_DOUBLE_APPLY` 로 차단.
- `tts_worker._finish_and_place`: 조립이 끝난 최종 배열을 보는 **유일한 지점**이라 단문·장문 모두
  바깥 경계에만 한 번 걸린다. 내부 chunk 결합은 무변경(청크마다 fade 넣으면 파츠 느낌·공백 발생).
- 순서는 pitch → 경계 envelope → tail. tail plan 은 envelope **적용 전 원본**으로 산출한다
  (`already_silent` 판정이 뒤집히지 않게).
- metadata 에 실제 적용 샘플 수 기록: `boundary_onset_samples` / `boundary_offset_samples`.

**기존 tail 처리와의 관계 — 중복 아닌 보완.** `ttsTailMode` 기본값은 `off` 이고 A2 실행도 `off` 였다
(= 사용자가 들은 음성엔 fade 가 아예 없었다). tail 은 auto 일 때도 말끝만 다루고 시작 개념이 없다.
경계 envelope 은 항상 적용되되, tail auto 가 실제로 cosine fade 를 걸 때만 말끝을 양보한다
(`boundary_offset_samples = 0`). 같은 구간을 두 번 fade 하지 않는다.

**기존 자동 검사가 놓친 이유** — 판정이 `head300_dbfs`/`tail300_dbfs`, 즉 **300ms RMS** 위에서 이뤄졌다.
클릭은 5~10ms 사건이라 완전히 뭉개진다. 끝 검사는 마지막 10~15ms 의 디지털 무음이 평균을 끌어내려
속았고(정작 계단은 끝나기 15~45ms 전), 무엇보다 **불연속 자체를 재는 항목이 없었다** —
전부 구간 레벨이었고 레벨의 변화율이 아니었다.

**테스트** — `python/test_boundary_envelope.py` 29건 신규. 인접 기존 모듈 포함 112건 통과, 실패 0.
`test_off_path_bytes_identical_to_place_final` → `test_off_path_shape_matches_place_final` 로 개명
(envelope 이 항상 걸리므로 바이트 동일이 아니라 길이·sr·pitch·subtype 동일이 보증이다. 단언은 강화).

**미확인** — 수정 후 실청취 확인 없음(GPU 재합성 금지). 소재는 A2 3종 + 대조군 1종뿐이라 화자·언어가
바뀌면 가장 이른 자음 버스트가 8ms 보다 앞설 수 있다. 참고로 국소 계측 기준 **smootherstep 이
클릭 3.3~5.1 dB 더 억제하면서 자음도 더 보존**하지만, 계약(S자 ease-in-out)을 임의로 바꾸지 않았다.

## 2026-08-21 — TTS GUI/UX: 긴 참조 구간 선택(3~10초 파생 클립) + 합성 게이팅 + 문구 정정

목표: 합성 백엔드는 완료됐으나 GUI/UX 보완. 특히 10초 초과 참조를 오류로 거부하지 않고 "참조 원본"으로
수용해 파형에서 3~10초 구간을 골라 쓰게 한다. (기존 push된 3커밋·안정화 커밋과 무관한 새 독립 커밋.)

**P0 — 긴 참조 구간 선택(핵심)**
- **백엔드 `reference_region.py`**(신규): `recommend_region`(10초 초과 파일에서 무음↓·클리핑0·연속발화
  기준 6~8초 자동 추천 — 확정 아님), `analyze_region`(구간 길이·무음비율·클리핑·RMS + 품질 경고),
  `coarse_peaks`(파형 렌더용 다운샘플), `trim_region`(선택 구간만 **mono/24kHz PCM** 파생 WAV, 원본 불변).
  화자중첩 회피는 diarization이 필요해 이번엔 제외("가능하면"에 해당).
- **분석/트림 IPC**: `separate.py`에 `ref-analyze`(길이·needs_region·추천·peaks)·`ref-trim`(파생 클립) 모드
  추가, `audio.ipc`에 `analyze-reference`·`trim-reference`(작업 임시폴더에 파생, 원본 불변) + preload 노출.
- **참조 오버라이드 배선**: `ttsReferenceOverride`(파생 클립 경로)를 config에 추가. 설정 시 **파생 클립만**
  기본 참조로 전달(전체 원본 파일을 모델 참조로 직접 넘기지 않음). 자동/수동 전사도 파생 클립만 대상.
- **UI `ReferenceRegionPanel`**(신규): 길이·SR·채널·허용(3~10초) 표시. 3초 미만→다른 파일 요청. 3~10초·품질
  통과→원본 그대로 사용. 10초 초과→파형(구간 하이라이트, 클릭 이동) + 시작·길이 슬라이더 + 구간 미리듣기(원본
  구간 재생) + "이 구간으로 확정"→파생 WAV 생성 + 구간 품질 지표 표시. 추천값은 미리 선택하되 확정은 사용자.
- **합성 게이팅**: 참조 미준비(3초 미만/구간 미확정/품질 오류)·빈 대사면 합성 버튼 비활성화 + 사유 표시
  (store `ttsRefReady`/`ttsReferenceClip`/`ttsRefMessage`). 새 파일 선택 시 이전 파생/준비 상태 무효화.

**P0 — 그 외**
- **빈/공백 대사 차단**: 버튼 비활성화 + "합성할 대사를 입력하세요". placeholder를 실제 입력으로 오인하지
  않도록 **"예문 불러오기" 버튼**으로 예문을 명시 입력.
- **잘못된 TTS 예상 시간 제거**: 파일 길이 기반 예상은 문장수·장치·모델 준비에 좌우돼 부정확 → TTS에서 미표시.

**P1 — 문구/정합**
- ModeSelector "음성 합성 (개발중)/합성(β)" → "음성 합성/합성". "GPT-SoVITS 전용" 제거.
  "참조 없이(ref-free)" → "전사문 없이 사용(화자 특성만 · 유사도 저하 가능)". 배지 자동/수동/ref-free →
  "자동 인식/직접 입력/전사문 없이"(사용자 용어). 보조 문구 10→11px로 상향.
- (부수) ModeSelector의 깨진 import 경로(`../../../shared/types`)·`JSX.Element` 타입 정정 — 편집 중인 파일의
  기존 오류로 web tsc를 막던 유일 항목(타입 전용, 런타임 무변경).
- (미완/후속) Qwen preflight 상태 배지·엔진/감정참조/언어의 고급설정 재편은 다음 슬라이스로 남김.

**테스트/검증**
- `test_reference_region.py`(7): 추천이 발화 구간 선택·길이 6~8초 / 구간 무음 vs 발화 / **경계 2.99·3.0·10.0·
  10.01** / 파형 peak / **트림 mono·24k·원본 불변** / 48k→24k 리샘플. python discovery **126**.
- 빌드/타입: **tsc node·web 통과(신규 오류 0, 기존 ModeSelector 오류도 해소)** · build 통과 · npm test **32**.
- **실측 백엔드 e2e(실제 72.6초 speaker_b.wav, 산출물 git 비추적)**: 추천 49.0s/7.0s(speech 0.93) → 구간 무음
  0.13·클리핑 0·in_range → 파생 **mono/24kHz/7.0s** → **원본 불변** → **파생 클립만** Qwen 합성 성공(2.08s,
  job 정리) · 자동전사 파생 구간만. ref-analyze/ref-trim IPC 모드도 동일 검증.
- **정직한 한계**: (a) 프로젝트에 정확히 111초 파일이 없어 72.6초 실파일로 검증(파이프라인은 10초 초과에 길이
  무관). (b) 제 도구는 Chromium을 구동하며 Electron 앱 창을 직접 클릭·드래그로 조작할 수 없어, 파일 업로드·파형
  드래그·재생 같은 **상호작용 UI 구동은 미실시**. UI는 빌드/타입/로직과 백엔드 e2e로 검증했고, 앱 내 클릭 검증은
  검토 단계에서 확인 필요.
- **범위/커밋**: 기존 push 커밋 amend/rebase/squash 없음. GUI/UX만 새 독립 커밋. resources/·작업파일/·파생 WAV
  미스테이지. push 안 함(검토 후 별도 push).

## 2026-08-21 — 실측 안정화: WDDM Auto VRAM 측정 출처 분리 + Qwen 취소 잔존물 정리

배경: ComfyUI 실모델 병행 실측에서 두 production 결함 확인. (1) Windows WDDM에서 nvidia-smi free
2121MiB인데 `torch.cuda.mem_get_info` free는 14148MiB로 보고 → Qwen 임계 4000인데 GPU 오선택.
(2) Qwen 취소(taskkill /T /F) 후 `segment_qwen_001.wav`가 output_dir에 잔존.

**결함 1 — 장치 정책 측정 출처 분리(`gpu_policy.py`)**
- Auto의 측정 출처를 플랫폼별로 분리. **Windows: nvidia-smi `--query-gpu=index,memory.total,memory.used,
  memory.free`의 GPU 전체 free를 1차 근거**로 사용(대상 GPU index 행만). subprocess timeout·비정상 종료·
  명령 부재·파싱 실패를 처리하고, **측정 실패 시 Auto는 보수적으로 CPU**(torch 값으로 폴백하지 않음 —
  WDDM에서 타 프로세스 점유 미반영이 실측 확인됨). 비-Windows는 기존 `mem_get_info` 경로 유지.
- 선택 사유(reason)에 **free·threshold·source**(nvidia-smi / torch.mem_get_info)를 포함.
- GPU/CPU 강제 정책 불변. OOM→CPU 1회 재시도는 최종 안전망으로 유지.
- 문서에서 "mem_get_info가 타 프로세스 점유를 반영한다"는 단정 제거.

**결함 2 — Qwen 취소 잔존물 정리(`tts_worker.py` + `qwen-cleanup.ts` + `audio.ipc.ts`)**
- Qwen 실행마다 output_dir 안에 **실행별 전용 임시폴더 `.qwen-job-*`**(tempfile.mkdtemp)를 만들고,
  segment·atempo·pending 등 모든 중간 산출물을 그 안에만 둔다(동일 파일시스템 → 최종 os.replace 원자적).
- 성공 시 검증된 최종만 `os.replace(job_dir/pending, output_dir/synthesized.wav)`. Python 정상/오류 경로는
  **finally로 job_dir 전체 삭제**.
- 취소(taskkill /T /F로 finally 미실행)는 **Electron 부모가 자식 종료 확인(runner 'done') 후** output_dir의
  `.qwen-job-*` 폴더만 삭제(`sweepQwenJobDirs`). 작업 시작 시에도 방어적으로 동일 스윕(안전 범위 = 해당
  output_dir 바로 아래 `.qwen-job-*` '폴더'만; synthesized.wav·session.json·타 작업 결과·동명 파일은 불변).

**테스트**
- `test_gpu_policy.py`(30): nvidia-smi 파싱(대상 index·garbage·returncode·부재·timeout) / Windows Auto(9508→GPU@1500,
  2121→CPU@4000, torch와 충돌 시 nvidia-smi 우선, 측정 실패→보수적 CPU) / 비-Windows source 태그 / 기존 torch 경로·
  OOM 재시도·강제 정책 불변.
- `test_qwen_engine.py`(27): 성공/실패/atempo 실패에 `.qwen-job-*` 정리·기존 synthesized.wav 불변 추가.
- `qwen-cleanup.test.ts`(node): `.qwen-job-*` 폴더만 제거, 최종/세션/타 폴더/동명 파일 보존, 부재 output_dir 무해.

**실측 재검증(실제 ComfyUI 병행, 산출물 git 비추적)**: A 대화 — nvidia-smi free 2420 ≥ 1500 → GPU(source=nvidia-smi).
B Qwen — nvidia-smi free 2424(torch는 14306) < 4000 → **CPU**(구 코드는 GPU 오선택), 출력 정상·`.qwen-job` 0.
C 취소 — seg_001 기록 후 취소 → worker/venv 자식 0, 중간물은 `.qwen-job-*`에 격리(output_dir 느슨한 잔존 0),
Electron 스윕 후 temp 0, 기존 synthesized.wav 불변.
- 검증: python discovery 119 · npm test 32 · tsc node 통과 · build 통과. (tsc web 기존 오류 `ModeSelector` 1건 무관·불변)
- **범위**: 기존 3커밋 불변(squash 안 함). UX 개선은 이 안정화 커밋 승인 후 별도 커밋. resources/·작업파일/ 미스테이지. push 안 함.

## 2026-08-21 — Qwen3-TTS 엔진 연동 (한국어 Auto 우선순위, job bridge 모델 1회 로딩)

배경: 블라인드 청취에서 GPT-SoVITS v2 한국어 제로샷이 4조건 모두 "외국인식 억양"(v2 한계). 로컬
Qwen3-TTS-12Hz-0.6B-Base(공식 Base) 최소 비교에서 4개 중 3개 억양 제거. → production 연동(GPT-SoVITS 병존).

- **신규 엔진 `qwen3`(`QwenTTSEngine`)** — 격리 `externals/qwen3_tts_venv`에서 **job bridge(`qwen_bridge.py`)로
  모델 1회 로딩 후 전 문장 배치 처리**(문장별 프로세스 금지). GPT-SoVITS 엔진은 **제거하지 않고 병존**.
- **폴백 범위(정확히)**: 두 종류를 구분한다.
  - **프리플라이트 불가 → GPT-SoVITS 폴백**: `available()`이 False(venv/bridge/스냅샷 필수 파일 부재)이거나
    `_select_job_engine`이 한국어 Auto에서 Qwen을 못 고를 때만, **모델 로딩 전에** 조용히가 아니라 warning 후
    기존 문장별 GPT-SoVITS 경로로 폴백. `preferred`가 다른 엔진/비한국어면 애초에 문장별 경로.
  - **합성 도중 오류 → 명확한 오류(폴백 아님)**: Qwen이 로딩/합성 중 실패하면 **GPT-SoVITS로 조용히 재합성하지
    않는다**. 오류를 그대로 표면화한다(부분 산출물은 정리). 단 하나의 예외는 CUDA OOM(아래) — 이것도 조용한
    GPT 재합성이 아니라 **가시적** CPU 1회 재시도.
- **완전 오프라인**: 브리지는 repo id가 아니라 **로컬 스냅샷 '경로'** 로 `from_pretrained(local_files_only=True)`.
  (repo id + `HF_HUB_OFFLINE=1`은 qwen-tts가 HF API를 때려 `OfflineModeIsEnabled`로 실패함을 실측 → 경로 로드로 회피.)
  `available()`은 venv만으로 True 금지 — **qwen_tts 패키지 설치 흔적**(venv `Lib/site-packages/qwen_tts`)과
  pinned revision(`5d839924…`) 스냅샷의 필수 파일(config/model.safetensors/vocab/merges/tokenizer_config/speech_tokenizer)을
  함께 preflight. venv만 남고 패키지가 제거된 상태를 available로 오판하지 않음. 런타임 자동 다운로드 없음(오프라인 로드 2.3s 실측).
- **참조 전사 → (ref_text, x_vector_only)**: `_resolve_qwen_ref_text`가 튜플 반환. 수동/자동 전사가 비어있지 않으면
  **ICL(x_vector_only=False)**; 명시적 ref-free·전사 실패·빈 전사는 **x-vector-only(True, ref_text 무시)로 강등**(warning에
  "x-vector-only 강등" 명시). Qwen 공식 구현이 `ref_text=""`+`x_vector_only=False`를 거부하므로 필수. **세그먼트별** 적용.
- **세그먼트별 언어**: `_detect_language`로 문장마다 `Korean/English/Chinese/Japanese`를 골라 전달(단일 Korean 고정 아님).
  미지원 감지 시 명확한 오류.
- **장치(작업별 VRAM 임계)**: `gpu_policy.select_device(min_free_mb=…)`를 작업별로 분리 — 대화 분리는 기존 1500,
  **Qwen은 실측 peak ~2569MiB + 안전 여유 → 4000**. `_QWEN_MIN_FREE_MB` 상수·gpu_policy 주석에 근거 기록,
  경계 테스트 추가. flash-attn 미설치, **sdpa 우선(실패 시 부분참조 해제+gc+`empty_cache` 후 eager)**. CPU면 float32,
  CUDA면 bfloat16(고정 dtype 아님).
- **CUDA OOM**: 브리지 오류가 OOM이면(자식 종료로 GPU는 이미 해제) **가시적 progress + CPU 1회 재시도**(조용한 재시도
  아님). CPU 실사용 가능성 실측(1문장 gen≈29.7s, 짧은 스크립트엔 사용 가능)에 근거. CPU도 실패면 오류 표면화.
- **실시간 진행률·타임아웃**: `subprocess.run(capture_output)` 대신 **`Popen`으로 stdout JSON 라인을 스레드+큐로 실시간**
  읽어 세그먼트마다 즉시 progress emit. **무응답 280s**(`_QWEN_INACTIVITY_SEC`) 초과 시 프로세스 트리 kill+정리 후 명확한
  오류. stderr는 tail(40)만 보존. Electron watchdog 300s(진행마다 리셋)와 조율: **Python 280s < Electron 300s** →
  Python이 먼저 자식을 정리(총시간 타임아웃 없이 무응답 기준 일원화).
- **속도·간격**: speed=1.0은 raw. 1.0 외는 **최종 결합본이 아니라 각 raw 세그먼트에 ffmpeg atempo** 적용 후, 사용자
  `silence_gap`으로 결합(간격 보존). atempo 실패(ffmpeg 없음/타임아웃/`OSError`/`SubprocessError`/returncode/0바이트)는 조용히
  raw로 넘기지 않고 **명확한 오류** — 이때 ffmpeg가 만든 **부분 출력을 직접 삭제**(뒤에 남지 않게).
- **최종 출력 원자적 교체**: `synthesized.wav`에 직접 결합하지 않는다. output_dir 내부 **고유 임시 WAV**(`.synthesized.pending.<pid>.wav`)
  에 결합→존재/non-empty/sr/finite **전량 검증 성공 시에만 `os.replace(temp, synthesized.wav)`**. 실패/검증실패면 임시만 삭제하고
  **기존 synthesized.wav는 그대로 보존**(부분 결과로 덮어쓰지 않음). 단일 세그먼트도 동일 경로.
- **출력 검증·정리**: 브리지가 세그먼트마다 sr>0·non-empty·finite 검증. 부모는 결과 수·index 중복/누락·요청 out_path 일치·
  존재·0바이트 검증. **finally로 `segment_qwen_*`·atempo·임시 결합본을 실패해도 정리**.
- **UI**: TTSEditor 엔진에 `Qwen3` 추가(미설치 시 GPT-SoVITS 폴백 고지). production 연동은 이 커밋에 포함.
- **전사 캐시 상한**: `_qwen_ref_text_cache`에 GPT 전사 캐시(`_TRANSCRIPT_CACHE_MAX`)와 동일한 방어적 상한(128,
  cap 미만일 때만 추가)을 둔다. 키는 `(path,size,mtime)`로 파일 변경 시 자동 무효화 유지.
- **테스트(모델 미로딩 단위)**: `python/test_qwen_engine.py`(26) — 라우팅 6 / (ref_text,x_vector_only) 4조건(수동 ICL·
  ref-free 강등·자동 ICL 캐시·빈 전사 강등) / run_job **Popen 실시간**(result 전 progress emit)·오류·returncode·예외 /
  batch-only 가드 / `_validate_seg_out` 3종 / **배치 경로 run_job 1회+세그먼트별 언어+임시정리** / **속도 후 silence_gap 보존** /
  부적합 참조 차단 / **available은 qwen_tts 패키지 요구**(제거 시 False) / **atempo 실패 시 부분출력 정리** /
  **최종 원자 교체**(concat 실패·검증 실패에 기존 synthesized.wav 불변, 성공 시 교체·pending 없음) 3종.
  **`mock.patch.stopall` 제거** — 패처별 `addCleanup(stop)` + 전역 Qwen 캐시 스냅샷/복원.
  `test_gpu_policy.py`에 작업별 임계 경계 3종 추가. `test_tts_routing`(2A) Qwen 라우팅 비활성 패치 유지.
- **실제 모델 스모크(단위 아님, 산출물 git 비추적·미커밋)**:
  - 오프라인 경로 로드 성공(2.3s, `HF_HUB_OFFLINE=1`) — repo id 로드가 실패하던 것을 경로 로드로 해결.
  - **CUDA 배치(2문장)**: gpu_policy=cuda:0(여유 14483/16302MB ≥ 4000), sdpa+bfloat16, 세그먼트별 실시간 progress
    (result 전 9회), 임시파일 정리됨(leftover=[]). **출력 WAV 길이 6.26초**(2문장 결합)·무NaN. **해당 실행 elapsed
    223.8초**(torch/whisper import + 오프라인 모델 로딩 + 2문장 생성 포함)로 문장 생성 자체 대비 느림. 실행 중 큰
    Python 프로세스(≈31GB)가 있었으나 이는 **시스템 메모리 정황일 뿐 GPU 점유 원인 확정이 아니다** — 정확한 원인은
    ComfyUI 실모델 병행 검증에서 `nvidia-smi`의 PID/used_memory로 확인.
  - **CPU 1문장**: float32, gen≈29.7s(3.60s 출력) — 짧은 스크립트엔 사용 가능.
  - **ref-free x-vector(CPU)**: `x_vector_only=True`(ref_text="") 실경로 정상, 2.48s 출력, "x-vector-only 강등" warning 확인.
  - **무응답 타임아웃**: `_QWEN_INACTIVITY_SEC=3`로 유도 → 3.2s에 프로세스 트리 kill + 명확한 오류.
  - **실패 시 정리**: 합성 중 실패(무응답)에도 finally가 부분 세그먼트 제거(leftover=[]), 기존 synthesized.wav 미훼손(미작성).
- 검증: python discovery **102** · gpu_policy 19 · qwen_engine 21 · routing 6 · smoke --quick 3/3 · npm test 29 ·
  tsc node 통과 · **tsc web는 기존 오류 1건(`ModeSelector.tsx`, 커밋 `1a59c22` 유래, 본 변경과 무관)만 — 신규 오류 0** · build 통과.
- **제한사항**: Qwen 생성 결과에 **확률적 편차** 확인됨(seed 미고정, 반복마다 톤/자연스러움 변동). 운영 기본 참조로 C가
  비교적 안정적이나 이는 사용자 청취 정성 판단이며 **production 코드에 참조 선택을 하드코딩하지 않음**(엔진 라우팅만).
  음색 유사도 A/C 우열은 수치 결론 없음. CPU 합성은 문장당 ~30초로 긴 스크립트엔 느림(장치 사유는 progress로 가시화).
- **범위**: GPT-SoVITS/F5/Kokoro 엔진·정책 불변. venv·모델 가중치·resources/·작업파일/ 미스테이지. 새 project 의존성 파일 미수정.

## 2026-08-21 — TTS 2C-2: 수동 참조 전사 UI + 전달 경로(명시적 ref-free > 수동 > 자동)

목표: 사용자가 GPT-SoVITS 참조 음성의 전사문·언어를 확인/수정/직접입력. 대화 분리 코드 불변.

- **데이터 모델(참조별 독립)**: `TtsReferenceEntry`(shared) — manualText/promptLang/mode + 자동 미리보기
  캐시(autoStatus/autoText/autoLang). 식별자 `'default'`(기본 참조)·emotionId(감정별)로 **독립 관리**.
  store `ttsReferencePrompts` + setter.
- **전달 경로**: UI(TTSEditor) → store → ProcessButton → IPC config(`buildTtsConfig`) → separate.py →
  `tts_worker.synthesize(reference_prompts)` → GPT 브리지 payload. `buildReferencePrompts`가 camelCase
  UI → snake_case(`manual_text/prompt_lang/mode`) 변환, **순수 auto(수동 없음·언어 미지정)는 전달 제외**.
- **우선순위**(`GPTSoVITSEngine._get_ref_prompt` + override): **명시적 ref-free > 수동 전사문(비어있지 않음) > 자동**.
  - 비어있지 않은 수동 → mode=manual, Whisper 미호출.
  - 사용자 프롬프트 언어 지정 시 자동 감지 언어를 override(전사문은 자동 유지).
  - **빈 수동 입력은 자동 성공으로 오인하지 않음** — auto로 폴백(공백 trim). 명시적 ref-free만 ref-free.
  - `reference_transcript`: MODE_MANUAL·REF_FREE_USER 추가, `build_manual_prompt`/`build_user_ref_free_prompt`,
    ReferencePrompt.transcript Optional. ref-free 강등은 기존 구조화 warning 유지.
  - override는 경로 기준(abspath)으로 GPT 엔진에 주입, **매 작업 set(빈 dict면 이전 잔재 해제)**. 기존 전사
    캐시(경로+size+mtime+모델)·품질 게이트 불변. override 없고 엔진 미생성이면 인스턴스화도 안 함.
- **자동 전사 미리보기**: IPC `audio:transcribe-reference`(preload `transcribeReference`) — 사용자 클릭 시에만
  단기 프로세스로 `separate.py ref-transcribe`(Whisper small, GPT 경로와 동일 모델) 실행 → 구조화 결과 표시.
  메인 처리 runner와 분리. 전문은 일반 progress 로그에 출력하지 않음(전사 성공은 언어+글자수만).
- **테스트**(모델 미로딩 우선):
  - `python/test_reference_prompt_override.py`(10): ref-free>수동>자동 우선순위/수동 전사(Whisper 0회)/언어 기본값/
    빈수동 ref_free/빈수동 auto 폴백/언어 override/override 없음/JSON 직렬화 + 전달경로 payload(식별자→경로)/잔재 해제.
    subprocess·Whisper mock.
  - `ttsConfig.test.ts`: buildReferencePrompts(trim/순수auto 제외/ref_free strips manual/언어만/UI캐시 제외) +
    deriveRefMode(우선순위·수동비우면 auto 복귀) + 미리보기만→미전달/수정하여사용→manual.
- **리뷰 보완 4건**:
  1. 자동 전사 결과를 `manualText`에 자동 복사하지 않음 — autoText에만 저장하고, **'수정하여 사용'** 명시
     클릭 시에만 manual로 전환(자동 미리보기만으론 manual override가 전달되지 않음). UI에 실효 모드
     배지(자동/수동/ref-free) 표시.
  2. 우선순위를 **명시적 ref_free > manual(비어있지 않음) > auto**로 고정 — `_get_ref_prompt`가 ref_free를
     manual보다 먼저 판정, `buildReferencePrompts`는 ref_free 시 manual_text를 비워 전달. 회귀 테스트 추가.
  3. 미리보기 runner에 **동시 실행 방지 + 120s timeout + 정리** — `preview-transcribe.ts`(`createPreviewGuard`/
     `runPreview`)로 추출. 미리보기 중 두 번째 미리보기·메인 합성 차단, timeout/오류/비정상 done에서도
     config·runner 정리하고 단일 resolve(UI가 '전사 중...'에 안 남음).
  4. `autoTranscribe()`의 빈 catch 제거 — 실패 시 `autoStatus=failed`+오류 메시지를 UI에 표시.
- **범위 준수**: 대화 분리 코드 불변. F5/Kokoro/자동선택/음악·전사·분할 불변. 새 패키지 0. `resources/`·파생
  테스트 음성·합성 출력 미커밋. tsconfig.web에 테스트 제외 추가(기존 ModeSelector 오류는 무관·선재).
- 검증: python discovery 78 · override 10 · smoke --quick 3/3(SKIP 0) · npm test 29(ttsConfig 17+settlement 6+
  preview 6) · tsc(node)·tsc(web) 신규오류 없음 · build 통과. preview-transcribe 6케이스(result/error/무결과 done/
  timeout+cancel/단일 resolve/guard 중복).

## 2026-08-21 — 대화 분리 GPU 정책 분리(Auto/GPU/CPU) + OOM 재시도 + 종료 상태 보장

증상: ComfyUI 실행 중 대화 분리가 장시간 준비 상태에 머묾(종료 후 정상). 원인: `get_device()`가
`torch.zeros(1)` 성공만 검사 → ComfyUI가 VRAM을 잡고 있어도 GPU로 판정해 경합. TTS 코드는 불변.

- **신규 `python/gpu_policy.py`** — GPU 선택 정책 분리(다른 엔진 재사용 가능):
  - `select_device(policy, min_free_mb=1500, timeout_sec)` → `(device, reason)`. **스칼라 할당이 아니라
    `torch.cuda.mem_get_info`의 실제 여유 VRAM**으로 판단(free는 ComfyUI 등 타 프로세스 점유를 반영).
    Auto: 여유 VRAM ≥ 임계면 GPU, 아니면 CPU(사유 포함). GPU 강제: CUDA 미가용이면 **조용히 CPU로
    낮추지 않고 RuntimeError**. CPU 강제: 항상 CPU. CUDA 조회는 데몬 스레드+타임아웃(busy hang 방어).
  - `run_with_oom_retry(fn, device, cleanup, on_fallback)` → `(result, used_device)`: cuda에서 **CUDA OOM만**
    정리 후 CPU로 1회 재시도. OOM 아닌 예외는 전파(원인 불명을 CPU 성공으로 숨기지 않음). `is_cuda_oom` 판별.
    **OOM 정리 시점 교정**: except 안에서 정리하면 traceback이 fn 프레임(GPU 모델·배치 텐서)을 붙들어
    empty_cache로도 VRAM이 안 풀린다 → OOM 메시지만 문자열로 보관하고 `del e`로 참조를 끊은 뒤,
    **except 범위를 벗어나 `gc.collect()` → cleanup(empty_cache) → CPU 재시도** 순으로 실행.
  - `get_device()`(transcribe/music/tts 공용)는 **건드리지 않음** — 이번 변경은 대화 경로로 한정.
- **`conversation_worker.py`**: `select_device(gpu_policy)`로 장치+사유 선택, progress에 표시.
  ECAPA 로딩+배치 추론을 하나의 재시도 단위(`_extract_embeddings(dev)`)로 묶어 `run_with_oom_retry`로
  감쌈 → CUDA OOM 시 `empty_cache` 후 CPU 1회 재시도(전환 사유 표시). CPU-only 준비(window_meta)는
  재시도 밖. `run_conversation_separation(..., gpu_policy="auto")`.
- **`separate.py`**: config `gpuPolicy`(기본 auto)를 대화 분리에 전달(다른 모드 불변).
- **신규 `src/main/services/run-settlement.ts`** + `audio.ipc.ts` 연결: 프로세스가 result/error/watchdog 중
  하나로 반드시 '정착'하도록 `createSettlementGuard` 추출. 외부 kill·코드0 무결과 등 어떤 종료에도 `done`에서
  오류로 마감 → **UI가 processing에 남지 않음**. 중복 오류 전송 방지. (테스트 가능하도록 순수 모듈로 분리.)
- **신규 `python/test_gpu_policy.py`**(16케이스): Auto→GPU(여유충분)/Auto→CPU(ComfyUI 점유 mock=free 300MB)/
  강제 GPU/강제 GPU 미가용 예외/강제 CPU/미가용/조회실패/타임아웃/스칼라할당 근거배제, OOM→CPU 재시도/
  **cleanup이 CPU 재시도보다 먼저·순서 검증**/비-OOM 전파(cleanup 미실행)/cpu 미재시도, is_cuda_oom.
  실제 CUDA 없이 torch.cuda mock. 모델 로딩 0회.
- **신규 `src/main/services/run-settlement.test.ts`**(6케이스, node:test): result→done 무오류/error→done 중복없음/
  watchdog→done 중복없음/무정착 done→완료신호없음 오류/done 중복호출 1회/settled 플래그. `npm test` 글롭을
  `src/**/*.test.ts`로 확장.
- **범위 준수**: TTS 코드 불변. get_device 공용 로직 불변(대화 경로만 신규 정책 사용). 새 패키지 0.
- 검증: gpu_policy 16 · discovery 68 · smoke --quick 3/3(SKIP 0) · npm test 12(ttsConfig 6+settlement 6) · tsc · build 통과.
- **미검증(사용자 확인 필요)**: 실제 ComfyUI 점유 상황에서 1.5GB 임계로 Auto가 CPU를 고르는지는 미입증
  (현재 여유 VRAM ~15GB라 Auto=GPU 확인됨). push 전 ComfyUI 실행 상태에서 여유 VRAM·Auto 선택 1회 확인 권장.

## 2026-08-21 — TTS 2C-1: 참조 전사 구조화 + 조용한 ref-free 강등 관측화

목표: GPT-SoVITS 참조 음성의 Whisper 전사 결과를 구조화하고, 전사 실패·빈 결과·미지원 언어가
**조용히 빈 문자열로 바뀌던 동작을 제거**. (수동 전사 입력 UI·강제 확인은 2C-2로 분리.)

- **신규 `python/reference_transcript.py`** — 전사(사실) ↔ 프롬프트 정책 분리(reference_audio 패턴):
  - `transcribe_reference(path, model_name)`: `_get_whisper_model`+`run_transcribe` 사용. text=strip,
    **language는 Whisper 결과를 정규화해 그대로 사용(문자 비율 재추정 없음 → 일본어 한자↔중국어 오판 방지)**.
    예외→`status=failed`+`TRANSCRIPTION_FAILED`, 빈 텍스트→`status=empty`+`EMPTY_TRANSCRIPT`.
    dataclass `ReferenceTranscript`(source_path/status/text/language/model_name/source/error_code/
    error_message/file_size/file_mtime_ns) + to_dict().
  - `build_gpt_prompt(transcript, target_language)`: 정책 판정. status=ok & language∈{ko,ja,zh,en}이면
    `mode=transcribed`(prompt_text=전사, prompt_language=Whisper 언어). 그 외는 `mode=ref_free`
    (prompt_text="", prompt_language=목표 텍스트 언어) + 구조화된 warning(원인 코드 + `REF_FREE_FALLBACK`).
    `ReferencePrompt`(mode/prompt_text/prompt_language/transcript/warnings) + to_dict(). 전부 json 직렬화.
  - 언어 정규화: 소문자화 + 최소 alias만(zh-cn/zh-tw/cmn/yue→zh, jp→ja, kr→ko). unknown/빈 값→None.
    추측으로 다른 언어를 지정하지 않음.
- **`GPTSoVITSEngine`**: `_get_ref_text`(예외 삼키고 ""반환) 제거 → **`_get_ref_prompt`**로 교체.
  - `config["prompt_text"]=prompt.prompt_text`, `config["prompt_lang"]=prompt.prompt_language`.
    전사 성공 시 `_detect_language(ref_text)` 재추정 호출 제거. 목표 텍스트 언어는 기존 `_detect_language(text)`.
    ref-free일 때만 목표 텍스트 언어를 프롬프트 언어 기본값으로.
  - 관측: 성공 시 **언어+글자 수만** progress로(전문 미출력). 강등 시 **같은 참조·같은 원인당 1회** warning emit.
  - 전사 캐시 키 = **절대경로 + size + mtime_ns + Whisper 모델명** → 파일 교체/모델 변경 시 재전사,
    같은 파일 반복 문장은 전사 1회. 실패/빈 결과도 캐시(같은 작업 반복 모델 호출 방지). 엔진 인스턴스
    범위 + 방어적 상한(128).
- **ref-free가 발생하는 조건(이번 단계에선 금지 아님, 경고만)**: 전사 예외(TRANSCRIPTION_FAILED) /
  빈 전사(EMPTY_TRANSCRIPT) / 언어 없음·unknown(LANGUAGE_MISSING) / 지원 밖 언어(UNSUPPORTED_PROMPT_LANGUAGE).
- **명시적 제한(숨기지 않음)**: GPT-SoVITS venv에 pyopenjtalk가 없으면 브리지에서 일본어 프롬프트가
  ref-free로 강등되는 별도 문제는 남아 있다. pyopenjtalk 설치/브리지 정책 변경은 이번 범위 아님.
- **비정상 반환값 방어(리뷰 반영)**: `run_transcribe`가 예외 없이 `None`/비-Mapping을 반환하거나
  text/language 타입이 이상해도 `.get` AttributeError로 터지지 않게 **결과 파싱을 예외 경계 안으로** 이동 +
  타입 검증 → 모두 `status=failed`+`TRANSCRIPTION_FAILED` → `build_gpt_prompt`에서 기존대로 ref_free 강등.
- **성공 메시지도 전사 키당 1회**(리뷰 권장): 캐시 적중 문장마다 반복되던 "참조 전사 완료"를 키당 1회로
  제한(긴 대본 로그 오염 방지). 강등 경고는 이미 원인당 1회.
- **신규 `python/test_reference_transcript.py`**(21케이스, 실제 Whisper/GPT 없이 mock): 한/일(zh 오판 금지)/영/
  중(zh-CN 정규화)/빈→ref_free/예외→ref_free/**None·비-Mapping·text타입이상→failed**/언어없음→ref_free/미지원→
  ref_free/성공 payload prompt_text·lang/ref-free payload text=""·목표언어/캐시 1회/**성공메시지 1회**/mtime·모델
  변경 재전사/경고 1회/JSON/invalid 차단(전사 0회). 통합 테스트는 load+subprocess mock 후 전달 JSON payload
  캡처로 검증. **각 patch는 patcher별 addCleanup(stop)으로 개별 복원(전역 stopall 미사용)**. 전역 분석캐시 스냅샷 복원.
- **범위 준수**: UI/IPC/separate.py/브리지 추론 정책/pyopenjtalk/F5 ref_text/Kokoro/엔진 자동선택/
  음악·대화·전사·분할 불변. 새 패키지 0.
- 검증: transcript 21 · audio 25 · routing 6 · discovery 52 · smoke --quick 3/3(SKIP 0) · npm 6 · tsc · build 통과.

## 2026-08-21 — TTS 2B: 참조 음성 분석·판정 구조화 + GPT 로딩 전 게이트

목표: 참조 음성의 객관적 상태 분석과 엔진별 적합성 판정을 분리·구조화하고, GPT-SoVITS
공식 조건(3~10초)·무음·심한 클리핑·디코딩 불가를 **모델 로딩 전에** 차단.

- **신규 `python/reference_audio.py`** — "사실 분석"과 "정책 판정" 분리(다른 엔진 재사용 가능):
  - `analyze_reference()`: soundfile 블록 스캔(전체를 메모리에 안 올림)으로 길이·sr·채널·frames·
    peak·rms_dbfs·silence_ratio·clipping_ratio 측정. 무음은 개별 샘플이 아니라 **25ms 창 RMS<-45dBFS**로
    판정(제로크로싱 오인 방지). 클리핑은 abs≥0.99. dBFS는 -120 하한(JSON 안전). 계측 상수는 엔진 무관.
  - `ReferencePolicy`(엔진별 기준)·`assess_reference()`(정책 적용). GPT 규칙을 분석 함수에 하드코딩 안 함.
  - dataclass 전부 `to_dict()`로 **json.dumps 가능**, 안정적 issue code 제공(FILE_NOT_FOUND/DECODE_FAILED/
    EMPTY_AUDIO/TOO_SHORT/TOO_LONG/NEAR_SILENT/HIGH_SILENCE_RATIO/CLIPPING_DETECTED/SEVERE_CLIPPING/MULTI_CHANNEL).
  - 분석 캐시는 (경로+size+mtime)로 키 → 파일 변경 시 자동 무효화. `assess_reference_file()`은 메타데이터
    먼저 읽어 **이미 TOO_LONG이면 품질 전체 스캔 생략**(quality_scanned=false).
  - GPT 정책(휴리스틱, 코드/문서 명시): 3.0~10.0초 경계 포함 / silence_ratio≥0.95 또는 RMS≤-55dBFS→NEAR_SILENT
    error / ≥0.40→HIGH_SILENCE warning / clip≥0.05→SEVERE error / ≥0.001→CLIPPING warning / 다채널→warning.
- **`tts_worker._prepare_ref` 보강**: 입력 존재 확인, 비 WAV+ffmpeg 부재 시 명확한 오류, returncode·결과
  파일 존재·0바이트 검사, stderr 끝부분 포함, 출력 mono/24kHz/pcm_s16le 명시. **실패를 조용히 원본
  반환하지 않음**. 정상 WAV 흐름은 유지.
- **`GPTSoVITSEngine`**: `synthesize_segment` 최상단에서 `_assess_ref()` → invalid면 load/Whisper/브리지
  전에 즉시 실패. 참조별(size/mtime) 판정 캐시로 문장마다 재분석 안 함. 경고는 참조당 1회 progress로 알림.
  → **2초·20초·무음·손상 파일은 모델을 전혀 로딩하지 않음.**
- **오류 경로 보완(리뷰 반영)**:
  - `analyze_reference`의 블록 스캔 예외를 **readable=False로 강등 → DECODE_FAILED**(정상 valid 통과 차단).
  - `synthesize`의 참조 준비(기본+감정)를 **try/finally 정리 범위에 포함** — 기본 준비로 임시폴더가 생긴 뒤
    감정 준비가 실패해도 임시폴더가 새지 않게 한다.
  - `_prepare_ref`가 `subprocess.run`의 **OSError/SubprocessError를 처리**(임시폴더 정리 후 명확한 RuntimeError).
    `timeout=120s` 설정(근거: PCM WAV 트랜스코딩은 실시간보다 훨씬 빨라 수분짜리도 수초 → 정상 파일 과도
    차단 없이 멈춘 ffmpeg의 무한 대기만 차단).
- **신규 `python/test_reference_audio.py`**(25케이스, stdlib unittest+mock, 새 의존성 0): 모델·ffmpeg 없이
  통과(ffmpeg는 mock). 없는파일/손상/빈/8s정상/2.99·3.0·10.0·10.01/전무음/반무음/소량·심한클리핑/스테레오/
  JSON/캐시재사용·무효화/**스캔예외→DECODE_FAILED**/invalid→모델0회/ffmpeg 부재·실패·**예외정리**·성공/
  **synthesize 감정준비 실패 시 기본 임시폴더 정리**. 전역 monkeypatch·분석캐시는 addCleanup/스냅샷 복원.
- **범위 준수**: UI/IPC/separate.py/브리지 추론 파라미터/F5·Kokoro 정책/음악·대화·전사·분할 불변. 새 패키지 0.
- 검증: reference 25 · routing 6 · discovery 31 · smoke --quick 3/3(SKIP 0) · npm test 6 · tsc · build 모두 통과.

## 2026-08-20 — TTS 2A: 감정 참조 라우팅 회귀 테스트 (모델 없이 검증)

1단계(전달 경로)에 이어, 등록한 감정별 참조 음성이 **실제 파일 그대로** 올바른 문장에
전달되는지 확정. **품질/길이 검증은 2B로 분리**(이번은 라우팅 정확성만).

- 신규 `python/test_tts_routing.py`(stdlib `unittest`, **새 의존성 0**). 실제 `tts_worker.synthesize()`를
  호출해 파싱→참조 선택→엔진 호출 전 흐름을 통합 검증(헬퍼만 따로 테스트하지 않음).
- 모델 차단: `_select_engine`을 가짜 엔진 반환으로 monkeypatch → GPT-SoVITS/F5/Kokoro 로딩·추론
  0회. `_engine_cache` 빈 상태 + 실행 0.24초로 확인.
- 검증 케이스: 기쁨→happy.wav(happy) · 슬픔→sad.wav(sad) · 화남→미등록이라 default.wav(angry) ·
  본문만 전달(태그 제거) · synthesized.wav 생성 · 알수없는태그/없는경로/무태그→default 폴백 ·
  교차 등록 시 참조 뒤바뀜 없음. 6/6 PASS.
- **production 코드 변경 없음** — 현재 구현이 그대로 통과(요구사항: 통과 시 테스트만 추가).
  IPC 경계 `as TtsInputOptions`는 런타임 검증 아님(2A 차단 사유 아님, 유지). npm test·build·tsc OK.

## 2026-08-20 — TTS 1단계 전달 결함 수정 (ttsEmotionRefs 누락 + 0초 변질)

TTS 옵션 전달 경로만 수정(다른 모드 코드 불변). 확인된 결함 3건:

- **ttsEmotionRefs 전달 경로 끊김**: ProcessButton은 보내고 separate.py는 읽을 준비가 됐는데,
  `audio.ipc.ts`의 JSON config에 `ttsEmotionRefs`가 빠져 중간에서 유실됐다.
- **0초 변질**: `ttsSilenceGap`/`ttsSpeed`가 `|| 기본값`이라 사용자가 지정한 0이 기본값으로 바뀜.
- 수정: TTS 필드 직렬화를 `src/shared/ttsConfig.ts`의 **`buildTtsConfig`(타입 있는 단일 소스)**로
  일원화 — `ttsEmotionRefs` 포함, 숫자 기본값은 **`??`**(0 보존). 반환 타입 `TtsConfig`라
  **이후 필드 누락은 컴파일 단계에서 잡힘**. `audio.ipc.ts`는 `...buildTtsConfig(options)` 스프레드.
- 회귀 테스트: `src/shared/ttsConfig.test.ts`(Node 내장 `node:test`, **새 의존성 0**). `npm test`.
  6케이스(refs 전달·0초 보존·기본값·통과·키 5개 존재) 전부 PASS. `npm run build`·tsc(node) OK.
- 범위: 음악/대화/전사/분할 코드 불변. `nSpeakers`(대화)의 `|| 2`는 TTS 아님 → 그대로 둠.

## 2026-08-16 — LLM 잔재 글자 NLLB 수리 + 구글 번역 백엔드

실제 앙상블+LLM 실행 산출물 확인 결과: 최악(중국어 문장·영어 통째)은 사라졌으나 36줄 중 9줄에
원문 한 글자(`風`, `致`, `스スキ`)가 잔존 → Qwen2.5-3B가 문장은 옮기되 가끔 한 글자를 베낌.

- **LLM 잔재 글자 수리**(`_translate_segments_llm` 후단): LLM 출력에 한자/가나가 남은 줄만
  NLLB로 재번역(NLLB는 JA→KO 혼입 없음). 깨끗한 줄은 LLM 그대로. 검증: 한자 줄만 교체·나머지 유지.
- **구글 번역 백엔드 추가**(`translateModel: 'google'`): 비공식 무료 엔드포인트(`translate_a/single`)
  를 `requests`로 호출 — **새 패키지 0**. 세그먼트별 1:1, 실패 시 NLLB 폴백. `set_translate_model`
  ·`translate_to_korean`·`translate_segments_to_korean` 분기 추가. UI '구글' 버튼(툴팁에 네트워크·
  프라이버시·비공식 고지). **검증(네트워크)**: 일본어 5세그 모두 깨끗한 한국어, CJK 잔재 0.
- **정직한 고지**: 구글은 (1)네트워크 필수(오프라인 원칙 이탈) (2)전사 텍스트가 구글로 전송(프라이버시)
  (3)비공식이라 막힘/레이트리밋 가능 → 그때 NLLB 폴백. 로컬 원칙 유지가 필요하면 NLLB/LLM 사용.
- py_compile·TSC OK.

## 2026-08-16 — 유틸 검증 후속: 에너지 게이트(아웃로 환각) + Mel-Band 단일 모드

유틸로 before/after를 수치 측정한 뒤(아래) 드러난 한계를 보완.

- **환각 검증(유틸)**: 실제 스템으로 옛/새 비교 → `hallucination_silence_threshold`는 **무음이
  있을 때만** 작동. 인트로 `作詞・作曲…`는 제거됐지만(총 성공), 아웃로 `ご視聴…`는 [235-265s]→
  [249-250.4s]로 줄되 **잔존**. 순수 악기 트랙(drums 7→6, other 16→5)은 덜 줄지만 음악 모드는
  보컬만 전사라 무관.
- **에너지 게이트 추가**(`_filter_silent_segments`, `run_transcribe` 단일 지점): 세그먼트 구간의
  실제 오디오 RMS가 임계(0.005) 미만이면 환각으로 간주해 폐기. **측정 근거**: 진짜 무음 RMS≈0.0002
  ≪ 실제 가사 RMS≈0.11 (세 자릿수 차이) → 임계 0.005는 양쪽 20배 이상 여유. 과삭제 가드(60% 초과
  삭제 시 원본 유지). **검증**: 실제 스템 재전사 → 인트로·아웃로 환각 0, 진짜 가사 35줄 보존.
- **번역 검증(유틸)**: 같은 41줄에서 한자/가나 혼입 16 + 영어 3 → **0 + 0** 확정.
- **Mel-Band 단일 분리 모드 추가**(`roformer_melband`): bleed 측정에서 **단일 Mel-Band FT2
  bleedless가 앙상블보다 잔음↓·2배 빠름**(인트로 bleed RMS: BS 0.0474 / Mel-Band 0.0466 /
  앙상블 0.0469 — 앙상블은 두 모델의 산술평균이라 더 나은 단일을 못 이김)이라 별도 모드로 노출.
  `run_roformer_separation(model_name)` 일반화 + 강건 스템 매칭(대소문자·other). UI 3택
  (보컬 2트랙/Mel-Band/앙상블), 타입 유니온 확장.
- **정직한 한계**: 앙상블의 이론상 이점(무상관 오차 상쇄)은 reference 없어 수치 증명 불가 —
  소스마다 유불리 달라 최종 선택은 귀. py_compile·TSC OK.

## 2026-08-16 — 보컬 앙상블 (BS-RoFormer + Mel-Band 2모델, 잔음 최소)

목적: "보컬 추출 한계 돌파". 조사 결과 SOTA는 RoFormer 계열이고, 단일 모델 교체보다
**아키텍처가 다른 두 모델의 앙상블이 잔음·bleed 감소에 지각적으로 크다**는 결론.

- **새 분리 모드 `roformer_ensemble`** — `music_worker.run_roformer_ensemble`.
  BS-RoFormer(`ep_317`, SDR 12.98) + Mel-Band(`kim_ft2_bleedless_unwa`, bleed 억제 특화)를
  각각 돌려 **보컬/반주를 파형 평균(avg_wave)** 한다. 두 모델을 임시 폴더에 따로 분리 후 섞음.
- 스템 명명이 모델마다 달라(BS=`(Vocals)/(Instrumental)`, Mel-Band=`(vocals)/(other)`)
  대소문자 무시 + 반주 명칭 변형(other/no vocals/accompan) 인식으로 매칭.
- UI: 분리 앵커에 '보컬 앙상블' 버튼 추가(툴팁: 잔음 최소, 2배 느림). 타입 유니온 확장.
- audio-separator 0.44.2가 두 모델 모두 네이티브 지원 — **새 의존성 0**, Kim FT2 ckpt만 첫 실행 시
  `externals/separator_models`에 다운로드(gitignore).
- 검증: 실곡(250초)으로 실행 → 보컬/반주 스템 생성(각 44MB), 스테레오 44.1k·250.4초·
  피크<1.0(클리핑 없음)·NaN 없음 확인. py_compile·TSC OK.
- **한계(정직)**: SDR 이득은 reference 스템이 없어 수치 검증 불가 — 앙상블은 SDR이 아니라
  아티팩트 감소가 목적이라 최종 품질 판단은 귀로 해야 한다. 커뮤니티 ckpt(Kim FT2)는 상업
  라이선스 불명확(개인 사용 무방).

## 2026-08-16 — Whisper 환각 억제 + 타임라인 번역 한 번에(언어 혼입 제거)

실사용 산출물(`F:/Download/AudioForge_output`)에서 두 결함을 근거로 확인해 수정.

- **원인 A — "作詞・作曲…"·"ご視聴ありがとうございました"는 파일 정보가 아니라 Whisper 환각.**
  무음/연주 구간(예: 반주만 있는 29초 인트로)에서 모델이 학습 자막의 상투 문구를 지어냄.
  결정적 증거: 반주 트랙(bass/drums/other)이 통째로 환각(`音楽`/`BGM`/`me me me`/시청 감사)이었고
  29초 균일 세그먼트가 지문. → **`run_transcribe`에 환각 억제 추가**: `word_timestamps=True` +
  `hallucination_silence_threshold=2.0`(무음 위 지어낸 세그먼트 폐기). 음악 모드는 보컬 스템만
  전사하므로 인트로/아웃로가 실제로 거의 무음 → 특히 잘 듣는다. `condition_on_previous_text=False`는 유지.
- **원인 B — 타임라인 번역이 뒤죽박죽(중국어·영어 혼입)인 건 '줄마다 따로' LLM 번역 탓.**
  `異郷の月`처럼 3~4글자 조각은 문맥이 없어 소형 LLM(Qwen)이 자기 우세 언어(중국어)로 흐르거나
  원문을 못 지움. → **`write_translation_timeline`을 '전 세그먼트 한 번에 번역'으로 교체.**
  새 `translate_segments_to_korean`: NLLB는 세그먼트별(안정적·혼입 없음), LLM은 번호 매겨 청크 단위로
  한 번에 번역 후 번호로 1:1 되돌림 + 정합 실패 시 그 청크만 NLLB 폴백(언어 혼입·유실 방지).
- 검증: 문제의 실제 파일로 재생성 시 41/41 줄 정합 + 한자/가나 혼입 0(NLLB 경로),
  LLM 번호-파싱·불일치 폴백 단위검증 PASS. `py_compile` OK.

## 2026-08-16 — 트랙 재생 버튼 원위치 복귀 + 전환 중첩 버그 수정

- **재생 버튼을 원래 위치(트랙 행 오른쪽)에 고정** — 재생 시 숨기고 좌측하단에 새 버튼을 띄우던 것을,
  같은 자리에서 **아이콘만 ▶↔❚❚**로 바꾸도록 변경(사용자 의견). 플레이어 내부 재생 버튼 제거(중복 방지).
  재생/일시정지는 행 버튼이 `paused` prop으로 제어(TrackPlayer는 준비된 뒤 반영), 정지/닫기는 플레이어의 ✕.
- **전환 시 중첩 재생 버그 수정** — A 재생 중 B를 틀면 A가 안 꺼지고, 다시 켜면 중복되던 문제.
  원인: 언마운트 시 `destroy()`만으로 재생이 확실히 멈추지 않아 이전 wavesurfer가 잔존.
  **cleanup을 `pause()` 후 `destroy()`(try/catch)로 강화** — 전환·재활성 시 이전 인스턴스 확실 종료.
- 일시정지는 언마운트가 아니라 `ws.pause()`라 재생성 없음 → 중첩 원천 차단. 검증: TSC 무에러.

## 2026-08-16 — 세션 저장/복원 (재분리 없이 이전 결과 불러오기)

동기: 툴 재시작 시 이전 결과·설정을 보려면 매번 다시 분리해야 했음.

- **완료 시 `session.json` 저장**: 출력 폴더(`AudioForge_output/<타임스탬프>_<곡명>/`)에 원본 경로·모드·
  옵션(분리모델/Whisper/번역백엔드/언어/무음/출력포맷/화자수 등)·트랙 목록·생성시각을 매니페스트로 저장.
  폴더가 자기완결적 — 이동해도 정보 보존 (`audio.ipc.ts` result 핸들러).
- **불러올 때 자동 감지**: 노래를 열면 `<원본폴더>/AudioForge_output/*/session.json`을 훑어 **원본이
  일치하는 최신 세션**을 찾음(`audio:find-session`). 트랙 파일이 실제로 남아 있는 것만 유효.
- **안내 후 선택(권장안)**: 이전 결과가 있으면 배너로 "다시 분리하지 않고 불러올까요? [불러오기]/[새로 분리]"
  표시(자동 즉시 복원 아님). 불러오기 → 설정+트랙을 원자적으로 복원(`restoreSession`), status=done.
- 배선: `store.restorable`/`restoreSession`, `preload.findSession`, `DropZone` 로드 후 탐색, `App` 배너.
- 기존 수동 "이전 결과 폴더 열기"(`restore-from-folder`)는 그대로 유지 — 이번 건 자동 감지 + 설정 복원 추가.
- 검증: TSC 무에러. 실제 감지/복원은 빌드 후 확인 필요.

## 2026-08-16 — 결과 트랙 재생기: 파형 + 시간 + 볼륨 + 드래그 이동

- **결과 트랙 재생을 밋밋한 `new Audio` → wavesurfer 파형 플레이어로 교체**. 재생 버튼을 누르면
  트랙 아래로 **파형 + `현재/전체 시간` + 재생/일시정지 + 볼륨(듣기 전용) + 드래그 이동**이
  펼쳐짐(상단 파일 카드와 동일한 결). 트랙 색을 파형/컨트롤에 반영.
- 새 `TrackPlayer` 컴포넌트(`TrackList.tsx`). **재생 시에만 지연 생성** — 트랙 4개를 동시에
  디코드하지 않음. 접히면 wavesurfer destroy(누수 방지). 한 번에 한 트랙만 재생(기존 semantics 유지).
- 볼륨은 `setVolume`(Web Audio 게인) — 원본 파일 미변경. 드래그 이동은 `dragToSeek`.
- 기존 `new Audio`/audioRef 경로 및 L-11 언마운트 정리 제거(플레이어가 자체 정리). 검증: TSC 무에러.

## 2026-08-16 — 타임라인 번역 파일 생성 (_korean_timeline.txt)

- **번역 시 세그먼트별 타임라인 번역 파일 추가**: `{base}_korean_timeline.txt`
  (`[0:01 → 0:03] 번역문` 형식). 전사 타임라인(`_timestamps.txt`)을 세그먼트별로 번역.
- 재사용 헬퍼 `write_translation_timeline(output_dir, base, src_lang)` 신설
  (`transcribe_worker.py`). `_save_transcription`(텍스트 추출·음악/대화 전사+번역)과
  `_run_track_process`(트랙별 번역·재번역)에서 호출. 루프 중 진행률 emit(워치독 방지).
- `_run_track_process` 전사 시 `_timestamps.txt`도 저장하도록 보강(트랙별 전사에도 타임라인 근거 확보).
- **설계 선택**: 전체 번역 `_korean.txt`(문맥·자연스러움)는 그대로 유지하고 타임라인은 별도 파일.
  타임라인은 세그먼트별 번역이라 문맥이 약할 수 있으나 시간축 대조에 유용. 현재 번역 백엔드
  (600M/1.3B/LLM)를 그대로 사용. **주의: LLM은 세그먼트 수만큼 호출이 늘어 느려짐**(전체+세그먼트 2회).
- 검증: 헬퍼 로직 테스트(스탬프 보존·빈 세그먼트·timestamps 부재 시 None), 구문 OK

## 2026-08-16 — 음악 전사는 보컬만 + 재번역 경로 + 트랙 번역 백엔드 반영

- **음악 모드 텍스트/SRT는 보컬 트랙만** (사용자 관찰): 켜면 드럼·베이스·기타까지 전부
  Whisper에 넣어 환각·시간낭비였음. `_post_process`에서 `mode=='music'`이면 `name=='vocals'`만
  전사(대화 모드는 전 화자 그대로). 개별 트랙 전사는 TrackList '가사' 버튼으로 여전히 가능
  (`python/separate.py`)
- **재번역 경로 추가** (사용자 관찰): 한 번 번역하면 번역 버튼이 사라져 다시 번역할 방법이 없었음.
  번역 결과가 있으면 **"다시 번역"** 버튼 표시 → 현재 번역 설정으로 재실행 (`TrackList.tsx`)
- **트랙 번역이 백엔드 선택을 무시하던 잠복 버그 수정**: TrackList가 `translateModel`을 안 넘겨
  항상 600m였음. 이제 Options의 600M/1.3B/LLM 선택을 첫 번역·재번역 모두 반영
  (`TrackList.tsx` → `audio:process-track`)

## 2026-08-16 — 파형 재생 편의: 볼륨(듣기 전용) + 드래그 이동

- **재생 볼륨 조절**: 파형 컨트롤 행에 스피커 아이콘 + 슬림 슬라이더 추가. `ws.setVolume`
  (Web Audio 게인) — **듣기 전용, 원본 파일 미변경**. 음소거 시 아이콘 X 표시. 파일/모드
  재초기화 후에도 볼륨 재적용. 색은 모드 액센트.
- **드래그로 스크럽/이동**: `dragToSeek: true` — 파형을 끌어서 재생 위치 이동, 왼쪽으로 넘겨
  끌면 처음으로. 기존엔 정확히 클릭해야 했던 불편 해소. (`src/renderer/components/Waveform.tsx`)

## 2026-08-16 — 무음 감지 미리보기 + 청취 (Phase A)

설계 문서 `silence-preview-design.md` 기준. 완전 자동 위에 숨겨둔 확인 레이어.

- **감지 유틸** `src/renderer/lib/silenceDetect.ts` — Python `trim_silence` 감지/세그먼트 로직을
  충실히 복제(프레임 20ms/홉 10ms/−40dB/50ms 병합, 말소리 세그먼트의 여집합=제거 무음).
  **실측 검증: 제거 총량 JS=PY 완전 일치**(일반 1.940=1.940, 선행·후행 2.470=2.470, 전체무음
  0=0 — 원본 유지 가드). 경계당 frameLen 과다계상 함정을 여집합 계산으로 회피(§5 거짓 미리보기 방지).
- **GUI(옵션 패널 불가침)**: 파형 카드에만 추가. Layer 1 = 컨트롤 행 왼쪽 ghost 👁 "무음" 토글
  (music/conversation 모드). Layer 2 = 켤 때만 열리는 얇은 스트립: 무음 N곳 + 전/후 길이
  `1:12 → 0:48 (−24초)` + `◀ N/총 ▶` 스테퍼 + `▶시작 ▶끝` 경계 청취(전환을 걸쳐 재생, R1).
- **오버레이**: wavesurfer Regions로 파형 위에 모드 액센트 저알파(0.14) 표시 — 레이아웃 무변경,
  비인터랙티브(drag/resize off).
- **성능(R5)**: 감지는 미리보기 켤 때 1회, 지연 실행(클릭 블로킹 방지) + fileUrl당 캐시.
- 새 Python 파라미터 없음(현재 동작 시각화만). 감지 민감도 수동 knob은 Phase B(미착수).
- ⚠️ 인앱 시각/조작 확인은 다음 빌드에서(여기선 감지 알고리즘 동일성만 실측). smoke test 형태의
  JS↔Python 드리프트 자동 가드는 후속 후보.

## 2026-08-16 — 파일 열기 시 마지막 폴더 기억

- **문제**: 파일 열기 다이얼로그에 `defaultPath`가 없어 OS 공용 "마지막 다이얼로그 경로"에
  의존 → 다른 Electron 앱이 그 값을 바꾸면 AudioForge도 엉뚱한 폴더로 열림(사용자 관찰 정확)
- **수정**: `userData/settings.json`에 마지막 폴더(`lastDir`) 기억. `audio:get-file-info`가
  다이얼로그·드래그앤드롭 공통 경로이므로 거기서 `dirname` 저장, `audio:select-file`은
  `defaultPath`로 사용. 저장 유틸을 `saveSetting(key,value)`로 일반화(L-6 pythonPath와 공유)
  (`src/main/ipc/audio.ipc.ts`). 결정적 — 다른 앱 영향 없음

## 2026-08-16 — 옵션 패널 레이아웃 wrap + Whisper 툴팁

- **레이아웃 깨짐 수정**: 옵션 서브컨트롤이 `flexWrap` 없는 단일 행이라, 옵션을 켤수록
  항목이 오른쪽으로 밀리며 "화자 수 2명"이 세로로 깨지던 문제. 서브옵션/모델 두 행을
  **하나의 `flexWrap: wrap` 컨테이너로 통합**하고, 항상 표시되는 앵커(출력/화자수/분리)를
  앞에 배치 → 토글 컨트롤(무음간격/Whisper/언어/번역)은 오른쪽으로 밀리지 않고 아래로 줄바꿈.
  무음간격 슬라이더는 wrap에서 한 줄 독차지 않게 고정 폭(240px), 버튼에 `whiteSpace:nowrap`로
  라벨 세로 깨짐 방지 (`src/renderer/components/Options.tsx`)
- **Whisper 모델 툴팁**: Small/Medium/Large/Turbo 의미를 알기 어렵던 문제 → 크기별 설명
  툴팁 추가(WHISPER_HINTS, 아티스트 친화 평이한 용어: 속도·정확도·용량 트레이드오프)
- **툴팁 확충(의미 불분명 컨트롤 전반)**: 힌트맵 패턴을 다른 컨트롤에도 적용 —
  Options: 출력 포맷(WAV/MP3/FLAC=OUTPUT_HINTS), 음악 분리 모델(4트랙/2트랙 설명),
  언어(자동 vs 강제 이유), 칩 전체(무음제거/텍스트변환/번역/SRT=전문용어 풀이).
  TTSEditor: 엔진(auto/GPT-SoVITS/F5/Kokoro), 속도·간격 슬라이더. 모두 아티스트 친화 용어
  (`Options.tsx`, `TTSEditor.tsx`). 모드 탭은 라벨이 이미 명확해 제외

## 2026-08-16 — 완성도 개선 패스 (L-items + 잔여 정리)

기능 결함이 아닌 유지보수성·정확성·견고성 정리. 그룹 단위 진행.

**그룹 A — 자잘한 안전 수정**
- L-8: `conversation_worker` docstring hop 표기 수정(0.75s→0.5s, 코드가 권위 HOP_SEC=0.5)
- F2: `_get_llm` 진행 메시지가 "Qwen2.5-3B" 하드코딩 → `model_name` 변수 기반으로(모델 바꿔도 정확)
- F3: `find_ffmpeg` 결과 모듈 캐시 — 반복 호출 시 winget 폴더 `os.walk` 재탐색 제거
- L-4: requirements.txt 정정 — **audio-separator 누락 추가**(RoFormer 9-4 기능 의존, 실제 구멍),
  transformers 주석에 로컬 LLM(Qwen) 추가 + 버전을 검증 환경(4.57.3)에 맞게 `>=4.57.0`으로,
  whisper 주석에 large-v3-turbo 추가. (07-05 이후 speechbrain/whisper/f5-tts/kokoro는 이미 반영돼 있어
  L-4 원문의 "누락" 지적 대부분은 이미 해결된 상태였음 — 실제 남은 건 audio-separator였음)

**그룹 B — 취소 견고성**
- L-9: `PythonRunner.cancel()`이 `kill()`로 부모 python만 종료 → 자식(ffmpeg/격리 venv) 잔존 가능.
  Windows에서 `taskkill /pid <pid> /T /F`로 프로세스 트리 전체 종료, 실패 시 `kill()` 폴백.
  비 Windows는 기존 `kill()` 유지 (`src/main/services/python-runner.ts`)

**그룹 C — 설정 영속화**
- L-6: 사용자가 고른 python 경로가 메모리에만 있어 재시작 시 초기화되던 문제.
  `userData/settings.json`에 저장(`settings:set`/`settings:select-python-path`), 시작 시 우선 적용.
  사용자 명시 선택이 자동 해석(env.json/기본값)보다 우선. app.getPath는 ready 이후에만 접근
  (`registerAudioIpc` 내부에서 로드) (`src/main/ipc/audio.ipc.ts`)

**그룹 D — 렌더러 정리**
- L-11: `TrackItem`/`KaraokeButton`의 `HTMLAudioElement`가 언마운트 시 미정리 → 재생 중
  트랙 목록 교체/언마운트 시 소리 잔존. 각 컴포넌트에 unmount cleanup useEffect 추가
  (pause + src 해제). KaraokeButton은 조기 `return null`보다 위에 배치해 훅 규칙 준수
  (`src/renderer/components/TrackList.tsx`)
- F1: 입력 포맷 개방 이후 디코딩 불가/손상 파일 드롭 시 `loadFile`이 `console.error`만 하고
  **사용자에겐 무반응**이던 문제 → `setError`로 안내 메시지 표시 (`src/renderer/components/DropZone.tsx`)

**그룹 E — 리팩터(신중)**
- L-1: 트랙 분할의 타임스탬프 모드와 자동감지 모드에 있던 추출 루프 ~50줄 중복을
  공통 함수 `_extract_tracks_ffmpeg(...)`로 통합(차이는 진행률 범위·라벨 규칙뿐 → 파라미터화).
  실행 검증: 6초 입력 2,4초 분할 → 3트랙(0-2/2-4/4-6), 라벨/파일명/메타데이터/진행률 정확
  (`python/separate.py`)
- L-3: 감정 정의 TS(TTSEditor.tsx)/Python(tts_worker.py) 중복 → **드리프트 가드로 해결**.
  두 정의는 관심사가 달라(TS=색상/그룹, Python=한/영 태그·프롬프트) 분리 유지하되,
  smoke_test에 `_check_emotions()` 추가: TS의 emotion id를 파싱해 `id ⊆ EMOTION_PROMPTS 키
  ∩ EMOTION_TAGS 값` 불변식 대조, 어긋나면 조용한 기본값 폴백 대신 FAIL. 양쪽에 교차참조 주석.
  공유 JSON(단일 소스) 방식은 Vite의 src 밖 import + 패키징 포함이 필요하고 이 환경에서
  프로덕션 빌드 검증이 불가('dev OK, 배포 깨짐' 리스크)해 **의도적으로 채택 안 함**.
  검증: `smoke_test --quick`에서 TS 50종 ⊆ Python 일치 PASS(가드가 스코핑 오탐도 잡아냄)
- L-2: 무음 감지 3벌(클라이언트 RMS / ffmpeg silencedetect / trim_silence) → **평가 후 통일 안 함**.
  SplitEditor의 자동 감지를 Python silencedetect로 통일하면 클릭마다 서브프로세스 왕복으로
  즉답성 상실 = UX 후퇴. 3벌은 목적(즉시 인터랙티브/배치 정확도/트리밍)이 달라 정당한 분리.
  실제 결함이던 오해 소지 주석("calls Python"인데 실제 클라이언트)만 정정 (`SplitEditor.tsx`)

**그룹 F — L-10**
- L-10: `gptsovits_bridge`의 죽은 `models_dir` 변수는 이미 제거된 상태(obsolete). 현재 bridge는
  `TTS_Config(yaml)`로 모델 경로를 로드 — 코드 변경 불필요, 문서만 정리

**요약**: code-review L-1~L-11 전부 소진(L-5·L-7 기존 완료 + 이번 A~F). 신규 결함 0,
기능 회귀 0. 검증: TSC 무에러, python 구문 OK, split 실행 검증, smoke_test --quick 3/3 PASS.

## 2026-08-16 — 입력 포맷 전면 개방 (ffmpeg 디코딩 가능 전부, mo3 등 포함)

- **동기**: 개발자 실사용으로 트래커 모듈(mo3 등) 등 비주류 포맷 입력 필요. UI에는
  대표 포맷만 유지(긴 나열 회피), 실제 허용은 ffmpeg가 디코딩 가능한 전 포맷으로 확장
- **입력 필터 개방(2곳)**:
  - 드래그앤드롭 확장자 화이트리스트 제거 — 모든 파일 허용, 디코딩 불가 시 파이프라인이 에러 처리
    (`src/renderer/components/DropZone.tsx`)
  - 파일 다이얼로그에 'All Files'(`*`) 필터 추가, 대표 Audio/Video 필터는 편의용으로 유지
    (`src/main/ipc/audio.ipc.ts`)
  - UI 표시 텍스트/배지는 **의도적으로 그대로**(짧게 유지) — 요구사항
- **RoFormer 경로 ffmpeg 정규화**: 유일하게 원시 입력을 audio-separator 자체 로더로
  직행하던 `run_roformer_separation`에 `convert_to_wav` 전처리 + 임시파일 정리 추가
  (`python/music_worker.py`). 나머지 모드는 이미 ffmpeg 경유(Demucs·대화=convert_to_wav,
  Whisper=내부 ffmpeg, split=ffmpeg 직접)라 무변경
- **검증**:
  - 앱이 실제로 고르는 ffmpeg(winget Gyan 8.1)에 `libopenmpt`/`libmodplug` 존재 확인,
    데뮤서 `libopenmpt — Tracker formats` 등록 확인 → mo3 디코딩 능력 실측
  - soundfile 불가·ffmpeg 가능 부류(m4a 프록시)로 메커니즘 증명: soundfile 직접 read는
    LibsndfileError, `convert_to_wav` 경유 시 44100Hz wav 정상 + cleanup 정상
  - TSC 무에러, music_worker 구문 OK
  - ⚠️ 실제 `.mo3` 샘플 파일 e2e는 미실행(샘플 부재) — 능력·메커니즘은 검증됨

## 2026-08-14 — Whisper Turbo 옵션 추가 + 모델 업그레이드 검증

- **Whisper large-v3-turbo 옵션 추가** (기본 large-v3 유지, 비파괴적):
  - 디코더 4층(large-v3는 32층) → 약 8배 빠름, 정확도 ≈ large-v2
  - UI Whisper 셀렉터에 "Turbo" 버튼 + 툴팁(한/일 CJK는 Large가 근소 우위 안내)
  - `whisperModel` 유니온에 'large-v3-turbo' 추가, config→args.whisper_model→
    whisper.load_model 전체 배선 확인, 화이트리스트 없음. whisper 20250625가
    available_models()에 'large-v3-turbo' 보유(검증). 최초 선택 시 ~1.6GB 다운로드
- **검증으로 반려된 후보(중요 — 무턱대고 교체 금지 근거)**:
  - **Mel-Band RoFormer 교체 반려**: 이 환경 audio-separator 0.44.2 번들 목록 기준,
    일반 보컬 분리는 현행 BS-RoFormer `ep_317`=**SDR 12.98**이 최고. 번들 Mel-Band
    일반 보컬 `ep_3005`=**11.44로 오히려 낮음**. SDR 27.99/19.17짜리 Mel-Band는
    디노이즈·디리버브 **전용**(보컬 분리 아님). 최신 커뮤니티 체크포인트
    (kim_ft2_bleedless_unwa, vocals_revive_v3e_unwa 등)는 파일명 SDR 부재로 수치
    우위 증명 불가 → 실측 A/B 없이는 교체하면 품질 저하 위험. **보류.**
  - **Qwen3 번역 백엔드 교체 보류**: 8B bf16≈16GB인데 번역 시 Whisper(~3GB)가
    캐시 잔존해 공존 OOM → 4B(bf16≈8GB)라야 공존 가능. 게다가 Qwen2.5-3B 품질이
    아직 사용자 청취 검증 전 → 미검증 모델을 미검증 모델로 바꾸는 churn. **2.5-3B
    청취 후 판단.** (교체 시엔 thinking 태그 회피 위해 Instruct-2507 변형 사용)

## 2026-08-14 — 화자 분리 재현성 (L-7 kmeans 시드 고정)

- **문제**: `_kmeans` k-means++ 초기화가 `np.random`(전역·비시드)을 써서 같은 입력도
  실행마다 화자 분리 결과가 미세하게 달라짐 → 위 M-2 속도 검증 때 old/new 전체 파이프라인
  대조가 불가능했던 원인
- **수정**: `_kmeans(data, k, rng=None)`로 생성기 주입. 호출부에서 `default_rng(0)` 하나를
  10회 재시작 전체에 **공유** → 재시작 간 초기화 다양성은 유지, 실행 간에는 완전 동일
- **검증**(격리): 같은 시드 2회 실행 라벨/inertia 완전 동일 ✓ / 어려운 데이터 10회 재시작
  inertia 5종(초기화가 재시작마다 실제로 다름) ✓ / 3군집 순수 분리 ✓ / 비시드 경로 유지 ✓
- 새 의존성 0. numpy Generator API만 사용

## 2026-07-24 — 화자 분리 속도 개선 (M-2 잔여분, 새 의존성 0)

- **임베딩 배치 추론**: 슬라이딩 윈도우를 1개씩 GPU 호출하던 것을 같은 길이 청크끼리
  묶어 배치(32) 추론. 동일 길이만 한 배치로 넣어 패딩이 없으므로 개별 추론과 결과 동일
- **Gaussian 확률맵 벡터화**: Step 5 프레임×화자 이중 파이썬 루프를 numpy 슬라이스 누적으로
  교체 (유예됐던 "M-2 Gaussian 벡터화" — 부동소수 순서 우려 해소)
- **결과 동일성 검증**(격리 테스트, kmeans 무작위성과 무관):
  - Gaussian 벡터화: 기존 루프와 scores/weights **완전 동일**(bit-identical), 프레임 라벨 동일 (n=2/3/5)
  - 배치 임베딩: 개별 추론 대비 최대 오차 1.7e-4, 자기 코사인 0.99999994 — 클러스터링 영향 없음
- 효과: 1시간 통화의 임베딩 추출/후처리 구간 대폭 단축. numpy/기존 speechbrain만 사용
- 참고: `_kmeans` 무작위 시드 미고정(L-7)은 이번 범위 밖 — 실행마다 미세 변동은 그대로

## 2026-07-24 — 품질 로드맵 §9-2 후속: 로컬 LLM 번역 백엔드 (Qwen2.5-3B)

- 번역 백엔드에 로컬 LLM(Qwen2.5-3B-Instruct) 추가 — JA→KO 구어체·문맥 번역이 NLLB보다 나음
- **환경 리스크 없음**: 이미 설치된 transformers(4.57.3, qwen2 지원)+torch를 그대로 재사용.
  새 venv·빌드·설치 없음. 모델(~6GB)은 HF 캐시에 최초 1회 다운로드(NLLB와 동일 방식)
- 백엔드만 교체하는 최소 변경: `translate_to_korean`을 디스패처로,
  `_translate_nllb`(기존)/`_translate_llm`(신규)로 분리. `set_translate_model`이
  config `translateModel` 값으로 라우팅('llm'/'qwen3b'→LLM, 그 외→NLLB 600m/1.3b)
- LLM은 문장을 ~1200자 청크로 묶어 한 번에 번역(문맥 유지 + generate 호출 감소),
  그리디 디코딩(결정적) + "번역문만 출력" 시스템 프롬프트
- UI: 번역 셀렉터에 'LLM' 버튼 추가(600M/1.3B/LLM), hover 힌트로 특성·다운로드 용량 안내
- **VRAM**: Qwen 3B(bf16 ~6GB) + Whisper(~3GB) 공존, 16GB 내 여유
- 검증: py_compile + TS 빌드 + 디스패치 라우팅 6종(모델 로드 없음) + transformers 호환 확인.
  **번역 품질은 실제 GPU 추론+청취로 사용자 검증 필요**(NLLB 1.3B 사례와 동일 원칙)

## 2026-07-05 — 환경 탐지/설치 구조 + 의존성 프레이밍 정정

- **프레이밍 정정**: 의존 대상은 ComfyUI 앱이 아니라 그 안에 설치된 AI 패키지들
  (코드 전수 확인 — 쓰는 건 python.exe 경로뿐, API/노드/모델 미사용)
- python/env_check.py: 환경 doctor (필수 패키지/ffmpeg/CUDA 점검, 단일 목록 소스)
- python/setup_env.py: 파이썬 해석/설치 (attach 우선 → 없으면 전용 venv,
  빌린 환경엔 자동설치 금지, env.json 기록)
- audio.ipc.ts: 하드코딩 경로 → resolvePythonPath (env.json → 기본값 → 시스템)
- .gitignore: externals/ 전체 무시 (venv·모델·env.json 머신별 자산)
- doc/environment.md 신규: 의존성·해석 구조·이식성 체크리스트·한계
- architecture/features/code-review 문서의 "ComfyUI 종속" 표현 정정

## 2026-07-05 — 품질 로드맵 §9-4 (RoFormer 보컬 분리)

- 음악 분리에 BS-RoFormer(SDR 12.97) 보컬/반주 2트랙 옵션 추가
- audio-separator+onnxruntime이 ComfyUI 환경에 이미 설치돼 있어 **환경 리스크 없음**
  (§9-7 격리 우려 해소) — 새 venv/설치 불필요
- music 모드 선택: 기본4트랙 / 고품질4트랙 / 보컬2트랙(RoFormer)
- 모델 610MB는 externals/separator_models 캐싱(gitignore). 15초 ~5초(GPU)
- 스모크 테스트에 music(RoFormer) 추가 → 7 PASS
- TrackList에 instrumental(반주) 색상 추가

## 2026-07-05 — 품질 로드맵 §9-2 (번역 모델 선택)

- NLLB 모델 선택 옵션 추가 (600M 기본 / 1.3B) — config/store/UI 배선, 캐시 무효화 처리
- **실측 결론**: 1.3B는 신뢰할 만한 개선 아님 (일부 문장 오히려 환각 심화) → 선택 옵션으로만
  제공, 기본 600M 유지, UI 라벨 중립화("고품질"→"1.3B"). 강제 다운로드 없음
- 진짜 번역 품질 레버는 LLM(문맥 인지) — 외부 서비스 결정 필요로 사용자 대기

## 2026-07-05 — 품질 로드맵 §9-1/§9-3/§9-5

### 9-1 Whisper 환각 대책
- condition_on_previous_text=False로 분리/무음 트랙의 반복 환각 억제
- 언어 강제 옵션(자동/한국어/영어/일본어/중국어) UI + config 배선

### 9-3 스모크 테스트 (python/smoke_test.py)
- 6개 모드 + 번역 경로를 result까지 검증, C-1 회귀 감지 설계

### 9-5 GPT-SoVITS 한국어 TTS 완성
- **VS Build Tools 없이 해결**: jieba_fast→jieba shim, eunjeon→python-mecab-ko shim
  (프리빌트 cp312 휠), 둘 다 격리 venv에 생성
- v2 사전학습 모델 다운로드(~1GB), 재현용 python/setup_gptsovits.py 작성
- 브리지 재작성: torchaudio soundfile 패치, sys.path/chdir 정리,
  run() (sr,ndarray) 튜플 파싱 버그 수정, all_ko 언어 매핑
- 참조 음성 Whisper 자동 전사(prompt_text)로 클로닝 품질 향상 + ref-free 폴백
- 검증: 스모크 tts PASS (7/7). 청취 품질은 사용자 검증 필요
- tts-setup-guide.md 전면 갱신

### 9-5 후속: 일본어 참조 대응 + 품질 한계 확정 (TTS 정리)
- fast_langdetect(lid.176.bin) 셋업 추가 (일본어/중국어 언어 구분)
- pyopenjtalk 미설치 graceful fallback: 일본어 출력=명확한 에러, 일본어 참조=ref-free 강등
- **사용자 청취 결과**: speaker_b(분리 조각) 클로닝 품질 낮음 → 참조 음원 한계로 진단
- 파인튜닝 검토: C++ 컴파일러 부재(pyopenjtalk 빌드 불가) + 데이터 부족(~20초 조각)으로 보류
- 언어별 지원 확정: 한/영/중 출력 = 빌드 불필요 동작, 일본어 = pyopenjtalk 빌드 필요
- 사용자 결정으로 TTS 여기서 정리 (재개 조건: VS Build Tools + 1~3분 깨끗한 화자 음성)

## 2026-07-05 — 리뷰 후속 수정 12건 (커밋별 1건 + 테스트)

### Critical
- **번역 torch import 누락 복구** (C-1): 번역 옵션 100% 크래시 해소
- **stdout JSON 라인 버퍼링** (C-3): 64KB 청크 분할로 result 유실 → 99% 멈춤 증상 방지. StringDecoder로 한글 분할도 방어. 1MB JSON 통합 테스트
- **TTS 엔진 캐싱** (C-2): 문장마다 모델 재로딩(10문장=10회) → 1회. Kokoro `or True` 제거

### High
- **track-process config화** (H-1): 한글 경로 spawn 인자 마지막 잔존 경로 제거
- **torchaudio 패치 지연 로딩** (H-2): 전 모드 시작 시 torch 10-30초 로딩 제거 (split 모드 e2e 0.78초)
- **trackRunner 수명 관리 + audio:track-error 채널** (H-3): 가사/번역 버튼 '처리 중' 고착/연타 누적/취소 불가 해소 (구 BUG-5/6 종결)

### Medium
- **NLLB CJK 문장 분리 + 400자 하드 청크** (M-3): 일본어 번역 조용한 유실 차단
- **TTSEditor 상태 store 초기화** (M-6): 모드 전환 시 대사 유실 방지
- **ffmpeg 실패 감지** (M-5): 손상 파일/디스크 부족 시 '완료!' 대신 명확한 에러
- **SplitEditor 리스너 정확 해제** (M-7) + **get_device daemon 스레드** (M-8)
- **트랙 분할 입력 시킹** (M-4): 곡마다 처음부터 디코딩 제거 (10.000s/42.459s 정확 검증)
- **화자 분리 루프 불변 최적화** (M-2 안전 부분): 중심 재계산 제거 + O(1) 인덱스 (통화 52초 e2e 검증)

### 문서/환경
- requirements.txt 실사용 기준 재작성 (pyannote 제거, whisper/speechbrain/f5-tts/kokoro 추가)
- architecture.md 현행화 (TTS 계층 반영, 구조 문제 목록 갱신)
- dev-guide.md 구버그 6건 종결 표기 — 버그 단일 소스는 code-review-2026-07-05.md
- 보류 항목: M-1(F5 ref_text — 청취 검증 필요), M-2 벡터화(동일성 검증 체계 필요), L-1~11

## 2026-07-05 — 전체 코드 리뷰 (4,330줄 전수)

- **doc/code-review-2026-07-05.md 작성**: Critical 3건(번역 torch NameError, TTS 문장별 모델 재로딩, stdout JSON 라인 버퍼링 부재) + High 3건 + Medium 8건 + Low 11건, 수정 우선순위 로드맵 포함
- dev-guide.md 잔존 버그 6건 재검증: BUG-1/2/3/4는 이미 해결/무효, BUG-5 잔존, BUG-6 부분 잔존
- 문서-코드 불일치 확인: architecture/dev-guide/changelog가 TTS 추가(커밋 15개분) 이전에서 정지 상태
- 참고: 이 changelog 아래 항목들은 TTS 관련 커밋(감정 50개, 엔진 추상화, GPT-SoVITS 등)을 누락하고 있음 — 차기 갱신 시 보완 필요

## 2026-04-12 — 성능 최적화 + 구조 정리

### 트랙 분할 최적화
- 타임스탬프 분할: ffmpeg 직접 추출 (WAV 변환/메모리 로딩 불필요, 80분 파일 ~30초)
- 자동 감지: ffmpeg silencedetect 필터로 교체 (Python RMS 분석 제거)
- 파일명에 곡 제목 포함 (`01_恋愛サーキュレーション.wav`)
- JSON 메타데이터 + 오디오 태그 내장 + meta-fix 모드
- `_tracklist.txt` 자동 저장 (트랙번호 + 타임스탬프 + 제목)
- 이전 결과 폴더 열기 (앱 재시작 후 복원)
- 첫 번째 트랙 제목 정상 적용

### 성능 개선
- NLLB-200 GPU 가속 + 모델 캐싱 (3-5배 빠른 번역)
- Whisper 모델 크기 선택 (Small/Medium/Large)
- Demucs 모델 선택 (htdemucs 기본 / htdemucs_ft 고품질)
- 처리 시간 예측 표시
- 대화 분리 2-5명 화자 지원

### Python 모듈 분리
- separate.py (1231줄) → 5개 파일로 분리
  - separate.py (486줄): CLI 라우팅 + 후처리
  - audio_utils.py (155줄): I/O, ffmpeg, 유틸
  - music_worker.py (70줄): Demucs
  - conversation_worker.py (377줄): 화자 분리
  - transcribe_worker.py (139줄): Whisper + NLLB

### UX 개선
- 파일 정보 + 파형 통합 카드
- 탭 형태 모드 선택 (4개)
- 접이식 옵션 (활성 뱃지 미리보기)
- 결과 화면 재처리 버튼
- 트랙별 개별 가사/번역 버튼
- 노래방 모드: drums+bass+other 동시 재생

### 인터랙티브 트랙 분할 에디터
- wavesurfer.js + Regions 플러그인
- 타임스탬프 붙여넣기 파싱 (다양한 포맷 지원)
- 자동 감지 결과 수정 가능
- 마커: 더블클릭 추가, 드래그 조정, 5초 미리듣기, 삭제
- 트랙 번호 표시

### 버그 수정
- ffprobe 경로: dirname+join (replace가 폴더명 깨뜨림)
- 임시 파일명: input→source (ffmpeg 동일 파일 충돌)
- sys.path.insert: 모듈 import 실패 방지
- MP4/MKV/AVI/MOV/WebM 영상 파일 지원

### 미완료 (롤백됨)
- split_worker.py 분리: 테스트 없이 진행하여 기능 고장 → 롤백
- 교훈: 한 파일씩 분리 → 테스트 → 커밋 순서 필수

## 2026-04-12 — UX 개선 + 트랙 분할 + Phase 2

### Phase 2 기능
- **NLLB-200 한국어 번역**: 28개 언어 → 한국어 자동 번역
- **SRT 자막 내보내기**: Whisper 타임스탬프 → 표준 SRT 포맷

## 2026-04-11 — Phase 1 + 핵심 기능

### Phase 1 기능
- 텍스트 단독 추출 모드, 클립보드 복사, 출력 포맷 선택
- 노래방 모드, 시간별 출력 폴더

### 대화 분리 v3
- Silero VAD + ECAPA-TDNN + 스펙트럴 클러스터링
- 슬라이딩 윈도우 + 프레임별 확률 맵 + 시간 스무딩

### 버그 수정
- 드래그앤드롭 (webUtils), 한글 경로 (-X utf8)
- Windows symlink, Tailwind v4 레이아웃

## 2026-04-11 — 초기 생성
- Electron + React + TypeScript 프로젝트
- Demucs 음악 분리, ECAPA-TDNN 대화 분리
- wavesurfer.js 파형, 무음 구간 제거
