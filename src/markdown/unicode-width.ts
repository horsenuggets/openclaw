/**
 * Unicode character width utilities for table alignment in
 * monospace code blocks (Discord). Wide characters (CJK, Hangul,
 * emoji) occupy more visual space than ASCII in Discord's code
 * block font. This module provides width measurement and hairspace
 * compensation to keep pipe-delimited table columns aligned.
 *
 * Hairspace (U+200A) is a very thin space (~0.1x of a regular
 * space in Discord's monospace font). By inserting hairspaces
 * alongside wide characters, we bridge the fractional gap between
 * the integer column model and actual rendered widths.
 */

/** Hairspace character used for sub-column-width alignment. */
export const HAIRSPACE = "\u200A";

/** Left-to-Right Mark — forces LTR context for BiDi neutrals. */
export const LRM = "\u200E";

/**
 * Hairspaces per wide character, expressed as a ratio numerator
 * and denominator. The effective count per N characters is
 * floor(N * NUM / DEN).
 *
 * CJK/Hiragana/Katakana: ~3.33 hairspaces per character.
 * Hangul: same starting ratio (can be tuned independently).
 * Emoji: same starting ratio (can be tuned independently).
 */
const CJK_HAIRSPACE_NUM = 10;
const CJK_HAIRSPACE_DEN = 3;
const HANGUL_HAIRSPACE_NUM = 11;
const HANGUL_HAIRSPACE_DEN = 2;
const EMOJI_HAIRSPACE_NUM = 10;
const EMOJI_HAIRSPACE_DEN = 3;

// ── Character classification ────────────────────────────────────

function isCJK(cp: number): boolean {
  // CJK Unified Ideographs
  if (cp >= 0x4e00 && cp <= 0x9fff) return true;
  // CJK Extension A
  if (cp >= 0x3400 && cp <= 0x4dbf) return true;
  // CJK Compatibility Ideographs
  if (cp >= 0xf900 && cp <= 0xfaff) return true;
  // CJK Extension B+
  if (cp >= 0x20000 && cp <= 0x2a6df) return true;
  // CJK Symbols and Punctuation (fullwidth)
  if (cp >= 0x3000 && cp <= 0x303f) return true;
  // Hiragana
  if (cp >= 0x3040 && cp <= 0x309f) return true;
  // Katakana
  if (cp >= 0x30a0 && cp <= 0x30ff) return true;
  // Katakana Phonetic Extensions
  if (cp >= 0x31f0 && cp <= 0x31ff) return true;
  // Bopomofo
  if (cp >= 0x3100 && cp <= 0x312f) return true;
  // Bopomofo Extended
  if (cp >= 0x31a0 && cp <= 0x31bf) return true;
  // Fullwidth Latin/Symbols
  if (cp >= 0xff01 && cp <= 0xff60) return true;
  // Fullwidth currency/misc
  if (cp >= 0xffe0 && cp <= 0xffe6) return true;
  return false;
}

function isHangul(cp: number): boolean {
  // Hangul Syllables
  if (cp >= 0xac00 && cp <= 0xd7af) return true;
  // Hangul Jamo
  if (cp >= 0x1100 && cp <= 0x11ff) return true;
  // Hangul Compatibility Jamo
  if (cp >= 0x3130 && cp <= 0x318f) return true;
  // Hangul Jamo Extended-A
  if (cp >= 0xa960 && cp <= 0xa97f) return true;
  // Hangul Jamo Extended-B
  if (cp >= 0xd7b0 && cp <= 0xd7ff) return true;
  return false;
}

function isEmoji(cp: number): boolean {
  // Miscellaneous Symbols
  if (cp >= 0x2600 && cp <= 0x26ff) return true;
  // Dingbats
  if (cp >= 0x2700 && cp <= 0x27bf) return true;
  // Emoticons
  if (cp >= 0x1f600 && cp <= 0x1f64f) return true;
  // Misc Symbols and Pictographs
  if (cp >= 0x1f300 && cp <= 0x1f5ff) return true;
  // Transport and Map Symbols
  if (cp >= 0x1f680 && cp <= 0x1f6ff) return true;
  // Supplemental Symbols and Pictographs
  if (cp >= 0x1f900 && cp <= 0x1f9ff) return true;
  // Symbols and Pictographs Extended-A
  if (cp >= 0x1fa00 && cp <= 0x1fa6f) return true;
  // Symbols and Pictographs Extended-B
  if (cp >= 0x1fa70 && cp <= 0x1faff) return true;
  // Regional Indicator Symbols (flags)
  if (cp >= 0x1f1e0 && cp <= 0x1f1ff) return true;
  // Common standalone emoji
  if (cp === 0x2b50) return true; // ⭐
  if (cp === 0x2764) return true; // ❤
  if (cp === 0x2615) return true; // ☕
  if (cp === 0x231a) return true; // ⌚
  if (cp === 0x231b) return true; // ⌛
  if (cp === 0x23e9) return true; // ⏩
  if (cp === 0x23ea) return true; // ⏪
  if (cp === 0x23f0) return true; // ⏰
  if (cp === 0x23f3) return true; // ⏳
  if (cp === 0x25aa) return true; // ▪
  if (cp === 0x25ab) return true; // ▫
  if (cp === 0x25b6) return true; // ▶
  if (cp === 0x25c0) return true; // ◀
  if (cp === 0x25fb) return true; // ◻
  if (cp === 0x25fc) return true; // ◼
  if (cp === 0x25fd) return true; // ◽
  if (cp === 0x25fe) return true; // ◾
  if (cp === 0x2934) return true; // ⤴
  if (cp === 0x2935) return true; // ⤵
  return false;
}

