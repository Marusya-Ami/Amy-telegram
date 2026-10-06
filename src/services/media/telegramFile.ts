import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const TELEGRAM_API = "https://api.telegram.org";
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export type DownloadedTelegramFile = {
  bytes: Buffer;
  extension: string;
  mimeType: string;
};

export async function downloadTelegramFile(fileId: string): Promise<DownloadedTelegramFile> {
  const token = getEnv().TELEGRAM_BOT_TOKEN;
  const infoResponse = await fetch(`${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const info = (await infoResponse.json().catch(() => null)) as { ok?: boolean; result?: { file_path?: string } } | null;
  const filePath = info?.result?.file_path;
  if (!infoResponse.ok || !info?.ok || !filePath) {
    logger.warn("media.download_failed", { status: infoResponse.status });
    throw new Error("Telegram getFile failed");
  }

  const extension = extensionOf(filePath);
  const fileResponse = await fetch(`${TELEGRAM_API}/file/bot${token}/${filePath}`);
  if (!fileResponse.ok) {
    logger.warn("media.download_failed", { status: fileResponse.status });
    throw new Error("Telegram file download failed");
  }
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  if (bytes.length === 0) throw new Error("Telegram file was empty");
  return { bytes, extension, mimeType: mimeOf(extension) };
}

function extensionOf(filePath: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filePath);
  const extension = match ? `.${match[1].toLowerCase()}` : ".jpg";
  return ALLOWED_EXTENSIONS.has(extension) ? extension : ".jpg";
}

function mimeOf(extension: string): string {
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}
