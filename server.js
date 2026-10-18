"use strict";
/*
  Auction bid service.
  One service runs auctions for any number of properties (see auctions.json).
  Rules:
   - The first verified bid at or above the minimum starts the clock (durationDays).
   - Every later bid must beat the current high bid by at least the increment.
   - A verified bid placed inside the final softCloseHours moves the close to
     softCloseHours after that bid, so nobody can win with a last-second bid.
   - A bid only counts after the bidder clicks the link emailed to them.
   - The seller never bids. All bids are recorded with timestamps.
*/
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "http://localhost:" + PORT).replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const SELLER_EMAIL = process.env.SELLER_EMAIL || "";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || "auction@localhost";
const TEST_MODE = process.env.TEST_MODE === "1";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

fs.mkdirSync(DATA_DIR, { recursive: true });
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.AUCTIONS_FILE || "auctions.json"), "utf8"));

const db = new Database(path.join(DATA_DIR, "auction.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS auction_cfg (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  auction_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS state (
  auction_id TEXT PRIMARY KEY,
  started_at INTEGER,
  ends_at INTEGER,
  finalized INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  amount INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS bids_auction ON bids(auction_id, status);
CREATE TABLE IF NOT EXISTS labels (
  auction_id TEXT NOT NULL,
  email TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (auction_id, email)
);
`);

try { db.exec("ALTER TABLE state ADD COLUMN winner_status TEXT NOT NULL DEFAULT 'awaiting_escrow'"); } catch (e) { /* already there */ }
try { db.exec("ALTER TABLE state ADD COLUMN notes TEXT NOT NULL DEFAULT ''"); } catch (e) { /* already there */ }

/* auctions live in the database so the dashboard can edit them; auctions.json only seeds new ones */
const AUCTIONS = {};
{
  const ins = db.prepare("INSERT OR IGNORE INTO auction_cfg(id,json) VALUES(?,?)");
  Object.keys(SEED).forEach((id) => ins.run(id, JSON.stringify(SEED[id])));
  db.prepare("SELECT id,json FROM auction_cfg").all().forEach((r) => { AUCTIONS[r.id] = JSON.parse(r.json); });
}
function saveCfg(id, obj) {
  db.prepare("INSERT INTO auction_cfg(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(id, JSON.stringify(obj));
  AUCTIONS[id] = obj;
}
function audit(auctionId, action, detail) {
  db.prepare("INSERT INTO audit(at,auction_id,action,detail) VALUES(?,?,?,?)").run(Date.now(), auctionId || null, action, detail ? String(detail).slice(0, 500) : null);
}

/* ---------- email ---------- */
const transport = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;
const outbox = []; // kept in memory for tests
async function sendMail(to, subject, text) {
  if (!to) return;
  outbox.push({ to, subject, text });
  if (outbox.length > 200) outbox.shift();
  if (!transport) { console.log("[mail:not-sent] to=%s subject=%s", to, subject); return; }
  try { await transport.sendMail({ from: MAIL_FROM, to, subject, text }); }
  catch (e) { console.error("mail failed:", to, e.message); }
}
const money = (n) => "$" + Number(n).toLocaleString("en-US");
const fmtDate = (ms) => new Date(ms).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "America/Phoenix" }) + " (Arizona time)";

/* ---------- helpers ---------- */
function cfg(id) { return Object.prototype.hasOwnProperty.call(AUCTIONS, id) ? AUCTIONS[id] : null; }
function getState(id) {
  let s = db.prepare("SELECT * FROM state WHERE auction_id=?").get(id);
  if (!s) { db.prepare("INSERT INTO state(auction_id) VALUES(?)").run(id); s = db.prepare("SELECT * FROM state WHERE auction_id=?").get(id); }
  return s;
}
function verifiedBids(id) {
  return db.prepare("SELECT * FROM bids WHERE auction_id=? AND status='verified' ORDER BY amount ASC, verified_at ASC, id ASC").all(id);
}
function highBid(id) {
  return db.prepare("SELECT * FROM bids WHERE auction_id=? AND status='verified' ORDER BY amount DESC, verified_at ASC, id ASC LIMIT 1").get(id);
}
function status(c, s, now) {
  if (c.opensAt && now < Date.parse(c.opensAt)) return "not_started";
  if (s.started_at) return now >= s.ends_at ? "ended" : "running";
  if (c.bidsOpenUntil && now >= Date.parse(c.bidsOpenUntil)) return "ended";
  return "open";
}
function nextMin(c, high) { return high ? high.amount + c.increment : c.minBid; }
function labelFor(id, email) {
  const row = db.prepare("SELECT label FROM labels WHERE auction_id=? AND email=?").get(id, email);
  if (row) return row.label;
  const n = db.prepare("SELECT COUNT(*) n FROM labels WHERE auction_id=?").get(id).n + 1;
  const label = "Bidder " + n;
  db.prepare("INSERT INTO labels(auction_id,email,label) VALUES(?,?,?)").run(id, email, label);
  return label;
}
function publicState(id, now = Date.now()) {
  const c = cfg(id), s = getState(id);
  const high = highBid(id);
  const all = verifiedBids(id);
  const history = all.map((b) => ({ amount: b.amount, at: b.verified_at, bidder: labelFor(id, b.email) }))
    .sort((a, b) => b.amount - a.amount);
  return {
    id, title: c.title, status: status(c, s, now),
    minBid: c.minBid, increment: c.increment,
    currentBid: high ? high.amount : null,
    nextMinBid: nextMin(c, high),
    bidCount: all.length,
    startedAt: s.started_at, endsAt: s.ends_at,
    durationDays: c.durationDays, softCloseHours: c.softCloseHours,
    opensAt: c.opensAt, bidsOpenUntil: c.bidsOpenUntil,
    history, serverTime: now
  };
}
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/* ---------- app ---------- */
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));

function originAllowed(o) {
  if (TEST_MODE && o === "http://localhost:8080") return true;
  return Object.values(AUCTIONS).some((a) => (a.allowedOrigins || []).includes(o));
}
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && originAllowed(o) && !req.path.startsWith("/admin")) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => res.type("text").send("Auction service is running."));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/auctions/:id", (req, res) => {
  if (!cfg(req.params.id)) return res.status(404).json({ error: "Unknown auction." });
  res.set("Cache-Control", "no-store");
  res.json(publicState(req.params.id));
});

const bidLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: TEST_MODE ? 1000 : 10, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many bid attempts from this address. Try again later." } });

app.post("/api/auctions/:id/bids", bidLimiter, async (req, res) => {
  const id = req.params.id, c = cfg(id);
  if (!c) return res.status(404).json({ error: "Unknown auction." });
  const b = req.body || {};
  if (b.website) return res.json({ ok: true, message: "Check your email to confirm your bid." }); // honeypot
  const name = String(b.name || "").trim().slice(0, 120);
  const company = String(b.company || "").trim().slice(0, 160);
  const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
  const phone = String(b.phone || "").trim().slice(0, 40);
  const amount = Number(b.amount);
  if (!name) return res.status(400).json({ error: "Enter your name." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (phone.replace(/\D/g, "").length < 7) return res.status(400).json({ error: "Enter a phone number we can reach you at." });
  if (!b.acceptTerms) return res.status(400).json({ error: "You must accept the auction terms to bid." });
  if (!Number.isInteger(amount) || amount <= 0 || amount > 5000000) return res.status(400).json({ error: "Enter your bid as a whole number of US dollars." });

  const now = Date.now();
  const s = getState(id);
  const st = status(c, s, now);
  if (st === "not_started") return res.status(409).json({ error: "Bidding has not opened yet." });
  if (st === "ended") return res.status(409).json({ error: "Bidding has ended." });
  const required = nextMin(c, highBid(id));
  if (amount < required) return res.status(409).json({ error: "Your bid must be at least " + money(required) + ".", nextMinBid: required });
  const pending = db.prepare("SELECT COUNT(*) n FROM bids WHERE auction_id=? AND email=? AND status='pending' AND created_at>?").get(id, email, now - DAY).n;
  if (pending >= 5) return res.status(429).json({ error: "You have several unconfirmed bids. Please confirm one from your email first." });

  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO bids(auction_id,name,company,email,phone,amount,token,created_at,ip) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, name, company, email, phone, amount, token, now, req.ip);
  const link = PUBLIC_BASE_URL + "/api/verify?token=" + token;
  await sendMail(email, "Confirm your bid on " + c.title,
    "Hello " + name + ",\n\nYou entered a bid of " + money(amount) + " on " + c.title + ".\n\n" +
    "Your bid does not count until you confirm it. Click this link within 24 hours:\n" + link + "\n\n" +
    "By confirming, you agree that your bid is binding. If you win, you are expected to complete payment through Escrow.com within 7 days of the auction closing.\n\n" +
    "If you did not place this bid, ignore this email and nothing will happen.\n");
  res.json({ ok: true, message: "Check your email and click the confirmation link. Your bid counts once you confirm it." });
});

function redirectTo(c, params) {
  const u = new URL((c ? c.siteUrl : "https://example.com") + "/auction.html");
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

app.get("/api/verify", async (req, res) => {
  const token = String(req.query.token || "");
  const row = db.prepare("SELECT * FROM bids WHERE token=?").get(token);
  if (!row) return res.status(404).type("html").send("<p>This confirmation link is not valid.</p>");
  const c = cfg(row.auction_id);
  const now = Date.now();
  if (row.status === "verified") return res.redirect(redirectTo(c, { confirmed: "1" }));
  if (row.status === "rejected") return res.redirect(redirectTo(c, { confirmed: "0", reason: row.reject_reason || "rejected" }));
  if (now - row.created_at > DAY) {
    db.prepare("UPDATE bids SET status='rejected', reject_reason='expired' WHERE id=?").run(row.id);
    return res.redirect(redirectTo(c, { confirmed: "0", reason: "expired" }));
  }

  let outcome, prevHigh = null, started = false, extended = false, newEnds = null;
  const tx = db.transaction(() => {
    const s = getState(row.auction_id);
    const st = status(c, s, now);
    if (st === "ended" || st === "not_started") { db.prepare("UPDATE bids SET status='rejected', reject_reason='closed' WHERE id=?").run(row.id); return "closed"; }
    const high = highBid(row.auction_id);
    if (row.amount < nextMin(c, high)) { db.prepare("UPDATE bids SET status='rejected', reject_reason='outbid' WHERE id=?").run(row.id); return "outbid"; }
    prevHigh = high;
    db.prepare("UPDATE bids SET status='verified', verified_at=? WHERE id=?").run(now, row.id);
    labelFor(row.auction_id, row.email);
    if (!s.started_at) {
      started = true; newEnds = now + c.durationDays * DAY;
      db.prepare("UPDATE state SET started_at=?, ends_at=? WHERE auction_id=?").run(now, newEnds, row.auction_id);
    } else if (s.ends_at - now <= c.softCloseHours * HOUR) {
      const candidate = now + c.softCloseHours * HOUR;
      if (candidate > s.ends_at) { extended = true; newEnds = candidate; db.prepare("UPDATE state SET ends_at=? WHERE auction_id=?").run(newEnds, row.auction_id); }
    }
    return "ok";
  });
  outcome = tx();
  audit(row.auction_id, outcome === "ok" ? "bid confirmed" : "bid rejected (" + outcome + ")", money(row.amount) + " by " + row.email);
  if (outcome !== "ok") return res.redirect(redirectTo(c, { confirmed: "0", reason: outcome }));

  const ends = getState(row.auction_id).ends_at;
  sendMail(row.email, "Your bid is confirmed: " + c.title,
    "Hello " + row.name + ",\n\nYour bid of " + money(row.amount) + " on " + c.title + " is confirmed and is now the high bid.\n\n" +
    "Bidding is scheduled to close " + fmtDate(ends) + ". Any bid in the final " + c.softCloseHours + " hours moves the close back to " + c.softCloseHours + " hours after that bid.\n\n" +
    "Watch the auction: " + c.siteUrl + "/auction.html\n");
  if (prevHigh && prevHigh.email !== row.email) {
    sendMail(prevHigh.email, "You have been outbid on " + c.title,
      "Hello " + prevHigh.name + ",\n\nYour bid of " + money(prevHigh.amount) + " on " + c.title + " has been outbid. The new high bid is " + money(row.amount) + ".\n\n" +
      "To bid again, you need to bid at least " + money(row.amount + c.increment) + ": " + c.siteUrl + "/auction.html\n\n" +
      "Bidding is scheduled to close " + fmtDate(ends) + ".\n");
  }
  sendMail(SELLER_EMAIL, (started ? "[AUCTION STARTED] " : "[NEW BID] ") + c.title + " " + money(row.amount),
    c.title + "\nNew confirmed bid: " + money(row.amount) + "\nBidder: " + row.name + (row.company ? " (" + row.company + ")" : "") + "\nEmail: " + row.email + "\nPhone: " + row.phone + "\n" +
    (started ? "This bid started the " + c.durationDays + "-day clock.\n" : "") + (extended ? "Close extended by the late-bid rule.\n" : "") +
    "Closes: " + fmtDate(ends) + "\n");
  res.redirect(redirectTo(c, { confirmed: "1" }));
});

/* ---------- seller dashboard (cookie login) ---------- */
const COOKIE = "auction_admin";
const sessionValue = () => crypto.createHmac("sha256", ADMIN_TOKEN || "no-token").update("auction-admin-session-v1").digest("hex");
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: "ADMIN_TOKEN is not set on the server." });
  const c = parseCookies(req)[COOKIE];
  if (!c || !safeEq(c, sessionValue())) return res.status(401).json({ error: "Not signed in." });
  if (req.method !== "GET" && req.headers["x-requested-with"] !== "admin") return res.status(403).json({ error: "Bad request." });
  next();
}
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: TEST_MODE ? 1000 : 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts. Try again later." } });

app.get("/admin", (_req, res) => { res.set("Cache-Control", "no-store"); res.sendFile(path.join(__dirname, "public", "admin.html")); });

app.post("/admin/api/login", loginLimiter, (req, res) => {
  const t = String((req.body || {}).token || "");
  if (!ADMIN_TOKEN || !safeEq(t, ADMIN_TOKEN)) return res.status(401).json({ error: "That password is not right." });
  res.setHeader("Set-Cookie", COOKIE + "=" + sessionValue() + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + 14 * 24 * 3600 + (req.secure ? "; Secure" : ""));
  res.json({ ok: true });
});
app.post("/admin/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  res.json({ ok: true });
});

function locked(id) {
  const s = getState(id);
  return !!s.started_at || db.prepare("SELECT COUNT(*) n FROM bids WHERE auction_id=? AND status='verified'").get(id).n > 0;
}
function adminView(id) {
  const c = cfg(id), s = getState(id), p = publicState(id);
  const bids = db.prepare("SELECT * FROM bids WHERE auction_id=? ORDER BY created_at DESC").all(id)
    .map((b) => ({ id: b.id, at: b.created_at, verifiedAt: b.verified_at, status: b.status, reason: b.reject_reason, amount: b.amount, name: b.name, company: b.company, email: b.email, phone: b.phone }));
  // fallback order: each verified bidder's best bid, highest first
  const best = new Map();
  bids.filter((b) => b.status === "verified").forEach((b) => { const k = b.email; if (!best.has(k) || best.get(k).amount < b.amount) best.set(k, b); });
  const ranking = [...best.values()].sort((a, b) => b.amount - a.amount);
  const log = db.prepare("SELECT at,action,detail FROM audit WHERE auction_id=? ORDER BY id DESC LIMIT 60").all(id);
  return { id, config: c, state: p, locked: locked(id), finalized: !!s.finalized, winnerStatus: s.winner_status, notes: s.notes, bids, ranking, audit: log };
}
function summaryRow(id) {
  const p = publicState(id), s = getState(id);
  const pending = db.prepare("SELECT COUNT(*) n FROM bids WHERE auction_id=? AND status='pending' AND created_at>?").get(id, Date.now() - DAY).n;
  const bidders = db.prepare("SELECT COUNT(DISTINCT email) n FROM bids WHERE auction_id=? AND status='verified'").get(id).n;
  return { id, title: AUCTIONS[id].title, status: p.status, currentBid: p.currentBid, minBid: p.minBid, bidCount: p.bidCount, bidders, pending, endsAt: p.endsAt, startedAt: p.startedAt, locked: locked(id), winnerStatus: s.winner_status, finalized: !!s.finalized, siteUrl: AUCTIONS[id].siteUrl };
}

app.get("/admin/api/summary", adminAuth, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    auctions: Object.keys(AUCTIONS).map(summaryRow),
    health: { emailConfigured: !!transport, sellerEmail: SELLER_EMAIL, publicBaseUrl: PUBLIC_BASE_URL, httpsBase: /^https:/.test(PUBLIC_BASE_URL) },
    audit: db.prepare("SELECT at,auction_id,action,detail FROM audit ORDER BY id DESC LIMIT 40").all()
  });
});
app.get("/admin/api/auctions/:id", adminAuth, (req, res) => {
  if (!cfg(req.params.id)) return res.status(404).json({ error: "Unknown auction." });
  res.set("Cache-Control", "no-store");
  res.json(adminView(req.params.id));
});

const RULE_FIELDS = ["minBid", "increment", "durationDays", "softCloseHours", "opensAt", "bidsOpenUntil"];
function cleanOrigins(list) {
  const out = [];
  (Array.isArray(list) ? list : String(list || "").split(/[\s,]+/)).forEach((o) => {
    o = String(o).trim().replace(/\/$/, "");
    if (!o) return;
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) throw new Error("Not a valid site address: " + o);
    out.push(o);
  });
  return out;
}
function cleanDate(v, label) {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(label + " is not a valid date.");
  return new Date(t).toISOString();
}
function intField(v, label, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(label + " must be a whole number between " + min + " and " + max + ".");
  return n;
}
function buildCfg(input, base) {
  const o = Object.assign({}, base || {});
  if ("title" in input) { o.title = String(input.title || "").trim().slice(0, 120); if (!o.title) throw new Error("Title is required."); }
  if ("siteUrl" in input) {
    const u = String(input.siteUrl || "").trim().replace(/\/$/, "");
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(u)) throw new Error("Site address must look like https://example.com");
    o.siteUrl = u;
  }
  if ("allowedOrigins" in input) o.allowedOrigins = cleanOrigins(input.allowedOrigins);
  if ("minBid" in input) o.minBid = intField(input.minBid, "Minimum bid", 1, 5000000);
  if ("increment" in input) o.increment = intField(input.increment, "Raise increment", 1, 1000000);
  if ("durationDays" in input) o.durationDays = intField(input.durationDays, "Countdown length (days)", 1, 120);
  if ("softCloseHours" in input) o.softCloseHours = intField(input.softCloseHours, "Late-bid window (hours)", 0, 240);
  if ("opensAt" in input) o.opensAt = cleanDate(input.opensAt, "Opening time");
  if ("bidsOpenUntil" in input) o.bidsOpenUntil = cleanDate(input.bidsOpenUntil, "Latest first-bid time");
  if (!o.siteUrl || !o.title) throw new Error("Title and site address are required.");
  if (!o.allowedOrigins || !o.allowedOrigins.length) o.allowedOrigins = [o.siteUrl];
  return o;
}

app.put("/admin/api/auctions/:id", adminAuth, (req, res) => {
  const id = req.params.id, c = cfg(id);
  if (!c) return res.status(404).json({ error: "Unknown auction." });
  const body = req.body || {};
  try {
    if (locked(id)) {
      const touched = RULE_FIELDS.filter((f) => f in body && JSON.stringify(body[f] === "" ? null : body[f]) !== JSON.stringify(c[f]) && String(body[f]) !== String(c[f]));
      if (touched.length) return res.status(409).json({ error: "Bidding has started, so the rules are locked. You can still change the title and site addresses." });
    }
    const next = buildCfg(body, c);
    const changes = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(c[k]));
    saveCfg(id, next);
    audit(id, "settings changed", changes.map((k) => k + ": " + JSON.stringify(c[k]) + " -> " + JSON.stringify(next[k])).join("; ") || "no changes");
    res.json(adminView(id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/admin/api/auctions", adminAuth, (req, res) => {
  const b = req.body || {};
  const id = String(b.id || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{2,60}$/.test(id)) return res.status(400).json({ error: "Name the property with its domain, like example.com." });
  if (cfg(id)) return res.status(409).json({ error: "That property already exists." });
  try {
    const base = { minBid: 2500, increment: 100, durationDays: 30, softCloseHours: 72, opensAt: null, bidsOpenUntil: null };
    const o = buildCfg(Object.assign({ title: id, siteUrl: "https://" + id }, b), base);
    saveCfg(id, o); getState(id);
    audit(id, "property added", o.title);
    res.json(adminView(id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/admin/api/auctions/:id", adminAuth, (req, res) => {
  const id = req.params.id;
  if (!cfg(id)) return res.status(404).json({ error: "Unknown auction." });
  if (db.prepare("SELECT COUNT(*) n FROM bids WHERE auction_id=?").get(id).n > 0) return res.status(409).json({ error: "This property has bids, so it cannot be deleted." });
  db.prepare("DELETE FROM auction_cfg WHERE id=?").run(id);
  db.prepare("DELETE FROM state WHERE auction_id=?").run(id);
  delete AUCTIONS[id];
  audit(id, "property deleted", id);
  res.json({ ok: true });
});

app.put("/admin/api/auctions/:id/workflow", adminAuth, (req, res) => {
  const id = req.params.id;
  if (!cfg(id)) return res.status(404).json({ error: "Unknown auction." });
  const allowed = ["awaiting_escrow", "escrow_open", "paid", "transferred", "defaulted"];
  const b = req.body || {};
  const s = getState(id);
  const ws = "winnerStatus" in b ? String(b.winnerStatus) : s.winner_status;
  if (!allowed.includes(ws)) return res.status(400).json({ error: "Unknown status." });
  const notes = "notes" in b ? String(b.notes || "").slice(0, 4000) : s.notes;
  db.prepare("UPDATE state SET winner_status=?, notes=? WHERE auction_id=?").run(ws, notes, id);
  if (ws !== s.winner_status) audit(id, "winner status", s.winner_status + " -> " + ws);
  if (notes !== s.notes) audit(id, "notes edited", "");
  res.json(adminView(id));
});

app.get("/admin/api/auctions/:id/bids.csv", adminAuth, (req, res) => {
  const id = req.params.id;
  if (!cfg(id)) return res.status(404).send("Unknown auction.");
  const q = (v) => { v = v == null ? "" : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
  const rows = db.prepare("SELECT * FROM bids WHERE auction_id=? ORDER BY created_at ASC").all(id);
  const lines = ["entered,confirmed,status,reason,amount,name,company,email,phone"].concat(rows.map((b) =>
    [new Date(b.created_at).toISOString(), b.verified_at ? new Date(b.verified_at).toISOString() : "", b.status, b.reject_reason, b.amount, b.name, b.company, b.email, b.phone].map(q).join(",")));
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="' + id + '-bids.csv"' });
  res.send(lines.join("\n"));
});

app.post("/admin/api/test-email", adminAuth, async (_req, res) => {
  if (!transport) return res.status(409).json({ error: "Email is not set up yet. Add SMTP_USER and SMTP_PASS in Render." });
  if (!SELLER_EMAIL) return res.status(409).json({ error: "SELLER_EMAIL is not set." });
  try {
    await transport.sendMail({ from: MAIL_FROM, to: SELLER_EMAIL, subject: "Auction service test email", text: "If you can read this, bid confirmations and alerts will be delivered." });
    audit(null, "test email sent", SELLER_EMAIL);
    res.json({ ok: true, to: SELLER_EMAIL });
  } catch (e) { res.status(502).json({ error: "Sending failed: " + e.message }); }
});

/* ---------- finalize ended auctions ---------- */
async function finalizeEnded() {
  const now = Date.now();
  for (const id of Object.keys(AUCTIONS)) {
    const c = AUCTIONS[id], s = getState(id);
    if (s.finalized || !s.started_at || now < s.ends_at) continue;
    db.prepare("UPDATE state SET finalized=1, winner_status='awaiting_escrow' WHERE auction_id=?").run(id);
    audit(id, "auction ended", "");
    const win = highBid(id);
    if (!win) continue;
    const others = new Map();
    verifiedBids(id).forEach((b) => { if (b.email !== win.email) others.set(b.email, b.name); });
    await sendMail(win.email, "You won the auction for " + c.title,
      "Congratulations " + win.name + ",\n\nYour bid of " + money(win.amount) + " won " + c.title + ".\n\n" +
      "Next step: the seller will contact you within 1 business day to open an Escrow.com transaction. Payment must be completed through Escrow.com within 7 days of the auction closing. The property transfers to you when escrow confirms payment.\n");
    await sendMail(SELLER_EMAIL, "[AUCTION ENDED] " + c.title + " won at " + money(win.amount),
      c.title + " closed at " + money(win.amount) + ".\nWinner: " + win.name + (win.company ? " (" + win.company + ")" : "") + "\nEmail: " + win.email + "\nPhone: " + win.phone + "\n\n" +
      "Next: open an Escrow.com transaction with the winner. If the winner does not pay within 7 days, offer it to the next-highest bidder. Full bid list and next steps: " + PUBLIC_BASE_URL + "/admin\n");
    for (const [email, nm] of others) {
      await sendMail(email, "Auction ended: " + c.title, "Hello " + nm + ",\n\nThe auction for " + c.title + " has ended, and your bid was not the winning bid. Thank you for taking part.\n");
    }
  }
}
if (!process.env.NO_TIMER) setInterval(() => finalizeEnded().catch((e) => console.error(e)), 60 * 1000);

if (TEST_MODE) {
  app.get("/test/outbox", (_req, res) => res.json(outbox));
  app.post("/test/time", express.json(), (req, res) => { // fast-forward helper: shifts stored timestamps back
    const ms = Number(req.body.shiftBackMs || 0);
    db.prepare("UPDATE state SET started_at=started_at-?, ends_at=ends_at-? WHERE started_at IS NOT NULL").run(ms, ms);
    db.prepare("UPDATE bids SET created_at=created_at-?, verified_at=verified_at-? WHERE verified_at IS NOT NULL").run(ms, ms);
    res.json({ ok: true });
  });
  app.post("/test/finalize", async (_req, res) => { await finalizeEnded(); res.json({ ok: true }); });
}

if (require.main === module) {
  app.listen(PORT, () => console.log("Auction service listening on " + PORT));
}
module.exports = { app };
