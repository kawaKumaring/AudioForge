# 긴 글 말투 안정 — 조각별 seed 정책 비교 (2026-10-09, 종료: 현행 유지)

> **최종 결론(관리자 결정 2026-10-09)** — 제품의 조각별 seed 정책(조각 k = s + k)을 유지한다. 같은 seed 정책(AUDIOFORGE_DIAG_SEED_POLICY=same)은 실험 기록으로만 남긴다(기본 꺼짐).
> - 현행 3개: 사용자 청취상 일정함. 같은 seed 3개: 2개 일정, 1개 첫 이음 뒤 톤 변화(쌍1, seed 101).
> - 전반적인 음성 품질은 높게 들린다는 사용자 평가.
> - 제한된 조건(참조 1개·글 1개·seed 3개)에서 변경 이점을 확인하지 못해 현행 유지. 같은 seed 가 나쁘다고 확정한 것도 아니다.
> - 발음·누락·반복·이음 자연스러움의 별도 품질 합격으로 확대하지 않는다(답변 없음).
> - 근거: 사용자청취판정.json(청취 원문·정답표 정책·조각별 applied_seed·음원 지문·이음 시각), 정답표.json, record-check.json, 각 실행 기록 manifest. 순서상 한계 — 세 쌍 모두 A(첫째)가 현행이었다(무작위 배치가 1/8 확률로 한쪽에 몰림).
> - 이번 자료는 다시 섞거나 추가 생성하지 않는다. 참조 방식 비교는 자동으로 시작하지 않는다.
> - 아래 본문의 "승인 대상"·"생성 전" 표현은 작성 당시 기록이다.

목표: 긴 글에서 목소리·말투가 조각 사이에 안정적으로 이어지게 하는 것. 이번 비교는 **변수 하나(조각별 seed 정책)** 만 바꾼다. 같은 seed 가 안정성을 보장한다고 가정하지 않는다. 참조 방식(x-vector/ICL) 변경은 이 비교와 섞지 않는다.

## 현재 코드의 실제 seed 결정 (코드 확인)
- 실행 seed: python/tts_worker.py `_pick_run_seed()` — 환경변수 AUDIOFORGE_TTS_SEED 가 있으면 그 값(seed_source=env), 없으면 실행마다 무작위(random_per_run). `_synthesize_qwen_job` 이 이 값을 브리지에 넘긴다(qwen.run_job(..., seed=run_seed)).
- 조각별 seed: python/qwen_bridge.py `_generate_plan` → `_seed_rng(seed, completed)` = **(실행 seed + 그 실행에서 완료한 조각 순번) mod (2^31−1)** 로 조각마다 torch·cuda RNG 를 다시 심는다. 순번은 발화가 바뀌어도 이어서 센다. 즉 3조각이면 s, s+1, s+2.
- 참조 조건: safe_xvector 이면 참조 음성의 화자 특징(x-vector)만 쓰고 참조 전사·억양 예시는 쓰지 않는다. 같은 발화의 조각은 모두 같은 참조(ReferenceTable 의 라우팅 스냅샷)를 쓴다. 조각 사이에 앞 조각 음성·문맥을 넘기지 않는다.
- 낭독 Qwen 지정 목소리(상주 실행기)는 seed 0 고정이라 이번 비교와 무관 — 이번 비교는 배치 경로(참조 목소리·카드)만.

## 비교 조건
- 바꾸는 것(하나): 조각별 seed 정책
  - A(현행): 조각 k = s + k
  - B(같은 seed): 모든 조각 = s
  - B 를 만들려면 진단 전용 스위치가 필요하다: 환경변수 `AUDIOFORGE_DIAG_SEED_POLICY=same` 일 때만 `_seed_rng(seed, 0)`. 기본값·제품 동작은 그대로(A). 실행 기록 머리에 정책을 남긴다. (승인 후 구현 — 코드 3~5줄 + 단위 검사 1건)
- 같게 두는 것: 글 · 참조 파일 · 분할(자동 분할 결과가 실행마다 같은지 기록으로 확인) · 모델(Qwen3-TTS 0.6B Base, revision 5d83992…) · 장치(cuda:0) · 참조 방식(safe_xvector) · 속도/음높이/쉼/말끝 설정 · 서수 보정 경로(이 글에는 숫자 없음) · 실행 seed(쌍마다 같은 s).
- 글·참조(결정 필요):
  - 권장: 9/25 장문과 같은 글(728자, 숫자·줄바꿈 없음 — 성능 측정용으로 만든 글)과 같은 참조(_local/experiments/longform-2026-09-25/bench-reference.wav, 3.95초, sha 31203178…). 사용자가 이미 들은 표본과 직접 이어진다. 이 참조 파일을 이번 생성에 다시 쓰는 것에 대한 승인이 필요하다.
  - 대안: 승인된 참조 조각(_local/perf-ref/ref-clip.wav, sha b51c8648…)과 같은 글. 9/25 표본과 직접 비교는 어렵다.
