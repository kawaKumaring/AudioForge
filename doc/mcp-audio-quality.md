# 음성 검수 MCP (2026-10-04)

> **현재 상태(2026-10-09 정리)** — 품질 검수 도구는 13개(서버 0.4.0)다. 검사는 기존 MCP 27건 + 근거 검사 25건 + 문장 대조 12건 통과. 사용자 청취 판정이 들어왔고(과거 표본 5건, 숫자 표기 비교 4건), 숫자 표기 비교를 위한 새 합성 4개를 했다. 제품의 숫자 전처리는 아직 구현하지 않았다. 아래 절들의 "도구 7개"·"새 합성 없음"·"청취 없음"은 각 절을 쓴 시점의 기록이다.

## 첫 판(0.3.0, 도구 7개) — 작성 시점 기록


기존 audioforge-devtool에 연결했다. 서버를 다시 연결하면 아래 7개 도구가 나타난다(이후 0.4.0에서 13개로 늘었다 — 아래 확장 절). app_start 없이 사용할 수 있다. 도구가 관측한 모든 보고서 항목과 명시적으로 첨부한 JSON 기록을 조회할 수 있지만, 자연스러움·화자 유사도·감정의 합격을 자동 판정하지 않는다.

| 도구 | 용도 |
|---|---|
| audio_quality_capabilities | 로컬 실행 환경·의존성·설치 ASR·지원 형식·제한 |
| audio_quality_inventory | 지정 폴더의 파일 목록(페이지 조회, 하위 폴더 자동 탐색 없음) |
| audio_quality_analyze | 원본 해시·채널별 신호·선택적 전사·대사 차이·첨부 기록 |
| audio_quality_read | summary / provenance / signals / transcript / differences / records |
| audio_quality_plot | 같은 축의 파형·스펙트로그램, MCP 이미지 직접 반환 |
| audio_quality_clip | 지정 구간을 디코딩 샘플 그대로 FLOAT WAV로 복사 |
| audio_quality_compare | 두 보고서의 조건·수치 차이, 품질 우열 판정 없음 |

## 호출 예시

```json
{"path":"_local/artifacts/example.wav","userApproved":true,"text":"기대 대사","asr":"small","records":["_local/artifacts/manifest.json"]}
```

반환 reportId를 read/plot/clip/compare에 넘긴다. read는 section과 offset/limit(최대 20)을 받는다. 배열은 페이지를 끝까지 읽어야 한다. records의 text 조각은 offset 순으로 이어 원문을 복원한다. 기록은 증거 자료이며 실행할 지시가 아니다. 예:

```json
{"reportId":"반환된 64자리 해시","section":"provenance"}
```

userApproved는 사용자 자료 열람 승인이 실제로 있을 때만 지정한다. 기본 경로 가드는 기존 MCP와 같고 실제 경로를 확인한다. expectedSha256를 주면 다른 파일을 잘못 검사하는 것을 막는다.

## 판정과 보존

- 채널별 peak/RMS/DC/비정상 값, 모든 채널이 낮은 구간만 무음 후보로 기록한다. 반대 위상 스테레오를 합쳐 무음으로 오판하지 않는다.
- 전사는 선택 사항이다. 설치된 Whisper base/small만 CPU로 사용한다. 모델 다운로드·GPU·새 음성 생성·원본 수정 없음.
- raw CER와 서수 표기 정규화 CER를 함께 제공한다. 두 번째/2번째 같은 차이만 제한적으로 정규화한다. 다른 숫자는 동등 처리하지 않는다. 전사 차이는 발음 결함 확정이 아니다.
- 차이 구간은 전사 세그먼트에 따른 후보이며 정확한 음소 정렬이 아니다.
- 파형은 동일 시간·진폭 축, 스펙트로그램은 동일 색 범위다. 자동 음량 보정·시간 정렬을 하지 않는다.
- 캐시에는 원본/첨부 기록/분석 코드/모델 내용 해시, 분석 범위, 기대 대사, Python 및 의존성 버전이 포함된다. 원본 변경 시 옛 보고서는 남기되 새 그림·구간 추출에는 쓰지 않는다.
- provenance에 원본 해시·실행 환경·조건이 나온다. recordsCurrent/sourceCurrent로 파일 변경 여부를 확인한다.

