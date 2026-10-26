"""참조 재사용·반복 준비 검사. 합성 모델·GPU·사용자 파일 없이 실행한다."""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _test_temp
import tempfile
import types
import unittest
import weakref
from pathlib import Path
from unittest.mock import patch
import qwen_bridge as qb
import qwen_voice_server as server
from qwen_reference_cache import reference_digest


class Model:
    def __init__(self):
        self.calls = []

    def create_voice_clone_prompt(self, **kw):
        self.calls.append(kw)
        return dict(kw)


class Reuse(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "참조.wav"
        self.path.write_bytes(b"AAAA")
        self.models = server.Models()
        self.model = Model()

    def prompt(self, text="첫 전사", model_dir="B"):
        return self.models.prompt(self.model, model_dir, {"ref": str(self.path), "text": text})

    def test_fixed_prompt_reuses_only_matching_content_and_transcript(self):
        first = self.prompt()
        self.assertIs(self.prompt(), first)
        self.assertEqual(len(self.model.calls), 1)
        self.assertNotEqual(self.prompt("고친 전사"), first)
        self.assertEqual(len(self.model.calls), 2)

    def test_same_timestamp_and_size_do_not_hide_replaced_audio(self):
        self.prompt()
        stamp = self.path.stat()
        self.path.write_bytes(b"BBBB")
        os.utime(self.path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.prompt()
        self.assertEqual(len(self.model.calls), 2)

    def test_duplicate_file_reuses_but_other_model_does_not(self):
        first = self.prompt()
        second_path = self.path.with_name("다른 경로.wav")
        second_path.write_bytes(self.path.read_bytes())
        self.assertIs(self.models.prompt(self.model, "B", {"ref": str(second_path), "text": "첫 전사"}), first)
        self.prompt(model_dir="C")
        self.assertEqual(len(self.model.calls), 2)

    def test_fixed_prompt_lru_limit(self):
        first = self.prompt("0")
        for i in range(1, server.REF_PROMPT_MAX):
            self.prompt(str(i))
        self.assertIs(self.prompt("0"), first)
        self.prompt("new")
        self.assertEqual(len(self.models.prompts), server.REF_PROMPT_MAX)
        count = len(self.model.calls)
        self.prompt("1")
        self.assertEqual(len(self.model.calls), count + 1)

    def test_failed_preparation_is_not_cached(self):
        with patch.object(self.model, "create_voice_clone_prompt", side_effect=RuntimeError("실패")):
            with self.assertRaises(RuntimeError):
                self.prompt()
        self.assertFalse(self.models.prompts)
        self.prompt()
        self.assertEqual(len(self.model.calls), 1)

    def test_reference_replaced_during_preparation_is_not_cached(self):
        def changed(**kw):
            self.path.write_bytes(b"BBBB")
            return kw
        with patch.object(self.model, "create_voice_clone_prompt", side_effect=changed):
            with self.assertRaisesRegex(RuntimeError, "변경"):
                self.prompt()
        self.assertFalse(self.models.prompts)

    def test_bridge_reference_replaced_during_preparation_is_not_cached(self):
        def changed(**kw):
            self.path.write_bytes(b"BBBB")
            return kw
        self.model.create_voice_clone_prompt = changed
        server._ref_prompt_cache(self.models, self.model, "B")
        with self.assertRaisesRegex(RuntimeError, "변경"):
            self.model.create_voice_clone_prompt(ref_audio=str(self.path), ref_text="전사")
        self.assertFalse(self.models.ref_prompts)

    def test_deleted_reference_is_not_served_from_cache(self):
        self.prompt()
        self.path.unlink()
        with self.assertRaises(OSError):
            self.prompt()

    def test_unknown_vendor_option_bypasses_reference_cache(self):
        server._ref_prompt_cache(self.models, self.model, "B")
        for _ in range(2):
            self.model.create_voice_clone_prompt(ref_audio=str(self.path), future_option=True)
        self.assertEqual(len(self.model.calls), 2)
        self.assertFalse(self.models.ref_prompts)

    def test_known_vendor_parameters_still_reuse(self):
        server._ref_prompt_cache(self.models, self.model, "B")
        for _ in range(3):
            self.model.create_voice_clone_prompt(ref_audio=str(self.path), ref_text="말", x_vector_only_mode=False)
        self.assertEqual(len(self.model.calls), 1)
        self.assertEqual((self.models.ref_made, self.models.ref_hits), (1, 2))

    def test_file_changed_during_hash_is_rejected(self):
        real_stat = os.stat
        def changed(path):
            st = real_stat(path)
            return types.SimpleNamespace(st_dev=st.st_dev, st_ino=st.st_ino, st_size=st.st_size + 1,
                                         st_mtime_ns=st.st_mtime_ns, st_ctime_ns=st.st_ctime_ns)
        with patch("qwen_reference_cache.os.stat", side_effect=changed):
            with self.assertRaisesRegex(RuntimeError, "변경"):
                reference_digest(self.path)

    def test_hash_reads_are_bounded(self):
        import builtins
        original = builtins.open
        sizes = []
        class Reader:
            def __enter__(reader):
                reader.stream = original(self.path, "rb")
                return reader
            def __exit__(reader, *args):
                reader.stream.close()
            def fileno(reader):
                return reader.stream.fileno()
            def read(reader, n=-1):
                sizes.append(n)
                return reader.stream.read(n)
        self.path.write_bytes(b"x" * (1024 * 1024))
        with patch("builtins.open", return_value=Reader()):
            reference_digest(self.path)
        self.assertTrue(sizes)
        self.assertTrue(all(0 < n <= 256 * 1024 for n in sizes))

    def test_model_eviction_drops_prompts_and_model_before_loading(self):
        gone = Model()
        gone.cycle = gone  # 실제 벤더의 bound-method 래퍼처럼 순환 참조가 있어도 해제
        ref = weakref.ref(gone)
        self.models.loaded["GONE"] = gone
        self.models.prompts[("GONE", "sha", "text")] = "prompt"
        self.models.ref_prompts[("GONE", "sha")] = "prompt"
        del gone
        def load(_):
            self.assertIsNone(ref())
            return Model()
        fake_torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        with patch.object(server, "MAX_MODELS", 1), patch.dict(sys.modules, {
            "torch": fake_torch, "qwen_custom_voice": types.SimpleNamespace(load=load)}):
            self.models.get("NEW")
        self.assertFalse(self.models.prompts)
        self.assertFalse(self.models.ref_prompts)


class Frames(unittest.TestCase):
    def setUp(self):
        qb._REF_FRAMES_CACHE.clear()
        self.addCleanup(qb._REF_FRAMES_CACHE.clear)

    def test_repeated_measurement_is_once_per_model_and_reference(self):
        first, second = object(), object()
        with patch.object(qb, "REF_FRAMES_MEASURER", side_effect=[40, 70, 90]) as measure:
            for _ in range(4):
                self.assertEqual(qb._measure_ref_code_frames(first, {"ref_audio": "A"}), 40)
            self.assertEqual(qb._measure_ref_code_frames(second, {"ref_audio": "A"}), 70)
            self.assertEqual(qb._measure_ref_code_frames(first, {"ref_audio": "B"}), 90)
            self.assertEqual(measure.call_count, 3)

    def test_codec_encoding_is_reused_by_budget_and_crop_measurement(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "검사.wav")
            sf.write(path, np.zeros(100, dtype="float32"), 24000)
            from unittest.mock import Mock
            encode = Mock(return_value=types.SimpleNamespace(audio_codes=[np.zeros((15, 2))]))
            model = types.SimpleNamespace(model=types.SimpleNamespace(speech_tokenizer=types.SimpleNamespace(encode=encode)))
            seg = {"ref_audio": path}
            with patch.object(qb, "REF_FRAMES_MEASURER", None):
                self.assertEqual(qb._measure_ref_code_frames(model, seg), 15)
                self.assertEqual(qb._ref_code_frames(model, seg), 15)
                self.assertEqual(qb._ref_code_frames(model, seg), 15)
            self.assertEqual(encode.call_count, 1)

    def test_failed_frame_measurement_is_not_cached(self):
        model = object()
        with patch.object(qb, "REF_FRAMES_MEASURER", side_effect=[None, 40]) as measure:
            self.assertIsNone(qb._measure_ref_code_frames(model, {"ref_audio": "A"}))
            self.assertEqual(qb._measure_ref_code_frames(model, {"ref_audio": "A"}), 40)
            self.assertEqual(measure.call_count, 2)

    def test_next_job_clears_previous_frame_measurements_even_when_rejected(self):
        qb._REF_FRAMES_CACHE[(1, "A")] = 999
        with patch.object(qb, "emit"):
            self.assertEqual(qb.run_loaded(object(), {"segments": []}), 1)
        self.assertFalse(qb._REF_FRAMES_CACHE)


if __name__ == "__main__":
    unittest.main()
