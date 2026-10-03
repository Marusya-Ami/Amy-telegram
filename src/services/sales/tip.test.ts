import assert from "node:assert/strict";
import test from "node:test";
import { AMY_PERSONALITY_PROMPT } from "@/prompts/amy-personality";
import { replyCompletionBody } from "@/services/amyBrain";
import { REPLY_LUNA_MODEL } from "@/lib/openaiModels";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { decideSales, commercialReplyContext, TIP_REPLY_HINT } from "@/services/sales/decide";
import { readSalesSignal } from "@/services/sales/signals";
import { formatSalesRecent } from "@/services/sales/inspect";
import { salesConfig } from "@/services/sales/config";
import { buildReplyMessages } from "@/services/amyBrain";
import {
  classifyTipAdminCommand,
  donationUrl,
  processTipAdminCommand,
  stripInventedLinks,
  tipButtonLabel,
  tipLanguage,
  tipMode,
  tipPresentation,
  type TipDelivery,
} from "@/services/sales/tip";
import { contextualTipReading, evaluateTipContext, type TipContextMessage } from "@/services/sales/tipContext";

const NOW = new Date("2026-09-25T18:00:00.000Z");
const CONFIGURED = "https://pay.example/amy";

test("tip phrases are TIP and stay separate from photos", () => {
  const support = decideText("можно тебя поддержать?");
  assert.equal(support.signal.intent, "TIP_DISCUSSION");
  assert.equal(support.decision, "TIP");
  assert.equal(support.candidateOfferId, null);
  assert.equal(support.candidateMediaAssetId, null);

  const tipRu = decideText("куда тебе отправить чаевые?");
  assert.equal(tipRu.signal.intent, "TIP_DISCUSSION");
  assert.equal(tipRu.decision, "TIP");

  const tipEn = decideText("can I tip you?");
  assert.equal(tipEn.signal.intent, "TIP_DISCUSSION");
  assert.equal(tipEn.decision, "TIP");

  const paid = decideText("у тебя есть приватные фото?");
  assert.equal(paid.decision, "PAID_OFFER");
  assert.notEqual(paid.signal.intent, "TIP_DISCUSSION");

  const free = decideText("покажешь фотку?");
  assert.equal(free.decision, "FREE_MEDIA");
  assert.notEqual(free.signal.intent, "TIP_DISCUSSION");

  const flirt = decideText("you're so pretty");
  assert.equal(flirt.signal.intent, "FLIRT");
  assert.notEqual(flirt.decision, "TIP");
});

test("distress suppresses a tip and leaves no donation candidate", () => {
  const decision = decideText("i want to die. can I tip you?");
  assert.equal(decision.signal.emotionalState, "DISTRESSED");
  assert.equal(decision.decision, "NO_OFFER");
  assert.equal(decision.reasonCode, "distress");
  assert.equal(decision.candidateOfferId, null);
  assert.equal(decision.candidateMediaAssetId, null);
});

test("a missing or invalid donation URL is not replaced", () => {
  assert.equal(donationUrl(undefined), null);
  assert.equal(donationUrl(""), null);
  assert.equal(donationUrl("http://insecure.example/tip"), null);
  assert.equal(donationUrl("not a url"), null);
  assert.equal(donationUrl(CONFIGURED), `${CONFIGURED}`);
  assert.equal(tipMode(undefined), "shadow");
  assert.equal(tipMode("live"), "live");
  assert.equal(tipMode("shadow"), "shadow");
  assert.equal(salesConfig.tipLinkCooldownMs, 24 * 60 * 60 * 1000);
});

test("the model cannot invent or replace the donation URL", () => {
  const invented = "https://fake.example/tip";
  const cleaned = stripInventedLinks([`можно 😏 ${invented}`]);
  assert.deepEqual(cleaned, ["можно 😏"]);
  assert.equal(cleaned.join(" ").includes(invented), false);
  assert.equal(donationUrl(CONFIGURED), CONFIGURED);
  assert.equal(cleaned.includes(CONFIGURED), false);
  assert.equal(AMY_PERSONALITY_PROMPT.includes("http"), false);
  const luna = replyCompletionBody(REPLY_LUNA_MODEL, [{ role: "user", content: "ping" }]);
  assert.equal("temperature" in luna, false);
  assert.equal("max_tokens" in luna, false);
  assert.equal(luna.max_completion_tokens, 500);
  assert.equal(JSON.stringify(luna).includes(CONFIGURED), false);
});

test("sales recent shows a TIP decision", () => {
  const text = formatSalesRecent([
    {
      createdAt: NOW,
      decision: "TIP",
      intent: "TIP_DISCUSSION",
      commercialReadiness: "LOW",
      confidence: 0.93,
      desiredContexts: [],
      reasonSummary: "explicit tip or support request",
      candidateOfferSlug: null,
      candidateMediaId: null,
      candidateMediaCategory: null,
    },
  ]);
  assert.match(text, /TIP/);
  assert.match(text, /TIP_DISCUSSION/);
  assert.doesNotMatch(text, /https?:/);
});

