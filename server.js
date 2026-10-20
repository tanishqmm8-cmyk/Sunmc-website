// Sunmc Minecraft server store — Express app with real backend.
// Orders are stored in the Firestore "orders" collection when
// FIREBASE_SERVICE_ACCOUNT_JSON is set, otherwise locally in ./data/ (LOCAL MODE).
// The payment screenshot is compressed and stored INSIDE the Firestore order
// document as a base64 data URL — Firebase Storage is NOT used, because it
// requires the paid Blaze plan. Everything runs on the free Spark plan.

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------- Config
const DISCORD_INVITE = 'https://discord.gg/T64jYftQJE';
const SERVER_IP = 'play.sunmc.bond';
const BEDROCK_PORT = '19133';

const RANKS = {
  MVP:      { price: 39,  label: 'MVP' },
  VIP:      { price: 79,  label: 'VIP' },
  Void:     { price: 129, label: 'Void' },
  Gangster: { price: 159, label: 'Gangster' },
  Warden:   { price: 199, label: 'Warden', top: true },
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sunmc-admin';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[WARN] ADMIN_PASSWORD not set — using default "sunmc-admin". CHANGE THIS before deploying!');
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ------------------------------------------------- Storage abstraction
// useFirebase === true  -> Firestore "orders" collection; the screenshot is
//                          compressed and stored inside the order document as
//                          a base64 data URL (field "screenshotData"). Firebase
//                          Storage is never used (it needs the Blaze plan).
// useFirebase === false -> ./data/orders.json + ./data/uploads/  (LOCAL MODE)
// listOrders() normalizes both into one field, "screenshotSrc", which the
// admin template uses directly as the <img> src (data URL or /uploads/ URL).
let useFirebase = false;
let db = null;
let admin = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    admin = require('firebase-admin');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    useFirebase = true;
    console.log('[OK] Firebase mode: Firestore connected (screenshots stored inside order docs).');
  } catch (e) {
    console.error('[ERROR] FIREBASE_SERVICE_ACCOUNT_JSON invalid — falling back to LOCAL MODE:', e.message);
  }
}

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!useFirebase) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
  console.warn('*** LOCAL MODE *** Orders go to ./data/orders.json, screenshots to ./data/uploads/.');
}

function readLocalOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeLocalOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Firestore documents are limited to ~1 MB, so in Firebase mode the payment
// screenshot is compressed to JPEG (max 1000px wide, quality ~65, stepping
// down further if needed) and stored inside the order document as a base64
// data URL. Target: base64 string comfortably under ~700 KB.
const Jimp = require('jimp');
const MAX_SCREENSHOT_B64 = 700 * 1024;

async function compressScreenshotToDataUrl(file) {
  let image;
  try {
    image = await Jimp.read(file.buffer);
  } catch (e) {
    const err = new Error('SCREENSHOT_UNREADABLE');
    err.code = 'SCREENSHOT_UNREADABLE';
    throw err;
  }
  const attempts = [
    { width: 1000, quality: 65 },
    { width: 900, quality: 55 },
    { width: 800, quality: 48 },
    { width: 700, quality: 42 },
    { width: 600, quality: 36 },
  ];
  for (const a of attempts) {
    const img = image.clone();
    if (img.bitmap.width > a.width) img.resize(a.width, Jimp.AUTO);
    img.quality(a.quality);
    const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
    const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
    if (dataUrl.length <= MAX_SCREENSHOT_B64) return dataUrl;
  }
  const err = new Error('SCREENSHOT_TOO_BIG');
  err.code = 'SCREENSHOT_TOO_BIG';
  throw err;
}

