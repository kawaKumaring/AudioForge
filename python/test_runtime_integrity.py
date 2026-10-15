"""실제 설정을 열지 않고 합성 런타임 설정의 손상·저장 실패를 확인한다."""
import os,sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import _test_temp
import tempfile,json,unittest
from unittest.mock import patch
import app_runtime as rt

class RuntimeIntegrity(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="audioforge_runtime_integrity_")
        self.env=patch.dict(os.environ,{"AUDIOFORGE_RUNTIME_ROOT":self.temp.name})
        self.env.start()
    def tearDown(self):
        self.env.stop();self.temp.cleanup()
    def test_invalid_json_shapes_are_unreadable(self):
        for data in ([],None,3,{"components":[]},{"schema":True},{"schema":999}):
            with self.subTest(data=data):
                with open(rt.config_path(),"w",encoding="utf8") as f:json.dump(data,f)
                self.assertTrue(rt.load_config().get("_unreadable"))
    def test_corrupt_original_cannot_be_silently_replaced(self):
        with open(rt.config_path(),"w",encoding="utf8") as f:f.write("{손상")
        with self.assertRaises(ValueError):rt.save_config({"schema":1,"components":{}})
        with open(rt.config_path(),encoding="utf8") as f:self.assertEqual(f.read(),"{손상")
    def test_invalid_new_config_does_not_replace_good_one(self):
        rt.save_config({"schema":1,"components":{"voice":{"path":"synthetic"}}})
        with self.assertRaises(ValueError):rt.save_config({"schema":1,"components":[]})
        self.assertIn("voice",rt.load_config()["components"])
    def test_replace_failure_keeps_original_and_no_temp(self):
        original={"schema":1,"components":{"voice":{"path":"synthetic"}}}
        rt.save_config(original)
        with patch("app_runtime.os.replace",side_effect=OSError("쓰기 거절")):
            with self.assertRaises(OSError):rt.save_config({"schema":1,"components":{}})
        self.assertEqual(rt.load_config(),original)
        self.assertEqual(os.listdir(self.temp.name),["runtime.json"])

if __name__=="__main__":unittest.main()
