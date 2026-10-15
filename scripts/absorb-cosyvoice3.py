"""승인된 공개 추론 코드/모델만 앱에 내려받는다. 사용자 자료 업로드 없음."""
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import requests

CODE_REV = '074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc'
MODEL_REV = '29e01c4e8d000f4bcd70751be16fa94bf3d85a18'
REPO = 'FunAudioLLM/CosyVoice'
MODEL = 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512'
ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'externals'
VENDOR = ROOT / 'python' / 'cosyvoice_vendor'
WEIGHTS = ASSETS / 'cosyvoice3_models'

def get(url):
    r = requests.get(url, timeout=90)
    r.raise_for_status()
    return r

def absorb_code():
    tree = get(f'https://api.github.com/repos/{REPO}/git/trees/{CODE_REV}?recursive=1').json()['tree']
    available = {x['path'] for x in tree if x['type'] == 'blob'}
    sub = next(x for x in tree if x['path'] == 'third_party/Matcha-TTS')
    matcha_rev = sub['sha']
    mtree = get(f'https://api.github.com/repos/shivammehta25/Matcha-TTS/git/trees/{matcha_rev}?recursive=1').json()['tree']
    mavail = {x['path'] for x in mtree if x['type'] == 'blob'}
    done = {}
    pending = ['cosyvoice/cli/frontend.py', 'cosyvoice/cli/model.py', 'cosyvoice/llm/llm.py',
               'cosyvoice/flow/flow.py', 'cosyvoice/hifigan/generator.py',
               'cosyvoice/hifigan/f0_predictor.py', 'cosyvoice/flow/DiT/dit.py', 'cosyvoice/flow/flow_matching.py',
               'cosyvoice/transformer/upsample_encoder.py', 'cosyvoice/tokenizer/tokenizer.py',
               'matcha/utils/audio.py', 'matcha/models/components/flow_matching.py']
    while pending:
        path = pending.pop()
        if path in done:
            continue
        is_matcha = path.startswith('matcha/')
        files = mavail if is_matcha else available
        if path not in files:
            continue
        base = f'https://raw.githubusercontent.com/shivammehta25/Matcha-TTS/{matcha_rev}' if is_matcha else f'https://raw.githubusercontent.com/{REPO}/{CODE_REV}'
        source = get(f'{base}/{path}').text
        target = VENDOR / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source, encoding='utf-8')
        done[path] = hashlib.sha256(source.encode()).hexdigest()
        parsed = ast.parse(source)
        for node in ast.walk(parsed):
            if isinstance(node, ast.ImportFrom):
                base_mod = node.module or ''
                if node.level:
                    parent_mod = path[:-3].split('/')[:-1]
                    parent_mod = parent_mod[:len(parent_mod) - node.level + 1]
                    base_mod = '.'.join(parent_mod + ([base_mod] if base_mod else []))
                modules = [base_mod] + [base_mod + '.' + a.name for a in node.names]
            elif isinstance(node, ast.Import):
                modules = [a.name for a in node.names]
            else:
                continue
            for mod in modules:
                if mod.startswith(('cosyvoice.', 'matcha.')):
                    p = mod.replace('.', '/')
                    pending.extend([p + '.py', p + '/__init__.py'])
        # 패키지 초기화 파일도 가져온다.
        for parent in Path(path).parents:
            if str(parent) != '.':
                pending.append(parent.as_posix() + '/__init__.py')
    for name, url in [('COSYVOICE-LICENSE', f'https://raw.githubusercontent.com/{REPO}/{CODE_REV}/LICENSE'),
                      ('MATCHA-LICENSE', f'https://raw.githubusercontent.com/shivammehta25/Matcha-TTS/{matcha_rev}/LICENSE')]:
        (VENDOR / name).write_text(get(url).text, encoding='utf-8')
    (VENDOR / 'provenance.json').write_text(json.dumps({'code_repo': REPO, 'code_revision': CODE_REV,
        'matcha_revision': matcha_rev, 'files_sha256': done}, indent=2), encoding='utf-8')
    # 추론 import에 끌려 들어오던 학습용 callback/다운로드 유틸은 흡수하지 않는다.
    (VENDOR/'matcha/utils/__init__.py').write_text('# AudioForge: inference-only; upstream MIT license retained.\n',encoding='utf-8')
    (VENDOR/'matcha/utils/pylogger.py').write_text('# AudioForge: single-process inference logger; upstream MIT license retained.\nimport logging\ndef get_pylogger(name=__name__):\n    return logging.getLogger(name)\n',encoding='utf-8')
    omitted=[]
    for name in ['instantiators.py','logging_utils.py','rich_utils.py','utils.py']:
        target=VENDOR/'matcha/utils'/name
        if target.is_file():
            target.unlink()
            omitted.append('matcha/utils/'+name)
    info=json.loads((VENDOR/'provenance.json').read_text(encoding='utf-8'))
    info['omitted_training_files']=omitted
    info['adaptations']=['matcha utils initialization: inference only','matcha logger: no training framework']
    info['absorbed_sha256']={p.relative_to(VENDOR).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in VENDOR.rglob('*.py')}
    (VENDOR/'provenance.json').write_text(json.dumps(info,indent=2),encoding='utf-8')
    print('추론 코드', len(done), '파일', flush=True)

def download_models():
    needed = ['cosyvoice3.yaml', 'llm.pt', 'flow.pt', 'hift.pt', 'campplus.onnx',
              'speech_tokenizer_v3.onnx', 'README.md', 'CosyVoice-BlankEN/config.json',
              'CosyVoice-BlankEN/generation_config.json', 'CosyVoice-BlankEN/merges.txt',
              'CosyVoice-BlankEN/tokenizer_config.json', 'CosyVoice-BlankEN/vocab.json',
              'CosyVoice-BlankEN/model.safetensors']
    env = os.environ.copy()
    env['HF_HOME'] = str(ASSETS / 'cosyvoice3_download_cache')
    env['HF_HUB_DISABLE_XET'] = '1'
    env['PYTHONIOENCODING'] = 'utf-8'
    subprocess.run([sys.executable, '-m', 'huggingface_hub.cli.hf', 'download', MODEL, *needed,
        '--revision', MODEL_REV, '--local-dir', str(WEIGHTS), '--max-workers', '2'], check=True, env=env)
    rows = []
    for name in needed:
        p = WEIGHTS / name
        h = hashlib.sha256()
        with p.open('rb') as f:
            for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
                h.update(block)
        rows.append({'name': name, 'bytes': p.stat().st_size, 'sha256': h.hexdigest()})
    (WEIGHTS / 'audioforge-manifest.json').write_text(json.dumps({'repo': MODEL,
        'revision': MODEL_REV, 'files': rows}, indent=2), encoding='utf-8')
    print('필수 모델 완료', sum(x['bytes'] for x in rows), '바이트', flush=True)

if __name__ == '__main__':
    absorb_code()
    download_models()
