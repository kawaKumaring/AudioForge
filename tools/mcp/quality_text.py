"""Conservative text/ASR correspondence, never proof that supplied text was spoken."""
import re, hashlib, json
from difflib import SequenceMatcher

def compact(text):
    return ''.join(c.lower() for c in text if c.isalnum())

def ordinal(text):
    names={'한':'1','첫':'1','두':'2','세':'3','네':'4','다섯':'5','여섯':'6','일곱':'7','여덟':'8','아홉':'9','열':'10'}
    return re.sub(r'(?<![가-힣])('+'|'.join(names)+r')\s*번째',lambda m:names[m[1]]+'번째',text)

def sentences(report):
    expected=report['identity'].get('text')
    if not expected or report['identity']['asr']=='none':
        raise ValueError('기대 대사와 실제 ASR 보고서가 모두 필요합니다.')
    parts=[s.strip() for s in re.split(r'(?<=[.!?。！？])\s*|\n+',expected) if compact(s)]
    # Bound row size for paginated MCP responses. This is an inspection unit, not sentence certainty.
    parts=[s[i:i+800] for s in parts for i in range(0,len(s),800)]
    segments=[s for s in report['transcript'] if s['kind']=='segment']
    cursor=0; indexed=[]
    for s in segments:
        text=compact(ordinal(s['text']));indexed.append((cursor,cursor+len(text),s));cursor+=len(text)
    actual=''.join(compact(ordinal(s['text'])) for s in segments)
    target=''.join(compact(ordinal(p)) for p in parts)
    opcodes=SequenceMatcher(None,target,actual,autojunk=False).get_opcodes()
    out=[];start=0
    for i,part in enumerate(parts):
        wanted=compact(ordinal(part));end=start+len(wanted);mapped=[];hits=0;changes=[]
        for tag,a,b,c,d in opcodes:
            left=max(a,start);right=min(b,end)
            if tag=='equal' and left<right:
                hits+=right-left;mapped.append((c+left-a,c+right-a))
            elif tag!='equal' and (left<right or (a==b and start<=a<end) or (a==b==end==len(target))):
                changes.append({'kind':tag,'expected':target[left:right], 'recognized':actual[c:d]})
                if d>c:mapped.append((c,d))
        nearby=[s for a,b,s in indexed if any(a<d and b>c for c,d in mapped)]
        windows=[{'start':s['start'],'end':s['end']} for s in nearby]
        recognized=' '.join(s['text'].strip() for s in nearby)
        # Missing text deliberately has no invented timestamp. Context is marked separately.
        context=[]
        if not windows:
            anchor=next((c for tag,a,b,c,d in opcodes if a<=start<=b),len(actual))
            context=[{'start':s['start'],'end':s['end']} for a,b,s in indexed if a<=anchor<=b]
        out.append({'index':i,'expected':part,'expectedNormalizedRange':[start,end],
                    'recognizedContext':recognized[:1000],'recognizedContextTruncated':len(recognized)>1000,'equalCharacterFraction':hits/max(1,len(wanted)),
                    'status':'transcript_match' if not changes else ('unlocated_candidate' if not windows else 'difference_candidate'),
                    'candidateWindows':windows,'adjacentContextOnly':context,'changesHash':hashlib.sha256(json.dumps(changes,ensure_ascii=False).encode()).hexdigest(),'changes':[dict(c,expected=c['expected'][:1000],recognized=c['recognized'][:1000],truncated=len(c['expected'])>1000 or len(c['recognized'])>1000) for c in changes],
                    'fullTextTool':'audio_quality_read / transcript', 'timing':'ASR 세그먼트 범위. 발화/누락 확정이나 강제 정렬이 아님.'})
        start=end
    return out

def crosscheck(left,right):
    if (left['source']['sha256']!=right['source']['sha256'] or
        left['summary']['window']!=right['summary']['window'] or
        left['identity'].get('text')!=right['identity'].get('text')):
        raise ValueError('같은 원본 해시·분석 범위·기대 대사끼리만 교차 대조합니다.')
    if left['identity']['asr']==right['identity']['asr'] and left['identity'].get('modelHash')==right['identity'].get('modelHash'):
        raise ValueError('같은 ASR 실행 조건끼리는 교차 검증으로 세지 않습니다.')
    a,b=sentences(left),sentences(right)
    return [{'index':x['index'],'expected':x['expected'],'left':x,'right':y,
             'agreement':'both_transcript_match' if x['status']==y['status']=='transcript_match' else
             ('same_difference_candidate' if x['changesHash']==y['changesHash'] else 'review_disagreement'),
             'qualityVerdict':'미판정. 같은 모델 계열의 공통 오류 가능.'} for x,y in zip(a,b)]
