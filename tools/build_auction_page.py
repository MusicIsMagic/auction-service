#!/usr/bin/env python3
"""Generate auction.html for a site, add auction.css/auction.js/config entries.
Usage: build_auction_page.py <site_dir> <zion|yellowstone> [--link]
--link adds the footer link (and homepage notice link) to every page. Without it the
auction page exists but nothing links to it, so nothing is public until launch.
"""
import re, sys, shutil, pathlib

site = pathlib.Path(sys.argv[1])
key = sys.argv[2]
link = "--link" in sys.argv
assets = pathlib.Path(__file__).parent

SITES = {
    "zion": dict(
        name="ZionNationalPark.org", host="zionnationalpark.org", auction_id="zionnationalpark.org",
        place="Zion National Park", region="southwest Utah",
        pages="Home, Hikes, When to visit, Stay and tours, Plan your trip, About, Privacy policy, Thank-you and 404 pages",
        buyers="tour operators, lodging, outfitters, shuttle and gear-rental businesses, and anyone who earns from Zion visitors",
        sections="trail guides, a season-by-season planner, lodging and tour guidance",
    ),
    "yellowstone": dict(
        name="YellowstoneNationalPark.net", host="yellowstonenationalpark.net", auction_id="yellowstonenationalpark.net",
        place="Yellowstone National Park", region="Wyoming, Montana, and Idaho",
        pages="Home, Sights and hikes, When to visit, Stay and tours, Plan your trip, About, Privacy policy, Thank-you and 404 pages",
        buyers="tour operators, lodging, outfitters, wildlife-tour and gear-rental businesses, and anyone who earns from Yellowstone visitors",
        sections="a sights and hikes guide, wildlife-viewing safety guidance, a season-by-season planner, lodging and tour guidance",
    ),
}
S = SITES[key]

src = (site / "plan-your-trip.html").read_text()
head, rest = src.split('<main id="main">', 1)
_, tail = rest.split("</main>", 1)

title = f"{S['name']}: Digital Property for Sale by Auction"
desc = f"{S['name']} is offered as a complete digital property: the name, a finished visitor guide, and a working lead-capture form. Bids are open."
head = re.sub(r"<title>.*?</title>", f"<title>{title}</title>", head, flags=re.S)
head = re.sub(r'(<meta name="description" content=")[^"]*(")', lambda m: m.group(1) + desc + m.group(2), head)
head = re.sub(r'(<link rel="canonical" href=")[^"]*(")', lambda m: m.group(1) + f"https://{S['host']}/auction.html" + m.group(2), head)
head = re.sub(r'(<meta property="og:title" content=")[^"]*(")', lambda m: m.group(1) + title + m.group(2), head)
head = re.sub(r'(<meta property="og:description" content=")[^"]*(")', lambda m: m.group(1) + desc + m.group(2), head)
head = re.sub(r'(<meta property="og:url" content=")[^"]*(")', lambda m: m.group(1) + f"https://{S['host']}/auction.html" + m.group(2), head)
head = head.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="robots" content="noindex, follow">', 1)
if "js/auction.js" not in head:
    head = head.replace('<script src="js/main.js" defer></script>', '<script src="js/main.js" defer></script>\n<script src="js/auction.js" defer></script>')
# nav: no item is current on this page
head = head.replace(' aria-current="page"', "")

