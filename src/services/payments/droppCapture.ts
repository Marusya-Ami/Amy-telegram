import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";

/** Discovery only. This is not a verified Dropp schema or signature scheme. */
export const DROPP_AUTHENTICATION = "UNVERIFIED" as const;

const MAX_STORE_CHARS = 100_000;
const MAX_STRING = 4_000;
const MAX_OBSERVATIONS = 80;
const MAX_DEPTH = 6;

const SENSITIVE_KEY =
  /token|secret|password|authorization|api[_-]?key|credential|cookie|cvv|cvc|\bpan\b|card(?:number|_number)?|signature|(?:^|_)sig$/i;
const SENSITIVE_TEXT_SOURCE =
  /bearer\s+[A-Za-z0-9._~+/-]+=*|basic\s+[A-Za-z0-9+/=]+|\b(?:sk|rk|pk)-[A-Za-z0-9]+|\bdrp_(?:live|test)_[A-Za-z0-9]+|(api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi;

const SIGNATURE_HEADER = /signature|(?:^|[-_])sig$|webhook-sign/i;
const RELEVANT_HEADER =
  /^(content-type|user-agent)$|signature|(?:^|[-_])sig$|webhook|dropp|event|delivery|idempoten|request-id|correlation|trace/i;

const FIELD_GROUPS: Record<string, readonly string[]> = {
  eventType: ["type", "event", "event_type", "eventType"],
  eventId: ["event_id", "eventId", "webhook_id", "webhookId", "delivery_id", "deliveryId", "id"],
  orderId: ["order_id", "orderId"],
  paymentId: ["payment_id", "paymentId", "transaction_id", "transactionId", "charge_id", "chargeId"],
  contentId: [
    "link_id",
    "linkId",
    "vault_id",
    "vaultId",
    "content_id",
    "contentId",
    "copy_slug",
    "copySlug",
    "product_id",
    "productId",
    "external_link_id",
    "externalLinkId",
  ],
  money: ["amount", "currency", "total", "price"],
  status: ["status", "payment_status", "paymentStatus", "state"],
  time: [
    "created_at",
    "createdAt",
    "updated_at",
    "updatedAt",
    "timestamp",
    "paid_at",
    "paidAt",
    "refunded_at",
    "refundedAt",
    "occurred_at",
    "occurredAt",
  ],
  buyer: [
    "buyer",
    "customer",
    "email",
    "user",
    "user_id",
    "userId",
    "customer_id",
    "customerId",
    "payer",
    "payer_id",
    "payerId",
  ],
  telegram: ["telegram", "telegram_id", "telegramId", "telegram_user_id", "telegramUserId", "chat_id", "chatId"],
  discriminator: ["donation", "kind", "product", "product_type", "productType"],
  reference: [
    "metadata",
    "reference",
    "client_reference_id",
    "clientReferenceId",
    "external_reference",
    "externalReference",
    "custom",
    "custom_data",
    "customData",
    "note",
  ],
};

const GROUP_BY_KEY = new Map<string, string>();
for (const [group, keys] of Object.entries(FIELD_GROUPS)) {
  for (const key of keys) GROUP_BY_KEY.set(key, group);
}

export type SignatureObservation = {
  name: string;
  valueLength: number;
  shape: "empty" | "opaque" | "composed";
  composedKeys: string[];
};

export type FieldObservation = {
  group: string;
  path: string;
  value: unknown;
};

export type DroppCaptureDraft = {
  httpMethod: string;
  contentType: string | null;
  bodyKind: "empty" | "json" | "malformed" | "text";
  bodySha256: string;
  bodyBytes: number;
  headerNames: string[];
  signatureHeaders: SignatureObservation[];
  authorizationScheme: string | null;
  cookieHeaderPresent: boolean;
  authentication: typeof DROPP_AUTHENTICATION;
  topLevelKeys: string[];
  observedFields: FieldObservation[];
  structure: unknown;
  payload: unknown;
};

export function inspectDroppRequest(input: {
  method: string;
  contentType: string | null;
  headers: Iterable<[string, string]>;
  rawBody: string;
}): DroppCaptureDraft {
  const headerNames: string[] = [];
  const signatureHeaders: SignatureObservation[] = [];
  let authorizationScheme: string | null = null;
  let cookieHeaderPresent = false;
  let contentType = input.contentType;

  for (const [name, value] of input.headers) {
    const lower = name.toLowerCase();
    if (lower === "cookie") {
      cookieHeaderPresent = true;
      continue;
    }
    if (lower === "authorization") {
      authorizationScheme = authorizationSchemeOf(value);
      headerNames.push(lower);
      continue;
    }
    if (SIGNATURE_HEADER.test(lower)) {
      headerNames.push(lower);
      signatureHeaders.push(inspectSignature(lower, value));
      continue;
    }
    if (!RELEVANT_HEADER.test(lower)) continue;
    headerNames.push(lower);
    if (lower === "content-type" && !contentType) contentType = value.slice(0, 200);
  }

  const rawBody = input.rawBody ?? "";
  const bodyBytes = Buffer.byteLength(rawBody);
  const bodySha256 = createHash("sha256").update(rawBody).digest("hex");
  const parsed = parseBody(rawBody, contentType);

  return {
    httpMethod: input.method.slice(0, 16),
    contentType: contentType ? contentType.slice(0, 200) : null,
    bodyKind: parsed.kind,
    bodySha256,
    bodyBytes,
    headerNames,
    signatureHeaders,
    authorizationScheme,
    cookieHeaderPresent,
    authentication: DROPP_AUTHENTICATION,
    topLevelKeys: parsed.topLevelKeys,
    observedFields: parsed.observedFields,
    structure: parsed.structure,
    payload: parsed.payload,
  };
}

export type DroppCheckoutMatch = {
  slug: string;
  externalLinkId: string | null;
};

export type DroppDiagnostic = {
  eventType: unknown;
  linkOrProductId: unknown;
  orderId: unknown;
  paymentId: unknown;
  paymentStatus: unknown;
  amount: unknown;
  currency: unknown;
  buyer: unknown;
  timestamp: unknown;
  reference: unknown;
  signatureHeaderNames: string[];
  authentication: typeof DROPP_AUTHENTICATION;
  signatureValidation: "not_performed";
  checkoutMatch: "matched" | "unmatched" | "no_identifier" | "not_checked" | "lookup_failed";
  matchedOfferSlug: string | null;
  paymentCreated: false;
  contentDelivered: false;
};

export function droppDiagnostic(draft: DroppCaptureDraft, stored: DroppCheckoutMatch | null | undefined): DroppDiagnostic {
  const linkOrProductId = observedGroup(draft, "contentId");
  const linkIds = scalarTexts(linkOrProductId);
  let checkoutMatch: DroppDiagnostic["checkoutMatch"] = "not_checked";
  let matchedOfferSlug: string | null = null;
  if (stored !== undefined) {
    if (!linkIds.length) checkoutMatch = "no_identifier";
    else if (stored?.externalLinkId && linkIds.includes(stored.externalLinkId)) {
      checkoutMatch = "matched";
      matchedOfferSlug = stored.slug;
    } else checkoutMatch = "unmatched";
  }
  return {
    eventType: observedGroup(draft, "eventType"),
    linkOrProductId,
    orderId: observedGroup(draft, "orderId"),
    paymentId: observedGroup(draft, "paymentId"),
    paymentStatus: observedGroup(draft, "status"),
    amount: observedMoney(draft, "amount"),
    currency: observedMoney(draft, "currency"),
    buyer: maskDiagnosticValue(observedGroup(draft, "buyer")),
    timestamp: observedGroup(draft, "time"),
    reference: observedGroup(draft, "reference"),
    signatureHeaderNames: draft.signatureHeaders.map((header) => header.name),
    authentication: DROPP_AUTHENTICATION,
    signatureValidation: "not_performed",
    checkoutMatch,
    matchedOfferSlug,
    paymentCreated: false,
    contentDelivered: false,
  };
}

export async function matchStoredDroppCheckout(draft: DroppCaptureDraft): Promise<DroppCheckoutMatch | null> {
  const linkIds = scalarTexts(observedGroup(draft, "contentId"));
  if (!linkIds.length) return null;
  const row = await prisma.paymentOfferExternalCheckout.findFirst({
    where: { provider: "DROPP", active: true, externalLinkId: { in: linkIds } },
    select: { externalLinkId: true, offer: { select: { slug: true } } },
  });
  if (!row) return null;
  return { slug: row.offer.slug, externalLinkId: row.externalLinkId };
}

export async function handleDroppWebhook(
  request: Request,
  persist: (draft: DroppCaptureDraft) => Promise<{ seenBefore: boolean }>,
  lookup?: (draft: DroppCaptureDraft) => Promise<DroppCheckoutMatch | null>,
): Promise<Response> {
  try {
    const rawBody = await request.text();
    const draft = inspectDroppRequest({
      method: request.method,
      contentType: request.headers.get("content-type"),
      headers: request.headers,
      rawBody,
    });
    const stored = await persist(draft);
    let diagnostic: DroppDiagnostic;
    if (!lookup) diagnostic = droppDiagnostic(draft, undefined);
    else {
      try {
        diagnostic = droppDiagnostic(draft, await lookup(draft));
      } catch {
        diagnostic = { ...droppDiagnostic(draft, undefined), checkoutMatch: "lookup_failed" };
      }
    }
    logger.info("dropp.webhook.captured", {
      authentication: draft.authentication,
      bodyKind: draft.bodyKind,
      bodyBytes: draft.bodyBytes,
      topLevelKeys: draft.topLevelKeys,
      headerNames: draft.headerNames,
      signatureHeaderNames: diagnostic.signatureHeaderNames,
      signatureShapes: draft.signatureHeaders.map((header) => header.shape),
      seenBefore: stored.seenBefore,
    });
    logger.info("dropp.webhook.diagnostic", diagnostic);
    return Response.json({ ok: true, authentication: "unverified" }, { status: 200 });
  } catch (error) {
    logger.error("dropp.webhook.capture_failed", {
      message: error instanceof Error ? error.name : "CaptureError",
    });
    return Response.json({ ok: false }, { status: 500 });
  }
}

export async function persistDroppCapture(draft: DroppCaptureDraft): Promise<{ seenBefore: boolean }> {
  const prior = await prisma.droppWebhookCapture.findFirst({
    where: { bodySha256: draft.bodySha256 },
    select: { id: true },
  });
  await prisma.droppWebhookCapture.create({
    data: {
      httpMethod: draft.httpMethod,
      contentType: draft.contentType,
      bodyKind: draft.bodyKind,
      bodySha256: draft.bodySha256,
      bodyBytes: draft.bodyBytes,
      headerNames: draft.headerNames as Prisma.InputJsonValue,
      signatureHeaders: draft.signatureHeaders as unknown as Prisma.InputJsonValue,
      authorizationScheme: draft.authorizationScheme,
      cookieHeaderPresent: draft.cookieHeaderPresent,
      authentication: draft.authentication,
      topLevelKeys: draft.topLevelKeys as Prisma.InputJsonValue,
      observedFields: draft.observedFields as unknown as Prisma.InputJsonValue,
      structure: jsonValue(draft.structure),
      payload: jsonValue(draft.payload),
      seenBefore: Boolean(prior),
    },
  });
  return { seenBefore: Boolean(prior) };
}

function authorizationSchemeOf(value: string): string {
  const scheme = value.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (scheme === "bearer" || scheme === "basic") return scheme;
  return scheme ? "other" : "empty";
}

function inspectSignature(name: string, value: string): SignatureObservation {
  const trimmed = value.trim();
  if (!trimmed) return { name, valueLength: 0, shape: "empty", composedKeys: [] };
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  const composedKeys = parts
    .filter((part) => part.includes("="))
    .map((part) => part.split("=", 1)[0]?.trim() ?? "")
    .filter(Boolean);
  if (composedKeys.length > 0) {
    return { name, valueLength: trimmed.length, shape: "composed", composedKeys };
  }
  return { name, valueLength: trimmed.length, shape: "opaque", composedKeys: [] };
}

function parseBody(rawBody: string, contentType: string | null): {
  kind: DroppCaptureDraft["bodyKind"];
  topLevelKeys: string[];
  observedFields: FieldObservation[];
  structure: unknown;
  payload: unknown;
} {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return { kind: "empty", topLevelKeys: [], observedFields: [], structure: null, payload: null };
  }

  const declaredJson = (contentType ?? "").toLowerCase().includes("json");
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (declaredJson || looksJson) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const sanitized = limitPayload(sanitize(parsed));
      return {
        kind: "json",
        topLevelKeys: topLevelKeys(parsed),
        observedFields: observeFields(sanitized),
        structure: shapeOf(sanitized, 0),
        payload: sanitized,
      };
    } catch {
      return malformed(rawBody);
    }
  }

  return {
    kind: "text",
    topLevelKeys: [],
    observedFields: [],
    structure: "text",
    payload: { preview: redactText(trimmed).slice(0, 500) },
  };
}

