# -*- coding: utf-8 -*-
"""song_vc(흡수본) ↔ 원본 seed-vc 수치 대조 — CPU·fp32 전용, 음원 파일을 쓰지 않는다.

쓰는 법(앱 저장소 뿌리에서):
  1) 새 코드:  <gptsovits_venv_app python> python/song_vc/test_parity.py --impl new
  2) 원본:     <seed-vc .venv python>      python/song_vc/test_parity.py --impl old
  3) 비교:     아무 파이썬(numpy)        python/song_vc/test_parity.py --compare

입력은 스크립트 안에서 만든 합성 파형(사인+잡음, 고정 시드)과 고정 난수 텐서뿐이다.
결과는 TEST_ROOT/기록/song_vc_parity/ 에 단계별 npz·json 으로 남는다.
원본 쪽은 resources/seed-vc 의 modules 와 체크포인트를 **읽기만** 한다.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(PY_DIR)
sys.path.insert(0, PY_DIR)
from _test_root import test_dir  # noqa: E402

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['CUDA_VISIBLE_DEVICES'] = ''  # ★GPU 를 쓰지 않는다.

import numpy as np  # noqa: E402

OUT = test_dir('records', 'song_vc_parity')
STAGES = ['whisper', 'campplus', 'rmvpe', 'length_regulator', 'dit_step', 'cfm_2step', 'bigvgan']


def master_root():
    # externals 는 본체로의 정션이다 — 실제 경로를 따라가 본체 저장소를 찾는다.
    return os.path.dirname(os.path.realpath(os.path.join(ROOT, 'externals')))


def synth_inputs():
    """합성 입력(고정 시드). 2초 16kHz 파형 = 220Hz 사인 + 약한 잡음."""
    rs = np.random.RandomState(1234)
    t = np.arange(32000) / 16000.0
    wave16 = (0.3 * np.sin(2 * np.pi * 220.0 * t) + 0.01 * rs.randn(32000)).astype(np.float32)
    T = 60
    return {
        'wave16': wave16,
        'S': rs.randn(1, 101, 768).astype(np.float32),           # 내용 특징 자리
        'f0': (200.0 + 50.0 * rs.rand(1, 101)).astype(np.float32),  # 음높이 자리(유성)
        'x': rs.randn(1, 128, T).astype(np.float32),
        'prompt_x': rs.randn(1, 128, T).astype(np.float32),
        'mu': rs.randn(1, T, 768).astype(np.float32),
        'style': rs.randn(1, 192).astype(np.float32),
        't': np.array([0.3], dtype=np.float32),
        'mel_voc': (rs.randn(1, 128, 40) * 0.5 - 5.0).astype(np.float32),
        'prompt_len': np.array(20),
    }


def state_check(model, sd):
    msd = model.state_dict()
    missing = sorted(set(msd) - set(sd))
    unexpected = sorted(set(sd) - set(msd))
    shape_bad = sorted(k for k in set(msd) & set(sd) if tuple(msd[k].shape) != tuple(sd[k].shape))
    return {'model_keys': len(msd), 'file_keys': len(sd), 'missing': len(missing),
            'unexpected': len(unexpected), 'shape_mismatch': len(shape_bad),
            'examples': (missing + unexpected + shape_bad)[:5]}


def run(impl):
    import torch
    torch.set_grad_enabled(False)
    torch.manual_seed(0)
    dev = torch.device('cpu')
    inp = synth_inputs()
    keys = {}

    if impl == 'new':
        sys.path.insert(0, HERE)
        import convert as C
        p = C.model_paths(None)
        model, config = C.load_dit(p['dit'], p['config'], dev)
        dit_sd = torch.load(p['dit'], map_location='cpu', weights_only=True)['net']
        rm = C.load_rmvpe(p['rmvpe'], dev)
        cp = C.load_campplus(p['campplus'], dev)
        # bigvgan 키 대조는 weight_norm 을 벗기기 전 모델로 한다.
        from modules.bigvgan import bigvgan as BG
        raw_bg = BG.BigVGAN(BG.load_hparams_from_json(os.path.join(p['bigvgan'], 'config.json')))
        keys['bigvgan'] = state_check(raw_bg, torch.load(os.path.join(p['bigvgan'], 'bigvgan_generator.pt'),
                                                         map_location='cpu', weights_only=True)['generator'])
        del raw_bg
        bg = C.load_bigvgan(p['bigvgan'], dev)
        wm, semantic_fn = C.load_whisper(p['whisper'], dev, torch.float32)
        from transformers import WhisperModel
        _, info = WhisperModel.from_pretrained(p['whisper'], local_files_only=True, output_loading_info=True)
        keys['whisper'] = {k: len(v) for k, v in info.items()}
        # CAMPPlus.load_state_dict 는 옛 이름(xvector.stats/dense)을 고쳐 읽는다 — 같은 규칙으로 대조한다.
        csd = {(k.replace('xvector.stats', 'stats', 1) if k.startswith('xvector.stats') else
                k.replace('xvector.dense', 'dense', 1) if k.startswith('xvector.dense') else k): v
               for k, v in torch.load(p['campplus'], map_location='cpu', weights_only=True).items()}
        keys['campplus'] = state_check(cp, csd)
        keys['rmvpe'] = state_check(rm.model, torch.load(p['rmvpe'], map_location='cpu', weights_only=True))
        for k in model:
            # load_checkpoint 와 같이 DDP 접두어(module.)를 떼고 대조한다.
            sd = {(n[len('module.'):] if n.startswith('module.') else n): v for n, v in dit_sd[k].items()}
            keys['dit.' + k] = state_check(model[k], sd)
    else:
        mroot = master_root()
        sv = os.path.join(mroot, 'resources', 'seed-vc')
        ck = os.path.join(sv, 'checkpoints')
        sys.path.insert(0, sv)
        import glob
        import yaml
        from modules.commons import recursive_munch, build_model, load_checkpoint
        g = lambda pat: glob.glob(os.path.join(ck, pat))[0]
        dit_path = g('models--Plachta--Seed-VC/snapshots/*/DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth')
        cfg_path = g('models--Plachta--Seed-VC/snapshots/*/config_dit_mel_seed_uvit_whisper_base_f0_44k.yml')
        config = yaml.safe_load(open(cfg_path, 'r'))
        mp = recursive_munch(config['model_params'])
        mp.dit_type = 'DiT'
        model = build_model(mp, stage='DiT')
        model, _, _, _ = load_checkpoint(model, None, dit_path, load_only_params=True, ignore_modules=[],
                                         is_distributed=False)
        for k in model:
            model[k].eval().to(dev)
        model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=8192)
        raw = torch.load(dit_path, map_location='cpu')['net']
        for k in model:  # 원본도 같은 방식으로 키를 센다(건너뛴 키가 원본과 같은지 보려고).
            sd = {(n[len('module.'):] if n.startswith('module.') else n): v for n, v in raw[k].items()}
            keys['dit.' + k] = state_check(model[k], sd)
        from modules.rmvpe import RMVPE
        rm = RMVPE(g('models--lj1995--VoiceConversionWebUI/snapshots/*/rmvpe.pt'), is_half=False, device=dev)
        from modules.campplus.DTDNN import CAMPPlus
        cp = CAMPPlus(feat_dim=80, embedding_size=192)
        cp.load_state_dict(torch.load(g('models--funasr--campplus/snapshots/*/campplus_cn_common.bin'), map_location='cpu'))
        cp.eval()
        from modules.bigvgan import bigvgan
        bg = bigvgan.BigVGAN.from_pretrained(g('hf_cache/models--nvidia--bigvgan_v2_44khz_128band_512x/snapshots/*'),
                                             use_cuda_kernel=False)
        bg.remove_weight_norm()
        bg = bg.eval()
        from transformers import AutoFeatureExtractor, WhisperModel
        wdir = g('hf_cache/models--openai--whisper-small/snapshots/*')
        wm = WhisperModel.from_pretrained(wdir, torch_dtype=torch.float32)
        del wm.decoder
        fe = AutoFeatureExtractor.from_pretrained(wdir)

        def semantic_fn(waves_16k):  # inference.py 와 같은 본문
            ori_inputs = fe([waves_16k.squeeze(0).cpu().numpy()], return_tensors="pt", return_attention_mask=True)
            f = wm._mask_input_features(ori_inputs.input_features, attention_mask=ori_inputs.attention_mask)
            o = wm.encoder(f.to(wm.encoder.dtype), head_mask=None, output_attentions=False,
                           output_hidden_states=False, return_dict=True)
            return o.last_hidden_state.to(torch.float32)[:, :waves_16k.size(-1) // 320 + 1]

    import torchaudio
    T = lambda a: torch.from_numpy(np.asarray(a))
    w16 = T(inp['wave16'])[None]
    res = {}
    res['whisper'] = semantic_fn(w16).numpy()
    feat2 = torchaudio.compliance.kaldi.fbank(w16, num_mel_bins=80, dither=0, sample_frequency=16000)
    feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
    res['campplus'] = cp(feat2.unsqueeze(0)).numpy()
    res['rmvpe'] = np.asarray(rm.infer_from_audio(w16[0], thred=0.03), dtype=np.float32)
    cond = model.length_regulator(T(inp['S']), ylens=torch.LongTensor([120]), n_quantizers=3, f0=T(inp['f0']))[0]
    res['length_regulator'] = cond.numpy()
    est = model.cfm.estimator
    x_lens = torch.LongTensor([inp['x'].shape[-1]])
    res['dit_step'] = est(T(inp['x']), T(inp['prompt_x']), x_lens, T(inp['t']), T(inp['style']), T(inp['mu'])).numpy()
    torch.manual_seed(42)
    pl = int(inp['prompt_len'])
    res['cfm_2step'] = model.cfm.inference(T(inp['mu']), x_lens, T(inp['prompt_x'])[..., :pl], T(inp['style']), None, 2,
                                           inference_cfg_rate=0.7).numpy()
    res['bigvgan'] = bg(T(inp['mel_voc'])).numpy()

    np.savez(os.path.join(OUT, '%s.npz' % impl), **res)
    meta = {'impl': impl, 'torch': torch.__version__, 'torchaudio': torchaudio.__version__,
            'shapes': {k: list(v.shape) for k, v in res.items()}, 'keys': keys}
    import transformers
    meta['transformers'] = transformers.__version__
    json.dump(meta, open(os.path.join(OUT, '%s.json' % impl), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=1))


def compare():
    a = np.load(os.path.join(OUT, 'old.npz'))
    b = np.load(os.path.join(OUT, 'new.npz'))
    rep = {}
    for k in STAGES:
        x, y = a[k], b[k]
        if x.shape != y.shape:
            rep[k] = {'shape_old': list(x.shape), 'shape_new': list(y.shape)}
            continue
        d = np.abs(x.astype(np.float64) - y.astype(np.float64))
        rep[k] = {'shape': list(x.shape), 'max_abs_diff': float(d.max()), 'ref_max_abs': float(np.abs(x).max())}
    json.dump(rep, open(os.path.join(OUT, 'compare.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    for k, v in rep.items():
        print(k, v)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--impl', choices=['old', 'new'])
    ap.add_argument('--compare', action='store_true')
    a = ap.parse_args()
    compare() if a.compare else run(a.impl)
