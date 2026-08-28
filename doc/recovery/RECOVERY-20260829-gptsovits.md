# 복구 기록 — 2026-08-29 GPT-SoVITS / env.json

## 사고
worktree 정리 중 `[System.IO.Directory]::Delete(path, recursive:true)` 가 junction 을 따라 들어가
공용 `externals` 의 일부를 삭제했다. junction 을 먼저 분리하고 잔여 링크 0 을 확인했으나 그 검사만
믿고 재귀 삭제를 실행한 판단이 원인이다. 승인 범위는 "worktree 폴더 4개 제거"였고 결과는 그 범위를 벗어났다.

## 삭제된 것
- `externals/GPT-SoVITS/` (엔진 코드 저장소)
- `externals/env.json`
- `externals/gptsovits_venv/Lib/site-packages` 의 a~l 구간 패키지
- `~/.cache/huggingface/hub/models--lj1995--GPT-SoVITS` 의 snapshots/blobs (refs 만 잔존)

## 복구 결과
- `env.json` — **원본과 동일하게 복원**. 삭제 전 확인된 단일 키(`python`)를 그대로 재생성, JSON 파싱과
  대상 인터프리터 존재를 검증.
- `GPT-SoVITS` 코드 — **기능적으로 재구성**. 공식 저장소(RVC-Boss/GPT-SoVITS)에서 clone.
  원본 revision 은 삭제 전 기록이 없어 **미확인**이며, 최신 clone 을 원상복구라고 부르지 않는다.
- 사전학습 모델 — **기능적으로 재구성**. `lj1995/GPT-SoVITS` 에서 setup 스크립트가 명시한 4개 자산
  (chinese-roberta-wwm-ext-large, chinese-hubert-base, gsv-v2final s1/s2)만 받아 배치.
  9파일/1050.6MB, **심볼릭 링크 0(독립 파일)**, 파일별 SHA-256 을 manifest 에 기록하고 배치본과 대조(불일치 0).

## 미복구
- `gptsovits_venv` — 손상 상태 그대로. 지시에 따라 임의 수리하지 않았다.
  소실 확인: transformers, librosa, ffmpeg, einops, jieba, g2p_en, pytorch_lightning,
  pyopenjtalk, LangSegment, fast_langdetect, gradio.
  잔존 확인: torch, numpy, scipy, soundfile.
  → GPT-SoVITS 엔진 실행은 현재 불가. 별도 환경 복구가 필요하다(패키지 설치는 미승인 영역).
- HF 캐시 — 재구성하지 않았다(모델은 staging 경유로 확보).

## 영향 없음(검증)
- Qwen 경로 무변경: `qwen3_tts_venv` (dist-info a~u 완전, torch 2.13.0+cu130, cuda True, qwen_tts import OK),
  `qwen3_tts_hf` 스냅샷 8파일, `qwen3_tts_1_7b_base`, `separator_models`.
- develop `ca2533d` (= origin), master `ca42b0e`, v1.0.0 무변경.

## 보존물(삭제 금지)
- 복구 staging: `E:\AudioForge_output\_recovery-staging\20260829-gptsovits\`
- 진단 아카이브: `E:\AudioForge_output\_diagnostic-archive\20260829-worktree-cleanup\`
  (음성·전사·토큰 포함 — Git·외부 업로드 금지. 이 문서와 manifest 는 비민감 수치만 담는다.)

## 재발 방지
worktree 제거는 git 의 자체 제거를 쓰고, 실패하면 남긴다. 링크가 섞인 트리에 재귀 삭제를 직접 호출하지 않는다.