test("only the owner can run tip_test", () => {
  const update = commandUpdate("42", "/tip_test 100");
  assert.equal(classifyTipAdminCommand(update, ""), null);
  assert.equal(classifyTipAdminCommand(update, "99"), null);
  assert.equal(classifyTipAdminCommand(commandUpdate("42", "/tip_test"), "42"), null);
  assert.equal(classifyTipAdminCommand(update, "42")?.telegramUserId, "100");
});

test("the tip button keeps the URL out of the visible text", () => {
  assert.equal(tipLanguage({ texts: ["можно тебя поддержать?"] }), "ru");
  assert.equal(tipLanguage({ texts: ["can I tip you?"] }), "en");
  assert.equal(tipLanguage({ texts: ["te puedo dejar una propina?"] }), "es");
  assert.equal(tipLanguage({ texts: ["привет", "can I tip you?"] }), "en");
  assert.equal(tipLanguage({ texts: ["hello", "можно тебя поддержать?"] }), "ru");
  assert.equal(tipLanguage({ texts: ["hello", "te puedo dejar una propina?"] }), "es");
  assert.equal(tipLanguage({ texts: ["ok"] }), "en");
  assert.equal(tipButtonLabel("ru"), "Оставить чаевые 🤍");
  assert.equal(tipButtonLabel("en"), "Leave a tip 🤍");
  assert.equal(tipButtonLabel("es"), "Dejar una propina 🤍");

  for (const language of ["ru", "en", "es"] as const) {
    const view = tipPresentation({ url: CONFIGURED, language, preceding: ["это мило с твоей стороны 🤍"] });
    assert.equal(view.text.includes(CONFIGURED), false);
    assert.equal(view.text.includes("http"), false);
    assert.equal(view.buttonUrl, CONFIGURED);
    assert.equal(view.buttonText, tipButtonLabel(language));
    assert.notEqual(view.text, "это мило с твоей стороны 🤍");
  }

  const missing = donationUrl("not a url");
  assert.equal(missing, null);
  const prompt = buildReplyMessages(
    {
      relationshipStage: "NEW",
      conversationSummary: null,
      firstName: "Alex",
      interactionDynamic: "UNKNOWN",
      interactionDynamicConfidence: 0,
    },
    [],
    ["can I tip you?"],
  );
  const system = String(prompt[0]?.content ?? "");
  assert.equal(system.includes("tipLinkAvailable"), false);
  assert.equal(system.includes(CONFIGURED), false);
  assert.equal(system.includes("http"), false);
  assert.match(system, /Talk like a person/);
  assert.match(system, /Do not mention a button/);
});

