# 테스트 전용 폴더 (2026-10-10)

AudioForge 의 검사·개발 도구가 만드는 파일은 **모두 여기**에 생긴다. Git 에 올라가지 않는다(`_local` 아래).
자리는 코드 한 곳이 정한다: `tools/test-root.cjs` · `python/_test_root.py` (본체 저장소의 `_local/테스트`, 환경변수 `AF_TEST_ROOT` 로 바꿀 수 있음).

## 하위 폴더
- `임시/` — 검사 실행마다의 임시 자리(`r<pid>`, 끝나면 지움). `개발판-tmp`·`master-tmp` 등은 2026-10-10 이전에 쌓인 것.
- `결과/` — 생성물·비교·청취 묶음(주제별)
  - `청취/` 사용자 청취용 페이지와 음원(서수 비교, 장문 seed 비교, 장문 이음 듣기, 품질 검수 묶음 등)
  - `integ-2026-10-09/` 통합 검증 스크립트·조사 보고서, `quality-audit-2026-10-04/`, `perf-ref/`(승인된 참조 조각 ref-clip.wav 포함)
  - `experiments/`, `개발판-artifacts/`, `song/`, `sep/`, `mdx/`, `분리비교-0926/`, `experiments-master/`
  - `seed-vc-0920/` 9/20 노래 변환 시험 결과(곡변환결과 포함)
- `화면/` — 화면 캡처(e2e 는 `화면/e2e/`, MCP ui_screenshot 의 상대 경로도 여기)
- `기록/` — 로그·보고서·수치 JSON. **`이동기록-2026-10-10.json`** = 이 폴더로 모을 때의 옛 경로 → 새 경로 전체 목록
- `도구/검수MCP/` — 음성 검수 MCP 보고서(분석 결과 재사용)
- `스크립트/` — 일회성 검사·실험 스크립트(`seed-vc-0920/` 포함)
- `입력/` — 시험 입력: `장문테스트`·`감정`·`노래`(옛 resources), `datasets`(emotiontts·ravdess)

## 여기에 없는 것(일부러)
- 앱이 관리하는 `_local/artifacts`(실행 기록 runs·diagnostics·generated·recovery)·`assets`(품질 비교 기준·참조 원본)·`manifests` — 코드가 그 자리를 직접 쓴다.
- 사용자 자료(`사용자/`, resources 의 참조 목소리 폴더), 모델(`externals`, 개발판 `_local/models`).

## 규칙
- 검사·도구 코드는 `_local/…` 를 직접 적지 말고 `tools/test-root.cjs`(`dir('results', …)`, `shot(…)`)·`python/_test_root.py`(`test_dir(…)`)를 쓴다.
- 사용자 미디어(입력/의 곡 등)는 승인된 작업에서만 연다.
