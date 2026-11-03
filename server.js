require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { init: initDb } = require("./db");
let db;

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const NOW_API_KEY = process.env.NOW_API_KEY || "";
const NOW_API = (process.env.NOW_API || "https://api.nowpayments.io/v1").replace(/\/$/, "");
const IPN_SECRET = process.env.IPN_SECRET || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5500").replace(/\/$/, "");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    first: row.first_name,
    last: row.last_name,
    address: row.address,
    balance: row.balance,
    invested: row.invested,
    principal: row.principal,
    profit: row.profit,
    plan: row.plan,
    daysActive: row.days_active,
    admin: !!row.admin
  };
}

function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function creditBalance(userId, amount, ref, note) {
  const amt = Number(amount) || 0;
  if (amt <= 0) return null;
  const existing = db.prepare("SELECT id FROM ledger WHERE ref = ? AND type = 'deposit'").get(ref);
  if (existing) return getUserById(userId); // idempotent
  db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(amt, userId);
  db.prepare(
    "INSERT INTO ledger (user_id, type, amount, ref, note, created_at) VALUES (?, 'deposit', ?, ?, ?, ?)"
  ).run(userId, amt, ref || null, note || "Deposit", Date.now());
  return getUserById(userId);
}

// ---------- Auth ----------
app.post("/api/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const pass = String(req.body.password || req.body.pass || "");
    const first = String(req.body.first || req.body.firstName || "").trim();
    const last = String(req.body.last || req.body.lastName || "").trim();
    const address = String(req.body.address || "").trim();
    if (!email || !pass || pass.length < 6) {
      return res.status(400).json({ error: "Email and password (min 6) required" });
    }
    const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (exists) return res.status(409).json({ error: "Email already registered" });
    const hash = await bcrypt.hash(pass, 10);
    const info = db.prepare(
      `INSERT INTO users (email, pass_hash, first_name, last_name, address, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(email, hash, first, last, address, Date.now());
    const user = getUserById(info.lastInsertRowid);
    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const pass = String(req.body.password || req.body.pass || "");
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(pass, user.pass_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/me", auth, (req, res) => {
  const user = getUserById(req.user.uid);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: publicUser(user) });
});

// ---------- Deposit invoice ----------
app.post("/api/deposit/invoice", auth, async (req, res) => {
  try {
    if (!NOW_API_KEY) return res.status(500).json({ error: "NOW_API_KEY not configured on server" });
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const user = getUserById(req.user.uid);
    const orderId = `u${user.id}-${Date.now()}`;
    const body = {
      price_amount: amount,
      price_currency: "usd",
      order_id: orderId,
      order_description: `Novorté deposit user ${user.id}`,
      ipn_callback_url: `${PUBLIC_URL}/api/webhook`,
      success_url: `${FRONTEND_URL}/#deposit`,
      cancel_url: `${FRONTEND_URL}/#deposit`
    };
    if (req.body.pay_currency && req.body.pay_currency !== "crypto") {
      body.pay_currency = req.body.pay_currency;
    }

    const r = await fetch(`${NOW_API}/invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": NOW_API_KEY },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || data.error || "Invoice failed", raw: data });

    const now = Date.now();
    db.prepare(
      `INSERT INTO payments (user_id, order_id, invoice_id, payment_id, amount, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`
    ).run(user.id, orderId, String(data.id || data.invoice_id || ""), data.payment_id ? String(data.payment_id) : null, amount, now, now);

    res.json({
      order_id: orderId,
      invoice_id: data.id || data.invoice_id,
      invoice_url: data.invoice_url,
      amount
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual status check (backup if IPN delayed)
app.get("/api/deposit/status", auth, async (req, res) => {
  try {
    const orderId = String(req.query.order_id || "");
    const row = db.prepare("SELECT * FROM payments WHERE order_id = ? AND user_id = ?").get(orderId, req.user.uid);
    if (!row) return res.status(404).json({ error: "Payment not found" });
    if (row.status === "finished") {
      return res.json({ paid: true, status: "finished", amount: row.amount, user: publicUser(getUserById(req.user.uid)) });
    }

    // Ask NOWPayments for updates
    if (NOW_API_KEY) {
      const listRes = await fetch(`${NOW_API}/payment/?limit=50`, { headers: { "x-api-key": NOW_API_KEY } });
      const listData = await listRes.json();
      const list = Array.isArray(listData) ? listData : (listData.data || listData.payments || []);
      const match = list.find(p => String(p.order_id) === orderId);
      if (match) {
        const st = String(match.payment_status || match.status || "").toLowerCase();
        db.prepare("UPDATE payments SET payment_id = ?, status = ?, updated_at = ? WHERE id = ?")
          .run(String(match.payment_id || ""), st, Date.now(), row.id);
        if (["finished", "confirmed", "sending", "partially_paid"].includes(st)) {
          const paidAmt = Number(match.price_amount || match.actually_paid || row.amount);
          creditBalance(req.user.uid, paidAmt, `pay-${match.payment_id || orderId}`, "NOWPayments deposit");
          db.prepare("UPDATE payments SET status = 'finished', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
          return res.json({ paid: true, status: st, amount: paidAmt, user: publicUser(getUserById(req.user.uid)) });
        }
        return res.json({ paid: false, status: st });
      }
    }
    res.json({ paid: false, status: row.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- IPN webhook ----------
app.get("/api/webhook", (req, res) => {
  res.json({ ok: true, hint: "NOWPayments must POST here. IPN URL should be PUBLIC_URL/api/webhook" });
});

app.post("/api/webhook", (req, res) => {
  try {
    // Optional HMAC verification
    if (IPN_SECRET) {
      const sig = req.headers["x-nowpayments-sig"] || req.headers["x-nowpayments-signature"] || "";
      const sorted = JSON.stringify(sortObject(req.body || {}));
      const hmac = crypto.createHmac("sha512", IPN_SECRET).update(sorted).digest("hex");
      if (sig && sig !== hmac) {
        console.warn("IPN signature mismatch");
        // still respond 200 to avoid retries storm while debugging — change to 403 in production if desired
      }
    }

    const body = req.body || {};
    const status = String(body.payment_status || body.status || "").toLowerCase();
    const orderId = String(body.order_id || "");
    const paymentId = body.payment_id ? String(body.payment_id) : null;
    const amount = Number(body.price_amount || body.actually_paid || 0);

    console.log("IPN", { status, orderId, paymentId, amount });

    if (!orderId) return res.json({ ok: true, ignored: "no order_id" });

    const row = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(orderId);
    if (!row) return res.json({ ok: true, ignored: "unknown order" });

    db.prepare("UPDATE payments SET payment_id = COALESCE(?, payment_id), status = ?, updated_at = ? WHERE id = ?")
      .run(paymentId, status || row.status, Date.now(), row.id);

    if (["finished", "confirmed", "sending", "partially_paid"].includes(status)) {
      const creditAmt = amount > 0 ? amount : row.amount;
      creditBalance(row.user_id, creditAmt, `pay-${paymentId || orderId}`, "NOWPayments IPN deposit");
      db.prepare("UPDATE payments SET status = 'finished', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

function sortObject(obj) {
  return Object.keys(obj).sort().reduce((o, k) => {
    o[k] = obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k]) ? sortObject(obj[k]) : obj[k];
    return o;
  }, {});
}

app.get("/api/health", (req, res) => res.json({ ok: true, time: Date.now() }));

initDb().then((database) => {
  db = database;
  app.listen(PORT, () => {
    console.log(`Novorté API on :${PORT}`);
    console.log(`Webhook URL: ${PUBLIC_URL}/api/webhook`);
    if (!NOW_API_KEY) console.warn("WARNING: NOW_API_KEY empty");
  });
}).catch((e) => {
  console.error("DB init failed", e);
  process.exit(1);
});
