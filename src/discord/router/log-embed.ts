import { type BuiltEmbed, buildEmbed } from "./embed-categories.js";

/**
 * Log-message embeds (the "Log Message" category): system notices like agent
 * errors, and lifecycle banners. Their text is often raw and inconsistent, so
 * two fixes are applied uniformly: bare http(s) URLs are turned into clickable
 * markdown links, and the whole description is italicized. The `» ` style (over
 * `: `) is an authoring choice applied by hand where we control the string, not
 * forced here, so colons from external sources pass through untouched.
 */

/**
 * Wrap bare http(s) URLs in markdown links so Discord renders them clickable,
 * using the URL without its scheme as the label. URLs already inside a markdown
 * link target (`](url)`) are left alone, and trailing sentence punctuation is
 * kept outside the link.
 */
export function autoLinkUrls(text: string): string {
  return text.replace(/(\]\()?(https?:\/\/[^\s<>)]+)/g, (match, linkOpen: string, url: string) => {
    if (linkOpen) {
      return match; // already the target of a [label](url) link
    }
    const trail = url.match(/[.,!?;:]+$/)?.[0] ?? "";
    const clean = trail ? url.slice(0, -trail.length) : url;
    const label = clean.replace(/^https?:\/\//, "");
    return `[${label}](${clean})${trail}`;
  });
}

/**
 * Build a Log-category embed from raw notice text: auto-links URLs and
 * italicizes the whole description. No title (log messages are title-less).
 */
export function buildLogEmbed(text: string): BuiltEmbed {
  return buildEmbed({ category: "log", description: `*${autoLinkUrls(text.trim())}*` });
}
