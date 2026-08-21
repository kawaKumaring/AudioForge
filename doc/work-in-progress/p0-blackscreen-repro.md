# P0 검은 화면 — 재현 증거와 정정

## 정정(중요)
- 이전 보고에서 `작업파일/e2e_shots/04_after_click.png`를 "수정 전 크래시(ErrorBoundary) 증거"라고 한 것은
  **오류**다. 실제로 그 파일은 repro 스크립트가 **수정 후 재실행 때 같은 파일명으로 덮어써서 '정상 처리 화면'**이다.
- **수정 전 순수 검은 화면 스크린샷은 존재하지 않는다.** ErrorBoundary를 수정과 함께 넣었기 때문에, 그 이후의
  어떤 재현도 검은 화면 대신 오류 화면(또는 방어 가드로 정상 오류 UI)을 보여준다. 따라서 **수정 전 증거는
  스크린샷이 아니라 아래 재현 stack trace**다.

## 재현 stack trace (수정 전, 최초 repro 실행에서 관측)
runPreview가 `data.transcript`만 추출하던 시점(방어 가드 도입 전) TTS 진입 시 관측:

```
[renderer][ErrorBoundary] TypeError: Cannot read properties of undefined (reading 'toFixed')
    at fmt (out/renderer/assets/index-DCivcxDo.js:24111:16)
    at ReferenceRegionPanel (out/renderer/assets/index-DCivcxDo.js:24264:9)
    at renderWithHooks (...:4026)
    at updateFunctionComponent (...:5655)
    at beginWork (...:6266)
    at performUnitOfWork (...:9032)
    at renderRootSync (...:8914)
    at performSyncWorkOnRoot (...:9593)
    at App / ErrorBoundary (...)
```

- 원인 경로: `runPreview`가 analyze의 최상위 payload(`duration_sec` 등)를 유실 → `analysis.duration_sec`
  undefined → `fmt(undefined)` → `undefined.toFixed()` TypeError → render throw → React 트리 언마운트 →
  배경색(#0a0a0f)만 남는 검은 화면.
- ErrorBoundary가 없던 원 상태에서는 이 render throw가 곧 **검은 화면**이었다(ErrorBoundary는 그 검은 화면을
  오류 화면으로 대체하는 수정의 일부).

## 방어 심층(defense-in-depth) 확인
- 수정 검증 중, `runPreview`만 버그 버전으로 되돌려도 **더 이상 크래시가 재현되지 않음**을 확인했다.
  이유: `ReferenceRegionPanel`의 방어 가드(`typeof a.duration_sec !== 'number'`이면 오류 처리 + "다시 분석")와
  `fmt` null-safe가 payload 유실을 검은 화면이 아니라 **정상 오류 UI**로 전환하기 때문.
- 즉 (1) 근본 수정(runPreview 전체 payload 반환) + (2) 방어 가드 + (3) ErrorBoundary 세 겹으로 재발을 막는다.

## 자동 검증(수정 후)
- `test/e2e/synthesize.e2e.mjs` (실 앱 구동): TTS 진입·111.08 분석·구간 확정·합성 클릭(store.status===processing,
  처리 취소 버튼 표시, audio:process 1회, 검은 overlay 0, pageerror/crash 0)·취소(processing=false·worker 종료·
  `.qwen-job-*` 0)·모드 전환 재진입. 전부 PASS.
- `test/e2e/synthesize-complete.e2e.mjs`: 실제 Qwen 합성 완료 → synthesized.wav 존재·디코딩(frames>0,sr=24000)·
  NaN/Inf 없음·peak>0 → resultMetadata(actual_engine=qwen3, device=cuda:0)·"합성 정보" GUI → pageerror/crash 0. PASS.
- `test/e2e/single-instance.e2e.mjs`: 두 번째 인스턴스 창 미생성. PASS.
- `preview-transcribe.test.ts`: runPreview 최상위 payload 보존 회귀(analyze/trim) 추가.
