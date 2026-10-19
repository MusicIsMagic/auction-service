(function () {
  "use strict";
  var CFG = window.SITE_CONFIG || {};
  var API = (CFG.AUCTION_API || "").replace(/\/$/, "");
  var ID = CFG.AUCTION_ID || "";
  var panel = document.getElementById("auction-panel");
  if (!panel) return;

  var els = {
    status: document.getElementById("a-status"),
    label: document.getElementById("a-label"),
    amount: document.getElementById("a-amount"),
    clockLabel: document.getElementById("a-clock-label"),
    clock: document.getElementById("a-clock"),
    meta: document.getElementById("a-meta"),
    history: document.getElementById("a-history"),
    historyWrap: document.getElementById("a-history-wrap"),
    banner: document.getElementById("a-banner"),
    form: document.getElementById("bid-form"),
    formWrap: document.getElementById("bid-form-wrap"),
    closed: document.getElementById("a-closed"),
    min: document.getElementById("a-min"),
    amountInput: document.getElementById("bid-amount")
  };

  var state = null, offset = 0;

  function money(n) { return "$" + Number(n).toLocaleString("en-US"); }
  function fmtDate(ms) {
    try { return new Date(ms).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" }); }
    catch (e) { return new Date(ms).toString(); }
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function countdown(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return d + "d " + pad(h) + "h " + pad(m) + "m " + pad(x) + "s";
  }
  function showBanner(text, kind) {
    els.banner.textContent = text;
    els.banner.className = "a-banner is-" + kind;
    els.banner.hidden = false;
  }

  /* return trip from the email confirmation link */
  var q = new URLSearchParams(window.location.search);
  if (q.get("confirmed") === "1") showBanner("Your bid is confirmed and counts. Thank you. You will get an email if someone outbids you.", "ok");
  else if (q.get("confirmed") === "0") {
    var why = { outbid: "Someone placed a higher confirmed bid before you confirmed yours, so your bid did not count. You can bid again below.", expired: "That confirmation link expired. Please place your bid again.", closed: "Bidding closed before your bid was confirmed." };
    showBanner(why[q.get("reason")] || "That bid could not be confirmed.", "warn");
  }

  function render() {
    if (!state) return;
    var now = Date.now() + offset;
    var st = state.status;
    var label = { not_started: "Opens soon", open: "Open for bids", running: "Bidding is live", ended: "Auction ended", cancelled: "Auction cancelled" }[st] || "";
    els.status.textContent = label;
    els.status.className = "a-status is-" + st;

    if (state.currentBid) {
      els.label.textContent = st === "ended" ? "Winning bid" : "Current high bid";
      els.amount.textContent = money(state.currentBid);
    } else {
      els.label.textContent = "Minimum opening bid";
      els.amount.textContent = money(state.minBid);
    }

    if (st === "running") {
      els.clockLabel.textContent = "Time remaining";
      els.clock.textContent = countdown(state.endsAt - now);
      els.meta.textContent = "Scheduled to close " + fmtDate(state.endsAt) + ". A bid in the final " + state.softCloseHours + " hours moves the close to " + state.softCloseHours + " hours after that bid.";
    } else if (st === "open") {
      els.clockLabel.textContent = "The clock starts at the first bid";
      els.clock.textContent = state.durationDays + " days";
      els.meta.textContent = "The first confirmed bid of at least " + money(state.minBid) + " starts a " + state.durationDays + "-day countdown.";
    } else if (st === "cancelled") {
      els.clockLabel.textContent = "";
      els.clock.textContent = "";
      els.meta.textContent = "The owner has cancelled this auction. No sale will be made.";
    } else if (st === "ended") {
      els.clockLabel.textContent = "Closed";
      els.clock.textContent = state.endsAt ? fmtDate(state.endsAt) : "No bids were placed";
      els.meta.textContent = "";
    } else {
      els.clockLabel.textContent = "Opens";
      els.clock.textContent = state.opensAt ? fmtDate(Date.parse(state.opensAt)) : "Soon";
      els.meta.textContent = "";
    }

    var live = st === "running" || st === "open";
    els.formWrap.hidden = !live;
    els.closed.hidden = live;
    els.closed.textContent = st === "cancelled" ? "This auction has been cancelled." : st === "ended" ? "Bidding has ended." : "Bidding is not open right now.";
    if (live) {
      els.min.textContent = money(state.nextMinBid);
      els.amountInput.setAttribute("min", state.nextMinBid);
      els.amountInput.placeholder = String(state.nextMinBid);
    }

    var cta = document.getElementById("a-cta");
    if (cta) {
      if (live) { cta.textContent = "Place a bid"; cta.setAttribute("href", "#bid-form-wrap"); cta.hidden = false; }
      else if (st === "ended" || st === "cancelled") { cta.hidden = true; }
      else { cta.textContent = "Bidding opens soon"; cta.setAttribute("href", "#auction-panel"); cta.hidden = false; }
    }

    var rm = document.getElementById("a-removed");
    if (rm) { rm.hidden = !state.removedBids; rm.textContent = state.removedBids ? state.removedBids + " bid" + (state.removedBids === 1 ? " was" : "s were") + " removed by the owner (for example, a bidder who could not be reached)." : ""; }
    els.historyWrap.hidden = !state.history.length && !state.removedBids;
    els.history.innerHTML = "";
    state.history.forEach(function (h) {
      var li = document.createElement("li");
      var a = document.createElement("span"); a.textContent = money(h.amount);
      var b = document.createElement("span"); b.textContent = h.bidder + " · " + fmtDate(h.at);
      li.appendChild(a); li.appendChild(b); els.history.appendChild(li);
    });
  }

  function load() {
    if (!API || !ID) { unavailable(); return; }
    fetch(API + "/api/auctions/" + encodeURIComponent(ID), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("bad"); return r.json(); })
      .then(function (s) { state = s; offset = s.serverTime - Date.now(); render(); })
      .catch(function () { if (!state) unavailable(); });
  }
  function unavailable() {
    var c2 = document.getElementById("a-cta");
    if (c2) { c2.textContent = "Bidding opens soon"; c2.setAttribute("href", "#auction-panel"); }
    els.status.textContent = "Opening soon";
    els.status.className = "a-status is-not_started";
    els.label.textContent = "Bidding";
    els.amount.textContent = "Opens soon";
    els.clockLabel.textContent = "";
    els.clock.textContent = "";
    els.meta.textContent = "Live bidding is not open yet. Check back shortly.";
    els.formWrap.hidden = true;
    els.closed.hidden = true;
  }

  load();
  setInterval(load, 20000);
  setInterval(function () { if (state && state.status === "running") render(); }, 1000);

  /* ---------- bid form ---------- */
  var statusEl = document.getElementById("bid-status");
  els.form.addEventListener("submit", function (e) {
    e.preventDefault();
    statusEl.className = "form-status"; statusEl.textContent = "";
    var f = els.form;
    var amount = parseInt(String(f.amount.value).replace(/[^0-9]/g, ""), 10);
    var body = {
      name: f.name.value, company: f.company.value, email: f.email.value, phone: f.phone.value,
      amount: amount, acceptTerms: f.terms.checked, website: f.website.value
    };
    if (!body.name.trim() || !body.email.trim() || !body.phone.trim() || !amount) {
      statusEl.className = "form-status is-error"; statusEl.textContent = "Please fill in your name, email, phone, and bid amount."; return;
    }
    if (!body.acceptTerms) { statusEl.className = "form-status is-error"; statusEl.textContent = "Please accept the auction terms."; return; }
    if (state && amount < state.nextMinBid) { statusEl.className = "form-status is-error"; statusEl.textContent = "Your bid must be at least " + money(state.nextMinBid) + "."; return; }
    if (!window.confirm("You are about to bid " + money(amount) + ". A confirmed bid is binding. Continue?")) return;
    var btn = f.querySelector("button[type=submit]"); btn.disabled = true;
    fetch(API + "/api/auctions/" + encodeURIComponent(ID) + "/bids", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        btn.disabled = false;
        if (res.ok) {
          statusEl.className = "form-status is-ok";
          statusEl.textContent = res.j.message || "Check your email to confirm your bid.";
          f.amount.value = "";
        } else {
          statusEl.className = "form-status is-error";
          statusEl.textContent = res.j.error || "Your bid could not be submitted.";
          if (res.j.nextMinBid) load();
        }
      }).catch(function () {
        btn.disabled = false;
        statusEl.className = "form-status is-error";
        statusEl.textContent = "Could not reach the auction. Please try again in a moment.";
      });
  });

  /* ---------- question form (Web3Forms, same key as the lead form) ---------- */
  var qf = document.getElementById("ask-form");
  if (qf) {
    qf.addEventListener("submit", function (e) {
      e.preventDefault();
      var st = document.getElementById("ask-status");
      var key = CFG.WEB3FORMS_ACCESS_KEY;
      if (!key || key.indexOf("PASTE") === 0) { st.className = "form-status is-error"; st.textContent = "Questions are not enabled yet."; return; }
      var fd = new FormData(qf); fd.append("access_key", key);
      fd.append("subject", "Auction question: " + (CFG.SITE_NAME || ""));
      fd.append("from_name", CFG.SITE_NAME || "Auction");
      st.className = "form-status"; st.textContent = "Sending...";
      fetch("https://api.web3forms.com/submit", { method: "POST", body: fd })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.success) { st.className = "form-status is-ok"; st.textContent = "Thanks. We will reply by email."; qf.reset(); }
          else { st.className = "form-status is-error"; st.textContent = "Could not send. Please try again."; }
        }).catch(function () { st.className = "form-status is-error"; st.textContent = "Could not send. Please try again."; });
    });
  }
})();