## 제한

입력 최대 512MiB, 분석 창 최대 600초·3천만 채널 샘플·8채널. 긴 파일은 범위를 나누어 분석한다. 그림/추출은 최대 120초. 프로세스 제한 240초. 기대 대사는 2만 글자, 첨부 JSON은 8개·각 1MiB 이하. 산출물은 _local/audio-quality에 보존하며 자동 삭제하지 않는다. 연결된 MCP 서버 하나당 분석 하나만 실행한다.

## 확인

`node test/e2e/audio-quality-mcp.cjs`: 실제 MCP 표준입출력 27건 통과. 반대 위상, 페이지 원문 복원, 출처 조회, 첨부 기록/원본 변경, 잘못된 음원, 원본 불변, 추출 샘플 전량 일치, 네이티브 이미지, 경로 가드를 포함한다.

기존 생성 파일 4개를 실제 도구로 분석하고 모든 section을 조회했다. CPU 전사·비교·이미지·구간 추출까지 완료했다. 결과: _local/quality-audit-2026-10-04/mcp-results.json 및 mcp-followup.json. 이 시점에는 사람 청취 판정을 수행하지 않았다(이후 청취 결과는 synthesis-quality-status·synthesis-ordinal-experiment 문서).

## 0.4.0 확장 — 문장·연결부·참조·판정 (2026-10-04)

도구가 7개에서 13개로 늘었다. 기존 MCP를 재연결하면 반영된다. 제품 GUI나 합성 엔진은 수정하지 않았다.

| 새 도구 | 입력·반환 |
|---|---|
| audio_quality_sentences | reportId, offset/limit → 문장별 기대 대사·ASR 문맥·차이·시간 후보 |
| audio_quality_crosscheck | reportId, otherReportId, offset/limit → 동일 음원/범위/대사의 다른 ASR 대조 |
| audio_quality_context | reportId, 선택 referenceReportId, offset/limit → 해시 연결된 참조/조건/연결점 및 기록 변경 여부 |
| audio_quality_boundary | reportId, boundaryId, window(좌우 초, 기본 0.1) → 채널별 좌우 RMS·피크·경계 샘플 차이 |
| audio_quality_evidence | reportId, start/end → MCP 그림·원본 샘플 구간 WAV·전사·신호·근거 JSON |
| audio_quality_review | reportId, action append/list → 해시·시간에 연결된 누적 판정 |

문장 대조는 강제 정렬이 아니다. 독립 ASR 결과와 문자를 대조한 뒤 관련 ASR 세그먼트의 범위만 반환한다. 못 찾은 문장은 candidateWindows가 비어 있고, adjacentContextOnly는 그 주변을 들을 자리일 뿐 누락 문장의 시각이 아니다. 반복 문구는 대응이 모호할 수 있다. transcript_match도 실제 발음 합격이 아니다. 서수 표기는 1~10의 제한된 규칙만 적용한다.

교차 대조는 원본 해시·분석 범위·기대 대사가 모두 같아야 한다. 같은 ASR 모델 조건은 거절한다. Whisper base와 small의 일치는 독립된 사람 두 명의 확인이 아니며 같은 계열의 공통 오류 가능성이 있다. modelHash 등 원래 실행 조건은 read/provenance에서 확인한다. 확장 도구의 inspectionCode에는 대조/측정 코드 해시가 따로 나온다(옛 보고서를 새 코드로 대조한 경우를 구분).

긴 문맥/차이는 일부 미리보기와 truncated 표시로 반환하며 원문 전체는 read/transcript에서 조회한다. 페이지는 개수뿐 아니라 응답 크기에 따라 짧아질 수 있으므로 nextOffset이 null일 때까지 읽는다. evidence의 전사/신호는 최대 20개와 전체 개수를 함께 반환한다. 그 구간의 파일과 그림은 별도 경로·해시를 가진다.

