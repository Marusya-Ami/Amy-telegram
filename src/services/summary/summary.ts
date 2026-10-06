export const SUMMARY_MESSAGE_THRESHOLD = 24;

export function shouldRefreshSummary(messagesSinceSummary: number): boolean {
  return messagesSinceSummary >= SUMMARY_MESSAGE_THRESHOLD;
}
