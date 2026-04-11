#!/usr/bin/env python3
"""AudioForge - Audio source separation entry point.

Modes: music, conversation, transcribe, split, track-process, meta-fix
Communication via JSON lines on stdout.
"""

import argparse
import json
import os
import sys
import subprocess

# Ensure sibling modules are importable regardless of cwd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audio_utils import (emit, load_audio, save_audio, find_ffmpeg,
                         convert_to_wav, trim_silence, fmt_time, fmt_srt_time)


def main():
    parser = argparse.ArgumentParser(description="AudioForge separator")
    parser.add_argument("--mode", choices=["music", "conversation", "transcribe", "split", "track-process", "meta-fix"], required=True)
    parser.add_argument("--input", required=True, help="Input audio file path")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--model", default="htdemucs", help="Demucs model name")
    parser.add_argument("--trim-silence", action="store_true")
    parser.add_argument("--silence-gap", type=float, default=0.0)
    parser.add_argument("--transcribe", action="store_true")
    parser.add_argument("--output-format", default="wav", choices=["wav", "mp3", "flac"])
    parser.add_argument("--whisper-model", default="large-v3")
    parser.add_argument("--translate", action="store_true")
    parser.add_argument("--srt", action="store_true")
    parser.add_argument("--split-points", default="")
    parser.add_argument("--split-labels", default="")
    parser.add_argument("--n-speakers", type=int, default=2, help="Number of speakers (conversation mode)")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    try:
        # ── Meta fix mode ──
        if args.mode == "meta-fix":
            _run_meta_fix(args)
            return

        # ── Track split mode ──
        if args.mode == "split":
            _run_split(args)
            return

        # ── Track process (individual) ──
        if args.mode == "track-process":
            _run_track_process(args)
            return

        # ── Transcribe-only mode ──
        if args.mode == "transcribe":
            _run_transcribe_only(args)
            return

        # ── Separation modes (music / conversation) ──
        tracks = []
        if args.mode == "music":
            from music_worker import run_music_separation
            tracks = run_music_separation(args.input, args.output, args.model) or []
        elif args.mode == "conversation":
            from conversation_worker import run_conversation_separation
            tracks = run_conversation_separation(args.input, args.output, args.n_speakers) or []

        if not tracks:
            emit("error", message="분리 결과가 없습니다.")
            sys.exit(1)

        # Post-processing
        _post_process(args, tracks)

    except Exception as e:
        emit("error", message=str(e))
        sys.exit(1)


def _post_process(args, tracks):
    """Trim silence, transcribe, translate, convert format."""
    # Trim silence
    if args.trim_silence:
        import torch
        emit("progress", percent=91, message="무음 구간 제거 중...")
        for t in tracks:
            wav, sr = load_audio(t["path"])
            trimmed = trim_silence(wav, sr, silence_gap_sec=args.silence_gap)
            trimmed_path = t["path"].replace(".wav", "_trimmed.wav")
            save_audio(trimmed_path, trimmed, sr)
            t["trimmed_path"] = trimmed_path
            emit("progress", percent=93, message=f"{t['label']} 무음 제거 완료")

    # Whisper transcription
    if args.transcribe:
        from transcribe_worker import transcribe_tracks
        transcribe_tracks(tracks, args.output, args.whisper_model, args.translate, args.srt)

    # Convert output format
    if args.output_format != "wav":
        ffmpeg = find_ffmpeg()
        if ffmpeg:
            emit("progress", percent=98, message=f"{args.output_format.upper()} 변환 중...")
            codec = {"mp3": ["-codec:a", "libmp3lame", "-q:a", "2"], "flac": ["-codec:a", "flac"]}
            for t in tracks:
                src = t["path"]
                if not src.endswith(".wav"):
                    continue
                dst = src.replace(".wav", f".{args.output_format}")
                cmd = [ffmpeg, "-y", "-i", src, *codec.get(args.output_format, []), dst]
                subprocess.run(cmd, capture_output=True)
                if os.path.exists(dst):
                    t["path"] = dst

    emit("progress", percent=99, message="완료!")
    emit("result", tracks=tracks, outputDir=args.output)


