"""Procedural illustrated art (SVG) for the local-service sites.
Everything is original, simple, and clearly illustrative."""
import random, math


def _rng(seed):
    return random.Random(seed)


def _svg(w, h, label, body, defs=""):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" '
            'preserveAspectRatio="xMidYMid slice" role="img" aria-label="%s"><defs>%s</defs>%s</svg>'
            % (w, h, w, h, label, defs, body))


def _grad(id_, stops, vertical=True):
    s = "".join('<stop offset="%.3f" stop-color="%s"/>' % (i / max(1, len(stops) - 1), c) for i, c in enumerate(stops))
    return '<linearGradient id="%s" x1="0" y1="0" x2="%d" y2="%d">%s</linearGradient>' % (id_, 0 if vertical else 1, 1 if vertical else 0, s)


# ---------- glyphs: simple pictograms drawn at 0..100 box ----------
def glyph(name, fg, bg2):
    g = {
        "ant": '<ellipse cx="30" cy="55" rx="12" ry="9"/><ellipse cx="50" cy="55" rx="9" ry="7"/><ellipse cx="70" cy="55" rx="14" ry="10"/>'
               '<path d="M26 48 L14 30 M44 49 L40 28 M52 49 L60 28 M68 62 L82 80 M50 62 L52 82 M32 62 L22 82 M22 50 L8 44" stroke="%s" stroke-width="3.5" fill="none" stroke-linecap="round"/>',
        "mouse": '<ellipse cx="46" cy="58" rx="30" ry="18"/><circle cx="74" cy="46" r="11"/><circle cx="68" cy="36" r="6"/><circle cx="80" cy="36" r="6"/>'
                 '<path d="M16 62 Q0 66 4 82" stroke="%s" stroke-width="3.5" fill="none" stroke-linecap="round"/>',
        "bug": '<ellipse cx="50" cy="56" rx="22" ry="28"/><circle cx="50" cy="24" r="10"/>'
               '<path d="M50 30 L50 84 M28 44 L10 36 M28 58 L8 60 M30 72 L14 86 M72 44 L90 36 M72 58 L92 60 M70 72 L86 86" stroke="%s" stroke-width="3.5" fill="none" stroke-linecap="round"/>',
        "tick": '<circle cx="50" cy="54" r="22"/><circle cx="50" cy="28" r="9"/>'
                '<path d="M30 46 L10 38 M28 56 L6 58 M32 68 L14 82 M70 46 L90 38 M72 56 L94 58 M68 68 L86 82" stroke="%s" stroke-width="3.5" fill="none" stroke-linecap="round"/>',
        "mosquito": '<ellipse cx="46" cy="46" rx="24" ry="9" transform="rotate(-20 46 46)"/><circle cx="68" cy="34" r="7"/>'
                    '<path d="M74 34 L96 28 M34 52 L18 76 M44 54 L36 82 M54 52 L58 80" stroke="%s" stroke-width="3" fill="none" stroke-linecap="round"/>'
                    '<ellipse cx="36" cy="26" rx="18" ry="7" opacity=".6" transform="rotate(-30 36 26)"/>',
        "wood": '<rect x="14" y="30" width="72" height="44" rx="6"/><path d="M20 42 H80 M20 54 H80 M20 66 H80" stroke="%s" stroke-width="3" opacity=".7"/>'
                '<circle cx="64" cy="52" r="5" fill="%s"/>',
        "house": '<path d="M10 52 L50 18 L90 52 L82 52 L82 84 L18 84 L18 52 Z"/><rect x="42" y="58" width="16" height="26" fill="%s"/>',
        "leaf": '<path d="M20 80 C14 40 40 16 84 18 C86 60 60 86 20 80 Z"/><path d="M22 78 L62 40" stroke="%s" stroke-width="3.5" fill="none" stroke-linecap="round"/>',
        "drop": '<path d="M50 12 C70 40 82 52 82 66 A32 32 0 0 1 18 66 C18 52 30 40 50 12 Z"/><path d="M36 66 A14 14 0 0 0 50 80" stroke="%s" stroke-width="4" fill="none" stroke-linecap="round"/>',
        "sun": '<circle cx="50" cy="50" r="18"/><path d="M50 10 V24 M50 76 V90 M10 50 H24 M76 50 H90 M22 22 L32 32 M68 68 L78 78 M78 22 L68 32 M32 68 L22 78" stroke="%s" stroke-width="5" fill="none" stroke-linecap="round"/>',
        "snow": '<path d="M50 10 V90 M15 30 L85 70 M15 70 L85 30" stroke="%s" stroke-width="6" fill="none" stroke-linecap="round"/><circle cx="50" cy="50" r="9"/>',
        "pool": '<rect x="14" y="40" width="72" height="40" rx="8"/><path d="M26 56 Q38 48 50 56 T74 56 M26 68 Q38 60 50 68 T74 68" stroke="%s" stroke-width="4" fill="none" stroke-linecap="round"/>'
                '<path d="M34 40 V22 A8 8 0 0 1 50 22 M58 40 V22 A8 8 0 0 1 74 22" stroke="%s" stroke-width="4" fill="none" stroke-linecap="round"/>',
        "filter": '<rect x="28" y="18" width="44" height="64" rx="10"/><path d="M36 34 H64 M36 46 H64 M36 58 H64 M36 70 H64" stroke="%s" stroke-width="4" opacity=".8"/>',
        "flask": '<path d="M40 14 H60 M44 14 V40 L22 80 A8 8 0 0 0 29 90 H71 A8 8 0 0 0 78 80 L56 40 V14"  stroke="%s" stroke-width="5" fill="none" stroke-linejoin="round"/><path d="M32 70 H68 L74 80 H26 Z"/>',
        "wrench": '<path d="M70 14 A20 20 0 0 0 52 40 L16 76 A8 8 0 0 0 28 88 L64 52 A20 20 0 0 0 86 30 L72 40 L62 30 L70 14Z"/>',
        "bolt": '<path d="M56 8 L24 54 H46 L40 92 L76 44 H54 Z"/>',
        "wind": '<path d="M10 36 H64 A10 10 0 1 0 54 26 M10 54 H80 A10 10 0 1 1 70 64 M10 72 H50 A9 9 0 1 1 41 81" stroke="%s" stroke-width="6" fill="none" stroke-linecap="round"/>',
        "bike": '<circle cx="24" cy="66" r="16" stroke="%s" stroke-width="5" fill="none"/><circle cx="76" cy="66" r="16" stroke="%s" stroke-width="5" fill="none"/><path d="M24 66 L42 34 H66 L76 66 M42 34 L52 66 H24 M62 28 H74" stroke="%s" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
        "shield": '<path d="M50 10 L84 22 V50 C84 70 70 84 50 92 C30 84 16 70 16 50 V22 Z"/><path d="M34 50 L46 62 L68 38" stroke="%s" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
        "scale": '<path d="M50 14 V82 M30 82 H70 M20 30 H80" stroke="%s" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M20 30 L8 56 H32 Z M80 30 L68 56 H92 Z"/>',
        "car": '<path d="M10 62 L18 40 H72 L86 58 H94 V74 H10 Z"/><circle cx="30" cy="76" r="9" fill="%s"/><circle cx="72" cy="76" r="9" fill="%s"/>',
        "spray": '<rect x="34" y="34" width="32" height="54" rx="8"/><path d="M42 34 V20 H62 V30" stroke="%s" stroke-width="5" fill="none"/><path d="M70 22 H88 M70 14 L86 8 M70 30 L86 36" stroke="%s" stroke-width="4" stroke-linecap="round"/>',
        "gauge": '<path d="M12 70 A38 38 0 0 1 88 70" stroke="%s" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M50 70 L68 40" stroke="%s" stroke-width="6" stroke-linecap="round"/><circle cx="50" cy="70" r="7"/>',
        "thermo": '<rect x="42" y="12" width="16" height="52" rx="8"/><circle cx="50" cy="72" r="16"/><path d="M50 22 V68" stroke="%s" stroke-width="5"/>',
        "check": '<circle cx="50" cy="50" r="38"/><path d="M32 52 L45 65 L70 36" stroke="%s" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    }
    body = g.get(name, g["house"])
    n = body.count("%s")
    body = body % tuple([bg2] * n) if n else body
    return '<g fill="%s">%s</g>' % (fg, body)


# ---------- scenes ----------
def hero(theme, pal, seed, label, w=1920, h=1080):
    r = _rng(seed)
    defs = _grad("sky", pal["sky"]) + _grad("gr", pal["ground"]) + _grad("wa", pal["water"])
    body = '<rect width="%d" height="%d" fill="url(#sky)"/>' % (w, h)
    sx, sy = int(w * r.uniform(.68, .82)), int(h * r.uniform(.22, .32))
    body += '<circle cx="%d" cy="%d" r="%d" fill="%s" opacity=".35"/><circle cx="%d" cy="%d" r="%d" fill="%s"/>' % (sx, sy, 230, pal["sun"], sx, sy, 56, pal["sun"])
    # distant hills / skyline
    pts = ["-20,%d" % (h + 20)]
    for i in range(0, 21):
        x = i * (w + 40) / 20 - 20
        y = h * 0.60 + math.sin(i * 0.7 + seed) * 40 + r.uniform(-18, 18)
        pts.append("%.0f,%.0f" % (x, y))
    pts.append("%d,%d" % (w + 20, h + 20))
    body += '<polygon points="%s" fill="%s" opacity=".55"/>' % (" ".join(pts), pal["far"])
    if theme == "pool":
        # palms + stucco house + pool
        for x in (260, 520, 1500, 1720):
            top = h * 0.46 + r.uniform(-30, 30)
            body += '<path d="M%d %d Q%d %d %d %d" stroke="%s" stroke-width="14" fill="none" stroke-linecap="round"/>' % (x, h * 0.78, x + 18, h * 0.62, x + 8, top, pal["trunk"])
            for a in range(-70, 90, 32):
                ex = x + 8 + math.cos(math.radians(a - 90)) * 150
                ey = top + math.sin(math.radians(a - 90)) * 70 + 40
                body += '<path d="M%d %d Q%d %d %.0f %.0f" stroke="%s" stroke-width="12" fill="none" stroke-linecap="round"/>' % (x + 8, top, x + 8 + (ex - x) * .5, top - 50, ex, ey, pal["leaf"])
        body += '<rect x="700" y="%d" width="520" height="230" fill="%s"/><rect x="680" y="%d" width="560" height="26" fill="%s"/>' % (h * 0.52, pal["house"], h * 0.52 - 22, pal["roof"])
        body += '<rect x="760" y="%d" width="90" height="120" fill="%s"/><rect x="1060" y="%d" width="120" height="120" fill="%s"/>' % (h * 0.52 + 60, pal["glass"], h * 0.52 + 60, pal["glass"])
        body += '<rect x="0" y="%d" width="%d" height="%d" fill="url(#gr)"/>' % (h * 0.76, w, h)
        body += '<path d="M360 %d H1560 L1680 %d H240 Z" fill="%s"/>' % (h * 0.80, h * 0.97, pal["deck"])
        body += '<path d="M400 %d H1520 L1620 %d H300 Z" fill="url(#wa)"/>' % (h * 0.83, h * 0.95)
        for i in range(7):
            yy = h * (0.845 + i * 0.015)
            body += '<path d="M%d %.0f q60 -14 120 0 t120 0 t120 0 t120 0 t120 0 t120 0 t120 0 t120 0" stroke="#fff" stroke-opacity=".28" stroke-width="3" fill="none"/>' % (360 + i * 18, yy)
    elif theme == "wood":
        # houses with pitched roofs, trees, lawn
        x = 120
        while x < w:
            hw = r.randint(280, 380)
            hh = r.randint(150, 210)
            base = h * 0.76
            col = r.choice(pal["houses"])
            body += '<rect x="%d" y="%.0f" width="%d" height="%d" fill="%s"/>' % (x, base - hh, hw, hh, col)
            body += '<path d="M%d %.0f L%d %.0f L%d %.0f Z" fill="%s"/>' % (x - 24, base - hh, x + hw / 2, base - hh - 120, x + hw + 24, base - hh, pal["roof"])
            for wx in (x + 50, x + hw - 110):
                body += '<rect x="%d" y="%.0f" width="60" height="64" fill="%s"/>' % (wx, base - hh + 36, pal["glass"])
            body += '<rect x="%d" y="%.0f" width="50" height="86" fill="%s"/>' % (x + hw / 2 - 25, base - 86, pal["door"])
            x += hw + r.randint(90, 160)
        for tx in range(60, w, 210):
            ty = h * 0.76
            th = r.randint(120, 200)
            body += '<rect x="%d" y="%.0f" width="14" height="%d" fill="%s"/><circle cx="%d" cy="%.0f" r="%d" fill="%s"/>' % (tx, ty - th * .45, th * .5, pal["trunk"], tx + 7, ty - th * .55, th * .42, pal["leaf"])
        body += '<rect x="0" y="%d" width="%d" height="%d" fill="url(#gr)"/>' % (h * 0.76, w, h)
        body += '<path d="M%d %d C%d %d %d %d %d %d" stroke="%s" stroke-width="46" fill="none" opacity=".55"/>' % (w * .46, h, w * .5, h * .9, w * .56, h * .84, w * .62, h * .77, pal["path"])
    else:  # "industrial": bay doors, skyline, warm light
        x = 80
        while x < w:
            bw = r.randint(160, 260)
            bh = r.randint(220, 420)
            body += '<rect x="%d" y="%.0f" width="%d" height="%d" fill="%s"/>' % (x, h * 0.74 - bh, bw, bh, pal["houses"][0] if r.random() < .5 else pal["houses"][-1])
            for yy in range(int(h * 0.74 - bh + 26), int(h * 0.74 - 30), 46):
                for xx in range(x + 22, x + bw - 30, 44):
                    if r.random() < .55:
                        body += '<rect x="%d" y="%d" width="22" height="22" fill="%s" opacity=".85"/>' % (xx, yy, pal["glass"])
            x += bw + r.randint(14, 50)
        body += '<rect x="0" y="%d" width="%d" height="%d" fill="url(#gr)"/>' % (h * 0.74, w, h)
        for i in range(4):
            body += '<rect x="%d" y="%d" width="300" height="190" fill="%s"/>' % (230 + i * 400, h * 0.74 + 40, pal["door"])
    return _svg(w, h, label, body, defs)


def card(glyph_name, pal, seed, label, w=800, h=600):
    r = _rng(seed)
    defs = _grad("c", pal["card"])
    body = '<rect width="%d" height="%d" fill="url(#c)"/>' % (w, h)
    for i in range(7):
        body += '<circle cx="%d" cy="%d" r="%d" fill="#fff" opacity="%.2f"/>' % (r.randint(0, w), r.randint(0, h), r.randint(40, 190), r.uniform(.03, .08))
    body += '<g transform="translate(%d %d) scale(%.2f)">%s</g>' % (w * .5 - 190, h * .5 - 190, 3.8, glyph(glyph_name, pal["glyph"], pal["card"][0]))
    return _svg(w, h, label, body, defs)


def header(theme, pal, seed, label, w=1600, h=500):
    return hero(theme, pal, seed, label, w, h)


def logo(glyph_name, pal):
    return ('<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="12" fill="%s"/>'
            '<g transform="translate(10 8) scale(.44)">%s</g><rect y="56" width="64" height="8" fill="%s"/><rect y="60" width="64" height="4" fill="%s"/></svg>'
            % (pal["logo_bg"], glyph(glyph_name, pal["logo_fg"], pal["logo_bg"]), pal["s1"], pal["s3"]))
