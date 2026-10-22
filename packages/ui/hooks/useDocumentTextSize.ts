import { useLayoutEffect } from 'react';
import { useConfigValue } from '../config';
import { applyDocumentTextSize, DEFAULT_DOCUMENT_TEXT_SIZE } from '../utils/documentTextSize';

/**
 * Apply the `documentTextSize` setting (Settings → Display → Text size) to the
 * document element for as long as the calling component is mounted. A layout
 * effect, so a remembered size is on the page before its first paint. On
 * unmount the default is put back.
 */
export function useDocumentTextSize(): void {
  const size = useConfigValue('documentTextSize');
  useLayoutEffect(() => {
    applyDocumentTextSize(document.documentElement, size);
  }, [size]);
  useLayoutEffect(
    () => () => applyDocumentTextSize(document.documentElement, DEFAULT_DOCUMENT_TEXT_SIZE),
    [],
  );
}
