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
 * Replace every embedded JSON object/array with a fenced ```json block
 * (2-space indent), separated from surrounding text by newlines. Non-JSON text
 * is left as-is.
 */
export function formatJsonBlocks(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const end = balancedEnd(text, i);
      if (end !== -1) {
        try {
          const pretty = JSON.stringify(JSON.parse(text.slice(i, end)), null, 2);
          out = out.replace(/\s+$/, "");
          out += `${out.length > 0 ? "\n" : ""}\`\`\`json\n${pretty}\n\`\`\``;
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

/** Auto-link URLs only outside fenced code blocks (so JSON contents stay intact). */
function autoLinkOutsideCode(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => (part.startsWith("```") ? part : autoLinkUrls(part)))
    .join("");
}

/**
 * Build a Log-category embed from raw notice text: pretty-prints embedded JSON
 * and auto-links URLs. No title, no forced italics.
 */
export function buildLogEmbed(text: string): BuiltEmbed {
  const formatted = autoLinkOutsideCode(formatJsonBlocks(text.trim()));
  return buildEmbed({ category: "log", description: formatted });
}
