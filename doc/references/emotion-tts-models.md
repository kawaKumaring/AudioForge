# 감정 TTS·보이스 클로닝 공개 모델 조사

- 조사 기준일: 2026-08-23
- 조사 범위: 공개 GitHub 저장소, 공식 Hugging Face 모델 카드, 공식 논문·프로젝트 페이지
- 제외 범위: 사용자 미디어, 로컬 ComfyUI 워크플로·프롬프트, 비공개 API, 제3자 홍보문
- 목적: AudioForge의 감정 표현, 감정 샘플 보드, 대체 로컬 TTS 엔진 후보를 판단하기 위한 기술 참고 자료

> 주의: “오픈소스 코드”와 “상업적으로 사용할 수 있는 공개 가중치”는 같은 뜻이 아니다. 아래 라이선스는 조사 시점의 공식 표기를 요약한 것이며 법률 자문이 아니다. VRAM·품질·속도는 공식 자료에 명시된 값만 적고, 확인되지 않은 값은 `미확인`으로 남긴다.

### 조사 관점

이 문서는 “지금 PC에 탑재할 모델 순위”만 다루지 않는다. 각 모델을 두 축으로 따로 본다.

- **기술 원리 가치**: 데이터·tokenizer·architecture·conditioning·post-training에서 AudioForge가 배울 수 있는 것.
- **제품 탑재 가능성**: 라이선스, 로컬 자원, Windows 지원, 공개된 inference/training 범위, 기존 worker와의 결합 비용.

따라서 큰 모델, 비상업 가중치, 한국어 미지원 모델도 기술 원리 조사에서 제외하지 않는다. 반대로 demo 품질이 높아도 공개 자료만으로 재현할 수 없는 학습 단계는 “즉시 적용 가능”으로 분류하지 않는다. 아래에서 **확인**은 공식 논문·저장소·모델 카드에 직접 적힌 사실, **추론**은 그 사실을 AudioForge에 대입한 판단을 뜻한다.

## 1. 먼저 보는 결론

1. **현재 AudioForge의 Qwen3-TTS Base 경로는 보이스 클로닝에는 적합하지만 instruction 기반 감정 제어 모델은 아니다.** 공식 모델 표에서 instruction control은 1.7B VoiceDesign·CustomVoice에만 표시되고 Base에는 표시되지 않는다. Base에서는 감정별 참조 오디오가 현재 구조에 맞는 정직한 제어 방법이다.
2. **AudioForge와 가장 직접적으로 맞는 대체 엔진 후보는 IndexTTS-2.5와 CosyVoice 3이다.** IndexTTS2는 음색 참조와 감정 입력을 분리하며 감정 오디오·8차원 벡터·감정 설명을 제공한다. CosyVoice 3는 제로샷 복제와 자연어 instruction을 함께 제공한다.
3. **문장 내부 감정·비언어 태그의 가장 강한 공개 참고 사례는 Fish Audio S2 Pro다.** 공식 release의 세부 표기는 Slow AR 4B + Fast AR 400M이고 HF metadata는 5B로 표시한다. 두 수치의 차이는 반올림·부속 parameter 포함 범위 차이로 추정되며 공식 설명은 찾지 못했다. 24GB 권장 VRAM과 비상업 연구 라이선스는 탑재 제약이지만, Dual-AR·RVQ·inline instruction·RL reward 설계의 기술 원리 가치는 별개로 높다.
4. **F5-TTS와 StyleTTS2는 자연스러운 운율 연구에 유용하지만, 현재 공개 인터페이스는 감정을 명시적으로 분리 제어하는 제품 API와 거리가 있다.** 참조가 가진 스타일을 전달하거나 잠재 style을 샘플링하는 쪽에 가깝다.
5. **ChatTTS의 웃음·쉼 토큰은 AudioForge의 향후 비언어 표현 문법에 좋은 선례다.** 그러나 공식 공개 모델은 완전한 감정 제어·제로샷 사용자 음성 복제 엔진으로 보기는 어렵다.
6. **감정 샘플 보드는 새 모델 없이도 바로 구현 가치가 있다.** 동일 대사와 감정별 참조를 고정해 결과를 비교하면 현재 Qwen Base의 참조 감정 전달이 실제로 작동하는지 사용자가 직접 판단할 수 있다.

## 2. 비교표

