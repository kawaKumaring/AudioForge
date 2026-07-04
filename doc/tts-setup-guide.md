# TTS 음성 합성 설치/개발 가이드

## 현재 상태: GPT-SoVITS 한국어 합성 작동 (2026-07-05)

### 작동하는 것
- **GPT-SoVITS**: 한국어/일본어/중국어/영어 + 음성 클로닝 (참조 음성 필요) — **주력 엔진**
  - 격리 venv(`externals/gptsovits_venv`)에서 실행, v2 모델
  - 참조 음성을 Whisper로 자동 전사(prompt_text)해 클로닝 품질 향상
  - 참조 전사 실패 시 ref-free 모드로 자동 폴백
- **F5-TTS**: 영어 음성 합성 + 음성 클로닝 (참조 음성 필요)
- **Kokoro**: 일본어, 중국어, 영어 (보이스팩)
- **엔진 추상화**: 언어별 자동 선택 (ko/ja → GPT-SoVITS, zh → Kokoro, en → F5)

## GPT-SoVITS 셋업 (신규 환경 재현)

**venv와 pretrained_models는 gitignore 대상(수 GB)** 이라 버전 관리에서 빠진다.
새 환경에서는 `python/setup_gptsovits.py`로 재현한다:

```bash
# 전제: externals/gptsovits_venv (torch/transformers/g2pk2 설치됨),
#       externals/GPT-SoVITS (repo clone)
python setup_gptsovits.py             # 패키지 + shim + 모델 다운로드 전체
python setup_gptsovits.py --no-models # shim/패키지만
```

셋업 스크립트가 하는 일:
1. **python-mecab-ko 설치** (프리빌트 cp312 휠 — MSVC 빌드 불필요)
2. **jieba_fast → jieba shim** 생성 (중국어 프론트엔드가 jieba_fast를 import하나
   C 확장 빌드 필요 → 순수 파이썬 jieba로 리다이렉트)
3. **eunjeon → python-mecab-ko shim** 생성 (한국어 g2p(g2pk2)가 Windows에서
   eunjeon.Mecab을 요구하나 MSVC 빌드 필요 → python-mecab-ko로 리다이렉트)
4. **v2 사전학습 모델 다운로드** (~1GB, HuggingFace `lj1995/GPT-SoVITS`):
   - chinese-roberta-wwm-ext-large (622MB) — BERT
   - chinese-hubert-base (181MB) — CNHuBERT
   - gsv-v2final-pretrained/s1bert25hz-...ckpt (149MB) — GPT(t2s)
   - gsv-v2final-pretrained/s2G2333k.pth (102MB) — SoVITS(vits)

### 언어별 지원 현황 (VS Build Tools 없이)
| 출력 언어 | 동작 | 필요 모델/패키지 |
|-----------|------|-----------------|
| 한국어 | ✅ | g2pk2 + eunjeon shim(python-mecab-ko) |
| 영어 | ✅ | 기본 |
| 중국어 | ✅ | jieba shim + fast_langdetect(lid.176.bin) |
| **일본어** | ❌ | **pyopenjtalk 필요** (프리빌트 휠 없음 → VS Build Tools 빌드) |

- **일본어 출력** 또는 **일본어 참조 음성의 전사(prompt_text)** 는 pyopenjtalk가 필요.
  미설치 시 브리지가 처리: 일본어 출력 → 명확한 에러, 일본어 참조 → ref-free 자동 강등.
- fast_langdetect(lid.176.bin, ~131MB): 일본어/중국어 언어 구분용. 한국어/영어는 불필요.
- 과거 가이드의 jieba_fast/eunjeon 빌드 요구는 **shim + 프리빌트 휠로 회피**했다.

## 핵심 기술 이슈와 해결

### 1. torchcodec (AudioForge 공통 이슈)
GPT-SoVITS가 `torchaudio.load`를 쓰는데 torchaudio 2.11은 torchcodec DLL을 요구.
→ 브리지가 `audio_utils.patch_torchaudio()`(soundfile 폴백)를 TTS import 전에 적용.

