import { handleDroppWebhookRequest } from "@/services/payments/droppWebhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Production-grade Dropp webhook handler with strict HMAC-SHA256 signature verification. */
export async function POST(request: Request) {
  return handleDroppWebhookRequest(request);
}
