"""MeowMap's icon.

Drawn at 8x and downsampled, which is the whole anti-aliasing strategy — PIL's polygon
and ellipse fills have hard edges and a cat is mostly curves.

WHAT WAS WRONG WITH THE OLD ONE: the ear tips sat ON the top edge while the chin stopped
well short of the bottom, so the face read as squashed against the top of the tile. The
head is now sized and placed from an explicit margin on all four sides, and the ears are
INSIDE it rather than sticking out of the artboard.

It also had no face beyond two eyes and a nose, which at 32px in a tab is a dark blob.
Inner ears, big eyes with catchlights, a muzzle, a mouth and whiskers give it something
to be recognised BY at a small size.
"""
from PIL import Image, ImageDraw

S = 512
K = 8                      # supersample factor
W = S * K

PAPER   = (233, 228, 214)
FUR     = (46, 42, 36)
EAR     = (255, 168, 182)  # --blossom
EYE     = (255, 193, 69)   # --marigold
PUPIL   = (46, 42, 36)
NOSE    = (255, 84, 112)   # --coral
SHINE   = (255, 250, 242)


def draw(bg):
    img = Image.new('RGB', (W, W), bg)
    d = ImageDraw.Draw(img)

    cx = W // 2
    # Ear tips at 12% from the top, chin at 92%: the face is CENTRED in the tile with
    # real margin above the ears, which is the bug being fixed.
    head_top, head_bot = int(W * .28), int(W * .88)
    head_w = int(W * .72)
    hl, hr = cx - head_w // 2, cx + head_w // 2

    def ear(outer_x, tip_x, inner_x, flip):
        tip_y = int(W * .10)
        base_y = int(W * .42)
        d.polygon([(outer_x, base_y), (tip_x, tip_y), (inner_x, base_y)], fill=FUR)
        # The inner ear is the same triangle scaled about its own CENTROID, not shrunk
        # toward the tip — shrinking toward the tip pushed it off to one side and the two
        # ears then looked like they were pointing different ways.
        pts = [(outer_x, base_y), (tip_x, tip_y), (inner_x, base_y)]
        gx = sum(p[0] for p in pts) / 3
        gy = sum(p[1] for p in pts) / 3
        f = .55
        d.polygon([(int(gx + (x - gx) * f), int(gy + (y - gy) * f)) for x, y in pts],
                  fill=EAR)

    ear(int(W * .16), int(W * .25), int(W * .46), False)
    ear(int(W * .84), int(W * .75), int(W * .54), True)

    d.ellipse([hl, head_top, hr, head_bot], fill=FUR)

    # Cheeks: a real cat's face is wider at the whisker line than a circle is.
    cheek_r = int(W * .13)
    for x in (hl + int(W * .07), hr - int(W * .07)):
        d.ellipse([x - cheek_r, int(W * .57), x + cheek_r, int(W * .57) + cheek_r * 2],
                  fill=FUR)

    eye_y = int(W * .53)
    eye_rx, eye_ry = int(W * .085), int(W * .105)
    for ex in (cx - int(W * .155), cx + int(W * .155)):
        d.ellipse([ex - eye_rx, eye_y - eye_ry, ex + eye_rx, eye_y + eye_ry], fill=EYE)
        # A vertical slit pupil is the single most cat-identifying mark there is.
        pr = int(W * .030)
        d.ellipse([ex - pr, eye_y - int(eye_ry * .82), ex + pr, eye_y + int(eye_ry * .82)],
                  fill=PUPIL)
        sr = int(W * .026)
        d.ellipse([ex - int(W * .055) + sr, eye_y - int(W * .058),
                   ex - int(W * .055) + sr * 3, eye_y - int(W * .058) + sr * 2], fill=SHINE)

    # Muzzle: two soft pads under the nose, which is what gives a cat its wide lower face.
    pad_y = int(W * .715)
    pad_r = int(W * .085)
    for px in (cx - int(W * .062), cx + int(W * .062)):
        d.ellipse([px - pad_r, pad_y - pad_r, px + pad_r, pad_y + pad_r], fill=SHINE)

    nose_y = int(W * .655)
    nw, nh = int(W * .050), int(W * .038)
    d.polygon([(cx - nw, nose_y - nh), (cx + nw, nose_y - nh), (cx, nose_y + nh)], fill=NOSE)

    # The mouth: two arcs from under the nose, the classic cat "w".
    lw = int(W * .016)
    d.line([(cx, nose_y + nh), (cx, pad_y - int(W * .035))], fill=FUR, width=lw)
    d.arc([cx - int(W * .125), pad_y - int(W * .105), cx, pad_y + int(W * .012)],
          start=0, end=110, fill=FUR, width=lw)
    d.arc([cx, pad_y - int(W * .105), cx + int(W * .125), pad_y + int(W * .012)],
          start=70, end=180, fill=FUR, width=lw)

    # Whiskers, kept short so they stay inside the tile at every size.
    for side in (-1, 1):
        x0 = cx + side * int(W * .145)
        for dy, dy2 in ((-int(W * .020), -int(W * .046)), (int(W * .012), int(W * .014)),
                        (int(W * .044), int(W * .074))):
            d.line([(x0, pad_y + dy), (x0 + side * int(W * .175), pad_y + dy2)],
                   fill=SHINE, width=int(W * .012))

    return img.resize((S, S), Image.LANCZOS)


face = draw(PAPER)
face.save('icon-512.png')
face.resize((192, 192), Image.LANCZOS).save('icon-192.png')
face.resize((180, 180), Image.LANCZOS).save('apple-touch-icon-180.png')

# Maskable needs the safe zone: Android crops to a circle inscribed in the middle 80%,
# so the whole face is scaled into that and the rest is bled paper.
inner = face.resize((int(S * .78), int(S * .78)), Image.LANCZOS)
mask = Image.new('RGB', (S, S), PAPER)
mask.paste(inner, ((S - inner.width) // 2, (S - inner.height) // 2))
mask.save('icon-512-maskable.png')
print('written')
