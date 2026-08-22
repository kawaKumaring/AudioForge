# B — audio finishing (tail/boundary) 구현 노트

기준: feature/tts-boundary-pause (S1 scaffold merge 위). production 구현 = `python/audio_finishing.py`
(순수 numpy array API) + `python/tts_worker.py` finishing 호출부 배선. pitch_shift.py 무변경.

## 처리 순서(계약 §2 — tts_worker 호출부에서 실현)
생성 → chunk speed → concat/boundary → line/emotion/explicit pause plan → **전체 pitch** →
최종 조건부 fade → 최종 0 padding → 검증 → 원자 교체.

- pitch는 여전히 `pitch_shift.place_final_with_pitch`가 담당하되, tail 'auto'일 땐 **final이 아닌
  work_dir 내부 staged**로 배치한다. 그 뒤 `audio_finishing`으로 fade+padding → 검증 → `os.replace`로
  `_finish_and_place`만 최종 synthesized.wav를 원자 교체한다. pitch_shift.py를 고치지 않고도 "pitch 후 fade"
  순서를 지킨다.
- tail **off/부재(기본)** → `place_final_with_pitch`를 그대로 호출 = 레거시와 바이트 동일(회귀 0).

## 활성 조건 / 미배선
- tail: `synthesize(..., tail_cfg=...)` 로 명시 전달될 때만 동작. 현재 `separate.py`/`buildTtsConfig`는
  tail 필드를 전달하지 않으므로 **실 TTS에서는 항상 off**. 통합 담당이 config(ttsTailMode 등)를 배선하면 켜진다.
- boundary(explicit pause / line / emotion gap): A의 텍스트 파서가 없으므로 **순수 API만** 제공하고
  실 concat 경로에 배선하지 않는다(A 파서 + 통합 배선 전 활성 금지). `resolve_boundary_gap_ms` /
  `resolve_boundary_plan` / `gap_ms_to_samples`가 검증된 `BoundaryDescriptor`를 소비한다.

## 계약 대비 유의점(정직 보고)
- 이미-무음 임계는 **계약값 1e-4**(마지막 ≤5ms peak)를 권위로 채택. 프로토타입
  `test_boundary_pause_synth.py`의 0.02와 다르다(선형 decay tail은 1e-4 기준으론 '무음' 아님).
- 사용자 "칼로 자른" 증상은 **코드상 유력 경로 + synthetic sine에서 재현**까지만. 실음성 해결·120ms/8ms 최적은
  실청취 전 주장하지 않는다.
- metadata 요약(`summarize_finishing`: tail_mode/padding/fade/fade_applied, emotion_boundary_mode,
  explicit_pause_count/total_ms)은 **내부 계산만** — 공유 metadata/schema/renderer 미배선(통합 담당 몫).

## 검증 상태
- `python/test_audio_finishing.py`: numpy 순수 스위트(tail plan/apply·config 검증·array 검증·경계 우선순위)
  = 이 환경(ambient numpy 2.3.5)에서 **실행·통과**. numpy 부재 환경에선 자동 skip.
- `_finish_and_place` 통합(staging→tail 순서 / finishing-fail·config-거부 시 기존 final 보존 / temp 정리)
  = **soundfile 필요 → 이 환경 미실행(skip)**, 공유 qwen venv에서 통합 담당이 검증.
