#!/usr/bin/env python3
"""Local-service site factory.
Usage: factory.py <site_key> [out_root]
Reads content/<site_key>.py (a dict named SITE) and writes a complete static site to
<out_root>/<site_key>/ (default /home/claude/local-sites). Re-runnable.
"""
import sys, os, json, html, pathlib, shutil, importlib.util, subprocess, datetime

HERE = pathlib.Path(__file__).parent
ASSETS = pathlib.Path("/home/claude/auction-assets")
sys.path.insert(0, str(HERE))
import art

KEY = sys.argv[1]
OUT_ROOT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "/home/claude/local-sites")
spec = importlib.util.spec_from_file_location("content", HERE / "content" / (KEY + ".py"))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
S = mod.SITE
OUT = OUT_ROOT / KEY
for d in ("css", "js", "images/art"):
    (OUT / d).mkdir(parents=True, exist_ok=True)

e = html.escape
NAME, HOST = S["name"], S["host"]
PAL = S["palette"]
NOW = "October 2026"


def a(s):  # attribute-safe
    return e(s, quote=True)


# ------------------------------------------------------------------ art
seed0 = sum(ord(c) for c in KEY)
ART = {}  # path -> svg
ART["hero"] = art.hero(S["theme"], PAL, seed0, S["hero_alt"])
ART["header-guide"] = art.header(S["theme"], PAL, seed0 + 1, S["hero_alt"])
ART["header-timing"] = art.header(S["theme"], PAL, seed0 + 2, S["hero_alt"])
ART["header-hiring"] = art.header(S["theme"], PAL, seed0 + 3, S["hero_alt"])
ART["header-quote"] = art.header(S["theme"], PAL, seed0 + 4, S["hero_alt"])
for i, t in enumerate(S["topics"]):
    ART["card-" + t["id"]] = art.card(t["glyph"], PAL, seed0 + 10 + i, t["title"])
for i, t in enumerate(S["timing"]):
    ART["time-" + t["id"]] = art.card(t["glyph"], PAL, seed0 + 30 + i, t["title"])
ART["card-hiring"] = art.card(S["hiring"]["glyph"], PAL, seed0 + 50, "Hiring checklist")
for k, v in ART.items():
    (OUT / "images" / "art" / (k + ".svg")).write_text(v)
