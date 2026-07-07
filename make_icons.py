"""Generate simple PWA icons (dark background, gold 'SD90' text) for the app."""

import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
BG = (26, 26, 46)
ACCENT = (244, 201, 93)

SIZES = [192, 512]


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(img)
    margin = size * 0.08
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=size * 0.18,
        outline=ACCENT,
        width=max(2, int(size * 0.02)),
    )
    text = "SD90"
    font = None
    for fname in ("arialbd.ttf", "segoeuib.ttf", "arial.ttf"):
        try:
            font = ImageFont.truetype(fname, int(size * 0.24))
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1] - size * 0.05), text, fill=ACCENT, font=font)
    note = "♪"
    try:
        nfont = ImageFont.truetype("segoeui.ttf", int(size * 0.16))
    except Exception:
        nfont = font
    bbox2 = draw.textbbox((0, 0), note, font=nfont)
    nw, nh = bbox2[2] - bbox2[0], bbox2[3] - bbox2[1]
    draw.text(((size - nw) / 2 - bbox2[0], size * 0.66 - bbox2[1]), note, fill=(234, 234, 242), font=nfont)
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        img = make_icon(size)
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        img.save(path)
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
