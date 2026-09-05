require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

// Uses your Firebase service account JSON (download from
// Firebase Console → Project Settings → Service Accounts → Generate new key)
admin.initializeApp({
  credential: admin.credential.cert(require("./serviceAccountKey.json")),
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// Returns everything the Flutter PaymentSheet needs to securely
// collect + save a card, without ever touching raw card data here.
app.post("/create-payment-sheet", async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: "uid is required" });

    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    let stripeCustomerId = userDoc.data()?.stripeCustomerId;

    // Create a Stripe Customer once per user, reuse it after that.
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: { firebaseUid: uid },
      });
      stripeCustomerId = customer.id;
      await userRef.set({ stripeCustomerId }, { merge: true });
    }

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: stripeCustomerId },
      { apiVersion: "2024-06-20" },
    );

    const setupIntent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
    });

    res.json({
      setupIntentClientSecret: setupIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customerId: stripeCustomerId,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Returns saved cards for a user, formatted safely (no full card number ever).
app.get("/payment-methods/:uid", async (req, res) => {
  try {
    const userDoc = await db.collection("users").doc(req.params.uid).get();
    const stripeCustomerId = userDoc.data()?.stripeCustomerId;
    if (!stripeCustomerId) return res.json({ paymentMethods: [] });

    const methods = await stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: "card",
    });

    res.json({
      paymentMethods: methods.data.map((pm) => ({
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// index.js — add this route
app.delete('/payment-methods/:paymentMethodId', async (req, res) => {
  try {
    await stripe.paymentMethods.detach(req.params.paymentMethodId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// index.js — add these
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.5-flash'; // free-tier-friendly model

const SYSTEM_PROMPT = `You are a friendly customer support assistant for "Shopping Bakery App",
a bakery e-commerce app selling cakes, donuts, cupcakes, cookies, and pastries.
Help users with questions about orders, delivery, payment methods (credit card, FPX),
returns, and general app usage. Keep answers short, warm, and practical.
If you don't know something specific to this app, say so honestly and suggest
they contact support via email instead of guessing.`;

app.post('/support-chat', async (req, res) => {
  try {
    const { message, history } = req.body; // history: [{role: 'user'|'model', text: string}]

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const contents = [
      ...(history || []).map((h) => ({
        role: h.role,
        parts: [{ text: h.text }],
      })),
      { role: 'user', parts: [{ text: message }] },
    ];

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        }),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini API error:', data);
      return res.status(500).json({ error: 'AI service error' });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ??
      "Sorry, I couldn't generate a response. Please try again.";

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