function malformed(rawBody: string): {
  kind: "malformed";
  topLevelKeys: string[];
  observedFields: FieldObservation[];
  structure: null;
  payload: { unparsed: true; preview: string };
} {
  return {
    kind: "malformed",
    topLevelKeys: [],
    observedFields: [],
    structure: null,
    payload: { unparsed: true, preview: redactText(rawBody).slice(0, 500) },
  };
}

function topLevelKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, 100);
}

function observeFields(value: unknown): FieldObservation[] {
  const found: FieldObservation[] = [];
  walkObservations(value, "", found);
  return found.slice(0, MAX_OBSERVATIONS);
}

function walkObservations(value: unknown, path: string, found: FieldObservation[]): void {
  if (found.length >= MAX_OBSERVATIONS) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 5); index += 1) {
      walkObservations(value[index], `${path}[${index}]`, found);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    const group = GROUP_BY_KEY.get(key);
    if (group) {
      found.push({ group, path: nextPath, value: observationValue(nested) });
    }
    if (nested && typeof nested === "object") walkObservations(nested, nextPath, found);
  }
}

function observationValue(value: unknown): unknown {
  if (Array.isArray(value)) return { arrayLength: value.length };
  if (value && typeof value === "object") return { objectKeys: Object.keys(value).slice(0, 40) };
  if (typeof value === "string") return maskEmail(redactText(value)).slice(0, MAX_STRING);
  return value;
}