def _run_transcribe_only(args):
    """Transcribe-only mode."""
    emit("status", message="텍스트 추출 모드", percent=0)
    from transcribe_worker import transcribe_file, translate_to_korean

    emit("progress", percent=5, message="오디오 변환 중...")
    wav_path = convert_to_wav(args.input)
    try:
        info = transcribe_file(wav_path, args.output, args.whisper_model, args.translate, args.srt)
    finally:
        try:
            os.remove(wav_path)
            os.rmdir(os.path.dirname(wav_path))
        except OSError:
            pass

    tracks = [{
        "name": "transcript",
        "label": f"텍스트 ({info['language']})",
        "path": info["txt_path"],
        "text": info["text"],
        "language": info["language"],
        "txt_path": info["txt_path"]
    }]
    if info.get("translated_text"):
        base = os.path.splitext(os.path.basename(args.input))[0]
        tracks.append({
            "name": "translation",
            "label": "한국어 번역",
            "path": os.path.join(args.output, f"{base}_korean.txt"),
            "text": info["translated_text"],
            "language": "ko"
        })

    emit("progress", percent=99, message="완료!")
    emit("result", tracks=tracks, outputDir=args.output)


def _run_track_process(args):
    """Process individual track (transcribe/translate)."""
    emit("status", message="트랙 개별 처리", percent=0)
    import whisper
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    base = os.path.splitext(os.path.basename(args.input))[0]
    text = None
    language = None

    if args.transcribe:
        emit("progress", percent=10, message="Whisper 모델 로딩 중...")
        w_model = whisper.load_model(args.whisper_model, device=device)
        emit("progress", percent=30, message="텍스트 추출 중...")

        result = w_model.transcribe(args.input, language=None, task="transcribe", verbose=False)
        text = result["text"].strip()
        language = result.get("language", "unknown")

        txt_path = os.path.join(args.output, f"{base}.txt")
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(text)

        if args.srt:
            srt_path = os.path.join(args.output, f"{base}.srt")
            with open(srt_path, "w", encoding="utf-8") as f:
                for si, seg in enumerate(result["segments"], 1):
                    f.write(f"{si}\n{fmt_srt_time(seg['start'])} --> {fmt_srt_time(seg['end'])}\n{seg['text'].strip()}\n\n")

        emit("progress", percent=60, message=f"언어 감지: {language}")
    else:
        txt_path = os.path.join(args.output, f"{base}.txt")
        if os.path.exists(txt_path):
            with open(txt_path, "r", encoding="utf-8") as f:
                text = f.read().strip()

    translated = None
    if args.translate and text:
        if not language:
            emit("progress", percent=65, message="언어 감지 중...")
            w_model = whisper.load_model("base", device=device)
            audio = whisper.load_audio(args.input)
            audio = whisper.pad_or_trim(audio)
            mel = whisper.log_mel_spectrogram(audio).to(device)
            _, probs = w_model.detect_language(mel)
            language = max(probs, key=probs.get)

        if language != "ko":
            from transcribe_worker import translate_to_korean
            emit("progress", percent=70, message=f"{language}→한국어 번역 중...")
            translated = translate_to_korean(text, language)
            if translated:
                kr_path = os.path.join(args.output, f"{base}_korean.txt")
                with open(kr_path, "w", encoding="utf-8") as f:
                    f.write(translated)

    track = {"name": base, "label": base, "path": args.input, "text": text or "", "language": language or "unknown"}
    if translated:
        track["translated_text"] = translated

    emit("progress", percent=99, message="완료!")
    emit("result", tracks=[track], outputDir=args.output)


