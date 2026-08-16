# 무음 감지 미리보기 + 청취 (설계) — 2026-08-16

상태: **설계만 (미구현)**. 구현 착수 시 이 문서를 기준으로.

## 1. 사용자 의도 (원문 요약)
- 소리 파일을 불러오면 파형은 보이는데, **무음 제거가 실제로 무엇을 자를지** 확인할 방법이 없다.
- 감지된 무음 구간을 **파형에 표시**하고, 그 **구간 시작·끝을 들어봐서** 진짜 무음인지 확인하고 싶다.
- 완전 자동 도구이되, **수동 조절 기능을 숨겨뒀다가** 선택 시 펼치는 점진적 노출(progressive disclosure).

## 2. 핵심 발견 (설계의 전제 — 반드시 유지)
**"무음 간격" 슬라이더(0~2초)는 감지 파라미터가 아니다.** `audio_utils.py`의 `trim_silence`:
- **감지는 고정값**: 임계 −40dB(`threshold_db=-40`), 프레임 20ms/홉 10ms, 최소 무음 50ms(그보다 짧은 무음은 말소리로 병합). 슬라이더와 무관.
- **`silence_gap_sec`(슬라이더) = 남긴 말소리 세그먼트 사이에 다시 끼워 넣는 무음 길이**. 감지 결과를 바꾸지 않는다.

→ 따라서 "슬라이더를 움직이면 감지 무음이 바뀌어 보인다"는 **거짓 미리보기**가 된다. 감지를 조절하고
싶으면 조절해야 할 knob은 **감지 민감도(threshold_db)**이며, 이는 현재 UI/코드에 **없는 새 파라미터**다.

## 3. 설계 (2단계)

### Phase A — 감지 미리보기 + 청취 (새 파라미터 없음)
- 무음 구간 제거가 켜지면, **고정 알고리즘으로 감지된 '제거될 무음 구간'**을 파형에 오버레이(dim/red).
  - 이는 슬라이더와 독립. 현재 실제로 잘려나갈 부분을 그대로 보여줌.
- 각 구간을 클릭 → 시작·끝 ~0.5초를 재생(audition)해 진짜 무음인지 귀로 확인.
- 슬라이더(무음 간격)는 지금 의미(삽입 간격) 유지 + 툴팁으로 "감지가 아니라 사이에 넣을 무음"임을 명확히.

### Phase B — 숨겨둔 수동 knob = "감지 민감도"
- **새 파라미터 `threshold_db`**(또는 민감도 0~100 → dB 매핑)를 노출(기본 접힘, "고급/수동" 펼침).
- 민감도를 움직이면 **감지 구간이 실제로 변함** → Phase A 오버레이가 실시간 갱신 = 사용자가 상상한
  "움직이면 눈에 보이는" 경험이 여기서 성립.
- 배선: `trim_silence(threshold_db=...)`는 이미 인자로 받음 → config `silenceThresholdDb` 추가 →
  `separate.py`에서 전달 → UI 슬라이더. (min-silence 50ms도 노출할지는 추후.)

## 4. 아키텍처
- **감지 오버레이 위치**: 메인 파형은 `Waveform.tsx`(wavesurfer WebAudio). 구간 표시는 wavesurfer
  **Regions 플러그인**으로 가능 — `SplitEditor.tsx`가 이미 `RegionsPlugin`을 씀(도입 검증됨).
- **Options ↔ Waveform 통신**: 현재 무음 슬라이더는 `Options.tsx`, 파형은 `Waveform.tsx`로 분리.
  감지 파라미터(민감도)와 "미리보기 on" 상태를 **store(app.store)** 에 두고 Waveform이 구독.
- **감지 계산 위치**: 클라이언트(디코드된 버퍼로 RMS) — `SplitEditor`의 `handleAutoDetect` RMS
  로직과 유사. 즉시·인터랙티브(서브프로세스 왕복 없음).

## 5. 위험과 완화 (필수)
- **거짓 미리보기 위험(최우선)**: 클라이언트 RMS 감지가 Python `trim_silence`와 **다른 알고리즘/파라미터**면
  미리보기가 실제 결과와 어긋난다(L-2에서 겪은 함정).
  - 완화: 감지 파라미터(−40dB·20ms/10ms·50ms)를 **단일 소스**로 두고 양쪽이 동일하게 사용.
    JS/Python 알고리즘 복제가 불가피하면 **드리프트 가드**(고정 fixture 오디오로 JS 감지 vs Python
    감지 경계 대조하는 smoke 테스트, L-3의 `_check_emotions` 패턴)를 함께 만든다.
- **성능**: 긴 파일에서 슬라이더 드래그마다 전체 RMS 재계산은 무거움 → 프레임 RMS를 1회 캐시하고
  임계만 다시 적용(임계 변경은 O(n) 비교), 드래그 debounce.
- **framer-motion 대량 stagger 금지**(기존 규칙): 구간이 많아도 컨테이너 단일 렌더, per-region 애니 금지.

## 6. 미결 결정
- 민감도 UI 표현: dB 직접 vs 0~100 민감도(직관적). → 0~100 권장, 내부 dB 매핑.
- 미리보기를 어느 모드에서? (music/conversation은 무음 제거 옵션 있음; transcribe/split은 별도.)
- min-silence(50ms)도 노출할지 — 우선 threshold만, 과잉 노출 경계.

## 7. 참고 앵커
- 감지/삽입 로직: `python/audio_utils.py` `trim_silence()`
- 파형: `src/renderer/components/Waveform.tsx`
- Regions 선례: `src/renderer/components/SplitEditor.tsx` (`RegionsPlugin`, `handleAutoDetect`)
- 무음 슬라이더/옵션: `src/renderer/components/Options.tsx`
