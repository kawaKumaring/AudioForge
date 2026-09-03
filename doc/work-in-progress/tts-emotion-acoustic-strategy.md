# 감정 음향 전략 — v1.4 권위 문서

작성 2026-08-28 (Qwen3-TTS-12Hz-0.6B-Base 기준). **갱신 2026-09-03 — v1.4 감정·음률의 기술 권위 문서.**

이 문서는 **무엇이 되고 무엇이 안 되는지**를 있는 그대로 적는다. 되지 않는 것을 되는 것처럼
적지 않는다. 이 문서와 코드·UI 문구가 어긋나면 문서가 아니라 코드가 틀린 것이다.

감정·음률에 관한 기술 결론은 여기 한 곳에 모은다. 다른 문서는 이 문서를 가리키고 세부를
복제하지 않는다. 과거 조사·계약 문서는 **역사적 근거로 보존**하며, 현재와 달라진 항목은
지우지 않고 `STALE` 로 표시한다.

---

## 1. 한 줄 요약

**현재 단계는 `reference_matched` 다.** 요청한 감정에 가까운 참조 클립을 **같은 화자의 후보
중에서 고르는 것**까지 구현됐다. 이것은 감정 적용 성공이 아니고 감정 인식 성공도 아니다.

모델에 감정 제어값을 전달하는 통로는 여전히 **하나도 없다**(§7). 기존 결과를 "감정 구현
완료"로 표현하는 것은 금지한다.

---

## 2. 성취 사다리 — 여섯 칸을 섞지 않는다

이 여섯 개는 서로 다른 상태다. 앞 칸을 뒤 칸으로 승격해 적지 않는다.

| 칸 | 뜻 | 현재 | 코드 대응 |
|---|---|---|---|
| 분석 가능 | 참조 클립에서 시간축 프로필을 잴 수 있다 | **달성** | `emotion_acoustic.analyze_profile_v3`, 적용 상태 `analyzed` |
| 후보 비교 가능 | 같은 화자의 후보 여럿을 같은 기준으로 견줄 수 있다 | **달성(자료 한정)** | `compare_profiles_v3` — 단 깨끗한 감정별 자료가 있어야 성립(§9) |
| `reference_matched` | 그 비교로 참조를 골라 이 발화에 붙였다 | **현재 단계** | `speaker_refs.resolve_with_emotion` |
| `model_applied` | 모델에 감정 제어값을 실제로 넘겼다 | **불가 — 통로 없음** | 상수 `False`, 테스트가 고정 |
| `post_applied` | 후처리로 실제 적용했다 | **미적용(승인 전 금지)** | 상수 `False`, 테스트가 고정 |
| 사용자 청취로 감정이 확인됨 | 사람이 듣고 의도한 감정으로 들린다고 판정했다 | **미수행** | 코드 상태 없음 — 판정 코드로만 기록(§14) |

"후보 비교 가능"과 "사용자 청취 확인"은 코드의 적용 상태 어휘(`EMOTION_APPLICATION_STATES`)에
칸이 없다. 전자는 자료 조건이고 후자는 사람의 판정이기 때문이다. 이 둘을 코드 상태로
승격하지 않는다 — 필요한 것은 상태가 아니라 자료와 청취다.

---

## 3. 기존 기술 자료 ↔ 현재 v1.4 구현 대응표

분류: `CURRENT`(현재 코드와 일치) · `IMPLEMENTED`(과거 계획이 구현됨) · `STALE`(현재와 달라짐) ·
`OPEN`(미구현·미검증).

### 3.1 `doc/research/tts-prosody-control.md` (2026-08-22)

| 결론 | 분류 | 근거 |
|---|---|---|
| 0.6B Base 는 텍스트 지시로 감정을 바꾸지 못한다 | CURRENT | vendor 모델 카드·추론 소스에서 재확인(§7) |
| Base 의 감정은 (a) 참조 (b) 샘플링 다양성 (c) 후처리뿐 | CURRENT | 현재도 같다 |
| 제어 2축 — 생성 축(재합성) / 후처리 축 | CURRENT | 공용 어휘로 계속 쓴다 |
| pitch·energy 는 "아직 어디에도 없다" | STALE | pitch 는 rubberband 후처리로 구현됨. energy 는 macro gain(boost-only)으로 별도 구현 |
| CustomVoice 등 instruct 모델은 "설치 금지 대상" | STALE | 금지 대상이 아니라 **미설치**다. 설치된 1.7B 는 Base 이며 instruct 모델이 아니다(§7.2) |
| 감정별 pitch/speed/pause/energy 범위표(§4) | OPEN | 가설이며 측정으로 확정한 적 없다. **프리셋으로 코드에 넣지 않았다** |
| 블라인드 3축 평가(유사도/자연스러움/감정 전달) | OPEN | 절차만 있고 수행하지 않았다. 임계값 교정의 전제(§10) |
| 감정 비교는 같은 대사 + 중립 앵커 | CURRENT | 유효하며 clean dataset 요건에 그대로 들어간다(§10) |

### 3.2 `doc/work-in-progress/tts-prosody-integration-contract.md` (2026-08-22)