def _run_split(args):
    """Track split mode. Uses ffmpeg direct extraction when timestamps provided."""
    emit("status", message="트랙 분할 모드", percent=0)

    from datetime import datetime
    import shutil

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        emit("error", message="ffmpeg을 찾을 수 없습니다.")
        return

    split_seconds = []
    split_labels_list = []

    if args.split_points:
        split_seconds = [float(x) for x in args.split_points.split(',') if x.strip()]
        if args.split_labels:
            split_labels_list = args.split_labels.split('|')

    # If timestamps provided, use fast ffmpeg direct extraction (no WAV conversion needed)
    if split_seconds:
        emit("progress", percent=5, message=f"타임스탬프 {len(split_seconds)}개 지점으로 분할")

        # Copy input to temp ASCII path for ffmpeg compatibility
        import tempfile
        tmp_dir = tempfile.mkdtemp(prefix="audioforge_")
        ext = os.path.splitext(args.input)[1]
        tmp_input = os.path.join(tmp_dir, f"source{ext}")
        shutil.copy2(args.input, tmp_input)

        try:
            # Get total duration via ffprobe
            from audio_utils import find_ffmpeg as _ff
            ffprobe = os.path.join(os.path.dirname(ffmpeg), "ffprobe" + os.path.splitext(ffmpeg)[1])
            probe_cmd = [ffprobe, "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", tmp_input]
            probe_result = subprocess.run(probe_cmd, capture_output=True, text=True)
            total_dur = float(probe_result.stdout.strip()) if probe_result.returncode == 0 else 0

            # Build time boundaries
            boundaries = [0.0] + split_seconds + ([total_dur] if total_dur > 0 else [])

            tracks = []
            total_tracks = len(boundaries) - 1
            source_name = os.path.splitext(os.path.basename(args.input))[0]

            for idx in range(total_tracks):
                pct = 10 + int((idx / max(total_tracks, 1)) * 75)
                start_sec = boundaries[idx]
                end_sec = boundaries[idx + 1] if idx + 1 < len(boundaries) else None

                label = split_labels_list[idx].strip() if idx < len(split_labels_list) and split_labels_list[idx].strip() else f"Track {idx + 1:02d}"
                safe_label = "".join(c for c in label if c not in r'\/:*?"<>|').strip()
                name = f"{idx + 1:02d}_{safe_label}" if safe_label else f"track_{idx + 1:02d}"

                emit("progress", percent=pct, message=f"{label} 추출 중...")

                out_path = os.path.join(args.output, f"{name}.wav")
                cmd = [ffmpeg, "-y", "-i", tmp_input, "-ss", str(start_sec)]
                if end_sec is not None:
                    cmd.extend(["-to", str(end_sec)])
                cmd.extend(["-acodec", "pcm_s16le", "-metadata", f"title={label}",
                            "-metadata", f"track={idx+1}/{total_tracks}",
                            "-metadata", f"album={source_name}", out_path])
                subprocess.run(cmd, capture_output=True)

                dur = (end_sec - start_sec) if end_sec else 0
                meta = {
                    "track_number": idx + 1, "title": label,
                    "start_time": round(start_sec, 3),
                    "end_time": round(end_sec, 3) if end_sec else 0,
                    "duration": round(dur, 3),
                    "source_file": os.path.basename(args.input),
                    "source_path": args.input,
                    "split_date": datetime.now().isoformat(),
                    "output_file": f"{name}.wav"
                }
                meta_path = os.path.join(args.output, f"{name}.json")
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump(meta, f, ensure_ascii=False, indent=2)

                tracks.append({"name": name, "label": f"{label} ({fmt_time(dur)})", "path": out_path, "meta_path": meta_path})

            # Save tracklist
            _save_tracklist(tracks, args.output)

            emit("progress", percent=90, message="분할 완료!")
            emit("result", tracks=tracks, outputDir=args.output)
        finally:
            try:
                os.remove(tmp_input)
                os.rmdir(tmp_dir)
            except OSError:
                pass
        return

    # Auto-detect mode: use ffmpeg silencedetect (no WAV conversion needed)
    emit("progress", percent=5, message="ffmpeg 무음 구간 자동 감지 중...")

    import tempfile, shutil, re
    tmp_dir = tempfile.mkdtemp(prefix="audioforge_")
    ext = os.path.splitext(args.input)[1]
    tmp_input = os.path.join(tmp_dir, f"input{ext}")
    shutil.copy2(args.input, tmp_input)

    try:
        # Get total duration
        ffprobe = os.path.join(os.path.dirname(ffmpeg), "ffprobe" + os.path.splitext(ffmpeg)[1])
        probe_cmd = [ffprobe, "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", tmp_input]
        probe_result = subprocess.run(probe_cmd, capture_output=True, text=True)
        total_dur = float(probe_result.stdout.strip()) if probe_result.returncode == 0 else 0

        # Run silencedetect filter
        cmd = [ffmpeg, "-i", tmp_input, "-af", "silencedetect=noise=-35dB:d=1.5", "-f", "null", "-"]
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        stderr = result.stderr

        # Parse silence_end timestamps
        # Format: [silencedetect @ ...] silence_end: 184.523 | silence_duration: 2.145
        silence_ends = []
        for match in re.finditer(r'silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)', stderr):
            end_time = float(match.group(1))
            dur = float(match.group(2))
            # Split point = middle of silence
            mid = end_time - dur / 2
            if mid > 1.0:  # Skip if too close to start
                silence_ends.append(mid)

        emit("progress", percent=20, message=f"{len(silence_ends)}개 무음 구간 감지")

        # Filter: minimum 10 seconds between splits
        filtered = []
        for t in silence_ends:
            if not filtered or (t - filtered[-1]) > 10:
                filtered.append(t)

        split_seconds = filtered
        emit("progress", percent=25, message=f"{len(split_seconds)}개 분할 지점 확정")

        # Use same fast ffmpeg extraction as timestamp mode
        boundaries = [0.0] + split_seconds + ([total_dur] if total_dur > 0 else [])
        tracks = []
        total_tracks = len(boundaries) - 1
        source_name = os.path.splitext(os.path.basename(args.input))[0]

        for idx in range(total_tracks):
            pct = 25 + int((idx / max(total_tracks, 1)) * 60)
            start_sec = boundaries[idx]
            end_sec = boundaries[idx + 1] if idx + 1 < len(boundaries) else None

            label = f"Track {idx + 1:02d}"
            name = f"track_{idx + 1:02d}"

            emit("progress", percent=pct, message=f"{label} 추출 중...")

            out_path = os.path.join(args.output, f"{name}.wav")
            cmd = [ffmpeg, "-y", "-i", tmp_input, "-ss", str(start_sec)]
            if end_sec is not None:
                cmd.extend(["-to", str(end_sec)])
            cmd.extend(["-acodec", "pcm_s16le", "-metadata", f"title={label}",
                        "-metadata", f"track={idx+1}/{total_tracks}",
                        "-metadata", f"album={source_name}", out_path])
            subprocess.run(cmd, capture_output=True)

            dur = (end_sec - start_sec) if end_sec else 0
            meta = {
                "track_number": idx + 1, "title": label,
                "start_time": round(start_sec, 3),
                "end_time": round(end_sec, 3) if end_sec else 0,
                "duration": round(dur, 3),
                "source_file": os.path.basename(args.input),
                "source_path": args.input,
                "split_date": datetime.now().isoformat(),
                "output_file": f"{name}.wav"
            }
            meta_path = os.path.join(args.output, f"{name}.json")
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)

            tracks.append({"name": name, "label": f"{label} ({fmt_time(dur)})", "path": out_path, "meta_path": meta_path})

        _save_tracklist(tracks, args.output)

        emit("progress", percent=90, message="분할 완료!")
        emit("result", tracks=tracks, outputDir=args.output)

    finally:
        try:
            os.remove(tmp_input)
            os.rmdir(tmp_dir)
        except OSError:
            pass


