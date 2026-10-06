import type { MemoryType, UserMemory } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import type { ContinuityExtraction } from "@/services/continuity/schema";

const MIN_CONFIDENCE = 0.6;
const MIN_IMPORTANCE = 0.35;
const CORRECTION_CONFIDENCE = 0.75;

export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function applyMemories(
  userId: string,
  memories: ContinuityExtraction["memories"],
  sourceMessageId: string | null,
): Promise<void> {
  for (const candidate of memories) {
    const key = normalizeKey(candidate.key);
    if (!key || candidate.confidence < MIN_CONFIDENCE || candidate.importance < MIN_IMPORTANCE) continue;

    if (candidate.replacesKey && candidate.confidence >= CORRECTION_CONFIDENCE) {
      await deactivateKey(userId, normalizeKey(candidate.replacesKey));
    }

    const existing = await prisma.userMemory.findFirst({
      where: { userId, key, active: true },
      orderBy: { updatedAt: "desc" },
    });

    if (!existing) {
      const created = await prisma.userMemory.create({
        data: {
          userId,
          type: candidate.type as MemoryType,
          key,
          value: candidate.value.trim(),
          confidence: candidate.confidence,
          importance: candidate.importance,
          sourceMessageId,
        },
      });
      logger.info("memory.created", { userId, memoryId: created.id, type: created.type, key });
      continue;
    }

    if (normalizeValue(existing.value) === normalizeValue(candidate.value)) {
      await prisma.userMemory.update({
        where: { id: existing.id },
        data: {
          lastConfirmedAt: new Date(),
          confidence: Math.max(existing.confidence, candidate.confidence),
          importance: Math.max(existing.importance, candidate.importance),
          type: candidate.type as MemoryType,
        },
      });
      logger.info("memory.updated", { userId, memoryId: existing.id, key, change: "confirmed" });
      continue;
    }

    if (candidate.confidence < CORRECTION_CONFIDENCE) continue;

    await prisma.userMemory.update({
      where: { id: existing.id },
      data: { active: false },
    });
    const created = await prisma.userMemory.create({
      data: {
        userId,
        type: candidate.type as MemoryType,
        key,
        value: candidate.value.trim(),
        confidence: candidate.confidence,
        importance: candidate.importance,
        sourceMessageId,
      },
    });
    logger.info("memory.updated", { userId, memoryId: created.id, key, change: "replaced", previousId: existing.id });
  }
}

export async function selectRelevantMemories(
  userId: string,
  texts: string[],
  limit = 8,
): Promise<UserMemory[]> {
  const active = await prisma.userMemory.findMany({
    where: { userId, active: true },
    orderBy: [{ importance: "desc" }, { lastConfirmedAt: "desc" }],
    take: 40,
  });
  const selected = rankMemories(active, texts, limit);
  if (selected.length > 0) {
    await prisma.userMemory.updateMany({
      where: { id: { in: selected.map((memory) => memory.id) } },
      data: { lastUsedAt: new Date() },
    });
  }
  return selected;
}

export function rankMemories<T extends { id: string; key: string; value: string; importance: number; lastConfirmedAt: Date }>(
  memories: T[],
  texts: string[],
  limit = 8,
): T[] {
  const haystack = texts.join(" ").toLowerCase();
  const scored = memories.map((memory) => {
    const words = `${memory.key} ${memory.value}`.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
    const keywordHit = words.some((word) => haystack.includes(word));
    const recency = memory.lastConfirmedAt.getTime() / 1e13;
    const score = memory.importance * 2 + (keywordHit ? 1.2 : 0) + recency;
    return { memory, score, core: memory.importance >= 0.8 };
  });

  const chosen: T[] = [];
  for (const item of scored.filter((item) => item.core).sort((a, b) => b.score - a.score)) {
    if (chosen.length >= 4) break;
    chosen.push(item.memory);
  }
  for (const item of scored.sort((a, b) => b.score - a.score)) {
    if (chosen.length >= limit) break;
    if (!chosen.some((memory) => memory.id === item.memory.id)) chosen.push(item.memory);
  }
  return chosen;
}

async function deactivateKey(userId: string, key: string): Promise<void> {
  if (!key) return;
  await prisma.userMemory.updateMany({
    where: { userId, key, active: true },
    data: { active: false },
  });
}
