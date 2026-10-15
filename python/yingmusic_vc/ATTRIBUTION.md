# YingMusic-SVC 추론 흡수

공식 코드: https://github.com/GiantAILab/YingMusic-SVC
고정 판: 4974a80c6044c4557059548409379f6365129f88 (MIT, LICENSE.txt 보존).
모델: GiantAILab/YingMusic-SVC, da6b73938afeb7ede4c8d93ef007af2abb04ef49, CC BY-NC 4.0.

convert.py는 AudioForge song_vc/convert.py(GPL-3.0)를 바탕으로 하며 그 사용 조건을 따른다.
공통 음향 부품은 ../song_vc/modules를 재사용한다(해당 LICENSE·ATTRIBUTION 유지).
전용 length_regulator·diffusion_transformer·flow_matching·commons는 공식 코드에서 가져왔다.
변경: 학습용 F0 변형 의존 제거, 쓰지 않는 시각화/중간 텐서 보관 제거,
로컬 모델만 로딩, 가중치 누락 엄격 거절, seed 명시, 자동 조옮김/속도 변경 거절,
참조 style residual 전달, 출력 FLOAT WAV. 소리 후처리 없음.
공식 RVC 학습 부품·별도 분리기·화면·학습 자료는 다운로드하지 않는다.
기본 엔진은 변경하지 않는다. AF_SONG_VC_ENGINE=yingmusic 명시 시에만 선택한다.

추가: 기존 흡수본 Munch 호환 dict 재사용, 비활성 양자화의 DAC import 지연.
참조 12초 상한, 기존 출력 덮어쓰기 금지, 비정상 실수 출력 거부.
