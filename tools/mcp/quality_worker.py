"""AudioForge quality inspection: CPU/local only; no quality pass inferred from metrics."""
import sys, json, math, hashlib, platform, importlib.metadata
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import soundfile as sf
VERSION = '2'

def digest(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def window(path,start=None,end=None,max_seconds=600):
    info=sf.info(path);start=0.0 if start is None else float(start);end=info.duration if end is None else float(end)
    if not all(math.isfinite(v) for v in (start,end)) or start<0 or end<=start or end>info.duration+1/info.samplerate: raise ValueError('잘못된 시간 범위')
    if end-start>max_seconds:raise ValueError(f'한 번에 {max_seconds}초까지. start/end를 지정하세요.')
    if info.channels>8:raise ValueError('최대 8채널 지원')
    if (end-start)*info.samplerate*info.channels>30_000_000:raise ValueError('디코딩 샘플 한도 초과. 범위를 줄이세요.')
    begin=round(start*info.samplerate);finish=min(info.frames,round(end*info.samplerate))
    y,sr=sf.read(path,start=begin,stop=finish,dtype='float32',always_2d=True)
    if not len(y):raise ValueError('빈 음원')
    return y,sr,info,begin/sr,finish/sr

def db(x):return float(20*np.log10(max(float(x),1e-12)))
def norm(s):return ''.join(c.lower() for c in s if c.isalnum())
def ordinal(s):
    import re
    # Only equivalent native Korean ordinal spellings; never turn 4 into 5.
    names={'한':'1','첫':'1','두':'2','세':'3','네':'4','다섯':'5','여섯':'6','일곱':'7','여덟':'8','아홉':'9','열':'10'}
    return re.sub(r'(?<![가-힣])('+'|'.join(names)+r')\s*번째',lambda m:names[m[1]]+'번째',s)
def cer(a,b):
    a,b=norm(a),norm(b)
    if not a:return None
    d=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        prev=d[0];d[0]=i
        for j,y in enumerate(b,1):prev,d[j]=d[j],min(d[j]+1,d[j-1]+1,prev+(x!=y))
    return d[-1]/len(a)
def spans(mask,hop,sr,start,minimum=.5):
    edges=np.diff(np.r_[False,mask,False].astype(int))
    return [{'start':round(start+a*hop/sr,4),'end':round(start+b*hop/sr,4),'duration':round((b-a)*hop/sr,4)} for a,b in zip(np.where(edges==1)[0],np.where(edges==-1)[0]) if (b-a)*hop/sr>=minimum]

def analyze(a):
    y,sr,info,start,end=window(a['source'],a['start'],a['end']);valid=bool(np.isfinite(y).all());safe=np.nan_to_num(y,nan=0,posinf=0,neginf=0)
    signals=[];hop=max(1,round(sr*.01));n=len(y)//hop
    frame_rms=np.sqrt(np.mean(safe[:n*hop].reshape(n,hop,info.channels).astype('float64')**2,axis=1)) if n else np.zeros((0,info.channels))
    for ch in range(info.channels):
        z=safe[:,ch].astype('float64');peak=float(np.abs(z).max());rms=float(np.sqrt(np.mean(z*z)))
        signals.append({'kind':'channel','channel':ch,'peak':peak,'rmsDb':db(rms),'dc':float(z.mean()),'crestDb':db(peak)-db(rms),'nearFullScaleSamples':int((np.abs(z)>=.9999).sum()),'nonfiniteSamples':int((~np.isfinite(y[:,ch])).sum())})
    if n:
        # All channels quiet; opposite-phase stereo must not disappear through downmix.
        env=frame_rms.max(axis=1)
        for gap in spans(env<10**(-50/20),hop,sr,start):signals.append({'kind':'quiet_candidate','thresholdDbFS':-50,'frameMs':hop/sr*1000,**gap})
    transcript=[{'kind':'expected','offset':i,'text':a['text'][i:i+2000]} for i in range(0,len(a['text'] or ''),2000)];differences=[];raw=normalized=None;asr_text=None
    if a['asr']!='none':
        if not valid:raise ValueError('비유한 샘플이 있어 ASR은 실행하지 않습니다. asr:none으로 신호 검사하세요.')
        import torch,whisper
        from scipy.signal import resample_poly
        torch.set_num_threads(4)
        # Pick highest-energy channel explicitly, avoiding phase cancellation.
        ch=int(np.argmax(np.mean(safe.astype('float64')**2,axis=0)))
        audio=resample_poly(safe[:,ch],16000//math.gcd(sr,16000),sr//math.gcd(sr,16000)).astype('float32')
        model=whisper.load_model(a['model'],device='cpu')
        res=model.transcribe(audio,language='ko',fp16=False,temperature=0,condition_on_previous_text=False,word_timestamps=True,verbose=None)
        asr_text=res['text']
        char_cursor=0
        for seg in res['segments']:
            transcript.append({'kind':'segment','start':start+seg['start'],'end':start+seg['end'],'text':seg['text'],'asrChannel':ch,'recognizedCharRange':[char_cursor,char_cursor+len(norm(seg['text']))]})
            char_cursor+=len(norm(seg['text']))
            for word in seg.get('words',[]):transcript.append({'kind':'word','start':start+word['start'],'end':start+word['end'],'text':word['word'],'probability':word.get('probability')})
        if a['text'] is not None:
            import difflib
            raw=cer(a['text'],asr_text);normalized=cer(ordinal(a['text']),ordinal(asr_text))
            for tag,i,j,k,l in difflib.SequenceMatcher(None,norm(a['text']),norm(asr_text),autojunk=False).get_opcodes():
                if tag!='equal':
                    nearby=[s for s in transcript if s['kind']=='segment' and s['recognizedCharRange'][1]>=k and s['recognizedCharRange'][0]<=max(k,l-1)]
                    differences.append({'kind':tag,'candidateWindows':[{'start':s['start'],'end':s['end']} for s in nearby],'expected':norm(a['text'])[i:j],'recognized':norm(asr_text)[k:l],'expectedCharRange':[i,j],'recognizedCharRange':[k,l],'timing':'문자 위치는 정규화 문자열 기준. 정확한 강제 정렬이 아님.'})
    records=[]
    for rec in a['records']:
        rawrecord=Path(rec['path']).read_text(encoding='utf-8-sig');json.loads(rawrecord)
        for offset in range(0,len(rawrecord),2000):records.append({'path':rec['path'],'sha256':rec['sha256'],'offset':offset,'text':rawrecord[offset:offset+2000],'sourceHashMentioned':a['sourceHash'] in rawrecord,'trust':'사용자 제공 기록. 경로/명령을 실행하지 않음. 해시 언급은 설정의 진실성 증명이 아님.'})
    return {'summary':{'version':VERSION,'sourceSha256':a['sourceHash'],'totalDuration':info.duration,'duration':len(y)/sr,'window':[start,end],'sampleRate':sr,'channels':info.channels,'format':info.format,'subtype':info.subtype,'finite':valid,'peak':max(r['peak'] for r in signals if r['kind']=='channel'),'rmsDb':[r['rmsDb'] for r in signals if r['kind']=='channel'],'rawCer':raw,'ordinalNormalizedCer':normalized,'asr':a['asr'],'expectedTextProvided':a['text'] is not None,'sections':['summary','provenance','signals','transcript','differences','records'],'facts':['원본 바이트 해시와 분석 범위 기록','ASR none이면 전사/대사 오류 판정 미실행'],'limitations':['무음·피크·ASR 불일치는 청취 합격/불합격이 아님','화자 유사도·감정·자연스러움 미판정','구절 연결 좌표는 기록 없으면 추정하지 않음','서수 정규화는 1~10 native Korean 번째 표기만 지원','ASR은 한국어 CPU; 단어 시각은 추정','배경 잡음과 무성 자음 자동 구분 미지원']},'signals':signals,'transcript':transcript,'differences':differences,'records':records}

def render(a):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from scipy.signal import spectrogram
    plt.rcParams.update({'font.family':'Malgun Gothic' if platform.system()=='Windows' else 'DejaVu Sans','axes.unicode_minus':False})
    samples=[]
    for r in a['reports']:
        start=r['window'][0] if a.get('start') is None else a['start'];end=r['window'][1] if a.get('end') is None else a['end']
        if start<r['window'][0] or end>r['window'][1]:raise ValueError('분석 보고서 범위 안에서 요청하세요.')
        samples.append((r,window(r['source']['path'],start,end,120)))
    max_t=max(s[1][4] for s in samples);min_t=min(s[1][3] for s in samples);amp=max(1,max(float(np.nanmax(np.abs(s[1][0]))) for s in samples))
    fig,axes=plt.subplots(2,len(samples),figsize=(7*len(samples),6),squeeze=False,layout='constrained')
    for col,(r,(y,sr,info,start,end)) in enumerate(samples):
        if not np.isfinite(y).all():raise ValueError('비유한 샘플 시각화 미지원. signals에서 확인하세요.')
        hop=max(1,len(y)//2400);n=math.ceil(len(y)/hop);frame=np.pad(y,((0,n*hop-len(y)),(0,0)),mode='edge').reshape(n,hop,info.channels);t=np.minimum(end,start+(np.arange(n)*hop+hop/2)/sr)
        for ch in range(info.channels):axes[0,col].fill_between(t,frame[:,:,ch].min(axis=1),frame[:,:,ch].max(axis=1),alpha=.5,label=f'ch {ch}')
        axes[0,col].set(xlim=(min_t,max_t),ylim=(-amp,amp),title=Path(r['source']['path']).name,ylabel='Amplitude');axes[0,col].legend()
        powers=[]
        for ch in range(info.channels):
            win=min(512,len(y));f,t,s=spectrogram(y[:,ch],sr,nperseg=win,noverlap=min(384,win//2),scaling='spectrum');powers.append(s)
        im=axes[1,col].pcolormesh(t+start,f,10*np.log10(np.maximum(np.max(powers,axis=0),1e-12)),vmin=-90,vmax=-20,cmap='magma',shading='auto');axes[1,col].set(xlim=(min_t,max_t),ylim=(0,min(8000,min(x[1][1] for x in samples)/2)),xlabel='Source seconds',ylabel='Hz')
    fig.colorbar(im,ax=list(axes[1]),label='Spectrum power dB');dest=Path(a['dir'])/'comparison.png';fig.savefig(dest,dpi=130);plt.close(fig)
    return {'image':str(dest),'sha256':digest(dest),'sources':[r['source'] for r in a['reports']],'render':{'timeAxis':[min_t,max_t],'amplitudeAxis':[-amp,amp],'spectralDb':[-90,-20],'channels':'waveform all; spectrogram max power over channels','fftMaxSamples':512,'normalized':False,'timeAligned':False},'note':'같은 축. 소리 품질 판정 아님.'}

def run(a):
    if a['op']=='sentences':
        from quality_text import sentences
        return sentences(a['report'])
    if a['op']=='crosscheck':
        from quality_text import crosscheck
        return crosscheck(a['left'],a['right'])
    if a['op']=='boundary':
        r=a['report'];t=a['time'];width=a['width']
        lo,hi=r['summary']['window']
        if t-width<lo or t+width>hi:raise ValueError('연결점 양쪽 측정 범위가 보고서 밖입니다.')
        y,sr,info,start,end=window(r['source']['path'],t-width,t+width,5)
        if not np.isfinite(y).all():raise ValueError('비유한 샘플이 있는 연결부')
        at=round(t*sr)-round(start*sr)
        if at<1 or at>=len(y):raise ValueError('연결점 양쪽 샘플 필요')
        channels=[]
        for ch in range(info.channels):
            left=y[:at,ch].astype('float64');right=y[at:,ch].astype('float64')
            l=db(np.sqrt(np.mean(left*left)));v=db(np.sqrt(np.mean(right*right)))
            channels.append({'channel':ch,'leftRmsDb':l,'rightRmsDb':v,'deltaRmsDb':v-l,'sampleStep':float(right[0]-left[-1]),'leftPeak':float(np.max(np.abs(left))),'rightPeak':float(np.max(np.abs(right)))})
        return {'time':round(t*sr)/sr,'window':[start,end],'channels':channels,'qualityVerdict':'미판정. 샘플 차이/음량 변화는 클릭음·부자연스러움 확정이 아님.'}
    if a['op']=='capabilities':
        deps={}
        for name in ['numpy','soundfile','scipy','matplotlib','torch','openai-whisper']:
            try:deps[name]=importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:deps[name]=None
        return {'version':VERSION,'python':sys.version.split()[0],'dependencies':deps,'decodeFormats':sf.available_formats(),'asrLocalModels':{n:(Path.home()/'.cache/whisper'/f'{n}.pt').exists() for n in ['base','small']},'limits':{'analysisSeconds':600,'plotClipSeconds':120,'channels':8,'samples':30_000_000},'network':False,'device':'CPU','unavailable':['청취 판정','화자 유사도 점수','정확한 음절 강제 정렬','자동 감정 판정'],'workflow':'inventory → analyze → read (all pages) → plot / compare / clip'}
    if a['op']=='analyze':return analyze(a)
    if a['op']=='plot':return render(a)
    if a['op']=='clip':
        r=a['reports'][0]
        if a['start']<r['window'][0] or a['end']>r['window'][1]:raise ValueError('분석 범위 밖')
        y,sr,_,start,end=window(r['source']['path'],a['start'],a['end'],120);dest=Path(a['dir'])/'excerpt.wav';sf.write(dest,y,sr,subtype='FLOAT')
        return {'path':str(dest),'sha256':digest(dest),'source':r['source'],'start':start,'end':end,'sampleRate':sr,'channels':y.shape[1],'frames':len(y),'processing':'float32 디코딩 샘플 그대로, FLOAT WAV 저장. 음량/속도 변경 없음'}
    raise ValueError('unknown operation')
if __name__=='__main__':
    try:print(json.dumps(run(json.load(sys.stdin)),ensure_ascii=False,allow_nan=False))
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
