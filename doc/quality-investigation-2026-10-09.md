# 품질 조사 — 비교 원문 연결 오류 · 긴 글 말투 변화 (2026-10-09)

새 음성 생성·반복 시험 없이 기존 실행 기록·검수 스크립트·코드만으로 조사했다. 근거 표시: [기록] 실행 기록으로 확인 · [코드] 코드로 확인 · [가설] 미확인.
상세 조사 기록(로컬): _local/integ-2026-10-09/last-sentence-investigation.md · audit-link-investigation.md · longform-tone-investigation.md

## 1. before-chunk3 판정 철회 — 범위
- 그 표본 하나의 "마지막 문장 누락" 판정만 철회한다. 해당 문장은 그 실행의 실제 입력(105자)에 없었다 [기록]. 프로그램 전체에 누락 결함이 없다는 뜻이 아니다.
- 같은 측정의 before-chunk0~2 는 실행 기록의 원문 지문(raw_text_sha256)이 검수 기대 대사와 **일치**했다 [기록] — 그 비교들과 청취 판정 04(추가 음절)는 유효하다. 무효는 before-chunk3 의 기대 대사 대조(CER·누락 결론)뿐이다.

## 2. 비교 원문을 잘못 연결한 원인
- [코드] 검수 스크립트가 기대 대사를 실행 기록이 아니라 **덩이 번호**로 꺼냈다: _local/quality-audit-2026-10-04/audit.py:23-24 \`says[f['chunk']]\`, run-mcp.cjs:5 \`text: says[item.chunk]\`, 청취 묶음 package-listening.cjs:8 \`says[3]\`.
- [기록] says.json 은 개선 **후** 코드의 나누기 규칙으로 만든 덩이 목록(37·87·115·115·…)이고, 개선 **전** 실행은 [37, 87, 115, 105] 로 나뉘었다 — 같은 번호가 같은 글이라는 가정이 4번째에서 깨졌다.
- [코드] 측정 스크립트(bench.mjs:338-339)는 출력에 실행 ID 를 남기지 않아, 실행 기록과의 연결 고리가 파일 번호뿐이었다.
- [코드] 기계적 차단 없음:
  - MCP analyze(tools/mcp/quality.cjs)는 넘겨받은 기대 대사를 실행 기록과 대조하지 않는다.
  - compare 는 기대 대사가 같은지(sameExpectedText) 알려 줄 뿐 막지 않는다.
  - crosscheck 는 같은 대사를 요구하지만, 틀린 대사를 양쪽에 똑같이 넣으면 통과한다.
- [기록] 대조에 필요한 재료는 실행 기록에 이미 있다: manifest result.sha256(음원 지문), header.raw_text_sha256(원문 지문), script.private.json(원문), 10-09 이후 sent.private.json(실제 전달문).

### 수정안(구현 전 — 승인 대상)
1. analyze 에 실행 기록 연결 인자: 실행 기록의 result.sha256 이 분석 파일 지문과 같을 때만 받고, 기대 대사를 그 기록의 원문에서 가져온다. 기대 대사를 직접 줬는데 기록 원문 지문과 다르면 거부한다. 보고서에 textSource {종류, 실행 ID, 원문 지문, 전달문 지문, 음원 지문} 을 남긴다.
2. compare: 두 보고서의 기대 대사 지문이 다르면 거부한다. 의도한 차이(intendedDifference)를 적으면 허용하고 그 사유를 결과에 싣는다 — 서수 A/B 처럼 원문이 다른 실험은 계속 가능하다.
3. crosscheck: 지금 규칙(같은 대사) 유지 + 양쪽 textSource 를 함께 보인다.
4. 측정 스크립트: 출력마다 실행 ID·음원 지문을 기록하고, 덩이 번호 대신 그것으로 연결한다.
- 바꿀 파일: tools/mcp/quality.cjs, tools/mcp/quality_text.py, 측정 스크립트. 검사: audio-quality-mcp 에 5건(지문 불일치 거부·textSource·대사 불일치·compare 거부·사유 있으면 허용), test_quality_text 1건 — 합성 시험 음원만 쓴다.

## 3. 긴 글 말투 변화 — 기록으로 확인한 것
- 실행: 본체 _local/artifacts/runs/tts-20260925-180448-c22511cb, 결과 지문 62c223d5… = 청취한 90.24초 파일 [기록].
- 입력: 728자 한 문단(줄바꿈·숫자 없음). 발화 1개를 자동 분할로 3조각(244·293·191자), 모두 마침표 뒤에서 나뉨 [기록].
- 접합: **29.76초, 66.16초** — timeline.json 에 있다(10-04 문서의 "정확한 접합 좌표 없음" 은 틀렸다). 사이 무음·겹침 0. manifest joins(접합 측정)는 비어 있고 조각 음원은 보존되지 않았다 [기록].
- 조건: Qwen3-TTS 0.6B Base(revision 5d839924), cuda:0, 24kHz, 빌드 c2bf9f0, safe_xvector(참조 전사 미사용), 세 조각 모두 같은 3.95초 참조, 감정 default, seed 12345(env), 세 조각 모두 상한 전 종료, 속도·음높이·말끝 변형 없음 [기록]. 조각별 실제 seed 는 기록되지 않았다.
- 10-04 검수의 가장 긴 저에너지 구간(73.44~74.43초)은 조각 2 안이며 접합점이 아니다 [기록].

## 4. 긴 글 말투 변화 — 구조와 미확인 원인
- 말투가 조각마다 달라질 수 있는 구조 [코드]:
  - 조각마다 모델을 따로 부르고 앞 조각의 문맥을 넘기지 않는다(python/qwen_bridge.py).
  - 조각마다 seed+순번으로 다시 심는다.
  - x-vector 전용 조건은 참조의 운율 예시를 모델에 주지 않는다.
- "감정 없는 말투" 와 가장 직접 이어지는 후보는 x-vector 전용 조건이다. 그 조건이 쓰였다는 것은 [기록], 그것이 원인이라는 것은 [가설].
- 해당 없음 [기록]: 감정별 참조 차이, CPU/GPU 전환, 속도·음높이·말끝 후처리.
- 모르는 것:
  - 사용자가 변화를 느낀 시각 — 접합점(29.76·66.16초)과 겹치는지.
  - 조각 사이 F0·에너지·말빠르기·화자 유사도 — 측정한 적이 없다.
  - 빌드 c2bf9f0 의 seed·분할 규칙이 지금과 같은지.

## 5. 개선 방향(근거 순, 구현 전)
1. 진단부터:
   - 실행 기록에 조각별 실제 seed 와 접합 시각을 남긴다(joins·quality-context 를 채움 — 브리지는 이미 실제 seed 를 돌려준다).
   - 조각별 화자 유사도·F0·에너지·말빠르기를 수치로 남긴다.
   - 사용자에게 변화를 느낀 대략의 시각을 한 번 묻는다.
2. 통제 실험(설계만): 같은 대사·참조·모델에서 다음을 비교한다. seed 3개 이상, 조각 원시 음원 보존, 조건 이름을 가린 청취로.
   - 분할: 현행 3조각 / 한 번 호출 / 문장 단위
   - seed: 조각별 순번 / 모두 같은 값
   - 참조 방식: x-vector / ICL(참조 억양 반영)
3. 그 결과에 따라 ICL 기본화·조각 사이 문맥 연결·seed 정책·분할 크기를 정한다.

## 다음 작업 범위(승인 대상)
- A. 검수 도구의 원문 연결 차단(2절 수정안 1~4)과 검사 6건.
- B. 긴 글 진단 기록: 조각별 실제 seed·접합 시각을 실행 기록에 남김. 화자 유사도 등 수치 측정은 기존 90초 파일을 열어야 하므로 파일별 승인이 필요하다.
- 통제 실험(새 생성)은 A·B 와 사용자 시각 확인 뒤에 따로 승인받는다.

## 구현(2026-10-09, 관리자 승인 — 통합 검증 전)
- A. 검수 대사 출처 연결: tools/mcp/quality_source.cjs 새로, quality.cjs(analyze runId·출처 · compare intendedDifference·textRelation), quality_evidence.cjs(crosscheck 출처 표시 · 출처 미확인 보고서의 누락 확정 거부). 사용법은 doc/mcp-audio-quality.md '대사 출처 연결'.
- B. 장문 실행 기록: 조각마다 **보정 후 발화문 안의 위치**(source_char_range, 기준 segment_spoken_text — 서수 보정 등을 거쳐 엔진에 보낸 발화 글 기준이며 **사용자 원문 위치가 아니다**. 원문 위치까지의 연결은 아직 없다)와 그 발화 글 지문, 실제 심은 seed(applied_seed — 브리지가 돌려준 값, 없으면 비움), 엔진이 돌려준 조각 음원 지문(returned_wav_sha256), x-vector 여부·감정. 생성 설정(상한·반복·종료·토큰)은 기존 기록 그대로.
  - 이음(joins)은 진단 WAV 와 무관하게 늘 남긴다 — 실제 배치 행의 표본(left_end/right_start)·앱 간격·겹침(앞 끝이 뒤 시작을 넘은 만큼). placement_check = 마지막 조각 끝 표본과 결과 파일 표본 수(판정은 하지 않음). 배치 기록이 없으면 이음을 만들지 않는다.
  - 과거 기록에 없는 값은 채우지 않는다(예: 9/25 장문의 조각별 seed).
- 장문 청취 준비: _local/listening/longform-joins-2026-10-09/장문이음듣기.html — 원본 그대로(새 합성·보정 없음), 29.76·66.16초 앞 5초/이음/앞뒤 5초 반복, 전체 재생, 경로·지문 표시.
- 준비한 검사(미실행): test/e2e/audio-quality-source.cjs, python/test_run_record_longform.py.

## 코드 검수 보완(2026-10-09 — 통합 검증 전)
1. 판정을 넷으로 분리(tools/mcp/quality_source.cjs): 실행 출처(runVerified) · 원문 저장 지문(rawTextState: verified / stored_sha_missing) · 전달문 근거(sentState: unrecorded / verified / invalid + sentIssues) · 구간 대응(windowAlignment: whole / unaligned).
   - 구간 분석은 대사가 원문에 들어 있어도 '대응 미확인' — 그 시간대의 대사라고 확정하지 않는다.
   - 누락 '확정' 은 출처·원문 확인 + 전체 구간 + 기대 대사가 있을 때만. 아니면 review 가 거부하지 않고 **미확정(uncertain)으로 보존**(requestedVerdict·verdictHeldBecause 함께).
2. compare: rawMatch(원문)와 sentMatch(전달문: 같음/다름/null=한쪽이라도 기록 없음·근거 어긋남)를 따로. 전달문을 확인하지 못하면 same_source_sent_unconfirmed — '같은 전달문' 이라 하지 않는다.
3. 저장된 근거만으로 확인: 원문은 header.raw_text_sha256 와 manifest artifacts 의 파일 지문으로(저장 지문이 없으면 확인 불가 — 새로 계산한 지문으로 대신하지 않음). 전달문은 sent.private.json(파일 지문·문장별 저장 지문·순서) 또는 chunks/*.private.json(manifest chunks[] 대비 누락·중복·순서, 파일 지문, 조각별 저장 지문)으로 사유를 나눠 표시.
4. 글자 범위는 '보정 후 발화문 내부 위치' 로 문서·기록 이름(source_char_basis=segment_spoken_text)에 명시. 원문 위치 연결은 남은 과제.

### 마지막 보완(근거 손상 시 정상 판정 차단)
- 전달문 기록 없음(unrecorded → same_source_sent_unrecorded, 정상)과 근거 손상(invalid → evidence_invalid, normal=false)을 분리. 손상이면 원문 일치·사유와 관계없이 정상 아님, 원문 일치 정보는 그대로 보인다.
- 원문 파일 목록 무결성(rawFileListState: match/unlisted/duplicate_listing/missing_file)을 원문 지문 확인과 따로 표시. 중복 등록·파일 없음은 충돌 → evidence_conflict(normal=false), 누락 확정 보류.
- 전달문 손상도 누락 확정 보류. 보류 시 사용자 의견은 미확정으로 보존.

### 최종 통합 검증 항목
- test/e2e/audio-quality-source.cjs: 출처·원문·전달문·구간·비교의 정상과 반대 사례 — 원문 저장 지문 없음, 원문 손상, 전달문 기록 없음, 전달문 지문 어긋남, 조각 파일 누락·중복·순서 이상·목록 밖·파일 지문 어긋남, 구간 대응 미확인·기대 대사 없음·출처 미확인·원문 확인 불가에서 누락 확정 보류(의견 보존), 한쪽 전달문 기록 없음/어긋남 비교, 근거 미확인 쪽 + 사유 비교.
- python/test_run_record_longform.py: 조각 범위(보정 후 발화문 기준)·없는 값 비움·실제 배치 기준 이음(간격·겹침)·결과 길이 대조.
- 영향: test/e2e/audio-quality-mcp.cjs · audio-quality-evidence.cjs · python/test_run_bundle_always.py · test_chunk_publish.py.

### 남은 제한
- 구간의 시간·대사 대응(강제 정렬)은 없다 — 구간 분석으로는 누락을 확정할 수 없다.
- 조각 범위는 보정 후 발화문 기준 — 사용자 원문 위치로 잇지 않았다.
- 실행 기록 찾기는 기록 폴더의 manifest 를 매번 모두 읽는다(색인 없음).
- 예전 보고서(대사 출처 정보 없음)는 출처 미확인으로 다뤄진다. 9/25 장문의 조각별 seed 처럼 과거 기록에 없는 값은 비어 있다.
