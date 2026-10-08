import assert from "node:assert/strict";
import test from "node:test";
import { createDroppVaultCheckout, DroppVaultPaymentError, droppCardPaymentEnabled } from "./droppVaultPayment";

test("Dropp card payments stay disabled unless DROPP_CARD_PAYMENT_ENABLED is exactly true", () => {
  assert.equal(droppCardPaymentEnabled("false"), false);
  assert.equal(droppCardPaymentEnabled(undefined), false);
  assert.equal(droppCardPaymentEnabled(""), false);
  assert.equal(droppCardPaymentEnabled("TRUE"), false);
  assert.equal(droppCardPaymentEnabled("1"), false);
  assert.equal(droppCardPaymentEnabled("true"), true);
});

test("createDroppVaultCheckout refuses to mint when the feature flag is not exactly true", async () => {
  const previous = process.env.DROPP_CARD_PAYMENT_ENABLED;
  try {
    for (const value of [undefined, "", "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.DROPP_CARD_PAYMENT_ENABLED;
      else process.env.DROPP_CARD_PAYMENT_ENABLED = value;
      await assert.rejects(
        () => createDroppVaultCheckout({ userId: "user_unused", offerSlug: "offer_unused" }),
        (err: unknown) => {
          assert.ok(err instanceof DroppVaultPaymentError);
          assert.equal(err.code, "card_payment_disabled");
          return true;
        },
      );
    }
  } finally {
    if (previous === undefined) delete process.env.DROPP_CARD_PAYMENT_ENABLED;
    else process.env.DROPP_CARD_PAYMENT_ENABLED = previous;
  }
});
