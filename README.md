# Amy Telegram

Amy is an AI companion people talk to in Telegram. This repository is Milestone 1: a private text conversation, with every inbound and outbound message stored in PostgreSQL.

There is no dashboard. Later milestones (memory, follow-ups, media, Telegram Stars, and the daily owner report) are not implemented yet.

## Requirements

- Node.js 20+
- PostgreSQL 16
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An OpenAI API key

## Setup

```bash
cp .env.example .env
```

Fill in `.env`. Do not commit it.

```bash
createdb amy_bot
npm install
npx prisma migrate dev
npm run dev
```

The app listens on port 3000.

## Environment

| Variable | Milestone 1 |
| --- | --- |
| `DATABASE_URL` | Required. Use a database dedicated to this app, for example `amy_bot`. |
| `TELEGRAM_BOT_TOKEN` | Required. |
| `TELEGRAM_WEBHOOK_SECRET` | Required. Any long random string you also pass to `setWebhook`. |
| `OPENAI_API_KEY` | Required. |
| `OPENAI_MODEL` | Optional. Defaults to `gpt-4o-mini` when empty. |
| `OWNER_TELEGRAM_ID` | Not used until a later milestone. |
| `APP_TIMEZONE` | Defaults to `America/Cancun`. Not used for scheduling yet. |
| `MEDIA_STORAGE_PATH` | Reserved for later media storage. |
| `CRON_SECRET` | Reserved for later scheduled jobs. |

Telegram must reach `https://<your-host>/api/telegram/webhook`. For a laptop, expose port 3000 with a tunnel, then register the webhook:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://<public-host>/api/telegram/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d "allowed_updates=[\"message\"]"
```

`secret_token` must match `TELEGRAM_WEBHOOK_SECRET`.
