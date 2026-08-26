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

## 조사 제한

- Narakeet은 여러 외부 TTS 제공자를 묶는 서비스이며, 개별 음성에 사용한 모델 구조·학습 데이터·가중치를 공개하지 않는다. 샘플만으로 특정 모델을 역추정하지 않는다.
- MP3 정량값은 음질·자연스러움의 일부만 설명한다. 같은 대사·같은 화자·같은 출력 조건의 청취 비교가 아니므로 AudioForge 대비 우열 수치로 사용하지 않는다.
- 외부 저장소 코드는 라이선스와 유지보수 상태를 확인한 뒤에만 참고한다. 기본 정책은 기술 개념을 재구현하는 것이며, 출처 불명 코드를 복사하지 않는다.
