import { prisma } from "@/lib/db/prisma";
import { sendTextMessage } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { mediaSentLabel } from "@/services/media/delivery";
import { readFreePhoto } from "@/services/media/library";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function activeOfferPreview(offerId: string): Promise<{
  telegramFileId: string;
  bytes: Buffer | null;
} | null> {
  const row = await prisma.paymentOfferMedia.findFirst({
    where: {
      offerId,
      role: "PREVIEW",
      active: true,
      mediaAsset: { active: true, mediaType: "PHOTO" },
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      mediaAsset: { select: { telegramFileId: true, storagePath: true } },
    },
  });
  const fileId = row?.mediaAsset.telegramFileId.trim() ?? "";
  if (!row) return null;
  let bytes: Buffer | null = null;
  try {
    bytes = await readFreePhoto(row.mediaAsset.storagePath);
  } catch {
    bytes = null;
  }
  if (!fileId && !bytes?.length) return null;
  return { telegramFileId: fileId, bytes };
}

export function classifyOfferMediaCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
): { chatId: string; parts: string[] } | null {
  const owner = ownerTelegramId.trim();
  if (!owner) return null;
  const message = update.message;
  if (!message?.from || message.from.is_bot) return null;
  if (message.chat?.type !== "private") return null;
  if (message.business_connection_id) return null;
  if (String(message.from.id) !== owner) return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const parts = text.split(/\s+/);
  const token = parts[0]?.split("@")[0]?.toLowerCase();
  if (token === "/offer_media" && parts.length === 2 && SLUG.test(parts[1] ?? "")) return { chatId: String(message.chat.id), parts };
  if (token === "/offer_preview_set" && parts.length === 3 && SLUG.test(parts[1] ?? "")) return { chatId: String(message.chat.id), parts };
  if (token === "/offer_preview_clear" && parts.length === 2 && SLUG.test(parts[1] ?? "")) return { chatId: String(message.chat.id), parts };
  if (token === "/offer_deliverable_add" && parts.length === 3 && SLUG.test(parts[1] ?? "")) return { chatId: String(message.chat.id), parts };
  if (token === "/offer_deliverable_remove" && parts.length === 3 && SLUG.test(parts[1] ?? "")) return { chatId: String(message.chat.id), parts };
  if (token === "/media_access" && parts.length === 3 && (parts[2] === "free" || parts[2] === "locked")) {
    return { chatId: String(message.chat.id), parts };
  }
  return null;
}

export async function processOfferMediaCommand(
  update: TelegramUpdate,
  ownerTelegramId: string,
  deps: { sendOwner?: (chatId: string, text: string) => Promise<void> } = {},
): Promise<void> {
  const command = classifyOfferMediaCommand(update, ownerTelegramId);
  if (!command) return;
  const sendOwner = deps.sendOwner ?? (async (chatId: string, text: string) => {
    await sendTextMessage(chatId, text);
  });
  const token = command.parts[0]?.split("@")[0]?.toLowerCase();
  const slug = command.parts[1] ?? "";
  const assetToken = command.parts[2] ?? "";
  let text = "No active paid offer is available.";
  if (token === "/offer_media") text = await offerMediaText(slug);
  if (token === "/offer_preview_set") text = await setPreview(slug, assetToken);
  if (token === "/offer_preview_clear") text = await clearPreview(slug);
  if (token === "/offer_deliverable_add") text = await addDeliverable(slug, assetToken);
  if (token === "/offer_deliverable_remove") text = await removeDeliverable(slug, assetToken);
  if (token === "/media_access") text = await setAvailability(command.parts[1] ?? "", command.parts[2] === "free" ? "FREE" : "LOCKED");
  await sendOwner(command.chatId, text);
}

export async function offerMediaText(slug: string): Promise<string> {
  const offer = await prisma.paymentOffer.findUnique({
    where: { slug },
    select: {
      title: true,
      offerMedia: {
        where: { active: true },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: {
          role: true,
          position: true,
          mediaAsset: { select: { id: true, category: true } },
        },
      },
      externalCheckouts: {
        where: { provider: "DROPP", active: true },
        select: { externalLinkId: true, linkIdEvidence: true },
      },
    },
  });
  if (!offer) return "No active paid offer is available.";
  const previews = offer.offerMedia.filter((row) => row.role === "PREVIEW");
  const deliverables = offer.offerMedia.filter((row) => row.role === "DELIVERABLE");
  const previewLines = previews.length
    ? previews.map((row) => `- ${mediaSentLabel(row.mediaAsset)}`)
    : ["none"];
  const deliverableLines = deliverables.length
    ? deliverables.map((row, index) => `${index + 1}. ${mediaSentLabel(row.mediaAsset)}`)
    : ["none"];
  const checkout = offer.externalCheckouts[0];
  const card = !checkout
    ? "Card checkout: not stored"
    : checkout.externalLinkId
      ? `Card checkout: stored. Link id evidence: ${checkout.linkIdEvidence}. Webhook authentication: UNVERIFIED`
      : "Card checkout: stored. Link id: unknown. Webhook authentication: UNVERIFIED";
  return [offer.title, "", "PREVIEW", ...previewLines, "", "DELIVERABLE", ...deliverableLines, "", card].join("\n");
}

