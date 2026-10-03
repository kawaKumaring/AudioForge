"""Qwen 지정 목소리 **감정 지시** 한 곳 — 생성 카드(tts_worker)와 상주 실행기(qwen_voice_server · 낭독)가 같이 쓴다.

감정 id(tts_worker.EMOTION_TAGS 의 값) → 영어 지시. 이유·실측은 tts_worker 의 '감정 지시' 주석과 doc/reader-engine 4-9.
★1.7B 지정 목소리만 지시를 받는다(0.6B 는 패키지가 버린다). ★성적인 감정 태그는 싣지 않는다.
"""

QWEN_EMOTION_INSTRUCTS = {
    "happy": "Speak in a very happy, joyful and excited tone.",
    "sad": "Speak in a very sad, sorrowful tone, as if about to cry.",
    "angry": "Speak in a very angry, furious tone.",
    "surprise": "Speak in a very surprised, astonished tone.",
    "whisper": "Whisper very softly and quietly, almost without voice.",
    "serious": "Speak in a very serious, grave tone.",
    "cheerful": "Speak in a very bright, cheerful tone.",
    "worried": "Speak in a very worried, anxious tone.",
    "tired": "Speak in a very tired, exhausted tone.",
    "polite": "Speak in a very polite, courteous tone.",
    "sarcastic": "Speak in a very sarcastic tone.",
    "nervous": "Speak in a very nervous, tense tone.",
    "shy": "Speak in a very shy, timid tone.",
    "confident": "Speak in a very confident, assured tone.",
    "comforting": "Speak in a very warm, comforting tone.",
    "excited": "Speak in a very excited tone.",
    "scared": "Speak in a very scared, frightened tone.",
    "annoyed": "Speak in a very annoyed, irritated tone.",
    "narration": "Read calmly and clearly, like a narrator.",
    "longing": "Speak in a very wistful, longing tone.",
    "jealous": "Speak in a very jealous, resentful tone.",
    "touched": "Speak in a very deeply moved, touched tone.",
    "empty": "Speak in a very hollow, defeated tone.",
    "mocking": "Speak in a very mocking, teasing tone.",
    "cute": "Speak in a very cute, sweet and playful tone.",
    "cold": "Speak in a very cold, detached tone.",
    "tender": "Speak in a very tender, affectionate tone.",
    "tearful": "Speak in a very tearful voice, as if about to cry.",
    "sighing": "Speak with a heavy, weary sigh.",
    "solemn": "Speak in a very solemn, resolute tone.",
    "playful": "Speak in a very playful, mischievous tone.",
    "contempt": "Speak in a very contemptuous, scornful tone.",
    "admiring": "Speak in a very admiring, awed tone.",
    "restless": "Speak in a very restless, impatient tone.",
    "resigned": "Speak in a very resigned, accepting tone.",
    "curious": "Speak in a very curious, inquisitive tone.",
    "bored": "Speak in a very bored, uninterested tone.",
    "flustered": "Speak in a very flustered, embarrassed tone.",
    "proud": "Speak in a very proud, triumphant tone.",
    "flutter": "Speak in a very excited, fluttering tone, full of anticipation.",
    "seductive": "Speak in a very soft, charming tone.",
    "sweet": "Speak in a very sweet, gentle tone.",
    "intimate": "Speak in a very hushed, intimate tone.",
    "bittersweet": "Speak in a very bittersweet, wistful tone.",
    "charming": "Speak in a very charming, warm tone.",
}


def instruct_of(emotion_id):
    """감정 id → 지시. 모르거나 없으면 None(보통으로 읽는다)."""
    if not emotion_id or emotion_id == "default":
        return None
    return QWEN_EMOTION_INSTRUCTS.get(emotion_id)
