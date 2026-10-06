import OpenAI from "openai";
import { getEnv } from "@/lib/env";
import { AUXILIARY_OPENAI_MODEL } from "@/lib/openaiModels";

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  return client;
}

export async function summarizeConversation(previous: string | null, recent: string): Promise<string> {
  const completion = await openai().chat.completions.create({
    model: AUXILIARY_OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 350,
    messages: [
      {
        role: "system",
        content:
          "Write a short rolling summary of a private chat. Keep important topics, unresolved threads, relationship tone, and recent context. Do not store permanent biographical facts as if they were the summary's job. Do not invent facts. Plain prose, under 120 words.",
      },
      {
        role: "user",
        content: `Previous summary:\n${previous ?? "(none)"}\n\nRecent messages:\n${recent}`,
      },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() ?? previous ?? "";
}
