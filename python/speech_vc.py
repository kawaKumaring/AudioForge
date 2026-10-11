"""Seed-VC V1 말하기 경로 흡수. GPL-3.0. 출처: speech-vc-absorption-2026-10-12.md.
기존 song_vc 부품 재사용; 노래 경로 변경 없음. 실행 중 다운로드 없음.
"""
import os, sys, argparse, json
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'song_vc'))
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
import numpy as np
import torch
import time
import yaml
from song_vc.convert import pick_device, load_bigvgan, load_campplus, mel_args, crossfade
ROOT = HERE.parent
DIT_FILE = 'DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth'
CONFIG_FILE = 'config_dit_mel_seed_uvit_whisper_small_wavenet.yml'

def model_paths(models_dir=None):
    d = Path(models_dir) if models_dir else ROOT / 'externals/speech_vc_models'
    shared = ROOT / 'externals/song_vc_models'
    return {'dit': str(d/'dit'/DIT_FILE), 'config': str(d/'dit'/CONFIG_FILE),
            'bigvgan': str(d/'bigvgan_v2_22khz_80band_256x'),
            'whisper': str(shared/'whisper-small'), 'campplus': str(shared/'campplus_cn_common.bin')}

def validate_config(config):
    m=config['model_params']; p=config['preprocess_params']
    if p['sr'] != 22050 or p['spect_params']['hop_length'] != 256 or p['spect_params']['n_mels'] != 80:
        raise ValueError('말하기 모델의 22.05kHz/80멜 설정이 아닙니다')
    if m['length_regulator']['f0_condition'] or m['DiT']['f0_condition'] or m['DiT']['final_layer_type'] != 'wavenet':
        raise ValueError('말하기용 무음높이 조건 모델이 아닙니다')
    if m['vocoder']['name'] != 'nvidia/bigvgan_v2_22khz_80band_256x':
        raise ValueError('말하기용 음성 복원 모델이 아닙니다')

def validate_vocoder_config(config, vocoder_config):
    """모델 이름만 같아도 실제 분석·복원 설정이 다르면 시작하지 않는다."""
    expected = mel_args(config)
    for field in ('sampling_rate', 'n_fft', 'num_mels', 'hop_size', 'win_size', 'fmin', 'fmax'):
        if vocoder_config.get(field) != expected[field]:
            raise ValueError('변환·음성 복원 설정이 다릅니다: ' + field)

