import type { FollowUpPhase } from "@prisma/client";
import { eventCategory } from "@/services/continuity/match";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export const BEFORE_EVENT_LEAD_MS = 10 * 60 * 1000;

const POST_EVENT_DELAY_MS: Record<string, number> = {
  meeting: 40 * 60 * 1000,
  interview: 40 * 60 * 1000,
  exam: 40 * 60 * 1000,
  date: 40 * 60 * 1000,
};

const JOURNEY_EMOTIONS = new Set(["nervous", "anxious", "worried", "excited", "scared", "stressed"]);

export type Weekday = (typeof WEEKDAYS)[number];

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
};

export type WhenInput = {
  now: Date;
  timeZone: string;
  relativeDay: "today" | "tomorrow" | "tonight" | "next_week" | null;
  weekday: Weekday | null;
  explicitDate: string | null;
  hour: number | null;
  minute: number | null;
};

export type ResolvedWhen = {
  eventAt: Date | null;
  eventDate: string | null;
  timeKnown: boolean;
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function zoneFor(userTimeZone: string | null | undefined, appTimeZone: string): string {
  if (userTimeZone && isValidTimeZone(userTimeZone)) return userTimeZone;
  return isValidTimeZone(appTimeZone) ? appTimeZone : "UTC";
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);

  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = weekdayFromPart(pick("weekday"));
  const hour = Number(pick("hour"));
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: hour === 24 ? 0 : hour,
    minute: Number(pick("minute")),
    weekday,
  };
}

export function utcFromZoned(parts: Omit<ZonedParts, "weekday">, timeZone: string): Date {
  let utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const got = zonedParts(new Date(utc), timeZone);
    const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const actual = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute);
    const delta = desired - actual;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

export function resolveWhen(input: WhenInput): ResolvedWhen {
  const timeKnown = input.hour != null;
  const hour = input.hour ?? 0;
  const minute = input.minute ?? 0;
  const today = zonedParts(input.now, input.timeZone);
  let date = { year: today.year, month: today.month, day: today.day };

  if (input.explicitDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.explicitDate);
    if (!match) return { eventAt: null, eventDate: null, timeKnown: false };
    date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  } else if (input.relativeDay === "tomorrow") {
    date = addDays(today, 1);
  } else if (input.relativeDay === "next_week") {
    date = addDays(today, 7);
  } else if (input.weekday) {
    date = nextWeekday(today, input.weekday, timeKnown ? { hour, minute } : null);
  } else if (!input.relativeDay) {
    return { eventAt: null, eventDate: null, timeKnown: false };
  }

  const eventDate = isoDate(date);
  return {
    eventAt: timeKnown ? utcFromZoned({ ...date, hour, minute }, input.timeZone) : null,
    eventDate,
    timeKnown,
  };
}

export function planFollowUpAt(input: {
  now: Date;
  timeZone: string;
  eventAt: Date | null;
  eventDate?: string | null;
  timeKnown: boolean;
  quietStart?: string;
  quietEnd?: string;
}): Date {
  let target: Date;
  const dateOnly = parseIsoDate(input.eventDate);
  if (input.eventAt && input.timeKnown) {
    target = new Date(input.eventAt.getTime() + 2 * 60 * 60 * 1000);
  } else if (dateOnly) {
    const next = addDays({ ...dateOnly, hour: 0, minute: 0, weekday: "sunday" }, 1);
    target = utcFromZoned({ ...next, hour: 11, minute: 0 }, input.timeZone);
  } else {
    const next = addDays(zonedParts(input.now, input.timeZone), 1);
    target = utcFromZoned({ ...next, hour: 11, minute: 0 }, input.timeZone);
  }

  const earliest = input.now.getTime() + 15 * 60 * 1000;
  if (target.getTime() < earliest) target = new Date(earliest);
  return nextOpenMoment(target, input.timeZone, input.quietStart, input.quietEnd);
}

export function postEventDelayMs(title: string): number {
  const category = eventCategory(title);
  return POST_EVENT_DELAY_MS[category ?? ""] ?? 40 * 60 * 1000;
}

export function eventJourneyEligible(input: { title: string; emotionalContext: string | null; timeKnown: boolean }): boolean {
  if (!input.timeKnown) return false;
  const category = eventCategory(input.title);
  if (category === "meeting" || category === "interview" || category === "exam" || category === "date") return true;
  if (/\bimportant\b/i.test(input.title)) return true;
  const emotion = input.emotionalContext?.trim().toLowerCase() ?? "";
  return JOURNEY_EMOTIONS.has(emotion);
}

