# Redo International Returns — free-trial landing page

Clone of the Shipping free-trial landing page ([Shipping-Free-Trial-Landing-Page](https://github.com/RedoMarketing/Shipping-Free-Trial-Landing-Page)) with copy adapted for International Returns. Same design system, same bot defense, same deploy shape.

## Pages

| File | Purpose |
| --- | --- |
| `index.html` | Landing page: hero, integrations, brand marquee, why-cards, feature carousel, stats, embedded signup form. |
| `free-trial.html` | Dedicated signup page (side rail + form). |
| `server.js` | Express server. Serves the static site under `/international-returns-free-trial/` and proxies signups to HubSpot behind Turnstile + rate limiting + honeypot + timing checks. |

## Deploy (mirrors the shipping page exactly)

1. **Railway**: new service off this repo (`npm start`). Set env vars:
   - `HS_PORTAL` / `HS_FORM` — the HubSpot form for International Returns leads (signups are **rejected** until these are set)
   - `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` — Turnstile widget for the domain (runs in degraded mode without them: rate limit + honeypot + timing only)
   - `BOOKING_URL` — where verified leads get redirected (falls back to Mike's calendar)
2. **Cloudflare**: proxy rule routing `redo.com/international-returns-free-trial/*` to the Railway service, preserving the path prefix.

The booking URL and HubSpot IDs never appear in client code. The server returns the booking URL only after a verified submission.

## GTM

All CTAs carry `id="get-started"` (intentionally duplicated) to match the existing GTM Click ID trigger.

## Local dev

```bash
npm install && npm start
```

Then open `http://localhost:3000/international-returns-free-trial/`. Without env vars the form path runs in degraded mode and signups 500 with `not_configured` (by design).
