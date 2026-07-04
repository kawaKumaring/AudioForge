#!/usr/bin/env python3
"""AudioForge 모드별 스모크 테스트.

separate.py를 Electron과 동일한 방식(JSON config + stdout JSON lines)으로
호출해 각 모드가 크래시 없이 result까지 도달하는지 확인한다. 결과 품질이
아니라 '파이프라인이 끝까지 도는가'를 본다. C-1(번역 torch NameError)처럼
특정 옵션 경로에서만 터지는 버그를 커밋 당일 잡기 위한 안전망.

사용법:
  python smoke_test.py                 # split/meta-fix(즉시) + music + (샘플 있으면 transcribe/conversation)
  python smoke_test.py --quick         # torch 불필요한 즉시 모드만 (split, meta-fix)
  python smoke_test.py --sample PATH   # transcribe/conversation용 실제 음성 샘플 지정
  python smoke_test.py --tts REF       # TTS 모드도 테스트 (참조 음성 필요, 느림)

종료 코드: 0=전부 통과/스킵, 1=하나라도 실패.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audio_utils import find_ffmpeg  # noqa: E402

PYTHON = sys.executable
SEPARATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "separate.py")

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


def _run_mode(name, config, work_dir, timeout=600):
    """Run separate.py with a config; return (ok, detail).
    ok=True if a 'result' JSON was emitted and no 'error' before it."""
    cfg_path = os.path.join(work_dir, f"cfg_{name}.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False)

    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    try:
        proc = subprocess.run(
            [PYTHON, "-X", "utf8", "-u", SEPARATE, "--config", cfg_path],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=env, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return False, f"timeout ({timeout}s)"

    got_result = False
    last_error = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "result":
            got_result = True
        elif msg.get("type") == "error":
            last_error = msg.get("message", "unknown")

    if got_result:
        return True, "result 수신"
    if last_error:
        return False, f"error: {last_error[:120]}"
    tail = (proc.stderr or "").strip().splitlines()[-1:] or ["no output"]
    return False, f"result 없음 (exit {proc.returncode}): {tail[0][:120]}"


def _make_synthetic(work_dir):
    """440Hz/880Hz 톤 버스트로 12초 스테레오 wav 생성 (파이프라인 구동용)."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    out = os.path.join(work_dir, "synthetic.wav")
    # 3s tone, 1s silence, 3s tone, 1s silence, 4s tone = 12s
    cmd = [ffmpeg, "-y",
           "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
           "-ac", "2", "-ar", "44100", out]
    r = subprocess.run(cmd, capture_output=True)
    return out if r.returncode == 0 and os.path.exists(out) else None


def _check_translate():
    """en→ko 번역을 직접 태워 C-1(번역 torch NameError) 회귀를 감지한다.
    한국어 샘플로는 translate_to_korean이 조기 반환하므로 이 경로가 안 타짐 —
    반드시 비한국어 입력으로 torch.no_grad() 경로를 통과시켜야 한다."""
    try:
        from transcribe_worker import translate_to_korean
        out = translate_to_korean("Hello, this is a smoke test.", "en")
        if out and out.strip():
            return True, f"en->ko: {out[:40]}"
        return False, "번역 결과 없음 (NLLB 로드/다운로드 확인)"
    except (NameError, ImportError, AttributeError) as e:
        # 코드 결함(C-1류) — 반드시 실패로
        return False, f"코드 결함 {type(e).__name__}: {e}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {str(e)[:100]}"