export function planEventFollowUps(input: {
  now: Date;
  timeZone: string;
  title: string;
  emotionalContext: string | null;
  eventAt: Date | null;
  eventDate?: string | null;
  timeKnown: boolean;
  followUpEligible: boolean;
  quietStart?: string;
  quietEnd?: string;
}): Array<{ phase: FollowUpPhase | null; scheduledAt: Date }> {
  if (!input.followUpEligible) return [];
  const quiet = { quietStart: input.quietStart, quietEnd: input.quietEnd };
  if (!input.timeKnown || !input.eventAt || !eventJourneyEligible(input)) {
    return [{ phase: null, scheduledAt: planFollowUpAt({ ...input, ...quiet }) }];
  }

  const plans: Array<{ phase: FollowUpPhase | null; scheduledAt: Date }> = [];
  const before = adjustPlannedTime(new Date(input.eventAt.getTime() - BEFORE_EVENT_LEAD_MS), input);
  if (before.getTime() < input.eventAt.getTime()) plans.push({ phase: "BEFORE_EVENT", scheduledAt: before });
  plans.push({
    phase: "AFTER_EVENT",
    scheduledAt: adjustPlannedTime(new Date(input.eventAt.getTime() + postEventDelayMs(input.title)), input),
  });
  return plans;
}

function adjustPlannedTime(
  target: Date,
  input: { now: Date; timeZone: string; quietStart?: string; quietEnd?: string },
): Date {
  const earliest = input.now.getTime() + 15 * 60 * 1000;
  const bounded = target.getTime() < earliest ? new Date(earliest) : target;
  return nextOpenMoment(bounded, input.timeZone, input.quietStart, input.quietEnd);
}

export function isQuietHour(
  date: Date,
  timeZone: string,
  start = "23:00",
  end = "09:00",
): boolean {
  const parts = zonedParts(date, timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const startMinutes = clockMinutes(start);
  const endMinutes = clockMinutes(end);
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function nextOpenMoment(
  date: Date,
  timeZone: string,
  start = "23:00",
  end = "09:00",
): Date {
  if (!isQuietHour(date, timeZone, start, end)) return date;
  const parts = zonedParts(date, timeZone);
  const endMinutes = clockMinutes(end);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const day = nowMinutes < endMinutes ? parts : addDays(parts, 1);
  return utcFromZoned(
    { year: day.year, month: day.month, day: day.day, hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
    timeZone,
  );
}

export function proactiveSendDecision(input: {
  now: Date;
  timeZone: string;
  proactiveCount24h: number;
  lastProactiveAt: Date | null;
  proactiveEnabled: boolean;
  aiEnabled: boolean;
  lastUserMessageAt: Date | null;
  quietStart?: string;
  quietEnd?: string;
}): { send: boolean; rescheduleAt: Date | null; reason: string } {
  const quietStart = input.quietStart ?? "23:00";
  const quietEnd = input.quietEnd ?? "09:00";
  const push = (at: Date, reason: string) => ({
    send: false,
    rescheduleAt: nextOpenMoment(at, input.timeZone, quietStart, quietEnd),
    reason,
  });

  if (!input.proactiveEnabled || !input.aiEnabled) {
    return push(new Date(input.now.getTime() + 60 * 60 * 1000), "proactive_disabled");
  }
  if (isQuietHour(input.now, input.timeZone, quietStart, quietEnd)) {
    return push(input.now, "quiet_hours");
  }
  if (input.proactiveCount24h >= 2) {
    return push(new Date(input.now.getTime() + 12 * 60 * 60 * 1000), "daily_cap");
  }
  if (input.lastProactiveAt && input.now.getTime() - input.lastProactiveAt.getTime() < 4 * 60 * 60 * 1000) {
    return push(new Date(input.lastProactiveAt.getTime() + 4 * 60 * 60 * 1000), "too_soon");
  }
  if (input.lastUserMessageAt && input.now.getTime() - input.lastUserMessageAt.getTime() < 20 * 60 * 1000) {
    return push(new Date(input.now.getTime() + 60 * 60 * 1000), "user_active");
  }
  return { send: true, rescheduleAt: null, reason: "due" };
}

function weekdayFromPart(value: string): Weekday {
  const short = value.toLowerCase().slice(0, 3);
  const mapped: Record<string, Weekday> = {
    sun: "sunday",
    mon: "monday",
    tue: "tuesday",
    wed: "wednesday",
    thu: "thursday",
    fri: "friday",
    sat: "saturday",
  };
  return mapped[short] ?? "sunday";
}

function isoDate(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseIsoDate(value: string | null | undefined): { year: number; month: number; day: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function clockMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function addDays(parts: ZonedParts, days: number): ZonedParts {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    weekday: parts.weekday,
  };
}

function nextWeekday(
  today: ZonedParts,
  weekday: Weekday,
  time: { hour: number; minute: number } | null,
): { year: number; month: number; day: number } {
  const todayIndex = WEEKDAYS.indexOf(today.weekday);
  const target = WEEKDAYS.indexOf(weekday);
  let delta = (target - todayIndex + 7) % 7;
  if (delta === 0 && time && (today.hour > time.hour || (today.hour === time.hour && today.minute >= time.minute))) {
    delta = 7;
  }
  const shifted = addDays(today, delta);
  return { year: shifted.year, month: shifted.month, day: shifted.day };
}
