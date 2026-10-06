const epochs = new Map<string, number>();

const MAX_HUMAN_DELAY_MS = 20_000;

export function humanReplyDelayMode(raw = process.env["HUMAN_REPLY_DELAY_MODE"]): "off" | "live" {
  return raw?.trim() === "live" ? "live" : "off";
}

export function bumpTurnEpoch(userId: string): number {
  const next = (epochs.get(userId) ?? 0) + 1;
  epochs.set(userId, next);
  return next;
}

export function turnEpoch(userId: string): number {
  return epochs.get(userId) ?? 0;
}

/** Inclusive bounds for one reply, measured on the full generated text. */
export function humanReplyDelayMs(replyChars: number, random: () => number = Math.random): number {
  const [min, max] = delayBand(replyChars);
  const span = max - min;
  const delay = min + Math.floor(random() * (span + 1));
  return Math.min(delay, MAX_HUMAN_DELAY_MS);
}

export function splitHumanDelay(totalMs: number, random: () => number = Math.random): { silenceMs: number; typingMs: number } {
  const silenceFraction = 0.45 + random() * 0.2;
  const silenceMs = Math.min(totalMs, Math.floor(totalMs * silenceFraction));
  return { silenceMs, typingMs: Math.max(0, totalMs - silenceMs) };
}

export async function waitForHumanReply(input: {
  userId: string;
  replyChars: number;
  epochAtStart: number;
  mode?: "off" | "live";
  sleep?: (ms: number) => Promise<void>;
  typing?: () => Promise<void>;
  random?: () => number;
}): Promise<"send" | "stale"> {
  if (turnEpoch(input.userId) !== input.epochAtStart) return "stale";
  const mode = input.mode ?? humanReplyDelayMode();
  if (mode !== "live") return "send";
  const random = input.random ?? Math.random;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const total = humanReplyDelayMs(input.replyChars, random);
  const { silenceMs, typingMs } = splitHumanDelay(total, random);
  if (silenceMs > 0) await sleep(silenceMs);
  if (turnEpoch(input.userId) !== input.epochAtStart) return "stale";
  if (typingMs > 0) {
    await input.typing?.().catch(() => undefined);
    await sleep(typingMs);
  }
  if (turnEpoch(input.userId) !== input.epochAtStart) return "stale";
  return "send";
}

function delayBand(replyChars: number): [number, number] {
  if (replyChars <= 35) return [5_000, 9_000];
  if (replyChars <= 90) return [6_000, 12_000];
  if (replyChars <= 180) return [8_000, 15_000];
  return [10_000, 18_000];
}