- 실행 seed: 3개(101, 202, 303) — 한 seed 결과로 일반화하지 않기 위해.
- 파일 수: 3 seed × 2 정책 = **6개**(각 약 90초). 다시 뽑아 고르지 않는다.
- 실행 방식: 매 생성 새 프로세스(상주 실행기 없음), 순차, GPU 여유 확인 후. 조각 원시 음원 보존(AUDIOFORGE_DIAG_CHUNK_STAGES=1 — 조각별 모델 반환 음원·이음 미리듣기 저장).

## 내장 점검(같은 생성으로 함께 확인 — 별도 시험 없음)
- 같은 s 의 A·B 쌍에서 첫 조각은 둘 다 seed s 다. 첫 조각 모델 반환 음원 지문이 같으면 이 조건에서 생성이 결정적이라는 근거, 다르면 seed 밖의 요인(초기 상태 등)이 섞인다는 뜻 — 그 경우 비교 해석을 제한한다.
- 실제 실행 기록에 다음이 정상 기록되는지: 조각별 applied_seed(A: s,s+1,s+2 / B: s,s,s), returned_wav_sha256, source_char_range(보정 후 발화문 기준), joins(basis=final_placement_rows, 간격·겹침), placement_check(마지막 조각 끝 표본 vs 결과 파일 표본 수), 실행 머리의 seed·seed_source·정책.

## 청취·판정
- 비교 페이지: seed 마다 두 파일을 이름 없이 X/Y 로(쌍마다 순서 섞음, 정답표는 따로 파일). 이음 위치 버튼은 실제 기록된 이음 표본에서.
- 묻는 것: 말투·목소리가 조각 사이에서 바뀌는가, 어디서. 자동 지표(화자 유사도 등)는 이번에 넣지 않는다 — 청취가 기준.
- 판정은 사용자 청취 원문을 파일 지문에 연결해 보존. 미보고 항목은 합격 처리하지 않는다.

## 예상 소요
- 9/25 같은 글의 생성(run_job)이 372초였다(당시 빌드, GPU). 파일당 약 4~7분(모델 적재 포함), 6개 순차 **약 25~45분**. GPU 를 다른 프로그램이 쓰면 늘어난다.

## 이번에 하지 않는 것
- 참조 방식(ICL) 비교, 조각 사이 문맥 연결, 분할 크기 변경 — 이 비교의 결과를 본 뒤 하나씩.
- 검수 도구 확장(색인·정밀 시간 정렬·원문 위치 연결).

