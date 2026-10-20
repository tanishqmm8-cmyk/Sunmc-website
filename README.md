# Sunmc Website App — Full Store (Node.js + Express)

The Sunmc Minecraft server store with a **real backend**: players pay via UPI,
**upload their payment screenshot** on the site, and the owner reviews orders in
an admin dashboard before granting ranks in-game.

## Features

- Public store: hero with copyable server IP, How to Join (Java / Bedrock),
  Features, Ranks & Kits (MVP ₹39, VIP ₹79, Void ₹129, Gangster ₹159, Warden ₹199)
- Buy flow: details form → UPI QR payment screen → **payment screenshot upload**
  (required, image ≤ 8 MB) + optional UPI Transaction ID (UTR) → honest success screen
- Admin dashboard at `/admin` (password login): orders newest first, screenshot
  thumbnails, "Mark Delivered" button
- Storage: **Firestore `orders` collection only** (via `firebase-admin`,
  server-side only). The payment screenshot is compressed in the server
  (max 1000px wide, JPEG) and stored **inside the order document** as a base64
  data URL. **No Firebase Storage, no Blaze plan, no billing — everything runs
  on the free Spark plan.** Falls back to local `data/` files when no Firebase
  config is present (local development only).

## Run locally

```bash
npm install
node server.js            # http://localhost:3000
```

Without env vars the app runs in **LOCAL MODE** (orders in `data/orders.json`,
screenshots in `data/uploads/`, admin password `sunmc-admin`) — for testing only.

## Deploy on Render

1. **Push to GitHub** — create a repo and push this folder:
   ```bash
   git init && git add . && git commit -m "Sunmc store" && git push
   ```
   (`node_modules/` and `data/` are git-ignored — do not commit them, and never
   commit any service-account file.)

2. **Create the Web Service** — Render dashboard → **New + → Web Service** →
   connect the GitHub repo:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Instance type: Free is fine to start.

3. **Environment variables** (Render → your service → Environment):
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — the **entire contents** of your Firebase
     service account JSON, pasted as one value. (Firebase console → Project
     Settings → Service accounts → Generate new private key.) Keep this secret —
     it is server-side only and is never sent to the browser.
   - `ADMIN_PASSWORD` — a strong password for the `/admin` dashboard.
     (Do **not** leave it as the local default `sunmc-admin`.)
   - Optional: `SESSION_SECRET` — any long random string.

4. Deploy. Your site will be live at `https://<your-service>.onrender.com`.

> **No billing needed:** this app uses **only Firestore**, which is free on the
> Spark plan. Firebase Storage is deliberately **not** used — it requires the
> Blaze (billing) plan. Because Firestore documents are limited to ~1 MB, the
> server compresses every payment screenshot (resize to max 1000px wide, JPEG
> quality ~65, stepping down if required) before storing it as base64 inside
> the order document.

> Note: Render's free tier sleeps after inactivity, so the first visit after a
> break can take ~30–60 seconds to wake up.

## How orders work

1. Player buys a rank → pays the UPI QR → uploads the payment screenshot (+ UTR).
2. Order appears in `/admin` as **pending**.
3. Owner checks the payment in their UPI app (match amount + UTR/name), grants
   the rank in-game, and clicks **Mark Delivered**.

Payments are **not** auto-verified (UPI has no public verification API for
personal accounts) — the screenshot + UTR is the verification material.
