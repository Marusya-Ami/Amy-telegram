import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().optional(),
  OWNER_TELEGRAM_ID: z.string().optional().default(""),
  APP_TIMEZONE: z.string().min(1).default("America/Cancun"),
  MEDIA_STORAGE_PATH: z.string().optional().default("./data/amy-media"),
  CRON_SECRET: z.string().optional().default(""),
  QUIET_HOURS_START: z.string().optional().default("23:00"),
  QUIET_HOURS_END: z.string().optional().default("09:00"),
  DROPP_WEBHOOK_SECRET: z.string().optional().default(""),
});

export type AppEnv = z.infer<typeof envSchema> & { OPENAI_MODEL: string };

let cached: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID,
    APP_TIMEZONE: process.env.APP_TIMEZONE,
    MEDIA_STORAGE_PATH: process.env.MEDIA_STORAGE_PATH,
    CRON_SECRET: process.env.CRON_SECRET,
    QUIET_HOURS_START: process.env.QUIET_HOURS_START,
    QUIET_HOURS_END: process.env.QUIET_HOURS_END,
    // Bracket access stays dynamic so the production build does not bake in an empty secret.
    DROPP_WEBHOOK_SECRET: process.env["DROPP_WEBHOOK_SECRET"],
  });

  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "env");
    throw new Error(`Missing or invalid environment variables: ${fields.join(", ")}`);
  }

  cached = {
    ...parsed.data,
    OPENAI_MODEL: parsed.data.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    MEDIA_STORAGE_PATH: parsed.data.MEDIA_STORAGE_PATH?.trim() || "./data/amy-media",
  };
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