async function saveOrder({ username, email, rank, price, utr, file }) {
  const orderId = crypto.randomBytes(8).toString('hex');
  const ext = EXT_BY_MIME[file.mimetype] || 'png';
  const createdAt = new Date().toISOString();

  if (useFirebase) {
    // Compress the screenshot and store it INSIDE the Firestore document as a
    // base64 data URL (field screenshotData). Firebase Storage is not used —
    // it requires the Blaze billing plan; Firestore on the free Spark plan is
    // enough because the compressed image fits in the ~1 MB document limit.
    const screenshotData = await compressScreenshotToDataUrl(file);
    const doc = {
      username, email, rank, price,
      utr: utr || '',
      screenshotData,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection('orders').doc(orderId).set(doc);
    return { orderId, createdAt };
  }

  // LOCAL MODE
  const filename = `${orderId}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
  const orders = readLocalOrders();
  orders.push({
    orderId, username, email, rank, price,
    utr: utr || '',
    screenshotUrl: `/uploads/${filename}`,
    status: 'pending',
    createdAt,
  });
  writeLocalOrders(orders);
  return { orderId, createdAt };
}

async function listOrders() {
  if (useFirebase) {
    const snap = await db.collection('orders').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => {
      const v = d.data();
      return {
        orderId: d.id,
        username: v.username, email: v.email, rank: v.rank, price: v.price,
        utr: v.utr || '',
        screenshotSrc: v.screenshotData || v.screenshotUrl || '',
        status: v.status || 'pending',
        createdAt: v.createdAt && v.createdAt.toDate ? v.createdAt.toDate().toISOString() : new Date().toISOString(),
      };
    });
  }
  return readLocalOrders()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map(o => ({ ...o, screenshotSrc: o.screenshotUrl || '' }));
}

async function markDelivered(orderId) {
  if (useFirebase) {
    await db.collection('orders').doc(orderId).update({ status: 'delivered' });
    return;
  }
  const orders = readLocalOrders();
  const o = orders.find(x => x.orderId === orderId);
  if (o) { o.status = 'delivered'; writeLocalOrders(orders); }
}

// ---------------------------------------------------------------- Helpers
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const fmtIST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: true,
});
function ist(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? esc(iso) : fmtIST.format(d);
}

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Sunmc</title>
<style>
/* Sunmc store — dark Minecraft theme, mobile-first */
:root {
  --bg: #14100b;
  --bg2: #1e1811;
  --card: #241c12;
  --border: #3a2c1a;
  --gold: #f5a623;
  --gold2: #ffd166;
  --text: #f2e9d8;
  --muted: #b8a888;
  --green: #7bc96f;
  --red: #e0604f;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif;
  line-height: 1.55;
}
a { color: var(--gold2); }
.wrap { max-width: 1080px; margin: 0 auto; padding: 0 16px; }

/* Header */
header.site {
  background: #0f0c08;
  border-bottom: 2px solid var(--border);
  position: sticky; top: 0; z-index: 50;
}
.nav { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; max-width: 1080px; margin: 0 auto; }
.brand { font-weight: 800; font-size: 22px; letter-spacing: 2px; color: var(--gold); text-decoration: none; }
.brand small { color: var(--muted); font-weight: 400; letter-spacing: 0; font-size: 12px; display: block; }
.navlinks a { color: var(--text); text-decoration: none; margin-left: 14px; font-size: 15px; }
.navlinks a:hover { color: var(--gold2); }

/* Hero */
.hero {
  text-align: center;
  padding: 56px 16px 40px;
  background: radial-gradient(ellipse at 50% 0%, #2b1f0e 0%, var(--bg) 70%);
}
.hero h1 { font-size: clamp(44px, 9vw, 84px); margin: 0; letter-spacing: 6px; color: var(--gold);
  text-shadow: 0 3px 0 #7a4d0c, 0 6px 18px rgba(0,0,0,.6); }
.hero p.sub { color: var(--muted); font-size: 18px; margin: 8px 0 24px; }
.ipbox {
  display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center;
  background: #0f0c08; border: 2px dashed var(--gold); border-radius: 10px; padding: 12px 16px; margin-bottom: 8px;
}
.ipbox code { font-size: 20px; color: var(--gold2); font-weight: 700; }
.ipbox .port { font-size: 15px; color: var(--muted); }
.btn {
  display: inline-block; background: var(--gold); color: #1a1206; font-weight: 800;
  border: none; border-radius: 10px; padding: 13px 26px; font-size: 17px; cursor: pointer;
  text-decoration: none; margin: 8px 4px 0;
}
.btn:hover { background: var(--gold2); }
.btn.ghost { background: transparent; color: var(--gold2); border: 2px solid var(--gold); }
.btn.small { padding: 8px 14px; font-size: 14px; }
.btn.danger { background: var(--red); color: #fff; }

/* Sections */
section.block { padding: 40px 0; }
section.block h2 { text-align: center; color: var(--gold); letter-spacing: 2px; margin-bottom: 20px; font-size: 28px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
.card {
  background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px;
}
.card h3 { margin: 0 0 8px; color: var(--gold2); }
.card p, .card li { color: var(--muted); font-size: 15px; }
.card ol, .card ul { margin: 6px 0; padding-left: 20px; }

/* Ranks */
.rank-card { text-align: center; position: relative; }
.rank-card .price { font-size: 34px; font-weight: 800; color: var(--gold2); margin: 6px 0; }
.rank-card .tier { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
.badge-top {
  position: absolute; top: -10px; right: 12px; background: var(--gold); color: #1a1206;
  font-size: 12px; font-weight: 800; padding: 3px 10px; border-radius: 20px;
}

/* Discord band */
.discord { background: #232b3d; border-top: 2px solid #3b4a6b; border-bottom: 2px solid #3b4a6b; text-align: center; padding: 36px 16px; }
.discord h2 { color: #8fa8ff; }

/* Forms */
.form-card { max-width: 520px; margin: 0 auto; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
label { display: block; margin: 14px 0 4px; font-weight: 600; }
input[type=text], input[type=email], input[type=password], input[type=file] {
  width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border);
  background: #0f0c08; color: var(--text); font-size: 16px;
}
.hint { font-size: 13px; color: var(--muted); }
.qr { display: block; max-width: 260px; width: 80%; margin: 12px auto; border: 6px solid #fff; border-radius: 8px; background: #fff; }
.paybox { text-align: center; }
.error { background: #3a1512; border: 1px solid var(--red); color: #ffd9d2; padding: 12px; border-radius: 8px; margin-bottom: 12px; }
.success-check { font-size: 56px; text-align: center; }

/* Admin */
table.orders { width: 100%; border-collapse: collapse; font-size: 14px; }
table.orders th, table.orders td { border: 1px solid var(--border); padding: 8px; vertical-align: top; text-align: left; }
table.orders th { background: #0f0c08; color: var(--gold2); }
.status-pending { color: var(--gold2); font-weight: 700; }
.status-delivered { color: var(--green); font-weight: 700; }
.thumb { width: 90px; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in; }
#shotModal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.88); z-index: 1000; align-items: center; justify-content: center; padding: 16px; cursor: zoom-out; }
#shotModal img { max-width: 100%; max-height: 100%; border-radius: 8px; }
.adminbar { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 16px; }
.tablewrap { overflow-x: auto; }

footer.site { border-top: 2px solid var(--border); padding: 24px 16px; text-align: center; color: var(--muted); font-size: 14px; }
footer.site a { color: var(--gold2); }

</style>
</head>
<body>
<header class="site">
  <div class="nav">
    <a class="brand" href="/">⛏ SUNMC<small>Survival SMP</small></a>
    <nav class="navlinks">
      <a href="/#join">Join</a>
      <a href="/#ranks">Ranks</a>
      <a href="${DISCORD_INVITE}" target="_blank" rel="noopener">Discord</a>
    </nav>
  </div>
</header>
${body}
<footer class="site">
  <p>Sunmc — Survival SMP · Java + Bedrock crossplay · ${SERVER_IP}</p>
  <p><a href="/admin">Admin</a></p>
</footer>
</body>
</html>`;
}

function homePage() {
  const rankCards = Object.entries(RANKS).map(([name, r]) => `
    <div class="card rank-card">
      ${r.top ? '<span class="badge-top">★ TOP TIER</span>' : ''}
      <div class="tier">${esc(r.label)} Rank + Kit</div>
      <div class="price">₹${r.price}</div>
      <p>Includes the ${esc(r.label)} kit — claim it in-game with <code>/kit</code>.</p>
      <a class="btn" href="/buy/${encodeURIComponent(name)}">Buy Now</a>
    </div>`).join('');

  const body = `
<section class="hero">
  <h1>SUNMC</h1>
  <p class="sub">Survival SMP · Java + Bedrock crossplay</p>
  <div class="ipbox">
    <code id="ip">${SERVER_IP}</code>
    <span class="port">Bedrock port: ${BEDROCK_PORT}</span>
    <button class="btn small" type="button" onclick="copyIp(this)">Copy IP</button>
  </div>
  <div>
    <a class="btn" href="#ranks">Buy a Rank</a>
    <a class="btn ghost" href="${DISCORD_INVITE}" target="_blank" rel="noopener">Join Discord</a>
  </div>
  <script>
    function copyIp(btn){navigator.clipboard.writeText('${SERVER_IP}').then(function(){btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy IP';},1500);});}
  </script>
</section>

<section class="block" id="join">
  <div class="wrap">
    <h2>HOW TO JOIN</h2>
    <div class="cards">
      <div class="card">
        <h3>🖥 Java Edition</h3>
        <ol>
          <li>Open Minecraft → Multiplayer → Add Server</li>
          <li>Server address: <b>${SERVER_IP}</b></li>
          <li>Done — join and play!</li>
        </ol>
      </div>
      <div class="card">
        <h3>📱 Bedrock (Phone / Console)</h3>
        <ol>
          <li>Open Minecraft → Servers → Add Server</li>
          <li>Address: <b>${SERVER_IP}</b></li>
          <li>Port: <b>${BEDROCK_PORT}</b></li>
          <li>Save and join!</li>
        </ol>
      </div>
    </div>
  </div>
</section>

<section class="block">
  <div class="wrap">
    <h2>FEATURES</h2>
    <div class="cards">
      <div class="card"><h3>🌐 Crossplay</h3><p>Java and Bedrock players play together on one server via Geyser.</p></div>
      <div class="card"><h3>⚔️ Survival SMP</h3><p>Classic survival with an active community and regular events.</p></div>
      <div class="card"><h3>🎁 Ranks &amp; Kits</h3><p>Buy a rank and claim its kit in-game with <code>/kit</code>.</p></div>
      <div class="card"><h3>🛒 Shops &amp; Auction House</h3><p>Player shops, an auction house and a thriving in-game economy.</p></div>
      <div class="card"><h3>🌀 RTP &amp; Leaderboards</h3><p>Random teleport to the wild and compete on the leaderboards.</p></div>
      <div class="card"><h3>💬 Active Community</h3><p>Friendly staff and players on our Discord server.</p></div>
    </div>
  </div>
</section>

<section class="block" id="ranks">
  <div class="wrap">
    <h2>RANKS &amp; KITS</h2>
    <p style="text-align:center;color:var(--muted)">Buying a rank gives you its kit too — no Discord needed, buy right here on the website!</p>
    <div class="cards">${rankCards}</div>
  </div>
</section>

<section class="discord">
  <h2>JOIN OUR DISCORD</h2>
  <p style="color:#c9d4f5">Announcements, support and community chat.</p>
  <a class="btn" href="${DISCORD_INVITE}" target="_blank" rel="noopener">discord.gg — Join Sunmc</a>
</section>`;
  return layout('Sunmc — Survival SMP', body);
}

function errorPage(title, msg) {
  return layout(title, `
  <section class="block"><div class="wrap">
    <div class="form-card">
      <div class="error">${esc(msg)}</div>
      <a class="btn" href="/">Back to home</a>
    </div>
  </div></section>`);
}

function buyFormPage(rankName, price, err) {
  const body = `
  <section class="block"><div class="wrap">
    <div class="form-card">
      <h2 style="text-align:center;color:var(--gold2);margin-top:0">Buy ${esc(rankName)} Rank — ₹${price}</h2>
      ${err ? `<div class="error">${esc(err)}</div>` : ''}
      <form method="POST" action="/buy/${encodeURIComponent(rankName)}">
        <label for="username">In-game name (required)</label>
        <input type="text" id="username" name="username" maxlength="32" required placeholder="e.g. DEKU">
        <label for="email">Email (required)</label>
        <input type="email" id="email" name="email" maxlength="120" required placeholder="you@example.com">
        <p class="hint">Apna sahi in-game name daalo — rank usi account pe milega. No Discord needed!</p>
        <button class="btn" type="submit" style="width:100%">Continue to Payment →</button>
      </form>
    </div>
  </div></section>`;
  return layout(`Buy ${rankName}`, body);
}

function paymentPage({ rankName, price, username, email }) {
  const body = `
  <section class="block"><div class="wrap">
    <div class="form-card paybox">
      <h2 style="color:var(--gold2);margin-top:0">Pay ₹${price}</h2>
      <p><b>${esc(rankName)}</b> rank for <b>${esc(username)}</b></p>
      <img class="qr" src="data:image/png;base64,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" alt="UPI QR code">
      <p>GPay / PhonePe / Paytm / Any UPI se scan karke pay karo</p>
      <p style="color:var(--gold2);font-weight:700">Payment ke baad screenshot zaroor lo!</p>
      <hr style="border-color:var(--border)">
      <form method="POST" action="/order" enctype="multipart/form-data" style="text-align:left">
        <input type="hidden" name="username" value="${esc(username)}">
        <input type="hidden" name="email" value="${esc(email)}">
        <input type="hidden" name="rank" value="${esc(rankName)}">
        <label for="screenshot">Upload Payment Screenshot *</label>
        <input type="file" id="screenshot" name="screenshot" accept="image/*" required>
        <p class="hint">Image only (PNG / JPG), max 8 MB. Payment ka screenshot upload karo.</p>
        <label for="utr">UPI Transaction ID / Reference No. (optional)</label>
        <input type="text" id="utr" name="utr" maxlength="64" placeholder="e.g. 432109876543">
        <button class="btn" type="submit" style="width:100%;margin-top:16px">Next — Confirm ✓</button>
      </form>
    </div>
  </div></section>`;
  return layout('Payment', body);
}

function successPage({ rankName, price, username }) {
  const body = `
  <section class="block"><div class="wrap">
    <div class="form-card">
      <div class="success-check">✅</div>
      <h2 style="text-align:center;color:var(--gold2)">Order mil gaya!</h2>
      <p><b>${esc(username)}</b>, tumhara <b>${esc(rankName)}</b> rank (₹${price}) ka order receive ho gaya hai. 🎉</p>
      <p>Tumhara rank <b>payment verify hone ke baad</b> activate hoga — usually <b>a few hours</b> ke andar. Hum pehle payment check karte hain, phir rank lagate hain.</p>
      <p class="hint">Apna UPI Transaction ID aur payment screenshot sambhal ke rakho — kabhi proof chahiye ho toh kaam aayega. Rank na mile toh Discord pe team se baat kar sakte ho: <a href="${DISCORD_INVITE}" target="_blank" rel="noopener">Sunmc Discord</a>.</p>
      <a class="btn" href="/" style="width:100%;text-align:center">Back to Home</a>
    </div>
  </div></section>`;
  return layout('Order Received', body);
}

// ------------------------------------------------------------- Admin views
function adminLoginPage(err) {
  const body = `
  <section class="block"><div class="wrap">
    <div class="form-card">
      <h2 style="text-align:center;color:var(--gold2);margin-top:0">Admin Login</h2>
      ${err ? `<div class="error">${esc(err)}</div>` : ''}
      <form method="POST" action="/admin/login">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required>
        <button class="btn" type="submit" style="width:100%;margin-top:14px">Login</button>
      </form>
    </div>
  </div></section>`;
  return layout('Admin Login', body);
}

function adminDashboardPage(orders) {
  const rows = orders.map(o => `
    <tr>
      <td>${ist(o.createdAt)}</td>
      <td>${esc(o.username)}</td>
      <td>${esc(o.email)}</td>
      <td>${esc(o.rank)}<br>₹${esc(o.price)}</td>
      <td>${esc(o.utr) || '<span class="hint">—</span>'}</td>
      <td>${o.screenshotSrc
        ? `<img class="thumb" src="${esc(o.screenshotSrc)}" alt="payment screenshot" title="Click for full size" onclick="showShot(this.src)">`
        : '<span class="hint">no image</span>'}</td>
      <td class="status-${esc(o.status)}">${esc(o.status)}</td>
      <td>${o.status !== 'delivered'
        ? `<form method="POST" action="/admin/orders/${encodeURIComponent(o.orderId)}/deliver"><button class="btn small" type="submit">Mark Delivered</button></form>`
        : '✓'}</td>
    </tr>`).join('');
  const body = `
  <section class="block"><div class="wrap">
    <div class="adminbar">
      <h2 style="margin:0;color:var(--gold2)">Orders (${orders.length})</h2>
      <span>
        <a class="btn small" href="/admin/orders">⟳ Refresh</a>
        <a class="btn small ghost" href="/admin/logout">Logout</a>
      </span>
    </div>
    <div class="tablewrap">
    <table class="orders">
      <thead><tr><th>Time (IST)</th><th>In-game name</th><th>Email</th><th>Rank</th><th>UTR</th><th>Screenshot</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No orders yet.</td></tr>'}</tbody>
    </table>
    </div>
  </div></section>
  <div id="shotModal" onclick="this.style.display='none'"><img id="shotFull" alt="payment screenshot, full size"></div>
  <script>
    function showShot(src){var m=document.getElementById('shotModal');document.getElementById('shotFull').src=src;m.style.display='flex';}
  </script>`;
  return layout('Admin — Orders', body);
}

// ----------------------------------------------------------------- Routes
app.use(express.urlencoded({ extended: false }));
// (styles and QR are inlined in server.js — no static folder needed)
if (!useFirebase) {
  app.use('/uploads', express.static(UPLOADS_DIR));
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));

