import { monoFontStack } from '@plannotator/ui/utils/cssFontFamily';

/**
 * Font override CSS for Pierre's shadow DOM.
 *
 * Single home for the font-family/font-size injection block shared by
 * usePierreTheme (live diff theme) and DiffHunkPreview (synchronous tooltip
 * theme). fontFamily is free text since custom fonts (#851); monoFontStack
 * quotes and escapes it so a name can't break out of the CSS string.
 */
export function buildPierreFontCSS(fontFamily?: string, fontSize?: string): string {
  const stack = monoFontStack(fontFamily);
  if (!stack && !fontSize) return '';
  return `
      pre, code, [data-line-content], [data-column-number] {
        ${stack ? `font-family: ${stack} !important;` : ''}
        ${fontSize ? `font-size: ${fontSize} !important; line-height: 1.5 !important;` : ''}
      }`;
}
