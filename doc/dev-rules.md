# AudioForge 개발 규칙 (필수 준수)

## 1. 기능 보전 규칙

### 1.1 새 기능 추가 시 기존 기능 동작 보장
- 새 패키지 설치 전에 **기존 패키지와의 충돌 여부** 반드시 확인
- 설치 후 **모든 기존 기능** 동작 테스트 필수
- 테스트 항목: 음악 분리, 대화 분리, 텍스트 추출, 트랙 분할, 음성 합성

### 1.2 의존성 설치 전 확인 사항
```
1. pip install 전에: 해당 패키지의 의존성 목록 확인 (pip show <pkg>)
2. 기존 패키지와 버전 충돌 여부 확인
3. 설치 후: 전체 기능 동작 확인 스크립트 실행
```

### 1.3 기능 동작 확인 스크립트
새 기능 추가/수정 후 반드시 실행:
```bash
python separate.py --config test_config.json  # 각 모드별 테스트
```

## 2. 코드 수정 규칙

### 2.1 한 번에 하나씩
- 파일 1개 수정 → 빌드 → 테스트 → 커밋
- 여러 파일 동시 수정 금지 (문제 발생 시 원인 추적 불가)

### 2.2 땜질 금지
- 에러 발생 시 **근본 원인을 먼저 파악**
- 1차원적 시도 (설치→실패→제거→재설치) 반복 금지
- 환경 전체를 확인한 뒤 한 번에 해결

### 2.3 모듈 분리 시
- 한 파일씩 분리 → 테스트 → 커밋
- 여러 파일 동시 분리 절대 금지
- 분리 후 import 경로 확인 필수

## 3. Windows 환경 규칙

### 3.1 경로
- spawn 인자에 한글 포함 금지 → JSON config 파일로 전달
- ffprobe 경로: `dirname + join` 사용, `replace` 금지
- 임시 파일명: `source`/`converted` 사용, `input` 금지
- `sys.path.insert(0, dirname(__file__))` 필수

### 3.2 인코딩
- Python: `-X utf8` + `PYTHONUTF8=1`
- spawn env: `PYTHONIOENCODING=utf-8`, `PYTHONUNBUFFERED=1`

### 3.3 GPU
- `get_device(timeout_sec=10)` 사용 (10초 안에 CUDA 응답 없으면 CPU 폴백)
- `torch.cuda.is_available()` 단독 사용 금지 (GPU 점유 시 멈춤)

### 3.4 패키지 호환성
- torchcodec: 사용 금지 (ffmpeg shared DLL 필요, WinGet ffmpeg은 static)
- torchaudio.load(): 직접 사용 금지 → `audio_utils.load_audio()` 사용
- torchaudio.save(): 직접 사용 금지 → `audio_utils.save_audio()` 사용
- torchaudio.transforms.Resample: 사용 가능 (torchcodec 불필요)
- soundfile: 모든 오디오 I/O의 기본
- transformers 5.x: `sys.setrecursionlimit(10000)` 필수

### 3.5 symlink
- speechbrain 모델 로딩 시 `os.symlink` → `shutil.copy2` monkey-patch 필수

## 4. UI 규칙

### 4.1 레이아웃
- Tailwind CSS v4 유틸리티(`mx-auto` 등)로 레이아웃 잡지 않음
- 모든 레이아웃은 **inline style**로 직접 작성
- Tailwind은 색상, 폰트, 장식에만 사용

### 4.2 React Hooks
- early return은 **모든 hooks 뒤에** 배치
- 렌더 본문에서 `setState` / `useAppStore.setState` 직접 호출 금지 → `useEffect` 사용

### 4.3 IPC 리스너
- 등록한 리스너는 **반드시** cleanup 함수로 해제
- 취소 시에도 cleanup 호출 필수 (ref로 관리)

## 5. Python 규칙

### 5.1 heavy import는 함수 내부에서
```python
# 금지: 파일 상단
import torch  # 10-30초 블로킹

# 필수: 함수 내부 lazy import
def run_something():
    emit("progress", message="로딩 중...")
    import torch  # emit 후 import
```

### 5.2 emit 규칙
- heavy import/로딩 **전에** 반드시 progress emit
- 사용자가 현재 무엇을 하는지 알 수 있도록 구체적 메시지
- progress percent는 항상 증가 (역행 금지)

### 5.3 에러 처리
- IPC에서 `return null` 대신 `throw Error` 사용
- Python worker에서 에러 시 `emit("error", message=...)` + 빈 리스트 반환
- try/except ImportError로 패키지 미설치 보호

## 6. 커밋 규칙

### 6.1 커밋 전 확인
- `npx electron-vite build` 성공 확인
- 기존 기능 영향 여부 확인

### 6.2 커밋 메시지
- 무엇을 **왜** 바꿨는지 명시
- 영향 범위 명시 (어떤 기능에 영향)

## 7. 현재 패키지 환경 (기준)

| 패키지 | 버전 | 용도 |
|--------|------|------|
| Python | 3.12.10 | 런타임 |
| torch | 2.11.0+cu130 | AI 엔진 |
| torchaudio | 2.11.0+cu130 | Resample만 사용 |
| torchcodec | **미설치** | 사용 금지 |
| soundfile | 0.13.1 | 오디오 I/O 기본 |
| demucs | 4.0.1 | 음악 분리 |
| speechbrain | 1.1.0 | 화자 분리 |
| whisper | 20250625 | 텍스트 추출 |
| f5-tts | 1.1.18 | 음성 합성 |
| transformers | 5.3.0 | NLLB 번역 + F5-TTS |
| silero-vad | 6.2.1 | 음성 검출 |
| ffmpeg | 8.1 (WinGet, static) | 오디오 변환 |
