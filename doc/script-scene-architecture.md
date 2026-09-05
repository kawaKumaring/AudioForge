# 대본·장면 구조 설계 (Script / Scene Plan)

`v1.2.0` 기준선에서 앞으로 만들 것들의 **구조와 계약**을 확정하는 문서다.
단계와 일정의 권위는 [roadmap.md](roadmap.md)이고, 이 문서는 구조를 소유한다. 같은 내용을
두 곳에 적지 않는다 — roadmap은 "언제 무엇을", 이 문서는 "어떤 모양으로".

이 문서는 설계만 담는다. 여기에 적힌 것은 아직 구현되지 않았다.

## 1. v1.2.0에서 완료된 것과 남은 한계

### 완료

- vendor native ICL 기본 경로. 참조 codec 구간 제거는 vendor가 하고 외부 ASR trim은 없다.
- 감정 태그·명시적 쉼·줄·문단 경계·자동분할의 TS/Python parser parity.
- 입력 추정 UI. 예상 음성 길이·작업 시간·생성 묶음 수와 문단별 분할 정보를 읽기 전용으로
  보여 주고, 화면의 묶음 수가 planner의 chunk 수와 같다.
- 상주 분석 worker. CPU만 쓰고 TTS 모델을 로드하지 않으며, 어떤 종료 경로에서도 고아가
  남지 않는다.
- run bundle. 모든 생성에 대해 JSON 기록이 남고 manifest가 마지막에 발행된다.
- macro gain drift 보정. 조립된 트랙에 한 번, boost-only.
- 테스트 자산 이식성. E2E가 저장소 밖 사용자 자산을 찾지 않는다.

### 남은 한계 — 다음 단계들이 겨냥하는 지점

- **화자가 하나다.** 대본에 여러 인물이 있어도 목소리를 나눌 수단이 없다.
- **감정은 구간 태그뿐이다.** 세기·전환 속도·인물별 감정 기본값이 없다.
- **prosody 축이 감정 태그에 얹혀 있다.** 강조·속도 변화·쉼의 길이를 따로 지시할 수 없다.
- **비언어·환경음·음악이 없다.** 대본에 "문이 닫힌다"를 적을 자리가 없다.
- **공간이 없다.** 거리·방향·잔향을 지시할 수 없다.
- **미리보기가 시간축을 못 보여 준다.** 묶음 수와 예상 길이는 알지만 장면의 순서를 보여
  주는 화면이 없다.
- **모델이 하나에 묶여 있다.** 다른 모델과 같은 조건으로 비교할 통로가 없다.
- **신뢰도 라벨이 사실상 한 값이다.** 실측 구간이 단일 호출 관측에서 나와, 여러 묶음으로
  갈리는 입력은 전부 `외삽`이다.

## 2. 공용 Script/Scene Plan의 목적

지금은 기능마다 대본을 따로 읽는다. 감정은 감정 파서가, 분할은 splitter가, 예상 시간은
estimator가 각자 읽는다. 화자·환경음·공간이 들어오면 이 방식은 반드시 갈라진다 — 같은
대본에 대해 서로 다른 해석이 여러 개 생기고, 화면과 생성 결과가 어긋난다.

그래서 **대본을 한 번 읽어 하나의 계획으로 만들고, 모든 소비자가 그 계획만 본다.**

- 파서는 하나다. 미리보기·타임라인·planner·생성기·run bundle이 같은 plan을 읽는다.
- plan은 **서술적**이다. 무엇을 할지 적고, 어떻게 만들지는 소비자가 정한다.
- plan은 **결정적**이다. 같은 입력·같은 parser version이면 같은 plan이 나온다.
- plan에는 **원문 좌표**가 있다. 화면에서 항목을 누르면 대본의 그 자리로 갈 수 있다.

## 3. 축 — 무엇과 무엇을 구분하는가

열 가지를 섞지 않는다. 각각 별도 배열이거나 별도 필드다.

| 축 | 무엇인가 | 누가 만드는가 |
|---|---|---|
| `source_paragraphs` | 사용자가 Enter로 나눈 문단 | 사용자 |
| `speakers` | 인물 정의(이름·참조 목소리·기본 감정) | 사용자 |
| `utterances` | 한 화자가 이어서 말하는 한 덩어리 | 파서 |
| `emotions` | 구간별 감정과 세기 | 사용자 태그 |
| `prosody` | 강조·속도·음높이 방향 | 사용자 지시 |
| `pauses` | 명시적 쉼과 그 길이 | 사용자 지시 |
| `actions` | 비언어 행동(한숨·웃음·숨) | 사용자 지시 |
| `ambience` | 환경음 층 | 사용자 지시 |
| `music` | 음악 층 | 사용자 지시 |
| `spatial` | 거리·방향·잔향 | 사용자 지시 |
| `chunks` | 실제 모델 호출 묶음 | planner |

**문단 ≠ 발화 ≠ 묶음.** 한 문단에 여러 화자가 있을 수 있고, 한 발화가 여러 묶음으로
갈릴 수 있다. UI에서 이 셋의 개수를 같은 이름으로 부르지 않는다. `v1.2.0`이 이미
`source_paragraphs` / `segments` / `chunks`를 나눠 쓰고 있고, 그 규율을 그대로 확장한다.

`chunks`는 다른 축과 성격이 다르다. 나머지는 사용자의 의도이고 `chunks`는 실행 계획이다.
그래서 chunk 경계가 바뀌어도 의도는 바뀌지 않아야 한다.

## 4. 책임 분리 — 네 층

`v1.2.0`의 세 축 계약을 네 층으로 확장한다. 한 층의 지시가 다른 층의 수단으로 구현되면
안 된다. "언성을 높임"을 gain 증가로, "저음"을 gain 감소로 처리하는 것이 금지된 이유가
그것이다.

**performance prosody** — 연기. 감정, 세기, 강조, 속도, 음높이 방향, 쉼.
모델이 실제로 그렇게 **발화**해야 한다. 후처리 gain·EQ로 흉내 내지 않는다.

**mix loudness** — 음량 균형. 층 사이의 상대 크기와 조립된 트랙의 macro gain.
연기의 대체물이 아니다. normalization·compressor·limiter·AGC를 연기 문제의 해법으로
끌어오지 않는다.

**spatial automation** — 공간. 거리, 방향, 잔향, 이동.
`v1.2.0`의 macro gain은 이미 `protected_spans`를 받아 둔다 — 공간 자동화가 손댈 구간을
macro gain이 덮어쓰지 않게 하려는 자리다.

**non-speech layer** — 말이 아닌 것. 비언어 행동, 환경음, 음악.
대사 트랙과 **별도 층**으로 만들고 별도로 믹스한다. 대사 생성 파이프라인에 끼워 넣지
않는다. 행동(한숨·웃음)은 예외적으로 모델이 낼 수도 있어 층을 두 갈래로 둔다 —
모델이 내는 것과 층으로 얹는 것을 plan에서 구분해 적는다.

각 층은 자기 metadata를 run bundle에 따로 남긴다. 어느 층이 무엇을 했는지 사후에
분리해 읽을 수 있어야 한다.

## 5. 원문 좌표 보존과 parser parity

