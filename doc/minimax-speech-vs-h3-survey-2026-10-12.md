# MiniMax 음성 제품과 H3의 차이

사용자가 제시한 https://www.minimax.io/audio 및 https://github.com/minimax-ai 를 조사했다. 공식 audio 화면은 웹 조회에서 본문이 나오지 않아 공식 API 설명·GitHub·기술 보고서로 보완했다. 실제 API 요청·음성 전송·다운로드·생성·앱 실행은 하지 않았다.

## 확인한 내용

MiniMax Speech와 H3는 같은 회사의 별도 제품이다. 공식 동기 음성 API는 speech-2.8-hd/turbo 및2.6/02계열을 제공한다. 한국어 선택, 스트리밍, 발음 사전, 문단·정량 쉼 표기,2.8계열 웃음·호흡·한숨 등의 태그를 설명한다. 쉼 `<#x#>`와 `(laughs)` 같은 표기는 Speech API 규약이며 H3/Qwen에 그대로 이식할 수 있다고 보지 않는다. 모델별 지원 범위는 다르다.

동기 API는10,000자 미만, 비동기 장문 안내는 최대100만자까지의 텍스트 입력을 설명한다. 이는 클라우드 음성 서비스의 입력 한도다. 로컬 H3가 그 길이를 한번에 안정적으로 생성한다는 근거가 아니다. 가격·속도·품질은 직접 호출해 측정하지 않았다.

목소리 복제 API는 미리 올린 음성의file_id를 받아voice_id를 만든다. 별도 참고 음성·본문, 잡음 감소·음량 정규화 설정도 있다. 문서를 읽었을 뿐 실제 서버 처리나 해당 기능의 한국어 품질을 확인한 것은 아니다. 현재 외부 전송 금지 원칙 아래에서는 연결하지 않는다.

공식 MiniMax-MCP·CLI는 API 호스트와 인증을 사용하는 공개 클라이언트다. 공개된 호출 코드가 음성 모델 가중치 공개를 의미하지 않는다. 이번에 확인한 공식 배포·자체 운영 안내에서는 M3/M2.7·Music3·H3 경로를 확인했지만 Speech2.8의 로컬 추론 가중치·완전한 실행 경로는 확인하지 못했다. 공개되지 않았다고 영구 단정하지 않고 이번 조사에서 미확인으로 둔다.

2025년 MiniMax-Speech 기술 보고서는 전사 없이 참조 음색 특징을 뽑는 학습된 화자 인코더, 자기회귀 음성 생성, Flow-VAE 복원을 설명한다. 감정 제어용LoRA·텍스트로 음색 설계·추가 자료를 쓰는 정밀 복제를 소개한다. 공개 구조 설명은 학습된 가중치를 대체하지 않으며,2025년 구조가2.8과 모두 같다고 추정하지 않는다. 화자 특징과 말투를 분리하고 원문·쉼·발음을 따로 관리하는 설계는 AudioForge가 참고할 수 있다.

## 로컬 H3 후속 후보

공식 H3 통합 목록에서 T8mars/comfyui-minimax-h3-audio-T8을 찾았다. 제작자 README는 오디오 참조·음색/감정·분할 장문·속도/메모리 관련 작업 흐름을 제공한다. 제3자 프로젝트이며 공식 Speech2.8 모델의 공개판이 아니다. 정확한 화자 지문·단어 시각·이음 및 모든16GB 환경의 성능을 보장하지 않는다고 명시한다. 필요한 부분의 코드·사용 조건을 추가 조사할 후보이며 전체 설치하지 않는다.

이 저장소의 이름만 보고 영상 계산을 완전히 제거했다고 말하지 않는다. 현재 AudioForge 최소 시험도 영상 디코딩만 생략하고 영상 잠재 샘플링은 남아 있다. 다른 공개 오디오 전용 구현의 존재 여부는 추가 조사 범위다.

## 권장 방향

로컬 요구를 유지하면서 사용자에게 좋은 평가를 받은 H3를 합성 옵션 후보로 삼는다. Speech API를 조용히 연결하거나 사용자 참조를 올리지 않는다. 다음 조사는 H3 오디오 중심 구현의 실제 코드·참조 경로·장문 연결·계산 제거 가능성으로 좁힌다. 모델을 바꾸거나 추가 생성을 하는 단계는 아니다.

## 출처

- https://www.minimax.io/audio
- https://github.com/MiniMax-AI
- https://platform.minimax.io/docs/api-reference/speech-t2a-http
- https://platform.minimax.io/docs/guides/speech-t2a-async
- https://platform.minimax.io/docs/api-reference/voice-cloning-clone
- https://platform.minimax.io/docs/guides/local-deploy
- https://github.com/MiniMax-AI/MiniMax-MCP
- https://github.com/MiniMax-AI/cli
- https://minimax-ai.github.io/tts_tech_report/
- https://github.com/MiniMax-AI/awesome-minimax-h3-integration
- https://github.com/T8mars/comfyui-minimax-h3-audio-T8