app.get('/', (req, res) => res.send(homePage()));

// Step 1: details form
app.get('/buy/:rank', (req, res) => {
  const r = RANKS[req.params.rank];
  if (!r) return res.status(404).send(errorPage('Not found', 'Rank nahi mila.'));
  res.send(buyFormPage(req.params.rank, r.price));
});

// Step 2: payment screen (carries username/email/rank forward)
app.post('/buy/:rank', (req, res) => {
  const rankName = req.params.rank;
  const r = RANKS[rankName];
  if (!r) return res.status(404).send(errorPage('Not found', 'Rank nahi mila.'));
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  if (!username) return res.send(buyFormPage(rankName, r.price, 'In-game name required hai.'));
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.send(buyFormPage(rankName, r.price, 'Sahi email daalo.'));
  }
  res.send(paymentPage({ rankName, price: r.price, username, email }));
});

// Step 3: screenshot upload + order save. Price/rank are derived server-side.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/') && EXT_BY_MIME[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('NOT_IMAGE'));
    }
  },
});

app.post('/order', (req, res) => {
  upload.single('screenshot')(req, res, async (err) => {
    const rankName = String((req.body && req.body.rank) || '').trim();
    const r = RANKS[rankName];
    if (err || !req.file || !r) {
      let msg = 'Order submit nahi ho paya — screenshot dobara try karo (image, max 8 MB).';
      if (err && err.code === 'LIMIT_FILE_SIZE') msg = 'Screenshot bahut bada hai — max 8 MB ki image upload karo.';
      else if (err && err.message === 'NOT_IMAGE') msg = 'Sirf image file upload karo (PNG / JPG).';
      else if (!req.file) msg = 'Payment screenshot upload karna zaroori hai.';
      return res.status(400).send(errorPage('Error', msg));
    }
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim();
    const utr = String(req.body.utr || '').trim();
    if (!username || !email) {
      return res.status(400).send(errorPage('Error', 'In-game name aur email required hain. Pehle step se dobara shuru karo.'));
    }
    try {
      await saveOrder({ username, email, rank: rankName, price: r.price, utr, file: req.file });
      res.send(successPage({ rankName, price: r.price, username }));
    } catch (e) {
      if (e && e.code === 'SCREENSHOT_TOO_BIG') {
        return res.status(400).send(errorPage('Error', 'Screenshot compress karne ke baad bhi bahut bada hai — please ek chhota screenshot upload karo (screenshot ko crop karke ya chhoti image bhej ke dobara try karo).'));
      }
      if (e && e.code === 'SCREENSHOT_UNREADABLE') {
        return res.status(400).send(errorPage('Error', 'Screenshot image khul nahi payi — PNG ya JPG screenshot upload karo.'));
      }
      console.error('saveOrder failed:', e);
      res.status(500).send(errorPage('Error', 'Server error — order save nahi hua. Thodi der baad dobara try karo, ya Discord pe team ko batao.'));
    }
  });
});

// ------------------------------------------------------------------ Admin
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin/orders');
  res.send(adminLoginPage());
});

app.post('/admin/login', (req, res) => {
  const pw = String(req.body.password || '');
  const ok = pw.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
  if (ok) {
    req.session.admin = true;
    return res.redirect('/admin/orders');
  }
  res.status(401).send(adminLoginPage('Galat password — dobara try karo.'));
});

app.get('/admin/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await listOrders();
    res.send(adminDashboardPage(orders));
  } catch (e) {
    console.error('listOrders failed:', e);
    res.status(500).send(errorPage('Error', 'Orders load nahi ho paye.'));
  }
});

app.post('/admin/orders/:id/deliver', requireAdmin, async (req, res) => {
  try {
    await markDelivered(req.params.id);
  } catch (e) {
    console.error('markDelivered failed:', e);
  }
  res.redirect('/admin/orders');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

app.listen(PORT, () => {
  console.log(`Sunmc store listening on http://localhost:${PORT} (${useFirebase ? 'FIREBASE' : 'LOCAL'} mode)`);
});
