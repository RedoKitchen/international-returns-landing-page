// Static server for the Redo International Returns free-trial landing page.
//
// The site is published at redo.com/international-returns via a reverse
// proxy. Everything is mounted at BOTH the /international-returns prefix and
// the bare root, and every URL in the page is relative, so the app works
// whether the proxy preserves or strips the prefix, and when the Railway
// domain is hit directly.
//
// It also proxies free-trial signups to HubSpot: the browser POSTs to
// `${BASE}/api/trial-signup`, we verify a Cloudflare Turnstile token + apply
// per-IP rate limiting server-side, and only then forward to HubSpot. The
// HubSpot portal/form IDs live in env vars and never reach the client, so the
// public api.hsforms.com endpoint bots were POSTing to directly is gone.
const express = require("express");
const path = require("path");

const app = express();
app.set("trust proxy", true);
const PORT = process.env.PORT || 3000;
const BASE = "/international-returns";

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

// Field mapping mirrors the real IR HubSpot form (see its share page):
//   - firstname, email + attribution fields live on the Contact (objectTypeId 0-1)
//   - the website URL maps to Company DOMAIN, and orders_last_year is also
//     on the Company object (objectTypeId 0-2) — same pattern as other Redo forms
// The form also carries hidden paid-attribution fields (utm_*, fbclid,
// li_fat_id, rdt_cid) which the page forwards from ad URLs.

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
app.use((req, res, next) => {
  const segments = req.path.split("/").filter(Boolean);
  if (segments.includes("node_modules") || HIDDEN_FILES.has(path.basename(req.path))) {
    return res.status(404).end();
  }
  next();
});

// Expose ONLY the public Turnstile site key to the browser. No secret here.
function serveConfig(req, res) {
  res.type("application/javascript").set("Cache-Control", "no-store");
  res.send(
    "window.__TRIAL_CFG__ = " +
      JSON.stringify({ turnstileSiteKey: TURNSTILE_SITE_KEY }) +
      ";"
  );
}
app.get(`${BASE}/config.js`, serveConfig);
app.get("/config.js", serveConfig);

// --- The proxied signup endpoint ---
const trialSignup = async (req, res) => {
  const ip = clientIp(req);
  const b = req.body || {};

  // 1. Honeypot: hidden "fax" field a human never fills. ("website" is a REAL,
  //    visible field on this form — do NOT treat it as the honeypot.)
  //    Silent 200 so bots learn nothing.
  if (b.fax) return res.status(200).json({ ok: true });

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
  const required = ["name", "email", "website", "orders"];
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
    { objectTypeId: "0-1", name: "firstname",        value: b.name },
    { objectTypeId: "0-1", name: "email",            value: b.email },
    { objectTypeId: "0-1", name: "phone",            value: b.phone },
    { objectTypeId: "0-2", name: "domain",           value: b.website },
    { objectTypeId: "0-2", name: "orders_last_year", value: b.orders },
    { objectTypeId: "0-1", name: "utm_source",       value: b.utm_source },
    { objectTypeId: "0-1", name: "utm_medium",       value: b.utm_medium },
    { objectTypeId: "0-1", name: "utm_campaign",     value: b.utm_campaign },
    { objectTypeId: "0-1", name: "utm_content",      value: b.utm_content },
    { objectTypeId: "0-1", name: "utm_product",      value: b.utm_product || "International Returns" },
    { objectTypeId: "0-1", name: "fbclid",           value: b.fbclid },
    { objectTypeId: "0-1", name: "li_fat_id",        value: b.li_fat_id },
    { objectTypeId: "0-1", name: "rdt_cid",          value: b.rdt_cid },
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

  let redirectUri = "";
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
    // The form carries Logic rules (SMB / Growth / Mid Market / AU-NZ) that pick
    // the right calendar per submission. HubSpot computes them server-side and
    // returns the winner as redirectUri — honor it so the routing stays in
    // HubSpot's hands. BOOKING_URL is only the fallback when no rule matches.
    try {
      const hsData = await hsRes.json();
      if (hsData && typeof hsData.redirectUri === "string" && hsData.redirectUri) {
        redirectUri = hsData.redirectUri;
      }
    } catch (_) { /* no JSON body — fall through to the fallback */ }
  } catch (err) {
    console.error("HubSpot submission error:", err);
    return res.status(502).json({ ok: false, error: "hubspot_error" });
  }

  // Verified submission — hand back the rule-chosen calendar, or the fallback.
  return res.status(200).json({ ok: true, bookingUrl: redirectUri || BOOKING_URL });
};
app.post(`${BASE}/api/trial-signup`, express.json({ limit: "16kb" }), trialSignup);
app.post("/api/trial-signup", express.json({ limit: "16kb" }), trialSignup);

// --- HTML: inject a <base> so relative URLs resolve no matter how the proxy
// --- rewrites the path (and even without a trailing slash on the URL).
const fs = require("fs");
const INDEX_PATH = path.join(__dirname, "index.html");
let indexRaw = null;
function renderIndex(baseHref) {
  if (indexRaw === null) indexRaw = fs.readFileSync(INDEX_PATH, "utf8");
  return indexRaw.replace(/<head>/i, `<head>\n<base href="${baseHref}">`);
}
function sendIndex(baseHref) {
  return (req, res) => {
    res.type("html").set("Cache-Control", "no-cache");
    res.send(renderIndex(baseHref));
  };
}
// Prefix mount: the proxy kept /international-returns on the way in.
app.get([BASE, `${BASE}/`, `${BASE}/index.html`], sendIndex(`${BASE}/`));
// Root mount: the proxy stripped the prefix, or Railway was hit directly.
app.get(["/", "/index.html"], sendIndex("/"));

app.use(BASE, express.static(__dirname, { extensions: ["html"] }));
app.use("/", express.static(__dirname, { extensions: ["html"] }));

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
