"""
export_songs.py
Scans the Ketron SD90 Remote songs/ library and builds a single compact
songs.json for the web_app PWA.

Each song entry: title, artist, reg_number, bank, mp3_path, duration_ms,
lyrics, lyric_format ("syllable" | "synced-word" | "midi" | null).

lyric_format classification mirrors song_library.py's syllable_mode
detection (avg text length < 8 chars) plus main.py's
_build_display_lines() is_synced_word heuristic:
  - no lyrics            -> null
  - avg len >= 8 chars    -> "midi"        (whole-line entries, word
                                             highlight is interpolated)
  - avg len < 8 chars:
      - trailing-space markers present AND every no-space entry is far
        (>=500ms) from the next entry -> "synced-word" (each entry is a
        complete word)
      - otherwise                     -> "syllable" (sub-word syllables)

Run: python export_songs.py
"""

import os
import json

SONGS_ROOT = r"C:\Users\mileg\OneDrive\Desktop\Ketron SD90 Remote\songs"
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "songs.json")


def classify_lyric_format(lyrics: list) -> str | None:
    if not lyrics:
        return None

    avg_len = sum(len(item["text"]) for item in lyrics) / len(lyrics)
    if avg_len >= 8:
        return "midi"

    has_space_markers = any(
        item["text"].endswith(" ") or "\n" in item["text"] or "\r" in item["text"]
        for item in lyrics
    )
    if not has_space_markers:
        return "syllable"

    is_synced_word = not any(
        i < len(lyrics) - 1
        and not lyrics[i]["text"].endswith(" ")
        and "\n" not in lyrics[i]["text"]
        and "\r" not in lyrics[i]["text"]
        and (lyrics[i + 1]["time_ms"] - lyrics[i]["time_ms"]) < 500
        for i in range(len(lyrics) - 1)
    )
    return "synced-word" if is_synced_word else "syllable"


def load_song(folder_path: str, folder_name: str) -> dict | None:
    info_path = os.path.join(folder_path, "song_info.json")
    lyrics_path = os.path.join(folder_path, "lyrics.json")

    if not os.path.isfile(info_path):
        return None

    try:
        with open(info_path, "r", encoding="utf-8") as f:
            info = json.load(f)
    except Exception:
        return None

    lyrics = []
    if os.path.isfile(lyrics_path):
        try:
            with open(lyrics_path, "r", encoding="utf-8") as f:
                ldata = json.load(f)
            raw = ldata if isinstance(ldata, list) else ldata.get("lyrics", [])
            for item in raw:
                lyrics.append({
                    "time_ms": int(item.get("time_ms", 0)),
                    "text": item.get("text", ""),
                })
        except Exception:
            lyrics = []

    return {
        "title": info.get("title", folder_name),
        "artist": info.get("artist", "") or "",
        "reg_number": info.get("ketron_registration_number"),
        "bank": info.get("ketron_bank"),
        "mp3_path": info.get("mp3_path", ""),
        "duration_ms": info.get("duration_ms", 0),
        "lyrics": lyrics,
        "lyric_format": classify_lyric_format(lyrics),
    }


def main():
    if not os.path.isdir(SONGS_ROOT):
        raise SystemExit(f"Songs root not found: {SONGS_ROOT}")

    songs = []
    for entry in sorted(os.scandir(SONGS_ROOT), key=lambda e: e.name.lower()):
        if not entry.is_dir():
            continue
        song = load_song(entry.path, entry.name)
        if song:
            songs.append(song)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(songs, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(OUT_PATH) / 1024
    with_lyrics = sum(1 for s in songs if s["lyrics"])
    print(f"Wrote {len(songs)} songs ({with_lyrics} with lyrics) -> {OUT_PATH} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