### 2. sys.path
GPT-SoVITS 내부 모듈(AR, feature_extractor 등)은 `GPT_SoVITS/` 하위를 path에
넣어야 잡힘. 브리지가 repo 루트 + `GPT_SoVITS` 둘 다 insert하고 repo 루트로 chdir
(tts_infer.yaml/모델 경로가 cwd 기준 상대경로).

### 3. run() 반환 형식
`TTS.run()`은 `(sr, ndarray)` 튜플을 yield. (과거 브리지가 dict로 파싱하던 버그 수정)

### 4. 언어 코드
GPT-SoVITS는 `all_ko/all_ja/all_zh/en`(텍스트 전체를 한 언어로). 브리지가 매핑.
`prompt_text`가 비면 자동 ref-free 모드.

## 코드 구조
- `python/tts_worker.py`: GPTSoVITSEngine (참조 전사 캐싱 + 브리지 subprocess 호출)
- `python/gptsovits_bridge.py`: venv에서 실행되는 브리지 (JSON stdin/stdout)
- `python/setup_gptsovits.py`: 재현용 셋업 (shim 생성 + 모델 다운로드)
- UI: 엔진 선택 버튼 (자동/GPT-SoVITS/F5/Kokoro)

## 의존성 격리 (필수)
| 패키지 | 메인(ComfyUI) | GPT-SoVITS venv |
|--------|---------------|-----------------|
| transformers | 5.3.0 | 4.50.0 |
| torch | 2.11.0+cu130 | 2.11.0+cu130 |
| python-mecab-ko | (없음) | 1.3.7 (shim으로 eunjeon 대체) |

**메인 환경에 GPT-SoVITS 의존성 설치 금지.** 반드시 별도 venv.

## 클로닝 품질 및 한계 (2026-07-05 사용자 청취 결과)

speaker_b(분리 트랙) 참조로 한국어 합성 시 **"목소리가 너무 다르다"** 는 청취 피드백.
원인 진단(코드 버그 아님, 제로샷 클로닝의 구조적 한계):
1. **참조 음원 부적합** — 분리(마스킹)된 손상 오디오 + 발화가 0.4~2.5초 조각뿐
   (실제 발화 ~20초). 클로닝 품질은 참조 품질을 넘지 못함.
2. **일본어 화자 + pyopenjtalk 부재** — 일본어 네이티브 합성/일본어 참조 전사가
   불가(빌드 없음) → 한국어 ref-free(참조 전사 없음, 최저 품질 모드)로만 가능.
3. **교차언어** — 일본어 목소리 → 한국어 출력.

**결론**: 현 재료(짧은 조각 + 분리 손상 + 교차언어 + ref-free)는 클로닝에 가장 불리한
조합. 제로샷으로는 여기가 상한.

## 품질을 올리는 길 (재개 조건)

| 방법 | 필요 조건 | 상태 |
|------|-----------|------|
| 깨끗한 참조로 제로샷 | 원본 녹음에서 단일 화자 5~10초 연속·깨끗 구간 | **빌드 불필요, 즉시 가능** |
| 일본어 네이티브 합성 | pyopenjtalk (VS C++ Build Tools 빌드) | 컴파일러 부재로 보류 |
| **파인튜닝** (최고 품질) | ① VS Build Tools(일본어 학습 데이터 음소화) ② 1~3분 깨끗한 화자 음성 | **두 전제 모두 미충족으로 보류** |

- **파인튜닝 보류 사유**(검증): 이 환경에 C++ 컴파일러(cl/cmake/gcc) 없음 → 일본어
  학습 데이터 준비(pyopenjtalk) 불가 + speaker_b 발화 ~20초 조각으로 데이터 부족.
- 학습 스크립트는 존재(`GPT_SoVITS/s1_train.py`, `s2_train.py`, `prepare_datasets/`).
  전제 충족 시 재개 가능.

## 남은 개선 (선택)
- **세션형 브리지**: 현재 문장마다 브리지 subprocess를 새로 띄워 모델을 재로딩.
  여러 문장 대본에서 느림. stdin으로 여러 요청을 받는 상주 프로세스로 개선 가능
  (이제 작동 확정됨 → 후보).
