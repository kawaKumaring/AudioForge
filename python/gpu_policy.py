# -*- coding: utf-8 -*-
"""GPU 장치 선택 정책 — Auto / GPU / CPU 분리.

배경: audio_utils.get_device()의 torch.zeros(1) 프로브는 '점유 여부'를 판별하지 못한다
(ComfyUI가 VRAM 대부분을 잡고 있어도 스칼라 할당은 성공). Auto에서는 실제 여유 VRAM을 근거로
안전하지 않으면 CPU를 고른다.

측정 출처(중요 — 플랫폼별로 분리):
  - Windows(WDDM): torch.cuda.mem_get_info()의 free는 이 환경에서 다른 프로세스(그래픽/게임/
    ComfyUI 등)의 점유를 신뢰성 있게 반영하지 못함이 실측으로 확인됐다(nvidia-smi free 2121MiB인데
    mem_get_info는 14148MiB로 보고). 따라서 Windows Auto의 1차 근거는 nvidia-smi의 GPU 전체
    memory.free이며, 대상 GPU index 행만 사용한다. nvidia-smi 부재/timeout/파싱 실패 시 Auto는
    보수적으로 CPU를 고른다(torch 값으로 폴백하지 않는다 — 위 이유로 신뢰 불가).
  - 그 외(Linux 등): torch.cuda.mem_get_info() 경로를 유지한다.
  - 선택 사유(reason)에는 free·threshold·source(측정 출처)를 포함한다.

정책:
  - "cpu": 무조건 CPU.
  - "gpu": 강제 GPU(명시적 선택). CUDA 미가용이면 조용히 CPU로 낮추지 않고 RuntimeError.
  - "auto": CUDA 가용 + 여유 VRAM ≥ min_free_mb 이면 CUDA, 아니면 CPU(사유 포함).

OOM은 측정과 별개의 최종 안전망 — run_with_oom_retry가 CUDA OOM 시 CPU로 1회 재시도한다.

select_device()는 (device, reason)을 반환 — reason은 progress 메시지로 노출한다.
"""

POLICY_AUTO = "auto"
POLICY_GPU = "gpu"
POLICY_CPU = "cpu"

# 작업별 required_free_vram: select_device(min_free_mb=...)로 호출자가 작업에 맞는 임계를 준다.
# 하나의 고정값을 공유하지 않는다(작업마다 실측 VRAM이 다르므로).
#   - 대화 분리(ECAPA-TDNN+speechbrain): DEFAULT_MIN_FREE_MB=1500 (기존 근거값 유지).
#   - Qwen3-TTS: tts_worker._QWEN_MIN_FREE_MB=4000 (실측 peak ~2569MiB + 안전 여유).
# 스칼라 할당이 아니라 이 임계값과 실제 free VRAM 비교로 GPU 안전성을 판단한다.
DEFAULT_MIN_FREE_MB = 1500


def _is_windows():
    """플랫폼 판별을 한 곳으로 — 테스트에서 이 함수만 patch하면 OS 분기를 검증할 수 있다."""
    import os
    return os.name == "nt"


def _nvidia_smi_free_total_mb(gpu_index, timeout_sec):
    """(free_mb, total_mb) 또는 None. Windows Auto의 1차 근거(GPU 전체 memory.free).
    nvidia-smi 부재/timeout/비정상 종료/파싱 실패/대상 index 부재 → None(호출부에서 보수적으로 CPU).
    멀티 GPU에서 gpu_index 행만 사용한다."""
    import subprocess
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,memory.total,memory.used,memory.free",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=timeout_sec)
    except (OSError, subprocess.SubprocessError):
        return None  # 명령 부재(FileNotFoundError) / timeout 등
    if out.returncode != 0:
        return None
    for line in (out.stdout or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        try:
            idx = int(parts[0])
            total = float(parts[1])
            free = float(parts[3])
        except ValueError:
            continue  # 비정상/헤더 라인
        if idx == gpu_index:
            return (free, total)
    return None  # 대상 index 행 없음


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

    # 대상 GPU index(현재 CUDA 디바이스). 조회 실패 시 0.
    try:
        gpu_index = int(torch.cuda.current_device())
    except Exception:
        gpu_index = 0

    if _is_windows():
        # Windows: nvidia-smi GPU 전체 free가 1차 근거. torch 값으로 폴백하지 않는다.
        source = "nvidia-smi"
        info = _nvidia_smi_free_total_mb(gpu_index, timeout_sec)
        if info is None:
            # 시스템 측정 실패 → 보수적으로 CPU(신뢰 가능한 free를 못 얻음).
            return "cpu", (f"nvidia-smi 측정 실패(부재/timeout/파싱) → 보수적 CPU "
                           f"(threshold={min_free_mb:.0f}MB, source={source})")
    else:
        # Linux 등: 기존 torch 경로 유지.
        source = "torch.mem_get_info"
        info = _cuda_free_total_mb(timeout_sec)
        if info is None:
            return "cpu", (f"CUDA 응답 없음/조회 실패 → CPU (busy 추정, "
                           f"threshold={min_free_mb:.0f}MB, source={source})")

    free_mb, total_mb = info
    if free_mb >= min_free_mb:
        return "cuda", (f"여유 VRAM {free_mb:.0f}/{total_mb:.0f}MB ≥ {min_free_mb:.0f}MB → GPU "
                        f"(source={source})")
    return "cpu", (f"여유 VRAM {free_mb:.0f}/{total_mb:.0f}MB < {min_free_mb:.0f}MB → CPU "
                   f"(source={source})")


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