def load_models(paths, device):
    from modules.commons import recursive_munch, build_model
    from modules.audio import mel_spectrogram
    from transformers import AutoFeatureExtractor, WhisperModel
    config=yaml.safe_load(Path(paths['config']).read_text(encoding='utf-8'))
    validate_config(config)
    validate_vocoder_config(config,json.loads((Path(paths['bigvgan'])/'config.json').read_text(encoding='utf-8')))
    params=recursive_munch(config['model_params']); params.dit_type='DiT'
    model=build_model(params, stage='DiT')
    state=torch.load(paths['dit'],map_location='cpu',weights_only=True)['net']
    for key in model:
        weights={k.removeprefix('module.'):v for k,v in state[key].items()}
        # 위치표는 학습 가중치가 아니라 현재 추론 길이로 만드는 고정 버퍼다.
        weights.pop('estimator.input_pos',None)
        # 공식 말하기 가중치의 F0 부품은 이 설정에서 사용하지 않는다.
        weights.pop('estimator.f0_embedder.weight',None)
        missing,unexpected=model[key].load_state_dict(weights,strict=False)
        allowed_buffers={'estimator.input_pos','estimator.t_embedder.freqs','estimator.t_embedder2.freqs'}
        if set(missing)-allowed_buffers or unexpected:
            raise RuntimeError('변환 모델의 가중치와 구조가 맞지 않습니다: '+str((missing,unexpected)))
        model[key].eval().to(device)
    model.cfm.estimator.setup_caches(max_batch_size=1,max_seq_length=8192)
    vocoder=load_bigvgan(paths['bigvgan'],device)
    campplus=load_campplus(paths['campplus'],device)
    wm=WhisperModel.from_pretrained(paths['whisper'],torch_dtype=torch.float16,local_files_only=True).to(device)
    del wm.decoder
    fe=AutoFeatureExtractor.from_pretrained(paths['whisper'],local_files_only=True)
    def semantic(waves):
        inputs=fe([waves.squeeze(0).cpu().numpy()],return_tensors='pt',return_attention_mask=True,sampling_rate=16000)
        features=wm._mask_input_features(inputs.input_features,attention_mask=inputs.attention_mask).to(device)
        encoded=wm.encoder(features.to(wm.encoder.dtype),head_mask=None,output_attentions=False,output_hidden_states=False,return_dict=True)
        return encoded.last_hidden_state.float()[:,:waves.size(-1)//320+1]
    margs=mel_args(config)
    return model,semantic,None,vocoder,campplus,lambda x:mel_spectrogram(x,**margs),margs

@torch.no_grad()
def main(args):
    import librosa
    import soundfile as sf
    import torchaudio

    if getattr(args,'diagnostics_controls',False) and not getattr(args,'diagnostics_dir',None):
        raise ValueError('원음 복원 대조에는 단계별 기록 폴더가 필요합니다')
    if args.f0_condition or args.auto_f0_adjust or args.semi_tone_shift:
        raise ValueError('말하기 모델에는 음높이 조건이나 조옮김을 적용하지 않습니다')
    device = pick_device()
    if device.type != 'cuda':
        raise RuntimeError('이 비교 경로는 GPU가 필요합니다. CPU로 자동 전환하지 않습니다')
    import random
    random.seed(args.seed); np.random.seed(args.seed)
    torch.manual_seed(args.seed); torch.cuda.manual_seed_all(args.seed)
    fp16 = args.fp16
    paths = model_paths(args.models_dir)
    diagnostic=None
    if getattr(args,'diagnostics_dir',None):
        from vc_diagnostics import Recorder, file_fingerprint
        files=[paths['dit'],paths['config'],paths['campplus'],
               str(Path(paths['bigvgan'])/'config.json'),str(Path(paths['bigvgan'])/'bigvgan_generator.pt')]
        files.extend(str(p) for p in sorted(Path(paths['whisper']).glob('*')) if p.is_file())
        diagnostic=Recorder(args.diagnostics_dir,{'seed':args.seed,'fp16':args.fp16,
            'steps':args.diffusion_steps,'cfg':args.inference_cfg_rate,'f0_condition':False,
            'sampling_rate':22050,'hop_length':256,
            'reconstruction_controls':getattr(args,'diagnostics_controls',False),
            'source':file_fingerprint(args.source),'reference':file_fingerprint(args.target),
            'models':[file_fingerprint(p) for p in files],
            'privacy':'음향 중간 자료는 사용자 음성 정보입니다. 로컬 보관 전용.'})
    model, semantic_fn, f0_fn, vocoder_fn, campplus_model, mel_fn, mel_fn_args = load_models(paths, device)
    raw_vocoder=vocoder_fn
    if diagnostic:
        from vc_diagnostics import traced_vocoder
        vocoder_fn=traced_vocoder(vocoder_fn,diagnostic)

    sr = mel_fn_args['sampling_rate']
    auto_f0_adjust = args.auto_f0_adjust
    pitch_shift = args.semi_tone_shift
    source = args.source
    target_name = args.target
    diffusion_steps = args.diffusion_steps
    length_adjust = args.length_adjust
    inference_cfg_rate = args.inference_cfg_rate
    source_audio = librosa.load(source, sr=sr)[0]
    ref_audio = librosa.load(target_name, sr=sr)[0]

    sr = 22050
    hop_length = 256
    max_context_window = sr // hop_length * 30
    overlap_frame_len = 16
    overlap_wave_len = overlap_frame_len * hop_length

    source_audio = torch.tensor(source_audio).unsqueeze(0).float().to(device)
    ref_audio = torch.tensor(ref_audio[:sr * 25]).unsqueeze(0).float().to(device)

    time_vc_start = time.time()
    converted_waves_16k = torchaudio.functional.resample(source_audio, sr, 16000)
    if converted_waves_16k.size(-1) <= 16000 * 30:
        S_alt = semantic_fn(converted_waves_16k)
    else:
        overlapping_time = 5
        S_alt_list = []
        buffer = None
        traversed_time = 0
        while traversed_time < converted_waves_16k.size(-1):
            if buffer is None:
                chunk = converted_waves_16k[:, traversed_time:traversed_time + 16000 * 30]
            else:
                chunk = torch.cat(
                    [buffer, converted_waves_16k[:, traversed_time:traversed_time + 16000 * (30 - overlapping_time)]],
                    dim=-1)
            S_alt = semantic_fn(chunk)
            if traversed_time == 0:
                S_alt_list.append(S_alt)
            else:
                S_alt_list.append(S_alt[:, 50 * overlapping_time:])
            buffer = chunk[:, -16000 * overlapping_time:]
            traversed_time += 30 * 16000 if traversed_time == 0 else chunk.size(-1) - 16000 * overlapping_time
        S_alt = torch.cat(S_alt_list, dim=1)

    ori_waves_16k = torchaudio.functional.resample(ref_audio, sr, 16000)
    S_ori = semantic_fn(ori_waves_16k)

    mel = mel_fn(source_audio.to(device).float())
    mel2 = mel_fn(ref_audio.to(device).float())

    target_lengths = torch.LongTensor([int(mel.size(2) * length_adjust)]).to(mel.device)
    target2_lengths = torch.LongTensor([mel2.size(2)]).to(mel2.device)

    feat2 = torchaudio.compliance.kaldi.fbank(ori_waves_16k, num_mel_bins=80, dither=0,
                                              sample_frequency=16000)
    feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
    style2 = campplus_model(feat2.unsqueeze(0))
    if diagnostic:
        diagnostic.array('source_wave_resampled',source_audio)
        diagnostic.array('reference_wave_resampled',ref_audio)
        diagnostic.array('source_mel',mel)
        diagnostic.array('reference_mel',mel2)
        diagnostic.array('source_content',S_alt)
        diagnostic.array('reference_content',S_ori)
        diagnostic.array('reference_speaker_embedding',style2)

    F0_ori = None
    shifted_f0_alt = None

    cond, _, codes, commitment_loss, codebook_loss = model.length_regulator(
        S_alt, ylens=target_lengths, n_quantizers=3, f0=shifted_f0_alt)
    prompt_condition, _, codes, commitment_loss, codebook_loss = model.length_regulator(
        S_ori, ylens=target2_lengths, n_quantizers=3, f0=F0_ori)

    max_source_window = max_context_window - mel2.size(2)
    if max_source_window <= overlap_frame_len:
        raise ValueError("참조가 너무 길어 변환 창이 없습니다")
    processed_frames = 0
    generated_wave_chunks = []
    while processed_frames < cond.size(1):
        chunk_cond = cond[:, processed_frames:processed_frames + max_source_window]
        is_last_chunk = processed_frames + max_source_window >= cond.size(1)
        cat_condition = torch.cat([prompt_condition, chunk_cond], dim=1)
        with torch.autocast(device_type=device.type, dtype=torch.float16 if fp16 else torch.float32):
            vc_target = model.cfm.inference(cat_condition,
                                            torch.LongTensor([cat_condition.size(1)]).to(mel2.device),
                                            mel2, style2, None, diffusion_steps,
                                            inference_cfg_rate=inference_cfg_rate)
            vc_target = vc_target[:, :, mel2.size(-1):]
        vc_wave = vocoder_fn(vc_target.float()).squeeze()
        vc_wave = vc_wave[None, :]
        if processed_frames == 0:
            if is_last_chunk:
                generated_wave_chunks.append(vc_wave[0].cpu().numpy())
                break
            generated_wave_chunks.append(vc_wave[0, :-overlap_wave_len].cpu().numpy())
            previous_chunk = vc_wave[0, -overlap_wave_len:]
            processed_frames += vc_target.size(2) - overlap_frame_len
        elif is_last_chunk:
            generated_wave_chunks.append(
                crossfade(previous_chunk.cpu().numpy(), vc_wave[0].cpu().numpy(), overlap_wave_len))
            processed_frames += vc_target.size(2) - overlap_frame_len
            break
        else:
            generated_wave_chunks.append(
                crossfade(previous_chunk.cpu().numpy(), vc_wave[0, :-overlap_wave_len].cpu().numpy(),
                          overlap_wave_len))
            previous_chunk = vc_wave[0, -overlap_wave_len:]
            processed_frames += vc_target.size(2) - overlap_frame_len
    vc_wave = torch.tensor(np.concatenate(generated_wave_chunks))[None, :].float()
    time_vc_end = time.time()
    print(f"RTF: {(time_vc_end - time_vc_start) / vc_wave.size(-1) * sr}")

    source_name = os.path.basename(source).split(".")[0]
    target_name = os.path.basename(target_name).split(".")[0]
    os.makedirs(args.output, exist_ok=True)
    out = os.path.join(args.output,
                       f"vc_{source_name}_{target_name}_{length_adjust}_{diffusion_steps}_{inference_cfg_rate}.wav")
    # torchaudio.save(실수 텐서) 와 같은 32비트 실수 wav.
    if os.path.exists(out):
        raise FileExistsError("기존 결과를 덮지 않습니다: " + out)
    if not torch.isfinite(vc_wave).all():
        raise RuntimeError("변환 결과에 유효하지 않은 값이 있습니다")
    sf.write(out, vc_wave[0].cpu().numpy(), sr, subtype='FLOAT')
    if diagnostic and getattr(args,'diagnostics_controls',False):
        # 본 변환이 끝난 뒤에만 원음의 복원을 대조한다. 난수 상태도 보존한다.
        with torch.random.fork_rng(devices=[device.index if device.index is not None else torch.cuda.current_device()]):
            traced_vocoder(raw_vocoder,diagnostic,prefix='control_source')(mel.float())
            traced_vocoder(raw_vocoder,diagnostic,prefix='control_reference')(mel2.float())
    if diagnostic:diagnostic.complete(out)
    return out


def build_parser():
    from modules.commons import str2bool as s2b
    p = argparse.ArgumentParser()
    p.add_argument('--source', type=str, required=True)
    p.add_argument('--target', type=str, required=True)
    p.add_argument('--output', type=str, default='./reconstructed')
    p.add_argument('--diffusion-steps', type=int, default=30)
    p.add_argument('--length-adjust', type=float, default=1.0)
    p.add_argument('--inference-cfg-rate', type=float, default=0.7)
    p.add_argument('--f0-condition', type=s2b, default=False)
    p.add_argument('--seed', type=int, default=20261012)
    p.add_argument('--diagnostics-dir', default=None, help='선택적 로컬 중간 기록; 새 폴더만 사용')
    p.add_argument('--diagnostics-controls', action='store_true',
                   help='원음·참조의 멜을 같은 복원기로 대조; 기록 폴더 필요')
    p.add_argument('--auto-f0-adjust', type=s2b, default=False)
    p.add_argument('--semi-tone-shift', type=int, default=0)


    p.add_argument('--fp16', type=s2b, default=True)
    p.add_argument('--models-dir', type=str, default=None,
                   help='로컬 말하기 모델 폴더')
    return p


if __name__ == '__main__':
    main(build_parser().parse_args())
