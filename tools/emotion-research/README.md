# 감정 음률 조사용 분석 스크립트

제품 코드가 **아니다.** 앱 빌드·배포물에 들어가지 않는다. 조사·설계 단계의 도구다.
권위 문서는 `doc/work-in-progress/tts-emotion-rule-design.md` 하나다.

## 실행 환경
기존 AudioForge·ComfyUI·사용자 Python 환경을 건드리지 않는 **별도 venv** 에서만 돌린다.
최소 의존성은 `pyworld`, `numpy`, `soundfile` 뿐이고 전부 휠로 설치된다(빌드 도구 불필요).
`torch`·CUDA 를 설치하거나 바꾸지 않는다. **CPU 만 쓴다.**

```
python -m venv <실험용경로>/venv
<실험용경로>/venv/Scripts/python -m pip install --only-binary=:all: pyworld numpy soundfile
```

## 스크립트

### `f0_curve_resynth.py <입력.wav>`
이미 만들어진 음성에 **F0 곡선만** 걸 수 있는지 확인한다. A/B/C 를 만든다.
- A 원본 · B 파라미터 무변경 재합성(대조군) · C 유성 구간만 F0 곡선 변경
- 길이·스펙트럼 포락·비주기성은 유지. 감정 이름을 붙이지 않는다(제어 가능성 시험값).

### `ravdess_extract_pairs.py [쌍 폴더]`
같은 화자·같은 문장의 **중립/감정 쌍**에서 시간축 F0·상대 음높이·길이·쉼·추정 오류를 뽑는다.
SVG 그래프를 의존성 없이 직접 그린다(분석 불가 구간은 선을 끊어 표시).

**⚠️ 정렬**: 시간 정규화만 한다. **구절 정렬이 아니다.** 구절별 규칙을 얻었다고 말할 수 없다.

## 자료
- 음원·다운로드 파일은 `_local/` 아래에 두어 **Git 에 넣지 않는다.**
- RAVDESS 는 CC BY-NC-SA 4.0(비상업). 인용: Livingstone SR, Russo FA (2018) PLoS ONE 13(5): e0196391.
- **자료나 파생 규칙을 제품 배포물에 넣는 것은 별도 승인 사항이다.**
