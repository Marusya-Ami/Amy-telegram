import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramUpdate } from "@/lib/telegram/types";
import {
  COMPARISON_CANDIDATE_MODEL,
  classifyCompareCommand,
  compareReplies,
  comparisonCompletionBody,
  describeOpenAIError,
  formatComparison,
  processCompareAdminCommand,
  type CompareContext,
} from "@/services/amyBrain/compare";

test("only the numeric owner can compare replies", () => {
  const update = command("42", "/compare_reply send me a pic");
  assert.equal(classifyCompareCommand(update, ""), null);
  assert.equal(classifyCompareCommand(update, "99"), null);
  assert.equal(classifyCompareCommand(command("42", "/compare_last"), "42")?.kind, "last");
  assert.equal(classifyCompareCommand({ ...update, business_message: update.message, message: undefined }, "42"), null);
  assert.equal(classifyCompareCommand(command("42", "/compare_reply hello"), "42")?.kind, "reply");
});

test("both models receive the same prompt and the production model is unchanged", async () => {
  const seen: Array<{ model: string; messages: unknown }> = [];
  const samples = await compareReplies(context("никаких сексуальных фоточек?"), {
    models: [
      { label: "A", model: "gpt-4o-mini" },
      { label: "B", model: COMPARISON_CANDIDATE_MODEL },
    ],
    complete: async (model, messages) => {
      seen.push({ model, messages });
      const text = model === "gpt-4o-mini" ? "нет, не моего стиля" : "может и есть";
      return { content: JSON.stringify({ messages: [text] }), latencyMs: model === "gpt-4o-mini" ? 11 : 22, promptTokens: 10, completionTokens: 4 };
    },
  });
  assert.deepEqual(seen.map((call) => call.model), ["gpt-4o-mini", COMPARISON_CANDIDATE_MODEL]);
  assert.deepEqual(seen[0]?.messages, seen[1]?.messages);
  assert.equal(samples[0]?.messages[0], "нет, не моего стиля");
  assert.equal(samples[0]?.guard, "would replace");
  assert.equal(samples[1]?.guard, "clear");
  const formatted = formatComparison("никаких сексуальных фоточек?", samples).join("\n");
  assert.match(formatted, /gpt-4o-mini/);
  assert.match(formatted, /gpt-5\.6-luna/);
  assert.doesNotMatch(formatted, /winner/i);
});

test("a comparison is sent only to the owner and does not call the customer path", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  let completions = 0;
  await processCompareAdminCommand(command("42", "/compare_reply what are you wearing?"), "42", {
    productionModel: "gpt-4o-mini",
    loadContext: async () => context("what are you wearing?"),
    complete: async () => {
      completions += 1;
      return { content: JSON.stringify({ messages: ["curious"] }), latencyMs: 5, promptTokens: 1, completionTokens: 1 };
    },
    send: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  });
  assert.equal(completions, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chatId, "42");
  assert.match(sent[0]?.text ?? "", /gpt-5\.6-luna/);
});

test("luna comparison omits mini-only parameters and surfaces the OpenAI error", async () => {
  const messages = [{ role: "user" as const, content: "ping" }];
  const mini = comparisonCompletionBody("gpt-4o-mini", messages);
  const luna = comparisonCompletionBody(COMPARISON_CANDIDATE_MODEL, messages);
  assert.equal(mini.temperature, 0.8);
  assert.equal(mini.max_tokens, 500);
  assert.equal("max_completion_tokens" in mini, false);
  assert.equal("temperature" in luna, false);
  assert.equal("max_tokens" in luna, false);
  assert.equal(luna.max_completion_tokens, 500);
  assert.deepEqual(luna.response_format, { type: "json_object" });

  const samples = await compareReplies(context("я хочу посмотреть на тебя"), {
    models: [{ label: "B", model: COMPARISON_CANDIDATE_MODEL }],
    complete: async () => {
      const error = Object.assign(new Error("hidden"), {
        status: 400,
        request_id: "req_test",
        error: {
          message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          type: "invalid_request_error",
          param: "max_tokens",
          code: "unsupported_parameter",
        },
      });
      throw error;
    },
  });
  const details = describeOpenAIError(Object.assign(new Error("hidden"), {
    status: 400,
    error: { message: "bad param", type: "invalid_request_error", param: "temperature", code: "unsupported_value" },
  }));
  assert.equal(details.param, "temperature");
  const formatted = formatComparison("я хочу посмотреть на тебя", samples).join("\n");
  assert.match(formatted, /FAILED/);
  assert.match(formatted, /status: 400/);
  assert.match(formatted, /type: invalid_request_error/);
  assert.match(formatted, /code: unsupported_parameter/);
  assert.match(formatted, /param: max_tokens/);
  assert.match(formatted, /max_completion_tokens/);
  assert.match(formatted, /request: req_test/);
  assert.doesNotMatch(formatted, /gpt-4o-mini/);
});

test("the luna probe stays owner-only and reports a failed layer without customer context", async () => {
  const seen: string[] = [];
  const sent: string[] = [];
  await processCompareAdminCommand(command("42", "/compare_probe"), "42", {
    completeRaw: async (body) => {
      seen.push(JSON.stringify(body.messages));
      if (body.response_format) {
        const error = Object.assign(new Error("hidden"), {
          status: 400,
          error: { message: "bad schema", type: "invalid_request_error", param: "response_format", code: null },
        });
        throw error;
      }
      return { content: "pong", latencyMs: 3, promptTokens: 1, completionTokens: 1 };
    },
    send: async (_chatId, text) => {
      sent.push(text);
    },
  });
  assert.equal(classifyCompareCommand(command("42", "/compare_probe"), "99"), null);
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen.join(" "), /Amy|relationship|memory/i);
  assert.match(sent.join("\n"), /plain: ok/);
  assert.match(sent.join("\n"), /json: FAILED/);
  assert.match(sent.join("\n"), /param: response_format/);
});

function context(text: string): CompareContext {
  return {
    user: {
      id: "user-1",
      relationshipStage: "ENGAGED",
      conversationSummary: "A light chat.",
      firstName: "Alex",
      interactionDynamic: "UNKNOWN",
      interactionDynamicConfidence: 0,
    },
    history: [{ direction: "INBOUND", sender: "USER", text: "hey" }],
    currentMessages: [text],
    memories: [{ key: "name", value: "Alex" }],
  };
}

function command(id: string, text: string): TelegramUpdate {
  const numeric = Number(id);
  return {
    update_id: numeric,
    message: {
      message_id: numeric,
      text,
      chat: { id: numeric, type: "private" },
      from: { id: numeric, is_bot: false },
    },
  };
}
