import { logger } from "@/lib/logger";

export class DroppApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "DroppApiError";
  }
}

export type CreateVaultLinkInput = {
  linkId: string;
  paymentIntentId: string;
  offerSlug: string;
  telegramUserId: string;
  idempotencyKey?: string;
  operatorProfileId?: string;
};

export type DroppVaultLinkResult = {
  linkId: string;
  shareUrl: string;
  miniAppUrl: string;
  buttonText: string;
  photoUrl: string | null;
  coverUrl: string | null;
  caption: string | null;
  expiresAt: string | null;
  price?: {
    amountCents: number;
    currencyCode: string;
    display: string;
  };
};

export type DroppClientDeps = {
  fetch?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
};

type DroppVaultLinkApiResponse = {
  data?: {
    link_id?: string;
    copy?: {
      id?: string;
      slug?: string;
      metadata?: Record<string, unknown>;
    };
    share_url?: string;
    price?: {
      amount_cents?: number;
      currency_code?: string;
      display?: string;
    };
    telegram?: {
      photo_url?: string;
      cover_url?: string;
      caption?: string;
      button?: {
        text?: string;
        url?: string;
      };
    };
    expires_at?: string;
  };
  error?: {
    message?: string;
    code?: string;
  };
};

function resolveDroppBaseUrl(configuredBase?: string): string {
  const raw = configuredBase || process.env["DROPP_API_BASE_URL"] || "https://api.external.dropp.fans/v1";
  return raw.replace(/\/+$/, "");
}

function resolveDroppApiKey(configuredKey?: string): string {
  return (configuredKey || process.env["DROPP_API_KEY"] || "").trim();
}

/**
 * Mint a shareable Telegram Vault link for a Dropp link.
 * Calls POST /v1/links/{link_id}/vault-link (scope links:write).
 * Uses a deterministic Idempotency-Key tied to the PaymentIntent.
 */
export async function createVaultLink(
  input: CreateVaultLinkInput,
  deps: DroppClientDeps = {},
): Promise<DroppVaultLinkResult> {
  const apiKey = resolveDroppApiKey(deps.apiKey);
  if (!apiKey) {
    throw new DroppApiError("Dropp API key is not configured", 500);
  }

  const baseUrl = resolveDroppBaseUrl(deps.baseUrl);
  const linkIdEncoded = encodeURIComponent(input.linkId);
  const path = baseUrl.endsWith("/v1")
    ? `${baseUrl}/links/${linkIdEncoded}/vault-link`
    : `${baseUrl}/v1/links/${linkIdEncoded}/vault-link`;

  const idempotencyKey = input.idempotencyKey ?? `dropp-vault:${input.paymentIntentId}`;

  // Minimal, non-PII correlation metadata far below the 8 KB limit
  const metadata: Record<string, string> = {
    paymentIntentId: input.paymentIntentId,
    offerSlug: input.offerSlug,
    telegramUserId: String(input.telegramUserId),
  };

  const requestBody: {
    metadata: Record<string, string>;
    operator_profile_id?: string;
  } = { metadata };

  if (input.operatorProfileId) {
    requestBody.operator_profile_id = input.operatorProfileId;
  }

  const fetchImpl = deps.fetch ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    logger.error("dropp.vault_link.network_error", {
      linkId: input.linkId,
      paymentIntentId: input.paymentIntentId,
      name: err instanceof Error ? err.name : "NetworkError",
    });
    throw new DroppApiError(
      `Failed to connect to Dropp Vault API: ${err instanceof Error ? err.message : "Network error"}`,
      502,
    );
  }

  const rawText = await response.text();
  let json: DroppVaultLinkApiResponse | null = null;
  try {
    json = JSON.parse(rawText) as DroppVaultLinkApiResponse;
  } catch {
    json = null;
  }

  if (!response.ok) {
    logger.warn("dropp.vault_link.api_rejected", {
      status: response.status,
      linkId: input.linkId,
      paymentIntentId: input.paymentIntentId,
      errorCode: json?.error?.code,
    });
    throw new DroppApiError(
      json?.error?.message ?? `Dropp Vault API returned status ${response.status}`,
      response.status,
      rawText,
    );
  }

  const data = json?.data;
  if (!data) {
    logger.error("dropp.vault_link.malformed_response", {
      status: response.status,
      linkId: input.linkId,
      paymentIntentId: input.paymentIntentId,
    });
    throw new DroppApiError("Dropp Vault API response missing data field", 502, rawText);
  }

  const miniAppUrl = data.telegram?.button?.url || data.share_url;
  if (!miniAppUrl) {
    logger.error("dropp.vault_link.missing_url", {
      linkId: input.linkId,
      paymentIntentId: input.paymentIntentId,
    });
    throw new DroppApiError("Dropp Vault response missing Mini App / share URL", 502, rawText);
  }

  return {
    linkId: data.link_id ?? input.linkId,
    shareUrl: data.share_url ?? miniAppUrl,
    miniAppUrl,
    buttonText: data.telegram?.button?.text ?? "💳 Pay by card",
    photoUrl: data.telegram?.photo_url ?? null,
    coverUrl: data.telegram?.cover_url ?? null,
    caption: data.telegram?.caption ?? null,
    expiresAt: data.expires_at ?? null,
    price: data.price
      ? {
          amountCents: data.price.amount_cents ?? 0,
          currencyCode: data.price.currency_code ?? "USD",
          display: data.price.display ?? "",
        }
      : undefined,
  };
}