| 결론 | 분류 | 근거 |
|---|---|---|
| `ttsEmotionRefSources` / `ttsEmotionRefs` / `ttsEmotionRefRegions` 3필드 분리 | IMPLEMENTED | 현재 `ttsConfig` 에 존재 |
| 만료 참조 4불변식(silent fallback 금지) | IMPLEMENTED | `tts_worker` 에 코드로 존재. v1.4 의 화자 축 fail-closed 도 같은 원칙의 확장 |
| pitch 는 전 엔진 공통 **최종** 후처리, 0 이면 무호출 | IMPLEMENTED | `pitch_shift` + 호출 계약 |
| `pitch_method` 는 `rubberband` 또는 `null` 뿐 | CURRENT | 저품질 폴백 없음 |
| UI 금지 표현("AI 가 문맥 읽고 감정 연기") | CURRENT | v1.4 문구 규칙에 그대로 이어진다(§8) |
| 브랜치 소유권(A/B/C/통합), 병합 순서 | STALE | 그 브랜치들은 이미 병합·종료됐다. 역사 기록으로만 읽는다 |
| 근거 SHA `0788885`·`ca42b0e`·`cf524be`·`fed9686`·`45226c7` | STALE | 현재 기준선은 §12 |
| §13 취소 순서 "가설" | STALE | 취소 계약은 이후 별도 작업에서 구현·검증됐다 |

### 3.3 `doc/work-in-progress/tts-prosody-integration-audit.md` (2026-08 중순)

| 결론 | 분류 | 근거 |
|---|---|---|
| **무응답 280초 계약을 근거 없이 늘리지 않는다** | CURRENT | `tts_worker._QWEN_INACTIVITY_SEC = 280` 그대로다. **이 항목은 STALE 이 아니다** |
| CPU generate 실측 24.6초 / 모델 로딩 13.5초 | CURRENT(역사적 실측) | 0.6B 기준값. 더 큰 모델에는 다시 재야 한다 |
| 280초 초과는 GPU 포화 시 자원 경합 | CURRENT | 알려진 제한으로 유지 |
| develop `0788885` · master `ca42b0e` · "develop 병합 금지" | STALE | 그 시점의 상태다 |
| Kokoro espeak 결함, externals junction 절차 | STALE | junction 은 이후 사고로 **금지**됐다(`script-scene-architecture §15`) |

### 3.4 `doc/work-in-progress/tts-expression-validation-roadmap.md` (2026-08-26)

| 결론 | 분류 | 근거 |
|---|---|---|
| "코드 존재 / 테스트 통과 / 실제로 들림"은 다른 상태 | CURRENT | §2 사다리가 이 원칙의 v1.4 판이다 |
| 완료 정의 5단계(구현·기술검증·품질검증·통합·릴리스) | CURRENT | 그대로 쓴다 |
| 금지 사항(감정 참조와 후처리를 동시에 크게 적용 금지 등) | CURRENT | 유효 |
| 생성 한도 `ABS_LIMIT=256` 은 모델 한도가 아니라 watchdog 정책 | CURRENT | `generation_limit.ABS_LIMIT = 256` 그대로 |
| 기준선 `develop 734dd00` · `master ca42b0e` · `v1.0.0@810e448` | STALE | §12 |
| 미완성 worktree 3개(preview / v3wire / boundary) | STALE | 이후 정리됨. worktree junction 은 현재 금지 |
| 장문 F0 연속성 "실패 판정" | OPEN | v3 프로필이 이제 곡선을 **잴 수 있게** 됐을 뿐, 연속성 개선은 하지 않았다 |
| 감정 fixture v3 계획 | IMPLEMENTED(분석 계층만) | §5. 생성 적용은 아님 |

### 3.5 `doc/references/emotion-tts-models.md` (2026-08-23)

| 결론 | 분류 | 근거 |
|---|---|---|
| Qwen Base 는 복제용이고 instruction 감정 제어 모델이 아니다 | CURRENT | 공식 표에서 instruction control 은 CustomVoice/VoiceDesign 에만 표시 |
| Base 에서 감정별 참조가 정직한 제어 방법 | CURRENT | v1.4 의 참조 선택이 이 결론의 연장이다 |
| 0.6B Base 약 2.52GB / 1.7B Base 약 4.54GB | CURRENT | 실측 2.51GB / 4.54GB 로 일치(§7.4) |
| **CosyVoice 3 가 한국어·제로샷 복제·instruction 을 함께 제공하는 PoC 1순위** | CURRENT · OPEN | 여전히 유효한 후보이며 아직 수행하지 않았다(§9-4) |
| IndexTTS-2.5 는 감정 분리 구조가 가장 명확하나 **한국어 미지원** | CURRENT | 제품 경로가 아니라 연구 PoC 로만 |
| PoC 공통 gate(동일 대사·3회 이상·축 분리 평가·라이선스 동급 평가) | CURRENT | 대체 엔진 비교의 조건으로 그대로 쓴다 |
| 감정 샘플 보드는 새 모델 없이 바로 가치 있다 | OPEN | 미구현 |
| 자동 점수보다 사용자 청취가 최종 권위 | CURRENT | §14 |

### 3.6 `doc/references/emotional-speech-product-patterns.md` (2026-08-23)

