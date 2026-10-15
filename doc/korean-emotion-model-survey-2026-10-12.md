# 한국어 감정 모델 적용 조사 (2026-10-12)

## 판단

한국어 발음·감정 종류 선택·학습하지 않은 참조 인물의 목소리 복제를 동시에 만족하는, 즉시 흡수 가능한 한국어 전용 공개 모델은 이번 조사에서 확인하지 못했다. 존재하지 않는다는 결론은 아니다. 새 모델을 설치했다는 보고나 품질 합격을 하지 않는다.

Cosy 지시 언어 비교 사용자 판정: 네 조건 모두 외국어가 섞이며 한국어 지시는 분노가 작동하지 않음. 지시 번역만으로 해결되지 않았다. 외국어에 대한 모델 성능은 이 한국어 시험으로 판정하지 않는다.

## 조사 후보와 적용 제약

- ZET-Speech: 한국어 감정 및 미학습 화자 데모 있음. 확인한 저장소는 데모 페이지만 공개. 추론 코드·가중치 확보 못함. 웹사이트 라이선스를 모델 라이선스로 대신 쓰지 않음.
  - https://zet-speech.github.io/ZET-Speech-Demo/
  - https://github.com/ZET-Speech/ZET-Speech-Demo
- HyunaZ/vits-kor-emotion: 한국어 MMS 기반, 감정 레이어 추가 학습. 중립/긍정/부정 각 1000개 학습 주장, 예시는 중립/기쁨/슬픔 번호. 체크포인트 약146MB 공개. 파일 목록은 README와 체크포인트 등이며 예시가 요구하는 EmotionalVitsModel 클래스 정의를 확인 못함. 예시에는 참조 목소리 입력이 없음. 모델 카드 CC-BY-NC-4.0 표기. 목표 기능으로 바로 연결 불가.
  - https://huggingface.co/HyunaZ/vits-kor-emotion
- Expressive-FastSpeech2: 한국어 감정 데이터 처리·학습 코드 있음. 이번 읽은 안내에서 바로 쓸 한국어 가중치 및 미학습 화자 복제 경로 확보 못함. 연구/학습 재료 후보.
  - https://github.com/keonlee9420/Expressive-FastSpeech2
- acidsound/index-tts-kr: 한국어 토큰·화자 적응 학습 코드. 추가 조사에서 한국어 체크포인트 model_step5584.pth(8.07GB)를 확인했다. 앞선 가중치 미확보 판단을 정정한다. 다만 대응 토크나이저·설정의 완전한 조합과 감정 미세학습 여부는 미확인으로, 한국어 감정 복제 성공으로 취급하지 않는다.
  - https://github.com/acidsound/index-tts-kr
  - https://huggingface.co/acidsound/index-tts-kr/tree/main
- Fish Audio S2-Pro: 공개 코드·가중치, 한국어 지원 및 감정 태그를 제공하는 추가 비교 후보. 가중치 묶음 약11GB. 공식 설치 안내는 Linux/WSL과 24GB GPU를 요구하므로 현재 16GB GPU는 권장 범위 밖이다. 실행 불가능으로 단정하지 않지만 양자화·오프로딩의 호환성과 속도는 미검증이다. 연구·비상업 사용과 상업 사용 조건을 구분해야 하며 설치 전 라이선스 검토가 필요하다. 다운로드하지 않았다.
  - https://huggingface.co/fishaudio/s2-pro
  - https://github.com/fishaudio/fish-speech
  - https://github.com/fishaudio/fish-speech/blob/main/docs/en/install.md
- Chatterbox Multilingual V3: 공개 코드·가중치, 한국어 언어 ID와 참조 음성 입력, 표현 강도 스칼라 지원. 분노/슬픔/명랑별 입력은 읽은 generate 함수에 없음. 한국어 전용 감정 모델은 아님. MIT 표기. 언어별 팩 6개에도 한국어 없음. 비교 후보일 뿐 지금 목적을 충족했다고 주장하지 않음.
  - https://github.com/resemble-ai/chatterbox/blob/master/src/chatterbox/mtl_tts.py
  - https://huggingface.co/ResembleAI/chatterbox
  - 읽은 코드의 최소 직접 파일: t3_mtl23ls_v3.safetensors(약2.14GB), s3gen.pt(약1.06GB), ve.pt(약5.7MB), grapheme_mtl_merged_expanded_v1.json. 약3.21GB이며 추가 의존 가중치/워터마커와 코드 전이 의존 범위는 아직 감사 안 함. 전체13.9GB를 내려받을 필요는 없음. from_pretrained 기본은 V2이므로 V3 명시 필요. 개별 리비전 고정과 호환 검수는 다운로드 전에 필요.
- Supertonic3: 한국어와 표현 태그를 공개 런타임에서 지원. 공개 패키지는 고정 음색, 참조에서 음색 JSON 생성은 모델 카드가 외부 Voice Builder로 안내. 오프라인 참조 복제 흡수 목표에 부적합. 최신 저장소는 2026-09-09 보관 처리되어 개발/지원 중단. 모델 OpenRAIL-M, 코드 MIT 구분.
  - https://huggingface.co/Supertone/supertonic-3
  - https://github.com/supertone-oss-archive/supertonic

## 권장 순서

1. 기존 Qwen 한국어 기본 화자와 지시 지원 경로를 대조 기준으로 검수. 기본 화자의 감정 전달과 참조 복제 감정 문제를 분리한다. 기본 화자로 바뀌는 것을 A/B/C 성공으로 보고하지 않는다.
2. 참조 복제까지 요구하면 한국어 감정 자료로 추가 학습할 수 있는 경로·필요 데이터·목소리/감정 분리 구조를 설계한다. 사용자 파일을 무작정 모으거나 승인 없이 학습하지 않는다.
3. Chatterbox는 표현 강도 비교가 필요할 때 선택 가능하나 감정 종류 선택 해결책이라고 설치하지 않는다.

다운로드·설치·추론·새 음성 생성 없음. 제품 기본 Qwen 유지. 이번 조사로 코드 테스트는 실행하지 않음.
