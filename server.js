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
const AUCTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.AUCTIONS_FILE || "auctions.json"), "utf8"));

const db = new Database(path.join(DATA_DIR, "auction.db"));
db.pragma("journal_mode = WAL");
db.exec(`
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

const allOrigins = new Set(Object.values(AUCTIONS).flatMap((a) => a.allowedOrigins || []));
if (TEST_MODE) allOrigins.add("http://localhost:8080");
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && allOrigins.has(o)) {
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

/* ---------- seller view ---------- */
function admin(req, res, next) {
  const t = req.query.token || req.headers["x-admin-token"] || "";
  if (!ADMIN_TOKEN || t.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_TOKEN))) return res.status(401).type("text").send("Unauthorized");
  next();
}
app.get("/admin/:id", admin, (req, res) => {
  const id = req.params.id, c = cfg(id);
  if (!c) return res.status(404).send("Unknown auction.");
  const p = publicState(id);
  const rows = db.prepare("SELECT * FROM bids WHERE auction_id=? ORDER BY created_at DESC").all(id);
  const tr = rows.map((b) => "<tr><td>" + esc(new Date(b.created_at).toLocaleString("en-US", { timeZone: "America/Phoenix" })) + "</td><td>" + esc(b.status) + (b.reject_reason ? " (" + esc(b.reject_reason) + ")" : "") + "</td><td>" + esc(money(b.amount)) + "</td><td>" + esc(b.name) + "</td><td>" + esc(b.company || "") + "</td><td>" + esc(b.email) + "</td><td>" + esc(b.phone || "") + "</td></tr>").join("");
  res.type("html").send("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>" + esc(c.title) + " bids</title><style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left}</style><h1>" +
    esc(c.title) + "</h1><p>Status: <b>" + esc(p.status) + "</b> | High bid: <b>" + esc(p.currentBid ? money(p.currentBid) : "none") + "</b> | Closes: " + esc(p.endsAt ? fmtDate(p.endsAt) : "not started") + "</p><table><tr><th>Entered</th><th>Status</th><th>Amount</th><th>Name</th><th>Company</th><th>Email</th><th>Phone</th></tr>" + tr + "</table>");
});

/* ---------- finalize ended auctions ---------- */
async function finalizeEnded() {
  const now = Date.now();
  for (const id of Object.keys(AUCTIONS)) {
    const c = AUCTIONS[id], s = getState(id);
    if (s.finalized || !s.started_at || now < s.ends_at) continue;
    db.prepare("UPDATE state SET finalized=1 WHERE auction_id=?").run(id);
    const win = highBid(id);
    if (!win) continue;
    const others = new Map();
    verifiedBids(id).forEach((b) => { if (b.email !== win.email) others.set(b.email, b.name); });
    await sendMail(win.email, "You won the auction for " + c.title,
      "Congratulations " + win.name + ",\n\nYour bid of " + money(win.amount) + " won " + c.title + ".\n\n" +
      "Next step: the seller will contact you within 1 business day to open an Escrow.com transaction. Payment must be completed through Escrow.com within 7 days of the auction closing. The property transfers to you when escrow confirms payment.\n");
    await sendMail(SELLER_EMAIL, "[AUCTION ENDED] " + c.title + " won at " + money(win.amount),
      c.title + " closed at " + money(win.amount) + ".\nWinner: " + win.name + (win.company ? " (" + win.company + ")" : "") + "\nEmail: " + win.email + "\nPhone: " + win.phone + "\n\n" +
      "Next: open an Escrow.com transaction with the winner. If the winner does not pay within 7 days, offer it to the next-highest bidder. Full bid list: " + PUBLIC_BASE_URL + "/admin/" + id + "?token=YOUR_ADMIN_TOKEN\n");
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