LOGO = art.logo(S["logo_glyph"], PAL)
(OUT / "favicon.svg").write_text(LOGO.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ', 1).replace(' aria-hidden="true"', ''))


PHOTO_DIR = HERE / "photos" / KEY
HAVE = set()


def _find(stem):
    for ext in ("jpg", "jpeg", "png", "webp"):
        f = PHOTO_DIR / (stem + "." + ext)
        if f.exists():
            return f
    return None


def _crop(im, w, h, ax=0.5, ay=0.5):
    """cover-crop to w:h, anchored, then resize"""
    from PIL import Image
    iw, ih = im.size
    sc = max(w / iw, h / ih)
    nw, nh = int(iw * sc + .5), int(ih * sc + .5)
    im2 = im.resize((nw, nh), Image.LANCZOS)
    x = int((nw - w) * ax); y = int((nh - h) * ay)
    return im2.crop((x, y, x + w, y + h))


def _trim_white(im, thr=222, frac=0.5, pad=4):
    """remove near-white gutter lines from the edges of a cell, then a few pixels of safety margin"""
    import numpy as np
    a = np.array(im).astype(int)
    white = a.min(axis=2) > thr
    h, w = white.shape
    t, b, l, r = 0, h, 0, w
    while t < h // 4 and white[t, l:r].mean() > frac: t += 1
    while b > h - h // 4 and white[b - 1, l:r].mean() > frac: b -= 1
    while l < w // 4 and white[t:b, l].mean() > frac: l += 1
    while r > w - w // 4 and white[t:b, r - 1].mean() > frac: r -= 1
    pw, ph = int((r - l) * 0.025) + pad, int((b - t) * 0.025) + pad
    return im.crop((l + pw, t + ph, r - pw, b - ph))


def _cells(path, cols, rows, inset=0.012):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    W, H = im.size
    cw, ch = W / cols, H / rows
    out = []
    for r in range(rows):
        for c in range(cols):
            # take the cell with a little slack on each side so gutters of slightly uneven width are caught, then trim white
            x0, y0 = c * cw, r * ch
            x1, y1 = (c + 1) * cw, (r + 1) * ch
            cell = im.crop((int(x0), int(y0), int(x1), int(y1)))
            out.append(_trim_white(cell))
    return out


def slice_photos():
    """cards sheet 3x3 -> 6 topics, hiring, 2 spare (headers); seasons sheet 2x2 -> 4 timing; hero single."""
    imgs = OUT / "images"
    n = len(S["topics"])
    f = _find("cards")
    spare = []
    if f:
        cells = _cells(f, 3, 3)
        for i, t in enumerate(S["topics"][:6]):
            _crop(cells[i], 800, 600).save(imgs / ("card-%s.jpg" % t["id"]), quality=84, optimize=True); HAVE.add("card-" + t["id"])
        _crop(cells[6], 800, 600).save(imgs / "card-hiring.jpg", quality=84, optimize=True); HAVE.add("card-hiring")
        _crop(cells[7], 1600, 500, .5, .55).save(imgs / "header-hiring.jpg", quality=82, optimize=True); HAVE.add("header-hiring")
        _crop(cells[8], 1600, 500, .5, .55).save(imgs / "header-quote.jpg", quality=82, optimize=True); HAVE.add("header-quote")
        spare = cells
    f = _find("seasons")
    if f:
        cells = _cells(f, 2, 2)
        for i, t in enumerate(S["timing"][:4]):
            _crop(cells[i], 800, 600).save(imgs / ("time-%s.jpg" % t["id"]), quality=84, optimize=True); HAVE.add("time-" + t["id"])
        _crop(cells[0], 1600, 500, .5, .5).save(imgs / "header-timing.jpg", quality=82, optimize=True); HAVE.add("header-timing")
    f = _find("hero")
    if f:
        from PIL import Image
        im = Image.open(f).convert("RGB")
        _crop(im, 1920, 1080).save(imgs / "hero.jpg", quality=82, optimize=True); HAVE.add("hero")
        _crop(im, 1600, 500, .5, .6).save(imgs / "header-guide.jpg", quality=82, optimize=True); HAVE.add("header-guide")
        for nm, w, h in (("og-photo", 1200, 630),):
            _crop(im, w, h).save(imgs / (nm + ".jpg"), quality=84)


slice_photos()


def img(name, alt, w, h, eager=False):
    extra = 'fetchpriority="high"' if eager else 'loading="lazy" decoding="async"'
    if name in HAVE:
        return '<img src="images/%s.jpg" data-fallback="images/art/%s.svg" alt="%s" width="%d" height="%d" %s>' % (name, name, a(alt), w, h, extra)
    return '<img src="images/art/%s.svg" alt="%s" width="%d" height="%d" %s>' % (name, a(alt), w, h, extra)


# ------------------------------------------------------------------ chrome
NAV = [("Home", "index.html")] + S["nav"] + []
CTA_LABEL = S["cta_label"]


def head(title, desc, path, extra_head="", robots=None):
    canon = "https://%s/%s" % (HOST, "" if path == "index.html" else path)
    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">%s
<title>%s</title>
<meta name="description" content="%s">
<link rel="canonical" href="%s">
<meta property="og:type" content="website">
<meta property="og:site_name" content="%s">
<meta property="og:title" content="%s">
<meta property="og:description" content="%s">
<meta property="og:url" content="%s">
<meta property="og:image" content="https://%s/images/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="%s">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400..700&family=Young+Serif&display=swap">
<link rel="stylesheet" href="css/style.css">
<script src="js/config.js"></script>
<script src="js/main.js" defer></script>
%s</head>
""" % ("\n<meta name=\"robots\" content=\"%s\">" % robots if robots else "", a(title), a(desc), canon, a(NAME), a(title), a(desc), canon, HOST, PAL["night"], extra_head)


def header(current):
    links = ""
    for label, href in NAV:
        links += '<a href="%s"%s>%s</a>' % (href, ' aria-current="page"' if href == current else "", e(label))
    links += '<a class="btn" href="quote.html"%s>%s</a>' % (' aria-current="page"' if current == "quote.html" else "", e(CTA_LABEL))
    return """<body>
<a class="skip" href="#main">Skip to content</a>
<div class="notice"><div class="wrap">%s</div></div>
<header class="site-header">
<div class="wrap">
<a class="brand" href="index.html">%s<span><span class="brand-name">%s</span><span class="brand-sub">%s</span></span></a>
<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
<nav class="nav" id="site-nav" aria-label="Main">%s</nav>
</div>
</header>
<main id="main">
""" % (S["notice_html"], LOGO, e(NAME), e(S["brand_sub"]), links)


def footer():
    explore = "".join('<li><a href="%s">%s</a></li>' % (h, e(l)) for l, h in NAV[1:]) + '<li><a href="quote.html">%s</a></li>' % e(CTA_LABEL)
    official = "".join('<li><a href="%s" rel="noopener">%s</a></li>' % (h, e(l)) for l, h in S["official"])
    return """</main>
<div class="strata strata--static" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<footer class="site-footer">
<div class="wrap">
<div>
<h2>About this site</h2>
<p>%s</p>
</div>
<div>
<h2>Explore</h2>
<ul>
%s
</ul>
</div>
<div>
<h2>Good sources</h2>
<ul>
%s
<li><a href="about.html">About this guide</a></li>
<li><a href="privacy.html">Privacy policy</a></li>
</ul>
</div>
</div>
<div class="legal"><div class="wrap">
<p>%s</p>
<p>&copy; <span id="year">2026</span> %s</p>
</div></div>
</footer>
</body>
</html>
""" % (S["footer_about_html"], explore, official, S["legal_html"].replace("{NOW}", NOW), e(NAME))


def page_head(h1, lead, header_art, alt):
    return """<section class="page-head">
%s
<div class="wrap">
<h1>%s</h1>
<p>%s</p>
</div>
</section>
<div class="strata" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
""" % (img(header_art, alt, 1600, 500, True), e(h1), e(lead))


def write(name, text):
    (OUT / name).write_text(text)


# ------------------------------------------------------------------ index
def faq_ld():
    return json.dumps({"@context": "https://schema.org", "@graph": [
        {"@type": "WebSite", "name": NAME, "url": "https://%s/" % HOST},
        {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": ans}} for q, ans in S["faq"]]}]})


def index():
    h = head(S["title"], S["description"], "index.html", '<script type="application/ld+json">%s</script>\n' % faq_ld())
    h += header("index.html")
    hp = "".join("<li>%s</li>" % x for x in S["hero_panel"]["items"])
    facts = "".join("<div><dt>%s</dt><dd>%s</dd></div>" % (e(k), e(v)) for k, v in S["facts"])
    rules = "".join('<div class="rule"><h3>%s</h3><p>%s</p></div>' % (e(t), e(p)) for t, p in S["rules"])
    cards = ""
    for t in S["topics"]:
        cards += ('<article class="card">%s<div class="card-body"><h3><a href="guide.html#%s">%s</a></h3><p>%s</p></div></article>\n'
                  % (img("card-" + t["id"], t["title"], 800, 600), t["id"], e(t["title"]), e(t["blurb"])))
    pts = "".join("<li><strong>%s</strong>%s</li>" % (e(t), e(p)) for t, p in S["home_points"])
    faqs = "".join("<details><summary>%s</summary><p>%s</p></details>" % (e(q), e(ans)) for q, ans in S["faq"])
    h += """
<section class="hero">
%s
<div class="wrap">
<div>
<h1>%s</h1>
<p>%s</p>
<div class="btn-row"><a class="btn btn--gold" href="quote.html">%s</a><a class="btn btn--ghost" href="guide.html">%s</a></div>
</div>
<aside class="hero-panel" aria-label="%s">
<h2>%s</h2>
<ul>
%s
</ul>
</aside>
</div>
</section>
<div class="strata" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<section class="facts" aria-label="%s at a glance"><div class="wrap"><dl>
%s
</dl></div></section>

<section class="section">
<div class="wrap">
<h2>%s</h2>
<p class="lede prose">%s</p>
<div class="rule-cards">
%s
</div>
</div>
</section>

<section class="section section--tint">
<div class="wrap">
<h2>%s</h2>
<p class="lede prose">%s</p>
<div class="grid grid--3">
%s</div>
</div>
</section>

<section class="section">
<div class="wrap split">
<div>
<h2>%s</h2>
<ul class="points">
%s
</ul>
<p><a class="btn" href="hiring.html">Hiring tips</a></p>
</div>
<div>%s</div>
</div>
</section>

<section class="section cta">
<div class="wrap">
<h2>%s</h2>
<p>%s</p>
<a class="btn btn--gold" href="quote.html">%s</a>
</div>
</section>

<section class="section">
<div class="wrap">
<h2>Common questions</h2>
<div class="prose" style="max-width:44rem">%s</div>
</div>
</section>
""" % (img("hero", S["hero_alt"], 1920, 1080, True), e(S["h1"]), e(S["hero_lead"]), e(CTA_LABEL), e(S["secondary_cta"]),
       a(S["hero_panel"]["title"]), e(S["hero_panel"]["title"]), hp, e(S["place_label"]), facts,
       e(S["rules_h2"]), e(S["rules_lead"]), rules, e(S["topics_h2"]), e(S["topics_lead"]), cards,
       e(S["points_h2"]), pts, img("card-hiring", "Hiring checklist", 800, 600),
       e(S["cta_h2"]), e(S["cta_p"]), e(CTA_LABEL), faqs)
    h += footer()
    write("index.html", h)


# ------------------------------------------------------------------ guide
def guide():
    g = S["guide"]
    h = head(g["title"], g["description"], "guide.html") + header("guide.html")
    h += page_head(g["h1"], g["lead"], "header-guide", S["hero_alt"])
    cards = ""
    for t in S["topics"]:
        plate = "".join("<div><dt>%s</dt><dd>%s</dd></div>" % (e(k), e(v)) for k, v in t["plate"])
        cards += ('<article class="card" id="%s">%s<div class="card-body"><h3>%s</h3><dl class="plate">%s</dl><p>%s</p></div></article>\n'
                  % (t["id"], img("card-" + t["id"], t["title"], 800, 600), e(t["title"]), plate, e(t["text"])))
    h += """<section class="section">
<div class="wrap">
<div class="callout prose"><p>%s</p></div>
<div class="grid grid--3">
%s</div>
</div>
</section>

<section class="section cta">
<div class="wrap">
<h2>%s</h2>
<p>%s</p>
<a class="btn btn--gold" href="quote.html">%s</a>
</div>
</section>
""" % (g["callout_html"], cards, e(S["cta_h2"]), e(S["cta_p"]), e(CTA_LABEL))
    h += footer()
    write("guide.html", h)


# ------------------------------------------------------------------ timing
def timing():
    t = S["timing_page"]
    h = head(t["title"], t["description"], "timing.html") + header("timing.html")
    h += page_head(t["h1"], t["lead"], "header-timing", S["hero_alt"])
    for i, b in enumerate(S["timing"]):
        tint = " section--tint" if i % 2 else ""
        flip = " split--flip" if i % 2 else ""
        facts = "".join("<li><b>%s</b> %s</li>" % (e(k), e(v)) for k, v in b["facts"])
        h += """<section class="section%s">
<div class="wrap split%s">
<div>%s</div>
<div>
<h2>%s</h2>
<p class="lede">%s</p>
<p>%s</p>
<ul class="facts-list">%s</ul>
</div>
</div>
</section>
""" % (tint, flip, img("time-" + b["id"], b["title"], 800, 600), e(b["title"]), e(b["when"]), e(b["text"]), facts)
    h += footer()
    write("timing.html", h)


# ------------------------------------------------------------------ hiring
def hiring():
    hi = S["hiring"]
    h = head(hi["page_title"], hi["description"], "hiring.html") + header("hiring.html")
    h += page_head(hi["h1"], hi["lead"], "header-hiring", S["hero_alt"])
    ask = "".join("<li><strong>%s</strong>%s</li>" % (e(q), e(ans)) for q, ans in hi["ask"])
    price = "".join("<li><b>%s</b> %s</li>" % (e(k), e(v)) for k, v in hi["price"])
    flags = "".join("<li><b>%s</b> %s</li>" % (e(k), e(v)) for k, v in hi["flags"])
    h += """<section class="section">
<div class="wrap split">
<div>%s</div>
<div>
<h2>%s</h2>
<ol class="steps">%s</ol>
</div>
</div>
</section>

<section class="section section--tint">
<div class="wrap split split--flip">
<div>
<h2>%s</h2>
<ul class="facts-list">%s</ul>
</div>
<div>
<h2>%s</h2>
<ul class="facts-list">%s</ul>
</div>
</div>
</section>

<section class="section">
<div class="wrap prose"><div class="callout"><p>%s</p></div></div>
</section>

<section class="section cta">
<div class="wrap">
<h2>%s</h2>
<p>%s</p>
<a class="btn btn--gold" href="quote.html">%s</a>
</div>
</section>
""" % (img("card-hiring", "Hiring checklist", 800, 600), e(hi["ask_h2"]), ask, e(hi["price_h2"]), price, e(hi["flags_h2"]), flags,
       hi["callout_html"], e(S["cta_h2"]), e(S["cta_p"]), e(CTA_LABEL))
    h += footer()
    write("hiring.html", h)


# ------------------------------------------------------------------ quote form
def quote():
    q = S["quote"]
    h = head(q["title"], q["description"], "quote.html") + header("quote.html")
    h += page_head(q["h1"], q["lead"], "header-quote", S["hero_alt"])
    opts = "".join('<option value="%s" data-key="%s">%s</option>' % (a(o), a(k), e(o)) for k, o in q["options"])
    urg = "".join("<option>%s</option>" % e(u) for u in q["urgency"])
    steps = "".join("<li><strong>%s</strong>%s</li>" % (e(t), e(p)) for t, p in q["steps"])
    h += """<section class="section">
<div class="wrap form-layout">
<form id="lead-form" class="lead-form" novalidate>
<input type="hidden" name="access_key" id="access_key" value="">
<input type="hidden" name="subject" value="%s">
<input type="hidden" name="from_name" value="%s">
<input type="hidden" name="site" value="%s">
<input type="hidden" name="landing_page" id="landing_page" value="">
<input type="hidden" name="referrer" id="referrer" value="">
<div class="hp" aria-hidden="true"><input type="checkbox" name="botcheck" tabindex="-1" autocomplete="off"></div>
<p class="lede" style="margin-top:0"><strong>%s</strong></p>

<div class="field-row">
<div class="field"><label for="name">Your name</label><input type="text" id="name" name="name" autocomplete="name" required><div class="error" role="alert">Enter your name.</div></div>
<div class="field"><label for="email">Email</label><input type="email" id="email" name="email" autocomplete="email" required><div class="error" role="alert">Enter an email address like name@example.com.</div></div>
</div>
<div class="field-row">
<div class="field"><label for="phone">Phone <span class="hint">(optional)</span></label><input type="tel" id="phone" name="phone" autocomplete="tel"></div>
<div class="field"><label for="interest">I need help with</label>
<select id="interest" name="interest" required>
<option value="">Choose one</option>
%s
</select><div class="error" role="alert">Choose what you need help with.</div></div>
</div>
<div class="field-row">
<div class="field"><label for="zip">%s <span class="hint">(optional)</span></label><input type="text" id="zip" name="location" autocomplete="postal-code" placeholder="%s"></div>
<div class="field"><label for="urgency">How soon do you need help? <span class="hint">(optional)</span></label>
<select id="urgency" name="urgency"><option value="">Not sure yet</option>%s</select></div>
</div>
<div class="field"><label for="message">Anything else we should know? <span class="hint">(optional)</span></label><textarea id="message" name="message"></textarea></div>
<div class="field"><div class="check"><input type="checkbox" id="consent" name="consent" value="yes" required><label for="consent" style="font-weight:400;font-family:var(--body);margin:0">%s See the <a href="privacy.html">privacy policy</a>.</label></div><div class="error" role="alert">Check the box to agree before sending.</div></div>
<button class="btn" type="submit">Send my request</button>
<div class="form-status" role="status" aria-live="polite"></div>
<noscript><p class="fine">This form needs JavaScript. Please turn it on and reload the page.</p></noscript>
<p class="fine">We use your details only to respond to your request, as described in the privacy policy.</p>
</form>

<aside>
<h2>What happens next</h2>
<ol class="steps">
%s
</ol>
<div class="callout"><p>%s</p></div>
</aside>
</div>
</section>
""" % (a(q["subject"]), a(NAME), a(HOST), e(q["form_intro"]), opts, e(q["location_label"]), a(q["location_ph"]), urg, e(q["consent"]), steps, q["callout_html"])
    h += footer()
    write("quote.html", h)


# ------------------------------------------------------------------ small pages
def about():
    ab = S["about"]
    secs = "".join("<h2>%s</h2><p>%s</p>" % (e(t), p) for t, p in ab["sections"])
    h = head("About this guide | " + NAME, ab["description"], "about.html") + header("about.html")
    h += '<section class="section"><div class="wrap prose">\n<h1>About this guide</h1>\n<p class="lede">%s</p>\n%s\n<h2>Contact</h2><p>Use the <a href="quote.html">quote form</a> and choose "Something else."</p>\n</div></section>\n' % (ab["lede_html"], secs)
    h += footer()
    write("about.html", h)


def privacy():
    h = head("Privacy policy | " + NAME, "How " + NAME + " collects and uses information.", "privacy.html") + header("privacy.html")
    h += """<section class="section"><div class="wrap prose">
<h1>Privacy policy</h1>
<p>Last updated %s.</p>
<h2>What we collect</h2>
<p>When you use the quote form we collect the details you enter: your name, email address, phone number if you give one, what you need help with, your location if you enter it, how soon you need help, and any message. We also record the page you first visited and the site that referred you, so we know which pages lead to requests.</p>
<p>If analytics is turned on, our analytics provider also collects standard visit data such as pages viewed, device and browser type, and approximate location.</p>
<h2>How we use it</h2>
<p>We use your details to respond to your request, to connect it with %s, and to understand how the site is used.</p>
<h2>Who we share it with</h2>
<p>With your consent on the form, we may share your request with %s who can help with it. We also rely on service providers: Web3Forms processes form submissions, Google Analytics measures traffic when it is enabled, and Google Fonts delivers the site's typefaces.</p>
<h2>Cookies</h2>
<p>This site sets no cookies of its own. Analytics may set cookies when it is enabled. You can block cookies in your browser settings.</p>
<h2>Your choices</h2>
<p>You can ask us to delete the information you sent or to stop contacting you. Use the <a href="quote.html">quote form</a>, choose "Something else," and tell us what you want. Companies that already received your request keep their own records and handle requests on their own terms.</p>
<h2>Children</h2>
<p>This site is not directed to children under 13, and we do not knowingly collect their information.</p>
<h2>Changes</h2>
<p>If this policy changes we will update the date above.</p>
</div></section>
""" % (NOW, S["providers_phrase"], S["providers_phrase"])
    h += footer()
    write("privacy.html", h)


def thanks():
    h = head("Request received | " + NAME, "Your request was sent.", "thank-you.html", robots="noindex") + header("thank-you.html")
    h += """<section class="section"><div class="wrap prose">
<h1>Request received</h1>
<p class="lede">Thanks. Your request is on its way and will be reviewed.</p>
<p>%s While you wait, these pages may help.</p>
<div class="btn-row"><a class="btn" href="guide.html">Read the guide</a><a class="btn" href="hiring.html">Hiring tips</a></div>
</div></section>
""" % e(S["thanks_p"])
    h += footer()
    write("thank-you.html", h)


def notfound():
    h = head("Page not found | " + NAME, "That page was not found.", "404.html", robots="noindex") + header("404.html")
    h += """<section class="section"><div class="wrap prose">
<h1>That page was not found</h1>
<p class="lede">The link may be old or mistyped. These pages are a good place to start.</p>
<div class="btn-row"><a class="btn" href="/index.html">Home</a><a class="btn" href="/guide.html">Guide</a><a class="btn" href="/quote.html">%s</a></div>
</div></section>
""" % e(CTA_LABEL)
    h += footer()
    write("404.html", h)


# ------------------------------------------------------------------ static assets
def assets():
    css = pathlib.Path("/home/claude/yellowstonenationalpark-net/css/style.css").read_text()
    css = css.replace("/* YellowstoneNationalPark.net — independent visitor guide */", "/* %s */" % NAME)
    over = """
/* palette */
:root {
  --night: %(night)s; --night-2: %(night2)s; --paper: %(paper)s; --paper-2: %(paper2)s;
  --ink: %(ink)s; --muted: %(muted)s; --line: %(line)s;
  --vermilion: %(accent)s; --vermilion-dk: %(accent_dk)s; --river: %(river)s; --gold: %(gold)s;
  --s1: %(s1)s; --s2: %(s2)s; --s3: %(s3)s; --s4: %(s4)s;
}
""" % PAL
    # insert override right after the :root block so the auction block still carries its marker
    css = css.replace("*, *::before, *::after { box-sizing", over + "\n*, *::before, *::after { box-sizing", 1)
    (OUT / "css" / "style.css").write_text(css)
    js = pathlib.Path("/home/claude/yellowstonenationalpark-net/js/main.js").read_text().replace("yng_", KEY[:6] + "_")
    (OUT / "js" / "main.js").write_text(js)
    cfg = pathlib.Path("/home/claude/yellowstonenationalpark-net/js/config.js").read_text()
    cfg = cfg.replace('AUCTION_ID: "yellowstonenationalpark.net"', 'AUCTION_ID: "%s"' % HOST).replace('SITE_NAME: "YellowstoneNationalPark.net"', 'SITE_NAME: "%s"' % NAME)
    (OUT / "js" / "config.js").write_text(cfg)
    pages = ["", "guide.html", "timing.html", "hiring.html", "quote.html", "about.html", "privacy.html"]
    sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(
        "<url><loc>https://%s/%s</loc><lastmod>%s</lastmod></url>\n" % (HOST, p, datetime.date.today().isoformat()) for p in pages) + "</urlset>\n"
    write("sitemap.xml", sm)
    write("robots.txt", "User-agent: *\nAllow: /\nDisallow: /auction.html\nSitemap: https://%s/sitemap.xml\n" % HOST)


def png_assets():
    """og-image.png and apple-touch-icon.png rendered from the SVG art."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium") if os.path.exists("/opt/pw-browsers/chromium") else p.chromium.launch()
        pg = b.new_page(viewport={"width": 1200, "height": 630})
        bg = ('<img src="file://%s" style="position:absolute;inset:0;width:1200px;height:630px;object-fit:cover">' % (OUT / "images" / "og-photo.jpg")) if "hero" in HAVE else ART["hero"].replace('width="1920" height="1080"', 'width="1200" height="630" style="position:absolute;inset:0"')
        pg.set_content('<body style="margin:0"><div style="width:1200px;height:630px;position:relative;overflow:hidden">%s'
                       '<div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.62),rgba(0,0,0,.05))"></div>'
                       '<div style="position:absolute;left:60px;bottom:70px;right:60px;color:#fff;font:700 64px/1.05 Georgia,serif">%s</div>'
                       '<div style="position:absolute;left:60px;bottom:30px;color:#fff;font:600 26px system-ui">%s</div></div></body>'
                       % (bg, e(S["og_headline"]), e(NAME)))
        pg.screenshot(path=str(OUT / "images" / "og-image.png"))
        pg2 = b.new_page(viewport={"width": 180, "height": 180})
        pg2.set_content('<body style="margin:0"><div style="width:180px;height:180px">%s</div></body>' % LOGO.replace('<svg ', '<svg width="180" height="180" ', 1))
        pg2.screenshot(path=str(OUT / "apple-touch-icon.png"))
        b.close()


assets(); index(); guide(); timing(); hiring(); quote(); about(); privacy(); thanks(); notfound(); png_assets()

# ------------------------------------------------------------------ auction page
A = S["auction"]
cfgj = {
    "name": NAME, "host": HOST, "auction_id": HOST, "place": A["place"], "region": "",
    "pages": A["pages"], "buyers": A["buyers"], "sections": A["sections"],
    "base_page": "quote.html", "lead_phrase": "a quote-request form", "guide_word": "consumer guide", "name_phrase": A["name_phrase"], "terms_disclaimer": A["terms_disclaimer"],
    "header_html": img("header-quote", S["hero_alt"], 1600, 500, True),
}
(OUT / "auction-config.json").write_text(json.dumps(cfgj, indent=1))
subprocess.run([sys.executable, str(ASSETS / "build_auction_page.py"), str(OUT), "local"], check=True)
# the generic auction page should not be indexed or linked until launch; robots already excludes it
print("built", OUT)
