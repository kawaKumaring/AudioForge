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

## 후속 fix — auto 경로 비유한 검증 갭(통합 리뷰 지적)

증상: 통합 리뷰(soundfile 있는 full venv)에서 `test_finishing_fail_preserves_existing_final`가
"AudioFinishingError not raised"로 실패 — auto 경로가 비유한 후보를 원자 교체 전에 거부하지 못했다.

root-cause(각 단계 finite 계측, SYNTHETIC float):
- **PCM_16 후보**(원래 테스트 fixture가 이렇게 씀): in-memory finite=False →
  **후보 파일 read 직후 finite=True**. libsndfile이 PCM write에서 NaN→유한으로 바꿔, 비유한이
  코드에 도달하기 전에 소실. 이후 전 단계 finite=True → 어떤 검증도 안 걸림 → os.replace 진행 = CI 실패.
- **FLOAT 후보**: read 후에도 finite=False(NaN 생존) → `place_final_with_pitch`가 잡지만 **PitchError**
  (AudioFinishingError 아님)로, finishing 헬퍼가 거부를 소유하지 못함.

fix(최소, auto 경로만; off 경로·pitch_shift.py·K2 무변경):
1. **A(source)**: pitch/write 이전에 원본 후보 array를 직접 검증 → FLOAT 비유한/스테레오/빈/sr을
   올바른 타입(AudioFinishingError)·순서로 write 전에 차단.
2. **B(in-memory)**: apply_final_tail 출력 재검증 — mono·finite + 예상 프레임 수 + padding 정확히 0.
3. **C(재오픈)**: pending을 **FLOAT로 write**(비유한을 PCM처럼 삼키지 않게) 후 재오픈해 디코드·메타
   sr==실제 sr·mono·finite·프레임 수·peak 검증. 통과해야만 os.replace(final) 1회.
4. write/재오픈/0바이트/디코드 실패는 AudioFinishingError로 승격 → pending 삭제 + 기존 final 무손상.
   테스트 fixture도 비유한 케이스는 subtype='FLOAT'로 기록(교훈: PCM은 NaN을 write 순간 소실).

## 후속 fix 2 — subtype 패리티(통합 merge 게이트)

지적: auto pitch0가 FLOAT(하드코딩)라 legacy off pitch0의 PCM_16과 불일치 → subtype-parity 게이트 차단.
측정(SYNTHETIC, 공유 venv에서 내 코드):
- legacy off pitch0 → PCM_16, pitch+1 → FLOAT(rubberband 기존 출력, pitch_shift.py 무변경)
- (수정 전) auto → 양쪽 FLOAT ← pitch0 불일치

fix(auto 경로만): pending write subtype을 하드코딩하지 않고 **staged(post-pitch) 파일의 subtype을 그대로
따른다**. `soundfile.info(staged).subtype`을 읽어 `sf.write(..., subtype=that)`. 결과:
- auto pitch0 → PCM_16(== legacy), auto pitch+1 → FLOAT(== legacy). **per-pitch 정확 패리티.**
재오픈 검증(C)에 `subtype == staged subtype`까지 추가. 비유한 안전(A: source array, B: in-memory finished)은
그대로라 PCM_16으로 써도 비유한을 숨길 수 없다(write 전 이미 finite 확정). pitch_shift.py·K2 무변경.

측정(수정 후): pitch0 legacy=PCM_16 auto=PCM_16 (EQUAL), pitch1 legacy=FLOAT auto=FLOAT (EQUAL).

## 검증 상태
- `python/test_audio_finishing.py`: numpy 순수 스위트(tail plan/apply·config 검증·array 검증·경계 우선순위)
  = 이 환경(ambient numpy 2.3.5)에서 **실행·통과**. numpy 부재 환경에선 자동 skip.
- `_finish_and_place` 통합(off byte-identity / auto staging→원자교체 / FLOAT NaN·+inf·-inf·stereo 거부 /
  apply 출력 비유한·프레임 불일치 / sf.write 실패 / 0바이트 pending / 재오픈 메타 sr 오염 / config 거부 /
  pitch 실패 — 각각 final 무손상 + os.replace(final) 미호출 + pending 잔여 0)
  = **공유 qwen venv(soundfile 0.14.0, numpy 2.5.2)에서 실행·통과**. 후속 fix 사이클에서 47/47 OK,
  full discovery 285/285 OK(K2 cancel·pitch 회귀 포함). PYTHONPATH를 boundary-pause worktree로 고정,
  import된 tts_worker/audio_finishing __file__이 worktree 안임을 preflight로 단언.