| 모델 | 음색 복제 | 감정·운율 제어 방식 | 공개 언어 | 공개 코드·가중치 | 라이선스 핵심 | AudioForge 판단 |
|---|---|---|---|---|---|---|
| Qwen3-TTS Base 0.6B/1.7B | 3초 제로샷, ICL 또는 x-vector | Base는 참조 오디오의 스타일 전달. 공식 instruction 제어 없음 | 10개, 한국어 포함 | 코드·가중치 공개 | Apache-2.0 | 현재 기본 엔진 유지. 감정별 참조 + 샘플 보드에 적합 |
| Qwen3-TTS CustomVoice/VoiceDesign 1.7B | preset/설계 음색, Base와 역할 다름 | 자연어 instruction으로 감정·속도·운율·음색 설명 | 10개 | 코드·가중치 공개 | Apache-2.0 | “복제한 특정 화자 + 자유 instruction”은 바로 동일 기능이 아님. 설계 음성을 참조로 다시 복제하는 2단계 후보 |
| CosyVoice 3 0.5B | 제로샷·교차언어 | prompt speech + instruction tokens; 감정·속도·볼륨 등 | 9개, 한국어 포함 | 코드·가중치 공개 | Apache-2.0 | 대체 엔진 PoC 우선 후보. 새 격리 환경 필요 |
| Fish Audio S2 Pro | 참조 음성 기반 | 문장 내부 자유형 자연어 태그, 다화자·다중 턴 | 80개 이상, 한국어 Tier 2 | 코드·가중치 공개 | Fish Audio Research License, 상업 사용 별도 | 문법·비언어 UX 연구 1순위, 기본 탑재는 라이선스·자원 문제 |
| IndexTTS-2.5 | 단일 참조 제로샷 | 음색과 감정 분리; 감정 오디오·8차원 벡터·텍스트 설명·강도 | 중·영·일·서·아 | 코드·가중치 공개 | bilibili Model Use License | 감정 정확도 검증용 대체 엔진 1순위. 한국어 미지원 |
| GPT-SoVITS | 짧은 참조 제로샷, 소량 데이터 few-shot | 주로 참조 오디오/학습 데이터의 감정 전달 | 중·영·일 중심, 버전별 상이 | 코드·가중치 공개 | 코드 MIT, 가중치·의존 모델별 확인 필요 | 기존 사용자층은 크지만 명시 감정 제어 계약은 약함 |
| F5-TTS v1 | 참조 오디오+전사 기반 제로샷 | reference-conditioned style/prosody transfer; 명시 감정 축 없음 | 공식 base 중·영 | 코드·가중치 공개 | 코드 MIT, 공식 weights CC-BY-NC-4.0 | 자연스러운 flow-matching 참고. 상업·감정 API 제약 |
| Spark-TTS 0.5B | 제로샷·교차언어 | decoupled tokens로 gender·pitch·speed 제어; 공개 UI에 감정 축 없음 | 중·영 | inference 코드·가중치 공개 | 코드 Apache-2.0, HF weights CC-BY-NC-SA-4.0 | pitch/formant 연구 참고, 감정 샘플 보드 엔진 우선순위 낮음 |
| StyleTTS2 | 다화자 모델에서 zero-shot adaptation | reference style encoder + latent style diffusion; 명시 감정 label API 아님 | 공식 pretrained는 영어 중심 | 코드·일부 weights 공개 | 주로 MIT, LibriTTS checkpoint는 별도 윤리 조건 주의 | 운율/스타일 잠재공간 연구용. 제품 통합 비용 큼 |
| EmotiVoice | 2,000+ 내장 음색; 개인 음성은 학습 recipe | prompt embedding으로 pitch·speed·energy·emotion 제어 | 중·영 | 코드·weights 공개 | Apache-2.0 | 고정 음색 감정 프롬프트 참고. 즉시 제로샷 클론 대체는 아님 |
| OpenVoice V2 | 짧은 참조로 tone color 변환 | base TTS의 style을 만든 뒤 tone-color converter로 화자색 전환 | 중·영·일·한·서·불 | 코드·weights 공개 | MIT | 음색과 표현 분리 구조의 좋은 참고. 2단계 파이프라인 복잡성 |
| ChatTTS | 공식 공개판은 사용자 제로샷 복제가 핵심 아님 | `[laugh]`, `[uv_break]`, oral/laugh/break 수준 토큰 | 중·영 | 코드·연구 weights 공개 | 코드 AGPL-3.0, 모델 학술용 | 웃음·호흡·쉼 문법 참고. 감정 엔진 대체로는 부적합 |

## 3. 모델별 조사

### 3.1 Qwen3-TTS

공식 공개 모델은 역할이 분리되어 있다.

- `0.6B/1.7B-Base`: 참조 오디오+전사 ICL 또는 x-vector-only를 이용한 음성 복제.
- `1.7B-CustomVoice`: 9개 preset speaker를 자연어 instruction으로 제어.
- `1.7B-VoiceDesign`: 자연어 설명에서 새 음색과 표현을 설계.
- `0.6B-CustomVoice`: preset speaker는 지원하지만 공식 표에서 instruction control은 표시되지 않는다.

구조는 12Hz 음성 tokenizer와 discrete multi-codebook autoregressive LM을 중심으로 한다. Base의 ICL은 참조 텍스트와 참조 음성 code를 함께 조건으로 사용하고, x-vector-only는 화자 embedding만 사용한다. 따라서 Base에서 감정 참조 오디오가 효과를 내는 것은 “감정 label을 이해해서”가 아니라 참조 prompt의 음색·운율·스타일이 이어지는 효과로 보는 것이 정확하다.

AudioForge 적용:

- 현재 0.6B Base와 감정별 reference clip 구조를 유지한다.
- `instruct` 슬라이더나 감정 문구를 Base에 보내는 가짜 기능을 만들지 않는다.
- 중기 연구로 VoiceDesign이 만든 감정별 짧은 reference를 Base clone prompt로 재사용하는 공식 2단계 workflow를 검토할 수 있다. 다만 이것은 사용자의 실제 감정 음성을 복제하는 것과 다른 기능이다.
- 0.6B Base HF 저장소 전체는 약 2.52GB, 1.7B Base는 약 4.54GB로 표시된다. 공식 최소 VRAM은 확인되지 않았다.

