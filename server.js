// Static server for the Redo International Returns free-trial landing page.
//
// The site is published at redo.com/international-returns-free-trial via a
// Cloudflare reverse proxy that PRESERVES the path prefix, so Railway receives
// requests under /international-returns-free-trial/*. We mount the static files
// at that same subpath so the on-disk layout matches the public URL exactly.
//
// It also proxies free-trial signups to HubSpot: the browser POSTs to
// `${BASE}/api/trial-signup`, we verify a Cloudflare Turnstile token + apply
// per-IP rate limiting server-side, and only then forward to HubSpot. The
// HubSpot portal/form IDs live in env vars and never reach the client, so the
// public api.hsforms.com endpoint bots were POSTing to directly is gone.
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "/international-returns-free-trial";

// --- Config (all secrets/IDs come from the environment, never the client) ---
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || "";   // public, exposed via config.js
const TURNSTILE_SECRET   = process.env.TURNSTILE_SECRET   || "";   // private, server-only
const HS_PORTAL          = process.env.HS_PORTAL          || "";
const HS_FORM            = process.env.HS_FORM            || "";
// The booking calendar URL is returned to the browser ONLY after a submission
// passes Turnstile + validation — it is never in the page source, so bots can't
// scrape it. Set BOOKING_URL in Railway; rotating the meeting-link slug there
// (without a code change) kills any slug bots have cached. Falls back to the
// current link so a deploy before the env var is set doesn't dead-end the flow.
// All leads route to Mike's calendar now (was Dom's).
const BOOKING_URL        = process.env.BOOKING_URL || "https://meetings.hubspot.com/michael-rose4/mikes-calendar-link";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// HubSpot property internal names + object types (mirrors the old client mapping):
//   - orders_last_year lives on the Company object   (objectTypeId 0-2)
//   - how_did_you_hear_about_us lives on the Contact (objectTypeId 0-1)
const PROP_ORDER_VOLUME = "orders_last_year";
const PROP_HDYHAU       = "how_did_you_hear_about_us";

// Minimum seconds a real human needs to fill the form. Bots submit instantly.
const MIN_FILL_MS = 3000;

// --- Simple in-memory per-IP rate limiter (fixed window) ---
// Railway runs a single instance, so an in-memory counter is sufficient. If this
// ever scales horizontally, move this to a shared store (Redis).
const RATE_MAX = 5;               // max submissions...
const RATE_WINDOW_MS = 60 * 60e3; // ...per IP per hour
const rateHits = new Map();       // ip -> { count, resetAt }

function rateLimited(ip) {
  const now = Date.now();
  const entry = rateHits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

// Opportunistically evict expired buckets so the map can't grow unbounded.
function sweepRateBuckets() {
  const now = Date.now();
  for (const [ip, entry] of rateHits) {
    if (now > entry.resetAt) rateHits.delete(ip);
  }
}

// Behind Cloudflare + Railway, the real client IP is in these headers, not req.ip.
function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    ""
  );
}

// Pull the HubSpot tracking cookie from the request so HubSpot's own spam
// scoring + session attribution work. It's sent automatically because the
// endpoint is same-origin with the page.
function hutkFromCookie(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)hubspotutk=([^;]+)/);
  return m ? m[1] : "";
}

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) {
    // Fail closed: a missing secret means the gate isn't configured, and we must
    // not silently run an unprotected endpoint. Surfaces loudly in the logs.
    console.error("TURNSTILE_SECRET is not set — rejecting submission.");
    return false;
  }
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token || "" });
    if (ip) body.set("remoteip", ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    if (!data.success) console.warn("Turnstile verification failed:", data["error-codes"]);
    return !!data.success;
  } catch (err) {
    console.error("Turnstile verification error:", err);
    return false; // fail closed on network/verify errors
  }
}

// Block internals before the static handler runs.
const HIDDEN_FILES = new Set(["server.js", "package.json", "package-lock.json"]);
app.use(BASE, (req, res, next) => {
  const segments = req.path.split("/").filter(Boolean);
  if (segments.includes("node_modules") || HIDDEN_FILES.has(path.basename(req.path))) {
    return res.status(404).end();
  }
  next();
});

// Expose ONLY the public Turnstile site key to the browser. No secret here.
app.get(`${BASE}/config.js`, (req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-store");
  res.send(
    "window.__TRIAL_CFG__ = " +
      JSON.stringify({ turnstileSiteKey: TURNSTILE_SITE_KEY }) +
      ";"
  );
});

