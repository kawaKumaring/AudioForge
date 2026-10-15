"""참조 A·분노 지시 언어 비교. 제품 지시는 수정하지 않는다."""
import hashlib
import html
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
MASTER = (ROOT / 'externals').resolve().parent
OLD = MASTER / '_local/테스트/결과/cosyvoice3-scenes-fixed-20261012'
OUT = MASTER / '_local/테스트/결과' / ('cosy-instruction-language-' + time.strftime('%Y%m%d-%H%M%S'))

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def main():
    sys.path.insert(0, str(ROOT / 'python'))
    from cosyvoice_engine import INSTRUCTIONS
    from tts_worker import synthesize
    import numpy as np
    import soundfile as sf
    old = json.loads((OLD / 'cosyvoice3-results.json').read_text(encoding='utf-8'))
    # 사용자 판정은 전체 조건에 대한 의견이다. 인물별 판정을 만들어 넣지 않는다.
    feedback = {'source': '사용자 청취', 'scope': '전체 조건, 인물별 구분 없음',
        'text': '감정은 적용되지만 외국인이 한국어를 어설프게 배운 발음처럼 들림. 자연스럽게와 낮고 부드럽게는 자연스러운 한국어. 명랑은 애매하며 슬픔처럼 들림.',
        'files': [{'voice': r['voice'], 'condition': r['condition'], 'path': r['path'],
                   'sha256': r['sha256']} for r in old]}
    for r in old:
        if sha(r['path']) != r['sha256']:
            raise RuntimeError('앞 청취 파일이 기록과 다릅니다')
    OUT.mkdir(parents=True, exist_ok=False)
    (OUT / '앞선청취판정.json').write_text(json.dumps(feedback, ensure_ascii=False, indent=2), encoding='utf-8')
    ref = OLD / '참조/A.wav'
    before = sha(ref)
    base = next(r for r in old if r['voice'] == 'A' and r['condition'] == '분노')
    if before != base['reference_sha256']:
        raise RuntimeError('참조 A 지문이 다릅니다')
    conditions = [
        ('중국어 분노 · 기존', 'You are a helpful assistant. 请非常生气地说一句话。'),
        ('영어 분노', 'You are a helpful assistant. Please say a sentence in a very angry tone.'),
        ('한국어 분노', 'You are a helpful assistant. 매우 화난 말투로 한 문장을 말해 주세요.'),
        ('영어 분노 · 한국어 명시', 'You are a helpful assistant. Please say a sentence in a very angry tone. Speak in Korean.'),
    ]
    rows = []
    print('결과 위치: ' + str(OUT), flush=True)
    for i, (label, instruction) in enumerate(conditions):
        INSTRUCTIONS['angry'] = instruction
        os.environ['AUDIOFORGE_TTS_SEED'] = str(base['seed'])
        os.environ['AUDIOFORGE_DIAG_CHUNK_PUBLISH'] = OUT.name + '-' + str(i)
        os.environ['AUDIOFORGE_LOCAL_ROOT'] = str(OUT / '기록')
        os.environ['AF_RUN_RECORD_DAYS'] = '0'
        started = time.monotonic()
        (OUT / str(i + 1)).mkdir()
        path = synthesize(str(ref), base['request_text'], str(OUT / str(i + 1)),
            preferred_engine='cosyvoice3', reference_conditioning_mode='auto',
            speed=1, pitch=0, silence_gap=.5,
            tail_cfg={'mode':'auto','pad_ms':120,'fade_ms':8})
        audio, sr = sf.read(path)
        if not np.isfinite(audio).all() or len(audio) == 0:
            raise RuntimeError('유효하지 않은 음성')
        rows.append({'condition':label,'instruction':instruction,'path':str(path),
            'sha256':sha(path),'reference_sha256':before,'seed':base['seed'],
            'source_text':base['source_text'],'request_text':base['request_text'],
            'duration_sec':len(audio)/sr,'peak':float(np.abs(audio).max()),
            'elapsed_sec':time.monotonic()-started,'listening':'pending'})
        if sha(ref) != before:
            raise RuntimeError('참조 변경')
        (OUT / 'results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
        print(label + ' 완료', flush=True)
    body = '<!doctype html><meta charset="utf-8"><title>분노 지시 언어 비교</title><style>body{background:#12161e;color:#dbe8f7;font:16px sans-serif;max-width:900px;margin:32px auto;padding:20px}section{background:#202631;padding:18px;margin:16px 0;border-radius:12px}audio{width:100%}p{overflow-wrap:anywhere;line-height:1.7}</style><h1>참조 A · 분노 지시 언어 비교</h1><p>1~3은 지시 언어 비교, 2와 4는 한국어 명시 유무 비교입니다. 번역 표현이 완전히 같은 강도를 보장하지는 않습니다. 발음·목소리 유지·분노를 각각 들어 주세요. 음량·속도 보정 없음.</p>'
    body += '<p>' + html.escape(base['source_text']) + '</p>'
    for r in rows:
        body += '<section><h2>' + html.escape(r['condition']) + '</h2><audio controls src="' + html.escape(Path(r['path']).relative_to(OUT).as_posix(),quote=True) + '"></audio><p>' + html.escape(r['path']) + '</p><details><summary>실제 지시</summary>' + html.escape(r['instruction']) + '</details></section>'
    body += '<script>document.addEventListener("play",e=>document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause()}),true)</script>'
    (OUT / '비교듣기.html').write_text(body,encoding='utf-8')
    print('비교 페이지: ' + str(OUT / '비교듣기.html'),flush=True)

if __name__ == '__main__':
    main()
