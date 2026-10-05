import { type BuiltEmbed, buildEmbed } from "./embed-categories.js";

/**
 * Log-message embeds (the "Log Message" category): system notices like agent
 * errors, and lifecycle banners. Their text is often raw and inconsistent, so
 * two readability fixes are applied uniformly: bare http(s) URLs are turned into
 * clickable markdown links, and any embedded JSON is pretty-printed (2-space
 * indent) into a fenced ```json block surrounded by newlines. No forced italics:
 * the embed already carries the visual style. The `» ` style (over `: `) is an
 * authoring choice applied by hand where we control the string, not forced here,
 * so colons from external sources pass through untouched.
 */

/**
 * Wrap bare http(s) URLs in markdown links so Discord renders them clickable,
 * using the URL without its scheme as the label. URLs already inside a markdown
 * link target (`](url)`) or Discord's angle-bracket form (<https://x>) are left
 * alone, and trailing sentence punctuation is kept outside the link.
 */
export function autoLinkUrls(text: string): string {
  return text.replace(/(\]\(|<)?(https?:\/\/[^\s<>)]+)/g, (match, prefix: string, url: string) => {
    if (prefix) {
      return match;
    }
    const trail = url.match(/[.,!?;:]+$/)?.[0] ?? "";
    const clean = trail ? url.slice(0, -trail.length) : url;
    const label = clean.replace(/^https?:\/\//, "");
    return `[${label}](${clean})${trail}`;
  });
}

/**
 * Find the end (exclusive) of a balanced `{...}`/`[...]` span starting at `start`
 * (string contents are skipped), or -1 if it never closes.
 */
function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/**
 * Replace every embedded JSON object/array with a fenced ```json block,
 * separated from surrounding text by newlines. `indent` controls pretty-printing
 * (2 = readable, 0 = compact). Non-JSON text is left as-is.
 */
export function formatJsonBlocks(text: string, indent = 2): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const end = balancedEnd(text, i);
      if (end !== -1) {
        try {
          const json = JSON.stringify(JSON.parse(text.slice(i, end)), null, indent);
          out = out.replace(/\s+$/, "");
          out += `${out.length > 0 ? "\n" : ""}\`\`\`json\n${json}\n\`\`\``;
          i = end;
          while (i < text.length && /\s/.test(text[i])) {
            i += 1;
          }
          if (i < text.length) {
            out += "\n";
          }
          continue;
        } catch {
          // Not valid JSON; emit the character literally and move on.
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Format raw log text: split on any pre-existing ```fenced``` blocks (left
 * untouched so already-formatted JSON is not double-fenced), and on the
 * remaining segments pretty-print embedded JSON and auto-link URLs (links only
 * outside the fences those segments then introduce).
 */
function formatLogText(text: string, indent: number): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith("```")) {
        return part;
      }
      return formatJsonBlocks(part, indent)
        .split(/(```[\s\S]*?```)/g)
        .map((seg) => (seg.startsWith("```") ? seg : autoLinkUrls(seg)))
        .join("");
    })
    .join("");
}

/** Discord's hard limit on an embed description. */
const EMBED_DESCRIPTION_LIMIT = 4096;

/**
 * Strip a single surrounding `*...*` italic wrap that the agent-side error
 * formatter (errors.ts) adds, so the raw error text can be rendered in a Log
 * embed without stray asterisks. Leaves `**bold**` and unwrapped text untouched.
 */
export function stripSurroundingItalics(text: string): string {
  const match = text.match(/^\*([^*][\s\S]*?[^*]|[^*])\*$/);
  return match ? match[1] : text;
}

/**
 * Build a Log-category embed from raw notice text: pretty-prints embedded JSON
 * and auto-links URLs. No title, no forced italics. Keeps the description within
 * Discord's limit by falling back to compact JSON, then truncating, so a large
 * payload never rejects the whole send.
 */
export function buildLogEmbed(text: string): BuiltEmbed {
  const trimmed = text.trim();
  let description = formatLogText(trimmed, 2);
  if (description.length > EMBED_DESCRIPTION_LIMIT) {
    description = formatLogText(trimmed, 0);
  }
  if (description.length > EMBED_DESCRIPTION_LIMIT) {
    description = `${description.slice(0, EMBED_DESCRIPTION_LIMIT - 1)}…`;
  }
  return buildEmbed({ category: "log", description });
}