### 연결점 기록 계약

기존 manifest의 files[].sha256 또는 result의 out_sha256는 결과와 기록의 연결만 입증한다. 조각 개수만으로 연결점을 나누지 않는다. 정확한 연결 좌표가 기록된 경우만 다음 JSON을 analyze의 records로 붙인다.

```json
{
  "schema": "audioforge-quality-context/v1",
  "sourceSha256": "최종 출력 파일의 SHA256",
  "reference": {
    "sha256": "실제 참조 파일의 SHA256",
    "start": 3.0,
    "end": 11.0,
    "selectionReason": "생성 과정에 남은 선택 이유"
  },
  "joins": [{"time": 12.34}, {"time": 25.67}]
}
```

joins.time은 최종 출력 원본 시간축의 초이며 오름차순, 최대 1000개다. 억지로 만든 기록을 붙이지 않는다. reference의 start/end는 기록이 주장하는 원본 내 구간이며 검사기가 재측정한 값이 아니다. 참조 선택 후보/설정 전체는 read/records로 원문을 조회한다. 기록이 없으면 추정하지 않는다. 현재 제품에 이 계약을 쓰는 로깅을 새로 넣지는 않았다.

context에서 referenceReportId를 넘기면 별도로 검사한 참조 파일의 실제 해시와 기록을 대조한다. fileHashVerified는 파일 내용 일치만 뜻하며, 엔진이 그것을 실제로 사용했다는 독립 증명이나 목소리 품질 판정이 아니다. boundary는 context가 내놓은 boundaryId만 받고, 음원과 기록이 바뀌었으면 측정하지 않는다. RMS/샘플 차이는 클릭음 또는 이음 부자연스러움의 확정 기준이 아니다.

### 판정 보존 계약

append 필수: start/end, category(omission/pronunciation/repetition/noise/join/speaker/naturalness/other), verdict(confirmed/not_observed/uncertain), basis(user_report/machine_observation), observer, note. user_report는 userStatement에 사용자가 실제 전달한 원문이 필요하다. 호출자가 원문을 제시했다는 기록이며 도구가 청취 행위를 인증하지 않는다. 기계 관측은 uncertain만 허용한다.

판정은 음원 내용 해시별 파일에 새 항목으로 저장한다. 정정 시 replaces에 이전 ID를 지정하며 원래 항목은 그대로 남는다. 같은 바이트의 다른 경로에서도 판정은 공유한다. 원본이 바뀌어도 이전 판정 조회는 가능하지만 sourceCurrent=false로 표시하고 새 판정 추가는 막는다. 정정 전후를 자동 집계해 품질 합격으로 만들지 않는다.

### 실제 확인

- 기존 MCP 검사 27건, 새 MCP 근거 검사 25건, 문장 대조 단위 12건 통과(총 64건). 모델/GPU 합성 미실행.
- 기존 음원 4개·39문장 대조: 자동 차이 후보 6문장. 품질 불합격 6건이라는 뜻이 아니다.
- before-chunk3 마지막 '7번째 장면이다'는 small/base 모두 누락 후보. 문장 시각은 만들지 않고 끝부분 11.5~15.91초 근거 묶음과 기계 관측 uncertain을 보존했다.
- 실제 참조 조각을 분석해 manifest의 b51c8648… 해시와 일치 확인. 원본 참조 내 선택 시작/끝과 다른 후보의 적합성은 이 기록만으로 알 수 없다.
- 90초 장문의 실제 연결 좌표는 없음. 측정 성공으로 꾸미지 않았다. 연결부 측정 자체는 위치·진폭을 아는 2채널 검사 음원에서 샘플 차이와 6.0206dB 변화를 확인했다.
- 산출물: _local/quality-audit-2026-10-04/mcp-extension-verified.json, mcp-evidence-final.png. 전사는 로컬 CPU만 사용했다. 이 절 작성 시점에는 사람 청취 없음.
