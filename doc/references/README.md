# AudioForge 기술 레퍼런스 색인

이 폴더는 외부 서비스·공개 저장소·사용자 제공 샘플을 AudioForge 구현과 구분해 기록한다. 외부 서비스의 품질 인상이나 저장소 README의 주장은 곧바로 AudioForge의 구현 사실이 아니다.

## 근거 표기

- `[M]` 로컬 파일을 변경·재생하지 않고 측정한 값
- `[F]` 공식 문서 또는 저장소 코드에서 직접 확인한 사실
- `[C]` 제작자·저장소 README의 주장(독립 벤치마크 아님)
- `[I]` 여러 근거를 바탕으로 한 추론
- `[R]` AudioForge에 적용하기 전에 검증할 제안

## 문서

| 문서 | 내용 |
| --- | --- |
| [narakeet-sample-analysis.md](narakeet-sample-analysis.md) | 사용자 제공 Narakeet MP3의 무재생 정량 분석과 공식 기능 조사 |
| [korean-speech-github-survey.md](korean-speech-github-survey.md) | AWS Polly 예제, 한국어 STT 벤치마크, Seiren/VITS 저장소 조사 |
| [tts-technology-comparison-and-adoption.md](tts-technology-comparison-and-adoption.md) | AudioForge와 비교한 적용 가능 기술·우선순위·제외 범위 |

## 내부 결정·검증 기록

외부 자료와 구분해 다음 문서에 사용자 요구, 실제 합성 결과, 재개 조건을 기록한다.

| 문서 | 내용 |
| --- | --- |
| [../research/tts-expression-discussion-record.md](../research/tts-expression-discussion-record.md) | 감정·문장부호·웃음·참조·샘플러에 관한 사용자 의도와 제품 결정 |
| [../research/tts-acoustic-findings-2026-08-26.md](../research/tts-acoustic-findings-2026-08-26.md) | 단문·장문 청취 평가와 F0·경계·무음 정량 분석 |
| [../work-in-progress/tts-expression-validation-roadmap.md](../work-in-progress/tts-expression-validation-roadmap.md) | 긴급 중단 상태, 미완성 브랜치, 검증·병합 재개 순서 |

## 조사 제한

- Narakeet은 여러 외부 TTS 제공자를 묶는 서비스이며, 개별 음성에 사용한 모델 구조·학습 데이터·가중치를 공개하지 않는다. 샘플만으로 특정 모델을 역추정하지 않는다.
- MP3 정량값은 음질·자연스러움의 일부만 설명한다. 같은 대사·같은 화자·같은 출력 조건의 청취 비교가 아니므로 AudioForge 대비 우열 수치로 사용하지 않는다.
- 외부 저장소 코드는 라이선스와 유지보수 상태를 확인한 뒤에만 참고한다. 기본 정책은 기술 개념을 재구현하는 것이며, 출처 불명 코드를 복사하지 않는다.

---

## 조사 문서 색인 (master 작업본 보존)

아래는 master 체크아웃에서 별도로 유지되던 색인이다. 두 체계를 하나로 합치지 않고
원문 그대로 보존한다 — 위쪽 근거 표기 체계와 이 색인은 서로 다른 문서 집합을 가리킨다.

> 공개 공식 자료를 바탕으로 작성한 조사 문서다. 모델 채택이나 기능 완료를 의미하지 않는다.

## 음악·오디오 분석

- [음악·보컬·악기 분리 기술 계보와 고도화 후보](music-separation-techniques.md)
  - DSP/NMF/ICA/HPSS부터 Wave-U-Net, Open-Unmix, Demucs, MDX-Net, RoFormer, SCNet, Banquet까지의 원리
  - leakage·phase·transient·chunk seam·ensemble·VRAM을 포함한 P0/P1/P2 및 검증 매트릭스

## 감정 음성

- [공개 감정 TTS·보이스 클로닝 모델 비교](emotion-tts-models.md)
  - Qwen3-TTS, CosyVoice, Fish Speech, IndexTTS, GPT-SoVITS, F5-TTS, Spark-TTS, StyleTTS2, EmotiVoice, OpenVoice, ChatTTS
  - 감정 제어 구조, 언어, 라이선스, 로컬 적용 가능성
- [멀티모달 모델의 자연 발화·감정 표현](multimodal-emotional-speech.md)
  - LTX-2, MiniMax H3, MiniMax Speech의 명칭과 구조 구분
  - 음성 자체 품질과 영상·표정·입모양·환경음의 시간 동기화 효과 분리
- [상용 감정 음성 제품 제어 방식](emotional-speech-product-patterns.md)
  - ElevenLabs, Gemini TTS, OpenAI TTS, Azure Speech의 공개 제어 UI·문법 비교
  - AudioForge는 외부 API를 사용하지 않으며 제품 설계 패턴만 참고

## 사용 원칙

- 공식 논문, 공식 GitHub, 공식 Hugging Face 모델 카드, 공식 제품 문서를 우선한다.
- 공개 사실, 합리적 추론, 미확인 사항을 구분한다.
- 코드 라이선스와 가중치 라이선스를 별도로 확인한다.
- hosted demo 품질과 공개 로컬 checkpoint 품질을 같다고 가정하지 않는다.
- 사용자 미디어·ComfyUI workflow·prompt는 별도 명시적 승인 없이 조사에 사용하지 않는다.
- 실제 모델 채택은 Windows 설치, VRAM, 취소, 원자 저장, 라이선스, synthetic 평가를 통과한 뒤 결정한다.

### 색인에 없던 문서

아래 두 문서는 master 색인에도 실려 있지 않았다. 파일이 존재하므로 제목만 그대로 옮겨
색인에 넣는다 — 내용 요약이나 재분류는 하지 않았다.

- [대화 처리 기술 계보와 AudioForge 고도화 후보](dialogue-processing-techniques.md)
- [영상·장면·트랙 분할 기술 계보와 AudioForge 고도화 후보](video-segmentation-techniques.md)
