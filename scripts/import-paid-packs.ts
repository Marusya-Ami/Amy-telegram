import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { getEnv } from "@/lib/env";
import { isFreePhotoEligible } from "@/services/media/eligibility";

const SOURCE = process.argv[2];
if (!SOURCE) throw new Error("Pass the import-paid-packs directory.");

type Pack = {
  slug: string;
  title: string;
  checkoutUrl: string;
  publicCode: string;
  externalLinkId: string;
  usd: number;
};

/** Link ids come from Dropp's /link/{linkId} redirect, not from the public /s/ code. */
const PACKS: Pack[] = [
  { slug: "keep-it-secret-10", title: "Keep It Secret 🤫", checkoutUrl: "https://app.dropp.fans/s/fS1BWDHx", publicCode: "fS1BWDHx", externalLinkId: "link_H4HzUQ1_5SN9YykZNvpx", usd: 10 },
  { slug: "just-between-us", title: "Just Between Us 💋", checkoutUrl: "https://app.dropp.fans/s/dGIPaLlG", publicCode: "dGIPaLlG", externalLinkId: "link_h8qHQBOvlEVSUzFirIKc", usd: 30 },
  { slug: "private-mood", title: "Private Mood 🖤", checkoutUrl: "https://app.dropp.fans/s/rVimIgw2", publicCode: "rVimIgw2", externalLinkId: "link_B5hqHInZO9GZGbm1L6cJ", usd: 12 },
  { slug: "icecream", title: "Icecream", checkoutUrl: "https://app.dropp.fans/s/7MXow3E1", publicCode: "7MXow3E1", externalLinkId: "link_1ZS05netYL120SVuK7iH", usd: 18 },
  { slug: "a-little-too-much", title: "A Little Too Much 😈", checkoutUrl: "https://app.dropp.fans/s/pLp1RJzo", publicCode: "pLp1RJzo", externalLinkId: "link_yfOzC_Hwwq09aJrTZuGm", usd: 27 },
  { slug: "for-your-eyes-only", title: "For Your Eyes Only 👀", checkoutUrl: "https://app.dropp.fans/s/OuDQ8UfY", publicCode: "OuDQ8UfY", externalLinkId: "link_ueZuZ7pAnxeROEUY70DM", usd: 18 },
  { slug: "i-shouldnt-send-this", title: "I Shouldn’t Send This 😏", checkoutUrl: "https://app.dropp.fans/s/Ng9DYJF2", publicCode: "Ng9DYJF2", externalLinkId: "link_7v9O05Si7f_K0tBwIJiZ", usd: 20 },
  { slug: "keep-it-secret-25", title: "Keep It Secret 🤫", checkoutUrl: "https://app.dropp.fans/s/Jiy92Jni", publicCode: "Jiy92Jni", externalLinkId: "link_zik50sSaE0kWO9MfvVD4", usd: 25 },
  { slug: "my-favourite-pack", title: "My favourite pack", checkoutUrl: "https://app.dropp.fans/s/1yP1MpwT", publicCode: "1yP1MpwT", externalLinkId: "link_lZNTiuSUvcqxLiYMW7ov", usd: 15 },
];

