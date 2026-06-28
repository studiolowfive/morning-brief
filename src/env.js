import fs from "node:fs";
import path from "node:path";

export function loadEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return process.env;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }

  return process.env;
}

export function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}
