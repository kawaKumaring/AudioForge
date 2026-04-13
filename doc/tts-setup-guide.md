# TTS 음성 합성 설치/개발 가이드 (미완료)

## 현재 상태: 개발 중

### 작동하는 것
- **F5-TTS**: 영어 음성 합성 + 음성 클로닝 (참조 음성 필요)
- **Kokoro**: 일본어, 중국어, 영어 (한국어 미지원)
- **엔진 추상화 구조**: TTSEngine 베이스 클래스, 엔진별 자동 선택

### 미완료
- **GPT-SoVITS**: 한국어 음성 합성 — 의존성 빌드 문제로 보류
- **한국어 TTS**: 현재 한국어를 제대로 합성할 수 있는 엔진 없음

## GPT-SoVITS 설치 방법 (이후 진행)

### 전제 조건
1. **Visual Studio Build Tools** 설치 필수
   - https://visualstudio.microsoft.com/ko/visual-cpp-build-tools/
   - "C++ 빌드 도구" 워크로드 선택
   - cmake, MSVC 컴파일러 포함

### 설치 순서
1. Visual Studio Build Tools 설치
2. GPT-SoVITS venv 의존성 재설치:
   ```bash
   cd E:/AI_Project/claudeCodeVsCode/AudioForge
   externals/gptsovits_venv/Scripts/python.exe -m pip install -r externals/GPT-SoVITS/requirements.txt
   ```
3. 빌드 실패했던 패키지:
   - `jieba_fast`: C 확장 필요 (또는 소스 코드에서 jieba로 전부 교체)
   - `pyopenjtalk`: cmake + C++ 컴파일러 필요 (일본어 TTS용, 한국어에는 불필요할 수 있음)
4. GPT-SoVITS 사전학습 모델 다운로드 (추론에 필요)

### 현재 파일 구조
```
externals/
├── GPT-SoVITS/          ← git clone 완료 (repo)
│   └── GPT_SoVITS/      ← 핵심 코드
├── gptsovits_venv/       ← Python 3.12 venv (torch 2.11+cu130 설치됨)
│   └── Lib/site-packages/ ← transformers 4.50, 기타 의존성 설치됨
```

### 의존성 충돌 정보
| 패키지 | 메인 환경 (ComfyUI) | GPT-SoVITS venv |
|--------|---------------------|-----------------|
| transformers | 5.3.0 | 4.50.0 |
| numpy | 1.26.4 (공유 가능) | 1.26.4 |
| torch | 2.11.0+cu130 (공유) | 2.11.0+cu130 |

**반드시 별도 venv로 격리.** 메인 환경에 GPT-SoVITS 의존성 설치 금지.

### 코드 구조 (이미 구현됨)
- `python/tts_worker.py`: GPTSoVITSEngine 클래스 정의됨
- `python/gptsovits_bridge.py`: venv에서 실행되는 브릿지 스크립트
- UI: 엔진 선택 버튼 (자동/GPT-SoVITS/F5/Kokoro)

### 이후 작업
1. Visual Studio Build Tools 설치
2. jieba_fast + pyopenjtalk 빌드
3. GPT-SoVITS 사전학습 모델 다운로드
4. gptsovits_bridge.py 추론 테스트
5. 앱 통합 테스트
