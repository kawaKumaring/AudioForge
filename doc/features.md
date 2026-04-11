# AudioForge 기능 현황

## 모드 (4가지)

### 1. 음악 분리
- **엔진**: Demucs htdemucs (CUDA GPU 가속)
- **출력**: 보컬, 드럼, 베이스, 기타 악기 4트랙
- **옵션**: 무음 제거, 텍스트 변환, 한국어 번역, SRT 자막, 출력 포맷
- **부가**: 노래방 모드 (보컬 제외 재생)

### 2. 대화 분리
- **엔진**: Silero VAD + ECAPA-TDNN + 스펙트럴 클러스터링
- **출력**: 화자 A, 화자 B 2트랙
- **파이프라인**:
  1. Silero VAD: 신경망 기반 음성 구간 검출
  2. 1.5초 슬라이딩 윈도우 (0.5초 hop), ECAPA-TDNN 임베딩 추출
  3. 코사인 유사도 → 스펙트럴 클러스터링 (k-means 10회 restart)
  4. 100Hz 프레임별 화자 확률 맵 (가우시안 가중 투표)
  5. 메디안 필터 500ms + 최소 턴 500ms 시간 스무딩
  6. 15ms 크로스페이드 재구성
- **옵션**: 무음 제거 (간격 조절 0~2초), 텍스트 변환, 한국어 번역, SRT 자막, 출력 포맷

### 3. 텍스트 추출
- **엔진**: Whisper large-v3 (CUDA)
- **출력**: 텍스트 파일 (.txt + _timestamps.txt)
- **기능**: 99개 언어 자동 감지, 음성/가사 → 텍스트
- **옵션**: 한국어 번역 (NLLB-200), SRT 자막

### 4. 트랙 분할
- **엔진**: 무음 구간 감지 (적응형 임계값, 최소 1.5초 무음 = 곡 경계)
- **출력**: 곡별 WAV 파일
- **최소 트랙 길이**: 10초 (짧은 노이즈 자동 무시)
- **옵션**: 트랙별 가사 추출 (Whisper), 한국어 번역 (NLLB-200), SRT 자막

## 공통 기능

### 텍스트 관련
- **Whisper large-v3**: 99개 언어 자동 감지, GPU 가속
- **NLLB-200 (600M)**: 28개 언어 → 한국어 번역 (일본어, 영어, 중국어 등)
- **SRT 자막**: 표준 자막 포맷 내보내기
- **클립보드 복사**: 트랙별 텍스트 원클릭 복사

### 오디오 관련
- **무음 구간 제거**: 에너지 기반 VAD + 구간 간 무음 길이 조절 (0~2초)
- **출력 포맷**: WAV (무손실) / MP3 (고품질 VBR) / FLAC (무손실 압축)
- **노래방 모드**: 보컬 제외 반주 재생

### UI/UX
- **드래그 앤 드롭**: webUtils.getPathForFile API 사용 (Electron 34+)
- **파일 정보 + 파형 통합**: 파일 확인을 최우선으로 표시
- **탭 형태 모드 선택**: 4개 모드를 탭으로 전환
- **접이식 옵션**: 기본 접힘, 활성 옵션 미리보기 뱃지
- **재처리 버튼**: 결과 화면에서 다른 모드로 바로 재실행
- **시간별 출력 폴더**: `AudioForge_output/2026-04-12_15-30-42_파일명/`

## 기술 스택

| 계층 | 기술 |
|------|------|
| 프론트엔드 | Electron 34 + React 19 + Zustand 5 + Framer Motion |
| 스타일 | Tailwind CSS v4 (장식만) + inline style (레이아웃) |
| 오디오 시각화 | wavesurfer.js 7.x |
| 빌드 | electron-vite 3.0 |
| Python | ComfyUI Python 3.12 (torch 2.11 + CUDA 13.0) |
| 음악 분리 | Demucs 4.0 (htdemucs) |
| 화자 분리 | speechbrain 1.1 (ECAPA-TDNN) + Silero VAD 6.2 |
| 텍스트 | Whisper 20250625 (large-v3) |
| 번역 | NLLB-200-distilled-600M |
| 오디오 I/O | soundfile (torchaudio 대체) + ffmpeg 8.1 |

## 알려진 제약

1. **Tailwind v4 레이아웃**: `mx-auto` 등 유틸리티가 Electron에서 동작 안 함 → inline style 필수 (doc/tailwind-v4-layout-bug.md)
2. **한글 경로**: Python `-X utf8` + `PYTHONUTF8=1` 필수
3. **Windows symlink**: speechbrain 모델 로딩 시 os.symlink → shutil.copy2 monkey-patch
4. **torchaudio 2.11**: torchcodec 의존성 → soundfile로 대체
5. **Whisper/NLLB 첫 실행**: 모델 다운로드 필요 (Whisper ~3GB, NLLB ~1.2GB)
