# AudioForge Changelog

## 2026-04-12 — UX 개선 + 트랙 분할 + Phase 2

### UX 개선
- 파일 정보 + 파형을 하나의 카드로 합침 (파일 확인 우선)
- 모드 선택을 카드 나열 → 탭 UI로 변경 (4개 모드 깔끔하게)
- 옵션을 접이식으로 변경 (기본 접힘, 활성 옵션 뱃지로 미리보기)
- 결과 화면에 "다른 모드로 재처리" 버튼 추가

### 트랙 분할 모드 (신규)
- 여러 곡이 이어진 파일을 무음 구간 기반으로 자동 분할
- 적응형 임계값, 최소 1.5초 무음 = 곡 경계, 최소 10초/트랙
- 각 트랙별 Whisper 가사 추출 + NLLB-200 한국어 번역 옵션

### Phase 2 기능
- **NLLB-200 한국어 번역**: 28개 언어 → 한국어 자동 번역
- **SRT 자막 내보내기**: Whisper 타임스탬프 → 표준 SRT 포맷

## 2026-04-11 — Phase 1 + 핵심 기능

### Phase 1 기능
- **텍스트 단독 추출 모드**: 분리 없이 Whisper로 바로 텍스트 변환
- **텍스트 클립보드 복사**: 원클릭 복사
- **출력 포맷 선택**: WAV / MP3 / FLAC
- **노래방 모드**: 보컬 제외 반주 재생
- **시간별 출력 폴더**: 덮어쓰기 방지

### 대화 분리 v3
- Silero VAD (신경망) 도입
- 슬라이딩 윈도우 (1.5s/0.5s hop) + 프레임별 확률 맵
- 메디안 필터 + 최소 턴 스무딩

### 음질 개선
- ffmpeg 변환 시 원본 샘플레이트 보존 (pcm_f32le)
- torchaudio → soundfile 대체 (torchcodec 의존성 회피)

### 버그 수정
- 드래그앤드롭: webUtils.getPathForFile 사용 (Electron 34)
- 한글 경로: Python -X utf8 모드
- Windows symlink: shutil.copy2 monkey-patch
- Tailwind v4 레이아웃: inline style로 전면 교체

## 2026-04-11 — 초기 생성
- Electron + React + TypeScript 프로젝트 생성
- Demucs 음악 분리 (보컬/드럼/베이스/기타)
- ECAPA-TDNN 대화 분리 (화자 A/B)
- wavesurfer.js 파형 표시
- 무음 구간 제거 옵션