- plan의 모든 항목은 **원문(사용자가 입력한 그대로)** 기준 offset을 가진다.
- 줄 끝 표기 정규화는 **파서 입구 한 곳**에서만 한다. `v1.2.0`의
  `tts_grammar.normalize_line_endings()`가 정규화 문자열과 함께 원문 좌표 역매핑을 낸다.
  그 뒤 단계는 정규화 좌표를 쓰고, 화면에 나갈 때만 원문 좌표로 되돌린다.
- **CRLF/LF/CR이 같은 plan SHA를 낸다.** 정규화 전 SHA(원문 신원)와 정규화 후
  SHA(파서가 본 것)를 따로 기록한다.
- TS와 Python이 같은 결과를 내는 것을 fixture와 plan hash로 고정한다. 한쪽만 고치면
  parity 테스트가 깨진다. UI용 별도 파서를 TS에 만들지 않는다.
- 좌표가 정확하지 않을 수 있는 항목은 그 사실을 필드로 밝힌다
  (`v1.2.0`의 `source_offsets_exact` 관례를 유지한다).

## 6. 분석·미리보기와 production 생성의 경계

두 경로는 **같은 plan을 읽고 다른 일을 한다.**

| | 분석·미리보기 | production 생성 |
|---|---|---|
| 실행 위치 | 상주 분석 worker(CPU) | 생성 worker(GPU) |
| 모델 | tokenizer만 | TTS 모델 |
| 부작용 | 없음 | 파일 생성, run bundle |
| 실패 시 | fail-open(상태로 표시) | fail-closed(발행하지 않음) |
| 취소 | 늦은 응답을 버린다 | 취소 수명을 완결한다 |

- **미리보기는 GPU를 켜지 않는다.** 분석만으로 TTS 모델이 로드되면 안 된다.
- **미리보기의 planned calls는 실제 생성 호출 수와 같아야 한다.** 이 등식이 깨지면
  미리보기는 신뢰를 잃는다. `v1.2.0`이 이미 이것을 테스트로 고정하고 있다.
- 미리보기가 시간 숫자를 낼 수 없으면 지어내지 않고 문구로 말한다.
- 원문 전문은 일반 로그·run bundle manifest에 남기지 않는다. 남기는 것은 request id,
  SHA, 상태, 오류 코드, 소요 시간이다.

## 7. 기존 것을 어떻게 재사용하는가

새로 만들지 않는다. 있는 것을 확장한다.

**`tts_grammar`** — 파서 입구. 지금 감정 태그·쉼·경계를 읽는다. 화자 표기·prosody 지시·
행동·층 지시를 **같은 파서**에서 읽어 plan에 담는다. 새 파서를 병행하지 않는다.

**입력 분석 worker** — plan 생산자. 지금 `input_analysis.analyze()`를 돌려준다.
plan을 돌려주게 확장하고, 프로토콜(JSON lines·request id·source SHA 검증·늦은 응답
폐기·fail-open)은 그대로 쓴다. 새 IPC 채널을 만들지 않는다.

**planner** — `chunks`의 유일한 소유자. 화자·감정 경계가 chunk 경계에 영향을 주더라도
분할 결정은 planner 하나가 한다. 미리보기는 planner를 호출할 뿐 자기 분할을 갖지 않는다.

**run bundle** — 진단 기록. 지금 stage별 기록과 manifest-last 발행을 한다.
plan SHA·parser version·층별 metadata·사용자 청취 판정 링크를 같은 bundle에 넣는다.
새 기록 체계를 만들지 않는다.

**macro gain / `protected_spans`** — 공간 자동화가 들어올 자리. 이미 계약이 있다.

## 8. 하위 호환성과 기존 대본 처리

- **기존 대본은 그대로 동작한다.** 화자 표기가 없으면 화자 하나로 읽고, 층 지시가 없으면
  층이 없는 plan이 된다. 새 문법을 쓰지 않는 대본의 결과가 달라지면 안 된다.
- 새 문법은 **덧붙이는 방식**으로 넣는다. 기존 태그의 의미를 바꾸지 않는다.
- plan schema에 version을 둔다. 소비자는 모르는 version을 만나면 결과를 쓰지 않는다
  (`v1.2.0`의 `ANALYSIS_SCHEMA_VERSION` 대조 관례를 유지한다).
- 세션·재현 metadata는 plan version과 parser version을 함께 적는다. 버전이 다르면
  "그때와 같은 결과"를 약속하지 않고 그 사실을 밝힌다.
- 새 문법처럼 보이지만 해석할 수 없는 표기는 **조용히 무시하지 않는다.** 경고로 남기고
  글자 그대로 읽는다.

## 9. 오류·경고와 fail-open / fail-closed

**fail-open (분석·미리보기·보조 정보)** — 실패해도 편집과 합성을 막지 않는다.
분석 worker 실패, 타임아웃, 스키마 불일치, 층 미리보기 실패가 여기 속한다. 화면은
상태 한 줄로 말하고 큰 오류 카드를 띄우지 않는다.

**fail-closed (생성·발행)** — 확신할 수 없으면 발행하지 않는다.
참조 정합 실패, 경계 절단, 전사 실패, capability 미실증 기능 요청, plan version 불일치가
여기 속한다. 실패·부분 결과는 진단 영역에 보존하되 정상 결과처럼 내보내지 않는다.

**경고**는 결과를 막지 않지만 기록에 남는다. 자동 보정으로 조용히 덮지 않는다.

원칙 셋을 유지한다. 근거 없는 임계값을 만들지 않는다. capability가 실증되지 않은 기능을
지원됨으로 표시하지 않는다. 자동 지표로 품질 PASS를 선언하지 않는다.

## 10. 단계별 구현 순서와 완료 조건

각 단계는 **앞 단계의 계약 위에서만** 시작한다.

### 1.3 — 공용 구조와 미리보기

plan schema, 파서 확장(구조만), plan을 읽는 읽기 전용 타임라인.

완료 조건: plan schema version 고정 · TS/Python parity fixture 통과 ·
CRLF/LF/CR 동일 plan SHA · 미리보기 planned calls == production planner ·
기존 대본 결과 불변 · GPU 로드 0 · 사용자 UI 인수.

### 1.4 — 다화자와 감정

화자 정의·발화 귀속·인물별 참조 목소리·감정 세기와 전환.

> **현재 위치 (2026-09-03)** — 화자 축과 인물별 참조는 구현·청취 PASS(화자 구분 기준).
> 감정 축은 **`reference_matched` 단계**다: 같은 화자의 후보 중에서 참조를 고르는 것까지이며
> 감정 적용 성공도 감정 인식 성공도 아니다. 모델에 감정 제어값을 넘기는 통로는 없다.
> 기술 세부·모델 capability·적용 통로 네 갈래는
> [감정 음향 전략](work-in-progress/tts-emotion-acoustic-strategy.md)이 소유한다.

완료 조건: 화자 귀속이 원문 좌표로 되짚어짐 · 화자별 참조 fingerprint가 캐시 키에 들어감 ·
감정 세기가 후처리 gain으로 구현되지 않음(층 metadata로 증명) · 다화자 장문 청취 판정 ·
단일 화자 대본 회귀 없음.

### 1.5 — 음성 언어 변환

대사의 언어를 바꾸되 목소리와 연기를 유지한다.

완료 조건: 로컬 종단 경로 · 원문/번역문 좌표 동시 보존 · 화자·감정 유지 청취 판정 ·
번역 실패 시 fail-closed · 외부 API 미사용.

### 1.6 — 환경음과 공간 연출

non-speech 층과 spatial automation.