test("a delivered reply receives the button without a new carrier message", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { maybeSendTipLink } = await import("@/services/sales/tip");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId, relationshipStage: "ENGAGED" } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip-attach",
    },
  });
  const sent: TipDelivery[] = [];
  try {
    const result = await maybeSendTipLink({
      userId: user.id,
      conversationId: conversation.id,
      triggerMessageId: null,
      decision: "TIP",
      mode: "live",
      url: CONFIGURED,
      now: NOW,
      userTexts: ["Я хочу оставить тебе чаевые"],
      amyTexts: ["мне очень приятно, что ты хочешь меня поддержать"],
      replyMessageId: "876",
      send: async (delivery) => {
        sent.push(delivery);
      },
    });
    assert.equal(result, "sent");
    assert.equal(sent[0]?.attachToMessageId, "876");
    assert.equal(sent[0]?.text, "");
    assert.equal(sent[0]?.buttonText, "Оставить чаевые 🤍");
    assert.equal(sent[0]?.buttonUrl, CONFIGURED);
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id, status: "LINK_SENT" } }), 1);
    await prisma.tipLink.deleteMany({ where: { userId: user.id } });

    const standalone = await maybeSendTipLink({
      userId: user.id,
      conversationId: conversation.id,
      triggerMessageId: null,
      decision: "TIP",
      mode: "live",
      url: CONFIGURED,
      now: NOW,
      userTexts: ["Я хочу оставить тебе чаевые"],
      send: async (delivery) => {
        sent.push(delivery);
      },
    });
    assert.equal(standalone, "sent");
    assert.equal(sent[1]?.attachToMessageId ?? null, null);
    assert.equal(sent[1]?.text, "вот");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("tip_test uses the live sender once and the cooldown blocks a second send", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const telegramUserId = uniqueId();
  const ownerId = uniqueId();
  const user = await prisma.user.create({
    data: { telegramUserId, relationshipStage: "ENGAGED", interactionDynamic: "EQUAL", interactionDynamicConfidence: 0.2 },
  });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip-owner",
    },
  });
  const sent: TipDelivery[] = [];
  const owner: string[] = [];
  const update = commandUpdate(ownerId, `/tip_test ${telegramUserId}`);
  const deps = {
    url: CONFIGURED,
    sendOwner: async (_chatId: string, text: string) => {
      owner.push(text);
    },
    sendTip: async (delivery: TipDelivery) => {
      sent.push(delivery);
    },
  };
  try {
    await processTipAdminCommand(update, ownerId, deps);
    await processTipAdminCommand(update, ownerId, deps);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.chatId, telegramUserId);
    assert.equal(sent[0]?.text.includes(CONFIGURED), false);
    assert.equal(sent[0]?.buttonUrl, CONFIGURED);
    assert.equal(sent[0]?.buttonText, "Leave a tip 🤍");
    assert.equal(sent[0]?.businessConnectionId, "conn-tip-owner");
    assert.deepEqual(owner, ["Sent the donation link.", "A donation link was sent recently."]);
    assert.equal(owner.join(" ").includes("http"), false);
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id, status: "LINK_SENT" } }), 1);
    assert.equal(await prisma.payment.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.salesDecision.count({ where: { userId: user.id, decision: "PAID_OFFER" } }), 0);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(fresh.relationshipStage, "ENGAGED");
    assert.equal(fresh.interactionDynamic, "EQUAL");
    assert.equal(fresh.interactionDynamicConfidence, 0.2);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("shadow tip records the decision and does not send a link or create a payment", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId, relationshipStage: "NEW", interactionDynamic: "UNKNOWN" } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip",
    },
  });
  const sent: string[] = [];
  try {
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: null,
        userTexts: ["can I tip you?"],
        amyTexts: ["можно"],
      },
      {
        mode: "shadow",
        tipMode: "shadow",
        donationUrl: CONFIGURED,
        sendTip: async (delivery) => {
          sent.push(delivery.text);
        },
      },
    );
    const row = await prisma.salesDecision.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(row.decision, "TIP");
    assert.equal(row.intent, "TIP_DISCUSSION");
    assert.equal(row.reasonCode, "tip_request");
    assert.equal(sent.length, 0);
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.payment.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: user.id } }), 0);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(fresh.relationshipStage, "NEW");
    assert.equal(fresh.interactionDynamic, "UNKNOWN");
    assert.equal(fresh.totalStarsSpent, 0);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("the tip button follows the conversation language, not the Telegram language code", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const cases = [
    { stored: "en", text: "можно тебя поддержать?", label: "Оставить чаевые 🤍" },
    { stored: "ru", text: "can I tip you?", label: "Leave a tip 🤍" },
    { stored: "ru", text: "te puedo dejar una propina?", label: "Dejar una propina 🤍" },
  ] as const;
  for (const [index, item] of cases.entries()) {
    const telegramUserId = uniqueId();
    const user = await prisma.user.create({
      data: { telegramUserId, languageCode: item.stored, relationshipStage: "ENGAGED" },
    });
    const conversation = await prisma.conversation.create({
      data: {
        userId: user.id,
        platform: "telegram-business",
        platformConversationId: telegramUserId,
        businessConnectionId: `conn-lang-${index}`,
      },
    });
    const sent: TipDelivery[] = [];
    try {
      await observeSalesTurn(
        {
          userId: user.id,
          conversationId: conversation.id,
          triggerMessageId: null,
          userTexts: [item.text],
          amyTexts: ["🤍"],
        },
        {
          mode: "shadow",
          tipMode: "live",
          donationUrl: CONFIGURED,
          now: new Date(NOW.getTime() + index * 1000),
          sendTip: async (delivery) => {
            sent.push(delivery);
          },
        },
      );
      assert.equal(sent[0]?.buttonText, item.label);
      assert.equal(sent[0]?.buttonUrl, CONFIGURED);
    } finally {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
  }
});

