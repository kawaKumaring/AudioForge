import copy
import json
import unittest
from pathlib import Path
import yaml
import speech_vc
import torch
from modules.bigvgan.bigvgan import BigVGAN

class SpeechContract(unittest.TestCase):
    def setUp(self):
        self.config=yaml.safe_load(Path(speech_vc.model_paths()['config']).read_text(encoding='utf-8'))
    def test_speech_config(self):
        speech_vc.validate_config(self.config)
    def test_reject_song_geometry(self):
        for field,value in [('sr',44100),('hop_length',512),('n_mels',128)]:
            with self.subTest(field=field):
                c=copy.deepcopy(self.config)
                if field=='sr':c['preprocess_params'][field]=value
                else:c['preprocess_params']['spect_params'][field]=value
                with self.assertRaises(ValueError):speech_vc.validate_config(c)
    def test_reject_pitch_condition(self):
        c=copy.deepcopy(self.config);c['model_params']['DiT']['f0_condition']=True
        with self.assertRaises(ValueError):speech_vc.validate_config(c)
    def test_reject_wrong_vocoder(self):
        c=copy.deepcopy(self.config);c['model_params']['vocoder']['name']='nvidia/bigvgan_v2_44khz_128band_512x'
        with self.assertRaises(ValueError):speech_vc.validate_config(c)
    def test_defaults(self):
        a=speech_vc.build_parser().parse_args(['--source','source.wav','--target','ref.wav'])
        self.assertFalse(a.f0_condition);self.assertFalse(a.auto_f0_adjust);self.assertEqual(a.semi_tone_shift,0)
        self.assertFalse(a.diagnostics_controls)
    def test_vocoder_geometry_matches(self):
        c=json.loads((Path(speech_vc.model_paths()['bigvgan'])/'config.json').read_text(encoding='utf-8'))
        speech_vc.validate_vocoder_config(self.config,c)
        for field in ('n_fft','num_mels','hop_size','win_size','sampling_rate','fmin','fmax'):
            with self.subTest(field=field):
                bad=copy.deepcopy(c);bad[field]=123
                with self.assertRaises(ValueError):speech_vc.validate_vocoder_config(self.config,bad)
    def test_controls_require_record_before_gpu_or_model(self):
        a=speech_vc.build_parser().parse_args(['--source','missing.wav','--target','missing.wav','--diagnostics-controls'])
        with self.assertRaisesRegex(ValueError,'기록 폴더'):speech_vc.main(a)
    def test_reject_pitch_before_model_load(self):
        a=speech_vc.build_parser().parse_args(['--source','missing.wav','--target','missing.wav','--f0-condition','True'])
        with self.assertRaises(ValueError):speech_vc.main(a)
    def test_separate_weights_and_shared_encoders(self):
        p=speech_vc.model_paths()
        self.assertIn('speech_vc_models',p['dit']);self.assertIn('song_vc_models',p['whisper'])
        self.assertNotIn('rmvpe',p)

    def test_default_vocoder_clips_and_probe_preserves_peaks(self):
        # 마지막 단계만 실제 forward로 확인: 학습 모델이나 GPU는 불필요.
        m=BigVGAN.__new__(BigVGAN);torch.nn.Module.__init__(m)
        m.conv_pre=torch.nn.Identity();m.num_upsamples=0
        m.activation_post=torch.nn.Identity();m.conv_post=torch.nn.Identity()
        m.use_tanh_at_final=False
        x=torch.tensor([[[-1.2,-0.4,0.4,1.3]]])
        self.assertTrue(torch.equal(m(x),x.clamp(-1,1)))
        self.assertTrue(torch.equal(m(x,clip_output=False),x))
        self.assertTrue(torch.equal(m(x),x.clamp(-1,1)))

    def test_tanh_model_is_unchanged_by_probe_flag(self):
        m=BigVGAN.__new__(BigVGAN);torch.nn.Module.__init__(m)
        m.conv_pre=torch.nn.Identity();m.num_upsamples=0
        m.activation_post=torch.nn.Identity();m.conv_post=torch.nn.Identity()
        m.use_tanh_at_final=True
        x=torch.tensor([[[-1.2,1.3]]])
        self.assertTrue(torch.equal(m(x),torch.tanh(x)))
        self.assertTrue(torch.equal(m(x,clip_output=False),torch.tanh(x)))

if __name__=='__main__':unittest.main()