완료 조건: 층이 대사 트랙과 분리 생성·분리 믹스됨 · `protected_spans`가 macro gain과
충돌하지 않음 · 층별 metadata가 run bundle에 분리 기록 · 층을 끄면 `v1.2.0`과 동일한
대사 트랙 · 청취 판정.

### 2.0 — 가창과 음악 목소리 변환

완료 조건: 별도 MVP 승인 후 착수 · 앞 네 단계의 계약을 바꾸지 않음.

## 11. 버전 계획

- **1.3** 공용 구조·미리보기
- **1.4** 다화자·감정
- **1.5** 음성 언어 변환
- **1.6** 환경음·공간 연출
- **2.0** 가창·음악 목소리 변환

버전은 기능 묶음의 이름이고 일정 약속이 아니다. 각 단계는 사용자 인수를 받은 뒤 다음으로
넘어간다.

## 12. 상위 모델 비교 — adapter 방식

공용 구조가 서기 **전에는** 하지 않는다. 지금 비교하면 모델 차이와 파이프라인 차이가
섞여 무엇이 좋아졌는지 알 수 없다.

공용 구조가 서면 모델을 **adapter**로 뒤에 끼운다. plan은 그대로 두고 adapter가 각 모델의
입력 형식으로 옮긴다. 그러면 같은 plan·같은 참조·같은 분할로 비교할 수 있다.
adapter가 지원하지 못하는 축(예: 층·공간)은 그 사실을 밝히고 비교 범위에서 제외한다.

새 모델·대용량 가중치를 자동으로 내려받지 않고 라이선스를 자동 동의하지 않는다.

## 13. 각 단계의 범위 밖 항목과 의존성

- **1.3 범위 밖**: 실제 화자 분리 생성, 층 생성, 공간 처리, 편집 가능한 타임라인.
  타임라인은 읽기 전용으로 시작한다.
- **1.4 의존**: 1.3의 plan schema와 좌표 계약. **범위 밖**: 언어 변환, 층, 공간.
- **1.5 의존**: 1.4의 화자·감정 귀속. **범위 밖**: 층, 공간, 가창.
- **1.6 의존**: 1.3의 층 표기와 1.4의 화자 축, `protected_spans`. **범위 밖**: 가창.
- **2.0 의존**: 1.3~1.6 계약 안정. **범위 밖**: MIDI/MusicXML 입력(후속 연구).

한 단계에서 여러 독립 변수를 동시에 바꾸지 않는다. 이 순서는 그 규율의 결과다.

## 14. 사용자 청취 판정과 JSON 진단의 연결

품질의 최종 권위는 사용자 청취다. 그 판정이 기록과 이어져야 나중에 되짚을 수 있다.

- 모든 생성은 run bundle을 남기고, bundle은 plan SHA·parser version·층별 metadata·
  참조 fingerprint·모델 revision을 담는다.
- 청취 판정은 **판정 코드**로 기록한다(`…_USER_PASS`, `…_FAIL` 형태). 그 코드가 어느
  run bundle을 가리키는지 id로 잇는다.
- 판정에 붙는 서술은 사용자의 말을 그대로 남긴다. 자동 지표로 바꿔 적지 않는다.
- 대사 원문·전사는 bundle의 private JSON에만 두고 manifest·일반 로그에 올리지 않는다.
- 판정이 FAIL이면 그 bundle을 진단 영역에 보존한다. 재현 조건(입력 SHA·참조·설정)이
  bundle에 있어 같은 조건으로 다시 만들 수 있어야 한다.
- 청취 없이 품질 PASS를 선언하지 않는다. 지표가 좋아도 마찬가지다.

## 15. 테스트 과잉 방지 정책

검증 시간 자체를 성과로 취급하지 않는다. 남은 계약을 증명하는 **최소 검증**으로 끝낸다.

- **문서 단계**에서는 테스트·build·GPU·앱 실행을 하지 않는다. 이 문서를 쓰는 작업이
  그렇다.
- **구현 중**에는 표적 테스트를 먼저 돌린다. 바꾼 것이 한 줄이면 검증도 그 한 줄을
  겨냥한다. 같은 SHA에 같은 전체 게이트를 반복하지 않는다.
- **전체 회귀**는 최종 후보에서 사용자 승인 시 **한 번만** 돌린다.
- 표적 검증이 실패하면 다른 테스트로 범위를 넓히지 않고 원인만 보고한다.
- **worktree junction과 사용자 런타임 조작을 하지 않는다.** 본체 자산을 가리키는
  링크를 임시 트리에 만들지 않고, 링크를 품은 트리에 재귀 삭제를 쓰지 않는다.
  (사고 기록: `_local/artifacts/recovery/externals-incident-20260831/`)
- clean 환경 검증이 필요하면 링크 없이 별도 clone을 쓰거나, 의존성 없이 되는 검사만 한다.

### 타입 검사는 실제 프로젝트로만 한다 (2026-09-03 확정)

`tsconfig.json` 은 `files: []` 에 project references 만 둔 **solution 설정**이다.
`tsc --noEmit -p tsconfig.json` 은 검사 대상이 **0개**이므로 언제나 통과하고, 그 통과는
아무 의미가 없다. 실측: `--listFiles` 로 센 프로젝트 파일이 0개다.

올바른 명령은 두 개다.

```
npx tsc --noEmit -p tsconfig.node.json    # src/main · src/preload · src/shared (프로젝트 파일 49)
npx tsc --noEmit -p tsconfig.web.json     # src/renderer · src/shared (프로젝트 파일 62)
```

- 두 설정을 **각각** 돌린다. 하나만 돌리면 renderer 또는 main 이 검사되지 않는다.
- 검사 파일 수가 0인 명령은 성공으로 인정하지 않는다. 의심되면 `--listFiles` 로 센다.
- 파이프(`| head`)를 붙이면 종료 코드가 파이프 마지막 명령의 것이 된다 — 통과 판정은
  출력이 비었는지와 tsc 자신의 종료 코드로 한다.

**기록**: 2026-09-03 이전에 이 저장소에서 `-p tsconfig.json` 으로 보고한 타입 검사
통과는 검사 대상이 0개였으므로 **유효 근거에서 제외한다.** v1.4 의 E1·E2·E3·문서 커밋
당시의 "타입 검사 통과" 보고가 여기에 해당한다. 실제 설정으로 다시 검사했을 때
E4 에서 만든 누락(런타임 `TypeError` 로 이어지는 Record 키 2개 부재)이 곧바로 잡혔다.

## 16. 여러 명 대화 화면 — 원문 하나가 유일한 권위 (2026-09-04)

`[2] 대사` 머리의 `한 명 | 여러 명` 탭은 **보기 전환**이다. 탭 자체는 원문을 쓰지 않는다.
`한 명` 은 기존 화면 그대로이고, `여러 명` 은 분석 계획(plan)의 발화 좌표를 원문 위에
투영한 화면이다. 구조화된 편집은 전부 `src/shared/dialogueSourcePatcher.ts` 의 명령을
거쳐 원문을 고친다. 범용 "계획 → 원문" 직렬화기는 없다.

파일: `src/renderer/hooks/useDialogueProjection.ts`(투영·초안·명령), `DialogueTabs.tsx`,
`MultiSpeakerDialogue.tsx`, 셸은 `TTSEditor.tsx` 의 훅 호출·탭·mount·콜백만.

### 실측으로 확정한 계획 좌표의 성질 (python/script_plan.build_structure)

