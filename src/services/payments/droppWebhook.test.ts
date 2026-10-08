import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  parseDecimalToCents,
  parseMinorUnitsToCents,
  processDroppWebhook,
  verifyDroppAmount,
  verifyDroppWebhookSignature,
} from "./droppWebhook";

const MOCK_SECRET = "whsec_testsecretkey987654321";

function signPayload(body: string, timestampSec: number, secret = MOCK_SECRET): string {
  const hash = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `sha256=${hash}`;
}

test("verifyDroppWebhookSignature accepts valid signature within 5 minutes skew", () => {
  const now = new Date("2026-10-05T20:00:00.000Z");
  const nowSec = Math.floor(now.getTime() / 1000);
  const body = '{"hello":"world"}';
  const sig = signPayload(body, nowSec);

  const res = verifyDroppWebhookSignature({
    rawBody: body,
    timestampHeader: String(nowSec),
    signatureHeader: sig,
    secret: MOCK_SECRET,
    now,
  });

  assert.deepEqual(res, { valid: true });
});

test("verifyDroppWebhookSignature rejects missing signature header", () => {
  const now = new Date();
  const res = verifyDroppWebhookSignature({
    rawBody: "{}",
    timestampHeader: String(Math.floor(now.getTime() / 1000)),
    signatureHeader: null,
    secret: MOCK_SECRET,
    now,
  });
  assert.equal(res.valid, false);
  if (!res.valid) assert.equal(res.reason, "missing_signature");
});

test("verifyDroppWebhookSignature rejects missing timestamp header", () => {
  const res = verifyDroppWebhookSignature({
    rawBody: "{}",
    timestampHeader: null,
    signatureHeader: "sha256=123456",
    secret: MOCK_SECRET,
    now: new Date(),
  });
  assert.equal(res.valid, false);
  if (!res.valid) assert.equal(res.reason, "missing_timestamp");
});

test("verifyDroppWebhookSignature rejects malformed signature (missing sha256= prefix or wrong length)", () => {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);

  const badPrefix = verifyDroppWebhookSignature({
    rawBody: "{}",
    timestampHeader: String(nowSec),
    signatureHeader: "v1=abcdef",
    secret: MOCK_SECRET,
    now,
  });
  assert.equal(badPrefix.valid, false);
  if (!badPrefix.valid) assert.equal(badPrefix.reason, "malformed_signature");

  const badLength = verifyDroppWebhookSignature({
    rawBody: "{}",
    timestampHeader: String(nowSec),
    signatureHeader: "sha256=abcdef",
    secret: MOCK_SECRET,
    now,
  });
  assert.equal(badLength.valid, false);
  if (!badLength.valid) assert.equal(badLength.reason, "malformed_signature");
});

test("verifyDroppWebhookSignature rejects timestamps older than 5 minutes", () => {
  const now = new Date("2026-10-05T20:00:00.000Z");
  const oldSec = Math.floor(now.getTime() / 1000) - 301; // 5m 1s ago
  const body = '{"event":"test"}';
  const sig = signPayload(body, oldSec);

  const res = verifyDroppWebhookSignature({
    rawBody: body,
    timestampHeader: String(oldSec),
    signatureHeader: sig,
    secret: MOCK_SECRET,
    now,
  });
  assert.equal(res.valid, false);
  if (!res.valid) assert.equal(res.reason, "timestamp_expired");
});

test("verifyDroppWebhookSignature rejects timestamps more than 5 minutes in the future", () => {
  const now = new Date("2026-10-05T20:00:00.000Z");
  const futureSec = Math.floor(now.getTime() / 1000) + 301;
  const body = '{"event":"test"}';
  const sig = signPayload(body, futureSec);

  const res = verifyDroppWebhookSignature({
    rawBody: body,
    timestampHeader: String(futureSec),
    signatureHeader: sig,
    secret: MOCK_SECRET,
    now,
  });
  assert.equal(res.valid, false);
  if (!res.valid) assert.equal(res.reason, "timestamp_future");
});

test("verifyDroppWebhookSignature rejects body modified after signing", () => {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const originalBody = '{"amount":10}';
  const tamperedBody = '{"amount":100}';
  const sig = signPayload(originalBody, nowSec);

  const res = verifyDroppWebhookSignature({
    rawBody: tamperedBody,
    timestampHeader: String(nowSec),
    signatureHeader: sig,
    secret: MOCK_SECRET,
    now,
  });
  assert.equal(res.valid, false);
  if (!res.valid) assert.equal(res.reason, "invalid_signature");
});