const IMAGE: Record<string, (bytes: Buffer) => boolean> = {
  ".jpeg": (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  ".jpg": (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  ".png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ".webp": (bytes) => bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP",
};

async function main() {
  const showerBefore = await showerSnapshot();
  const paymentsBefore = await prisma.payment.count();
  const intentsBefore = await prisma.paymentIntent.count();
  const seenHashes = new Map<string, string>();
  const existingHashes = await hashStoredFiles();

  for (const pack of PACKS) {
    if (pack.slug === "shower-time") throw new Error("Refusing to touch shower-time.");
    if (!pack.externalLinkId.startsWith("link_") || pack.externalLinkId === pack.publicCode) {
      throw new Error(`Unverified Dropp link id for ${pack.slug}.`);
    }
    const folder = path.resolve(SOURCE, pack.slug);
    const names = (await readdir(folder)).filter((name) => !name.startsWith(".")).sort((a, b) => a.localeCompare(b));
    if (names.length === 0) throw new Error(`No photos in ${pack.slug}.`);
    const files = [];
    for (const name of names) {
      const bytes = await readFile(path.join(folder, name));
      const extension = path.extname(name).toLowerCase();
      const check = IMAGE[extension];
      if (!check?.(bytes)) throw new Error(`Unreadable image in ${pack.slug}.`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (seenHashes.has(sha256) || existingHashes.has(sha256)) throw new Error(`Duplicate photo for ${pack.slug}.`);
      seenHashes.set(sha256, pack.slug);
      files.push({ name, bytes, extension, sha256 });
    }

    const description = `${files.length} private photos`;
    const offer = await prisma.paymentOffer.upsert({
      where: { slug: pack.slug },
      create: {
        slug: pack.slug,
        title: pack.title,
        description,
        kind: "PAID_CONTENT",
        tags: [],
        contexts: [],
        flirtLevel: null,
        active: true,
      },
      update: { title: pack.title, description, active: true },
    });
    await prisma.paymentOfferPrice.upsert({
      where: { offerId_provider_currency: { offerId: offer.id, provider: "DROPP", currency: "USD" } },
      create: { offerId: offer.id, provider: "DROPP", amount: pack.usd, currency: "USD", active: true },
      update: { amount: pack.usd, active: true },
    });
    await prisma.paymentOfferExternalCheckout.upsert({
      where: { offerId_provider: { offerId: offer.id, provider: "DROPP" } },
      create: {
        offerId: offer.id,
        provider: "DROPP",
        checkoutUrl: pack.checkoutUrl,
        externalLinkId: pack.externalLinkId,
        linkIdEvidence: "public_redirect_route",
        active: true,
      },
      update: {
        checkoutUrl: pack.checkoutUrl,
        externalLinkId: pack.externalLinkId,
        linkIdEvidence: "public_redirect_route",
        active: true,
      },
    });

    const root = path.resolve(getEnv().MEDIA_STORAGE_PATH);
    for (const [index, file] of files.entries()) {
      const position = index + 1;
      const storagePath = path.posix.join("paid", pack.slug, `${String(position).padStart(2, "0")}${file.extension}`);
      const destination = path.resolve(root, storagePath);
      if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Refused to write outside media storage.");
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(folder, file.name), destination);
      const uniqueId = `local-${file.sha256}`;
      const asset = await prisma.mediaAsset.upsert({
        where: { telegramFileUniqueId: uniqueId },
        create: {
          telegramFileId: uniqueId,
          telegramFileUniqueId: uniqueId,
          storagePath,
          mediaType: "PHOTO",
          category: "other",
          description: "Private deliverable",
          tags: [],
          mood: "private",
          flirtLevel: 3,
          peopleCount: 1,
          hasAmy: true,
          hasLuna: false,
          contexts: [],
          notes: `paid-pack:${pack.slug}`,
          active: true,
          availability: "LOCKED",
        },
        update: { storagePath, availability: "LOCKED", active: true },
      });
      const other = await prisma.paymentOfferMedia.findFirst({
        where: { mediaAssetId: asset.id, active: true, offerId: { not: offer.id } },
        select: { id: true },
      });
      if (other) throw new Error(`Photo already belongs to another offer (${pack.slug}).`);
      await prisma.paymentOfferMedia.upsert({
        where: { offerId_mediaAssetId_role: { offerId: offer.id, mediaAssetId: asset.id, role: "DELIVERABLE" } },
        create: { offerId: offer.id, mediaAssetId: asset.id, role: "DELIVERABLE", position, active: true },
        update: { position, active: true },
      });
    }
  }

  const showerAfter = await showerSnapshot();
  if (JSON.stringify(showerBefore) !== JSON.stringify(showerAfter)) throw new Error("shower-time changed.");
  if ((await prisma.payment.count()) !== paymentsBefore) throw new Error("A payment was created.");
  if ((await prisma.paymentIntent.count()) !== intentsBefore) throw new Error("A payment intent was created.");
  console.log(JSON.stringify(await report(), null, 2));
  await prisma.$disconnect();
}

async function showerSnapshot() {
  const offer = await prisma.paymentOffer.findUnique({
    where: { slug: "shower-time" },
    select: {
      title: true,
      description: true,
      active: true,
      tags: true,
      contexts: true,
      updatedAt: true,
      prices: { select: { provider: true, amount: true, currency: true, active: true } },
      externalCheckouts: { select: { provider: true, linkIdEvidence: true, externalLinkId: true, checkoutUrl: true, active: true } },
      offerMedia: { select: { role: true, position: true, active: true, mediaAssetId: true } },
    },
  });
  return offer;
}

async function hashStoredFiles(): Promise<Set<string>> {
  const root = path.resolve(getEnv().MEDIA_STORAGE_PATH);
  const hashes = new Set<string>();
  async function walk(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) hashes.add(createHash("sha256").update(await readFile(full)).digest("hex"));
    }
  }
  await walk(root);
  return hashes;
}

async function report() {
  const rows = [];
  for (const pack of PACKS) {
    const offer = await prisma.paymentOffer.findUniqueOrThrow({
      where: { slug: pack.slug },
      select: {
        title: true,
        tags: true,
        contexts: true,
        prices: { select: { provider: true, amount: true, currency: true, active: true } },
        externalCheckouts: { select: { provider: true, externalLinkId: true, linkIdEvidence: true, checkoutUrl: true, active: true } },
        offerMedia: {
          where: { active: true },
          select: { role: true, position: true, mediaAsset: { select: { active: true, availability: true, storagePath: true } } },
        },
      },
    });
    const deliverables = offer.offerMedia.filter((row) => row.role === "DELIVERABLE");
    const stars = offer.prices.find((price) => price.provider === "TELEGRAM_STARS" && price.currency === "XTR" && price.active);
    const dropp = offer.prices.find((price) => price.provider === "DROPP" && price.currency === "USD" && price.active);
    const checkout = offer.externalCheckouts.find((row) => row.provider === "DROPP" && row.active);
    const freeEligible = deliverables.filter((row) =>
      isFreePhotoEligible({
        active: row.mediaAsset.active,
        availability: row.mediaAsset.availability,
        deliverable: true,
      }),
    );
    rows.push({
      slug: pack.slug,
      title: offer.title,
      photos: deliverables.length,
      locked: deliverables.every((row) => row.mediaAsset.availability === "LOCKED" && row.mediaAsset.active),
      previews: offer.offerMedia.filter((row) => row.role === "PREVIEW").length,
      paidPaths: deliverables.every((row) => row.mediaAsset.storagePath.startsWith(`paid/${pack.slug}/`)),
      order: deliverables.map((row) => row.position).join(","),
      droppUsd: dropp?.amount ?? null,
      droppMapped: checkout?.checkoutUrl === pack.checkoutUrl,
      verifiedLinkId: checkout?.linkIdEvidence === "public_redirect_route" && checkout.externalLinkId === pack.externalLinkId,
      linkIdIsPublicCode: checkout?.externalLinkId === pack.publicCode,
      xtr: stars?.amount ?? null,
      sellableViaStars: Boolean(stars),
      salesTags: offer.tags,
      salesContexts: offer.contexts,
      freeEligible: freeEligible.length,
    });
  }
  return rows;
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : "import failed");
  await prisma.$disconnect();
  process.exit(1);
});
