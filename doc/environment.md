# AudioForge 실행 환경 가이드 (의존성 · 이식성)

## 핵심: 의존 대상은 ComfyUI 앱이 아니라 "AI 패키지들"이다

AudioForge가 ComfyUI에서 가져다 쓰는 것은 **`python.exe` 경로 하나**뿐이다
([audio.ipc.ts]의 `DEFAULT_PYTHON`). ComfyUI의 API·노드·모델 폴더·워크플로우는
**전혀 쓰지 않는다**(코드 전수 확인). ComfyUI는 필요한 AI 패키지들이 이미 한 세트로
깔려 있는 **편리한 파이썬 설치**라서 얹혀 쓸 뿐이다.

→ 따라서 "ComfyUI에 종속"이 아니라 **"이 패키지들이 든 파이썬 환경에 종속"** 이 정확하다.
ComfyUI를 켜지 않아도, 심지어 없어도, 아래 패키지를 갖춘 파이썬만 있으면 동작한다.

## 필요한 것 (실제 의존성)

`python/env_check.py`의 `REQUIRED`가 단일 소스. (2026-07-05 기준)

| 구분 | 패키지(pip) | import | 용도 |
|------|-------------|--------|------|
| core | torch (CUDA) | torch | AI 엔진 |
| core | numpy | numpy | 수치 연산 |
| core | soundfile | soundfile | 오디오 I/O |
| core | openai-whisper | whisper | 텍스트 추출 |
| core | demucs | demucs | 음악 4트랙 분리 |
| core | audio-separator | audio_separator | RoFormer 보컬 분리 |
| core | onnxruntime-gpu | onnxruntime | audio-separator 백엔드 |
| core | speechbrain | speechbrain | 화자 분리(ECAPA) |
| core | transformers | transformers | NLLB 번역 |
| tts | f5-tts | f5_tts | 합성(영어/클로닝) |
| tts | kokoro | kokoro | 합성(다국어 폴백) |
| hub | silero-vad | silero_vad | 음성 검출(torch.hub로도 로드) |

**pip으로 안 되는 시스템 전제** (venv 밖 — 대상 기계에 있어야 함):
- **NVIDIA GPU + 드라이버** — torch의 CUDA 실행에 필수. GPU별 CUDA 세대에 맞는 torch
  필요(이 기계는 RTX 5070 Ti / cu130). 없으면 CPU 폴백(수십 배 느림).
- **ffmpeg / ffprobe** — 시스템 설치(WinGet). pip 아님.
- **일본어 TTS(pyopenjtalk)** — 프리빌트 휠 없음 → VS C++ Build Tools 빌드 필요.
  한/영/중은 빌드 불필요.

**GPT-SoVITS(TTS)** 는 버전 충돌(transformers 4.50) 때문에 **전용 venv**
(`externals/gptsovits_venv`)로 격리됨. 메인 환경과 별개, `setup_gptsovits.py`로 재현.

## 환경 해석 구조 (다른 환경에서 사용 시)

```
1. 파이썬 해석 (setup_env.py, 우선순위)
   AUDIOFORGE_PYTHON 환경변수
   → externals/env.json (이전 해석 결과)
   → ComfyUI 임베디드 파이썬 자동탐지
   → 전용 venv (externals/audioforge_venv)
   → 시스템 python
2. 각 후보를 env_check로 점검 → core 충족하는 첫 후보에 attach (설치 0)
3. 아무것도 부족하면 → 전용 venv 생성 후 거기에만 설치
   ★ 빌린 환경(ComfyUI)엔 절대 자동설치하지 않음 (오염/파손 방지)
4. 선택된 파이썬 경로를 externals/env.json에 기록 → 앱이 읽음
```

앱은 `resolvePythonPath()`로 `env.json → 하드코딩 기본값 → 시스템` 순으로 폴백한다.

## 도구 사용법

```bash
# 환경 점검만 (부수효과 없음)
<python> python/env_check.py            # 사람용 리포트
<python> python/env_check.py --json     # 기계용

# 환경 해석 (attach 우선, 없으면 venv 생성/설치)
python python/setup_env.py              # 탐색→attach, 없으면 venv 생성
python python/setup_env.py --check      # 탐색/점검만 (설치·생성 안 함)
python python/setup_env.py --force-venv # 전용 venv 강제 생성/설치
python python/setup_env.py --torch-index cu124  # venv 생성 시 torch CUDA 채널

# TTS(GPT-SoVITS) 전용 venv (별개)
python python/setup_gptsovits.py
```

## 다른 기계로 옮길 때 체크리스트

| 대상 상황 | 필요 작업 |
|-----------|-----------|
| ComfyUI(또는 동일 패키지 파이썬) 있음 | `setup_env.py` → attach. 설치 0 |
| ComfyUI 없음, GPU 있음 | `setup_env.py --force-venv` → 전용 venv에 설치 (torch CUDA 채널 GPU에 맞게) |
| GPU 없음 | 동작하나 CPU라 매우 느림 (실용성 낮음) |
| ffmpeg 없음 | `winget install Gyan.FFmpeg` (pip 아님) |
| 일본어 TTS 필요 | VS Build Tools 설치 후 pyopenjtalk 빌드 |

## 정직한 한계

"venv 생성 + 설치"는 **ComfyUI 엮임과 파이썬 패키지 의존을 없앤다**(이식성 핵심).
그러나 **GPU 드라이버·ffmpeg·(일본어)빌드도구·모델 다운로드는 venv 밖 전제**라
대상 기계에 갖춰져야 한다. 즉 "엮이지 않는 독립"은 달성되지만
"아무 기계에서 클릭 한 번"은 로컬 AI GPU 앱의 본질상 불가능하다.
`env_check`/`setup_env`는 이 전제들을 "조용한 실패" 대신 "탐지·안내"로 바꿔준다.
