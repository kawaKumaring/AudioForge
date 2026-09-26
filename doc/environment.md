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
| core | transformers | transformers | NLLB/LLM(Qwen) 번역 |
| tts | f5-tts | f5_tts | 합성(영어/클로닝) |
| tts | kokoro | kokoro | 합성(다국어 폴백) |
| hub | silero-vad | silero_vad | 음성 검출(torch.hub로도 로드) |

**pip으로 안 되는 시스템 전제** (venv 밖 — 대상 기계에 있어야 함):
- **NVIDIA GPU + 드라이버** — torch의 CUDA 실행에 필수. GPU별 CUDA 세대에 맞는 torch
  필요(이 기계는 RTX 5070 Ti / cu130). 없으면 CPU 폴백(수십 배 느림).
- **ffmpeg / ffprobe** — 시스템 설치(WinGet). pip 아님.
- **일본어 TTS(pyopenjtalk)** — 프리빌트 휠 없음 → VS C++ Build Tools 빌드 필요.
  한/영/중은 빌드 불필요.

**GPT-SoVITS(TTS)** 는 버전 충돌(transformers 4.50) 때문에 **전용 venv** 로 격리됨.
메인 환경과 별개다.

> **2026-08-29 이후**: GPT-SoVITS 환경은 `run.bat`이 스스로 설치·검증·연결한다.
> 앱 전용 파이썬(python-build-standalone)까지 자동으로 확보하므로 ComfyUI도 시스템
> 파이썬도 필요 없다. 자세한 내용은 **`doc/app-runtime-installer.md`**.
>
> 위치는 두 종류로 나뉜다. **앱이 소유한 것**은 `<본체 저장소>/externals/runtime/`
> (`app-python/`, `gptsovits_venv_app/`, `runtime.json`) — 설치기가 만들고 고치는
> 유일한 영역이다. **외부에서 참조하는 것**은 `<본체 저장소>/externals/`
> (`GPT-SoVITS/`, `qwen3_tts_venv/`, `separator_models/`, `env.json`) — 읽기만 한다.
>
> "본체 저장소" 기준인 것이 핵심이다. 작업 트리(worktree)에서 `run.bat`을 돌려도
> 런타임은 본체 밑에 설치되므로, 작업 트리를 정리해도 설치가 사라지지 않는다.
> 다른 곳에 두고 싶으면 `AUDIOFORGE_RUNTIME_ROOT`를 명시한다(최우선).
>
> 아직 자동이 아닌 것: **Node.js 설치**(런처가 Node로 돌아 자동화 불가)와
> **GPT-SoVITS 코드·모델 내려받기**. 둘 다 없으면 안내하고 멈춘다.
>
> 예전 `setup_gptsovits.py`는 남아 있지만 **실행하지 않는다** — 기존 repo·기존 venv를
> 전제로 그 venv에 pip 설치와 shim 덮어쓰기를 하기 때문이다.
> 예전 `externals/gptsovits_venv`도 그대로 두되, 새 설치는 그것을 건드리지 않는다.

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

## 노래 목소리 변환기 연결 (따라부르기)

따라부르기의 **변환 한 칸**만 바깥 해석기를 쓴다. 변환기는 앱 파이썬과 판이 맞지 않아
같은 프로세스에 올릴 수 없다. 나머지 칸(분리·합치기)은 앱 안에서 돈다 —
분리 모델 둘은 `externals/separator_models` 에 이미 있다.

`externals/env.json` 에 두 칸을 적는다(이 파일은 기계마다 다르므로 저장소에 올리지 않는다):

```json
{
  "python": "<앱 파이썬>",
  "singing_python": "<변환기 전용 해석기>",
  "singing_script": "<변환 스크립트>"
}
```

환경변수 `AUDIOFORGE_SINGING_PYTHON` · `AUDIOFORGE_SINGING_SCRIPT` 가 있으면 그쪽이 먼저다
(검사나 일회성 실행에서 갈아 끼우기 위한 것).

**적지 않아도 앱은 뜬다.** 따라부르기만 못 쓰고, 화면이 무엇을 적어야 하는지 말한다.

> ★경로를 코드에 박지 않는다. 본체가 이미 적어 둔 원칙 그대로다 —
> **"연결은 '추측' 이 아니라 '기록' 이어야 한다."**
> 특정 PC 의 절대경로는 그 PC 에서만 맞고 다른 데서는 조용히 틀린다.

변환기를 갈아 끼우거나 떼어낼 때는 `python/song_voice.py` **한 파일만** 손대면 된다.
그 바깥에서는 변환기의 이름도 인자도 알지 못한다(검사로 막아 두었다).

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