test("RAW BODY VERIFICATION: JSON re-stringification fails signature check", () => {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);

  // Raw body A with custom spacing
  const rawBodyA = '{\n  "event": "order.paid",\n  "data": {\n    "id": "ord_1"\n  }\n}';
  const sigA = signPayload(rawBodyA, nowSec);

  // Raw body B: parsed from A and serialized via JSON.stringify (compact, no extra whitespace)
  const rawBodyB = JSON.stringify(JSON.parse(rawBodyA));

  assert.notEqual(rawBodyA, rawBodyB, "Precondition: stringified representation differs in whitespace");

  const checkB = verifyDroppWebhookSignature({
    rawBody: rawBodyB,
    timestampHeader: String(nowSec),
    signatureHeader: sigA,
    secret: MOCK_SECRET,
    now,
  });

  assert.equal(checkB.valid, false, "Verification of re-serialized JSON must fail against signature of raw body A");
  if (!checkB.valid) assert.equal(checkB.reason, "invalid_signature");
});

test("Money helper: parseDecimalToCents strictly validates decimal dollar values and fails closed", () => {
  // ACCEPT cases
  assert.equal(parseDecimalToCents(15), 1500);
  assert.equal(parseDecimalToCents(15.0), 1500);
  assert.equal(parseDecimalToCents(15.00), 1500);
  assert.equal(parseDecimalToCents("15"), 1500);
  assert.equal(parseDecimalToCents("15.0"), 1500);
  assert.equal(parseDecimalToCents("15.00"), 1500);
  assert.equal(parseDecimalToCents(0.99), 99);
  assert.equal(parseDecimalToCents("0.99"), 99);
  assert.equal(parseDecimalToCents(0), 0);
  assert.equal(parseDecimalToCents("0"), 0);
  assert.equal(parseDecimalToCents("0.0"), 0);
  assert.equal(parseDecimalToCents("0.00"), 0);
  assert.equal(parseDecimalToCents("10.5"), 1050);
  assert.equal(parseDecimalToCents("10.50"), 1050);
  assert.equal(parseDecimalToCents(10.5), 1050);

  // REJECT cases - fractional cents / truncation / rounding
  assert.equal(parseDecimalToCents(15.001), null);
  assert.equal(parseDecimalToCents("15.001"), null);
  assert.equal(parseDecimalToCents(15.999), null);
  assert.equal(parseDecimalToCents("15.999"), null);
  assert.equal(parseDecimalToCents(0.991), null);
  assert.equal(parseDecimalToCents("0.991"), null);

  // REJECT cases - scientific notation
  assert.equal(parseDecimalToCents("1e2"), null);
  assert.equal(parseDecimalToCents("1e20"), null);

  // REJECT cases - non-finite / negative
  assert.equal(parseDecimalToCents(NaN), null);
  assert.equal(parseDecimalToCents(Infinity), null);
  assert.equal(parseDecimalToCents(-Infinity), null);
  assert.equal(parseDecimalToCents(-15), null);
  assert.equal(parseDecimalToCents("-15"), null);
  assert.equal(parseDecimalToCents(-0.99), null);
  assert.equal(parseDecimalToCents("-0.99"), null);
  assert.equal(parseDecimalToCents("-15.00"), null);
  assert.equal(parseDecimalToCents(-0), null);

  // REJECT cases - malformed strings / non-numeric
  assert.equal(parseDecimalToCents(""), null);
  assert.equal(parseDecimalToCents("   "), null);
  assert.equal(parseDecimalToCents(null), null);
  assert.equal(parseDecimalToCents(undefined), null);
  assert.equal(parseDecimalToCents("abc"), null);
  assert.equal(parseDecimalToCents("$15"), null);
  assert.equal(parseDecimalToCents("15,00"), null);
  assert.equal(parseDecimalToCents("15."), null);
  assert.equal(parseDecimalToCents(".99"), null);
});

test("Money helper: parseMinorUnitsToCents strictly validates integer cents", () => {
  // ACCEPT cases
  assert.equal(parseMinorUnitsToCents(1500), 1500);
  assert.equal(parseMinorUnitsToCents("1500"), 1500);
  assert.equal(parseMinorUnitsToCents(0), 0);
  assert.equal(parseMinorUnitsToCents("0"), 0);
  assert.equal(parseMinorUnitsToCents(15), 15);

  // REJECT cases
  assert.equal(parseMinorUnitsToCents(15.5), null);
  assert.equal(parseMinorUnitsToCents("15.00"), null);
  assert.equal(parseMinorUnitsToCents(-1500), null);
  assert.equal(parseMinorUnitsToCents("-1500"), null);
  assert.equal(parseMinorUnitsToCents("1e2"), null);
  assert.equal(parseMinorUnitsToCents(NaN), null);
  assert.equal(parseMinorUnitsToCents(Infinity), null);
  assert.equal(parseMinorUnitsToCents(null), null);
  assert.equal(parseMinorUnitsToCents(undefined), null);
  assert.equal(parseMinorUnitsToCents(""), null);
  assert.equal(parseMinorUnitsToCents("abc"), null);
});

