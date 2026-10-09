import type { Message } from "@prisma/client";

const TERMINAL_FILLER = /(?:^|[\s,;:])(?:lol|lmao|haha+|hehe+|лол)[.!?…]*$/iu;

export const FILLER_RETRY_NOTE =
  "You already ended recent messages with the same filler (lol, haha, lmao). Rewrite this reply without that suffix. Do not swap in haha, an emoji, or another repeated closer. Keep the meaning and Amy's voice.";

export function endsWithChatFiller(text: string): boolean {
  return TERMINAL_FILLER.test(text.trim());
}

export function recentFillerNote(history: Pick<Message, "direction" | "sender" | "text">[]): string {
  const recent = amyRecent(history);
  const filled = recent.filter((text) => endsWithChatFiller(text));
  if (filled.length < 2) return "";
  return "You already ended recent messages with lol/haha/lmao. Do not end this reply that way. Do not replace it with the same kind of closer. A normal sentence, tease, or fragment is enough.";
}

export function replyRepeatsTerminalFiller(
  reply: string[],
  history: Pick<Message, "direction" | "sender" | "text">[],
): boolean {
  const recent = amyRecent(history);
  if (recent.filter((text) => endsWithChatFiller(text)).length < 2) return false;
  return reply.some((text) => endsWithChatFiller(text));
}

function amyRecent(history: Pick<Message, "direction" | "sender" | "text">[]): string[] {
  return history
    .filter((message) => message.sender === "AMY" && message.direction === "OUTBOUND")
    .map((message) => message.text?.trim() ?? "")
    .filter(Boolean)
    .slice(-6);
}
