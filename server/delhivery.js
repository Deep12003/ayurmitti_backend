import express from "express";
import dotenv from "dotenv";
import Razorpay from "razorpay";
import crypto from "crypto";
import postmark from "postmark";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import * as delhivery from "./delhivery.js";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= ENV =================
const rootEnvPath = path.resolve(__dirname, "..", ".env");
const serverEnvPath = path.resolve(__dirname, ".env");
if (fs.existsSync(rootEnvPath)) dotenv.config({ path: rootEnvPath });
if (fs.existsSync(serverEnvPath)) dotenv.config({ path: serverEnvPath, override: false });

// ================= VALIDATE ENV =================
const missingEnv = [];
if (!process.env.POSTMARK_API_KEY) missingEnv.push("POSTMARK_API_KEY");
if (!process.env.RAZORPAY_KEY_ID) missingEnv.push("RAZORPAY_KEY_ID");
if (!process.env.RAZORPAY_KEY_SECRET) missingEnv.push("RAZORPAY_KEY_SECRET");
if (missingEnv.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 8080;

// ================= FILE FALLBACK =================
const DATA_DIR = path.resolve(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
};

const readFromDisk = (file, fallback = []) => {
  try {
    ensureDataDir();
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback), "utf-8");
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    console.error(`❌ Failed to read ${file}:`, e.message);
    return fallback;
  }
};

const writeToDisk = (file, data) => {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
};

// ================= POSTGRESQL =================
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const DB_SSL = String(process.env.DB_SSL || "true").toLowerCase() !== "false";

let pool = null;
let isDbReady = false;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DB_SSL ? { rejectUnauthorized: false } : false,
  });

  pool.on("error", (err) => {
    console.error("❌ PostgreSQL pool error:", err.message);
    isDbReady = false;
  });
}

