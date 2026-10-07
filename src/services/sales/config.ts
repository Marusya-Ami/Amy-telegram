/** Deterministic sales limits. Shadow mode uses the same values live mode would. */
export const salesConfig = {
  paidOfferMinIntervalMs: 4 * 60 * 60 * 1000,
  paidOfferMaxPer24h: 2,
  paidOfferWindowMs: 24 * 60 * 60 * 1000,
  sameOfferReshowAfterMs: 7 * 24 * 60 * 60 * 1000,
  declineSuppressMs: 7 * 24 * 60 * 60 * 1000,
  freeMediaMinIntervalMs: 15 * 60 * 1000,
  paidOfferMinConfidence: 0.8,
  tipLinkCooldownMs: 24 * 60 * 60 * 1000,
  contextMessageLimit: 8,
  contextLineMaxChars: 240,
} as const;