test("Money helper: verifyDroppAmount checks whole and minor unit equivalence strictly", () => {
  // Expected $15.00 matching
  assert.equal(verifyDroppAmount({ droppAmount: "15", expectedAmount: 15 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: "15.0", expectedAmount: 15 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: "15.00", expectedAmount: 15 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: 15, expectedAmount: 15 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: 15.0, expectedAmount: 15 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: 15.00, expectedAmount: 15 }), true);

  // Expected $15.00 rejections
  assert.equal(verifyDroppAmount({ droppAmount: 15.001, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "15.001", expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: 15.999, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "15.999", expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "1e2", expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "1e2", expectedAmount: 100 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: NaN, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: Infinity, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: -Infinity, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: -15, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "-15", expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "-15.00", expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "", expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "   ", expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: null, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: undefined, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "abc", expectedAmount: 15 }), false);

  // Expected $0.99
  assert.equal(verifyDroppAmount({ droppAmount: "0.99", expectedAmount: 0.99 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: 0.99, expectedAmount: 0.99 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: 0.991, expectedAmount: 0.99 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: "0.991", expectedAmount: 0.99 }), false);

  // Minor units: 1500 only equals $15.00 when reading explicitly identified *_cents field
  assert.equal(verifyDroppAmount({ droppAmount: { total_cents: 1500 }, expectedAmount: 15 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: { amount_cents: 1500 }, expectedAmount: 15 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: { subtotal_cents: 1500 }, expectedAmount: 15 }), true);

  // 15 in minor units is 15 cents, NOT $15.00 -> must reject
  assert.equal(verifyDroppAmount({ droppAmount: { total_cents: 15 }, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: { amount_cents: 15 }, expectedAmount: 15 }), false);

  // Bare number 1500 is $1500.00, NOT $15.00 -> must reject
  assert.equal(verifyDroppAmount({ droppAmount: 1500, expectedAmount: 15 }), false);

  // Bare number 15 is $15.00, NOT 15 cents -> matches $15.00
  assert.equal(verifyDroppAmount({ droppAmount: 15, expectedAmount: 15 }), true);

  // Object decimal fields
  assert.equal(verifyDroppAmount({ droppAmount: { total: "15.00" }, expectedAmount: 15 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: { amount: "15.00" }, expectedAmount: 15 }), true);
  assert.equal(verifyDroppAmount({ droppAmount: { total: "15.001" }, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: { total_cents: 1500.5 }, expectedAmount: 15 }), false);
  assert.equal(verifyDroppAmount({ droppAmount: { total_cents: -1500 }, expectedAmount: 15 }), false);
});

test("Non-order.paid events (e.g. order.refunded, payment.received) are safely captured and do not fulfill", async () => {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const refundPayload = JSON.stringify({
    event: "order.refunded",
    occurred_at: now.toISOString(),
    data: { id: "ord_refunded_1", status: "refunded" },
  });

  const sig = signPayload(refundPayload, nowSec);
  let persisted = 0;

  const res = await processDroppWebhook(
    {
      rawBody: refundPayload,
      headers: {
        "x-dropp-timestamp": String(nowSec),
        "x-dropp-signature": sig,
        "x-dropp-event-type": "order.refunded",
      },
    },
    {
      webhookSecret: MOCK_SECRET,
      now,
      persistDraft: async () => {
        persisted += 1;
        return { seenBefore: false };
      },
    },
  );

  assert.equal(res.status, 200);
  assert.equal(res.body["ok"], true);
  assert.equal(res.body["ignored"], true);
  assert.equal(res.body["eventType"], "order.refunded");
  assert.equal(res.body["paymentId"], undefined);
  assert.equal(persisted, 1);
});

test("Invalid HMAC is rejected without persisting the raw payload", async () => {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const body = JSON.stringify({
    event: "order.paid",
    data: { id: "ord_untrusted", status: "paid", buyer: { email: "buyer@example.com" } },
  });
  let persisted = 0;
  const res = await processDroppWebhook(
    {
      rawBody: body,
      headers: {
        "x-dropp-timestamp": String(nowSec),
        "x-dropp-signature": "sha256=" + "ab".repeat(32),
      },
    },
    {
      webhookSecret: MOCK_SECRET,
      now,
      persistDraft: async () => {
        persisted += 1;
        return { seenBefore: false };
      },
    },
  );
  assert.equal(res.status, 401);
  assert.equal(res.body["reason"], "invalid_signature");
  assert.equal(persisted, 0);
});

test("Expired timestamp is rejected without persisting the raw payload", async () => {
  const now = new Date("2026-10-05T20:00:00.000Z");
  const oldSec = Math.floor(now.getTime() / 1000) - 301;
  const body = JSON.stringify({ event: "order.paid", data: { id: "ord_stale" } });
  const sig = signPayload(body, oldSec);
  let persisted = 0;
  const res = await processDroppWebhook(
    {
      rawBody: body,
      headers: {
        "x-dropp-timestamp": String(oldSec),
        "x-dropp-signature": sig,
      },
    },
    {
      webhookSecret: MOCK_SECRET,
      now,
      persistDraft: async () => {
        persisted += 1;
        return { seenBefore: false };
      },
    },
  );
  assert.equal(res.status, 401);
  assert.equal(res.body["reason"], "timestamp_expired");
  assert.equal(persisted, 0);
});
