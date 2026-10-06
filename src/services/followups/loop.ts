import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { runDueFollowUps } from "@/services/followups/runDue";
import { telegramBotTransport } from "@/services/transport/telegramBotTransport";

const globalState = globalThis as { amyFollowUpLoop?: boolean };

export function startFollowUpLoop(): void {
  if (globalState.amyFollowUpLoop) return;
  globalState.amyFollowUpLoop = true;
  const tick = () => {
    const env = getEnv();
    void runDueFollowUps({
      transport: telegramBotTransport,
      appTimeZone: env.APP_TIMEZONE,
      quietStart: env.QUIET_HOURS_START,
      quietEnd: env.QUIET_HOURS_END,
    }).catch((error: unknown) => {
      logger.error("followup.sent", {
        failed: true,
        name: error instanceof Error ? error.name : "Error",
      });
    });
  };
  setInterval(tick, 60_000);
}
