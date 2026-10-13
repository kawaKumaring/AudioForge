"""상황 지시는 대사 밖에서만, 감정 효과는 검증 전."""
import re

def validate_direction(value):
    if value is None:return ''
    if not isinstance(value,str):raise ValueError('H3 연기 지시는 글이어야 합니다')
    value=value.strip()
    if len(value)>1200:raise ValueError('H3 연기 지시는1200자까지 입력할 수 있습니다')
    if re.search(r'[<>]|\[Shot|subject_definitions:|detailed_description:|retention_analysis:',value,re.I):
        raise ValueError('H3 연기 지시에는 내부 제어 태그를 넣을 수 없습니다')
    return value