const initializeDb = async () => {
  if (!pool) {
    console.warn("⚠️ No DATABASE_URL — using file fallback");
    return false;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders_store (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        orders JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`INSERT INTO orders_store (id, orders) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products_store (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        products JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`INSERT INTO products_store (id, products) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings_store (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`INSERT INTO settings_store (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);

    isDbReady = true;
    console.log("✅ PostgreSQL ready — orders, products, settings");
    return true;
  } catch (error) {
    console.error("❌ PostgreSQL init failed:", error.message);
    isDbReady = false;
    return false;
  }
};

// ================= DB HELPERS =================
// Explicit column names — no fragile string manipulation
const DB_TABLES = {
  orders:   { table: "orders_store",   col: "orders",   file: ORDERS_FILE,   fallback: [] },
  products: { table: "products_store", col: "products", file: PRODUCTS_FILE, fallback: [] },
  settings: { table: "settings_store", col: "settings", file: SETTINGS_FILE, fallback: {} },
};

const dbRead = async (key) => {
  const { table, col, file, fallback } = DB_TABLES[key];
  if (pool && isDbReady) {
    try {
      const result = await pool.query(`SELECT ${col} FROM ${table} WHERE id = 1 LIMIT 1`);
      const val = result.rows?.[0]?.[col];
      return val !== undefined ? val : fallback;
    } catch (e) {
      console.error(`❌ DB read ${table} failed:`, e.message);
    }
  }
  return readFromDisk(file, fallback);
};

const dbWrite = async (key, data) => {
  const { table, col, file } = DB_TABLES[key];
  if (pool && isDbReady) {
    try {
      await pool.query(
        `UPDATE ${table} SET ${col} = $1::jsonb, updated_at = NOW() WHERE id = 1`,
        [JSON.stringify(data)]
      );
      return;
    } catch (e) {
      console.error(`❌ DB write ${table} failed:`, e.message);
    }
  }
  writeToDisk(file, data);
};

// ================= CORS =================
const configuredOrigins = (process.env.CORS_ORIGIN || "https://ayurmitti.com,https://www.ayurmitti.com")
  .split(",").map(o => o.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isLocal = origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (origin && (configuredOrigins.includes(origin) || isLocal)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ================= SERVICES =================
const postmarkClient = new postmark.ServerClient(process.env.POSTMARK_API_KEY);
const MAIL_FROM = process.env.MAIL_FROM || "Ayurmitti <info@ayurmitti.com>";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ================= HEALTH =================
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "Backend running 🚀", db: isDbReady ? "PostgreSQL" : "File fallback" });
});

// =====================================================
// 📦 ORDERS
// =====================================================
app.get("/api/orders", async (req, res) => {
  try {
    const orders = await dbRead("orders");
    res.json({ success: true, orders: Array.isArray(orders) ? orders : [] });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to load orders" });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders)) {
      return res.status(400).json({ success: false, error: "orders must be an array" });
    }
    await dbWrite("orders", orders);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to save orders" });
  }
});

// =====================================================
// 🛍️ PRODUCTS
// =====================================================
app.get("/api/products", async (req, res) => {
  try {
    const products = await dbRead("products");
    res.json({ success: true, products: Array.isArray(products) ? products : [] });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to load products" });
  }
});

app.post("/api/products", async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products)) {
      return res.status(400).json({ success: false, error: "products must be an array" });
    }
    await dbWrite("products", products);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to save products" });
  }
});

// =====================================================
// ⚙️ SETTINGS
// =====================================================
const DEFAULT_SETTINGS = {
  storeName: "Ayurmitti",
  email: "info@ayurmitti.com",
  phone: "+91 9636910582",
  address: "Rajasthan, India",
  freeShippingThreshold: 500,
};

app.get("/api/settings", async (req, res) => {
  try {
    const settings = await dbRead("settings");
    res.json({
      success: true,
      settings: settings && Object.keys(settings).length > 0 ? settings : DEFAULT_SETTINGS,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to load settings" });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== "object") {
      return res.status(400).json({ success: false, error: "settings must be an object" });
    }
    await dbWrite("settings", settings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to save settings" });
  }
});

// =====================================================
// 📧 ORDER CONFIRMATION EMAIL
// =====================================================
app.post("/api/create-order", async (req, res) => {
  try {
    const { order } = req.body;
    if (!order || !order.email || !order.id || !order.amount) {
      return res.status(400).json({ error: "Missing order data (id, email, amount required)" });
    }

    await postmarkClient.sendEmail({
      From: MAIL_FROM,
      To: order.email,
      Subject: `Order Confirmed #${order.id} — Ayurmitti`,
      HtmlBody: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Order Confirmed</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Jost:wght@300;400;500&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background:#f7f2ea;font-family:'Jost',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2ea;padding:48px 16px;">
  <tr><td align="center">
    <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">
      <tr>
        <td style="padding-bottom:24px;text-align:center;">
          <p style="margin:0;font-family:'Cormorant Garamond',serif;font-size:13px;letter-spacing:6px;color:#8b6b47;text-transform:uppercase;">Ayurmitti</p>
        </td>
      </tr>
      <tr>
        <td style="background:linear-gradient(135deg,#2c1e0f 0%,#4a2f1a 60%,#6b3e20 100%);border-radius:16px 16px 0 0;padding:52px 48px 44px;text-align:center;">
          <table width="64" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;">
            <tr><td style="width:64px;height:64px;background:rgba(201,169,110,0.15);border:1.5px solid rgba(201,169,110,0.4);border-radius:50%;text-align:center;line-height:64px;font-size:26px;">✅</td></tr>
          </table>
          <h1 style="margin:0 0 10px;font-family:'Cormorant Garamond',serif;font-size:34px;font-weight:600;color:#f7f2ea;letter-spacing:1px;">Order Confirmed</h1>
          <p style="margin:0;font-size:13px;color:#c9a96e;letter-spacing:3px;text-transform:uppercase;font-weight:300;">Thank you for your purchase</p>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:44px 48px;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:3px;color:#a08060;text-transform:uppercase;font-weight:500;">Dear</p>
          <h2 style="margin:0 0 24px;font-family:'Cormorant Garamond',serif;font-size:28px;color:#2c1e0f;font-weight:600;">${order.customer || "Valued Customer"}</h2>
          <p style="margin:0 0 36px;font-size:15px;color:#6b5040;line-height:1.8;font-weight:300;">Your order has been received and is being lovingly prepared. We blend ancient Ayurvedic wisdom with pure natural ingredients — your wellness journey begins now.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
            <tr>
              <td style="border-top:1px solid #ede5d8;"></td>
              <td style="padding:0 16px;white-space:nowrap;font-size:16px;color:#c9a96e;">🌿</td>
              <td style="border-top:1px solid #ede5d8;"></td>
            </tr>
          </table>
          <p style="margin:0 0 16px;font-size:11px;letter-spacing:4px;color:#a08060;text-transform:uppercase;font-weight:500;">Order Details</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf5ed;border-radius:10px;border:1px solid #ede5d8;">
            <tr><td style="padding:18px 24px 14px;border-bottom:1px solid #ede5d8;">
              <table width="100%" cellpadding="0" cellspacing="0"><tr>
                <td style="font-size:13px;color:#9a7a5a;font-weight:300;">Order ID</td>
                <td align="right" style="font-size:13px;color:#2c1e0f;font-weight:500;">${order.id}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:14px 24px 14px;border-bottom:1px solid #ede5d8;">
              <table width="100%" cellpadding="0" cellspacing="0"><tr>
                <td style="font-size:13px;color:#9a7a5a;font-weight:300;">Status</td>
                <td align="right"><span style="display:inline-block;background:#e8f5e9;color:#2e7d32;font-size:11px;font-weight:500;letter-spacing:1px;padding:4px 10px;border-radius:20px;text-transform:uppercase;">Confirmed</span></td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:14px 24px 18px;">
              <table width="100%" cellpadding="0" cellspacing="0"><tr>
                <td style="font-size:13px;color:#9a7a5a;font-weight:300;">Amount Paid</td>
                <td align="right" style="font-family:'Cormorant Garamond',serif;font-size:24px;color:#c9a96e;font-weight:600;">₹${order.amount}</td>
              </tr></table>
            </td></tr>
          </table>
          <p style="margin:32px 0 0;font-size:14px;color:#9a7a5a;line-height:1.8;font-weight:300;">Questions? We're here for you at <a href="mailto:info@ayurmitti.com" style="color:#c9a96e;text-decoration:none;font-weight:500;">info@ayurmitti.com</a></p>
        </td>
      </tr>
      <tr>
        <td style="background:#2c1e0f;border-radius:0 0 16px 16px;padding:28px 48px;text-align:center;">
          <p style="margin:0 0 6px;font-family:'Cormorant Garamond',serif;font-size:15px;color:#c9a96e;letter-spacing:2px;">Rooted in Nature. Crafted with Care.</p>
          <p style="margin:0;font-size:11px;color:#6b5040;letter-spacing:1px;">© 2025 Ayurmitti &nbsp;·&nbsp; <a href="https://ayurmitti.com" style="color:#6b5040;text-decoration:none;">ayurmitti.com</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`,
      TextBody: `Order Confirmed! Order ID: ${order.id} | Amount: ₹${order.amount} | Thank you for shopping with Ayurmitti.`,
    });

    res.json({ success: true, message: "Order email sent ✅" });
  } catch (err) {
    console.error("❌ ORDER EMAIL ERROR:", err);
    res.status(500).json({ error: "Order email failed", details: err.message });
  }
});

// =====================================================
// 🚚 SHIPPING EMAIL
// =====================================================
app.post("/api/send-shipping-update", async (req, res) => {
  try {
    const { order } = req.body;
    if (!order || !order.email || !order.id) {
      return res.status(400).json({ error: "Missing order data (id, email required)" });
    }

    await postmarkClient.sendEmail({
      From: MAIL_FROM,
      To: order.email,
      Subject: `Your Order is on the Way! #${order.id} — Ayurmitti`,
      HtmlBody: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Order Shipped</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Jost:wght@300;400;500&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background:#f0f4f0;font-family:'Jost',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f0;padding:48px 16px;">
  <tr><td align="center">
    <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">
      <tr>
        <td style="padding-bottom:24px;text-align:center;">
          <p style="margin:0;font-family:'Cormorant Garamond',serif;font-size:13px;letter-spacing:6px;color:#4a7c59;text-transform:uppercase;">Ayurmitti</p>
        </td>
      </tr>
      <tr>
        <td style="background:linear-gradient(135deg,#1a3a28 0%,#2d5a3d 55%,#3d7a50 100%);border-radius:16px 16px 0 0;padding:52px 48px 44px;text-align:center;">
          <table width="64" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;">
            <tr><td style="width:64px;height:64px;background:rgba(142,203,160,0.15);border:1.5px solid rgba(142,203,160,0.4);border-radius:50%;text-align:center;line-height:64px;font-size:26px;">🚚</td></tr>
          </table>
          <h1 style="margin:0 0 10px;font-family:'Cormorant Garamond',serif;font-size:34px;font-weight:600;color:#f0f4f0;letter-spacing:1px;">Your Order Shipped!</h1>
          <p style="margin:0;font-size:13px;color:#8ecba0;letter-spacing:3px;text-transform:uppercase;font-weight:300;">On its way to you</p>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:44px 48px;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:3px;color:#5a8a6a;text-transform:uppercase;font-weight:500;">Dear</p>
          <h2 style="margin:0 0 24px;font-family:'Cormorant Garamond',serif;font-size:28px;color:#1a3a28;font-weight:600;">${order.customer || "Valued Customer"}</h2>
          <p style="margin:0 0 36px;font-size:15px;color:#3a5a4a;line-height:1.8;font-weight:300;">Great news! Your Ayurmitti order has been dispatched and is making its way to you.</p>
          <p style="margin:0 0 16px;font-size:11px;letter-spacing:4px;color:#5a8a6a;text-transform:uppercase;font-weight:500;">Shipment Details</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4faf5;border-radius:10px;border:1px solid #d8ede0;">
            <tr><td style="padding:18px 24px 14px;${order.trackingId ? "border-bottom:1px solid #d8ede0;" : ""}">
              <table width="100%" cellpadding="0" cellspacing="0"><tr>
                <td style="font-size:13px;color:#6a9a7a;font-weight:300;">Order ID</td>
                <td align="right" style="font-size:13px;color:#1a3a28;font-weight:500;">${order.id}</td>
              </tr></table>
            </td></tr>
            ${order.trackingId ? `
            <tr><td style="padding:14px 24px 18px;">
              <table width="100%" cellpadding="0" cellspacing="0"><tr>
                <td style="font-size:13px;color:#6a9a7a;font-weight:300;">Tracking ID</td>
                <td align="right"><a href="https://track.delhivery.com/${order.trackingId}" style="font-family:'Cormorant Garamond',serif;font-size:18px;color:#2d5a3d;font-weight:600;letter-spacing:1px;text-decoration:underline;">${order.trackingId}</a></td>
              </tr></table>
            </td></tr>` : ""}
          </table>
          <p style="margin:32px 0 0;font-size:14px;color:#6a9a7a;line-height:1.8;font-weight:300;">Need help? Reach us at <a href="mailto:info@ayurmitti.com" style="color:#2d5a3d;text-decoration:none;font-weight:500;">info@ayurmitti.com</a></p>
        </td>
      </tr>
      <tr>
        <td style="background:#1a3a28;border-radius:0 0 16px 16px;padding:28px 48px;text-align:center;">
          <p style="margin:0 0 6px;font-family:'Cormorant Garamond',serif;font-size:15px;color:#8ecba0;letter-spacing:2px;">Rooted in Nature. Crafted with Care.</p>
          <p style="margin:0;font-size:11px;color:#3a6a4a;letter-spacing:1px;">© 2025 Ayurmitti &nbsp;·&nbsp; <a href="https://ayurmitti.com" style="color:#3a6a4a;text-decoration:none;">ayurmitti.com</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`,
      TextBody: `Your order has been shipped! Order ID: ${order.id}${order.trackingId ? ` | Tracking: ${order.trackingId}` : ""}. Thank you for shopping with Ayurmitti.`,
    });

    res.json({ success: true, message: "Shipping email sent ✅" });
  } catch (err) {
    console.error("❌ SHIPPING ERROR:", err);
    res.status(500).json({ error: "Shipping email failed", details: err.message });
  }
});

// =====================================================
// 💳 CREATE RAZORPAY ORDER
// =====================================================
app.post("/api/create-payment-order", async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Amount is required and must be greater than 0" });
    }
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: order.currency });
  } catch (err) {
    console.error("❌ RAZORPAY ERROR:", err);
    res.status(500).json({ error: "Payment order failed", details: err.message });
  }
});

// =====================================================
// 🔐 VERIFY PAYMENT
// =====================================================
app.post("/api/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification data" });
    }
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");
    if (expectedSignature === razorpay_signature) {
      return res.json({ success: true, message: "Payment verified ✅" });
    }
    res.status(400).json({ success: false, message: "Invalid signature ❌" });
  } catch (err) {
    console.error("❌ VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed", details: err.message });
  }
});

// =====================================================
// 🚚 DELHIVERY
// =====================================================
app.post("/api/delivery/availability", async (req, res) => {
  try {
    const { pincode } = req.body;
    if (!pincode) return res.status(400).json({ success: false, message: "Pincode is required" });
    const result = await delhivery.checkDeliveryAvailability(pincode);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Failed to check delivery availability" });
  }
});

app.post("/api/delivery/charges", async (req, res) => {
  try {
    const { weight = 0.5, pincode, origin_pincode = process.env.WAREHOUSE_PINCODE || "332404" } = req.body;
    if (!pincode) return res.status(400).json({ success: false, message: "Pincode is required" });
    const result = await delhivery.calculateDeliveryCharges({ weight, pincode, origin_pincode });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Failed to calculate charges" });
  }
});

app.post("/api/delivery/create-shipment", async (req, res) => {
  try {
    const {
      order_id, customer_name, customer_phone, customer_email,
      destination_pincode, destination_address, destination_city,
      destination_state, payment_mode = "Prepaid", total_amount = 0,
      product_description = "Ayurvedic Products", weight = 0.5,
    } = req.body;

    if (!order_id || !customer_name || !customer_phone || !destination_pincode || !destination_address) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const result = await delhivery.createShipment({
      order_id, customer_name, customer_phone, customer_email,
      destination_pincode, destination_address,
      destination_city: destination_city || "",
      destination_state: destination_state || "",
      payment_mode: payment_mode.toLowerCase() === "cod" ? "COD" : "Prepaid",
      total_amount, product_description, weight,
    });

    if (result.success) {
      try {
        const orders = await dbRead("orders");
        const idx = orders.findIndex(o => o.id === order_id);
        if (idx !== -1) {
          orders[idx].delivery = {
            partner: "delhivery",
            waybill: result.waybill,
            shipment_id: result.shipment_id,
            status: result.status,
            tracking_url: result.tracking_url,
            created_at: new Date().toISOString(),
          };
          await dbWrite("orders", orders);
        }
      } catch (dbError) {
        console.warn("⚠️ Could not update order with delivery info:", dbError.message);
      }
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Failed to create shipment" });
  }
});

app.get("/api/delivery/tracking/:waybill", async (req, res) => {
  try {
    const { waybill } = req.params;
    if (!waybill) return res.status(400).json({ success: false, message: "Waybill is required" });
    const result = await delhivery.getShipmentTracking(waybill);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Failed to get tracking" });
  }
});

app.post("/api/delivery/cancel", async (req, res) => {
  try {
    const { waybill } = req.body;
    if (!waybill) return res.status(400).json({ success: false, message: "Waybill is required" });
    const result = await delhivery.cancelShipment(waybill);
    if (result.success) {
      try {
        const orders = await dbRead("orders");
        for (const order of orders) {
          if (order.delivery?.waybill === waybill) {
            order.delivery.status = "cancelled";
            order.delivery.cancelled_at = new Date().toISOString();
            break;
          }
        }
        await dbWrite("orders", orders);
      } catch (dbError) {
        console.warn("⚠️ Could not update cancellation status:", dbError.message);
      }
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Failed to cancel shipment" });
  }
});

// =====================================================
// 🏭 REGISTER WAREHOUSE (run once)
// =====================================================
app.post("/api/delivery/register-warehouse", async (req, res) => {
  try {
    const response = await axios.post(
      `${process.env.DELHIVERY_BASE_URL || "https://express.delhivery.com"}/api/backend/clientwarehouse/create/`,
      {
        name: process.env.WAREHOUSE_NAME || "B S OVERSEAS",
        email: process.env.WAREHOUSE_EMAIL || "info@ayurmitti.com",
        phone: process.env.WAREHOUSE_PHONE || "9636910582",
        address: process.env.WAREHOUSE_ADDRESS || "SHAHID MAGAN SINGH COLONY, WARD NO-15, Mahroli",
        city: process.env.WAREHOUSE_CITY || "Maharoli",
        country: "India",
        pin: process.env.WAREHOUSE_PINCODE || "332603",
        state: process.env.WAREHOUSE_STATE || "Rajasthan",
        return_address: process.env.WAREHOUSE_ADDRESS || "SHAHID MAGAN SINGH COLONY, WARD NO-15, Mahroli",
        return_pin: process.env.WAREHOUSE_PINCODE || "332603",
        return_city: process.env.WAREHOUSE_CITY || "Maharoli",
        return_state: process.env.WAREHOUSE_STATE || "Rajasthan",
        return_country: "India",
      },
      {
        headers: {
          Authorization: `Token ${process.env.DELHIVERY_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("❌ Warehouse registration error:", err.message);
    res.status(500).json({ success: false, error: err.message, details: err.response?.data });
  }
});

// ================= GRACEFUL SHUTDOWN =================
const shutdown = (signal) => {
  console.log(`\n${signal} received — shutting down gracefully`);
  if (pool) {
    pool.end(() => {
      console.log("🔌 PostgreSQL pool closed");
      process.exit(0);
    });
    // Force exit if pool doesn't close within 5s
    setTimeout(() => process.exit(0), 5000).unref();
  } else {
    process.exit(0);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ================= START =================
const startServer = async () => {
  await initializeDb();
  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });
};

startServer();