async function setPreview(slug: string, assetToken: string): Promise<string> {
  const offer = await activeOffer(slug);
  if (!offer) return "No active paid offer is available.";
  const asset = await resolveAsset(assetToken);
  if (asset === "missing") return "No photo matches that id.";
  if (asset === "inactive") return "That photo is not active.";
  const opposite = await prisma.paymentOfferMedia.findFirst({
    where: { mediaAssetId: asset.id, role: "DELIVERABLE", active: true },
    select: { id: true },
  });
  if (opposite) return "That photo is already a locked deliverable.";
  await prisma.$transaction(async (tx) => {
    await tx.paymentOfferMedia.updateMany({
      where: { offerId: offer.id, role: "PREVIEW", active: true },
      data: { active: false },
    });
    await tx.paymentOfferMedia.upsert({
      where: { offerId_mediaAssetId_role: { offerId: offer.id, mediaAssetId: asset.id, role: "PREVIEW" } },
      create: { offerId: offer.id, mediaAssetId: asset.id, role: "PREVIEW", position: 1, active: true },
      update: { active: true, position: 1 },
    });
    await tx.mediaAsset.update({ where: { id: asset.id }, data: { availability: "LOCKED" } });
  });
  return offerMediaText(slug);
}

async function clearPreview(slug: string): Promise<string> {
  const offer = await activeOffer(slug);
  if (!offer) return "No active paid offer is available.";
  await prisma.paymentOfferMedia.updateMany({
    where: { offerId: offer.id, role: "PREVIEW", active: true },
    data: { active: false },
  });
  return offerMediaText(slug);
}

async function addDeliverable(slug: string, assetToken: string): Promise<string> {
  const offer = await activeOffer(slug);
  if (!offer) return "No active paid offer is available.";
  const asset = await resolveAsset(assetToken);
  if (asset === "missing") return "No photo matches that id.";
  if (asset === "inactive") return "That photo is not active.";
  const opposite = await prisma.paymentOfferMedia.findFirst({
    where: { mediaAssetId: asset.id, role: "PREVIEW", active: true },
    select: { id: true },
  });
  if (opposite) return "That photo is already a preview.";
  const existing = await prisma.paymentOfferMedia.findUnique({
    where: { offerId_mediaAssetId_role: { offerId: offer.id, mediaAssetId: asset.id, role: "DELIVERABLE" } },
  });
  const last = await prisma.paymentOfferMedia.findFirst({
    where: { offerId: offer.id, role: "DELIVERABLE", active: true },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = existing?.active ? existing.position : (last?.position ?? 0) + 1;
  await prisma.$transaction(async (tx) => {
    await tx.paymentOfferMedia.upsert({
      where: { offerId_mediaAssetId_role: { offerId: offer.id, mediaAssetId: asset.id, role: "DELIVERABLE" } },
      create: { offerId: offer.id, mediaAssetId: asset.id, role: "DELIVERABLE", position, active: true },
      update: { active: true, position },
    });
    await tx.mediaAsset.update({ where: { id: asset.id }, data: { availability: "LOCKED" } });
  });
  return offerMediaText(slug);
}

async function removeDeliverable(slug: string, assetToken: string): Promise<string> {
  const offer = await activeOffer(slug);
  if (!offer) return "No active paid offer is available.";
  const asset = await resolveAsset(assetToken, true);
  if (asset === "missing" || asset === "inactive") return "No photo matches that id.";
  await prisma.paymentOfferMedia.updateMany({
    where: { offerId: offer.id, mediaAssetId: asset.id, role: "DELIVERABLE", active: true },
    data: { active: false },
  });
  return offerMediaText(slug);
}

async function setAvailability(assetToken: string, availability: "FREE" | "LOCKED"): Promise<string> {
  const asset = await resolveAsset(assetToken, true);
  if (asset === "missing" || asset === "inactive") return "No photo matches that id.";
  if (availability === "FREE") {
    const deliverable = await prisma.paymentOfferMedia.findFirst({
      where: { mediaAssetId: asset.id, role: "DELIVERABLE", active: true },
      select: { id: true },
    });
    if (deliverable) return "Remove the deliverable assignment first.";
  }
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: { availability } });
  return `${mediaSentLabel(asset)}\n${availability === "FREE" ? "free" : "locked"}`;
}

async function activeOffer(slug: string): Promise<{ id: string } | null> {
  return prisma.paymentOffer.findFirst({ where: { slug, active: true }, select: { id: true } });
}

async function resolveAsset(
  token: string,
  allowInactive = false,
): Promise<{ id: string; category: string; active: boolean } | "missing" | "inactive"> {
  const exact = await prisma.mediaAsset.findUnique({
    where: { id: token },
    select: { id: true, category: true, active: true },
  });
  if (exact) return exact.active || allowInactive ? exact : "inactive";
  const rows = await prisma.mediaAsset.findMany({
    select: { id: true, category: true, active: true },
  });
  const matches = rows.filter((row) => mediaSentLabel(row) === token || row.id.endsWith(token));
  if (matches.length !== 1) return "missing";
  const match = matches[0];
  if (!match) return "missing";
  if (!match.active && !allowInactive) return "inactive";
  return match;
}
