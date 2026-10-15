"""모델 생성 없이 합성 신호로 서로 다른 멜 설정의 캐시 격리를 확인한다."""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import sys
import unittest
from pathlib import Path
import torch
sys.path.insert(0,str(Path(__file__).parent/'song_vc'))
from modules import audio

class MelCacheTest(unittest.TestCase):
    def setUp(self):
        audio.mel_basis.clear();audio.hann_window.clear()
        t=torch.arange(8192)/22050
        self.wave=(.2*torch.sin(2*torch.pi*440*t)+.1*torch.sin(2*torch.pi*2300*t))[None,:]
        self.base=dict(n_fft=1024,num_mels=80,sampling_rate=22050,hop_size=256,
                       win_size=1024,fmin=0,fmax=None,center=False)

    def tearDown(self):
        audio.mel_basis.clear();audio.hann_window.clear()

    def check_alternate(self,changes):
        first=audio.mel_spectrogram(self.wave,**self.base)
        other={**self.base,**changes}
        shared=audio.mel_spectrogram(self.wave,**other)
        self.assertTrue(torch.equal(first,audio.mel_spectrogram(self.wave,**self.base)))
        audio.mel_basis.clear();audio.hann_window.clear()
        isolated=audio.mel_spectrogram(self.wave,**other)
        self.assertTrue(torch.equal(shared,isolated))

    def test_mel_count_is_not_shared(self):self.check_alternate({'num_mels':64})
    def test_fft_geometry_is_not_shared(self):self.check_alternate({'n_fft':2048,'win_size':2048})
    def test_lower_band_is_not_shared(self):self.check_alternate({'fmin':120})
    def test_window_size_is_not_shared(self):self.check_alternate({'win_size':768})
    def test_repeated_settings_reuse_filter(self):
        audio.mel_spectrogram(self.wave,**self.base)
        basis=next(iter(audio.mel_basis.values()));window=next(iter(audio.hann_window.values()))
        audio.mel_spectrogram(self.wave,**self.base)
        self.assertIs(basis,next(iter(audio.mel_basis.values())))
        self.assertIs(window,next(iter(audio.hann_window.values())))

if __name__=='__main__':unittest.main()
