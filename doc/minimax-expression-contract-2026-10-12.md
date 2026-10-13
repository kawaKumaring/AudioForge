# 감정·기호 연출 입력 계약 조사

공식 문서 및 설치된 H3 노드 코드 조사만 했다. 생성·서비스 호출·다운로드 없음. 아래는 문서 지원 여부이며 우리 환경의 청취 합격 판정이 아니다.

Speech API: `voice_setting.emotion`에 happy/sad/angry/fearful/disgusted/surprised/calm을 보낸다. 기본은 글에 따른 자동 선택. fluent/whisper는 문서상2.6계열 전용이며2.8의 whisper는 지원하지 않는다. 감정은 일반 대사에 삽입하는 낱말이 아니다.2.8계열의 `(laughs)`·`(chuckle)`·`(breath)`·`(sighs)`는 비언어 발성 태그다. `<#0.7#>`은 쉼 요청이며 태그 연속 사용은 허용되지 않는다. API의 voice_modify.intensity는 소리의 강함/부드러움 조절이고 감정 강도 척도가 아니다. 구현된 서버 내부 구조는 공개 호출 계약만으로 확인할 수 없다.

H3: 한국어 대사는 `<d>[Korean] …</d>`, 화자 `(S1)`, 참조 `<Audio 1>`을 일관되게 연결한다. 말투·감정·단어 강조는 대사 밖의 영어 자연어로 구체화한다. 공식 가이드는 기본 구두점과 문장 끝 표기를 사용하고 장식 기호를 정리하도록 권한다. `<scenetrans>`는 컷 사이 발화 연결, `<cutoff>`는 끝에서 의도적으로 잘리는 발화 표기이며 말끝 보호 기능이 아니다. Speech용 태그를 그대로 지원한다고 가정하지 않는다.

설치 nodes_minimax_h3.py는 prompt를 Qwen 텍스트 인코더에 전달하고, 참조 오디오를 audio VAE로 인코딩해 conditioning의 minimax_refs에 붙인다. 별도 anger/happy 판독기로 음량을 바꾸는 코드가 아니다. 강한 감정 설명·동작·호흡 지시는 모델이 해석하며 정확한 효과를 보장하지 않는다. CFG나 audio sigma shift도 감정 강도 척도가 아니다.

AudioForge 설계 제안: 원문은 그대로 저장하고 엔진별 전달 글·감정 설정·쉼 계획을 따로 보존한다. 감정 종류와 연기 설명, 실제 쉼, 소리 후처리를 분리한다. H3의 쉼 설명은 의미 지시로 표시하고 정량적 쉼으로 보장하지 않는다. 같은 UI를 쓰더라도 엔진의 지원 여부에 따라 번역·거절·미지원 표시를 한다. ♥·반복대시를 임의 감정으로 확정하거나 Speech 태그를 Qwen/H3에 조용히 보내지 않는다. 장식 기호 처리도 원문을 삭제하는 것이 아니라 전달 미리보기와 변경 기록을 갖는 선택 기능이어야 한다. 정식 구현은 이번 범위 밖이다.

출처:
- https://platform.minimax.io/docs/api-reference/speech-t2a-http (세부 스키마는 같은 경로의 .md로 확인)
- https://www.minimax.io/news/minimax-speech-28
- https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md
- https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md
- E:\AI\ComfyUI_windows_portable_python3.12\ComfyUI\comfy_extras\nodes_minimax_h3.py