// --- The proxied signup endpoint ---
app.post(`${BASE}/api/trial-signup`, express.json({ limit: "16kb" }), async (req, res) => {
  const ip = clientIp(req);
  const b = req.body || {};

  // 1. Honeypot: hidden field a human never fills. Silent 200 so bots learn nothing.
  if (b.website) return res.status(200).json({ ok: true });

  // 2. Time trap: submitted implausibly fast after page load.
  const elapsed = Number(b.elapsedMs);
  if (Number.isFinite(elapsed) && elapsed < MIN_FILL_MS) {
    return res.status(200).json({ ok: true });
  }

  // 3. Rate limit per IP.
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }
  if (rateHits.size > 5000) sweepRateBuckets();

  // 4. Turnstile — the real gate. Everything above is cheap pre-filtering.
  //    Enforced only when a secret is configured. Without one we run in DEGRADED
  //    mode (rate limit + honeypot + timing + validation only) so the form still
  //    works before Turnstile keys exist — set TURNSTILE_SECRET to lock it down.
  if (TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(b.turnstileToken, ip);
    if (!ok) return res.status(403).json({ ok: false, error: "captcha_failed" });
  }

  // 5. Server-side validation of required fields (never trust the client).
  const required = ["firstName", "lastName", "company", "email", "annualOrderVolume"];
  for (const f of required) {
    if (!String(b[f] || "").trim()) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(b.email).trim())) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }

  if (!HS_PORTAL || !HS_FORM) {
    console.error("HS_PORTAL / HS_FORM not set — cannot forward to HubSpot.");
    return res.status(500).json({ ok: false, error: "not_configured" });
  }

  // 6. Build the HubSpot payload and forward.
  const allFields = [
    { objectTypeId: "0-1", name: "firstname",       value: b.firstName },
    { objectTypeId: "0-1", name: "lastname",        value: b.lastName },
    { objectTypeId: "0-1", name: "email",           value: b.email },
    { objectTypeId: "0-1", name: "company",         value: b.company },
    { objectTypeId: "0-1", name: "phone",           value: b.phone },
    { objectTypeId: "0-2", name: PROP_ORDER_VOLUME, value: b.annualOrderVolume },
    { objectTypeId: "0-1", name: PROP_HDYHAU,       value: b.hdyhau },
    { objectTypeId: "0-1", name: "utm_source",      value: b.utm_source },
    { objectTypeId: "0-1", name: "utm_medium",      value: b.utm_medium },
    { objectTypeId: "0-1", name: "utm_campaign",    value: b.utm_campaign },
  ];
  const fields = allFields
    .map((f) => ({ ...f, value: String(f.value == null ? "" : f.value).trim() }))
    .filter((f) => f.value !== "");

  const context = {};
  const hutk = hutkFromCookie(req);
  if (hutk) context.hutk = hutk;
  if (ip) context.ipAddress = ip;           // strengthens HubSpot's spam scoring
  if (b.pageUri) context.pageUri = b.pageUri;
  if (b.pageName) context.pageName = b.pageName;

  try {
    const hsRes = await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${HS_PORTAL}/${HS_FORM}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields, context }),
      }
    );
    if (!hsRes.ok) {
      const text = await hsRes.text();
      console.error("HubSpot submission failed:", hsRes.status, text);
      return res.status(502).json({ ok: false, error: "hubspot_error" });
    }
  } catch (err) {
    console.error("HubSpot submission error:", err);
    return res.status(502).json({ ok: false, error: "hubspot_error" });
  }

  // Verified submission — only now do we hand back the booking URL.
  return res.status(200).json({ ok: true, bookingUrl: BOOKING_URL });
});

app.use(BASE, express.static(__dirname, { extensions: ["html"] }));

// Convenience: bare domain root -> the landing page.
app.get("/", (req, res) => res.redirect(302, BASE + "/"));

// Health check for Railway.
app.get("/healthz", (req, res) => res.type("text").send("ok"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving ${BASE}/ on port ${PORT}`);
  if (!HS_PORTAL || !HS_FORM) {
    console.warn(
      "WARNING: HS_PORTAL / HS_FORM not set — signups will be REJECTED until configured."
    );
  }
  if (!TURNSTILE_SECRET) {
    console.warn(
      "WARNING: TURNSTILE_SECRET not set — running in DEGRADED mode (no CAPTCHA). " +
        "Rate-limit + honeypot + timing still apply. Set TURNSTILE_SITE_KEY + TURNSTILE_SECRET to enable Turnstile."
    );
  }
});
