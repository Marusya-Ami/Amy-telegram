import type { Prisma } from "@prisma/client";

/**
 * FREE_MEDIA may send an asset only when it is explicitly free-safe.
 * An active DELIVERABLE assignment is locked even if the flag still says FREE.
 * A PREVIEW is excluded unless its availability is FREE.
 */
export function isFreePhotoEligible(input: {
  active: boolean;
  availability: "FREE" | "LOCKED";
  deliverable: boolean;
}): boolean {
  if (!input.active || input.deliverable) return false;
  return input.availability === "FREE";
}

export function freeSelectableAssetWhere(extra: Prisma.MediaAssetWhereInput = {}): Prisma.MediaAssetWhereInput {
  return {
    ...extra,
    active: true,
    availability: "FREE",
    offerMedia: { none: { active: true, role: "DELIVERABLE" } },
  };
}
