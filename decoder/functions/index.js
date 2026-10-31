// Rejection decoder for ascship.web.app/rejection-decoder.
//   POST /  { text }  →  { result }   (CORS limited to the site)
// Rate limited per IP per hour and store-wide per day, counted in Firestore `decoder_rl`.
const crypto = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk").default;
const { decode, validateInput, DecodeError } = require("./decode");

admin.initializeApp();
const db = admin.firestore();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const ORIGINS = ["https://ascship.web.app", "https://ascship.firebaseapp.com", "http://localhost:5183"];
const PER_IP_HOUR = 6;
const PER_DAY = 400;

const ipHash = (ip) => crypto.createHash("sha256").update(`decoder:${ip}`).digest("hex").slice(0, 24);

async function takeQuota(ip) {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13);
  const day = now.toISOString().slice(0, 10);
  const ipRef = db.doc(`decoder_rl/ip_${ipHash(ip)}_${hour}`);
  const dayRef = db.doc(`decoder_rl/day_${day}`);
  return db.runTransaction(async (tx) => {
    const [a, b] = await Promise.all([tx.get(ipRef), tx.get(dayRef)]);
    if ((a.get("n") || 0) >= PER_IP_HOUR) return "ip";
    if ((b.get("n") || 0) >= PER_DAY) return "day";
    const expires = admin.firestore.Timestamp.fromMillis(now.getTime() + 2 * 864e5);
    tx.set(ipRef, { n: admin.firestore.FieldValue.increment(1), expires }, { merge: true });
    tx.set(dayRef, { n: admin.firestore.FieldValue.increment(1), expires }, { merge: true });
    return null;
  });
}

exports.decodeRejection = onRequest(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, memory: "256MiB", maxInstances: 5, invoker: "public" },
  async (req, res) => {
    const origin = req.get("origin");
    if (ORIGINS.includes(origin)) res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Access-Control-Max-Age", "3600");
      return res.status(204).send("");
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    if (!ORIGINS.includes(origin)) return res.status(403).json({ error: "origin" });

    const text = req.body?.text;
    try {
      validateInput(text);
    } catch (e) {
      return res.status(400).json({ error: e.code, message: e.message });
    }

    const blocked = await takeQuota(req.ip || "unknown");
    if (blocked) {
      return res.status(429).json({
        error: "rate_limited",
        message: blocked === "ip" ? "You've decoded a few already this hour. Try again later." : "The decoder is busy today. Try again tomorrow.",
      });
    }

    try {
      const { result, model, usage } = await decode(new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() }), text);
      logger.info("decoded", { model, in: usage?.input_tokens, out: usage?.output_tokens, guidelines: result.guidelines.map((g) => g.id) });
      return res.json({ result });
    } catch (e) {
      if (e instanceof DecodeError) return res.status(502).json({ error: e.code, message: e.message });
      logger.error("decode failed", { status: e?.status, msg: e?.message });
      return res.status(502).json({ error: "failed", message: "Something went wrong. Try again in a minute." });
    }
  }
);
