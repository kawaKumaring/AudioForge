# AudioForge 기능 현황

## 모드 (4가지 + 2 내부 모드)

### 1. 음악 분리 (`music`)
- **엔진**: Demucs htdemucs / htdemucs_ft (CUDA GPU 가속)
- **출력**: 보컬, 드럼, 베이스, 기타 악기 4트랙
- **옵션**: 무음 제거, 텍스트 변환, 한국어 번역, SRT 자막, 출력 포맷, Demucs 모델 선택
- **부가**: 노래방 모드 (drums+bass+other 동시 재생)

### 2. 대화 분리 (`conversation`)
- **엔진**: Silero VAD + ECAPA-TDNN + 스펙트럴 클러스터링
- **출력**: 화자 A~E (2~5명 선택 가능)
- **옵션**: 화자 수, 무음 제거 (간격 조절 0~2초), 텍스트 변환, 한국어 번역, SRT, 출력 포맷

### 3. 텍스트 추출 (`transcribe`)
- **엔진**: Whisper small/medium/large-v3 (CUDA)
- **출력**: 텍스트 파일 (.txt + _timestamps.txt)
- **옵션**: 한국어 번역 (NLLB-200), SRT 자막

### 4. 트랙 분할 (`split`)
- **방식 1**: 타임스탬프 붙여넣기 → ffmpeg 직접 추출 (빠름)
- **방식 2**: ffmpeg silencedetect 자동 감지 → 마커 편집 → 분할
- **에디터**: wavesurfer.js 파형 + 마커 (더블클릭/드래그/미리듣기/삭제)
- **출력**: 곡별 WAV + JSON 메타 + 오디오 태그 + _tracklist.txt
- **부가**: 트랙별 개별 가사 추출 / 번역 버튼

### 내부 모드
- `track-process`: 개별 트랙 Whisper/번역 (TrackList 버튼에서 호출)
- `meta-fix`: JSON 메타 수정 후 파일명+태그 재적용

## 공통 기능

### 텍스트
- Whisper: small/medium/large-v3, 99개 언어 자동 감지, GPU 가속, 모델 캐싱
- NLLB-200 (600M): 28개 언어 → 한국어, GPU 가속, 모델 캐싱
- SRT 자막 내보내기
- 클립보드 복사

### 오디오
- 무음 구간 제거 + 간격 조절 (0~2초)
- 출력 포맷: WAV / MP3 / FLAC
- 원본 샘플레이트 보존
- MP4/MKV/AVI/MOV/WebM 영상 파일 지원 (ffmpeg 오디오 추출)

### UI/UX
- 드래그 앤 드롭 (webUtils.getPathForFile)
- 파일 정보 + 파형 통합 카드
- 탭 형태 모드 선택 (4개)
- 접이식 옵션 (활성 뱃지 미리보기)
- 재처리 버튼
- 시간별 출력 폴더
- 이전 결과 폴더 열기 (복원)
- 처리 시간 예측 표시

## 기술 스택

| 계층 | 기술 |
|------|------|
| 프론트엔드 | Electron 34 + React 19 + Zustand 5 + Framer Motion |
| 스타일 | Tailwind CSS v4 (장식만) + inline style (레이아웃) |
| 오디오 시각화 | wavesurfer.js 7.x + Regions 플러그인 |
| 빌드 | electron-vite 3.0 |
| Python | ComfyUI Python 3.12 (torch 2.11 + CUDA 13.0) |
| 음악 분리 | Demucs 4.0 (htdemucs / htdemucs_ft) |
| 화자 분리 | speechbrain 1.1 (ECAPA-TDNN) + Silero VAD 6.2 |
| 텍스트 | Whisper 20250625 (small/medium/large-v3) |
| 번역 | NLLB-200-distilled-600M |
| 오디오 I/O | soundfile (torchaudio 대체) + ffmpeg 8.1 |

## 코드 구조 (현재 3296줄)

### Python (1227줄)
| 파일 | 줄 | 역할 | 의존성 |
|------|---:|------|--------|
| separate.py | 486 | CLI 라우팅 + 후처리 + split/meta-fix/track-process | audio_utils, workers |
| audio_utils.py | 155 | I/O, ffmpeg, 무음제거 | 없음 |
| music_worker.py | 70 | Demucs 분리 | audio_utils |
| conversation_worker.py | 377 | 화자 분리 | audio_utils |
| transcribe_worker.py | 139 | Whisper + NLLB | audio_utils |

### Frontend (2069줄)
| 파일 | 줄 | 역할 |
|------|---:|------|
| audio.ipc.ts | 297 | 모든 IPC 핸들러 |
| SplitEditor.tsx | 392 | 트랙 분할 에디터 |
| TrackList.tsx | 289 | 결과 표시 + 재생/가사/번역 |
| DropZone.tsx | 229 | 파일 입력 |
| App.tsx | 156 | 메인 레이아웃 |
| Options.tsx | 142 | 옵션 패널 |
| python-runner.ts | 122 | Python 프로세스 관리 |
| ProcessButton.tsx | 91 | 시작/취소 버튼 |
| app.store.ts | 86 | 전역 상태 |
| Waveform.tsx | 69 | 파형 표시 |
| ModeSelector.tsx | 65 | 모드 탭 |
| preload/index.ts | 53 | contextBridge |
| types.ts | 40 | 공유 타입 |
| ProgressBar.tsx | 38 | 진행률 바 |

## 알려진 제약

1. Tailwind v4 레이아웃 유틸리티 Electron에서 동작 안 함 → inline style
2. 한글 경로: Python `-X utf8` + `PYTHONUTF8=1`
3. Windows symlink: speechbrain → os.symlink monkey-patch
4. torchaudio 2.11: torchcodec → soundfile 대체
5. Whisper/NLLB 첫 실행: 모델 다운로드 (Whisper ~3GB, NLLB ~1.2GB)
6. ffprobe 경로: dirname+join 사용 (replace 금지)
7. 임시 파일: source/converted 접두어 (input 금지)
