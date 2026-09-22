type LogLevel = "info" | "warn" | "error";

const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|credential/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(nested);
  }
  return output;
}

function write(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info(event: string, fields?: Record<string, unknown>) {
    write("info", event, fields);
  },
  warn(event: string, fields?: Record<string, unknown>) {
    write("warn", event, fields);
  },
  error(event: string, fields?: Record<string, unknown>) {
    write("error", event, fields);
  },
};
