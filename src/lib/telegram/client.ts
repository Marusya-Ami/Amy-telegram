import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { sleep, withRetry } from "@/lib/retry";

const TELEGRAM_API = "https://api.telegram.org";

export class TelegramRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly description?: string,
  ) {
    super(message);
    this.name = "TelegramRequestError";
  }
}

type SendResult = {
  messageId: string;
};

export async function sendTextMessage(chatId: string, text: string): Promise<SendResult> {
  const chunks = splitTelegramText(text);
  let last: SendResult | null = null;

  for (const chunk of chunks) {
    last = await sendChunk(chatId, chunk);
  }

  if (!last) {
    throw new TelegramRequestError("Refused to send an empty Telegram message", 400, false);
  }

  return last;
}

async function sendChunk(chatId: string, text: string): Promise<SendResult> {
  const started = Date.now();

  return withRetry(
    "telegram.sendMessage",
    async () => {
      const token = getEnv().TELEGRAM_BOT_TOKEN;
      const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; description?: string; parameters?: { retry_after?: number }; result?: { message_id?: number } }
        | null;

      if (!response.ok || !payload?.ok || payload.result?.message_id == null) {
        const retryAfter = payload?.parameters?.retry_after;
        if (response.status === 429 && retryAfter) {
          await sleep(Math.min(retryAfter, 5) * 1000);
        }

        logger.error("telegram.outbound_failed", {
          chatId,
          status: response.status,
          description: payload?.description ?? "unknown",
          durationMs: Date.now() - started,
        });

        throw new TelegramRequestError(
          "Telegram sendMessage failed",
          response.status,
          response.status === 429 || response.status >= 500,
          payload?.description,
        );
      }

      logger.info("telegram.outbound", {
        chatId,
        telegramMessageId: String(payload.result.message_id),
        chars: text.length,
        durationMs: Date.now() - started,
      });

      return { messageId: String(payload.result.message_id) };
    },
    {
      attempts: 3,
      isRetryable: (error) => error instanceof TelegramRequestError && error.retryable,
    },
  );
}

export async function sendChatAction(chatId: string, action: "typing"): Promise<void> {
  const token = getEnv().TELEGRAM_BOT_TOKEN;
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });

  if (!response.ok) {
    logger.warn("telegram.typing_failed", { chatId, status: response.status });
  }
}

function splitTelegramText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const limit = 4000;
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    chunks.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
