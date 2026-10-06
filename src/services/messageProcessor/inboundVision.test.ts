import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { TurnDeps } from "./runTurn";

loadEnv("/Users/mariia/Amy-telegram/.env");

const VISUAL = "subject: electrical cabinet; setting: indoor wall; activity: installed equipment; caption fit: yes";

test("a business photo with a caption reaches Amy with visual context", async () => {
  const { interpretUpdate } = await import("../../lib/telegram/parseUpdate");
  const interpreted = interpretUpdate(businessPhoto(7, "Habe den heute bei einem Kunden installiert"));
  assert.equal(interpreted.action, "inbound");
  if (interpreted.action !== "inbound") return;
  assert.equal(interpreted.inbound.kind, "photo");
  assert.equal(interpreted.inbound.photoFileId, "file-large");
  assert.equal(interpreted.inbound.text, "Habe den heute bei einem Kunden installiert");

  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-caption");
  const seen: { current?: string[]; visual?: string | null } = {};
  try {
    await seedPhoto(prisma, user, "Habe den heute bei einem Kunden installiert", "file-large", 1);
    await processTextBurst(user.userId, deps(async (input) => {
      seen.current = input.currentMessages;
      seen.visual = input.visualContext;
      return ["Das sieht nach einer sauberen Installation aus."];
    }));
    assert.deepEqual(seen.current, ["Habe den heute bei einem Kunden installiert"]);
    assert.match(seen.visual ?? "", /electrical cabinet/);
    assert.doesNotMatch(seen.visual ?? "", /i can only text/i);
    const outbound = await prisma.message.findFirst({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.equal(outbound?.text, "Das sieht nach einer sauberen Installation aus.");
    assert.notEqual(outbound?.text, "i can only text right now");
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a business photo without a caption is still a conversational turn", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-photo-only");
  let visual: string | null = null;
  try {
    await seedPhoto(prisma, user, null, "file-only", 1);
    await processTextBurst(user.userId, deps(async (input) => {
      visual = input.visualContext ?? null;
      assert.deepEqual(input.currentMessages, ["(sent a photo)"]);
      return ["oh that looks tidy"];
    }));
    assert.match(visual ?? "", /electrical cabinet/);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a photo and a following text in one burst are one turn", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-photo-then-text");
  let calls = 0;
  try {
    await seedPhoto(prisma, user, null, "file-burst", 1);
    await seedText(prisma, user, "installed this today", 2);
    await processTextBurst(user.userId, deps(async (input) => {
      calls += 1;
      assert.deepEqual(input.currentMessages, ["installed this today"]);
      assert.match(input.visualContext ?? "", /electrical cabinet/);
      return ["you installed that today?"];
    }));
    assert.equal(calls, 1);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("text and a following photo in one burst are one turn", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-text-then-photo");
  let calls = 0;
  try {
    await seedText(prisma, user, "look what I did", 1);
    await seedPhoto(prisma, user, null, "file-after", 2);
    await processTextBurst(user.userId, deps(async (input) => {
      calls += 1;
      assert.deepEqual(input.currentMessages, ["look what I did"]);
      assert.match(input.visualContext ?? "", /electrical cabinet/);
      return ["okay show me"];
    }));
    assert.equal(calls, 1);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a work photo does not become a free-media request", async () => {
  const { readSalesSignal } = await import("../sales/signals");
  const caption = "Habe den heute bei einem Kunden installiert";
  const signal = readSalesSignal([caption]);
  assert.notEqual(signal.intent, "MEDIA_REQUEST");
  assert.notEqual(signal.intent, "PREMIUM_MEDIA_REQUEST");

  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-work");
  let userTexts: string[] = ["missing"];
  try {
    await seedPhoto(prisma, user, caption, "file-work", 1);
    await processTextBurst(user.userId, {
      ...deps(async () => ["stark"]),
      observeSales: async (input) => {
        userTexts = input.userTexts;
      },
    });
    assert.deepEqual(userTexts, [caption]);
    assert.equal(userTexts.some((line) => line.includes("electrical cabinet")), false);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a selfie does not automatically become a paid offer", async () => {
  const { readSalesSignal } = await import("../sales/signals");
  assert.equal(readSalesSignal([]).intent, "NONE");
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-selfie");
  let userTexts: string[] = ["missing"];
  try {
    await seedPhoto(prisma, user, null, "file-selfie", 1);
    await processTextBurst(user.userId, {
      ...deps(async () => ["hey"], "subject: a person facing the camera; caption fit: no_caption"),
      observeSales: async (input) => {
        userTexts = input.userTexts;
      },
    });
    assert.deepEqual(userTexts, []);
    assert.notEqual(readSalesSignal(userTexts).intent, "PREMIUM_MEDIA_REQUEST");
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("vision failure still answers the caption without invented details", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-fail");
  try {
    await seedPhoto(prisma, user, "installed this today", "file-fail", 1);
    await processTextBurst(user.userId, {
      ...deps(async (input) => {
        assert.match(input.visualContext ?? "", /do not invent/i);
        assert.equal((input.visualContext ?? "").includes("electrical"), false);
        return ["that sounds like a full day"];
      }),
      understandCustomerPhotos: async () => {
        throw new Error("vision down");
      },
    });
    const outbound = await prisma.message.findFirst({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.equal(outbound?.text, "that sounds like a full day");
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a photo-only vision failure does not invent what was visible", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-fail-empty");
  try {
    await seedPhoto(prisma, user, null, "file-empty", 1);
    await processTextBurst(user.userId, {
      ...deps(async (input) => {
        assert.match(input.visualContext ?? "", /do not invent/i);
        assert.match(input.visualContext ?? "", /no caption/i);
        assert.equal((input.visualContext ?? "").includes("i can only text"), false);
        return ["what did you want to show me?"];
      }),
      understandCustomerPhotos: async () => null,
    });
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a customer photo does not create a media asset", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-not-catalog");
  const fileId = "customer-file-not-catalog";
  try {
    const before = await prisma.mediaAsset.count({ where: { telegramFileId: fileId } });
    await seedPhoto(prisma, user, "installed this", fileId, 1);
    await processTextBurst(user.userId, deps(async () => ["nice"]));
    const after = await prisma.mediaAsset.count({ where: { telegramFileId: fileId } });
    assert.equal(before, 0);
    assert.equal(after, 0);
    const vision = fs.readFileSync(new URL("../conversation/customerVision.ts", import.meta.url), "utf8");
    assert.equal(vision.includes("mediaAsset"), false);
    const library = fs.readFileSync(new URL("../media/library.ts", import.meta.url), "utf8");
    assert.match(library, /mediaAsset\.create/);
    assert.match(library, /export async function processOwnerBotAdminUpdate/);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("German caption context can produce a German reply", async () => {
  const { buildReplyMessages } = await import("../amyBrain");
  const messages = buildReplyMessages(
    {
      firstName: "Jan",
      relationshipStage: "ENGAGED",
      conversationSummary: "Er hat gesagt, dass er Elektriker ist.",
    },
    [],
    ["Habe den heute bei einem Kunden installiert"],
    [],
    "",
    `He sent a photo. Factual visible context, not his words: ${VISUAL}. Reply as someone who saw the picture.`,
  );
  const prompt = JSON.stringify(messages);
  assert.match(prompt, /Habe den heute bei einem Kunden installiert/);
  assert.match(prompt, /electrical cabinet/);
  assert.doesNotMatch(prompt, /i can only text right now/);
  const reply = "Das sieht nach einer sauberen Installation aus.";
  assert.match(reply, /[äöüÄÖÜß]|Das sieht/);
});

test("customer photo facts stay compact and do not invent identity", async () => {
  const { describeCustomerPhoto, formatCustomerPhotoContext } = await import("../conversation/customerVision");
  const facts = await describeCustomerPhoto({
    bytes: Buffer.from("not-a-real-image"),
    mimeType: "image/jpeg",
    caption: "Habe den heute bei einem Kunden installiert",
    complete: async (messages) => {
      const text = JSON.stringify(messages);
      assert.match(text, /Do not infer identity/);
      assert.match(text, /Habe den heute/);
      return JSON.stringify({
        subject: "electrical cabinet on a wall",
        setting: "indoor installation",
        activity: "equipment mounted in place",
        details: ["cables", "metal enclosure"],
        visibleText: "",
        captionFit: "yes",
      });
    },
  });
  assert.ok(facts);
  const line = formatCustomerPhotoContext(facts!);
  assert.match(line, /subject: electrical cabinet/);
  assert.ok(line.length < 500);
});

test("a business video is not answered with the text-only fallback", async () => {
  const { interpretUpdate } = await import("../../lib/telegram/parseUpdate");
  const interpreted = interpretUpdate(businessMedia({
    video: { file_id: "video-file", thumbnail: { file_id: "still-file", file_unique_id: "still", width: 320, height: 320 } },
  }));
  assert.equal(interpreted.action, "inbound");
  if (interpreted.action !== "inbound") return;
  assert.equal(interpreted.inbound.kind, "video");
  assert.equal(interpreted.inbound.type, "VIDEO");
  assert.equal(interpreted.inbound.visualForm, "video");
  assert.equal(interpreted.inbound.photoFileId, "still-file");
  assert.equal(Boolean(interpreted.inbound.businessConnectionId), true);

  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-video");
  let understood = 0;
  try {
    await seedVisual(prisma, user, { kind: "video", visualForm: "video", fileId: "still-file", type: "VIDEO" });
    await processTextBurst(user.userId, deps(async (input) => {
      assert.match(input.visualContext ?? "", /sent a video/i);
      assert.match(input.visualContext ?? "", /electrical cabinet/);
      assert.doesNotMatch(input.visualContext ?? "", /i can only text/i);
      return ["kurz und knapp"];
    }, VISUAL));
    const outbound = await prisma.message.findFirst({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.equal(outbound?.text, "kurz und knapp");
    assert.notEqual(outbound?.text, "i can only text right now");
    understood += 1;
    assert.equal(understood, 1);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a video without a still still reaches Amy in the conversation language", async () => {
  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-video-empty");
  let calls = 0;
  try {
    await seedVisual(prisma, user, { kind: "video", visualForm: "video", fileId: null, type: "VIDEO" });
    await processTextBurst(user.userId, {
      ...deps(async (input) => {
        calls += 1;
        assert.match(input.visualContext ?? "", /sent a video/i);
        assert.match(input.visualContext ?? "", /do not invent/i);
        return ["was wolltest du mir zeigen?"];
      }),
      understandCustomerPhotos: async () => {
        throw new Error("should not download");
      },
    });
    assert.equal(calls, 1);
    const outbound = await prisma.message.findFirst({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.notEqual(outbound?.text, "i can only text right now");
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("an image sent as a document is a photo turn", async () => {
  const { interpretUpdate } = await import("../../lib/telegram/parseUpdate");
  const interpreted = interpretUpdate(businessMedia({
    document: { file_id: "doc-image", file_unique_id: "doc", mime_type: "image/jpeg", file_name: "job.jpg" },
    caption: "vom Kunden",
  }));
  assert.equal(interpreted.action, "inbound");
  if (interpreted.action !== "inbound") return;
  assert.equal(interpreted.inbound.kind, "photo");
  assert.equal(interpreted.inbound.type, "IMAGE");
  assert.equal(interpreted.inbound.visualForm, "image_file");
  assert.equal(interpreted.inbound.text, "vom Kunden");

  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-document");
  try {
    await seedVisual(prisma, user, {
      kind: "photo",
      visualForm: "image_file",
      fileId: "doc-image",
      type: "IMAGE",
      text: "vom Kunden",
    });
    await processTextBurst(user.userId, deps(async (input) => {
      assert.deepEqual(input.currentMessages, ["vom Kunden"]);
      assert.match(input.visualContext ?? "", /image file/i);
      return ["sauber"];
    }));
    const outbound = await prisma.message.findFirst({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.notEqual(outbound?.text, "i can only text right now");
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a reply that contains a photo and an album stay one visual turn", async () => {
  const { interpretUpdate } = await import("../../lib/telegram/parseUpdate");
  const reply = interpretUpdate(businessMedia({
    caption: "hier",
    reply_to_message: { message_id: 9 },
    photo: [{ file_id: "reply-photo", file_unique_id: "r", width: 100, height: 100, file_size: 20 }],
  }));
  assert.equal(reply.action, "inbound");
  if (reply.action !== "inbound") return;
  assert.equal(reply.inbound.kind, "photo");
  assert.equal(reply.inbound.replyToMessageId, "9");

  const { prisma } = await import("../../lib/db/prisma");
  const { processTextBurst } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-album");
  let calls = 0;
  try {
    await seedPhoto(prisma, user, null, "album-a", 1);
    await seedPhoto(prisma, user, null, "album-b", 2);
    await processTextBurst(user.userId, deps(async () => {
      calls += 1;
      return ["beide gesehen"];
    }));
    assert.equal(calls, 1);
  } finally {
    await cleanup(prisma, user.userId);
  }
});

test("a sticker can still use the text-only fallback", async () => {
  const { interpretUpdate } = await import("../../lib/telegram/parseUpdate");
  const animation = interpretUpdate(businessMedia({
    animation: { thumbnail: { file_id: "gif-still", file_unique_id: "g", width: 10, height: 10 } },
  }));
  assert.equal(animation.action, "inbound");
  if (animation.action === "inbound") assert.equal(animation.inbound.visualForm, "animation");
  const pdf = interpretUpdate(businessMedia({
    document: { file_id: "pdf-file", file_unique_id: "p", mime_type: "application/pdf", file_name: "notes.pdf" },
  }));
  assert.equal(pdf.action, "inbound");
  if (pdf.action === "inbound") assert.equal(pdf.inbound.kind, "unsupported");
  const sticker = interpretUpdate(businessMedia({ sticker: { file_id: "sticker", file_unique_id: "s" } }));
  assert.equal(sticker.action, "inbound");
  if (sticker.action !== "inbound") return;
  assert.equal(sticker.inbound.kind, "unsupported");

  const { prisma } = await import("../../lib/db/prisma");
  const { processImmediateMessage } = await import("./runTurn");
  const user = await seedUser(prisma, "vision-sticker");
  try {
    const message = await prisma.message.create({
      data: {
        conversationId: user.conversationId,
        userId: user.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "SYSTEM",
        telegramMessageId: `${user.userId}-sticker`,
        metadata: { kind: "unsupported", processed: false },
      },
    });
    await processImmediateMessage(user.userId, message.id, deps(async () => ["should not generate"]));
    const outbound = await prisma.message.findFirst({ where: { userId: user.userId, direction: "OUTBOUND" } });
    assert.equal(outbound?.text, "i can only text right now");
  } finally {
    await cleanup(prisma, user.userId);
  }
});

function businessMedia(message: Record<string, unknown>) {
  return {
    update_id: 90,
    business_message: {
      message_id: 90,
      date: 1,
      business_connection_id: "biz-1",
      from: { id: 42, is_bot: false, first_name: "Jan" },
      chat: { id: 42, type: "private" as const },
      ...message,
    },
  };
}

async function seedVisual(
  prisma: typeof import("../../lib/db/prisma").prisma,
  ids: { userId: string; conversationId: string },
  input: { kind: string; visualForm: string; fileId: string | null; type: "IMAGE" | "VIDEO"; text?: string | null },
) {
  await prisma.message.create({
    data: {
      conversationId: ids.conversationId,
      userId: ids.userId,
      direction: "INBOUND",
      sender: "USER",
      type: input.type,
      text: input.text ?? null,
      telegramMessageId: `${ids.userId}-visual`,
      metadata: {
        kind: input.kind,
        visualForm: input.visualForm,
        processed: false,
        ...(input.fileId ? { photoFileId: input.fileId } : {}),
      },
    },
  });
}

function businessPhoto(id: number, caption: string) {
  return {
    update_id: id,
    business_message: {
      message_id: id,
      date: 1,
      business_connection_id: "biz-1",
      from: { id: 42, is_bot: false, first_name: "Jan" },
      chat: { id: 42, type: "private" as const },
      caption,
      photo: [
        { file_id: "file-small", file_unique_id: "s", width: 90, height: 90, file_size: 10 },
        { file_id: "file-large", file_unique_id: "l", width: 800, height: 800, file_size: 90 },
      ],
    },
  };
}

function deps(generate: TurnDeps["generate"], visual = VISUAL): TurnDeps {
  return {
    generate,
    send: async () => ({ messageId: "sent-vision" }),
    sleep: async () => undefined,
    delayMs: () => 700,
    understandCustomerPhotos: async () => visual,
  };
}

async function seedUser(prisma: typeof import("../../lib/db/prisma").prisma, telegramUserId: string) {
  const user = await prisma.user.create({ data: { telegramUserId, firstName: "Jan" } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram-business", platformConversationId: telegramUserId, businessConnectionId: "biz-1" },
  });
  return { userId: user.id, conversationId: conversation.id };
}

async function seedPhoto(
  prisma: typeof import("../../lib/db/prisma").prisma,
  ids: { userId: string; conversationId: string },
  caption: string | null,
  fileId: string,
  order: number,
) {
  await prisma.message.create({
    data: {
      conversationId: ids.conversationId,
      userId: ids.userId,
      direction: "INBOUND",
      sender: "USER",
      type: "IMAGE",
      text: caption,
      telegramMessageId: `${ids.userId}-p-${order}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)),
      metadata: { kind: "photo", processed: false, photoFileId: fileId },
    },
  });
}

async function seedText(
  prisma: typeof import("../../lib/db/prisma").prisma,
  ids: { userId: string; conversationId: string },
  text: string,
  order: number,
) {
  await prisma.message.create({
    data: {
      conversationId: ids.conversationId,
      userId: ids.userId,
      direction: "INBOUND",
      sender: "USER",
      type: "TEXT",
      text,
      telegramMessageId: `${ids.userId}-t-${order}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)),
      metadata: { kind: "text", processed: false },
    },
  });
}

async function cleanup(prisma: typeof import("../../lib/db/prisma").prisma, userId: string) {
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

function loadEnv(path: string): void {
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
