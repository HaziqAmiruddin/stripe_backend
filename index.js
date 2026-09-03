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