test("a weak current turn uses the recent conversation, not the stored Telegram language", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { maybeSendTipLink } = await import("@/services/sales/tip");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({
    data: { telegramUserId, languageCode: "en", relationshipStage: "ENGAGED" },
  });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-lang-history",
    },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      userId: user.id,
      direction: "INBOUND",
      sender: "USER",
      type: "TEXT",
      text: "можно тебя поддержать?",
    },
  });
  const sent: TipDelivery[] = [];
  try {
    const result = await maybeSendTipLink({
      userId: user.id,
      conversationId: conversation.id,
      triggerMessageId: null,
      decision: "TIP",
      mode: "live",
      url: CONFIGURED,
      now: NOW,
      userTexts: ["ok"],
      send: async (delivery) => {
        sent.push(delivery);
      },
    });
    assert.equal(result, "sent");
    assert.equal(sent[0]?.buttonText, "Оставить чаевые 🤍");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("a live tip sends only the configured URL and does not mark a purchase", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId, relationshipStage: "ENGAGED", interactionDynamic: "EQUAL", interactionDynamicConfidence: 0.4 } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip-live",
    },
  });
  const sent: TipDelivery[] = [];
  try {
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: null,
        userTexts: ["можно тебя поддержать?"],
        amyTexts: ["можно 😏 https://fake.example/tip"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: CONFIGURED,
        now: NOW,
        sendTip: async (delivery) => {
          sent.push(delivery);
        },
      },
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text.includes(CONFIGURED), false);
    assert.equal(sent[0]?.text.includes("fake.example"), false);
    assert.equal(sent[0]?.buttonUrl, CONFIGURED);
    assert.equal(sent[0]?.buttonText, "Оставить чаевые 🤍");
    assert.equal(sent[0]?.businessConnectionId, "conn-tip-live");
    const link = await prisma.tipLink.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(link.status, "LINK_SENT");
    assert.equal(await prisma.payment.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: user.id } }), 0);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(fresh.relationshipStage, "ENGAGED");
    assert.equal(fresh.interactionDynamic, "EQUAL");
    assert.equal(fresh.interactionDynamicConfidence, 0.4);
    assert.equal(fresh.totalStarsSpent, 0);

    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: null,
        userTexts: ["can I tip you?"],
        amyTexts: ["можно"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: CONFIGURED,
        now: new Date(NOW.getTime() + 60 * 1000),
        sendTip: async (delivery) => {
          sent.push(delivery);
        },
      },
    );
    assert.equal(sent.length, 1);
    const second = await prisma.salesDecision.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(second.reasonCode, "tip_cooldown");
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id } }), 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("live tip with no configured URL sends nothing", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram-business", platformConversationId: telegramUserId, businessConnectionId: "conn-tip-missing" },
  });
  let sent = 0;
  try {
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: null,
        userTexts: ["can I send you money?"],
        amyTexts: ["можно"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: null,
        sendTip: async () => {
          sent += 1;
        },
      },
    );
    assert.equal(sent, 0);
    const row = await prisma.salesDecision.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(row.decision, "TIP");
    assert.equal(row.reasonCode, "tip_unconfigured");
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id } }), 0);
    assert.equal(row.reasonSummary?.includes("http"), false);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("a failed tip send does not record LINK_SENT", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { maybeSendTipLink } = await import("@/services/sales/tip");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId, relationshipStage: "NEW", interactionDynamic: "UNKNOWN" } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip-fail",
    },
  });
  try {
    await assert.rejects(() => maybeSendTipLink({
      userId: user.id,
      conversationId: conversation.id,
      triggerMessageId: null,
      decision: "TIP",
      mode: "live",
      url: CONFIGURED,
      userTexts: ["can I tip you?"],
      send: async () => {
        throw new Error("telegram down");
      },
    }));
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.payment.count({ where: { userId: user.id } }), 0);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(fresh.relationshipStage, "NEW");
    assert.equal(fresh.interactionDynamic, "UNKNOWN");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("the owner can clear only that user's tip cooldown", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const telegramUserId = uniqueId();
  const ownerId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip-reset",
    },
  });
  await prisma.tipLink.create({
    data: { userId: user.id, conversationId: conversation.id, status: "LINK_SENT" },
  });
  const owner: string[] = [];
  try {
    assert.equal(classifyTipAdminCommand(commandUpdate(ownerId, `/tip_reset ${telegramUserId}`), "99"), null);
    await processTipAdminCommand(commandUpdate(ownerId, `/tip_reset ${telegramUserId}`), ownerId, {
      sendOwner: async (_chatId, text) => {
        owner.push(text);
      },
    });
    assert.deepEqual(owner, ["Tip cooldown cleared."]);
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.payment.count({ where: { userId: user.id } }), 0);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("a live contextual follow-up sends the button once", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId, relationshipStage: "ENGAGED" } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip-context",
    },
  });
  const sent: TipDelivery[] = [];
  const history: TipContextMessage[] = [{
    createdAt: new Date(NOW.getTime() - 60 * 1000),
    sender: "USER",
    text: "можно оставить чаевые?",
  }];
  try {
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: null,
        userTexts: ["Кидай"],
        amyTexts: ["🤍"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: CONFIGURED,
        now: NOW,
        tipHistory: history,
        linkSentAt: null,
        sendTip: async (delivery) => {
          sent.push(delivery);
        },
      },
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.buttonText, "Оставить чаевые 🤍");
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id, status: "LINK_SENT" } }), 1);

    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: null,
        userTexts: ["Кидай"],
        amyTexts: ["🤍"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: CONFIGURED,
        now: new Date(NOW.getTime() + 60 * 1000),
        tipHistory: history,
        sendTip: async (delivery) => {
          sent.push(delivery);
        },
      },
    );
    assert.equal(sent.length, 1);
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id, status: "LINK_SENT" } }), 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("reply prompt warns against repeating recent emojis", () => {
  const messages = buildReplyMessages(
    {
      relationshipStage: "NEW",
      conversationSummary: null,
      firstName: "Alex",
      interactionDynamic: "UNKNOWN",
      interactionDynamicConfidence: 0,
    },
    [
      { direction: "OUTBOUND", sender: "AMY", text: "не выпрашиваю 😌" },
      { direction: "OUTBOUND", sender: "AMY", text: "если сам захочешь 😌" },
    ],
    ["кидай"],
  );
  const system = String(messages[0]?.content ?? "");
  assert.match(system, /Use emojis sparingly/);
  assert.match(system, /Many replies should have no emoji/);
  assert.match(system, /😌/);
  assert.match(system, /Do not repeat them in this reply/);
  assert.equal(system.includes("http"), false);
});