| 결론 | 분류 | 근거 |
|---|---|---|
| **화자와 연기는 다른 축이다** | CURRENT | v1.4 가 화자 축과 감정 축을 분리해 구현한 근거 |
| 감정 제어력 비교에는 **같은 대사**를 써야 한다 | CURRENT | clean dataset 요건(§10) |
| 비언어 사건은 `emotion`·`pause` 와 다른 타입이어야 한다 | OPEN | 미구현 |
| 수치를 `기쁨 85점`처럼 감정 정답으로 표시하면 안 된다 | CURRENT | v1.4 UI 원칙의 직접 근거(§8) |
| 감정 참조가 없으면 "기본 참조 기반 예상"으로 표시 | IMPLEMENTED(형태 다름) | `감정 참조 자료 부족` 으로 표시 |
| instruction-capable 로컬 모델이 **검증되면** 고급 기능을 capability-gated 로 | CURRENT | 아직 검증된 모델이 없다 |

### 3.7 `doc/script-scene-architecture.md`

| 결론 | 분류 | 근거 |
|---|---|---|
| 열 축 분리(`source_paragraphs`/`speakers`/`utterances`/`emotions`/… /`chunks`) | IMPLEMENTED(1.3·1.4 범위) | plan schema 2 |
| 1.4 완료 조건: 감정 세기가 **후처리 gain 으로 구현되지 않을 것** | CURRENT | 지금도 gain 으로 구현하지 않았다 |
| 1.4 완료 조건: 화자별 참조 fingerprint 가 캐시 키에 들어감 | IMPLEMENTED | `reference_id` 는 파일 **내용** SHA 에서 나온다 |
| 1.4 완료 조건: 다화자 장문 청취 판정 | OPEN | 짧은 4발화 대화만 청취 PASS |
| §12 상위 모델 비교는 공용 구조가 선 **뒤에** adapter 로 | CURRENT | v1.4 의 대체 엔진 PoC 도 이 규칙을 따른다 |
| §15 테스트 과잉 방지 · junction 금지 | CURRENT | 이번 작업도 표적 검증만 수행 |

### 3.8 `doc/roadmap.md`

| 결론 | 분류 | 근거 |
|---|---|---|
| **연기·믹싱·공간 세 축 분리** | CURRENT | v1.4 가 지킨다. 참조 선택은 `performance_prosody` 축이고 gain 을 건드리지 않는다 |
| 트랙 gain 을 키우는 것은 언성을 높이는 것이 아니다 | CURRENT | v3 상대 에너지 축이 `not_a_gain_command` 를 명시하는 근거 |
| `MODEL_GAIN_PROXY_FOR_PROSODY` — 모델이 register 를 gain 으로 대신 표현 | CURRENT | 후처리 보정은 **청취 전 production 금지** 상태 그대로 |
| §9 상위 모델 비교는 동일 대본·참조·하드웨어로 | CURRENT | 대체 엔진 PoC 조건 |
| 기준선 `master@fa0e907` · `develop@4b64947` | STALE | §12 |
| "1.3 … 사용자 인수 대기" · "1.4 … 1.3 인수 뒤 착수" | STALE | 1.3 은 정식 릴리스됐고 1.4 는 진행 중 |
| "감정 장문·fixture v3 — 계획" | STALE | 분석 계층은 구현됨(§5). 장문·청취는 여전히 OPEN |

---

## 4. 재사용한 결론 (다시 조사하지 않았다)

이번 v1.4 작업은 아래를 **기존 문서에서 그대로 가져다 썼다.** 인터넷 재조사·새 모델 조사는
하지 않았다.

1. Qwen Base 는 instruction 기반 감정 제어 모델이 아니다 — 3.1·3.5.
2. 현재 감정 전달의 실제 생성 축은 **감정별 reference** 다 — 3.1·3.5.
3. pitch·speed·pause 후처리는 감정 연기의 완전한 대체물이 아니다 — 3.1 §3.2, 원문 §8 "DSP 의 위치".
4. 화자 identity / performance prosody / mix loudness / spatial automation 을 분리한다 — 3.6·3.8.
5. 감정 비교는 **같은 대사와 중립 앵커**를 쓴다 — 3.1 §5.2, 3.6 원칙 2.
6. 자동 수치가 아니라 **사용자 청취가 최종 권위**다 — 3.5·3.6·3.7 §14.
7. 상위 모델 비교는 **공용 adapter 와 동일 조건**에서 한다 — 3.7 §12, 3.8 §9.
8. 대체 엔진 후보와 그 제약(CosyVoice 3 한국어 지원 / IndexTTS 한국어 미지원) — 3.5.

### 재사용에 실패했던 것 (기록)