def _find_sample():
    """작업파일/ 폴더에서 첫 오디오 샘플 탐색."""
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    work = os.path.join(base, "작업파일")
    if not os.path.isdir(work):
        return None
    for f in sorted(os.listdir(work)):
        if f.lower().endswith((".m4a", ".wav", ".mp3", ".flac")):
            return os.path.join(work, f)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="즉시 모드만 (split, meta-fix)")
    ap.add_argument("--sample", default="", help="transcribe/conversation용 실제 음성")
    ap.add_argument("--tts", default="", help="TTS 참조 음성 (지정 시 TTS 테스트)")
    args = ap.parse_args()

    work_dir = tempfile.mkdtemp(prefix="audioforge_smoke_")
    results = []  # (mode, status, detail)  status in PASS/FAIL/SKIP

    def record(mode, status, detail):
        results.append((mode, status, detail))
        color = {"PASS": GREEN, "FAIL": RED, "SKIP": YELLOW}[status]
        print(f"  [{color}{status}{RESET}] {mode:14s} {DIM}{detail}{RESET}")

    print(f"AudioForge 스모크 테스트\n{DIM}work: {work_dir}{RESET}\n")

    # ── 즉시 모드 (torch 불필요) ──
    synth = _make_synthetic(work_dir)
    if not synth:
        print(f"{RED}ffmpeg을 찾을 수 없어 합성 샘플 생성 실패 — split/music 스킵{RESET}")

    if synth:
        split_out = os.path.join(work_dir, "split_out")
        os.makedirs(split_out, exist_ok=True)
        ok, d = _run_mode("split", {
            "mode": "split", "input": synth, "output": split_out,
            "splitPoints": "4,8", "splitLabels": "A|B|C"
        }, work_dir)
        record("split", "PASS" if ok else "FAIL", d)

        # meta-fix는 split 결과 폴더의 json을 재적용
        if ok:
            ok2, d2 = _run_mode("meta-fix", {
                "mode": "meta-fix", "input": synth, "output": split_out
            }, work_dir)
            record("meta-fix", "PASS" if ok2 else "FAIL", d2)
        else:
            record("meta-fix", "SKIP", "split 실패로 스킵")
    else:
        record("split", "SKIP", "ffmpeg 없음")
        record("meta-fix", "SKIP", "ffmpeg 없음")

    if args.quick:
        return _summary(results)

    # ── 번역 경로 직접 검증 (C-1 회귀 감지 — 한국어 샘플로는 안 타는 경로) ──
    ok, d = _check_translate()
    record("번역(en→ko)", "PASS" if ok else "FAIL", d)

    # ── music (torch + demucs, 합성 샘플로 구동 확인) ──
    if synth:
        music_out = os.path.join(work_dir, "music_out")
        os.makedirs(music_out, exist_ok=True)
        ok, d = _run_mode("music", {
            "mode": "music", "input": synth, "output": music_out, "model": "htdemucs"
        }, work_dir)
        record("music", "PASS" if ok else "FAIL", d)

        rf_out = os.path.join(work_dir, "roformer_out")
        os.makedirs(rf_out, exist_ok=True)
        ok, d = _run_mode("music-roformer", {
            "mode": "music", "input": synth, "output": rf_out, "model": "roformer"
        }, work_dir)
        record("music(RoFormer)", "PASS" if ok else "FAIL", d)
    else:
        record("music", "SKIP", "ffmpeg 없음")

    # ── 실제 음성이 필요한 모드 ──
    sample = args.sample or _find_sample()
    if sample and os.path.exists(sample):
        # transcribe + translate: C-1(번역 torch NameError) 회귀 감지 경로
        tr_out = os.path.join(work_dir, "tr_out")
        os.makedirs(tr_out, exist_ok=True)
        ok, d = _run_mode("transcribe", {
            "mode": "transcribe", "input": sample, "output": tr_out,
            "whisperModel": "small", "translate": True, "srt": True
        }, work_dir)
        record("transcribe+번역", "PASS" if ok else "FAIL", d)

        conv_out = os.path.join(work_dir, "conv_out")
        os.makedirs(conv_out, exist_ok=True)
        ok, d = _run_mode("conversation", {
            "mode": "conversation", "input": sample, "output": conv_out, "nSpeakers": 2
        }, work_dir)
        record("conversation", "PASS" if ok else "FAIL", d)
    else:
        record("transcribe+번역", "SKIP", "실제 음성 샘플 없음 (--sample)")
        record("conversation", "SKIP", "실제 음성 샘플 없음 (--sample)")

    # ── TTS (참조 음성 필요, 모델 로딩 느림) ──
    if args.tts and os.path.exists(args.tts):
        tts_out = os.path.join(work_dir, "tts_out")
        os.makedirs(tts_out, exist_ok=True)
        ok, d = _run_mode("tts", {
            "mode": "tts", "input": args.tts, "output": tts_out,
            "ttsText": "안녕하세요. 스모크 테스트입니다.", "ttsEngine": "auto"
        }, work_dir, timeout=900)
        record("tts", "PASS" if ok else "FAIL", d)
    else:
        record("tts", "SKIP", "참조 음성 없음 (--tts)")

    return _summary(results)


def _summary(results):
    n_pass = sum(1 for _, s, _ in results if s == "PASS")
    n_fail = sum(1 for _, s, _ in results if s == "FAIL")
    n_skip = sum(1 for _, s, _ in results if s == "SKIP")
    print(f"\n{'='*44}")
    print(f"통과 {GREEN}{n_pass}{RESET} / 실패 {RED}{n_fail}{RESET} / 스킵 {YELLOW}{n_skip}{RESET}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