출처: [공식 README와 모델 역할 표](https://github.com/QwenLM/Qwen3-TTS/blob/main/README.md), [0.6B Base 모델 카드](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base), [1.7B Base 파일](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base/tree/main), [기술 보고서](https://arxiv.org/abs/2601.15621)

### 3.2 CosyVoice 3

CosyVoice 계열은 text/instruction/prompt speech를 speech token LM에 넣고, flow-matching/ODE 계열 acoustic model로 mel을 복원한 뒤 HiFTGAN vocoder로 waveform을 만든다. CosyVoice 3 tokenizer는 ASR, 감정 인식, 언어 식별, audio-event detection, speaker analysis를 함께 학습한 supervised semantic token을 강조한다. 자연스러운 감정 전달의 한 이유는 단순한 화자 embedding이 아니라 prompt speech의 semantic/prosodic 정보를 speech token과 acoustic prompt 양쪽에서 이용하기 때문이다.

공식 3.0은 9개 언어와 교차언어 제로샷 복제, 감정·속도·볼륨 instruction을 지원한다. 공개 체크포인트 이름은 0.5B지만 HF bundle은 tokenizer·flow·vocoder 등 전체 구성 때문에 약 9.75GB다. 공식 최소 VRAM은 확인되지 않았다.

AudioForge 적용:

- 한국어·제로샷·instruction을 동시에 제공해 대체 엔진 PoC 가치가 높다.
- 현재 Qwen venv와 섞지 말고 별도 venv/worker capability로 격리해야 한다.
- 동일 음색에서 `emotion reference`와 `instruction`의 결과를 감정 샘플 보드로 A/B 평가한 뒤 채택한다.

출처: [공식 저장소](https://github.com/FunAudioLLM/CosyVoice), [CosyVoice 3 논문](https://arxiv.org/abs/2505.17589), [0.5B 모델 파일](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/tree/main), [CosyVoice 논문](https://arxiv.org/abs/2407.05407)

### 3.3 Fish Audio S2 Pro

S2 Pro는 단순한 “큰 TTS 모델”이 아니라 text/instruction/speaker turn과 계층형 audio token을 같은 autoregressive 문제로 다루는 사례다. 감정 표현이 좋은 이유를 공개 자료에서 가장 구체적으로 분해할 수 있는 모델이므로 architecture, codec, control, data/post-training을 나눠 본다.

#### 3.3.1 Dual-AR: 시간 의미와 같은 시점의 음향 세부를 분리

**확인:** 공식 v2.0.0 release는 Slow AR 4B와 Fast AR 400M을 명시한다.

- **Slow AR**: 시간축을 따라 매 frame의 첫 번째 semantic codebook을 예측한다. Qwen3-4B 계열 decoder-only backbone을 사용하며 text, inline instruction, speaker/turn, reference prompt와 장기 발화 구조를 처리한다.
- **Fast AR**: Slow AR hidden state를 조건 prefix로 받아 한 시점의 나머지 9개 residual codebook을 depth 방향으로 순차 예측한다.
- **효과**: 10개 codebook을 전부 시간축에 평탄화하면 sequence가 약 10배 길어진다. Dual-AR은 “언제 무엇을 말할지”를 긴 Slow sequence에서, “그 순간의 세밀한 음향을 어떻게 채울지”를 짧은 Fast depth sequence에서 분리한다.

**추론:** AudioForge의 현재 Qwen multi-codebook 경로에서 발생한 장시간 autoregressive tail 문제와 비교할 가치가 있다. Dual-AR을 일부 함수만 복사해 해결할 수는 없지만, 향후 새 engine을 평가할 때 `시간축 종료 안정성`과 `residual codebook 생성 비용`을 따로 측정해야 한다는 설계 교훈을 준다.

#### 3.3.2 RVQ/ModifiedDAC codec: 낮은 frame rate와 계층적 정보

**확인:** 공식 release는 ModifiedDAC, 10 RVQ codebooks, 약 21Hz frame rate, 44.1kHz output을 명시한다. 첫 codebook은 semantic/temporal generation에 쓰이고 나머지 9개가 residual acoustic detail을 보충한다. 참조 음성은 codec token으로 encode되어 prompt에 들어간다.

**추론:** 감정은 단일 F0 수치가 아니라 발화 속도, energy envelope, pause, voice quality, 웃음/숨 같은 acoustic event가 여러 codebook에 걸쳐 나타난다. 첫 semantic codebook만 다루거나 최종 WAV pitch만 움직이는 것보다, 계층 전체를 조건화한 모델이 표현을 더 자연스럽게 만들 가능성이 높다. 이 원리는 AudioForge의 pitch 후처리를 폐기하라는 뜻이 아니라, pitch가 “생성된 감정”을 대신할 수 없다는 근거다.

#### 3.3.3 inline emotion/nonverbal instruction

**확인:** S2는 `[angry]`, `[super happy]`, `[whisper]`, `[laughing]`, `[chuckle]`, `[inhale]`, `[sigh]`, `[clearing throat]`, `[short pause]` 같은 free-form 자연어 tag를 텍스트 내부 word 위치에 둘 수 있다. `<|speaker:i|>` 형태 speaker turn과 multi-turn generation도 공개된다. 공식 설명의 “15,000+”는 열거 가능한 고정 enum이 아니라 자연어 instruction 공간을 뜻한다.

**확인:** 별도의 hand-authored acoustic rule이 tag를 WAV 효과로 변환하는 구조가 아니다. model이 captioned speech와 instruction의 관계를 학습해 해당 위치의 audio token 분포를 바꾼다.

**추론:** AudioForge의 parser/색상/감정 전환 UI는 Fish식 syntax를 수용할 기반은 있지만 현재 Qwen Base가 같은 tag 의미를 학습한 것은 아니다. 따라서 `[웃음]` token을 parser에 추가하는 것과 자연스러운 웃음을 생성하는 것은 별도 작업이다. 현재 엔진에서는 등록된 같은 화자의 nonverbal clip을 삽입하는 방식이 결정적이고, Fish 계열 engine에서만 native tag를 capability로 노출하는 방식이 정직하다.

#### 3.3.4 speaker와 style의 관계

**확인:** reference audio code와 prompt text를 통해 rapid voice cloning을 하고, speaker tag로 multi-speaker turn을 구분한다. RL reward에는 timbre similarity가 포함된다. inline natural-language instruction은 style과 vocal event를 제어한다.

**경계:** 공개 자료는 IndexTTS2처럼 독립된 `speaker encoder`와 `emotion encoder`를 완전히 disentangle했다고 설명하지 않는다. speaker identity와 style instruction이 하나의 shared sequence model에서 상호작용할 수 있다.

**추론:** 감정 tag를 강하게 할수록 화자 유사도가 흔들릴 가능성을 제품 평가에서 별도 측정해야 한다. 감정 샘플 보드는 `감정 인지`와 `화자 동일성`을 한 점수로 합치지 말아야 한다.

#### 3.3.5 데이터 pipeline, SFT, RL/post-training

**확인:** 기술 보고서는 1천만 시간 이상, 80개 이상 언어의 speech data와 다음 staged pipeline을 설명한다.

1. video captioning과 speech captioning으로 발화 내용뿐 아니라 style·emotion·event 설명을 만든다.
2. voice-quality assessment로 낮은 품질 sample을 걸러낸다.
3. pre-training 뒤 supervised fine-tuning으로 instruction-following과 multi-turn 형식을 학습한다.
4. GRPO/Dr.GRPO 계열 RL post-training으로 autoregressive hallucination, token skip, timbre drift를 줄인다.

**확인:** 공식 보고서의 composite reward는 semantic accuracy `R_STT`, acoustic preference `R_Pref`, timbre similarity `R_SIM`을 결합한다. speaker ID 오류와 놓친 vocal instruction에는 더 강한 penalty를 적용한다고 설명한다. Slow AR와 Fast AR 양쪽을 reward로 최적화한다.

**기술적 의미:** 자연스러운 감정은 architecture 하나에서 나오지 않는다. caption 품질, instruction 위치 annotation, 음질 filtering, ASR 정확도, 화자 유사도, human/acoustic preference를 함께 최적화한 결과다. 동일한 tag parser만 구현해 같은 품질을 기대할 수 없다.

#### 3.3.6 공개/비공개 경계

**공개 확인:** model weights, ModifiedDAC codec, inference code, local API/WebUI, SGLang streaming engine, fine-tuning/LoRA 경로가 공개되어 있다. 공식 inference 문서는 24GB 이상 GPU를 권장하며 Linux/WSL을 명시한다. Fish Audio Research License는 연구·비상업 사용만 무료이고 상업 사용은 별도 계약이다.

**재현 가능하다고 단정할 수 없는 부분:** 공식 공개 안내가 1천만 시간 원천 corpus, caption/quality/reward model weights, 전체 data filtering pipeline, GRPO production training loop와 reward 학습 자료 전부를 제공한다고 명시하지는 않는다. 논문에 algorithm이 공개됐다는 사실과 최종 모델의 전체 학습을 제3자가 재현할 수 있다는 것은 다르다.

#### 3.3.7 AudioForge 적용 분류

| 분류 | 적용 항목 | 이유 |
|---|---|---|
| 즉시 적용 | 감정 샘플 보드에서 감정 인지·화자 유사·발음·경계 자연스러움을 분리 평가 | 새 모델 없이 현재 Qwen 결과 평가 개선 가능 |
| 즉시 적용 | inline tag 위치, speaker/감정 색상, nonverbal event를 구분하는 parser/metadata 설계 | UI·문법 원리이며 Fish weights 불필요 |
| 변형 적용 | 현재 Qwen Base에서는 `[웃음]`을 native 생성하지 않고 등록 clip event로 실행 | capability를 과장하지 않으면서 Fish UX 장점을 차용 |
| 변형 적용 | engine capability별 native emotion tag/reference emotion/postprocess를 구분 | 모델마다 감정 제어 원리가 다름 |
| 훈련 필요 | Qwen Base가 free-form inline emotion/nonverbal tag를 실제 acoustic token으로 따르게 만들기 | parser나 prompt만으로 학습되지 않은 제어 능력 생성 불가 |
| 훈련 필요 | 화자 유사도를 유지하면서 emotion 강도를 독립 제어 | paired speaker/emotion data와 disentanglement/reward 필요 |
| 참고만 가능 | Dual-AR slow/fast 구조를 현재 Qwen worker 일부에 이식 | checkpoint architecture와 codec 자체가 달라 국소 패치 불가 |
| 참고만 가능 | Fish의 GRPO reward pipeline을 그대로 재현 | reward/data assets와 대규모 training 비용이 공개 inference보다 훨씬 큼 |
| 조건부 엔진 PoC | S2 Pro를 별도 local backend로 실행 | 24GB 권장 VRAM, Linux/WSL, 비상업 license, 별도 worker 필요 |

출처: [공식 저장소](https://github.com/fishaudio/fish-speech), [v2.0.0 release의 정확한 Slow/Fast/codec/RL 표기](https://github.com/fishaudio/fish-speech/releases), [S2 Pro 모델 카드](https://huggingface.co/fishaudio/s2-pro), [공식 inference·24GB 권장](https://github.com/fishaudio/fish-speech/blob/main/docs/en/inference.md), [공식 설치 환경](https://github.com/fishaudio/fish-speech/blob/main/docs/en/install.md), [라이선스](https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md), [기술 보고서](https://arxiv.org/abs/2603.08823)

### 3.4 IndexTTS-2/2.5

IndexTTS2의 핵심은 speaker/timbre prompt와 emotion/style prompt의 분리다. 공개 API는 다음 감정 입력을 서로 배타적으로 제공한다.

- 별도 감정 참조 오디오
- 8차원 벡터: happy, angry, sad, afraid, disgusted, melancholic, surprised, calm
- 자연어 감정 설명
- `emo_alpha` 감정 강도

논문·공식 설명은 감정 특징과 화자 특징을 disentangle하고 feature fusion으로 강한 감정에서도 발음과 음색을 유지한다고 설명한다. 2.5는 중국어·영어·일본어·스페인어·아랍어, 발음 제어와 속도 제어를 제공하지만 한국어는 공식 지원 목록에 없다. 공식 평가표는 2.5를 0.8B로 표기하고 HF bundle은 약 5.49GB다. 최소 VRAM은 확인되지 않았다. 가중치는 Apache/MIT가 아니라 별도의 bilibili Model Use License다.

AudioForge 적용:

- 감정 오디오를 화자 오디오와 독립적으로 바꾸는 구조가 현재 “감정별 참조” 설계와 가장 닮았다.
- 8축 벡터는 향후 감정 샘플 보드의 비교 UI에 좋은 참고지만, AudioForge Qwen Base에 같은 슬라이더를 그대로 붙일 수는 없다.
- 한국어 부재와 라이선스 검토 때문에 우선은 일본어·영어 synthetic 평가용 격리 PoC가 적합하다.

출처: [공식 저장소](https://github.com/index-tts/index-tts), [공식 CLI 감정 제어](https://github.com/index-tts/index-tts/blob/main/docs/cli_v2_usage.md), [2.5 가중치·라이선스](https://huggingface.co/IndexTeam/IndexTTS-2.5/tree/main), [IndexTTS2 논문](https://arxiv.org/abs/2506.21619)

### 3.5 GPT-SoVITS

GPT-SoVITS는 짧은 reference와 prompt transcript를 사용하며, self-supervised semantic representation을 autoregressive GPT가 예측하고 SoVITS 계열 decoder가 음성을 복원하는 계열이다. 5초 zero-shot과 약 1분 데이터 few-shot fine-tuning이 핵심 장점이다. 공개 인터페이스에서 감정은 보통 감정이 담긴 reference나 화자별 fine-tuning data를 통해 전달된다. 공식 README의 “향상된 TTS 감정 제어”는 아직 roadmap 항목으로 남아 있어, 안정적인 독립 emotion control API가 완성됐다고 보면 안 된다.

AudioForge 적용:

- 이미 감정별 reference를 관리하는 UI와 개념적으로 호환된다.
- 버전·checkpoint·frontend 의존성이 복잡하고, Qwen Base 대비 교체 이득을 먼저 synthetic A/B로 입증해야 한다.
- code는 MIT지만 포함·다운로드되는 pretrained components와 weights는 각 출처 라이선스를 별도 감사해야 한다.

출처: [공식 저장소](https://github.com/RVC-Boss/GPT-SoVITS), [공식 README](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/README.md), [MIT 코드 라이선스](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/LICENSE)

### 3.6 F5-TTS

F5-TTS는 text와 reference-conditioned audio를 Diffusion Transformer/flow matching으로 생성하고 Vocos 등 vocoder로 복원한다. duration model, phoneme alignment, 별도 text encoder를 크게 줄인 구조가 장점이다. 참조 오디오와 전사를 in-context condition으로 사용하므로 그 reference의 음색·속도·운율이 전달될 수 있지만 공식 v1 Base에는 IndexTTS2 같은 명시 emotion vector나 instruction API가 없다.

공식 base는 중국어·영어 중심이다. code는 MIT지만 Emilia로 학습된 공식 weights는 CC-BY-NC-4.0이므로 상업 사용 후보에서 제외해야 한다. 공식 최소 VRAM은 확인되지 않았다.

AudioForge 적용:

- 자연스러운 긴 문장과 flow-matching 구조 연구에는 유용하다.
- 감정 제어는 reference selection에 의존하므로 현재 Qwen Base보다 제품 기능이 명확히 늘어난다고 보기 어렵다.
- 라이선스 때문에 기본 배포 엔진 후보 우선순위는 낮다.

출처: [공식 저장소·라이선스](https://github.com/SWivid/F5-TTS), [공식 모델 카드](https://huggingface.co/SWivid/F5-TTS), [논문](https://arxiv.org/abs/2410.06885)

### 3.7 Spark-TTS

Spark-TTS는 Qwen2.5 기반 LLM과 single-stream decoupled speech tokens를 사용한다. BiCodec이 content와 global acoustic attributes를 분리하고, 공개 controlled generation은 gender·pitch·speed를 조건으로 제공한다. separate flow-matching model 없이 LLM이 예측한 code에서 직접 복원하는 단순성이 장점이다.

공식 공개 모델은 0.5B, 중국어·영어, zero-shot/cross-lingual clone을 지원한다. 저장소 코드는 Apache-2.0이지만 HF weights는 CC-BY-NC-SA-4.0이므로 둘을 구분해야 한다. HF bundle은 약 3.95GB다.

AudioForge 적용:

- pitch·speed·voice attribute의 생성 단계 제어와 현재 후처리 pitch를 비교하는 연구에 유용하다.
- 공식 UI에 독립 emotion control은 없으므로 감정 샘플 보드 대체 엔진 우선순위는 낮다.

출처: [공식 저장소](https://github.com/SparkAudio/Spark-TTS), [공식 모델 카드](https://huggingface.co/SparkAudio/Spark-TTS-0.5B), [논문](https://arxiv.org/abs/2503.01710)

### 3.8 StyleTTS2

StyleTTS2는 style을 latent random variable로 보고 diffusion으로 생성한다. reference mel에서 acoustic style과 prosodic style을 각각 encoding하며, WavLM 기반 large speech language model discriminator와 differentiable duration modeling을 사용한다. 자연스러운 억양은 “감정 label 선택”보다는 text-conditioned latent style sampling과 reference style embedding에서 나온다.

공식 pretrained는 LJSpeech single-speaker와 LibriTTS multi-speaker 등 영어 중심이다. 코드 대부분은 MIT이며 공식 저장소는 LibriTTS model 사용 시 별도 윤리 조건을 주의하라고 명시한다. 최소 VRAM 공식값은 확인되지 않았다.

AudioForge 적용:

- 감정/운율을 speaker identity와 분리된 latent로 다루는 연구 참고.
- 한국어·Windows 배포·명시 감정 UI·현재 Qwen worker와의 결합 비용 때문에 직접 엔진 후보 우선순위는 낮다.

출처: [공식 저장소](https://github.com/yl4579/StyleTTS2), [논문](https://arxiv.org/abs/2306.07691), [공식 demo](https://styletts2.github.io/)

### 3.9 EmotiVoice

EmotiVoice는 PromptTTS 계열로 speaker와 style/emotion prompt를 condition으로 넣으며, 공개 설명상 style factor는 pitch·speed·energy·emotion이다. 중국어·영어와 2,000개 이상의 내장 음색을 제공한다. 개인 음성 cloning은 별도의 학습 recipe로 제공하므로 짧은 reference를 즉시 쓰는 zero-shot clone과 구분해야 한다.

AudioForge 적용:

- 감정 label·prompt를 명시하는 UI와 감정별 동일 대사 sample board의 선례로 유용하다.
- 현재 사용자의 임의 화자를 즉시 복제하는 엔진 대체로는 부적합하다.
- Apache-2.0이라 코드 연구는 비교적 수월하다.

출처: [공식 저장소·라이선스](https://github.com/netease-youdao/EmotiVoice), [PromptTTS 논문](https://arxiv.org/abs/2211.12171)

### 3.10 OpenVoice V2

OpenVoice의 특징은 tone color와 style을 분리하는 2단계 구조다. base TTS가 emotion/accent/rhythm/pause/intonation이 담긴 source speech를 만들고, tone color converter가 reference speaker의 음색으로 변환한다. 이를 통해 base speaker의 표현을 유지하면서 target speaker tone color를 입힌다.

V2 공식 언어는 영어·스페인어·프랑스어·중국어·일본어·한국어이며 V1/V2 code와 weights는 MIT로 공지됐다. 다만 style 선택은 base TTS와 언어별 speaker/style 자산에 의존하며 모든 언어에서 같은 emotion preset이 보장되는 것은 아니다.

AudioForge 적용:

- “표현 생성”과 “사용자 음색 입히기”를 분리하는 구조적 참고 가치가 높다.
- Qwen 단일 engine보다 두 모델의 artifact·failure·license·latency를 관리해야 해 통합 비용이 크다.
- 향후 가창/voice conversion mode와도 연결될 수 있으나 현재 TTS 표현 사이클과 섞지 않는다.

출처: [공식 저장소·MIT 안내](https://github.com/myshell-ai/OpenVoice), [논문](https://arxiv.org/abs/2312.01479)

### 3.11 ChatTTS

ChatTTS는 대화용 autoregressive speech model이며 speaker embedding, semantic token generation, DVAE/Vocos 계열 decoder를 사용한다. 공개판의 실제 token-level 제어는 `[laugh]`, `[uv_break]`, `[lbreak]`와 oral/laugh/break 수준이다. 공식 FAQ도 추가 감정 제어는 공개되지 않았다고 명시한다.

공식 공개판은 중국어·영어, 학술 목적 모델이며 code는 AGPL-3.0이다. 30초 clip 기준 최소 4GB VRAM이라는 공식 FAQ 수치가 있으나 환경에 따라 달라질 수 있다.

AudioForge 적용:

- `[웃음 0.8]`, `[한숨]`, `[숨]` 같은 향후 nonverbal event 문법의 좋은 선례다.
- 사용자의 특정 화자 zero-shot clone, 다양한 감정 제어, 상업 배포 관점에서는 기본 엔진 후보가 아니다.

출처: [공식 저장소·FAQ](https://github.com/2noise/ChatTTS), [공식 모델 카드](https://huggingface.co/2Noise/ChatTTS)

### 3.12 모델별 기술 원리의 적용 분류

아래 표는 “모델을 통째로 설치할지”가 아니라 공개 기술을 AudioForge에 어느 수준으로 가져올 수 있는지를 정리한다. 큰 모델·비상업 가중치도 원리 연구에서 제외하지 않는다.

| 모델/원리 | 즉시 적용 | 변형 적용 | 훈련 필요 | 참고만 가능 |
|---|---|---|---|---|
| Qwen Base ICL/x-vector | reference fingerprint·전사 정합·두 mode 명시·감정 sample cache | 감정별 reference routing과 sample board | Base에 자유형 instruction 능력 추가 | multi-codebook LM 자체 변경 |
| Qwen VoiceDesign/CustomVoice | capability와 Base 역할을 UI에서 구분 | VoiceDesign 결과를 reusable reference로 만드는 2단계 workflow | 특정 사용자 음색+자유 instruction을 한 모델에서 강하게 유지 | 1.7B 설계 모델 구조를 0.6B Base에 국소 이식 |
| CosyVoice supervised semantic tokenizer | emotion/audio-event 위험 신호를 reference 품질 UI에 표시 | 별도 engine worker에서 instruction과 prompt speech 비교 | tokenizer multi-task supervision 재현 | flow/HiFTGAN을 Qwen decoder에 직접 연결 |
| Fish Dual-AR·inline tag·RL | parser/UX·평가축·capability 계약 | nonverbal clip event와 native tag engine을 분리 | 현재 Base의 native inline emotion, timbre reward alignment | Slow/Fast AR·ModifiedDAC의 부분 이식 |
| IndexTTS2 timbre/emotion 분리 | sample board에서 화자 동일성과 감정 인지를 별도 평가 | 별도 engine에서 emotion audio/vector/text 모드 제공 | 현재 Qwen에 독립 8D emotion latent 추가 | feature fusion만 떼어 기존 checkpoint에 적용 |
| GPT-SoVITS semantic prompt/few-shot | reference·prompt text 결합 상태와 fine-tune profile을 metadata로 분리 | engine adapter 및 감정 reference A/B | 독립 emotion control head | 버전별 SoVITS/GPT 부품을 Qwen에 혼합 |
| F5 flow matching/reference style | 동일 reference·동일 text A/B 평가 방법 | 비상업 연구 engine, reference style transfer 비교 | 상업 허용 data로 새 weights 학습 | flow sampler를 autoregressive Qwen에 국소 적용 |
| Spark decoupled attributes | 생성 pitch와 postprocess pitch를 다른 capability로 표시 | gender/pitch/speed 생성축 연구 backend | emotion attribute 추가 | BiCodec/LLM token 체계를 기존 engine에 부분 이식 |
| StyleTTS2 style diffusion | “랜덤 style”과 “사용자 지정 감정”을 UX에서 구분 | latent variation A/B 연구 | 한국어·감정 label용 style model 재학습 | diffusion style block을 Qwen Base에 붙이기 |
| EmotiVoice PromptTTS | 감정 prompt sample board·preset 설명 | 내장 voice 기반 연구 backend | 사용자 임의 화자 zero-shot 능력 | prompt encoder만 다른 acoustic model에 복사 |
| OpenVoice tone-color conversion | 표현 source와 목표 음색을 metadata에서 분리하는 개념 | 별도 style TTS→tone converter 2단계 backend | 언어/감정별 base style 확장 | converter를 현재 Qwen 생성 내부에 삽입 |
| ChatTTS laugh/break token | nonverbal event 문법·길이·fallback 오류 계약 | 등록 clip 기반 웃음/숨 event | 현재 Qwen native laugh token | ChatTTS token ID를 다른 tokenizer에서 재사용 |

#### 원리별 공통 교훈

- **reference 방식**은 가장 빨리 적용할 수 있지만 음색과 감정이 얽힌다(Qwen Base, F5, GPT-SoVITS).
- **분리된 style/emotion condition**은 편집성이 좋지만 이를 학습한 checkpoint가 필요하다(IndexTTS2, StyleTTS2, OpenVoice의 2단계 구조).
- **inline event/instruction**은 문장 내부 표현이 강하지만 tokenizer·training caption·SFT/RL이 함께 있어야 한다(Fish, ChatTTS 일부).
- **codec와 생성 구조**는 품질·길이·latency를 좌우하지만 기존 checkpoint에 UI나 후처리만으로 추가할 수 없다(Qwen multi-codebook, Fish Dual-AR/RVQ, Spark BiCodec, CosyVoice tokenizer+flow).
- **post-training과 평가**는 architecture와 동등하게 중요하다. semantic accuracy, instruction adherence, timbre similarity, acoustic preference를 분리 측정해야 한다(Fish RL, CosyVoice multi-task tokenizer, IndexTTS2 emotion/timbre 평가).

## 4. AudioForge 적용 우선순위

이 절의 우선순위는 **제품 구현 순서**일 뿐 기술 가치 순위가 아니다. 즉시 탑재가 어려운 Fish·F5·StyleTTS2도 앞 절의 원리 연구와 장기 설계에서 계속 유지한다.

### 즉시: 현재 엔진 위에서 구현

1. **감정 샘플 보드**
   - 사용자가 명시적으로 누르는 `감정 샘플 만들기` 버튼.
   - 기본은 동일 대사 비교, 보조로 감정별 예문.
   - 감정별 reference fingerprint, region, transcript hash, engine revision, seed, pitch, speed를 cache key로 사용.
   - 감정 reference 없음/만료/미확정은 기본 reference로 조용히 대체하지 않고 카드에서 명확히 구분.
   - 자동 점수보다 사용자 청취가 최종 권위.
2. **감정 전환 타임라인**
   - 현재 parser plan을 색 구간과 marker로 표시.
   - gradient는 “혼합”이 아니라 “전환”으로 설명.
3. **비언어 표현 계약 설계**
   - ChatTTS/Fish 사례를 참고하되 현재 Qwen Base가 raw `ㅎㅎㅎ`에서 안정적인 웃음을 생성한다고 가정하지 않는다.
   - 1차는 등록된 같은 화자의 웃음·한숨·호흡 clip 삽입이 더 결정적이다.

### 단기 PoC: 격리 엔진 비교

1. **IndexTTS-2.5**: 감정 오디오·벡터·설명 입력의 분리성이 가장 명확하다. 한국어 부재 때문에 영/일 synthetic fixture로 먼저 비교한다.
2. **CosyVoice 3**: 한국어·제로샷·instruction의 조합이 가장 유망하다. 현재 Qwen과 별도 venv/worker로 격리한다.
3. **OpenVoice V2**: style source와 tone-color conversion의 2단계가 실제로 화자 동일성을 보존하는지 연구한다.

PoC 공통 gate:

- 동일 승인 reference 또는 synthetic speaker만 사용.
- 동일 대사·동일 언어·동일 감정 조건을 3회 이상 생성해 비결정성을 분리.
- 화자 유사도, 발음 누락, 감정 인지, generation tail, 속도, peak/clipping, cleanup을 별도 평가.
- 라이선스·bundle 크기·Windows 설치·GPU/CPU fallback·취소 가능성을 기능 품질과 같은 수준으로 평가.
- API나 클라우드 fallback 금지.

### 연구 전용

- Fish S2 Pro: inline/free-form tag와 multi-turn 표현 연구.
- F5-TTS/StyleTTS2: flow/style diffusion이 자연스러운 prosody를 만드는 방식 연구.
- Spark-TTS: 생성 단계의 pitch/speed attribute와 후처리의 품질 비교.
- EmotiVoice/ChatTTS: prompt emotion 및 nonverbal token UX 연구.

## 5. 감정 표현이 좋아지는 공통 구조

여러 모델의 공통점을 종합하면 감정 표현 품질은 단일 “감정 강도” 슬라이더보다 다음 구조에서 나온다.

1. **화자와 표현의 분리**: IndexTTS2의 timbre/emotion disentanglement, OpenVoice의 tone-color converter.
2. **참조의 prosody를 보존하는 조건화**: Qwen Base ICL, CosyVoice prompt speech, F5 reference conditioning.
3. **텍스트 내부 위치 제어**: Fish S2의 sub-word inline instruction, ChatTTS의 laugh/break token.
4. **고품질 speech tokenizer**: Qwen multi-codebook tokenizer, CosyVoice supervised semantic tokenizer, Fish dual-AR codec modeling.
5. **명시적 style latent 또는 instruction 학습**: StyleTTS2 diffusion, EmotiVoice PromptTTS, Qwen CustomVoice/VoiceDesign.
6. **강한 데이터와 post-training**: 대규모 다화자·다감정 데이터, emotion/audio-event supervision, RL alignment.

따라서 AudioForge가 현재 Qwen Base 위에서 얻을 수 있는 실질 개선은 “없는 감정 latent를 슬라이더로 꾸미는 것”이 아니라 다음이다.

- 감정별로 정합된 3~10초 reference와 transcript 관리.
- stale transcript·만료 clip·silent fallback 차단.
- 감정 샘플 보드로 실제 전달 여부를 사용자에게 들려주기.
- inline parser와 경계 pause/tail을 결정적으로 관리.
- 이후 감정과 음색이 분리된 엔진을 선택적 backend로 추가.

## 6. 확인되지 않은 항목

- 대부분 모델의 소비자 GPU별 공식 최소 VRAM은 공개 문서에서 확정하지 못했다. 커뮤니티 수치를 제품 요구사항으로 쓰지 않는다.
- 공개 demo의 감정 품질은 로컬 공개 weights와 동일하다고 보장할 수 없다.
- 모델이 “감정 지원”이라고 표기해도 모든 언어·화자·문장에서 같은 강도로 작동한다고 볼 수 없다.
- 공식 paper benchmark는 서로 다른 dataset·prompt·평가자를 사용하므로 모델 간 숫자를 단순 순위로 비교하지 않는다.
- Qwen Base의 reference emotion 유지, CosyVoice instruction, IndexTTS2 vector는 서로 다른 제어 방식이므로 하나의 공통 감정 점수로 환산하지 않는다.

## 7. 후속 조사 체크리스트

- [ ] CosyVoice 3 Windows 격리 설치와 실제 bundle/VRAM 측정(synthetic only)
- [ ] IndexTTS-2.5 라이선스 조항 검토와 영/일 emotion-vector PoC
- [ ] Qwen VoiceDesign → reusable Base clone prompt 2단계 PoC
- [ ] 감정 샘플 보드의 동일 대사/감정별 예문 A/B 평가 설계
- [ ] inline emotion/nonverbal event의 공통 parser 확장안
- [ ] 모델별 child process cancel·timeout·atomic publish 계약
- [ ] 사용자가 승인한 청취 평가표(화자 유사·감정 인지·자연스러움·발음·경계)