고정 데이터 `src/shared/fixtures/dialogue-planner-spans.json`, 검사 `dialogueSourcePatcher.planner.test.ts`.

- 발화 구간(`source_start~source_end`)은 **`[화자 …]` 줄을 포함하지 않는다**. 그 줄은
  앞 발화 끝과 다음 발화 시작 사이의 빈틈에 놓인다. 감정 태그(`[기쁨]`)는 구간에 포함된다.
- 한 줄 안의 감정 전환·`[쉼 N]` 은 발화를 **여러 개로 나눈다**(같은 `line_index`).
- `source_sha256` 은 원문 UTF-8 sha256 과 같다(renderer 의 `samplerSha256Hex` 와 일치 —
  PLAN_STALE 판정의 전제). `parser_authority` 는 정상 대본에서 true, `source_offsets_exact` 도 true.
- 알 수 없는 지시가 있으면 파서가 물러나 `UNKNOWN_DIRECTIVE` 경고를 낸다 → 화면은 직접 입력.

이 성질 때문에 화면의 "대화 한 줄" 은 `groupUtteranceRows()` 가 만든다: 같은 줄의 조각을
한 행으로 잇고, 바로 앞 빈틈이 *공백 + 화자 표기 하나* 뿐이면 그 표기를 구간에 흡수한다.
빈틈에 그 밖의 것이 있으면 흡수하지 않아 `NON_WHITESPACE_OUTSIDE` 가 정직하게 걸린다.
첫 개발 화면 확인에서 모든 대본이 이 사유로 막혔던 것이 이 함수를 만든 계기다.

### 타이핑 계약

- 행 본문 textarea 는 어떤 계획 상태에서도 입력을 받는다(초안 = 화면 임시값).
- blur / Ctrl+Enter 에 한 번 반영한다. 반영은 초안을 시작할 때 붙잡은 원문 SHA 와 지금 SHA 를
  비교한다. 다르면 덮어쓰지 않고 초안을 버린다(resync). 같은데 계획만 아직이면
  (`PLAN_MISSING`/`PLAN_STALE`) 초안을 **보류**하고 계획이 오면 반영한다(deferred).
- 행 투영은 계획 `sourceSha256` 과 맞는 원문 스냅샷 위에서만 계산한다. 낡은 좌표를 새
  원문에 대지 않는다. 좌표 의존 버튼(화자·감정·추가·삭제·이동)은 그동안 잠긴다.
- 빈 카드 2개는 `ensurePendingSpeakers(2)` 로만 만든다 — React StrictMode 가 effect 와
  updater 를 두 번 부르므로 ref 로 번호를 매기면 카드 4개가 같은 ID 가 된다(실측).

### 기본 인물 (2026-09-04 마감)

화자 표기가 없는 대사는 인물 칸에 **기본 인물**로 보인다(빈 칸 아님). 기본 인물은 한 명 탭과
같은 기본 목소리를 쓴다는 안내 한 줄만 있고, 인물 카드·목소리 store·저장소 어디에도
등록하지 않는다. 사용자가 명시 인물로 바꾸면 패처가 그 대사 앞에 `[화자 이름]` 을 세우고,
이어받던 다음 대사는 `[화자 기본]` 으로 되돌린다. `[화자 기본]` 은 파서가 화자를 비운다(실측,
fixture `default_reset`). 명시 인물 → 기본 인물도 같은 경로(`changeSpeaker(…, null)`)다.
빈 문자열은 기본 인물이 아니라 잘못된 이름이다.

### 쉼의 두 경우

- **대사 안의 쉼**(`안녕 [쉼 1] 잘 지냈어?`): 계획은 발화를 둘로 나누지만 화면은 한 행으로
  묶고 쉼 표기는 본문에 남는다. 기본 감정·화자 변경·본문 수정 뒤에도 남고, 쉼을 지우는
  본문 수정은 거부된다(`MID_EMOTION_WOULD_BE_LOST` — 이름은 감정이지만 모든 중간 표기를 보호한다).
- **대사 사이의 독립 쉼 줄**(`[쉼 1]` 만 있는 줄): 발화 구간 밖의 내용이므로
  `NON_WHITESPACE_OUTSIDE` 로 직접 입력에 물러난다. 사용자 문구가 두 경우를 구분한다.

### 사용자 화면 용어

한 명 / 여러 명 / 인물 / 기본 인물 / 목소리 지정 / 목소리 구성 저장/불러오기 / 대본 직접 입력.
내부 용어(VoiceCast·배역 세트·source patcher·parser·SHA·projection)는 화면에 내지 않는다.
`VOICE_CAST_LABEL` 의 문구도 "목소리 구성" 으로 통일했다(코드 이름은 그대로).

### 탭 = 생성 방식 `speakerMode` (2026-09-04 재설계 — 보호·전환 폐기)

한 명이 기본 기능이다. 명시 화자가 있다는 이유로 한 명 편집을 막고 여러 명 화면으로 보내는
설계(SingleScriptGuard·`speakerStructurePreserved` 게이트·`한 명 대본으로 전환`)는 **폐기**했다.

- `ttsSpeakerMode: 'single' | 'multi'` 는 **현재 작업의 생성 방식**이다. 대본 내용이 아니라 라우팅
  방식이다. 앱·새 파일·리셋 기본 single. 세션 복원은 저장된 값만(legacy 세션 부재 → single).
  탭은 이 값을 그대로 보여 주고, 클릭은 이 값만 바꾼다(원문·인물 설정·목소리 자산 무변경, 확인창 없음).
