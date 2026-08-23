# Cross-Mode 기술 조사 참고자료 색인

`design/cross-mode-job-safety-contract` 브랜치에 통합한 4개 분야 기술 조사 문서(read-only 복사본).
원본은 각 소유 worktree에 그대로 두고, 이 브랜치는 계약(`../design/cross-mode-job-safety-contract.md`)·intake
(`../design/cross-mode-research-intake.md`) 근거로만 참조한다. 축약·재해석하지 않은 전문 사본이다.

| 분야 | 파일 | 핵심 적용 계약 | 줄 수 | 핵심 사실 정정([F]) |
|---|---|---|---|---|
| 음악 분리 | [music-separation-techniques.md](music-separation-techniques.md) | §21·§22·§24 | 220 | 5 preset + 파형 앙상블(정합 검증·mixture consistency·manifest 부재) |
| 대화 화자 분석 | [dialogue-processing-techniques.md](dialogue-processing-techniques.md) | §20·§23·§25 | 207 | conversation = argmax 단일화자 마스킹(실제 source separation 아님) |
| 오디오 텍스트 추출(ASR) | [text-extraction-techniques.md](text-extraction-techniques.md) | §20·§23·§26 | 235 | 이미지 OCR 아니라 Whisper 오디오 ASR |
| 영상/트랙 분할 | [video-segmentation-techniques.md](video-segmentation-techniques.md) | §22·§29·§30 | 220 | split = 오디오 무음/수동 marker 트랙 분할(시각 shot/scene 아님) |

## 사실 등급 표기(각 문서 공통)
- **[사실]/[코드 사실]/[공식 사실]** — 원 논문·공식 저장소/문서 또는 현재 AudioForge 코드로 확인.
- **[제작사 주장]/[제작자 보고]** — 배포자 보고 점수. 재현 전 제품 성능으로 간주 금지.
- **[추론]/[적용 추론]** — 공개 원리와 현행을 연결한 개선 가설. synthetic/open benchmark 검증 전 사실 아님.

## 조사 제한(각 문서 공통)
사용자 미디어·전사 본문·ComfyUI workflow/prompt 미열람, 외부 API·모델 다운로드·GPU 실행 없음, 저장소 read-only.

## 계약 연결
- 공통 job-safety 불변식·모드별 차이·P0/P1: `../design/cross-mode-job-safety-contract.md`(§20–§30).
- 분야별 P0/P1/P2·fixture·적용 계약 절 매핑: `../design/cross-mode-research-intake.md`.
- 별도 audit: `research/cross-mode-reliability-audit.md`(다른 브랜치).
