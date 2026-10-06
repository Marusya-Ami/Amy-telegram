import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { secretsMatch } from "@/lib/security";
import { runDueFollowUps } from "@/services/followups/runDue";
import { telegramBotTransport } from "@/services/transport/telegramBotTransport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const env = getEnv();
  const provided = request.headers.get("x-cron-secret");
  if (!env.CRON_SECRET || !secretsMatch(provided, env.CRON_SECRET)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const result = await runDueFollowUps({
      transport: telegramBotTransport,
      appTimeZone: env.APP_TIMEZONE,
      quietStart: env.QUIET_HOURS_START,
      quietEnd: env.QUIET_HOURS_END,
    });
    return NextResponse.json({ ok: true, sentUsers: result.sentUsers, skipped: result.skipped });
  } catch (error) {
    logger.error("followup.sent", {
      failed: true,
      name: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
