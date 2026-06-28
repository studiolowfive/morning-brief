const entities = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};

export function decodeHtml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_, name) => entities[name.toLowerCase()] ?? `&${name};`)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripMarkdown(value = "") {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`>#]/g, "").trim();
}

export function slugText(value = "") {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|and|or|to|of|for|in|on|with|a|an|is|are|it|this|that)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function clip(value = "", length = 240) {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 3).trim()}...`;
}
