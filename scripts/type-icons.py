"""Leonote's file-type icons for Explorer: a plain page with the kind's colour and a short label.

python scripts/type-icons.py  ->  src-tauri/icons/types/<kind>.ico
The app writes them out and points its own "Open with" entries at them (external.rs).
Small sizes drop the label and keep the colour; the label is drawn from 32 px up.
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons", "types")
FONT = r"C:\Windows\Fonts\segoeuib.ttf"
SYMBOLS = r"C:\Windows\Fonts\seguisym.ttf"  # ♫ and ▶ are not in Segoe UI
# kind: (colour, label)
KINDS = {
    "note": ("#D99A2B", "MD"),
    "text": ("#7D8794", "TXT"),
    "code": ("#7B61D9", "</>"),
    "data": ("#2F9E8F", "{ }"),
    "pdf": ("#D9443A", "PDF"),
    "doc": ("#2F6FD9", "DOC"),
    "sheet": ("#1E9B5A", "XLS"),
    "slides": ("#E0702C", "PPT"),
    "image": ("#2EA36B", "IMG"),
    "audio": ("#9A4FD6", "♫"),
    "video": ("#D63A6F", "▶"),
    "board": ("#2B95C9", "BRD"),
    "sketch": ("#C9408F", "ART"),
    "movie": ("#B0469B", "VID"),
    "archive": ("#8A6A45", "ZIP"),
    "file": ("#7D8794", ""),
}
SIZES = [16, 20, 24, 32, 40, 48, 64, 256]


def rgb(hexs):
    return tuple(int(hexs[i:i + 2], 16) for i in (1, 3, 5))


def page(size, colour, label):
    S = 4  # drawn at 4x and brought down, for smooth edges
    W = size * S
    im = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = rgb(colour)
    # the page: a little narrower than square, its top right corner folded
    l, r = W * 0.17, W * 0.83
    t, b = W * 0.06, W * 0.94
    fold = W * 0.2
    rad = W * 0.07
    edge = max(S, round(W * 0.018))
    paper, line = (248, 248, 246, 255), (0, 0, 0, 70)
    d.rounded_rectangle([l, t, r, b], radius=rad, fill=paper, outline=line, width=edge)
    # the folded corner: cut away, edged, and the flap laid over in the kind's colour
    d.polygon([(r - fold, t - S), (r + S, t - S), (r + S, t + fold)], fill=(0, 0, 0, 0))
    d.line([(r - fold, t + edge / 2), (r - edge / 2, t + fold)], fill=line, width=edge)
    d.polygon([(r - fold, t), (r - fold, t + fold), (r, t + fold)], fill=c + (255,))
    # the label band across the lower page
    bt, bb = W * 0.56, W * 0.82
    bl, br = W * 0.08, W * 0.92
    if size < 32 or not label:
        # small: a plain stripe of the colour says the kind
        d.rounded_rectangle([l + W * 0.09, W * 0.6, r - W * 0.09, W * 0.78], radius=W * 0.04, fill=c + (255,))
    else:
        d.rounded_rectangle([bl, bt, br, bb], radius=W * 0.06, fill=c + (255,))
        fs = (bb - bt) * (0.78 if len(label) <= 2 else 0.66)
        face = SYMBOLS if not label.isascii() else FONT
        font = ImageFont.truetype(face, int(fs))
        box = d.textbbox((0, 0), label, font=font, anchor="lt")
        while box[2] - box[0] > (br - bl) * 0.84:
            fs *= 0.92
            font = ImageFont.truetype(face, int(fs))
            box = d.textbbox((0, 0), label, font=font, anchor="lt")
        d.text(((bl + br) / 2, (bt + bb) / 2), label, font=font, fill=(255, 255, 255, 255), anchor="mm")
        # two quiet lines of "text" above the band: grey on the page, 90% opaque (drawn, not blended, so a
        # see-through colour would punch a hole in the paper)
        for k, y in enumerate((W * 0.3, W * 0.42)):
            d.rounded_rectangle([l + W * 0.1, y, (r - W * 0.1) if k else (r - fold - W * 0.04), y + W * 0.045], radius=W * 0.02, fill=(212, 212, 210, 230))
    return im.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
for kind, (colour, label) in KINDS.items():
    imgs = [page(s, colour, label) for s in SIZES]
    imgs[-1].save(os.path.join(OUT, kind + ".ico"), format="ICO", sizes=[(s, s) for s in SIZES], append_images=imgs[:-1])
    imgs[-1].save(os.path.join(OUT, kind + ".png"))
print("wrote", len(KINDS), "icons to", os.path.normpath(OUT))
