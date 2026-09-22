import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { secretsMatch } from "@/lib/security";
import { ingestTelegramUpdate } from "@/services/messageProcessor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (error) {
    logger.error("webhook.config_error", {
      message: error instanceof Error ? error.message : "config_error",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const providedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secretsMatch(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
    logger.warn("webhook.rejected", { reason: "secret_mismatch" });
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    logger.warn("webhook.rejected", { reason: "invalid_json" });
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  try {
    await ingestTelegramUpdate(payload);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("webhook.failed", {
      message: error instanceof Error ? error.name : "WebhookError",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
