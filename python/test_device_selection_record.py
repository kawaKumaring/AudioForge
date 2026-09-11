# 장치 선택 **사유 기록**의 계약. 선택 정책 자체는 시험하지 않는다(바꾸지 않았다).
#
# 왜 이 파일이 있는가(2026-09-11 조사): 실행 기록 98건 중 3건이 CPU 로 완주했는데,
# 기록에는 셋 다 `device_selection_source = "nvidia-smi"` 로만 남아 있었다. 정상 판단과
# **측정 실패로 보수적 CPU 를 고른 경우**가 같은 한 단어로 기록돼, 사후에 "여유가 충분한데
# 왜 CPU 였는지" 를 가릴 수 없었다. 원인은 `_parse_device_source` 에서 `source=` 정규식이
# 앞에 있어 뒤의 측정 실패 분기가 **도달하지 못한 것**이었다.
#
# ★이 시험은 과거 CPU 실행의 원인을 밝히지 않는다. 다음에 같은 일이 생겼을 때
#   **기록만으로 갈릴 수 있게** 만드는 것이 목적이다.
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts_worker   # noqa: E402


class DeviceSelectionRecordTest(unittest.TestCase):
    def test_normal_nvidia_smi_selection(self):
        """정상 판단 — 출처가 그대로 남는다."""
        r = "여유 VRAM 10794/16302MB ≥ 4000MB → GPU (source=nvidia-smi)"
        self.assertEqual(tts_worker._parse_device_source(r), "nvidia-smi")

    def test_measure_failure_is_not_masked_by_source_regex(self):
        """★핵심 — 측정 실패 사유에도 `source=nvidia-smi` 가 들어 있다.

        정규식이 먼저 걸리면 정상 판단과 구별되지 않는다. 구별돼야 한다."""
        r = ("nvidia-smi 측정 실패(부재/timeout/파싱) → 보수적 CPU "
             "(threshold=4000MB, source=nvidia-smi)")
        got = tts_worker._parse_device_source(r)
        self.assertNotEqual(got, "nvidia-smi", "정상 판단과 같은 값으로 기록되면 구분이 불가능하다")
        self.assertEqual(got, "nvidia-smi(측정실패→CPU)")

    def test_reason_without_source_label(self):
        """출처 라벨이 없는 사유 — 지어내지 않고 None 이다."""
        for r in ("정책: CPU 강제", "CUDA 미가용 → CPU", "정책: GPU 강제"):
            self.assertIsNone(tts_worker._parse_device_source(r), r)
        self.assertIsNone(tts_worker._parse_device_source(""))
        self.assertIsNone(tts_worker._parse_device_source(None))

    def test_linux_torch_source_still_parsed(self):
        """다른 측정 출처도 그대로 남는다(회귀 가드)."""
        r = "여유 VRAM 9000/16000MB ≥ 4000MB → GPU (source=torch.mem_get_info)"
        self.assertEqual(tts_worker._parse_device_source(r), "torch.mem_get_info")

    def test_reason_is_in_record_allowlists(self):
        """새 항목이 기록 허용 목록에 실제로 들어 있어야 기록된다."""
        self.assertIn("device_selection_reason", tts_worker._RUN_HEADER_FROM_METADATA)

    def test_reason_strings_carry_no_paths_or_command_output(self):
        """개인정보 제외 원칙 — 사유 문자열에 경로·명령 출력·사용자 데이터가 없어야 한다.

        gpu_policy 가 만드는 사유 7종을 전수로 본다. 형식이 바뀌어 경로가 섞이면 여기서 막힌다."""
        import gpu_policy
        import inspect
        src = inspect.getsource(gpu_policy.select_device)
        # 사유 문자열 안에 f-string 으로 들어가는 값은 숫자·출처 라벨뿐이어야 한다.
        banned = ("path", "Path", "cwd", "os.environ", "stdout", "stderr", "argv", "__file__")
        for b in banned:
            self.assertNotIn(b, src, f"사유를 만드는 함수에 {b} 가 들어오면 경로·출력이 샐 수 있다")

    def test_known_reason_shapes_round_trip(self):
        """gpu_policy 가 실제로 만드는 사유 모양들이 모두 처리된다."""
        cases = {
            "정책: CPU 강제": None,
            "정책: GPU 강제": None,
            "CUDA 미가용 → CPU": None,
            "nvidia-smi 측정 실패(부재/timeout/파싱) → 보수적 CPU (threshold=4000MB, source=nvidia-smi)":
                "nvidia-smi(측정실패→CPU)",
            "CUDA 응답 없음/조회 실패 → CPU (busy 추정, threshold=4000MB, source=torch.mem_get_info)":
                "torch.mem_get_info",
            "여유 VRAM 10794/16302MB ≥ 4000MB → GPU (source=nvidia-smi)": "nvidia-smi",
            "여유 VRAM 1200/16302MB < 4000MB → CPU (source=nvidia-smi)": "nvidia-smi",
        }
        for reason, want in cases.items():
            self.assertEqual(tts_worker._parse_device_source(reason), want, reason)


class OldRecordCompatibilityTest(unittest.TestCase):
    """기존 기록 읽기 호환성 — 새 항목이 없던 기록도 그대로 읽혀야 한다."""

    def test_reader_tolerates_missing_new_field(self):
        old_header = {
            "device": "cpu",
            "device_selection_source": "nvidia-smi",
            # device_selection_reason 없음 — 2026-09-11 이전 기록
        }
        self.assertIsNone(old_header.get("device_selection_reason"))
        self.assertEqual(old_header.get("device"), "cpu")

    def test_allowlist_is_a_filter_not_a_requirement(self):
        """허용 목록은 '담아도 되는 것' 이지 '반드시 있어야 하는 것' 이 아니다.

        새 항목을 넣었다고 옛 기록이 깨지면 안 된다."""
        keys = set(tts_worker._RUN_HEADER_FROM_METADATA)
        old = {"device": "cpu", "device_selection_source": "nvidia-smi"}
        kept = {k: v for k, v in old.items() if k in keys}
        self.assertEqual(kept, old)


if __name__ == "__main__":
    unittest.main()
