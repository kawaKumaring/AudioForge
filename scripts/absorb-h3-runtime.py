"""설치된 H3 추론 코드의 의존 부분만 앱 안으로 복사. 서버·GUI·다운로드·원본 삭제 없음."""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil

ROOT=Path(__file__).resolve().parents[1]
SOURCE=Path(r'E:\AI\ComfyUI_windows_portable_python3.12\ComfyUI')
DEST=(ROOT/'externals').resolve()/'h3_runtime'
MODELS=(ROOT/'externals').resolve()/'h3_models'

class Returns(ast.NodeTransformer):
    def visit_Call(self,node):
        self.generic_visit(node)
        if isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name) and node.func.value.id in {'io','IO'} and node.func.attr=='NodeOutput':
            return ast.Tuple(elts=node.args,ctx=ast.Load())
        return node

def method(tree,cls,name):
    c=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name==cls)
    f=next(n for n in c.body if isinstance(n,ast.FunctionDef) and n.name=='execute')
    f.name=name;f.decorator_list=[];f.args.args=f.args.args[1:]
    return Returns().visit(f)

def main():
    DEST.mkdir(parents=True,exist_ok=True);MODELS.mkdir(parents=True,exist_ok=True)
    source=SOURCE/'comfy_extras/nodes_minimax_h3.py';tree=ast.parse(source.read_text(encoding='utf-8'))
    helpers=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.Assign))]
    helpers+=[method(tree,'MiniMaxH3ReferenceToVideo','reference_to_latent'),method(tree,'MiniMaxH3SigmaShift','shift_model')]
    audio=ast.parse((SOURCE/'comfy_extras/nodes_audio.py').read_text(encoding='utf-8'))
    helpers+=[n for n in audio.body if isinstance(n,ast.FunctionDef) and n.name=='vae_decode_audio']
    code='''# H3 추론 함수만 추출. 원본 ComfyUI GPL-3.0, LICENSE와 manifest.json 참조.
from __future__ import annotations
import math
import torch
import torch.nn.functional as F
import comfy.audio
import comfy.model_management
import comfy.model_prefetch
import comfy.model_sampling
import comfy.nested_tensor
import comfy.patcher_extension
import comfy.utils
import node_helpers
from comfy.ldm.minimax.model import FRAME_PER_TOKEN, FRAME_RESCALE
from comfy.ldm.minimax.vae import IMAGENET_MEAN
'''+ast.unparse(ast.Module(body=helpers,type_ignores=[]))+'\n'
    (DEST/'h3_ops.py').write_text(code,encoding='utf-8')
    queue=['comfy.sd','comfy.sample','comfy.samplers','comfy.options','comfy.cli_args','node_helpers',
           'comfy.audio','comfy.model_prefetch','comfy.nested_tensor','comfy.patcher_extension','comfy.utils',
           'comfy.model_management','comfy.model_sampling','comfy.ldm.minimax.model','comfy.ldm.minimax.vae','folder_paths']
    copied={}
    def locate(module):
        p=SOURCE.joinpath(*module.split('.'))
        return p.with_suffix('.py') if p.with_suffix('.py').is_file() else p/'__init__.py' if (p/'__init__.py').is_file() else None
    while queue:
        module=queue.pop();path=locate(module)
        if not path or module in copied:continue
        relative=path.relative_to(SOURCE);target=DEST/relative;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(path,target);copied[module]={'file':str(relative),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
        pkg=module if path.name=='__init__.py' else module.rpartition('.')[0]
        for i in range(1,len(module.split('.'))):queue.append('.'.join(module.split('.')[:i]))
        try:parsed=ast.parse(path.read_text(encoding='utf-8-sig'))
        except (SyntaxError,UnicodeError):continue
        for n in ast.walk(parsed):
            if isinstance(n,ast.Import):queue.extend(a.name for a in n.names)
            elif isinstance(n,ast.ImportFrom):
                base=n.module or ''
                if n.level:
                    parent=pkg.split('.')[:len(pkg.split('.'))-n.level+1];base='.'.join(parent+([base] if base else []))
                queue.append(base);queue.extend(base+'.'+a.name for a in n.names if a.name!='*')
    # 실제 Qwen3VL 토크나이저와 동적으로 읽는 모델 설정. 모델 가중치는 여기 복사하지 않는다.
    for path in (SOURCE/'comfy').rglob('*.json'):
        if 'qwen25_tokenizer' in path.parts or path.with_suffix('.py').is_file() or path.parent in {SOURCE/'comfy',SOURCE/'comfy/text_encoders'}:
            target=DEST/path.relative_to(SOURCE);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,target)
    tokenizer=SOURCE/'comfy/text_encoders/qwen25_tokenizer'
    if tokenizer.is_dir():shutil.copytree(tokenizer,DEST/tokenizer.relative_to(SOURCE),dirs_exist_ok=True)
    shutil.copy2(SOURCE/'LICENSE',DEST/'LICENSE')
    names={'model':'diffusion_models/minimax-h3/minimax_h3_ref2va_pruned_int8_convrot.safetensors',
           'encoder':'text_encoders/minimax-h3/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
           'audio_vae':'vae/minimax-h3/minimax_h3_audio_vae_fp32.safetensors'}
    assets={}
    for key,relative in names.items():
        source=SOURCE/'models'/relative;target=MODELS/source.name
        if not source.is_file():raise FileNotFoundError(source.name)
        if not target.exists():os.link(source,target)
        if not os.path.samefile(source,target):raise RuntimeError('기존 모델과 다른 파일: '+target.name)
        assets[key]={'file':target.name,'size':source.stat().st_size,'storage':'읽기 전용으로 사용하는 하드링크. 원본 삭제·수정 없음.'}
    manifest={'license':'ComfyUI GPL-3.0','source':'설치된 ComfyUI 기본 추론 코드','modules':copied,
              'h3_source_sha256':hashlib.sha256((SOURCE/'comfy_extras/nodes_minimax_h3.py').read_bytes()).hexdigest(),
              'ops_sha256':hashlib.sha256((DEST/'h3_ops.py').read_bytes()).hexdigest(),'assets':assets,
              'excluded':'서버·GUI·커스텀 노드·영상 VAE·다운로드·미디어 저장 노드'}
    (DEST/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'runtime':str(DEST),'modules':len(copied),'models':len(assets)},ensure_ascii=False))

if __name__=='__main__':main()
