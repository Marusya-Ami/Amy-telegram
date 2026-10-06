import { handleDroppWebhook, matchStoredDroppCheckout, persistDroppCapture } from "@/services/payments/droppCapture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Discovery capture. Signature verification is intentionally not enforced. */
export async function POST(request: Request) {
  return handleDroppWebhook(request, persistDroppCapture, matchStoredDroppCheckout);
}
