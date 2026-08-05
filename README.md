# Redo International Returns — landing page

The Shipping free-trial landing page design ([Shipping-Free-Trial-Landing-Page](https://github.com/RedoMarketing/Shipping-Free-Trial-Landing-Page)) carrying International Returns content (sourced from marketing's IR-LP-V4 information doc). Same layout, same components, same bot defense: server-proxied form, Cloudflare Turnstile, honeypot, per-IP rate limit, timing check, booking URL hidden until a verified submission.

## Pages

| File | Purpose |
| --- | --- |
| `index.html` | The whole page (V4 structure in the shipping design system): rotating hero, pillar cards, pain cards, EU hub map, carrier grid, customs mock, localized-portal demo, savings calculator, buyback band, demo form. |
| `server.js` | Express server. Serves the site under `/international-returns-free-trial/` and proxies `api/trial-signup` to HubSpot behind the defense stack. |

## The form (demo request, not account signup)

Fields mirror the real IR HubSpot form: name, business email, website URL (maps to Company `domain`), international orders last year (select, maps to Company `orders_last_year`). Hidden paid-attribution params (`utm_*`, `fbclid`, `li_fat_id`, `rdt_cid`) pass through from ad URLs. Notes:

- **The honeypot is `fax`, not `website`** — `website` is a real, visible field on this form. Do not "fix" this back.
- On verified success the server returns `bookingUrl` and the page redirects to the demo calendar. Falls back to Mike's calendar until `BOOKING_URL` is set in Railway.
- All CTAs carry `id="get-started"` (intentionally duplicated) for the GTM Click ID trigger.

## Before launch ([CONFIRM] markers in server.js)

1. Content numbers to confirm with marketing (they came from the IR-LP-V4 doc, which flags its own rate-card figures as pre-final): ~70% lower cost per return, $49 vs $15, 3–4 day refunds, $30/order business case, 200+ countries, 4,000+ brands, 800+ reviews.

## Deploy (mirrors the shipping page)

1. **Railway**: new service, `npm start`. Env vars: `HS_PORTAL` + `HS_FORM` (the IR form's portal/GUID — kept out of this public repo on purpose; signups rejected until set), `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` (degraded mode without), `BOOKING_URL`.
2. **Cloudflare**: proxy `redo.com/international-returns-free-trial/*` to the service, preserving the path prefix.

## Local dev

```bash
npm install && npm start
```

Open `http://localhost:3000/international-returns-free-trial/`. Without env vars, valid submissions 500 with `not_configured` (by design).
