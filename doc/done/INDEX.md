# 완료 구현 색인 (빠른 확인용)

**목적**: "무엇을 · 언제 · 어디에 기록됐는지"만 한눈에. 상세는 링크된 문서 섹션에서 본다.

**앵커 규칙 — 라인 번호 대신 `(커밋 해시 + 문서 섹션 제목)`로 가리킨다.**
- 이유: 라인 번호는 파일을 한 번만 편집해도 어긋난다. 실제로 2026-08 정리 때
  code-review 문서의 `conversation_worker.py:366`, `python-runner.ts:104` 등 라인 참조가
  대부분 어긋나 있던 것을 확인했다. **섹션 제목·커밋 해시는 편집에 흔들리지 않는다.**
- 정확한 코드 위치가 필요하면 커밋 해시로 `git show <hash>`를 보면 그 시점 상태가 정확히 나온다.

**문서 지도**
- `changelog.md` — 시간순 상세 기록(무엇을 왜 어떻게). 살아있는 로그.
- `code-review-2026-07-05.md` — 버그/개선 단일 소스(상태표 + 근거). 보류 항목 포함해 살아있음.
- `done/INDEX.md`(이 파일) — 완료 작업의 슬림 색인. 상세로 가는 포인터.

---

## 2026-08

| 날짜 | 핵심 (한 일) | 커밋 | 상세 위치 |
|------|-------------|------|-----------|
| 08-28 | 경계 envelope: 시작·끝 급절단(클릭) 수정(onset 10ms/offset 20ms, 실측 확정) | `63ce38b` | boundary-envelope-2026-08-28.md 전체 |
| 08-21 | TTS GUI/UX: 긴 참조 3~10초 구간 선택(파생 클립)·합성 게이팅·문구 정정 | 동일 커밋 | changelog §"TTS GUI/UX: 긴 참조 구간 선택(3~10초 파생 클립) + 합성 게이팅 + 문구 정정" |
| 08-21 | 실측 안정화: WDDM Auto VRAM 측정(nvidia-smi) 분리 + Qwen 취소 잔존물 정리 | `19f777c` | changelog §"실측 안정화: WDDM Auto VRAM 측정 출처 분리 + Qwen 취소 잔존물 정리" |
| 08-21 | Qwen3-TTS 엔진 연동(한국어 Auto 우선, job bridge 모델 1회) | 동일 커밋 | changelog §"Qwen3-TTS 엔진 연동 (한국어 Auto 우선순위, job bridge 모델 1회 로딩)" |
| 08-21 | TTS 2C-2: 수동 참조 전사 UI + 전달 경로(ref-free>수동>자동) | `69713a8` | changelog §"TTS 2C-2: 수동 참조 전사 UI + 전달 경로(명시적 ref-free > 수동 > 자동)" |
| 08-21 | 대화 분리 GPU 정책(Auto/GPU/CPU)+OOM 재시도+종료 상태 보장 | `ccebd10` | changelog §"대화 분리 GPU 정책 분리(Auto/GPU/CPU) + OOM 재시도 + 종료 상태 보장" |
| 08-21 | TTS 2C-1: 참조 전사 구조화 + ref-free 강등 관측화 | `b9859eb` | changelog §"TTS 2C-1: 참조 전사 구조화 + 조용한 ref-free 강등 관측화" |
| 08-21 | TTS 2B: 참조 음성 분석·판정 구조화 + GPT 로딩 전 게이트 | `1c0b9ab` | changelog §"TTS 2B: 참조 음성 분석·판정 구조화 + GPT 로딩 전 게이트" |
| 08-20 | TTS 2A: 감정 참조 라우팅 회귀 테스트(모델 없이) | `8d3975e` | changelog §"TTS 2A: 감정 참조 라우팅 회귀 테스트 (모델 없이 검증)" |
| 08-20 | TTS 1단계 전달 결함 수정(ttsEmotionRefs 누락+0초 변질) | `e1436ea` | changelog §"TTS 1단계 전달 결함 수정 (ttsEmotionRefs 누락 + 0초 변질)" |
| 08-16 | LLM 잔재 글자 NLLB 수리 + 구글 번역 백엔드 | `c169e71` | changelog §"LLM 잔재 글자 NLLB 수리 + 구글 번역 백엔드" |
| 08-16 | 에너지 게이트(아웃로 환각 제거) + Mel-Band 단일 모드 | `c015263` | changelog §"유틸 검증 후속: 에너지 게이트(아웃로 환각) + Mel-Band 단일 모드" |
| 08-16 | 보컬 앙상블(BS-RoFormer + Mel-Band, 잔음 최소) | `eed68a1` | changelog §"보컬 앙상블 (BS-RoFormer + Mel-Band 2모델, 잔음 최소)" |
| 08-16 | Whisper 환각 억제 + 타임라인 번역 한 번에(언어 혼입 제거) | `6b5e046` | changelog §"Whisper 환각 억제 + 타임라인 번역 한 번에(언어 혼입 제거)" |
| 08-16 | 트랙 재생 버튼 원위치 복귀 + 전환 중첩 버그 수정 | `edacf2e` | changelog §"트랙 재생 버튼 원위치 복귀 + 전환 중첩 버그 수정" |
| 08-16 | 세션 저장/복원(session.json, 재분리 없이 불러오기) | `e0a0a5d` | changelog §"세션 저장/복원 (재분리 없이 이전 결과 불러오기)" |
| 08-16 | 트랙 재생 이중 컨트롤 제거(중첩 재생 버그 수정) | `f5eb3df` | changelog(트랙 재생기 항목) |
| 08-16 | 결과 트랙 재생기: 파형+시간+볼륨+드래그 이동 | `4149f1d` | changelog §"결과 트랙 재생기: 파형 + 시간 + 볼륨 + 드래그 이동" |
| 08-16 | 타임라인 번역 파일 생성(_korean_timeline.txt) | `6d31fd4` | changelog §"타임라인 번역 파일 생성 (_korean_timeline.txt)" |
| 08-16 | 음악 전사=보컬만 + 재번역 버튼 + 트랙 번역 백엔드 반영 | `b87fa39` | changelog §"음악 전사는 보컬만 + 재번역 경로 + 트랙 번역 백엔드 반영" |
| 08-16 | 파형 재생 볼륨(듣기 전용) + 드래그 이동 | `e8d8678` | changelog §"파형 재생 편의: 볼륨(듣기 전용) + 드래그 이동" |
| 08-16 | 무음 감지 미리보기 + 경계 청취 (Phase A) | `7c293bc` | changelog §"무음 감지 미리보기 + 청취 (Phase A)" / silence-preview-design.md |
| 08-16 | 파일 열기 시 마지막 폴더 기억(defaultPath) | `3efb45e` | changelog §"파일 열기 시 마지막 폴더 기억" |
| 08-16 | 툴팁 확충 — 출력/분리/언어/칩/TTS엔진 의미 설명 | `3ab5770` | changelog §"옵션 패널 레이아웃 wrap + Whisper 툴팁" |
| 08-16 | 옵션 패널 wrap 레이아웃(앵커 고정 + 아래로 줄바꿈) | `43407de` | changelog §"옵션 패널 레이아웃 wrap + Whisper 툴팁" |
| 08-16 | 문서 정합성 정리(날짜 오기·낡은 항목) | `03b3d63` | changelog(본 색인 생성 계기) |
| 08-16 | 완성도 개선 L-1~L-11 전부 소진(그룹 A~F) | `eb761a7`~`7b6572e` | changelog §"완성도 개선 패스" / code-review §수정현황표 L-1~L-11 |
| 08-16 | 입력 포맷 전면 개방(ffmpeg 전부, mo3 등) | `5b2c57c` | changelog §"입력 포맷 전면 개방" |
| 08-14 | Whisper large-v3-turbo 옵션(기본 유지) | `8f05de8` | changelog §"Whisper Turbo 옵션 추가" |
| 08-14 | 화자 분리 kmeans 시드 고정 → 재현성(L-7) | `0e28f5e` | changelog §"화자 분리 재현성" |

## 2026-07 (요약)

| 날짜 | 핵심 | 커밋 | 상세 위치 |
|------|------|------|-----------|
| 07-24 | 로컬 LLM 번역 백엔드(Qwen2.5-3B, API 미사용) | `02fe915` | changelog / code-review §9-2 |
| 07-24 | 화자 분리 속도(임베딩 배치+Gaussian 벡터화) | `d2b70c4` | changelog / code-review §M-2 |
| 07-05 | 전수 리뷰 + Critical/High/Medium 12건 수정 | (다수) | code-review-2026-07-05.md 전체 |

---

## 갱신 규칙
- 작업 하나를 커밋·푸시할 때, 이 표에 **한 줄** 추가(날짜/핵심/커밋/문서§).
- 핵심은 한 줄로. 상세는 changelog에 쓰고 여기선 그 섹션 제목만 가리킨다.
- 라인 번호는 쓰지 않는다(위 앵커 규칙).
