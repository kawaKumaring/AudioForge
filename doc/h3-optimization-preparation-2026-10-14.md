# H3 추가 최적화 준비 — 2026-10-14

## 판단

새 음성 생성은 사용자 지시로 미룬다. 현재 본체는 minimax_h3_ref2va_pruned_int8_convrot, 텍스트 인코더만 NVFP4/AWQ다. NVFP4 본체용 Fused MLP 성능 수치를 이 구성에 적용할 수 없다.

공개 연산 결합 구현은 DiTBlock.forward를 교체한다. 현재 앱 내부의 forward에는 attention 인자가 추가로 있으며 이를 받아 호출한다. 공개 구현의 대체 함수에는 이 인자가 없고 self.attn을 직접 호출한다. 그대로 흡수하면 현재 Attention 선택 계약을 손상시킬 수 있으므로 붙이지 않았다. 보존한 인자·연산 반올림·출력 지문을 확인한 뒤 별도 적용해야 한다. 공개 accurate 경로도 모든 환경에서 동일 음질을 보장한다는 뜻이 아니다.

현재 설치 상태: torch 2.11.0+cu130, triton-windows 3.6.0.post26, sageattention 2.2.0+cu130torch2.9.0andhigher.post4. 패키지 존재와 배포 메타만 확인했다. GPU 커널 실행·이진 호환성은 아직 확인하지 않았다. 설치·다운로드 없음.

SageAttention 공용 래퍼는 실행 오류 때 PyTorch로 돌아가는 경로가 있어 그대로 비교하면 가속 적용 여부를 잘못 판단할 수 있다. 이번에는 기존 자동 선택과 명시적 PyTorch만 검수용으로 연결했다. Sage 방식 추가는 실패를 숨기지 않는 경로와 실제 GPU 검증을 확보한 뒤 판단한다.

## 이번 구현

기본값 256·16단계·CFG1·res_multistep/simple 유지. AF_H3_DIAGNOSTIC=1을 명시했을 때만 128·64 크기 또는 PyTorch 방식을 고를 수 있다. 미지원 값은 적재 전에 거절한다. 문장 분할·원문·참조·시간 예산·후처리 변경 없음.

크기·요청 계산 방식·검수 모드가 캐시 열쇠에 포함된다. 설정이 다르면 조건을 새로 준비한다. 생성 기록에는 canvas, attention_requested, attention_selected, diagnostic이 들어간다. attention_selected는 선택된 래퍼이며 모든 내부 연산을 추적한 값이 아니다. 기존 INT8 래퍼 안에도 입력 조건에 따라 PyTorch를 호출하는 분기가 있다. 이를 실제 커널 실행 증거로 쓰지 않는다.

scripts/compare-h3-profiles.py: 기본 실행은 계획 출력뿐이며 참조 파일을 읽지 않고 모델도 적재하지 않는다. --execute와 --approve-reference, 참조·새 저장 폴더를 명시해야 생성한다. 이미 있는 폴더는 거절하며 master/_local/테스트/결과 아래만 사용한다. 이번에는 실행 모드를 사용하지 않았다.

준비된 비교는 동일 대사·참조·seed로 256/128/64 자동 방식, 256 PyTorch의 네 조건이다. 각각 모델을 내리고 준비한다. 런타임과 OS 캐시는 남으므로 총시간을 완전히 공정한 cold 비교로 부르지 않는다. 단계별 시간도 함께 보고 반복 순서 비교가 필요하면 별도로 한다. 음성 지문·요청 설정·선택 래퍼·단계 시간·참조 지문·정확한 결과 경로와 청취 페이지를 남긴다. 참조는 승인된 파일 스냅샷을 사용한다. 생성이 끝나지 않으면 실패 기록을 남기며 합격으로 표시하지 않는다.

영상 크기를 줄이면 영상 토큰은 줄지만 음성 위치 좌표도 달라질 수 있다. 음성 길이는 유지해도 발음·음색 동일성은 보장하지 않는다. 청취 전 기본값을 바꾸지 않는다.

## 검사

구현 후 관련 Python22건·상주 소유권 Node1건, 총23건 통과. 캐시 분리·작은 크기 전달·원문 보존·기본값·잘못된 설정 거절·계획만 실행의 파일 읽기 금지·명시적 실행 승인 조건을 확인했다. GPU 모델을 사용하지 않고 검사 음원과 대역을 사용했다. 전체 검사·앱 실행·캡처·실제 생성 없음.

## 남은 일

GPU 생성 재개 시 앞서 남은 실제 미사용 해제·취소부터 확인한다. 다음 네 조건의 실제 시간·발음·참조 음색·말끝을 비교한다. 현재 추가 속도 향상 또는 음질 합격은 미확인이다. develop만 커밋·푸시하며 master 병합하지 않는다. 보류 연기 편집기와 기존 미완료 변경 제외.

## 자료

- ComfyUI 영상·음성 잠재값 생성: https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py
- H3 연산 결합 연결: https://github.com/ByronLeeeee/ComfyUI-MiniMax-H3-Optimization-Suite/blob/main/plugins/ComfyUI-H3-Fused-Kernels/nodes.py
- 연산 결합 코드: https://github.com/ByronLeeeee/ComfyUI-MiniMax-H3-Optimization-Suite/blob/main/plugins/ComfyUI-H3-Fused-Kernels/kernels.py
- 방식·측정 한계: https://github.com/ByronLeeeee/ComfyUI-MiniMax-H3-Optimization-Suite/blob/main/README.md
- SageAttention 공식: https://github.com/thu-ml/SageAttention

자료 열람은 했으나 외부 코드·모델 다운로드나 설치는 하지 않았다.