## 실행 결과(2026-10-09, 관리자 승인 실행) — 사람 청취 대기
### 실행
- 기준 seed 101·202·303(생성 전 plan.json 에 고정) × per_chunk/same = 6개, 6/6 성공. 파일당 41~50초(새 프로세스·cuda:0) — 예상(4~7분)보다 훨씬 빨랐다(9/25 는 당시 빌드). 다시 뽑지 않음, 길이·음량·속도 보정 없음, 제품 기본 seed 정책 불변.
- 참조: 이미 재사용 승인된 참조 조각(ref-clip.wav, b51c8648…). 9/25 참조(bench-reference)는 승인 기록을 확인하지 못해 쓰지 않았다. 글: 9/25 장문과 같은 측정용 글(728자).
- 길이: per_chunk 90.28/89.40/87.56초, same 87.96/86.52/91.80초. 모든 조각 상한 전 종료.
### 기록 확인(실제 생성에서)
- 조각별 실제 seed: per_chunk = s, s+1, s+2 / same = s, s, s — 6개 모두 기대대로 [기록].
- 분할·전달문: 6개 모두 3조각(0-244, 244-537, 537-728), 조각 전달문 지문 동일(82ba…/1e3c…/78ec…) — 9/25 장문의 분할과도 같은 지문. 조각 전달문의 저장 지문 = 본문 지문.
- 조각 음원 지문(returned_wav_sha256)·조각 음원 보존(vendor_returned.wav)·이음(basis=final_placement_rows, 간격·겹침 0)·결과 길이 대조(마지막 조각 뒤 2880표본 = 말끝 여백 120ms) 모두 기록됨.
- 결함 하나 발견·수정: 실행 머리에 seed_policy 가 빠졌다(머리 항목 허용 목록에 없었음). 생성 뒤 허용 목록 두 곳에 추가했다 — 이번 6개 기록에는 없고, 정책은 조각별 applied_seed 와 plan.json 으로 확인된다.
### 재현성
- 같은 기준 seed 쌍의 첫 조각(두 정책 모두 seed s) 음원 지문: 3쌍 모두 **같다**(362bce11…, 286c3010…, c56afec4…). 이 조건(새 프로세스·같은 장치·같은 설정)에서 첫 조각 생성은 재현됐다. 둘째·셋째 조각의 차이는 seed 가 다른 것과 함께 나타나지만, 이것만으로 말투 차이의 원인을 seed 정책으로 단정하지 않는다.
### 청취(대기)
- 정책 이름을 숨긴 3쌍(X/Y 는 쌍마다 무작위): E:AI_ProjectclaudeCodeVsCodeappsdevelopmentAudioForge_af_worktreesdevelop-run_locallisteninglongform-seed-20261009083328비교듣기.html — 전체 재생, 각 결과의 실제 이음 앞 5초·이음에서·앞뒤 5초 반복.
- 듣는 파일(원본과 바이트가 같은 사본, 이름에 정책 없음): E:AI_ProjectclaudeCodeVsCodeappsdevelopmentAudioForge_af_worktreesdevelop-run_locallisteninglongform-seed-20261009083328듣기 · 경로 목록 E:AI_ProjectclaudeCodeVsCodeappsdevelopmentAudioForge_af_worktreesdevelop-run_locallisteninglongform-seed-20261009083328청취파일경로.txt · 정답표(청취 뒤) E:AI_ProjectclaudeCodeVsCodeappsdevelopmentAudioForge_af_worktreesdevelop-run_locallisteninglongform-seed-20261009083328정답표.json · 기록 대조 E:AI_ProjectclaudeCodeVsCodeappsdevelopmentAudioForge_af_worktreesdevelop-run_locallisteninglongform-seed-20261009083328ecord-check.json
- 평가: 목소리 유지 · 말투 변화(어디쯤) · 이음 자연스러움 · 발음·누락·반복. 같은 seed 가 낫다고 전제하지 않는다.

## 사용자 청취 판정·정답 대조(2026-10-09)
- 표기: 사용자 판정의 A/B = 페이지 X/Y(쌍의 첫째/둘째).
- 정답 대조: 정답표의 정책과 실행 기록의 조각별 applied_seed 로 따로 확인 — 6개 모두 일치. 세 쌍 모두 A(X) = per_chunk(현행: s, s+1, s+2), B(Y) = same(s, s, s). 청취 사본·원본 지문 일치.
- **쌍1 B 는 same 정책**(모든 조각 seed 101)이다.
- 청취 원문:
  - 쌍1 A(per_chunk): "일정한 것 같다."
  - 쌍1 B(same): "첫 이음 뒤 목소리 톤이 약간 달라진다. 명랑하게 바뀐 느낌이다." — 첫 이음은 28.48초. 쌍1 A·B 의 첫 조각(0~28.48초)은 음원 지문이 같고, 차이는 둘째 조각부터다 [기록].
  - 쌍2·쌍3 A/B: "모두 일정한 것 같다."
  - 전체: "대부분 음성의 퀄리티가 높게 들린다."
- 판정 범위: 말투 일관성 5개 긍정 · 1개 변화 관찰(same 정책 1개). 품질은 긍정적 인상. 발음·누락·반복·이음 자연스러움은 별도 답변이 없어 합격 처리하지 않는다.
- 한계: 참조 1개·글 1개·seed 3개. 무작위 X/Y 배치가 우연히 세 쌍 모두 X=per_chunk(1/8 확률)여서 순서 단서가 생길 수 있었다. 한 쌍의 차이로 정책의 일반적 우위를 확정하지 않는다.
- 제안: **현행(per_chunk) 유지.** 근거 — 변화가 관찰된 1개는 same 정책 쪽이었고, 현행 3개는 모두 일정하다고 들렸다. 같은 seed 로 바꿀 근거는 없다. 반대로 현행이 낫다고 확정할 근거도 약하다(차이 1건). 진단 스위치는 기본 꺼짐으로 남긴다.
- 기록: E:AI_ProjectclaudeCodeVsCodeappsdevelopmentAudioForge_af_worktreesdevelop-run_locallisteninglongform-seed-20261009083328사용자청취판정.json (쌍마다 사용자 원문·정책(정답표/기록)·실제 seed·음원 지문·이음 시각)