test("the production tip sequence stays contextual and does not buy a photo", () => {
  const start = new Date("2026-09-27T18:00:00.000Z");
  const at = (minute: number) => new Date(start.getTime() + minute * 60 * 1000);
  const history: TipContextMessage[] = [];
  const opened = step(["Не просишь чаевых"], at(0), history);
  assert.equal(opened.state.active, true);
  assert.equal(opened.decision.signal.intent, "TIP_DISCUSSION");
  history.push({ createdAt: at(0), sender: "USER", text: "Не просишь чаевых" });
  history.push({ createdAt: at(1), sender: "AMY", text: "не выпрашиваю 😌 если сам захочешь оставить чаевые — я не буду спорить" });

  const wantPhoto = step(["Хочу", "Если будешь жесткий и пришлешь фото"], at(2), history);
  assert.equal(wantPhoto.state.conditionedOnContent, true);
  assert.equal(wantPhoto.state.execute, false);
  assert.notEqual(wantPhoto.decision.decision, "TIP");
  assert.notEqual(wantPhoto.decision.decision, "PAID_OFFER");
  history.push({ createdAt: at(2), sender: "USER", text: "Хочу" });
  history.push({ createdAt: at(2), sender: "USER", text: "Если будешь жесткий и пришлешь фото" });

  const where = step(["Куда отправить"], at(3), history);
  assert.equal(where.state.execute, true);
  assert.equal(where.decision.decision, "TIP");
  assert.equal(where.decision.reasonCode, "tip_request");
  history.push({ createdAt: at(3), sender: "USER", text: "Куда отправить" });

  const send = step(["Кидай"], at(4), history);
  assert.equal(send.state.active, true);
  assert.equal(send.state.execute, true);
  assert.equal(send.decision.decision, "TIP");
  assert.equal(send.decision.candidateOfferId, null);
});

test("short confirmations tip only inside an active tip conversation", () => {
  const now = new Date("2026-09-27T18:10:00.000Z");
  const earlier = new Date(now.getTime() - 2 * 60 * 1000);
  const walk = evaluateTipContext({
    now,
    currentUserLines: ["давай"],
    history: [{ createdAt: earlier, sender: "USER", text: "пойдем гулять?" }],
  });
  assert.equal(walk.active, false);
  assert.equal(walk.execute, false);
  assert.equal(contextualTipReading({
    now,
    currentUserLines: ["давай"],
    history: [{ createdAt: earlier, sender: "USER", text: "пойдем гулять?" }],
  })?.intent, "NONE");

  const tipHistory: TipContextMessage[] = [{ createdAt: earlier, sender: "USER", text: "можно оставить чаевые?" }];
  const confirm = step(["давай"], now, tipHistory);
  assert.equal(confirm.decision.decision, "TIP");

  const drop = step(["скинь"], now, [{ createdAt: earlier, sender: "USER", text: "как тебя поддержать?" }]);
  assert.equal(drop.decision.decision, "TIP");

  const where = step(["куда отправить?"], now, tipHistory);
  assert.equal(where.decision.decision, "TIP");

  const spanish = step(["mándalo"], now, [{ createdAt: earlier, sender: "USER", text: "te puedo dejar una propina?" }]);
  assert.equal(spanish.decision.decision, "TIP");

  const alone = step(["давай"], now, []);
  assert.notEqual(alone.decision.decision, "TIP");
});

test("natural how and where questions continue an active tip conversation only", () => {
  const now = new Date("2026-09-27T18:30:00.000Z");
  const earlier = new Date(now.getTime() - 2 * 60 * 1000);
  const tipHistory: TipContextMessage[] = [{ createdAt: earlier, sender: "USER", text: "Я хочу оставить тебе чаевые" }];
  const inside = [
    "как это сделать?",
    "а как это сделать?",
    "как отправить?",
    "куда тогда?",
    "куда скинуть?",
    "how do I do it?",
    "how can I do that?",
    "where do I send it?",
    "¿cómo lo hago?",
    "¿dónde lo envío?",
    "pásamelo",
  ];
  for (const line of inside) {
    const turn = step([line], now, tipHistory);
    assert.equal(turn.state.active, true, line);
    assert.equal(turn.state.execute, true, line);
    assert.equal(turn.decision.decision, "TIP", line);
    assert.equal(turn.decision.reasonCode, "tip_request", line);
    assert.equal(turn.decision.signal.confidence, 0.93, line);
  }

  for (const line of ["как это сделать?", "куда тогда?", "давай"]) {
    const turn = step([line], now, []);
    assert.equal(turn.state.active, false, line);
    assert.notEqual(turn.decision.decision, "TIP", line);
  }

  const weather = step(["как там погода?"], now, tipHistory);
  assert.equal(weather.state.active, false);
  assert.notEqual(weather.decision.decision, "TIP");

  const cancel = step(["не, передумал"], now, tipHistory);
  assert.equal(cancel.state.declined, true);
  assert.equal(cancel.state.active, false);
  assert.notEqual(cancel.decision.decision, "TIP");
});

