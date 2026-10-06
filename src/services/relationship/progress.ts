import type { RelationshipStage } from "@prisma/client";

export function nextRelationshipStage(input: {
  current: RelationshipStage;
  messagesCount: number;
  activeDays: number;
}): RelationshipStage {
  if (input.current === "VIP" || input.current === "DORMANT") return input.current;

  let stage: RelationshipStage = "NEW";
  if (input.messagesCount >= 12 || input.activeDays >= 2) stage = "ACQUAINTANCE";
  if (input.messagesCount >= 40 && input.activeDays >= 3) stage = "ENGAGED";
  if (input.messagesCount >= 100 && input.activeDays >= 8) stage = "CLOSE";

  const rank: Record<RelationshipStage, number> = {
    NEW: 0,
    ACQUAINTANCE: 1,
    ENGAGED: 2,
    CLOSE: 3,
    VIP: 4,
    DORMANT: -1,
  };
  return rank[stage] > rank[input.current] ? stage : input.current;
}
