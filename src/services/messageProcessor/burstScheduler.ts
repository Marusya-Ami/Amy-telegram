export const TEXT_BURST_DEBOUNCE_MS = 3000;

export class BurstScheduler {
  private readonly deadlines = new Map<string, number>();

  constructor(private readonly debounceMs = TEXT_BURST_DEBOUNCE_MS) {}

  push(userId: string, now: number): number {
    const deadline = now + this.debounceMs;
    this.deadlines.set(userId, deadline);
    return deadline;
  }

  flush(now: number): string[] {
    const due: string[] = [];
    for (const [userId, deadline] of this.deadlines) {
      if (deadline <= now) {
        due.push(userId);
        this.deadlines.delete(userId);
      }
    }
    return due;
  }
}

export function createBurstTimer(debounceMs: number, run: (userId: string) => void) {
  const tokens = new Map<string, number>();
  const timers = new Map<string, NodeJS.Timeout>();

  return {
    push(userId: string) {
      const token = (tokens.get(userId) ?? 0) + 1;
      tokens.set(userId, token);
      const existing = timers.get(userId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        timers.delete(userId);
        if (tokens.get(userId) !== token) return;
        run(userId);
      }, debounceMs);

      timers.set(userId, timer);
    },
  };
}

export function interMessageDelayMs(random: () => number = Math.random): number {
  return 700 + Math.floor(random() * 1101);
}