test("a contextual how-question during cooldown is recognized and not sent again", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId, relationshipStage: "ENGAGED" } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip-how",
    },
  });
  const sent: TipDelivery[] = [];
  try {
    await prisma.tipLink.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        status: "LINK_SENT",
        createdAt: new Date(NOW.getTime() - 2 * 60 * 1000),
      },
    });
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: null,
        userTexts: ["как это сделать?"],
        amyTexts: ["мне приятно"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: CONFIGURED,
        now: NOW,
        tipHistory: [{
          createdAt: new Date(NOW.getTime() - 60 * 1000),
          sender: "USER",
          text: "Я хочу оставить тебе чаевые",
        }],
        sendTip: async (delivery) => {
          sent.push(delivery);
        },
      },
    );
    const row = await prisma.salesDecision.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    assert.equal(row.decision, "TIP");
    assert.equal(row.intent, "TIP_DISCUSSION");
    assert.equal(row.confidence, 0.93);
    assert.equal(row.reasonCode, "tip_cooldown");
    assert.equal(sent.length, 0);
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id, status: "LINK_SENT" } }), 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("tip context ends on cancel, distress, expiry, and a sent button", () => {
  const now = new Date("2026-09-27T18:20:00.000Z");
  const recent = new Date(now.getTime() - 60 * 1000);
  const old = new Date(now.getTime() - 11 * 60 * 1000);
  const cancelled = step(["не, забей"], now, [{ createdAt: recent, sender: "USER", text: "можно чаевые?" }]);
  assert.equal(cancelled.state.declined, true);
  assert.equal(cancelled.state.execute, false);
  assert.notEqual(cancelled.decision.decision, "TIP");

  const distress = step(["кидай", "i want to die"], now, [{ createdAt: recent, sender: "USER", text: "можно чаевые?" }]);
  assert.equal(distress.decision.decision, "NO_OFFER");
  assert.equal(distress.decision.reasonCode, "distress");

  const expired = evaluateTipContext({
    now,
    currentUserLines: ["кидай"],
    history: [{ createdAt: old, sender: "USER", text: "можно оставить чаевые?" }],
  });
  assert.equal(expired.execute, false);

  const sent = evaluateTipContext({
    now,
    currentUserLines: ["кидай"],
    history: [{ createdAt: recent, sender: "USER", text: "можно оставить чаевые?" }],
    linkSentAt: new Date(recent.getTime() + 1000),
  });
  assert.equal(sent.active, false);
  assert.equal(sent.execute, false);

  const paid = readSalesSignal(["I'll tip if you send me a private photo"]);
  assert.notEqual(paid.intent, "TIP_DISCUSSION");
  const blocked = contextualTipReading({
    now,
    currentUserLines: ["I'll tip if you send me a private photo"],
    history: [],
  });
  assert.notEqual(blocked?.intent, "TIP_DISCUSSION");
});

function step(lines: string[], now: Date, history: TipContextMessage[]) {
  const state = evaluateTipContext({ now, currentUserLines: lines, history });
  const signal = contextualTipReading({ now, currentUserLines: lines, history }) ?? readSalesSignal(lines);
  return { state, decision: decideReading(signal) };
}

function decideReading(reading: ReturnType<typeof readSalesSignal>) {
  return decideSales({
    signal: reading,
    declinedNow: reading.declinedNow,
    assets: [],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: null,
    dynamic: "UNKNOWN",
    dynamicConfidence: 0,
    now: NOW,
  });
}

function decideText(text: string) {
  const reading = readSalesSignal([text]);
  return decideSales({
    signal: reading,
    declinedNow: reading.declinedNow,
    assets: [{
      id: "media-home",
      category: "selfie",
      tags: ["casual_selfie"],
      mood: "relaxed",
      flirtLevel: 1,
      contexts: ["casual_selfie", "at_home"],
      active: true,
    }],
    offers: [{
      id: "offer-shower",
      slug: "shower-time",
      tags: ["private", "shower"],
      contexts: ["flirty", "shower", "private_photos"],
      flirtLevel: 2,
      active: true,
      hasActivePrice: true, priority: 1,
    }],
    purchasedOfferIds: new Set<string>(),
    interactions: [],
    priorFreeMediaAt: null,
    dynamic: "UNKNOWN",
    dynamicConfidence: 0,
    now: NOW,
  });
}

function commandUpdate(id: string, text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: Number(id), type: "private" },
      from: { id: Number(id), is_bot: false },
      text,
    },
  };
}

function uniqueId(): string {
  return String(7_100_000_000 + Math.floor(Math.random() * 1_000_000_000));
}