/**
 * Returns true if the given code point is a zero-width character
 * that should not count toward visual width at all (variation
 * selectors, ZWJ, combining marks, etc.).
 */
function isZeroWidth(cp: number): boolean {
  // Zero-width joiner / non-joiner / LRM / RLM
  if (cp >= 0x200c && cp <= 0x200f) return true;
  // Variation selectors
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  // Combining Diacritical Marks
  if (cp >= 0x0300 && cp <= 0x036f) return true;
  // Skin tone modifiers
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true;
  // Combining marks extended
  if (cp >= 0x1ab0 && cp <= 0x1aff) return true;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return true;
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return true;
  return false;
}

// ── RTL detection ───────────────────────────────────────────────

function isRTL(cp: number): boolean {
  // Arabic
  if (cp >= 0x0600 && cp <= 0x06ff) return true;
  // Arabic Supplement
  if (cp >= 0x0750 && cp <= 0x077f) return true;
  // Arabic Extended-A
  if (cp >= 0x08a0 && cp <= 0x08ff) return true;
  // Arabic Presentation Forms-A
  if (cp >= 0xfb50 && cp <= 0xfdff) return true;
  // Arabic Presentation Forms-B
  if (cp >= 0xfe70 && cp <= 0xfeff) return true;
  // Hebrew
  if (cp >= 0x0590 && cp <= 0x05ff) return true;
  // Syriac
  if (cp >= 0x0700 && cp <= 0x074f) return true;
  // Thaana
  if (cp >= 0x0780 && cp <= 0x07bf) return true;
  // NKo
  if (cp >= 0x07c0 && cp <= 0x07ff) return true;
  return false;
}

/**
 * Returns true if the string contains any RTL characters that
 * could disrupt pipe alignment in code-block tables via the
 * Unicode BiDi algorithm.
 */
export function containsRTL(text: string): boolean {
  for (const ch of text) {
    if (isRTL(ch.codePointAt(0)!)) return true;
  }
  return false;
}

// ── Width categories ────────────────────────────────────────────

type CharCategory = "cjk" | "hangul" | "emoji" | "zero" | "normal";

function classifyCodePoint(cp: number): CharCategory {
  if (isZeroWidth(cp)) return "zero";
  if (isHangul(cp)) return "hangul";
  if (isCJK(cp)) return "cjk";
  if (isEmoji(cp)) return "emoji";
  return "normal";
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Count the wide characters in a string, split by category.
 * Zero-width characters are excluded from all counts.
 */
export function countWideChars(text: string): {
  cjk: number;
  hangul: number;
  emoji: number;
} {
  let cjk = 0;
  let hangul = 0;
  let emoji = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const cat = classifyCodePoint(cp);
    if (cat === "cjk") cjk++;
    else if (cat === "hangul") hangul++;
    else if (cat === "emoji") emoji++;
  }
  return { cjk, hangul, emoji };
}

/**
 * Measure the visual column width of text for table alignment.
 * Each wide character (CJK, Hangul, emoji) counts as 2 columns;
 * zero-width characters count as 0; everything else counts as 1.
 */
export function cellVisualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const cat = classifyCodePoint(cp);
    if (cat === "zero") continue;
    width += cat === "normal" ? 1 : 2;
  }
  return width;
}

/**
 * Compute the total number of hairspaces needed for a string's
 * wide characters. Uses per-category ratios with floor rounding
 * to handle fractional-width accumulation.
 */
export function hairspaceCount(text: string): number {
  const { cjk, hangul, emoji } = countWideChars(text);
  return (
    Math.floor((cjk * CJK_HAIRSPACE_NUM) / CJK_HAIRSPACE_DEN) +
    Math.floor((hangul * HANGUL_HAIRSPACE_NUM) / HANGUL_HAIRSPACE_DEN) +
    Math.floor((emoji * EMOJI_HAIRSPACE_NUM) / EMOJI_HAIRSPACE_DEN)
  );
}