main = f"""<main id="main">

<section class="page-head">
<img src="images/header-plan.jpg" data-fallback="images/art/header-plan.svg" alt="" width="1600" height="500" fetchpriority="high">
<div class="wrap">
<h1>{S['name']} is for sale</h1>
<p>One complete digital property, offered to one buyer by open auction.</p>
</div>
</section>
<div class="strata" aria-hidden="true"><i></i><i></i><i></i><i></i></div>

<section class="section">
<div class="wrap form-layout">
<div>
<div id="a-banner" class="a-banner" hidden role="status"></div>

<div class="auction-panel" id="auction-panel" aria-live="polite">
<span class="a-status" id="a-status">Loading</span>
<p class="a-label" id="a-label">Current high bid</p>
<p class="a-amount" id="a-amount">&nbsp;</p>
<p class="a-clock-label" id="a-clock-label"></p>
<p class="a-clock" id="a-clock"></p>
<p class="a-meta" id="a-meta"></p>
<div class="a-history-wrap" id="a-history-wrap" hidden>
<h3>Confirmed bids</h3>
<ul class="a-history" id="a-history"></ul>
</div>
</div>

<div id="bid-form-wrap" hidden>
<form id="bid-form" class="lead-form" novalidate>
<h2 style="margin-top:0">Place a bid</h2>
<p class="fine" style="margin-top:0">Your next bid must be at least <strong id="a-min"></strong>. Your bid counts only after you confirm it by email.</p>
<div class="hp" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
<div class="field-row">
<div class="field"><label for="bid-name">Your name</label><input type="text" id="bid-name" name="name" autocomplete="name" required></div>
<div class="field"><label for="bid-company">Company <span class="hint">(optional)</span></label><input type="text" id="bid-company" name="company" autocomplete="organization"></div>
</div>
<div class="field-row">
<div class="field"><label for="bid-email">Email</label><input type="email" id="bid-email" name="email" autocomplete="email" required></div>
<div class="field"><label for="bid-phone">Phone</label><input type="tel" id="bid-phone" name="phone" autocomplete="tel" required></div>
</div>
<div class="field"><label for="bid-amount">Your bid (US dollars)</label><div class="a-amount-field"><span>$</span><input type="text" inputmode="numeric" id="bid-amount" name="amount" autocomplete="off" required></div></div>
<div class="field"><label class="check"><input type="checkbox" name="terms" id="bid-terms"><span>I have read the auction terms. I understand that a confirmed bid is binding, and that the winner pays through Escrow.com within 7 days of the auction closing.</span></label></div>
<button class="btn" type="submit">Submit bid</button>
<div id="bid-status" class="form-status" role="status"></div>
</form>
</div>
<div id="a-closed" class="a-closed" hidden>Bidding is not open right now.</div>
</div>

<aside class="a-side">
<h2>What the buyer gets</h2>
<ul class="a-list">
<li><strong>The name:</strong> {S['name']}, an exact-match name for visitors searching for {S['place']}.</li>
<li><strong>A finished website:</strong> {S['pages']}. It includes {S['sections']}, all written for this site.</li>
<li><strong>Lead capture, already working:</strong> a trip-planning form that delivers requests to the owner's email.</li>
<li><strong>Design and image files,</strong> and the complete source, ready to host anywhere.</li>
<li><strong>A clean transfer</strong> of the name and files through Escrow.com.</li>
</ul>
<p>It is best suited to {S['buyers']}.</p>

<h2>How the auction works</h2>
<ol class="steps">
<li><strong>The opening bid sets the clock.</strong>The first confirmed bid at or above the minimum starts a 30-day countdown.</li>
<li><strong>Raise the bid.</strong>Each new bid must beat the high bid by at least $100.</li>
<li><strong>No last-second wins.</strong>A bid in the final 72 hours moves the close to 72 hours after that bid, so everyone has time to respond.</li>
<li><strong>Confirm by email.</strong>A bid counts only after you click the link we email you.</li>
<li><strong>The owner does not bid.</strong>Every bid on this page comes from an outside bidder.</li>
</ol>

<h2>Terms</h2>
<p class="fine" style="margin-top:0">A confirmed bid is a binding offer. The highest confirmed bid when the auction closes wins. The winner opens an Escrow.com transaction within 7 days of closing and pays through it. The buyer pays the escrow fee. If the winner does not complete payment, the owner may offer the property to the next-highest bidder. The property transfers when Escrow.com confirms payment. Images on this site are illustrative and may be computer-generated. This is an independent visitor guide and is not affiliated with the National Park Service or any government agency, and no traffic, revenue, or search-ranking figures are claimed or implied.</p>

<form id="ask-form" class="ask-form" novalidate>
<h3>Ask a question</h3>
<div class="hp" aria-hidden="true"><input type="checkbox" name="botcheck" tabindex="-1" autocomplete="off"></div>
<div class="field"><label for="ask-email">Your email</label><input type="email" id="ask-email" name="email" required></div>
<div class="field"><label for="ask-msg">Your question</label><textarea id="ask-msg" name="message" required></textarea></div>
<button class="btn" type="submit">Send question</button>
<div id="ask-status" class="form-status" role="status"></div>
</form>
</aside>
</div>
</section>

</main>"""

# footer link on every page
def add_link(path):
    t = path.read_text()
    if "auction.html" in t:
        return
    t = t.replace('<li><a href="privacy.html">Privacy policy</a></li>',
                  '<li><a href="privacy.html">Privacy policy</a></li>\n<li><a href="auction.html">This property is for sale</a></li>', 1)
    if path.name == "index.html":
        t = re.sub(r'(<div class="notice"><div class="wrap">.*?)(</div></div>)',
                   r'\1 <a href="auction.html">This property is for sale.</a>\2', t, count=1, flags=re.S)
    path.write_text(t)

(site / "auction.html").write_text(head + main + tail)

# assets
shutil.copy(assets / "auction.js", site / "js" / "auction.js")
css = (site / "css" / "style.css").read_text()
marker = "/* ---------- auction page ---------- */"
if marker not in css:
    css += (assets / "auction.css").read_text()
    (site / "css" / "style.css").write_text(css)

cfg = (site / "js" / "config.js").read_text()
if "AUCTION_API" not in cfg:
    cfg = cfg.replace("  SITE_NAME:", f'  AUCTION_API: "",\n  AUCTION_ID: "{S["auction_id"]}",\n  SITE_NAME:')
    (site / "js" / "config.js").write_text(cfg)

if link:
    for p in site.glob("*.html"):
        add_link(p)
print("built", site / "auction.html", "link" if link else "unlinked")