test("deterministic 1: strong affectionate/compliment context can allow AMY_INITIATED_TIP", () => {
  const highIntentPhrases = [
    "you're so amazing 💕",
    "I want to make you happy",
    "I want to spoil you",
    "what can I do for you?",
    "how can I spoil you?",
    "wie kann ich dich verwöhnen",
    "ich möchte dich verwöhnen",
    "ich will dich verwöhnen",
    "как тебя порадовать",
    "хочу тебя порадовать",
    "хочу тебя побаловать",
    "как тебя побаловать",
    "cómo puedo consentirte",
    "quiero consentirte",
    "quiero hacerte feliz",
  ];

  for (const phrase of highIntentPhrases) {
    const reading = readSalesSignal([phrase]);
    assert.equal(reading.tipCandidate, true, `tipCandidate should be true for '${phrase}'`);
    const decision = decideSales({
      signal: reading,
      declinedNow: false,
      noMoney: reading.noMoney,
      tipCandidate: reading.tipCandidate,
      assets: [],
      offers: [],
      purchasedOfferIds: new Set(),
      interactions: [],
      priorFreeMediaAt: null,
      now: NOW,
    });
    assert.equal(decision.decision, "TIP", `decision should be TIP for '${phrase}'`);
    assert.equal(decision.reasonCode, "amy_initiated_tip", `reasonCode should be amy_initiated_tip for '${phrase}'`);
    assert.equal(commercialReplyContext(decision.decision, decision.reasonCode, "live"), TIP_REPLY_HINT);
  }
});

test("deterministic 2: neutral 'hello' -> no tip", () => {
  const ordinaryPhrases = [
    "hello",
    "you're sweet",
    "you're cute",
    "you're beautiful",
    "you're gorgeous",
    "you're so sexy",
    "I love you",
    "du bist schön",
    "du bist süß",
    "du bist so sexy",
    "ich liebe dich",
    "ты красивая",
    "ты милая",
    "ты сексуальная",
    "я тебя люблю",
    "eres linda",
  ];

  for (const phrase of ordinaryPhrases) {
    const reading = readSalesSignal([phrase]);
    assert.equal(reading.tipCandidate, false, `tipCandidate should be false for '${phrase}'`);
    const decision = decideSales({
      signal: reading,
      declinedNow: false,
      noMoney: reading.noMoney,
      tipCandidate: reading.tipCandidate,
      assets: [],
      offers: [],
      purchasedOfferIds: new Set(),
      interactions: [],
      priorFreeMediaAt: null,
      now: NOW,
    });
    assert.notEqual(decision.decision, "TIP", `decision should not be TIP for '${phrase}'`);
    assert.equal(decision.decision, "NO_OFFER", `decision should be NO_OFFER for '${phrase}'`);
    assert.equal(decision.reasonCode, "no_commercial_signal", `reasonCode should be no_commercial_signal for '${phrase}'`);
    assert.equal(commercialReplyContext(decision.decision, decision.reasonCode, "live"), null);
  }
});

test("deterministic 3: distress -> no tip", () => {
  const reading = readSalesSignal(["i want to die. you're so sweet and amazing 💕"]);
  assert.equal(reading.emotionalState, "DISTRESSED");
  assert.equal(reading.tipCandidate, false);
  const decision = decideSales({
    signal: reading,
    declinedNow: false,
    noMoney: reading.noMoney,
    tipCandidate: reading.tipCandidate,
    assets: [],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: null,
    now: NOW,
  });
  assert.notEqual(decision.decision, "TIP");
  assert.equal(decision.decision, "NO_OFFER");
  assert.equal(decision.reasonCode, "distress");
});

test("deterministic 4: user says no money -> no tip", () => {
  const reading = readSalesSignal(["you're so sweet and amazing, but i have no money"]);
  assert.equal(reading.noMoney, true);
  assert.equal(reading.tipCandidate, false);
  const decision = decideSales({
    signal: reading,
    declinedNow: false,
    noMoney: reading.noMoney,
    tipCandidate: reading.tipCandidate,
    assets: [],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: null,
    now: NOW,
  });
  assert.notEqual(decision.decision, "TIP");
  assert.equal(decision.reasonCode, "no_money");
});

test("deterministic 5: user declines payment -> no immediate tip", () => {
  const reading = readSalesSignal(["not buying, you're amazing though"]);
  assert.equal(reading.declinedNow, true);
  assert.equal(reading.tipCandidate, false);
  const decision = decideSales({
    signal: reading,
    declinedNow: true,
    noMoney: reading.noMoney,
    tipCandidate: reading.tipCandidate,
    assets: [],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: null,
    now: NOW,
  });
  assert.notEqual(decision.decision, "TIP");
  assert.equal(decision.reasonCode, "user_declined");
});

