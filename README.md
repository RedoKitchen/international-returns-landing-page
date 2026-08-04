# Redo International Returns — landing page

Paid-traffic landing page for International Returns (marketing's IR-LP-V4 design), served behind the same bot-defense architecture as the [Shipping free-trial page](https://github.com/RedoMarketing/Shipping-Free-Trial-Landing-Page): server-proxied form, Cloudflare Turnstile, honeypot, per-IP rate limit, timing check, booking URL hidden until a verified submission.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole page (V4): rotating hero, pillar cards, pain cards, EU hub map, carrier grid, customs mock, localized-portal demo, savings calculator, demo form. Fully self-contained except Google Fonts + Turnstile. |
| `server.js` | Express server. Serves the page under `/international-returns-free-trial/` and proxies `api/trial-signup` to HubSpot behind the defense stack. |

## The form

Fields: full name, business email, website URL, top international market, international orders range. Notes:

- **The honeypot is `fax`, not `website`** — `website` is a real, visible field on this form. Do not "fix" this back.
- The server splits full name into HubSpot `firstname`/`lastname` on the first space.
- On verified success the server returns `bookingUrl` and the page redirects to the demo calendar (family pattern). If `bookingUrl` were ever absent, the page falls back to the V4 inline thank-you state.
- Successful submits push `{event: "ir_demo_request"}` to the GTM dataLayer.

## Before launch ([CONFIRM] markers in the code)

1. **HubSpot property names**: `top_international_market` and `international_orders_last_year` in `server.js` are placeholders — match them to the internal property names on the HubSpot form marketing creates, or edit them there.
2. The V4 design itself carries `[CONFIRM]` / `[WEBFLOW: LOGOS]` comments from marketing (rate-card figures, carrier logo permissions, broker list). Resolve those before paid traffic hits it.

## Deploy (mirrors the shipping page)

1. **Railway**: new service, `npm start`. Env vars: `HS_PORTAL`, `HS_FORM` (signups rejected until set), `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` (degraded mode without), `BOOKING_URL` (falls back to Mike's calendar).
2. **Cloudflare**: proxy `redo.com/international-returns-free-trial/*` to the service, preserving the path prefix.

## Local dev

```bash
npm install && npm start
```

Open `http://localhost:3000/international-returns-free-trial/`. Without env vars, valid submissions 500 with `not_configured` (by design).