def _save_tracklist(tracks, output_dir):
    """Save _tracklist.txt with track numbers and timestamps."""
    ts_path = os.path.join(output_dir, "_tracklist.txt")
    with open(ts_path, "w", encoding="utf-8") as f:
        for t in tracks:
            mp = t.get("meta_path")
            if mp and os.path.exists(mp):
                with open(mp, "r", encoding="utf-8") as mf:
                    m = json.load(mf)
                f.write(f"{m.get('track_number', 0):02d}\t{fmt_time(m.get('start_time', 0))}\t{m.get('title', t['name'])}\n")


def _run_meta_fix(args):
    """Re-apply metadata from edited JSON files."""
    emit("status", message="메타데이터 재적용", percent=0)
    ffmpeg = find_ffmpeg()
    target_dir = args.output

    json_files = sorted([f for f in os.listdir(target_dir) if f.endswith('.json')])
    if not json_files:
        emit("error", message="JSON 메타 파일이 없습니다.")
        sys.exit(1)

    total = len(json_files)
    tracks = []

    for i, jf in enumerate(json_files):
        pct = int((i / total) * 90)
        meta_path = os.path.join(target_dir, jf)
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)

        old_file = meta.get("output_file", "")
        old_path = os.path.join(target_dir, old_file)
        title = meta.get("title", f"Track {i+1}")

        safe_label = "".join(c for c in title if c not in r'\/:*?"<>|').strip()
        new_file = f"{meta.get('track_number', i+1):02d}_{safe_label}.wav" if safe_label else old_file
        new_path = os.path.join(target_dir, new_file)

        if old_path != new_path and os.path.exists(old_path):
            os.rename(old_path, new_path)
            meta["output_file"] = new_file
            emit("progress", percent=pct, message=f"이름 변경: {old_file} → {new_file}")

        if ffmpeg and os.path.exists(new_path):
            tmp = new_path + ".tmp.wav"
            cmd = [ffmpeg, "-y", "-i", new_path, "-metadata", f"title={title}", "-metadata", f"track={meta.get('track_number', i+1)}/{total}", "-codec", "copy", tmp]
            subprocess.run(cmd, capture_output=True)
            if os.path.exists(tmp):
                os.replace(tmp, new_path)

        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        new_json = os.path.splitext(new_file)[0] + ".json"
        new_json_path = os.path.join(target_dir, new_json)
        if meta_path != new_json_path:
            os.rename(meta_path, new_json_path)

        tracks.append({"name": os.path.splitext(new_file)[0], "label": title, "path": new_path})

    emit("progress", percent=99, message="메타데이터 재적용 완료!")
    emit("result", tracks=tracks, outputDir=target_dir)


if __name__ == "__main__":
    main()