test("deterministic 6 & 7: Amy already initiated tip <24h blocks new Amy tip, but explicit user tip still works", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip-amy-init",
    },
  });
  const sent: TipDelivery[] = [];
  try {
    const pastTime = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const pastMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        userId: user.id,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "you're so sweet",
        telegramMessageId: `msg-${uniqueId()}`,
        createdAt: pastTime,
      },
    });
    await prisma.salesDecision.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: pastMsg.id,
        mode: "SHADOW",
        decision: "TIP",
        confidence: 0.9,
        intent: "FLIRT",
        flirtLevel: 2,
        commercialReadiness: "LOW",
        emotionalState: "NORMAL",
        desiredContexts: ["flirty", "affectionate"],
        reasonCode: "amy_initiated_tip",
        reasonSummary: "natural amy-initiated tip opportunity",
        createdAt: pastTime,
      },
    });
    await prisma.tipLink.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: pastMsg.id,
        status: "LINK_SENT",
        createdAt: pastTime,
      },
    });

    const complimentMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        userId: user.id,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "you're so amazing 💕",
        telegramMessageId: `msg-${uniqueId()}`,
        createdAt: NOW,
      },
    });
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: complimentMsg.id,
        userTexts: ["you're so amazing 💕"],
        amyTexts: ["thank you sweetie"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: CONFIGURED,
        now: NOW,
        sendTip: async (d) => { sent.push(d); },
      },
    );
    assert.equal(sent.length, 0);
    const blockedDecision = await prisma.salesDecision.findFirstOrThrow({
      where: { userId: user.id, triggerMessageId: complimentMsg.id },
    });
    assert.equal(blockedDecision.reasonCode, "amy_tip_cooldown");

    const explicitMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        userId: user.id,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "how can I tip you?",
        telegramMessageId: `msg-${uniqueId()}`,
        createdAt: new Date(NOW.getTime() + 1000),
      },
    });
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: explicitMsg.id,
        userTexts: ["how can I tip you?"],
        amyTexts: ["вот"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: CONFIGURED,
        now: new Date(NOW.getTime() + 1000),
        sendTip: async (d) => { sent.push(d); },
      },
    );
    assert.equal(sent.length, 1);
    const explicitDecision = await prisma.salesDecision.findFirstOrThrow({
      where: { userId: user.id, triggerMessageId: explicitMsg.id },
    });
    assert.equal(explicitDecision.decision, "TIP");
    assert.equal(explicitDecision.reasonCode, "tip_request");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("deterministic 8: tip button uses existing backend URL path and URL is never exposed to LLM", async () => {
  assert.equal(TIP_REPLY_HINT.includes("http"), false);
  assert.equal(TIP_REPLY_HINT.includes(CONFIGURED), false);

  const mockUser = {
    id: "usr-llm-test",
    telegramUserId: "12345",
    firstName: "Test",
    lastName: null,
    username: null,
    relationshipStage: "ENGAGED" as const,
    interactionDynamic: "UNKNOWN" as const,
    interactionDynamicConfidence: 0,
    conversationSummary: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastAmyMessageAt: null,
    aiEnabled: true,
    timezone: null,
    countryCode: null,
    preferredLanguage: "en",
    lastInteractionAt: NOW,
    followUpPhase: "NONE" as const,
    lastFollowUpSentAt: null,
    followUpDueAt: null,
    followUpAnchorDate: null,
    followUpAnchorType: null,
    followUpCount: 0,
    followUpRetryCount: 0,
    followUpBackoffUntil: null,
  };
  const messages = buildReplyMessages(
    mockUser,
    [],
    ["you're so sweet 💕"],
    [],
    "",
    "",
    TIP_REPLY_HINT,
  );
  const serialized = JSON.stringify(messages);
  assert.equal(serialized.includes(CONFIGURED), false);
  assert.equal(serialized.includes("http://"), false);
  assert.equal(serialized.includes("https://"), false);

  const presentation = tipPresentation({ url: CONFIGURED, language: "en" });
  assert.equal(presentation.buttonUrl, CONFIGURED);
});

test("deterministic 9: no duplicate TipLink / button execution on replay", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: "conn-tip-replay",
    },
  });
  const sent: TipDelivery[] = [];
  try {
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        userId: user.id,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "can I tip you?",
        telegramMessageId: `replay-${uniqueId()}`,
      },
    });
    // 1st run
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: message.id,
        userTexts: ["can I tip you?"],
        amyTexts: ["вот"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: CONFIGURED,
        now: NOW,
        sendTip: async (d) => { sent.push(d); },
      },
    );
    assert.equal(sent.length, 1);
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id, triggerMessageId: message.id } }), 1);

    // 2nd run with exact same triggerMessageId (replay)
    await observeSalesTurn(
      {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: message.id,
        userTexts: ["can I tip you?"],
        amyTexts: ["вот"],
      },
      {
        mode: "shadow",
        tipMode: "live",
        donationUrl: CONFIGURED,
        now: NOW,
        sendTip: async (d) => { sent.push(d); },
      },
    );
    assert.equal(sent.length, 1);
    assert.equal(await prisma.tipLink.count({ where: { userId: user.id, triggerMessageId: message.id } }), 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});
