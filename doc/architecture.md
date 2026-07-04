# AudioForge 아키텍처

## 전체 구조

```
AudioForge/                      # (줄 수는 2026-07-05 기준)
├── python/                    # AI 백엔드 (Python 3.12 + CUDA)
│   ├── separate.py  (~580줄)  # CLI 엔트리포인트 + 라우팅 + split/meta-fix
│   ├── audio_utils.py (~230줄)# I/O, ffmpeg, 무음제거, torchaudio 패치, 유틸
│   ├── music_worker.py (70줄) # Demucs 음악 분리
│   ├── conversation_worker.py (~385줄) # 화자 분리 (VAD+ECAPA+클러스터링)
│   ├── transcribe_worker.py (~165줄)   # Whisper 텍스트 + NLLB 번역
│   ├── tts_worker.py (~420줄) # TTS 엔진 추상화 (F5/Kokoro/GPT-SoVITS) + 감정 50개
│   └── gptsovits_bridge.py (87줄) # GPT-SoVITS 격리 venv 브리지 (stdin JSON)
├── externals/
│   ├── GPT-SoVITS/            # GPT-SoVITS 소스 (베타)
│   └── gptsovits_venv/        # 전용 격리 venv (ComfyUI 환경 오염 방지)
├── src/
│   ├── main/
│   │   ├── index.ts           # Electron 메인 프로세스
│   │   ├── ipc/
│   │   │   └── audio.ipc.ts (~370줄) # 모든 IPC 핸들러 (runner + trackRunner)
│   │   └── services/
│   │       └── python-runner.ts (~145줄) # Python 프로세스 관리 (라인 버퍼링)
│   ├── preload/
│   │   └── index.ts (~60줄)   # contextBridge API
│   ├── renderer/
│   │   ├── App.tsx (157줄)    # 메인 레이아웃 (초기/작업 화면 분기)
│   │   ├── components/
│   │   │   ├── DropZone.tsx (229줄)     # 파일 드래그앤드롭
│   │   │   ├── ModeSelector.tsx (70줄)  # 5개 모드 탭 선택
│   │   │   ├── Options.tsx (142줄)      # 접이식 옵션 패널
│   │   │   ├── SplitEditor.tsx (364줄)  # 트랙 분할 에디터 (파형+마커)
│   │   │   ├── TTSEditor.tsx (~285줄)   # TTS 대사/감정/엔진 편집기
│   │   │   ├── ProcessButton.tsx (104줄)# 시작/취소 + 시간 예측
│   │   │   ├── ProgressBar.tsx (61줄)   # 진행률
│   │   │   ├── Waveform.tsx (82줄)      # wavesurfer.js 파형 (모드별 색상)
│   │   │   └── TrackList.tsx (~300줄)   # 결과 트랙 + 재생/가사/번역
│   │   ├── stores/
│   │   │   └── app.store.ts (96줄)      # Zustand 전역 상태
│   │   └── styles/
│   │       └── globals.css              # CSS 변수 + 장식 클래스
│   └── shared/
│       └── types.ts (40줄)              # 공유 타입 정의
└── doc/                        # 문서
    ├── architecture.md           # 이 파일
    ├── features.md               # 기능 현황
    ├── changelog.md              # 변경 이력
    ├── dev-rules.md              # 필수 개발 규칙
    ├── dev-guide.md              # 회고 + 교훈 (버그 목록은 종결됨)
    ├── code-review-2026-07-05.md # 전수 리뷰 + 수정/품질 로드맵 (버그 단일 소스)
    ├── tts-setup-guide.md        # GPT-SoVITS 셋업 (베타)
    └── tailwind-v4-layout-bug.md # Tailwind v4 레이아웃 버그 기록
```

## 데이터 흐름

```
[사용자] → DropZone (파일 드래그)
    → ModeSelector (모드 선택)
    → Options (옵션 설정)
    → ProcessButton (시작)
        → window.api.audio.process() [preload]
        → ipcMain 'audio:process' [audio.ipc.ts]
            → PythonRunner.run('separate.py', args) [python-runner.ts]
                → separate.py main() → 모드별 worker 호출
                    ← JSON lines (stdout): progress, result, error
                ← PythonRunner events
            ← mainWindow.webContents.send()
        ← store 업데이트
    → ProgressBar (진행률)
    → TrackList (결과)
```

## Python 모드별 라우팅

```
separate.py main()
├── mode == "music"       → music_worker.run_music_separation()
├── mode == "conversation"→ conversation_worker.run_conversation_separation()
├── mode == "transcribe"  → _run_transcribe_only() → transcribe_worker.transcribe_file()
├── mode == "split"       → _run_split() (자체 구현, ffmpeg 직접 추출)
├── mode == "track-process"→ _run_track_process() (개별 트랙 Whisper/번역)
└── mode == "meta-fix"    → _run_meta_fix() (JSON 메타 재적용)
```

## 모듈 의존성

```
audio_utils.py ← 모든 worker가 의존
    ↑
music_worker.py (독립)
conversation_worker.py (독립)
transcribe_worker.py (독립)
    ↑
separate.py (라우팅 + 후처리)
    ├── music_worker (lazy import)
    ├── conversation_worker (lazy import)
    └── transcribe_worker (lazy import)
```

**규칙**: worker 간 상호 의존 없음. audio_utils만 공유.

## 알려진 구조 문제 (2026-07-05 리뷰 반영)

### 1. separate.py에 split/meta-fix 로직이 남아있음
- `_run_split` 타임스탬프/자동감지 경로에 추출 루프 ~70줄 중복 (code-review L-1)
- **판단**: 파일 분리는 현 규모에서 실익보다 회귀 위험이 큼 — 중복 함수 추출만 대기,
  파일 분리는 실제 고통이 생길 때까지 보류 (code-review §8 '하지 말 것')

### 2. audio.ipc.ts / SplitEditor.tsx 분리 계획 — 보류로 확정
- 과거 "분리 예정"이었으나 2026-07-05 리뷰에서 보류 결정 (같은 근거)

### 3. 무음 감지 구현 3벌 중복 (code-review L-2)
- SplitEditor 클라이언트 RMS / Python ffmpeg silencedetect / audio_utils.trim_silence
- **계획**: 클라이언트 감지를 Python silencedetect 호출로 통일 검토

### 4. ~~conversation_worker ImportError 보호 제거~~ — 해결됨
- torch/numpy는 try/except 복구, 나머지는 separate.py 최상위 except가 emit("error") 처리

## 개발 규칙

1. **모듈 분리 시**: 한 파일씩 분리 → 테스트 → 커밋. 한번에 여러 파일 동시 분리 금지
2. **레이아웃**: Tailwind v4 유틸리티 사용 금지, inline style만 (doc/tailwind-v4-layout-bug.md 참조)
3. **Python 경로**: sys.path.insert(0, dirname(__file__)) 필수
4. **한글 경로**: -X utf8 + PYTHONUTF8=1 필수
5. **torchaudio**: load/save는 soundfile 사용, Resample만 torchaudio 허용
6. **Windows symlink**: speechbrain 로딩 시 os.symlink monkey-patch 필수
7. **ffprobe 경로**: dirname+join 사용, replace 금지 (폴더명에 ffmpeg 포함)
8. **임시 파일명**: input.wav 사용 금지, source/converted 접두어 사용 (ffmpeg 동일 파일 충돌 방지)
