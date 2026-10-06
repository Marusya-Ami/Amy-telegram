import assert from "node:assert/strict";
import test from "node:test";
import { droppDiagnostic, handleDroppWebhook, inspectDroppRequest, type DroppCaptureDraft } from "./droppCapture";

const SECRET = "sk-testsecretvalue123";
const BEARER = "super-secret-bearer-token";
const SIGNATURE = "t=1710000000,v1=abcdef1234567890signature";

test("valid JSON POST is captured and acknowledged without a verified signature", async () => {
  const drafts: DroppCaptureDraft[] = [];
  const response = await handleDroppWebhook(
    request(
      JSON.stringify({
        type: "payment.received",
        id: "evt_observed_1",
        order_id: "ord_1",
        payment_id: "pay_1",
        link_id: "vault_1",
        amount: 10,
        currency: "USD",
        status: "paid",
        created_at: "2026-09-25T00:00:00Z",
        customer: { email: "buyer@example.com", telegram_id: "12345" },
        donation: false,
      }),
      {
        "content-type": "application/json",
        "x-dropp-signature": SIGNATURE,
      },
    ),
    async (draft) => {
      drafts.push(draft);
      return { seenBefore: false };
    },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; authentication: string };
  assert.deepEqual(body, { ok: true, authentication: "unverified" });
  const draft = drafts[0];
  assert.ok(draft);
  assert.equal(draft.authentication, "UNVERIFIED");
  assert.equal(draft.bodyKind, "json");
  assert.deepEqual(draft.signatureHeaders.map((header) => header.shape), ["composed"]);
  assert.deepEqual(draft.signatureHeaders[0]?.composedKeys, ["t", "v1"]);
  assert.equal(JSON.stringify(draft.signatureHeaders).includes(SIGNATURE), false);
  assert.equal(observed(draft, "eventType"), "payment.received");
  assert.equal(observed(draft, "eventId"), "evt_observed_1");
  assert.equal(observed(draft, "orderId"), "ord_1");
  assert.equal(observed(draft, "paymentId"), "pay_1");
  assert.equal(observed(draft, "contentId"), "vault_1");
  assert.equal(observed(draft, "money", "amount"), 10);
  assert.equal(observed(draft, "money", "currency"), "USD");
  assert.equal(observed(draft, "telegram"), "12345");
  assert.equal(observed(draft, "discriminator"), false);
  assert.equal(JSON.stringify(draft).includes("buyer@example.com"), false);
  assert.equal(observed(draft, "buyer", "email"), "b***@e***.com");
  const diagnostic = droppDiagnostic(draft, { slug: "shower-time", externalLinkId: "vault_1" });
  assert.equal(diagnostic.paymentStatus, "paid");
  assert.equal(diagnostic.checkoutMatch, "matched");
  assert.equal(diagnostic.matchedOfferSlug, "shower-time");
  assert.equal(diagnostic.authentication, "UNVERIFIED");
  assert.equal(diagnostic.signatureValidation, "not_performed");
  assert.equal(diagnostic.paymentCreated, false);
  assert.equal(diagnostic.contentDelivered, false);
  assert.deepEqual(diagnostic.signatureHeaderNames, ["x-dropp-signature"]);
  assert.equal(JSON.stringify(diagnostic).includes(SIGNATURE), false);
  assert.equal(JSON.stringify(diagnostic).includes("buyer@example.com"), false);
});

test("unknown JSON structure is stored and does not fail", async () => {
  const response = await handleDroppWebhook(
    request(JSON.stringify({ unexpected: { nested: true } }), { "content-type": "application/json" }),
    async () => ({ seenBefore: false }),
  );
  assert.equal(response.status, 200);
  const inspected = inspectDroppRequest({
    method: "POST",
    contentType: "application/json",
    headers: [["content-type", "application/json"]],
    rawBody: JSON.stringify({ unexpected: { nested: true } }),
  });
  assert.deepEqual(inspected.topLevelKeys, ["unexpected"]);
  assert.deepEqual(inspected.observedFields, []);
  assert.equal(inspected.authentication, "UNVERIFIED");
});

test("malformed body is captured without throwing", async () => {
  let kind = "";
  const response = await handleDroppWebhook(request("{not-json", { "content-type": "application/json" }), async (draft) => {
    kind = draft.bodyKind;
    return { seenBefore: false };
  });
  assert.equal(response.status, 200);
  assert.equal(kind, "malformed");
});

test("credentials in the body and headers do not appear in the capture or logs", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line?: unknown) => {
    lines.push(String(line));
  };
  try {
    const raw = JSON.stringify({
      type: "payment.received",
      api_key: SECRET,
      nested: { password: "p@ss", note: `Bearer ${BEARER}` },
    });
    let stored = "";
    const response = await handleDroppWebhook(
      request(raw, {
        "content-type": "application/json",
        authorization: `Bearer ${BEARER}`,
        cookie: "session=sekret",
        "x-signature": SIGNATURE,
      }),
      async (draft) => {
        stored = JSON.stringify(draft);
        return { seenBefore: false };
      },
    );
    assert.equal(response.status, 200);
    const responseText = await response.text();
    const logs = lines.join("\n");
    for (const secret of [SECRET, BEARER, SIGNATURE, "sekret", "p@ss"]) {
      assert.equal(stored.includes(secret), false, secret);
      assert.equal(logs.includes(secret), false, secret);
      assert.equal(responseText.includes(secret), false, secret);
    }
    assert.match(stored, /\[redacted\]/);
    assert.match(logs, /"authentication":"UNVERIFIED"/);
    assert.match(logs, /dropp\.webhook\.captured/);
  } finally {
    console.log = original;
  }
});

test("duplicate-looking deliveries return success and are marked seen before", async () => {
  const raw = JSON.stringify({ hello: "again" });
  const flags: boolean[] = [];
  const persist = async (draft: DroppCaptureDraft) => {
    const seenBefore = flags.length > 0 && flags.every(() => draft.bodySha256.length === 64);
    flags.push(seenBefore);
    return { seenBefore };
  };
  const first = await handleDroppWebhook(request(raw, { "content-type": "application/json" }), persist);
  const second = await handleDroppWebhook(request(raw, { "content-type": "application/json" }), persist);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(flags, [false, true]);
});

test("capture does not require Telegram configuration", async () => {
  const response = await handleDroppWebhook(
    request(JSON.stringify({ type: "order.paid" }), { "content-type": "application/json" }),
    async () => ({ seenBefore: false }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

function request(body: string, headers: Record<string, string>): Request {
  return new Request("https://amy.lawlet.net/api/payments/dropp/webhook", {
    method: "POST",
    headers,
    body,
  });
}

function observed(draft: DroppCaptureDraft, group: string, pathIncludes?: string): unknown {
  const match = draft.observedFields.find(
    (field) => field.group === group && (!pathIncludes || field.path.includes(pathIncludes)),
  );
  return match?.value;
}
