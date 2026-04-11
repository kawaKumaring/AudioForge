# AudioForge 아키텍처

## 전체 구조

```
AudioForge/
├── python/                    # AI 백엔드 (Python 3.12 + CUDA)
│   ├── separate.py  (486줄)   # CLI 엔트리포인트 + 라우팅 + 후처리
│   ├── audio_utils.py (155줄) # I/O, ffmpeg, 무음제거, 포맷 유틸
│   ├── music_worker.py (70줄) # Demucs 음악 분리
│   ├── conversation_worker.py (377줄) # 화자 분리 (VAD+ECAPA+클러스터링)
│   └── transcribe_worker.py (139줄)   # Whisper 텍스트 + NLLB 번역
├── src/
│   ├── main/
│   │   ├── index.ts           # Electron 메인 프로세스
│   │   ├── ipc/
│   │   │   └── audio.ipc.ts (297줄) # 모든 IPC 핸들러
│   │   └── services/
│   │       └── python-runner.ts (122줄) # Python 프로세스 관리
│   ├── preload/
│   │   └── index.ts (53줄)    # contextBridge API
│   ├── renderer/
│   │   ├── App.tsx (156줄)    # 메인 레이아웃 (초기/작업 화면 분기)
│   │   ├── components/
│   │   │   ├── DropZone.tsx (229줄)     # 파일 드래그앤드롭
│   │   │   ├── ModeSelector.tsx (65줄)  # 4개 모드 탭 선택
│   │   │   ├── Options.tsx (142줄)      # 접이식 옵션 패널
│   │   │   ├── SplitEditor.tsx (392줄)  # 트랙 분할 에디터 (파형+마커)
│   │   │   ├── ProcessButton.tsx (91줄) # 시작/취소 + 시간 예측
│   │   │   ├── ProgressBar.tsx (38줄)   # 진행률
│   │   │   ├── Waveform.tsx (69줄)      # wavesurfer.js 파형
│   │   │   └── TrackList.tsx (289줄)    # 결과 트랙 + 재생/가사/번역
│   │   ├── stores/
│   │   │   └── app.store.ts (86줄)      # Zustand 전역 상태
│   │   └── styles/
│   │       └── globals.css              # CSS 변수 + 장식 클래스
│   └── shared/
│       └── types.ts (40줄)              # 공유 타입 정의
└── doc/                        # 문서
    ├── architecture.md          # 이 파일
    ├── features.md              # 기능 현황
    ├── changelog.md             # 변경 이력
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

## 알려진 구조 문제 (향후 개선 대상)

### 1. separate.py에 split/meta-fix/track-process 로직이 남아있음 (486줄)
- `_run_split`: 170줄 — 타임스탬프 분할 + 자동감지 + ffmpeg 추출
- `_run_track_process`: 60줄 — 개별 트랙 Whisper/번역
- `_run_meta_fix`: 40줄 — 메타데이터 재적용
- **계획**: split_worker.py로 분리 예정이나, 한 파일씩 테스트 후 진행 필요

### 2. audio.ipc.ts가 7개 핸들러를 모두 포함 (297줄)
- process, process-track, cancel, restore-from-folder, export-tracks, select-file, get-file-info 등
- **계획**: track.ipc.ts로 분리 예정

### 3. SplitEditor.tsx가 과도하게 큼 (392줄)
- 파형 관리 + 마커 관리 + 타임스탬프 파서 + 자동감지 + UI가 한 컴포넌트
- **계획**: 타임스탬프 파서를 utils로 분리, 클라이언트 자동감지는 이미 ffmpeg으로 대체되어 제거 가능

### 4. conversation_worker.py에서 try/except ImportError 보호가 제거됨
- 6416d19 커밋에서 "이중 import 정리" 시 실수로 제거
- 함수 상단의 import 실패 시 적절한 에러 메시지 없이 크래시
- **수정 필요**: 에러 처리 복구

## 개발 규칙

1. **모듈 분리 시**: 한 파일씩 분리 → 테스트 → 커밋. 한번에 여러 파일 동시 분리 금지
2. **레이아웃**: Tailwind v4 유틸리티 사용 금지, inline style만 (doc/tailwind-v4-layout-bug.md 참조)
3. **Python 경로**: sys.path.insert(0, dirname(__file__)) 필수
4. **한글 경로**: -X utf8 + PYTHONUTF8=1 필수
5. **torchaudio**: load/save는 soundfile 사용, Resample만 torchaudio 허용
6. **Windows symlink**: speechbrain 로딩 시 os.symlink monkey-patch 필수
7. **ffprobe 경로**: dirname+join 사용, replace 금지 (폴더명에 ffmpeg 포함)
8. **임시 파일명**: input.wav 사용 금지, source/converted 접두어 사용 (ffmpeg 동일 파일 충돌 방지)
