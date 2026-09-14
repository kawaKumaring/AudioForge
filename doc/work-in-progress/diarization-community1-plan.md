# 대화 분석 — pyannote Community-1 로컬 연결

상태: **연결은 끝났다. 모델 가중치만 기다린다.**
고를 수 있는 경로로 붙였고 **기본은 기존 엔진**이다. master 병합 안 함.

## 지금 막혀 있는 것 (이 장비에서 확인)

공식 페이지: <https://huggingface.co/pyannote/speaker-diarization-community-1>

- 모델이 **이용 조건 수락이 필요한 상태**다 — 메타데이터의 `gated` 값이 `auto`.
- 이 장비에 **Hugging Face 토큰이 없다**(환경변수·저장 파일 모두 없음).
- 파일 접근을 확인해 보면 **HTTP 401** 이다(가중치는 내려받지 않았다).

**계정·약관 동의가 필요한 일이라 대신 하지 않았다.**

### 사용자가 해야 하는 일 (그 외에는 필요 없다)
1. 위 모델 페이지에서 **이용 조건 수락**.
2. `hf.co/settings/tokens` 에서 **접근 토큰 생성**.
3. 그 토큰으로 가중치를 받아 아래 자리에 둔다(또는 토큰을 환경에 두고 한 번 받게 한다):

       externals/diarization_models/community-1/

그러면 화면의 **대화 > 분석 방식 > Community-1** 이 바로 동작한다. 코드 변경은 필요 없다.

## 설치한 것 (이 장비에서 실제로 돈 것)

앱 파이썬은 ComfyUI 내장 파이썬이라 섞지 않았다. **전용 환경**을 따로 만들었다.

    externals/diarization_venv/                  ← 격리 실행 환경
    externals/diarization_models/community-1/    ← 가중치 자리(아직 비어 있다)

- `pyannote.audio` **4.0.7** · torch **2.11.0+cu128** · torchaudio 2.11.0+cu128 ·
  torchcodec 0.16.0 · soundfile 0.14.0
- GPU 인식 확인: **RTX 5070 Ti · sm_120 · CUDA 12.8** (torch 가 `is_available()=True`).
- **이용 조건**: 코드(pyannote.audio)는 공개 배포판을 그대로 설치했다. **가중치는 게이트**라
  사용자가 수락해야 받을 수 있다 — 위 참조.

## 밖으로 나가는 길을 막은 자리

- 텔레메트리: `PYANNOTE_METRICS_ENABLED=false` (설치본 코드에서 이 환경변수가 스위치임을 확인).
- 허브 통신: `HF_HUB_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1` — 실행 중 다운로드를 막는다.
- **클라우드 SDK(pyannoteai)는 쓰지 않는다.** Precision-2 API 로 대체하지 않는다.
- 다리가 받는 것은 로컬 파일 경로뿐이고, 내보내는 것은 로컬 JSON 하나다.

## 연결한 모양

    대화 모드 > 분석 방식 : [기본] [Community-1]      ← 기본은 '기본'(기존 엔진)

- 화자 수 설정(2~5명)을 `num_speakers` 로 그대로 전달한다.
- 결과 두 가지를 **구분해** 쓴다.
  · `exclusive_speaker_diarization` → 화자별 트랙 배정과 구간 수정에 쓴다(한 시점에 한 화자).
  · `speaker_diarization` 에서 계산한 **겹침 구간**은 따로 보존해 화면에 별도로 표시한다.
- ★**겹침을 찾았다는 것은 겹친 목소리를 갈라냈다는 뜻이 아니다.** 화면에도 그렇게 적었다.
- **분석은 16kHz 모노**로 하지만 **출력 트랙은 원본 시간축·음질 기준**으로 만든다 —
  기존 `dialogue_rebuild` 가 원본에서 그 구간을 그대로 떠 온다(경계 페이드도 기존 규칙).
- 구간 수정 화면·저장 형식·재구성은 **이미 있는 것을 그대로** 쓴다. 새로 만들지 않았다.
- 진행·오류는 기존 작업 흐름으로 흐른다. 준비 안 됨은 `DIARIZE_NOT_READY` 로,
  실행 실패는 사유와 함께 올린다.

## 실패를 숨기지 않는다

- 격리 환경 없음 → `DIARIZE_VENV_MISSING`
- 모델 없음 → `DIARIZE_MODEL_MISSING` (무엇을 해야 하는지 문장으로 함께 알린다)
- 다리 실패 → `DIARIZE_FAILED(exit N): <사유>`
- GPU 를 못 쓰면 → `DIARIZE_CUDA_UNAVAILABLE`. **몰래 CPU 로 바꾸지 않는다.**
- 어느 경우에도 **기존 엔진으로 슬그머니 갈아타지 않는다**(검사로 확인).

## 확인한 것

- 계약 검사 `python/test_diarize_community1.py` (9건) — 준비 안 됨 사유, cuda 고정,
  화자 수 전달, 텔레메트리·오프라인 차단, 겹침 분리 보관, 겹침 구간 계산.
- 화면 표적 검사 `test/e2e/diarize-engine.e2e.mjs` (14건) — 대화 모드에만 선택이 있고 기본이
  기존 엔진, 다른 모드에는 없음, 고른 값 반영, **모델 없음이 사유와 함께 실패**하고 그때
  결과 파일이 만들어지지 않음, 겹침을 따로 표시하고 구간 목록에 섞지 않음.

## 아직 확인하지 못한 것 (모델이 없어서)

- **실제 화자 분석 1회를 돌리지 못했다.** 처리 시간·실제 장치·최대 GPU 메모리는 다리가
  기록하도록 만들어 뒀지만, 아직 값이 없다.
- exclusive 결과가 이 장비에서 어떤 모양으로 나오는지도 미확인이다(코드 기준으로만 연결했다).
- 정확도 비교는 하지 않는다 — 정답 화자 표기가 없고 직접 비교 근거도 없다.