2026-09-03 capability 감사에서 "Base 를 감정 자료로 파인튜닝하는 길"을 새로 발견한 것처럼
보고했다. **이미 3.1 §2 에 적혀 있던 결론이다**("base 모델을 감정 데이터셋으로 파인튜닝해야
하고 결과도 mediocre at best"). 같은 감사에서 **대체 엔진 PoC(CosyVoice 3)** 를 적용 통로
목록에서 빠뜨렸다 — 3.5 에 PoC 1순위로 기록돼 있던 항목이다. 조사 전에 기존 문서를 먼저
읽어야 한다는 사실의 실례로 남긴다.

---

## 5. v3 시간축 감정 프로필 — 분석 계층 (2026-09-03 구현)

권위: `python/emotion_acoustic.py` §8. 스키마 `af-emotion-profile/3`.

기존 `emotion_acoustic` 과 `onset_continuity_metrics` 를 **확장**했다. 새 분석기·새 파서·새
recorder 를 만들지 않았다(§13).

### 5.1 축과 상태

축은 다섯이고, 축마다 **얼마나 잴 수 있었는가**를 따로 적는다
(`AXIS_MEASUREMENT_STATES` — 적용 상태와 다른 어휘다).

| 축 | 무엇을 재는가 | 현재 상태 |
|---|---|---|
| `relative_f0` | 자기 중앙값 대비 반음 곡선(16 좌표) | `analyzed` |
| `relative_energy` | 중앙값을 뺀 상대 dB 곡선, 강세 후보 | `analyzed` |
| `rhythm` | 단어 길이비·속도 변화 | `approximate`(ASR 타이밍 있을 때) / `unsupported`(없을 때) |
| `pause_tail` | 쉼 위치·개수, 말끝 F0·에너지 변화 | `analyzed`, 단 `breath` 는 `unsupported` |
| `trajectory` | 시작·중간·끝과 방향 전환 | `analyzed` |

- `approximate` 는 "재긴 했으나 해상도가 낮다"는 뜻이다. 한국어 음절 분해기가 없어 리듬은
  **단어 anchor 까지만** 본다 — 음절 단위인 척하지 않는다.
- `unsupported` 는 검출기가 없다는 뜻이다. **호흡을 무음과 같은 것으로 판정하지 않는다.**
- 못 잰 축은 숫자를 내지 않는다. 0 으로 채우지 않는다.

### 5.2 왜 상대값인가

절대 Hz·절대 dB 를 남기지 않는다. 기준(자기 중앙값)을 뺀 곡선이라야 **다른 음역·다른 녹음
볼륨의 연기를 옮길 수 있다.** 이 성질은 GPU 없이 검증했다(§6.2).

### 5.3 실측

추적 자산 `test/fixtures/audio/ko-speech-7s.wav`(7.5초) 한 개 기준.

- 분석 시간 **66~70 ms**(같은 자산 여러 회, 회차별 편차). 참조 파일당 1회이고 캐시된다.
- 프로필 본문 **약 3.6KB**(3,630 B). 원본 프레임을 담지 않고 16개 시간 정규화 좌표만 남긴다.
- fixture: `python/fixtures/emotion-profile.v3.json`. v2 fixture(`emotion-scripts.v2.json`)는
  시나리오 메타데이터이며 **자동 승격하지 않는다** — 서로 다른 종류의 기록이다.

### 5.4 출처 등급과 golden 자격

`provenance.source_kind` ∈ {`clean_speech`, `separated_stem`, `unknown`}(호출부가 선언하고
분석기가 추측하지 않는다). `quality_baseline_eligible` 은 다음일 때만 참이다.

- `clean_speech` 로 선언됐고,
- 배경음·잔향 의심(`BACKGROUND_OR_REVERB_POSSIBLE`)·낮은 유성 비율 경고가 없다.

**음악에서 분리한 보컬 stem 은 감정 품질 기준 자료가 되지 못한다.** 반주가 남긴 잔향이
연기로 측정되기 때문이다. 자격이 없다고 못 쓰는 것은 아니다 — 결정성·스키마 검증에는
그대로 쓴다. 막는 것은 "이것이 그 감정의 표준이다"라는 말뿐이다.
**자동 dereverb·denoise·정규화로 자격을 만들지 않는다.**

---

## 6. 참조 선택 계층 (2026-09-03 구현)

권위: `python/speaker_refs.py`. 화면 거울: `src/shared/speakerReference.ts`.

### 6.1 확정된 우선순위는 바뀌지 않았다

1. `(화자, 감정)` 전용 참조 → 2. 그 화자의 기본 참조 → 3. **화자 표기가 없는 대본에서만**
기존 감정별 참조 → 4. 전역 기본 참조.

바뀐 것은 **2번 안쪽**뿐이다. `(화자, 감정)` 전용 참조가 없을 때, 이전에는 화자 기본 참조로
곧장 갔지만 이제는 **그 화자가 가진 클립들 중** 요청 감정 프로필에 가장 가까운 것을 고른다.

후보 목록은 화자별로 만들어진다. 다른 화자의 클립은 점수가 아무리 높아도 **목록에 오르지
않는다** — 점수를 매긴 뒤 걸러내는 구조가 아니다.

### 6.2 자동 선택 기준값 — `provisional`

- 유사도 = `1/(1+거리)`. 거리는 축별 척도로 나눈 값(F0·궤적 3.0 반음, 에너지 4.0 dB,
  리듬 0.30 속도비).
- 가중치: `relative_f0` 0.35 · `trajectory` 0.30 · `relative_energy` 0.15 ·
  `pause_tail` 0.15 · `rhythm` 0.05. `approximate` 축은 ×0.25.
- 비교 가능한 축만 배점에 들어간다. 못 잰 축은 0점이 아니라 **제외**된다.
- 최소 점수 `EMOTION_MATCH_MIN_SCORE = 0.55` — 거리 0.818, F0 축 환산 약 **2.5 반음** RMS.

**이 값은 `provisional` 이다.** 라벨된 감정 코퍼스가 없어 측정으로 교정한 적이 없고, 지금
하는 일은 "그보다 벌어진 후보를 감정에 맞다고 말하지 않는다"는 보수적 차단뿐이다.
실측 교정 전까지 이 숫자를 정답 기준처럼 표시하지 않는다.

### 6.3 GPU 없이 검증된 것 — nuisance invariance

±12 dB gain 변화와 절대 음역 이동에도 **같은 후보가 선택**됐다.

이것이 증명하는 것은 딱 하나다. **녹음 볼륨과 절대 음역이 달라졌다는 이유만으로 선택
결과가 쉽게 바뀌지는 않는다.** 이것을 근거로 "말투를 정확히 보고 고른다"거나 "감정을 정확히
판정한다"고 말하지 않는다. 그 주장에는 라벨된 자료와 청취 판정이 필요하며(§10, §14) 아직
없다.

### 6.4 후보가 부족할 때

| 상황 | 상태 | 실제 동작 |
|---|---|---|
| 쓸 수 있는 후보 0 | — | **생성 전 차단**(`SPEAKER_REFERENCE_NOT_READY`). 전역 기본 목소리로 대체하지 않는다 |
| 후보 1 | `insufficient_candidates` | 그 참조를 쓰되 **최적이라 말하지 않는다.** `reference_matched` 거짓 |
| 문턱 미달 | `no_reliable_candidate` | 화자 기본 참조로 간다. 성공으로 적지 않는다 |
| 기준 프로필 없음 | `no_target_profile` | 같음 |
| 후보 프로필 측정 실패 | `no_reliable_candidate` / `NO_CANDIDATE_PROFILE` | 같음. 실패 개수를 센다 |
| 미등록 화자 | — | **생성 전 차단**(`SPEAKER_NOT_REGISTERED`) |
| 사용자가 직접 지정 | `explicit` | 점수와 겨루게 하지 않는다 |

---

## 7. 모델 capability — 2026-09-03 read-only 감사

GPU·모델 로딩·다운로드 없이 디스크에 있는 것만 읽었다. 권위: `python/expressive_capability.py` §8.

### 7.1 결론

**지금 이 컴퓨터에 모델이 감정을 직접 받는 통로는 없다.**

이 계열에서 **목소리 복제는 Base 만** 되고 **감정 지시는 Base 만 안 된다.** 둘이 겹치는
변종이 없다. 그래서 "복제 + 감정 지시 동시"는 모든 행에서 `unsupported` 다.

### 7.2 설치된 1.7B 의 정확한 정체

`externals/qwen3_tts_1_7b_base/config.json` 실측:

- `tts_model_size: "1b7"`, **`tts_model_type: "base"`** → **Qwen3-TTS-12Hz-1.7B-Base**
- `speaker_encoder_config.enc_dim: 2048`(0.6B 는 1024), `spk_id: {}`(preset 화자 0개)

즉 **CustomVoice 도 VoiceDesign 도 아니다.** 1.7B Base 가 주는 것은 더 큰 복제 모델이지
instruction 감정 제어가 아니다. 공식 모델 카드의 Instruction Control 칸이 **Base 행에서만
비어 있고** 1.7B CustomVoice·VoiceDesign 행에만 ✅ 가 있다.

**모델 크기가 커졌다는 이유로 감정 제어가 가능하다고 표현하거나 연결하지 않는다.**

감사 표에서 1.7B Base 의 `emotion_instruction_text` 는 `unknown`(`PARAMETER_REACHABLE_UNTESTED`)
으로 적혀 있다. 이것은 "인자가 물리적으로 모델까지 닿는다"는 배선 사실만 뜻하며 **감정 제어가
될지도 모른다는 뜻이 아니다.** vendor 모델 카드가 Base 의 지시 제어를 선언하지 않았으므로,
capability 계약 규칙 2("엔진이 스스로 unsupported 라고 선언하면 믿는다")를 엄격히 적용하면
`unsupported` 가 맞다. **이 한 칸의 확정은 결정 대기 항목이다(§11).**

### 7.3 축별 판정

두 Base 스냅샷 공통:

- 연속 감정 세기 / F0 곡선 입력 / 길이·쉼 제어 → **`unsupported`(인자 자체가 없다)**
- 참조 기반 표현 전달 → `unknown`(기전은 있고 효과는 미측정)
- 복제 + 감정 지시 동시 → `unsupported`

표 어디에도 `supported` 가 없다. 프로브 없이 supported 를 적을 수 있는 경로를 만들지 않았다.

### 7.4 1.7B Base 가 연결되지 않는 이유

필수 파일 6종이 모두 있다. 연결되지 않는 것은 자산 문제가 아니라 **배선 문제**다 —
`tts_worker._QWEN_SNAPSHOT` 이 0.6B 스냅샷 경로에 고정돼 있다. 다만 연결한다고 감정 제어가
생기지는 않는다(§7.2). 연결의 이유가 있다면 **복제 품질**이지 감정이 아니다.

연결 시 함께 봐야 할 것: 무응답 계약 280초와 chunk 예산 비율은 **0.6B 실측에 묶여 있다.**

### 7.5 비교표

| 항목 | Qwen 0.6B Base | Qwen 1.7B Base | Qwen 1.7B CustomVoice / VoiceDesign | CosyVoice 3 0.5B | IndexTTS-2.5 |
|---|---|---|---|---|---|
| 설치 | 설치·연결됨 | **설치·미연결** | 미설치 | 미설치 | 미설치 |
| 한국어 | 지원 | 지원 | 지원 | **지원** | **미지원** |
| 사용자 음성 복제 | 3초 제로샷 | 3초 제로샷 | **불가**(preset 9종 / 설계 음색) | 제로샷·교차언어 | 단일 참조 제로샷 |
| 감정 instruction | **없음**(vendor 선언) | **없음**(vendor 선언) | 있음(자연어) | 있음(instruction token: 감정·속도·볼륨) | 있음(감정 오디오·8차원 벡터·설명·강도) |
| 복제 + 감정 동시 | 불가 | 불가 | 불가(복제 없음) | **가능하다고 선언됨(미검증)** | 가능하나 한국어 없음 |
| 디스크 | 2.51 GB(실측) | 4.54 GB(실측) | 미확인(1.7B급 추정 ≈4.5 GB) | 약 9.75 GB(문서) | 약 5.49 GB(문서) |
| VRAM | peak 약 2,569 MiB 실측 / 게이트 4,000 MB | **추정** 약 4.6 GB / 게이트 6 GB 권장 | 미확인 | 미확인 | 미확인 |
| 라이선스 | Apache-2.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 | bilibili Model Use License |
| 앱 통합 비용 | 0(현행) | 경로 상수 1곳 + watchdog·예산 재검토 | 다운로드 + **다화자 복제 상실** | 별도 venv·worker·adapter(가장 큼) | 한국어 부재로 제품 경로 불가 |

VRAM 추정의 근거는 하나뿐이다 — 0.6B 실측 peak 와 가중치 크기 비(1.81배). 재본 적 없는
값이며 측정으로 대체해야 한다.

---

## 8. UI 원칙 — 자동 선택을 정답처럼 보이지 않게 한다

문구 권위: `src/shared/analysisWording.ts`.

구현됨:

- 기본 화면은 `감정에 맞는 참조 선택` / `감정 참조 자료 부족` 한 줄뿐이고 숫자가 없다.
- 점수·유사도·축별 값은 **상세 정보에만** 둔다.
- `현재 모델은 감정 곡선 직접 제어를 지원하지 않음` 을 상태와 무관하게 상세 정보에 항상 적는다.
- "적용 완료" 류 문구는 테스트로 금지했다.
- 후보가 하나뿐이면 최적 후보라고 표현하지 않는다.
- 깨끗한 동일 화자 감정 자료가 없으면 `감정 참조 자료 부족` 으로 말한다.

설계로 확정하되 **아직 구현하지 않은 것**(§11 결정 대기):

- **선택된 참조를 사용자가 확인할 수 있어야 한다** — 어떤 클립이 골라졌는지 이름·재생으로.
- **사용자가 다른 후보로 바꿀 수 있어야 한다** — 자동 선택은 제안이고 최종 권위가 아니다.
- 기준값이 `provisional` 이라는 사실이 화면에서 읽혀야 한다(정답 점수처럼 보이지 않게).

---

## 9. 적용 통로 — 네 갈래

세 갈래가 아니다. 기존 조사 문서의 대체 엔진 후보를 포함해 넷이다.

1. **같은 화자의 감정별 reference matching** — 현재 구현된 것. 상한은 "더 맞는 클립을
   고른다"이며 없는 연기를 만들지 못한다. 전제는 깨끗한 감정별 자료(§10).
2. **제한적인 F0 / duration / pause 후처리** — 효과는 크지만 음색 동일성·품질 위험이 있다.
   **청취 승인 전 production 연결 금지**(현 상태). 원문 §8 "DSP 의 위치"가 그대로 적용된다 —
   DSP 는 이미 감정이 실린 참조를 따라가게 돕는 보조 수단이지 감정의 출처가 아니다.
3. **현재 Base 모델의 감정 자료 추가 학습(파인튜닝)** — vendor 가 Base 를 FT 용도로 명시한다.
   기존 조사(3.1 §2)는 커뮤니티 답변을 인용해 결과가 "mediocre at best" 라고 기록했다.
   자료·시간이 가장 많이 든다.
4. **복제와 감정 instruction 을 함께 지원하는 별도 엔진의 격리 PoC** — 기존 조사에서
   **CosyVoice 3** 가 한국어·제로샷 복제·instruction 을 동시에 선언한 1순위 후보다.
   IndexTTS-2.5 는 감정 제어 구조가 가장 명확하지만 **한국어 미지원**이라 제품 경로가 아니라
   연구 PoC 다. PoC 는 별도 venv·worker 로 격리하고, 공용 plan 을 유지한 채 adapter 로
   비교한다(`script-scene-architecture §12`). 새 가중치를 자동 다운로드하거나 라이선스를
   자동 동의하지 않는다.

네 갈래 모두 **깨끗한 감정 자료**를 전제로 하거나 그것으로 검증된다. 그래서 §10 이 먼저다.

---

## 10. clean dataset 구성 — reference matching 을 실제 감정 선택으로 교정하려면

지금 부족한 것은 알고리즘이 아니라 **자료**다. 아래는 기존 평가 절차(3.1 §5, 3.6 원칙 2·5)를
현재 구현에 맞춘 요건이다.

**자료 조건**

- 음악에서 분리한 보컬 stem 제외(§5.4). `source_kind = clean_speech` 로 선언 가능해야 한다.
- 잔향·배경음 경고가 붙지 않는 녹음. 자동 dereverb·denoise·정규화로 만들지 않는다.
- 한 화자 안에서 **같은 녹음 조건**(마이크·거리·게인). 조건이 섞이면 nuisance 가 감정으로 측정된다.
- 클립 길이 3~10초(현행 참조 정책과 동일).

**구성**

- **중립 앵커 필수** — 화자마다 감정 없는 같은 대사 1개 이상. 모든 비교의 원점이다.
- **같은 대사**로 감정만 다르게 녹음한 집합(모델·기준값 비교용).
- 감정별 실사용 예문은 **별도 집합**으로 둔다(대사 내용이 감정 판단에 힌트를 주므로 비교용과 섞지 않는다).
- 화자 최소 2명 — 한 사람의 버릇을 감정으로 착각하지 않기 위해.
- 감정 최소 4종(기쁨·슬픔·화남·차분함) — 기존 평가표와 같은 축.
- 감정당 클립 **2개 이상**(후보 비교가 성립하는 최소치), 교정에는 3개 이상 권장.
- 최소 규모 예: 화자 2 × 감정 4 × 클립 3 = 24 + 중립 앵커 2 = **26 클립**.
  이것은 **작동 확인의 최소치이지 통계적 근거가 아니다.**

**라벨과 판정**

- 감정 라벨은 **사람이 붙인다.** 자동 분류로 라벨을 만들지 않는다(그 자체가 검증 대상이다).
- 블라인드 강제 선택 청취로 정답률을 얻고, 그 결과로만 `EMOTION_MATCH_MIN_SCORE` 를 교정한다.
- 유사도 / 자연스러움 / 감정 전달을 **섞지 않고 따로** 채점한다(3.1 §5.1).
- 원본과 파생물은 승인된 경로에만 두고 Git 에 추적하지 않는다.

---

## 11. 남은 결정 (production 적용 방식은 아직 정하지 않는다)

1. 1.7B Base 의 `emotion_instruction_text` 를 `unknown` 으로 둘지 `unsupported` 로 확정할지(§7.2).
2. 사용자 후보 확인·교체 UI 를 언제 구현할지(§8).
3. §9 네 갈래 중 무엇을 먼저 할지. **현재 권장 순서는 §10 자료 확보 → 기준값 교정 → 4번 PoC** 다.
4. 1.7B Base 연결 여부(감정과 무관하며 복제 품질 사안, watchdog·예산 재검토 동반).

---

## 12. 기준선 (2026-09-03)

- `origin/master` = `46949b7b2d360e754ff74b7d7eb9133d41f88123` — 정식 v1.3.0
- `origin/develop` = `8d9a205343cf139d236ed7590a133d29656fcf67` — v1.4.0-dev
- master 병합 보류 중.

과거 문서의 SHA(`ca42b0e`, `0788885`, `734dd00`, `38e6072`, `fa0e907`, `4b64947`, `1c1e630` 등)는
**그 시점의 역사적 근거**이며 현재 상태가 아니다. 지우지 않고 그대로 둔다.

---

## 13. 중복 설계가 생기지 않았다는 확인

- 감정 음향 판정 어휘는 `expressive_capability.CAPABILITY_STATES` 하나뿐이다. 병렬 상태표를
  만들지 않았다.
- v3 프로필은 새 분석기가 아니라 `emotion_acoustic` §8 확장이고, F0·RMS 추출은
  `onset_continuity_metrics` 를 그대로 쓴다. 무음 판정 문턱도 기존 `SILENCE_REL_THRESHOLD` 다.
- 참조 선택은 새 모듈이 아니라 기존 `ReferenceTable` 에 메서드를 얹은 것이다. `resolve()` 의
  동작은 한 글자도 바뀌지 않았고 테스트가 그 사실을 고정한다.
- 기록은 새 recorder 없이 기존 `chunk_publish` 의 chunk 행·헤더에 필드를 얹었다.
- 모델 capability 표는 새 모듈이 아니라 `expressive_capability` §8 이다.
- 새 parser·새 planner·새 IPC 를 만들지 않았다.
- 이 문서가 감정·음률의 단일 권위이며, 다른 문서는 링크만 둔다.

---

## 14. 사용자 청취가 최종 권위 (변경 없음)

- F0·에너지·유사도 점수는 **보조 지표**다. `기쁨 85점` 처럼 감정 정답으로 표시하지 않는다.
- 청취 판정은 판정 코드(`…_USER_PASS` / `…_FAIL`)로 run bundle id 와 이어 기록한다.
- 청취 없이 품질 PASS 를 선언하지 않는다. 지표가 좋아도 마찬가지다.
- 2026-09-02 다화자 4발화 청취는 **`safe_xvector` 화자 구분 PASS** 이며 감정 판정이 아니다.

---

## 부록 A — 2026-08-28 원문 보존: 왜 감정 차이가 약한가 (측정)

같은 참조 클립 하나로 기쁨·화남·슬픔 3종을 생성한 실측:

- F0 변동폭(`f0_std_semitones`): 기쁨 4.285 / 화남 4.098 / 슬픔 4.090 / 참조 4.207 반음.
  **세 감정이 사실상 같다.** 최대 차이 0.195 반음으로 분석 해상도 `PROSODY_FLAT_SEMITONES`
  (0.5 반음)에도 못 미친다.
- F0 범위: 10.148 ~ 11.352 반음(참조 11.026).
- 중앙 F0: 기쁨 226.4 / 화남 269.7 / 슬픔 250.0 Hz(참조 266.7 Hz). **기쁨이 가장 낮다** —
  통념과 반대 방향이며, 감정 제어의 결과가 아니라 생성 편차로 보는 편이 사실에 가깝다.

사용자는 이 3종을 듣고 "감정 차이가 약하다"고 확정했다. 측정이 그 판단과 같은 방향이다.

원인(코드 감사에서 확정, 현재도 유효):

- voice clone 경로에 감정·스타일 instruct 인자가 **없다**.
- `instruct` 는 `generate_voice_design` / `generate_custom_voice` 에만 있고 두 함수 모두
  `tts_model_type` 게이트에서 Base 를 거부한다.
- tokenizer 에 감정·비언어·운율 토큰이 **0개**이고 SSML 유사 입력도 없다.
- `ref_text` 에 지시문을 섞는 것은 구조적으로 금지된다(ICL 정렬이 위치별 덧셈이라 깨진다).
- 따라서 감정은 **참조 클립 교체로만** 실현된다. 같은 참조를 쓰면 모델 입력이 완전히
  동일하므로 감정 차이가 나올 통로 자체가 없다.

## 부록 B — 2026-08-28 원문 보존: `instruct_ids` probe

- `generate_voice_clone(..., **kwargs)` → `_merge_generate_kwargs` 는 `dict(kwargs)` 로 시작해
  알려진 샘플링 인자만 덮어쓴다. 모르는 키는 **그대로 통과**한다.
- `Qwen3TTSForConditionalGeneration.generate` 시그니처에 `instruct_ids` 가 실제로 있고,
  `instruct_id is not None` 이면 talker 입력 임베드 앞에 붙인다.
- 즉 **코드 경로만 보면 수용될 자리는 있다.** 런타임 관측은 없다 — accepted 미확인.
- 그러나 `generate_custom_voice` 에 `if self.model.tts_model_size in "0b6": instruct = None`
  (`# for 0b6 model, instruct is not supported`)가 있다. 선언의 대상은 경로가 아니라 **모델 크기**다.
- 따라서 `emotion_instruction_text` claim 은 0.6B 에서 `unsupported` 다. probe 는 숨은 실험으로만
  유지하고 production·UI 에서 활성화하지 않는다. accepted 를 관측해도 honored 로 승격되지 않는다.

## 부록 C — 2026-08-28 원문 보존: 참조 배치·분리도·추종도 계약

권위: `python/emotion_acoustic.py` §1~§7. TS 거울: `src/shared/emotionAcoustic.ts`.

- **role**: `distinct` / `shared_default` / `absent` — 판정이 아니라 "어떤 파일이 들어가는가"라는 사실.
- **분리도**: 반음 단위 축 4개(중앙 F0 오프셋·범위 차·IQR 차·변동폭 차)로만 판정한다. 기준은
  기존 `PROSODY_FLAT_SEMITONES`(0.5 반음)이며 새로 지어낸 감정 문턱이 아니다. dB·ms·자/초
  축은 **기록만 하고 판정에 쓰지 않는다** — 그 단위에는 계약된 해상도가 없다.
- **추종도**: 두 참조를 가장 크게 가른 축 하나에서, 기본 참조를 원점으로 `감정참조 - 기본참조`와
  `생성결과 - 기본참조`를 잰다. 부호가 같고 크기가 해상도 이상일 때만 `followed = 1`.
  이것이 honored 의 유일한 근거다.
- **supported 로 가는 길은 하나뿐**이다: `distinct` + 구별됨 + 결과가 따라감. 그 길은 실제 생성
  결과를 측정해야만 열린다. 오늘도 그 측정은 없다.
- **고정 프리셋 숫자를 만들지 않는다.** "기쁨은 F0 +2 반음" 같은 표는 이 저장소 어디에도 없다.

## 부록 D — 2026-08-28 원문 보존: 지금도 미지원인 것

- **웃음** — 모델 native 지원 없음. `LAUGH_NO_STRATEGY` 유지. 실제 웃음 클립이나 비언어 생성
  모델 없이 "지원"으로 승격하지 않는다.
- **경악·비명 등 강한 비언어** — 같은 이유로 전략 없음.
- **모델 native 감정 지시** — 부록 B.
- **동일 참조에서의 감정 분화** — 통로가 없다. DSP 로 메울 수 있는 종류의 결핍이 아니다.

### DSP 의 위치

F0 contour / energy contour / tempo / tail decay / pause 는 다룰 수 있다. 그러나 고정 프리셋
숫자를 지어내지 않고 감정별 참조 샘플에서 뽑은 값만 쓴다. **DSP 만으로 웃음·경악·진짜 감정을
구현했다고 표현하는 것은 금지한다.**
