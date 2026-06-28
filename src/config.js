import fs from "node:fs";
import path from "node:path";

export function loadSourceConfig() {
  const filePath = path.join(process.cwd(), "config", "sources.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
