#!/usr/bin/env python3
"""Generate Catsnip extension icons — a bold cat face inside crop-region brackets
(no external deps).

The mark fuses the two ideas the brand needs to convey:
  * CAT  — a bold, head-on white cat face (ears, eyes, pink nose, whiskers).
  * SNIP — four white corner brackets, the universal "select a region" /
           screenshot motif, framing the cat.

It is size-adaptive. At toolbar size (16px) the crop brackets + whiskers would
smear the tiny tile into a blob, so they are dropped and the cat face is drawn
bolder and edge-to-edge — the strongest, cleanest cat cue. At 32/48/128px there
is room for the full composition, so the brackets and whiskers come back and the
face tucks in to give them corner space. make() supersamples for smooth edges."""
import struct, zlib, os

BLUE    = (37, 99, 235)    # #2563EB  background top (royal blue)
BLUE_DK = (30, 64, 175)    # #1E40AF  background bottom + eye holes
WHITE   = (255, 255, 255)  # cat face + crop brackets
PINK    = (249, 168, 212)  # #F9A8D4  tiny nose accent


def rounded(x, y, n, r):
    """Inside a rounded square of side n, corner radius r?"""
    if x < r and y < r:                 return (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x > n - 1 - r and y < r:         return (x - (n - 1 - r)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y > n - 1 - r:         return (x - r) ** 2 + (y - (n - 1 - r)) ** 2 <= r * r
    if x > n - 1 - r and y > n - 1 - r: return (x - (n - 1 - r)) ** 2 + (y - (n - 1 - r)) ** 2 <= r * r
    return True


def _point_in_tri(px, py, ax, ay, bx, by, cx, cy):
    """Is point (px,py) inside triangle a,b,c (via barycentric sign test)?"""
    d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def snip_pixel(nx, ny, tiny=False):
    """Return (r,g,b) for normalized coords (0–1), or None for the background.

    `tiny` (set by make() for 16px) drops the crop brackets + whiskers and uses
    a bolder, edge-to-edge cat face so the toolbar icon stays crisp."""

    # --- Snip identity: four corner crop brackets (select-region motif). ---
    # Drawn only when there is room (not on the 16px toolbar render).
    if not tiny:
        arm, th = 0.14, 0.05
        for ox, sx in ((0.15, 1.0), (0.85, -1.0)):
            for oy, sy in ((0.15, 1.0), (0.85, -1.0)):
                hx0, hx1 = sorted((ox, ox + sx * arm))   # horizontal arm
                hy0, hy1 = sorted((oy, oy + sy * th))
                if hx0 <= nx <= hx1 and hy0 <= ny <= hy1:
                    return WHITE
                vx0, vx1 = sorted((ox, ox + sx * th))    # vertical arm
                vy0, vy1 = sorted((oy, oy + sy * arm))
                if vx0 <= nx <= vx1 and vy0 <= ny <= vy1:
                    return WHITE

    # --- Cat face geometry (bolder & cornerless when tiny). ---
    if tiny:
        ear_l = (0.155, 0.05, 0.40, 0.46, 0.13, 0.46)
        ear_r = (0.845, 0.05, 0.87, 0.46, 0.60, 0.46)
        hx, hy, rx, ry = 0.5, 0.60, 0.315, 0.315
        eyes, erx, ery = ((0.37, 0.555), (0.63, 0.555)), 0.082, 0.105
        nose = (0.45, 0.69, 0.55, 0.69, 0.5, 0.755)
    else:
        ear_l = (0.31, 0.12, 0.50, 0.47, 0.28, 0.47)
        ear_r = (0.69, 0.12, 0.72, 0.47, 0.50, 0.47)
        hx, hy, rx, ry = 0.5, 0.62, 0.275, 0.265
        eyes, erx, ery = ((0.41, 0.61), (0.59, 0.61)), 0.062, 0.082
        nose = (0.455, 0.695, 0.545, 0.695, 0.5, 0.76)

    # Ears: two upright triangles.
    if _point_in_tri(nx, ny, *ear_l) or _point_in_tri(nx, ny, *ear_r):
        return WHITE

    # Head: a rounded ellipse carrying the eyes + nose.
    dx, dy = (nx - hx) / rx, (ny - hy) / ry
    if dx * dx + dy * dy <= 1.0:
        for ex, ey in eyes:
            edx, edy = (nx - ex) / erx, (ny - ey) / ery
            if edx * edx + edy * edy <= 1.0:
                return BLUE_DK  # eye = background-dark, reads as a hole
        if _point_in_tri(nx, ny, *nose):
            return PINK
        return WHITE

    # Whiskers (larger sizes only): short strokes off the cheeks, kept clear of
    # the corner brackets above and below.
    if not tiny:
        wt = 0.022
        for wy in (0.625, 0.69):
            if 0.05 <= nx <= 0.225 and abs(ny - wy) <= wt:
                return WHITE
            if 0.775 <= nx <= 0.95 and abs(ny - wy) <= wt:
                return WHITE

    return None


def make(n):
    r = n * 0.22
    tiny = n <= 20                 # 16px: bold cornerless face, no brackets
    ss = 4 if n <= 48 else 2       # more sub-pixels at tiny sizes for smooth edges
    inv = 1.0 / (ss * ss)
    buf = bytearray()
    for y in range(n):
        buf.append(0)  # PNG row filter
        for x in range(n):
            if not rounded(x, y, n, r):
                buf += bytes((0, 0, 0, 0))
                continue
            t = y / max(1, n - 1)
            bg = tuple(int(BLUE[i] + (BLUE_DK[i] - BLUE[i]) * t) for i in range(3))
            # Average several sub-pixel samples of the motif over the gradient.
            ar = ag = ab = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    nxp = (x + (sx + 0.5) / ss) / n
                    nyp = (y + (sy + 0.5) / ss) / n
                    px = snip_pixel(nxp, nyp, tiny) or bg
                    ar += px[0]; ag += px[1]; ab += px[2]
            buf += bytes((int(ar * inv + 0.5), int(ag * inv + 0.5), int(ab * inv + 0.5), 255))
    return png(n, n, bytes(buf))


def png(w, h, raw):
    def chunk(typ, data):
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


here = os.path.dirname(os.path.abspath(__file__))
for size in (16, 32, 48, 128):
    with open(os.path.join(here, f"icon{size}.png"), "wb") as f:
        f.write(make(size))
    print(f"wrote icon{size}.png")
