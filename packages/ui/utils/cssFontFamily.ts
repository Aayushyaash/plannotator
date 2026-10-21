/**
 * The code font is free text since custom fonts (#851): a person types the
 * family name of a font installed on their machine. Every place that turns
 * that name into CSS goes through here, so a quote, backslash or line break
 * in it can never end the CSS string early.
 *
 * Only a family NAME is accepted, never a URL or a stack: the name resolves
 * against the fonts installed on the machine showing the page, and nothing
 * is fetched for it.
 */

/** Longest family name kept. Real names are far shorter. */
export const MAX_FONT_FAMILY_LENGTH = 200;

/** Control characters (C0, DEL, C1) and the Unicode line and paragraph separators. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** The name as it is stored: control characters dropped, trimmed, capped. */
export function normalizeFontFamilyName(name: string): string {
  return name.replace(CONTROL_CHARS, '').trim().slice(0, MAX_FONT_FAMILY_LENGTH).trim();
}

/**
 * The name as a CSS string (`"Iosevka Term"`), with backslashes and double
 * quotes escaped. Empty for an empty name.
 */
export function quoteFontFamily(name: string): string {
  const clean = normalizeFontFamilyName(name);
  if (!clean) return '';
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A `font-family` value for code: the quoted name, then the generic
 * `monospace`, so a name that is not installed still renders aligned code.
 * Empty for an empty name.
 */
export function monoFontStack(name: string | undefined): string {
  const quoted = name ? quoteFontFamily(name) : '';
  return quoted ? `${quoted}, monospace` : '';
}