- 한 명 모드: 편집기는 제한이 없다. `[화자 …]` 표기가 남아 있어도 single 생성은 화자 라우팅을 무시하고
  모든 발화를 한 명의 기본/감정 참조로 만든다(routing snapshot 의 speaker_id 전부 None, 화자 참조·전용
  참조·후보 선택 무개입). 화면에는 중립 안내 한 줄("모든 대사를 한 목소리로 생성합니다. 인물 표기 N개는
  여러 명에서만 쓰입니다"). 표기를 지우거나 바꾼 편집 뒤에는 오류가 아닌 알림
  `인물 구분이 변경되었습니다 · 되돌리기`(직전 원문으로. 다음 편집이 오면 알림 소멸). 자산·구성 무접촉.
- 여러 명 모드: 현재 원문의 화자 정보를 쓴다. 명시 화자는 자기 기본 목소리, 감정별 목소리는 그 인물의
  토글이 켜졌을 때만. 참조가 없으면 모델 로딩 전에 차단(대체 없음).
- 라우팅 계약: single → 모든 발화 speaker_id=None, run bundle header `speaker_mode='single'`, 규칙
  emotion_reference/global_default. multi → 계획 speaker_id 유지, `default_speaker` 또는 켠 인물의
  `explicit_emotion_override`, chunk 행에 speaker/reference/rule/speaker_mode 기록.
- 합성 중 탭은 잠긴다. 진행 중 작업의 스냅샷은 이미 쓴 config 로 확정되어 바뀌지 않는다.
- Python 은 config 키 부재(legacy)를 multi 로 본다(오늘까지의 worker 동작). 앱은 항상 값을 보낸다.
- `stripSpeakerDirectives`·`speakerStructurePreserved` 는 패처의 순수 함수로 남아 있다(화면에서는 쓰지
  않음. 표기 제거 보조 동작이 필요해지면 결과 설명·되돌리기와 함께 별도로 붙인다).
- `speaker_mode` 키 부재는 **single** 이다(2026-09-05 교정). 새 작업·저장값 부재·legacy config 모두 single,
  multi 는 명시했을 때만. v1.3 은 한 명이 기본이었으므로 없는 키를 여러 명으로 추측하지 않는다.

### 여러 명 화면 = 인물의 한 발화 카드 (2026-09-05 재설계)

기본 단위는 **인물의 한 발화 카드**다. 카드 하나에 누가(인물 select, 기본 인물 포함) · 어떤 목소리(머리의
`목소리 준비됨/없음/확인 중`, 누르면 그 인물의 목소리 패널) · 어느 위치에서 어떤 감정(`+ 감정`) · 무엇을
(대사 한 칸) · 위/아래/삭제가 함께 있다. 카드 순서 = 생성 순서. 같은 인물의 카드는 같은 인물 id 와 목소리
설정을 공유한다(한 곳에서 바꾸면 모든 카드에 같은 상태).

- **대화칸 하나**: 카드 본문 `content` = 원문 조각에서 화자 표기만 뺀 것. 첫 감정 태그·중간 태그·쉼 표기가
  글자 그대로 들어 있고 일반 편집으로 넣고 지운다. 반영(`replaceUtteranceContent`)은 화자 표기만 지키고
  나머지를 통째로 바꾼다. 기본 감정 dropdown·두 번째 textarea·태그 보호 규칙은 없다.
- **`+ 감정`**: 감정 목록을 열고 고르면 `insertTagAtCaret` 이 caret 위치에 기존 문법 태그를 넣는다. 맨 앞 =
  시작 감정, 중간 = 그 위치부터 변경. 표기 안에 caret 이 있으면 표기 뒤에, 앞 글자가 공백이 아니면 공백 하나.
  IME 조합 중이면 조합이 끝난 뒤 넣는다. 마지막 유효 caret 을 기억한다. `execCommand('insertText')` 로 넣어
  네이티브 undo 가 산다(실패 시 draft). 감정별 참조 음성 선택은 여기 섞지 않는다(목소리 패널의 고급 토글).
- **목소리 패널**: 선택한 인물 한 명만. 지정/바꾸기·재생·해제·참조 구간(파형은 이 인물만)·같은 파일 공유
  경고·`감정별 목소리 사용` 토글. 닫으면 카드로 돌아온다. 패널이 열리면 그 인물의 참조를 다시 확인한다.
- **인물**: 위쪽 인물 카드 영역 없음. 요약 한 줄(`인물 N명 · 모두 준비됨` / `목소리 준비 안 됨 M명: …` /
  `기본 인물 대사 K개`). 빈 대본은 시작 카드 2개(이름·목소리·첫 대사) — 넣기 전엔 어디에도 쓰지 않는다.
  첫 대사를 넣은 인물의 시작 카드만 사라진다. `+ 대화 추가` 는 기존 인물 선택 또는 `새 인물 만들기…`.
  인물은 원문의 표기에서 나오므로 "인물 삭제" 버튼이 없다 — 카드의 인물을 바꾸거나 카드를 지운다.
- **원문 직접 편집**: `고급 · 대본 표기 직접 편집` 버튼으로만. 열면 카드를 숨기고 기존 편집기를 보여 준다.
  닫으면 현재 ttsText 의 분석 결과가 카드로 돌아온다. 구조화할 수 없는 대본이면 이유와 함께 편집기가 그대로
  보이고 열림 상태는 접힌다. 두 편집기를 동시에 고치지 않는다.
- 검증(개발 앱 1회, 36항목): 폭 1280×800·720 에서 가로 넘침 0·세로로 쪼개진 버튼 0·카드 겹침 0.

### 01:39 run 감사 결론 (2026-09-05, 읽기 전용 승인 범위)

session.json(그 run 의 출력 폴더)에서 확인: `ttsSpeakerRefs` 키 3개·고유 값 3개(모두 임시 파생 클립 경로,
현재 소실), `ttsSpeakerRefSources` 키 3개·**고유 경로 2개** — 두 인물(spk_55d8…, spk_2eda…)이 같은 원본
파일(sha8 ad9f3418)을 등록한 상태였고 세 번째(spk_917b…)만 다른 파일(05835a48). 세션 원문 SHA 와 bundle
raw_text SHA 일치(1425fb5b). 따라서 config→Python→bundle 은 등록된 그대로였고(같은 원본에서 자른 두 클립 →
같은 reference_id a33735…), 중복은 **등록 단계(store 의 source)** 에서 생겼다. 이후 09:50 세션에서는 spk_2eda…
의 원본이 다른 파일(47ce140e)로 바뀌어 세 인물 모두 고유했다. 등록 경로(파일 대화상자 → registerSpeakerRef)
코드에서 값이 섞이는 지점은 찾지 못했다 — 같은 파일을 두 번 고른 것인지, 아직 못 찾은 결함인지는 미확정.
완화: 여러 명 화면과 목소리 패널이 "같은 파일을 씁니다" 를 그 자리에서 말한다.

## 17. 다화자 목소리 선택 감사 (2026-09-04, v1.4 병합 차단 결함)

증상: 여러 명 대화에서 지정한 목소리와 다른 목소리가 간헐적으로 나온다.

### run bundle 실측 (`_local/artifacts/runs`, 읽기 전용, 내부 ID·SHA 만)
- 완료 run 4건(9/3 23:51, 9/4 01:39, 09:50, 09:56): 전부 qwen3, 발화별 선택 규칙 전부 `speaker`
  (인물 기본 목소리), `no_target_profile`, 후보 1개. 감정 기반 대체·다른 인물로의 fallback·전역
  기본 대체 **없음**. 한 run 안에서 같은 인물은 같은 reference_id 를 유지한다.
- **01:39 run: 서로 다른 두 인물이 같은 reference_id(같은 음원 내용)** 로 생성됐다. Python 은
  config 가 준 두 기본 참조의 내용이 같았다는 사실을 그대로 기록했다. 이 사실을 여러 명 카드는
  말하지 못했다(같은 파일 공유 경고는 고급 설정 목록에만 있었다).
- 미완료 run 4건: `GENERATION_LIMIT_EXCEEDED` 3건(01:29·01:33·10:09, 각 3분 안팎, 청크 0 —
  모델 생성 상한 도달), `SPEAKER_REFERENCE_NOT_READY` 1건(09:47, 준비 전 생성 시도 → fail-closed 정상).
- bundle 은 요청 config 의 참조 경로·SHA 를 기록하지 않으므로 "사용자가 기대한 SHA" 는 bundle 만으로
  복원할 수 없다. 기대값은 사용자가 지정한 파일에서 나온다.

### 코드 감사에서 확인한 사실
- Python `speaker_refs.ReferenceTable.resolve` 순서: 화자 없음 → 감정 참조 → 전역 기본 /
  화자 있음 → 미등록이면 실패 → `(화자, 감정)` 전용 참조 → 화자 기본 참조 → 실패(다른 인물·전역으로
  내려가지 않음). 합성 루프는 `resolve_with_emotion` 을 쓰며, 전용 참조가 없고 후보가 2개 이상이면
  감정 프로필 점수로 그 인물의 다른 클립을 고를 수 있다(규칙 이름은 `speaker`).
- renderer 의 `(화자, 감정)` 전용 참조(`ttsSpeakerEmotionRefs`)는 적용된 목소리 구성에서만 나오고,
  인물 기본 목소리를 다시 지정하거나 인물을 지워도 지워지지 않는다. 화면 판정 표의
  `speakerEmotionReady` 는 빈 표였다 → 화면은 "기본 목소리" 라 말하고 생성은 전용 참조를 쓸 수 있었다.
  **8160426 에서 판정 표를 store 와 연결하고 카드에 "이 감정에서는 다른 목소리 사용" 을 표시.**
- `reference_id` 는 준비된 참조 파일 **내용** 의 sha256 앞 16자리. 준비 임시 폴더·파생 클립 폴더는
  호출마다 UID 라 경로 충돌은 없다.
- 세션 복원은 `ttsSpeakerRefState`·`ttsSpeakerEmotionRefs` 를 초기화하지 않는다(이전 대본의 같은
  이름 인물에 옛 목소리가 붙을 수 있음) — 열린 항목.

### 2차 수정 (2026-09-04, 생성 의미 충돌·세션 누수)

1. **세션 복원 상태 누수** — `restoreSession` 이 원문은 세션 것으로 바꾸면서 화자 배정
   (`ttsSpeakerRefState`·`ttsSpeakerLabels`)과 감정별 참조·후보 선택은 그대로 두었다. 이제
   `reconstructSpeakerRefState` 가 **그 세션에 저장된 명시적 배정만**(`ttsSpeakerRefSources`)
   복원한다(ready:false — 준비는 구간 편집기가 다시 확인). 세션에 없으면 빈 상태. 감정별 참조·
   후보 선택·켬 상태는 복원 시 항상 비운다. 파일명·표시 이름은 identity 가 아니다.
2. **기본 여러 명 모드의 참조 권위** — 기본 상태에서는 인물 카드의 기본 목소리(`ttsSpeakerRefs`)만
   생성에 쓴다. 적용된 목소리 구성의 `(인물, 감정)` 참조와 감정 후보 선택은 사용자가 이 작업에서
   그 인물의 **`감정별 목소리 사용`** 을 켠 경우에만 config 로 나간다(`speakerEmotionGate`,
   ProcessButton·화면 판정 표가 같은 게이트). 켠 상태는 세션 상태(`ttsSpeakerEmotionEnabled`)이고
   카드에 항상 표시된다("사용 중: …" / "있음(꺼짐): 기본 목소리만"). 저장된 구성·후보는 지우지 않는다.
3. **불변 라우팅 스냅샷** — `ReferenceTable.freeze_routing(parsed)` 가 preflight 직후(모델 로딩 전)
   발화마다 speaker_ref·emotion_id·reference_id·규칙을 확정해 읽기 전용 튜플로 얼린다. Qwen·legacy
   생성 루프는 그 행을 읽고 다시 묻지 않는다. 하나라도 정할 수 없으면 `SpeakerReferenceError` 로
   그 자리에서 멈춘다(반쪽 스냅샷 없음, 대체 없음). 규칙 이름: `default_speaker` /
   `explicit_emotion_override` / `emotion_candidate_selected` / `emotion_reference` / `global_default`.
   chunk 행에 `routing_rule` 이 기록된다. stage `routing_snapshot` 이 발화 수·규칙 분포를 알린다.

검증 메모: Python recorder 테스트(`test_chunk_publish`·`test_run_bundle*`)는 numpy·soundfile 이 있는
`externals/runtime/gptsovits_venv_app/Scripts/python.exe` 로 돌려야 한다. 시스템 python 과 관리
인터프리터(`app-python/…`)에는 그 모듈이 없어 import 단계에서 오류가 난다(제품 결함이 아니다).

### 미결
- 사용자가 겪은 run 이 어느 것인지, 그때 각 인물에 지정한 파일이 무엇인지 확인이 필요하다.
  bundle 의 reference_id 와 기대 파일의 SHA 가 같으면 모델 변동, 다르면 배선 오류로 나눈다.
  01:39 run 은 "같은 reference_id 가 들어간 사실" 까지만 확정이다. 09:50·09:56 도 기대 SHA 대조 전에는
  정상 배선으로 최종 판정하지 않는다.
- GPU 재검증(두 인물, A→B→A→B 네 발화, 짧은 대사 한 작업, 1회)은 사용자 승인 뒤에만.

### 목소리 설정의 단일 권위와 초기 연결 (2026-09-05)

- **인물별 목소리의 유일한 편집 위치 = 여러 명 화면의 인물/발화 카드.** 고급 설정 › 음성의 인물별 목소리 편집기
  (SpeakerReferenceManager)는 폐기하고 읽기 전용 안내로 대체했다. 감정별 목소리 후보 편집도 카드의 목소리 패널 안
  접힌 상세에서만(목소리 구성 관리자는 구성 만들기/적용/저장만). 같은 인물의 구간 편집기 두 개가 같은 clipKey 를
  동시에 소유하던 경로가 사라졌다.
- **준비 판정 단일 파생** `readinessFromSlots`: 카드 표시·요약·합성 전 preflight·전송 규칙이 같은 store 슬롯에서 같은
  함수로 표를 만든다. 여러 명 합성 전 `multiSpeakerPreflight` 가 대본의 명시 화자마다 판정해 막히면 첫 발화
  번호와 함께 시작 전에 차단한다(대체 없음). Python 의 fail-closed(SPEAKER_NOT_REGISTERED)는 마지막 방벽으로
  남고, 화면은 내부 코드 대신 "이 인물의 목소리가 준비되지 않았습니다. 인물 카드에서 목소리를 지정해 주세요" 를 낸다.
  실사용 결함(한 명 정상·여러 명 SPEAKER_NOT_REGISTERED)의 원인: renderer 에 여러 명 preflight 가 없었고, 1번 인물의
  초기 연결도 없어 카드가 '목소리 없음' 인 채 config 가 나갔다.
- **1번 인물 초기 binding**: 여러 명 모드에서 아무 인물도 목소리가 없으면 1번 인물의 store 슬롯을 처음 불러온 음성
  (fileInfo.path, 같은 canonical asset, 파일·클립 복사 없음)에 실제로 만든다. 3~10초 통째로 유효 → 바로 준비됨,
  10초 초과(기본 목소리가 구간 클립을 쓰면) → '구간 선택 필요'. 한 파일·한 인물 id 당 한 번. 이후 한 명 기본 목소리와
  1번 인물 binding 은 독립(슬롯이 다름). 2번 이후 인물은 자동 연결 없음. 시작 카드는 1번 인물(`인물1`) 하나.
- 인물 id 는 원문의 `[화자 이름]` 에서 파서가 만든다(텍스트 권위). 표시 이름과 분리된 별도 stable id 는 두지 않았다 —
  한 명 화면에서 표기 이름을 직접 바꾸면 슬롯이 따라가지 않는다(preflight 가 잡아 카드로 안내). 이름 변경 시 슬롯
  이관은 후속 과제.

### 참조 음성 상태 분리 (2026-09-05, 감사 결론과 교정)

감사(읽기 전용) 결론: 가설과 기제는 달랐다 — 구간 확정 뒤에도 `source`(전체 원본)는 유지되고, 편집기도 항상
원본을 열며 확정 클립을 편집 대상으로 쓰지 않는다. 실제 결함은 **클립 수명 소유권**이었다.
- analyze IPC 가 재분석(편집기 다시 열기)마다 그 clipKey 의 확정 클립을 지우고 패널이 준비 상태를 내렸다 →
  "인물 다섯 명 목소리를 다 맞췄는데 패널을 접었다 펴니 준비가 안 됐다" 의 원인.
- 재확정은 이전 클립을 먼저 지운 뒤 시도했다 → 실패하면 멀쩡한 확정을 잃었다.
- 기본·인물 재생 버튼은 `clip || source` 라 임시 클립 수명에 묶였다. "미리듣기 음성을 불러오지 못했습니다. 파일이
  옮겨졌거나 지워졌는지…" 문구의 실제 원인은 이 임시 클립(tmp)의 소실이지 사용자 원본이 아니었다.
- 이전 결과 불러오기(복원)가 방금 자동 확정된 기본 참조를 '구간 재확정 필요' 로 되돌렸다.

교정: analyze 는 클립을 놓지 않는다(클립이 바뀌는 때는 재확정 성공·원본 교체·해제·새 파일·리셋만). trim 은 새 폴더에
먼저 만들고 성공(파일 존재)했을 때만 이전 클립을 놓고 교체하며 실패면 새 폴더만 지운다(원자 교체). 패널은
`committed`(사용 중 클립·구간)를 받아 마운트·재분석이 준비 상태를 내리지 않고, 슬라이더는 사용 중 구간에서 시작해
전체 원본 범위에서 넓힐 수 있으며, 재확정 실패는 사유만 말하고 이전 확정을 유지한다. 재생은 원본 파일의 확정
구간을 튼다. 복원은 같은 파일의 살아 있는 기본 참조를 내리지 않는다.
남은 것(후속): 인물 참조의 세션 복원이 구간을 버린다(세션에 구간 필드 없음). 전체 원본을 앱 관리 저장소로 승격하는
durable 자산(reference-library 는 잘린 24k 클립만 소유) 은 별도 설계.

### 장문 생성 중단 — 원인과 교정 (2026-09-05)

감사(코드 + run 기록): 상한 실패 4건(01:29·01:33·10:09·23:40)은 113~214초에 끝났다 — 모든 시간축(Python 280초
비활성, 600초 로딩, Electron 300초 비활성·630초 정지·3600초 총량) 미달. 종료 사유는 **모델 생성 상한**
(`GENERATION_LIMIT_EXCEEDED`, EOS 미종료 폭주)이다. 같은 406자 입력이 두 번 실패한 뒤 세 번째에 229/512 반복으로
성공했다(확률적). 한 chunk 실패가 작업 전체를 지우고(job_dir rmtree) 완료 chunk 를 버렸으며, '다시 시도' 는
동일 config 를 처음부터 다시 돌렸다. 시간 초과·분할 실패·worker 감시·취소·꼬리 절단은 어느 run 에서도 원인이
아니었다(꼬리 절단은 설계상 일어나지 않는다 — 상한 결과는 폐기된다).

교정(상한을 올리지 않는다):
- 기록: 실패 마감이 payload 수치(조각·반복·상한·재분할 횟수)와 분류(model_generation_cap / time_limit /
  split_failure / worker_watchdog / reference_prep / user_cancel)를 manifest 에 남긴다. watchdog 세 판정은
  기계 코드(JOB_STALLED / JOB_BUDGET_EXHAUSTED / JOB_INACTIVE)를 갖는다.
- 분할: 안전 목표 = 품질 운영 상한(379)의 절반. 문장·절 경계에서만 미리 끊고 공백·문자 레벨은 hard 상한까지(단어
  한가운데 미절단). 상한에 도달한 chunk 는 그대로 재시도하지 않고 문장→절 경계에서 **한 번** 재분할해 이어 간다.
  조각은 원래 발화의 화자·감정·참조·prefix 를 상속하고, 부모의 chunk_index 연속·chunk_count 일치 계약을
  `chunk_resplit` 이 지킨다. 재분할 조각도 상한이면 GENERATION_LIMIT_EXCEEDED(resplit_attempts=1).
- 하지 않은 것(후속·결정 필요): adaptive deadline(추정기 `estimatedWallSeconds`·`preparationSeconds` 가 있으나
  어떤 deadline 도 읽지 않음), 완료 chunk 보존/재개(`longform-job.ts` 의 resume 계약은 소비자 없는 dead code),
  `auto` 참조 모드에서 상한 도달을 safe_xvector 전환 사유에 넣을지, 레거시 엔진 경로의 segment 당 300초 고정.
- GPU 미검증: 재분할 경로는 순수 로직 테스트로만 확인했다. 실제 검증(대본 길이·예상 시간·작업 수)은 별도 승인 뒤.

### 개발 화면 확인 (보조 스크립트)

`npm run test:e2e:tts-multi-dialogue-dev` — `npm run dev` 를 띄우고 CDP 로 붙어 DOM 텍스트와
속성만 본다(스크린샷 없음, 합성 WAV, 격리 userData). 끝나면 자기 트리만 내린다.
필수 계약이 아니라 **보조 스크립트**다 — 계약은 `dialogueSourcePatcher*.test.ts` 와
`MultiSpeakerDialogue.contract.test.ts` 가 든다. 실행 결과 표시는 제품 동작과 일치한다
(2026-09-04 대조식 교정). 한계: `목소리 지정` 버튼의 파일 선택 호출은 contextBridge 객체가
고정되어 자동으로 가로챌 수 없다 — 버튼 존재만 확인하고, 실제 파일 선택·합성은 사용자가 본다.

## 18. 참조 길이 정책 — 엔진별 분리 (2026-09-05)

### 조사 결론
- 3~10초 제한의 정의는 `python/reference_audio.py` 의 `GPTSOVITS_POLICY` 한 곳이었다(2026-08-21 도입, 근거 "GPT-SoVITS 공식
  조건"). GPT-SoVITS 는 벤더 추론 코드(`GPT_SoVITS/inference_webui.py`)가 3~10초 밖 참조를 예외로 거부한다 → **필수** 조건.
- Qwen3-TTS 경로는 같은 정책을 그대로 재사용하고 있었다(`tts_worker` Qwen 게이트가 10초 초과를 "3~10초 구간을 선택·확정" 오류로
  차단). qwen_tts 는 참조 전체를 speaker encoder(x-vector) 와 speech tokenizer(ICL ref_code) 에 넣고 길이 검사·절단을 하지
  않으며, 로컬 스냅샷에 모델 카드가 없어 벤더 권장값은 확인하지 못했다 → Qwen 에 대한 10초 상한은 **근거 없는 공통 제한**이었다.
- 상한 값이 네 군데에 복제돼 있었다: 판정 정책(reference_audio) / 구간 추천·확정(reference_region 3.0·10.0) /
  정렬 상수(reference_alignment MIN/MAX_CLIP_SEC) / 화면 문구(ReferenceRegionPanel MIN/MAX_SEC·"허용 3~10초"·차단 문구 표).

### 정책 모델 (단일 권위 = `reference_audio.ReferencePolicy`)
- 두 층을 섞지 않는다. **필수**(min/max_duration_sec, None 허용) = 엔진이 실제로 요구하는 조건, 어기면 error(차단).
  **권장**(recommended_*) = 이 앱이 결과를 검증한 범위, 밖이면 `OUTSIDE_RECOMMENDED_LENGTH` warning(차단 아님). 수치마다 출처(basis).
- `GPTSOVITS_POLICY`: 필수 3~10초(벤더). `QWEN3_POLICY`: 길이 필수 한계 없음(벤더 코드에 제한 없음 — 무제한 지원 선언이 아니다),
  권장 3~10초 = 2026-09-05 GPU 실측(6.5~7.5초 클립)·정렬/혼입 방지 도구가 검증된 범위. 처리 불가(손상·빈 음성·거의 무음·
  심한 클리핑)는 두 엔진 모두 계속 차단.
- 엔진 해석 `resolve_policy_engine(preferred, qwen_available)`: auto → Qwen 런타임 있으면 qwen3, 없으면 gptsovits(화면 안내
  "한국어는 Qwen3 우선, 미설치 시 GPT-SoVITS" 와 동일 축). f5tts·kokoro 는 이번 범위 밖 → 기존 표시(gptsovits 정책) 유지.
- 파생: `region_bounds(source_dur)`(구간 도구 필수 경계, 없으면 0~원본 전체) / `recommended_bounds()`(추천이 노리는 범위) /
  `region_threshold_sec()`(구간 추천 기준 = 필수 상한 → 없으면 권장 상한) / `describe()`(IPC 요약).

### 배선 (화면 = 확정 = 생성이 같은 정책)
- `separate.py _reference_policy(args)` 가 화면이 보낸 `ttsEngine` 을 위 규칙으로 해석해 ref-analyze(`reference_region.
  analysis_payload`)·ref-trim(`build_reference_clip`, `analyze_region`)·감정 후보 판정에 같은 정책을 넘긴다. 응답에 `policy` 요약,
  `needs_region`(구간 추천), `region_required`(필수 상한 초과), `too_short`(필수 하한), `outside_recommended`, `valid_whole`.
- `tts_worker` Qwen 게이트는 `QWEN3_POLICY`(길이 차단 없음, 권장 밖 참조당 1회 progress 경고, 인물 참조·인물 감정 참조도 처리 가능
  검사). GPT-SoVITS 게이트(`_assess_ref`)는 벤더 필수 조건 그대로. run 기록 헤더에 `reference_policy` 기록.
- 화면(`shared/referencePolicy`): 길이 숫자 없음. 헤더 "필수 3~10초" / "권장 3~10초(검증 범위) · 길이 필수 조건 없음", 구간 안내를
  필수("그대로 쓸 수 없습니다")·권장("추천 구간, 더 긴 구간도 가능하나 미검증")으로 구분, 슬라이더 상한 = 필수 상한 없으면 원본
  전체, 권장 밖 길이 경고(막지 않음). 분석·확정 IPC 에 `ttsEngine` 을 얹고 엔진이 바뀌면 재분석.
- 엔진 전환: 사용 중 구간은 정책 변경으로 삭제·재절단·교체하지 않는다. 새 엔진의 **필수** 조건 밖일 때만 준비를 내리고
  사유(`committedMismatchText`)와 수정 동작(슬라이더는 사용 중 구간에서 시작)을 제공한다. 권장 밖은 경고만(준비 유지).
  원본 전체가 유효한 상태에서 사용 중 구간을 조용히 원본 전체로 되돌리지 않는다.
- 카드: `목소리 준비됨 · 26.5초부터 6.6초` / `원본 전체` — 긴 원본을 등록해도 모델에 가는 것은 확정 구간이며 그 사실을 카드가 말한다.
  긴 원본의 기본 동작은 그대로다(자동 구간 추천, 기본 참조는 자동 확정 1회). 미리듣기·구간 편집은 전체 원본 기준.
- 감정 후보 자산 수명(`evaluateLifecycle`) 길이 경계는 인자(기본 = 예전 3~10) — 목소리 구성 등록은 현재 엔진 정책 경계 사용.

### 참조 예산 (상수 83 의 정체와 교정)
- `qwen_bridge` 의 83 은 controlled-prefix(legacy opt-in) 가 참조를 **재발화**할 때 필요한 프레임을 "약 6.9초 참조"(12Hz × 6.9s)
  로 가정한 값이었다 — 여유 예산이 아니라 참조 길이 가정. vendor native ICL(기본 경로)은 재발화가 없어 replay 0 이 맞지만,
  참조 codec 프레임과 참조 전사 토큰이 talker prompt(입력 위치)를 차지하는데 이것은 0 으로 넣고 있었다(과소 계산).
- 교정: `chunk_budget.reference_budget(x_vector_only, ref_code_frames, ref_text_tokens, controlled_prefix)` — x-vector 0/0,
  native ICL prompt = 실제 참조 프레임 + 전사 토큰·replay 0, controlled-prefix replay = 실제 참조 프레임. 프레임 수는 bridge 가
  vendor speech tokenizer 로 **유효 참조(실제 모델에 넘기는 클립)** 를 실측(파일당 1회 캐시). 측정 실패는 예외(추정값 금지).
  분할 상한도 segment 별 참조 예산으로. 출력 상한(품질 379·tier·안전 목표 190)·재시도 횟수는 바꾸지 않았다.
- 긴 참조의 영향: native ICL 은 prompt 위치만(58초 참조 ≈ 700 frame, architecture 32768 대비 미미) → tier 불변. legacy
  controlled-prefix 만 생성 예산이 실제로 늘어난다(83 으로는 부족했을 값). run 기록 chunk 에 reference_code_frames /
  reference_prefix_tokens / reference_replay_frames 기록.

### 실측 (2026-09-05, 정책 변경 **전** 코드 f4e6e98, 사용자 제공 인물 폴더 5개 중 3명)
- 참조: 가=A(26.48s+6.57s) / 나=B(15.735s+7.06s) / 다=C(7.17s+7.455s). 앱의 카드 패널 구간 추천 → "이 구간으로
  확정"(build_reference_clip) 으로 파생. C 원본은 문제 당시 세 번째 인물 원본과 내용 해시가 같다.
- 다화자 1회(A→B→C→A→B→C, 6발화): CUDA 97초, ICL, 6 chunk 전부 completed_before_limit, routing_rule 전부 default_speaker,
  인물별 reference_id 3개 서로 다름, fallback/retry 없음, 21.9초. 전체+인물별 6+전환 경계 5 미리듣기(후처리 0).
- 장문 1회(405자·3발화·3인물): CUDA 149초, ICL, chunk 3개(토큰 102/109/89, 반복 172/178/172, 상한 512) 전부 completed_before_limit,
  분할·재분할 없음 → **재분할 경로는 실제 실행 미검증**. 42.64초. 산출물 `_local/artifacts/diagnostics/gpu-reverify-20260905/`.
- 정책 변경 후 GPU 검증은 하지 않았다(별도 승인). 위 실측을 변경 후 정책의 검증으로 재사용하지 않는다.

### 미결·한계
- Qwen 권장 3~10초는 이 앱의 검증 범위다. 벤더 권장값(모델 카드)은 오프라인이라 미확인. 10초 초과·3초 미만 참조의 Qwen 결과는
  GPU 미검증(경고 문구가 그렇게 말한다).
- 인물 카드 패널(기본 참조 아님)의 자동 확정은 기존대로 없음 — 사용자가 추천 구간을 확정한다.
- `reference_library.py` MAX_REGION_MS(10초, 24k 클립 자동 후보 선별) 는 이번에 건드리지 않았다(엔진 무관 자산 목록 규칙).
- f5tts·kokoro 참조 정책은 미검토(기존 표시 유지).
