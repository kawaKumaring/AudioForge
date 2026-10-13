"""H3 한국어 시간 예산. 청취된 두 표본 기반 초기 추정, 원문·읽기 지시 변경 없음."""
import re
import unicodedata
from spoken_ordinals import spoken_ordinals

TIMING_VERSION='h3-ko-units-v1'
RATE=5.7
START_SECONDS=.5
MAX_FRAMES=736


def estimate(text):
    counted=unicodedata.normalize('NFC',text)
    counted,ordinals=spoken_ordinals(counted)  # 시간 산정에만, 모델에 보내는 원문은 그대로
    hangul=len(re.findall('[가-힣]',counted))
    digits=len(re.findall('[0-9]',counted))
    latin=len(re.findall('[A-Za-z]',counted))
    other=sum(c.isalpha() and not ('가'<=c<='힣') and not ('A'<=c<='Z' or 'a'<=c<='z') for c in counted)
    units=hangul+digits+latin+other
    if not units:raise ValueError('H3 시간 계산에 읽을 글자가 없습니다')
    seconds=max(5.,units/RATE+START_SECONDS)
    frames=max(5,round(seconds*24));frames+=(5-frames)%17
    warnings=[]
    if digits:warnings.append('숫자는 자릿수 기반 근사·읽기 방식 미확정')
    if latin or other:warnings.append('외국어는 글자 기반 근사·발음 길이 미확정')
    return {'rule':TIMING_VERSION,'units':units,'hangul_syllables':hangul,'digit_units':digits,'foreign_units':latin+other,
            'ordinal_count_for_estimate':len(ordinals),'rate':RATE,'start_seconds':START_SECONDS,
            'estimated_seconds':seconds,'frames':frames,'aligned_seconds':frames/24,'uncertainty':warnings,
            'pause_policy':'청취 표본의 쉼 포함 속도 사용·문장부호 쉼 중복 가산 없음'}


def split_by_budget(text,limit=None):
    if limit is not None and limit<1:raise ValueError('분할 길이 제한이 올바르지 않습니다')
    def fits(value):
        try:return (limit is None or len(value)<=limit) and estimate(value)['frames']<=MAX_FRAMES
        except ValueError:return False
    chunks=[];rest=text
    while rest:
        if fits(rest):chunks.append(rest);break
        ends=[m.end() for m in re.finditer(r'\s+',rest)]
        valid=[e for e in ends if rest[:e].strip() and fits(rest[:e])]
        if not valid:raise RuntimeError('H3 한 어절이 시간 예산을 넘습니다. 단어를 자르지 말고 띄어쓰기를 확인하세요')
        sentences=[e for e in valid if rest[:e].rstrip().endswith(('.', '!', '?', '。', '！', '？'))]
        end=max(sentences or valid);chunks.append(rest[:end]);rest=rest[end:]
    assert ''.join(chunks)==text
    return chunks
