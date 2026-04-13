# AudioForge 기능 현황

## 모드 (5가지 사용자 모드 + 2 내부 모드)

### 1. 음악 분리 (`music`) — 보라색
- **엔진**: Demucs htdemucs / htdemucs_ft (CUDA GPU 가속, CPU 폴백)
- **출력**: 보컬, 드럼, 베이스, 기타 악기 4트랙
- **옵션**: 무음 제거, 텍스트 변환, 한국어 번역, SRT 자막, 출력 포맷, Demucs 모델 선택
- **부가**: 노래방 모드 (drums+bass+other 동시 재생)

### 2. 대화 분리 (`conversation`) — 시안색
- **엔진**: Silero VAD + ECAPA-TDNN + 스펙트럴 클러스터링
- **출력**: 화자 A~E (2~5명 선택 가능)
- **옵션**: 화자 수, 무음 제거 (간격 조절 0~2초), 텍스트 변환, 한국어 번역, SRT, 출력 포맷

### 3. 텍스트 추출 (`transcribe`) — 초록색
- **엔진**: Whisper small/medium/large-v3 (CUDA, CPU 폴백)
- **출력**: 텍스트 파일 (.txt + _timestamps.txt)
- **옵션**: 한국어 번역 (NLLB-200), SRT 자막

### 4. 트랙 분할 (`split`) — 주황색
- **방식 1**: 타임스탬프 붙여넣기 → ffmpeg 직접 추출
- **방식 2**: ffmpeg silencedetect 자동 감지
- **출력**: 곡별 WAV + JSON 메타 + 오디오 태그 + _tracklist.txt
- **부가**: 트랙별 개별 가사 추출 / 번역 버튼

### 5. 음성 합성 (`tts`) — 로즈색
- **엔진**: F5-TTS (~1.2GB, CUDA, CPU 폴백)
- **기능**: 참조 음성으로 목소리 클로닝 + 텍스트 → 음성 생성
- **감정**: 50개 감정 태그 (6그룹: 기본/긍정/부정/불안·피로/부드러움/로맨스)
- **감정 제어**: 프롬프트 힌트 (태그만) 또는 감정별 참조 음성 등록 (우선)
- **다국어**: 한국어, 영어, 일본어, 중국어 (영어 목소리로 한국어 대사 가능)
- **속도**: 0.5x ~ 2.0x 조절
- **문장 간격**: 0 ~ 2.0초 조절

### 내부 모드
- `track-process`: 개별 트랙 Whisper/번역 (TrackList 버튼에서 호출)
- `meta-fix`: JSON 메타 수정 후 파일명+태그 재적용

## 감정 목록 (50개, 6그룹)

### 기본 (5)
기본 · 나레이션 · 공손 · 진지 · 자신감

### 긍정 (8)
기쁨 · 명랑 · 흥분 · 득의 · 감동 · 호기심 · 장난 · 동경

### 부정 (9)
슬픔 · 화남 · 짜증 · 공포 · 질투 · 경멸 · 냉소 · 비꼼 · 냉정

### 불안/피로 (9)
걱정 · 긴장 · 초조 · 당황 · 피곤 · 지루함 · 한숨 · 허탈 · 체념

### 부드러움 (10)
속삭임 · 위로 · 다정 · 부끄러움 · 애교 · 울먹 · 비장 · 놀람 · 그리움 · 애틋

### 로맨스 (9)
설렘 · 달콤 · 매력 · 유혹 · 은밀 · 흥분(성적) · 신음 · 절정 · 황홀

## 공통 기능

### 텍스트
- Whisper: small/medium/large-v3, 99개 언어 자동 감지, GPU 가속, 모델 캐싱
- NLLB-200 (600M): 28개 언어 → 한국어, GPU 가속, 모델 캐싱
- SRT 자막 내보내기, 클립보드 복사

### 오디오
- 무음 구간 제거 + 간격 조절 (0~2초)
- 출력 포맷: WAV / MP3 / FLAC
- 원본 샘플레이트 보존
- MP4/MKV/AVI/MOV/WebM 영상 파일 지원

### GPU 폴백
- CUDA 사용 가능 → GPU 가속
- GPU 점유 중 (ComfyUI 등) → 10초 타임아웃 후 자동 CPU 전환
- `get_device()` 공통 함수로 모든 worker에 적용

### UI/UX
- 드래그 앤 드롭 (webUtils.getPathForFile)
- 파일 정보 + 파형 통합 카드 (모드별 파형 색상)
- 5개 모드 탭 (아이콘 + 축약 라벨)
- 접이식 옵션 (활성 뱃지 미리보기)
- 재처리 버튼, 이전 결과 폴더 열기
- 시간별 출력 폴더, 처리 시간 예측, 경과 타이머

## 기술 스택

| 계층 | 기술 |
|------|------|
| 프론트엔드 | Electron 34 + React 19 + Zustand 5 + Framer Motion |
| 스타일 | Tailwind CSS v4 (장식만) + inline style (레이아웃) |
| 오디오 시각화 | wavesurfer.js 7.x |
| 빌드 | electron-vite 3.0 |
| Python | ComfyUI Python 3.12 (torch 2.11 + CUDA 13.0) |
| 음악 분리 | Demucs 4.0 (htdemucs / htdemucs_ft) |
| 화자 분리 | speechbrain 1.1 (ECAPA-TDNN) + Silero VAD 6.2 |
| 텍스트 | Whisper 20250625 (small/medium/large-v3) |
| 번역 | NLLB-200-distilled-600M |
| 음성 합성 | F5-TTS 1.1 |
| 오디오 I/O | soundfile + ffmpeg 8.1 |

## 향후 예정
- 노래 음성 변환 (SVC): RVC/So-VITS-SVC (doc/future-svc.md 참조)
- Python separate.py 추가 모듈 분리
- audio.ipc.ts 분리
