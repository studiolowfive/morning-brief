import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

export function appendJsonl(fileName, rows) {
  ensureDataDir();
  if (!Array.isArray(rows)) rows = [rows];
  if (!rows.length) return;
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  fs.appendFileSync(path.join(dataDir, fileName), body);
}

export function readJsonl(fileName) {
  const filePath = path.join(dataDir, fileName);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function rewriteJsonl(fileName, rows) {
  ensureDataDir();
  const filePath = path.join(dataDir, fileName);
  const body = rows.length ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n" : "";
  fs.writeFileSync(filePath, body);
  return filePath;
}

export function writeJson(fileName, value) {
  ensureDataDir();
  const filePath = path.join(dataDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

export function readJson(fileName) {
  const filePath = path.join(dataDir, fileName);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Collapse the append-only signal log to one row per signal id (keeping the
// freshest copy) and drop anything older than the retention window, so the
// file and the report-time dedupe stay honest instead of growing forever.
export function compactSignals(fileName = "signals.jsonl", retentionDays = 14) {
  const rows = readJsonl(fileName);
  if (!rows.length) return { kept: 0, removed: 0 };

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const byId = new Map();

  for (const row of rows) {
    const stamp = Date.parse(row.publishedAt) || Date.parse(row.collectedAt) || 0;
    if (stamp && stamp < cutoff) continue;
    const key = row.id || `${row.sourceId}:${row.url || row.title}`;
    const existing = byId.get(key);
    const existingStamp = existing ? Date.parse(existing.collectedAt) || 0 : -1;
    if (!existing || (Date.parse(row.collectedAt) || 0) >= existingStamp) {
      byId.set(key, row);
    }
  }

  const kept = [...byId.values()];
  rewriteJsonl(fileName, kept);
  return { kept: kept.length, removed: rows.length - kept.length };
}

export function writeText(fileName, body) {
  ensureDataDir();
  const filePath = path.join(dataDir, fileName);
  fs.writeFileSync(filePath, body);
  return filePath;
}

export function readLatestReport() {
  const reports = readJsonl("reports.jsonl");
  return reports.at(-1) ?? null;
}

export function readManualSignals() {
  return readJsonl("manual-signals.jsonl");
}
