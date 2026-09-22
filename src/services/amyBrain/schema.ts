import { z } from "zod";

export const amyReplySchema = z.object({
  messages: z.array(z.string().trim().min(1).max(3500)).min(1).max(3),
});

export type AmyReply = z.infer<typeof amyReplySchema>;

export function parseAmyReply(payload: unknown): AmyReply {
  const record = typeof payload === "string" ? parseJsonObject(payload) : payload;
  return amyReplySchema.parse(record);
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  return JSON.parse(candidate);
}
