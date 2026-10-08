import assert from "node:assert/strict";
import test from "node:test";
import { createVaultLink, DroppApiError } from "./droppClient";

const MOCK_API_KEY = "drp_live_testapikey123456789";
const MOCK_LINK_ID = "link_H4HzUQ1_5SN9YykZNvpx";
const MOCK_INTENT_ID = "cmut_intent_test_123";
const MOCK_OFFER_SLUG = "keep-it-secret-10";
const MOCK_TELEGRAM_USER_ID = "688907647";

test("createVaultLink calls POST /v1/links/{link_id}/vault-link with proper headers, body, and metadata", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: unknown = null;

  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedMethod = init?.method ?? "";
    capturedHeaders = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
    capturedBody = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        data: {
          link_id: MOCK_LINK_ID,
          copy: {
            id: "link_cpd_test123",
            slug: "aB3kPq9z",
            metadata: {
              paymentIntentId: MOCK_INTENT_ID,
              offerSlug: MOCK_OFFER_SLUG,
              telegramUserId: MOCK_TELEGRAM_USER_ID,
            },
          },
          share_url: "https://app.dropp.fans/v/aB3kPq9z",
          price: {
            amount_cents: 1000,
            currency_code: "USD",
            display: "$10.00",
          },
          telegram: {
            photo_url: "https://app.dropp.fans/v/aB3kPq9z/opengraph-image",
            cover_url: "https://app.dropp.fans/v/aB3kPq9z/cover",
            caption: "🔒 Keep It Secret",
            button: {
              text: "🔒 Unlock for $10.00",
              url: "https://t.me/droppbot/vault?startapp=aB3kPq9z_signedtoken",
            },
          },
          expires_at: "2027-10-05T00:00:00.000Z",
        },
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await createVaultLink(
    {
      linkId: MOCK_LINK_ID,
      paymentIntentId: MOCK_INTENT_ID,
      offerSlug: MOCK_OFFER_SLUG,
      telegramUserId: MOCK_TELEGRAM_USER_ID,
    },
    {
      apiKey: MOCK_API_KEY,
      baseUrl: "https://api.external.dropp.fans/v1",
      fetch: mockFetch,
    },
  );

  // 1. Correct endpoint and linkId
  assert.equal(capturedUrl, `https://api.external.dropp.fans/v1/links/${MOCK_LINK_ID}/vault-link`);
  assert.equal(capturedMethod, "POST");

  // 2. Authorization header present with Bearer token
  assert.equal(capturedHeaders["authorization"], `Bearer ${MOCK_API_KEY}`);
  assert.equal(capturedHeaders["content-type"], "application/json");

  // 3. Deterministic Idempotency-Key
  const expectedIdempotencyKey = `dropp-vault:${MOCK_INTENT_ID}`;
  assert.equal(capturedHeaders["idempotency-key"], expectedIdempotencyKey);

  // 4. Metadata includes only necessary correlation identifiers, no PII
  assert.deepEqual(capturedBody, {
    metadata: {
      paymentIntentId: MOCK_INTENT_ID,
      offerSlug: MOCK_OFFER_SLUG,
      telegramUserId: MOCK_TELEGRAM_USER_ID,
    },
  });

  // 5. Official Mini App URL extracted directly from Dropp response
  assert.equal(result.miniAppUrl, "https://t.me/droppbot/vault?startapp=aB3kPq9z_signedtoken");
  assert.equal(result.shareUrl, "https://app.dropp.fans/v/aB3kPq9z");
  assert.equal(result.buttonText, "🔒 Unlock for $10.00");
  assert.equal(result.photoUrl, "https://app.dropp.fans/v/aB3kPq9z/opengraph-image");
  assert.equal(result.caption, "🔒 Keep It Secret");
  assert.equal(result.expiresAt, "2027-10-05T00:00:00.000Z");
  assert.deepEqual(result.price, {
    amountCents: 1000,
    currencyCode: "USD",
    display: "$10.00",
  });
});

test("createVaultLink uses deterministic idempotency key across retries", async () => {
  const capturedKeys: string[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers as HeadersInit);
    capturedKeys.push(headers.get("idempotency-key") ?? "");
    return new Response(
      JSON.stringify({
        data: {
          link_id: MOCK_LINK_ID,
          share_url: "https://app.dropp.fans/v/rep1",
          telegram: { button: { url: "https://t.me/droppbot/vault?startapp=token1" } },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const input = {
    linkId: MOCK_LINK_ID,
    paymentIntentId: "intent_retry_456",
    offerSlug: "private-mood",
    telegramUserId: "123456",
  };

  await createVaultLink(input, { apiKey: MOCK_API_KEY, fetch: mockFetch });
  await createVaultLink(input, { apiKey: MOCK_API_KEY, fetch: mockFetch });

  assert.equal(capturedKeys.length, 2);
  assert.equal(capturedKeys[0], "dropp-vault:intent_retry_456");
  assert.equal(capturedKeys[1], "dropp-vault:intent_retry_456");
  assert.equal(capturedKeys[0], capturedKeys[1]);
});

test("createVaultLink falls back to share_url if telegram button is absent", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        data: {
          link_id: MOCK_LINK_ID,
          share_url: "https://app.dropp.fans/v/fallback_share",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await createVaultLink(
    {
      linkId: MOCK_LINK_ID,
      paymentIntentId: MOCK_INTENT_ID,
      offerSlug: MOCK_OFFER_SLUG,
      telegramUserId: MOCK_TELEGRAM_USER_ID,
    },
    { apiKey: MOCK_API_KEY, fetch: mockFetch },
  );

  assert.equal(result.miniAppUrl, "https://app.dropp.fans/v/fallback_share");
  assert.equal(result.shareUrl, "https://app.dropp.fans/v/fallback_share");
});

test("createVaultLink throws DroppApiError on 404 or 400 without exposing secrets in message", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        error: { code: "not_found", message: "Link does not exist or vault is disabled" },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  };

  await assert.rejects(
    async () => {
      await createVaultLink(
        {
          linkId: "link_nonexistent",
          paymentIntentId: MOCK_INTENT_ID,
          offerSlug: MOCK_OFFER_SLUG,
          telegramUserId: MOCK_TELEGRAM_USER_ID,
        },
        { apiKey: MOCK_API_KEY, fetch: mockFetch },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof DroppApiError);
      assert.equal(err.status, 404);
      assert.equal(err.message, "Link does not exist or vault is disabled");
      // Must not leak the API key in the error message
      assert.equal(err.message.includes(MOCK_API_KEY), false);
      return true;
    },
  );
});

test("createVaultLink refuses execution when API key is missing", async () => {
  await assert.rejects(
    async () => {
      await createVaultLink(
        {
          linkId: MOCK_LINK_ID,
          paymentIntentId: MOCK_INTENT_ID,
          offerSlug: MOCK_OFFER_SLUG,
          telegramUserId: MOCK_TELEGRAM_USER_ID,
        },
        { apiKey: "" },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof DroppApiError);
      assert.equal(err.status, 500);
      assert.equal(err.message, "Dropp API key is not configured");
      return true;
    },
  );
});
