import { timingSafeEqual } from "crypto";

export function secretsMatch(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const actual = Buffer.from(provided);
  const required = Buffer.from(expected);
  if (actual.length !== required.length) return false;
  return timingSafeEqual(actual, required);
}