function observedGroup(draft: DroppCaptureDraft, group: string): unknown {
  const matches = draft.observedFields.filter((field) => field.group === group);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0]?.value ?? null;
  return matches.map((field) => ({ path: field.path, value: field.value }));
}

function observedMoney(draft: DroppCaptureDraft, key: "amount" | "currency"): unknown {
  const matches = draft.observedFields.filter((field) => field.group === "money" && field.path.split(".").pop() === key);
  if (!matches.length) return null;
  return matches.length === 1 ? matches[0]?.value ?? null : matches.map((field) => field.value);
}

function scalarTexts(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.length > 0) return [item];
    if (item && typeof item === "object" && "value" in item && typeof item.value === "string" && item.value.length > 0) {
      return [item.value];
    }
    return [];
  });
}

function maskDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return maskEmail(value);
  if (Array.isArray(value)) return value.map((item) => maskDiagnosticValue(item));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) output[key] = maskDiagnosticValue(nested);
    return output;
  }
  return value;
}

function shapeOf(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "max_depth";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, item: value.length ? shapeOf(value[0], depth + 1) : null };
  }
  if (typeof value === "object") {
    const keys: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) keys[key] = shapeOf(nested, depth + 1);
    return { type: "object", keys };
  }
  return typeof value;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "string") return maskEmail(redactText(value)).slice(0, MAX_STRING);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(nested);
  }
  return output;
}

function redactText(value: string): string {
  return value.replace(new RegExp(SENSITIVE_TEXT_SOURCE.source, "gi"), "[redacted]");
}

function maskEmail(value: string): string {
  return value.replace(
    /(^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9-]*(\.[A-Za-z0-9.-]+)?/g,
    "$1$2***@$3***$4",
  );
}

function jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function limitPayload(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded.length <= MAX_STORE_CHARS) return value;
  return { truncated: true, preview: encoded.slice(0, 2_000) };
}
