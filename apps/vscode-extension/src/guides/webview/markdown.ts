/**
 * Markdown and diagram output for the Guides webviews, sanitized: agent text
 * is never trusted. DOMPurify keeps only `code:`, `symbol:`, `chapter:` and
 * http(s) links; our links become `data-link` attributes the delegated
 * handlers act on, so nothing navigates the webview itself.
 */

import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false });

const ALERT_KINDS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

const LINK_RE = /^(code|symbol|chapter):/i;

let hooked = false;
function hookOnce(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A") {
      const href = node.getAttribute("href") ?? "";
      node.removeAttribute("href");
      node.removeAttribute("target");
      if (LINK_RE.test(href)) {
        node.setAttribute("data-link", href);
        node.setAttribute("class", "pn-link");
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "link");
      } else if (/^https?:\/\//i.test(href)) {
        node.setAttribute("data-external", href);
        node.setAttribute("class", "pn-ext");
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "link");
      }
    }
  });
}

const PURIFY_CONFIG = {
  ALLOWED_URI_REGEXP: /^(?:code:|symbol:|chapter:|https?:)/i,
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "img", "video", "audio", "svg", "math"],
  FORBID_ATTR: ["style", "id", "class"],
};

/** Markdown to a sanitized fragment. */
export function renderMarkdown(text: string): DocumentFragment {
  hookOnce();
  const html = marked.parse(text, { async: false }) as string;
  const fragment = DOMPurify.sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
  for (const quote of Array.from(fragment.querySelectorAll("blockquote"))) markAlert(quote);
  return fragment;
}

/** Inline markdown (a file summary) to a sanitized fragment without the wrapping paragraph. */
export function renderInlineMarkdown(text: string): DocumentFragment {
  hookOnce();
  const html = marked.parseInline(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
}

/** `> [!IMPORTANT]` blockquotes become callouts (GitHub alert syntax, as in the web app). */
function markAlert(quote: HTMLQuoteElement): void {
  const first = quote.querySelector("p");
  if (!first) return;
  const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.textContent ?? "");
  if (!m) return;
  const kind = m[1].toUpperCase();
  quote.classList.add("pn-alert", `pn-alert-${kind.toLowerCase()}`);
  // Drop the marker text from the first text node.
  const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
  const textNode = walker.nextNode() as Text | null;
  if (textNode) textNode.data = textNode.data.replace(/^\s*\[![A-Z]+\]\s*/i, "");
  const title = document.createElement("div");
  title.className = "pn-alert-title";
  title.textContent = ALERT_KINDS[kind];
  quote.insertBefore(title, quote.firstChild);
}
