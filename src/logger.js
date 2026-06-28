import fs from "node:fs";
import path from "node:path";

const logDir = path.join(process.cwd(), "logs");

export function log(level, message, meta = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta
  };
  fs.appendFileSync(path.join(logDir, "morning-brief.log"), `${JSON.stringify(entry)}\n`);
  const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${level}] ${message}${suffix}`);
}

export const logger = {
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  error: (message, meta) => log("error", message, meta)
};
