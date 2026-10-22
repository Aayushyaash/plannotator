import { createElement, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * What DOMPurify keeps of an Ask AI answer. Every tag and attribute marked
 * writes for the markdown an answer uses must be listed here, or DOMPurify
 * drops the element and keeps only its text (#2069: tables ran together).
 */
export const CHAT_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  // `align` is what marked writes on th/td for aligned GFM columns.
  ALLOWED_ATTR: ['href', 'rel', 'class', 'align'],
};

/** The markdown step of {@link renderChatMarkdown}, before sanitizing. */
export function chatMarkdownToHtml(text: string): string {
  return marked.parse(text, { async: false, breaks: true }) as string;
}

export function renderChatMarkdown(text: string): ReactNode {
  const clean = DOMPurify.sanitize(chatMarkdownToHtml(text), {
    ALLOWED_TAGS: [...CHAT_SANITIZE_CONFIG.ALLOWED_TAGS],
    ALLOWED_ATTR: [...CHAT_SANITIZE_CONFIG.ALLOWED_ATTR],
  });

  return createElement('div', {
    className: 'ai-markdown',
    dangerouslySetInnerHTML: { __html: clean },
  });
}

export function formatRelativeTime(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
