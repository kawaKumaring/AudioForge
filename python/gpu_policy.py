# -*- coding: utf-8 -*-
"""GPU 장치 선택 정책 — Auto / GPU / CPU 분리.

배경: audio_utils.get_device()의 torch.zeros(1) 프로브는 '점유 여부'를 판별하지 못한다
(ComfyUI가 VRAM 대부분을 잡고 있어도 스칼라 할당은 성공). 여기서는 실제 여유 VRAM
(torch.cuda.mem_get_info)을 근거로 Auto에서 안전하지 않으면 CPU를 고른다. mem_get_info의
free 값은 다른 프로세스(ComfyUI 등)의 점유를 반영하므로 별도 프로세스 스캔 없이도 점유를 감지한다.

정책:
  - "cpu": 무조건 CPU.
  - "gpu": 강제 GPU. CUDA 미가용이면 조용히 CPU로 낮추지 않고 RuntimeError(실패를 숨기지 않음).
  - "auto": CUDA 가용 + 여유 VRAM ≥ min_free_mb 이면 CUDA, 아니면 CPU(사유 포함).

select_device()는 (device, reason)을 반환 — reason은 progress 메시지로 노출한다.
"""

POLICY_AUTO = "auto"
POLICY_GPU = "gpu"
POLICY_CPU = "cpu"

# ECAPA-TDNN + speechbrain + 입력 배치 텐서의 대략적 여유. 휴리스틱(환경/모델에 따라 조정 가능).
# 스칼라 할당이 아니라 이 임계값과 실제 free VRAM 비교로 GPU 안전성을 판단한다.
DEFAULT_MIN_FREE_MB = 1500


def _cuda_free_total_mb(timeout_sec):
    """(free_mb, total_mb) 또는 None(타임아웃/조회 실패).
    스칼라 텐서 할당이 아니라 mem_get_info로 실제 여유 VRAM을 읽는다.
    CUDA 드라이버가 응답 없이 멈출 수 있어 데몬 스레드 + join 타임아웃으로 감싼다."""
    import threading
    import torch
    out = {}

    def _probe():
        try:
            free, total = torch.cuda.mem_get_info()
            out["free"] = free
            out["total"] = total
        except Exception as e:  # 조회 자체 실패(드라이버/컨텍스트 문제 등)
            out["error"] = repr(e)

    t = threading.Thread(target=_probe, daemon=True)
    t.start()
    t.join(timeout=timeout_sec)
    if t.is_alive() or "free" not in out:
        return None
    return (out["free"] / (1024 * 1024), out["total"] / (1024 * 1024))


def select_device(policy=POLICY_AUTO, min_free_mb=DEFAULT_MIN_FREE_MB, timeout_sec=10):
    """정책에 따라 (device, reason) 반환. TTS 등 다른 경로의 get_device는 건드리지 않는다."""
    import torch
    p = (policy or POLICY_AUTO).lower()
    cuda_available = bool(torch.cuda.is_available())

    if p == POLICY_CPU:
        return "cpu", "정책: CPU 강제"

    if p == POLICY_GPU:
        if not cuda_available:
            # 강제 GPU인데 CUDA가 없으면 조용히 CPU로 낮추지 않는다(실패를 숨기지 않음).
            raise RuntimeError("정책이 GPU 강제이지만 CUDA를 사용할 수 없습니다.")
        return "cuda", "정책: GPU 강제"

    # auto
    if not cuda_available:
        return "cpu", "CUDA 미가용 → CPU"
    info = _cuda_free_total_mb(timeout_sec)
    if info is None:
        return "cpu", "CUDA 응답 없음/조회 실패 → CPU (busy 추정)"
    free_mb, total_mb = info
    if free_mb >= min_free_mb:
        return "cuda", f"여유 VRAM {free_mb:.0f}/{total_mb:.0f}MB ≥ {min_free_mb}MB → GPU"
    return "cpu", (f"여유 VRAM {free_mb:.0f}/{total_mb:.0f}MB < {min_free_mb}MB "
                   f"(타 프로세스 점유 추정) → CPU")


def is_cuda_oom(exc):
    """예외가 CUDA OOM인지 판별. torch.cuda.OutOfMemoryError(있으면) 또는 메시지 기반."""
    try:
        import torch
        oom_type = getattr(torch.cuda, "OutOfMemoryError", None)
        if oom_type is not None and isinstance(exc, oom_type):
            return True
    except Exception:
        pass
    return "out of memory" in str(exc).lower()


def run_with_oom_retry(fn, device, cleanup=None, on_fallback=None):
    """fn(device)를 실행하고, device=='cuda'에서 CUDA OOM이 나면 자원을 정리한 뒤 CPU로 1회
    재시도한다. OOM이 아닌 예외는 그대로 전파한다 — 원인 불명 예외를 CPU 성공으로 숨기지 않는다.
    반환: (result, used_device).

    중요: except 블록 안에서 정리/재시도를 하면 예외 traceback이 fn 프레임(GPU 모델·배치 텐서
    보유)을 계속 참조해 empty_cache로도 VRAM이 풀리지 않는다. 그래서 OOM 메시지만 문자열로
    보관하고 예외/traceback 참조를 끊은 뒤, except 범위를 완전히 벗어나 gc.collect() + cleanup
    (empty_cache 등)을 실행하고 CPU로 재시도한다."""
    import gc
    oom_info = None
    try:
        return fn(device), device
    except Exception as e:
        if device == "cuda" and is_cuda_oom(e):
            oom_info = str(e)
            # 예외와 그 traceback(fn 프레임의 GPU 객체 보유)에 대한 이 프레임의 참조를 끊는다.
            del e
        else:
            raise
    # ── 여기는 except 범위 밖 → 예외 컨텍스트/traceback이 해제된 상태 ──
    gc.collect()          # fn 프레임/텐서를 실제로 수거
    if cleanup:
        cleanup()         # torch.cuda.empty_cache() 등 (수거 후에야 VRAM 반환)
    if on_fallback:
        on_fallback(oom_info)
    return fn("cpu"), "cpu"
