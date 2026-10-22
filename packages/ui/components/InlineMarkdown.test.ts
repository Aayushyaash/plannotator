import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import katex from 'katex';
import { InlineMarkdown, resetDigitHexIssueRefs, setDigitHexIssueRefs, trimUrlTail } from './InlineMarkdown';
import { getMathRenderer, getMathRendererSource, resetMathRenderer, setMathRenderer } from '../utils/math';

function renderInline(text: string): string {
  return renderToStaticMarkup(createElement(InlineMarkdown, { text }));
}

describe('trimUrlTail', () => {
  test('trims trailing period', () => {
    expect(trimUrlTail('https://foo.com.')).toBe('https://foo.com');
  });

  test('trims trailing comma / semicolon / question mark', () => {
    expect(trimUrlTail('https://foo.com,')).toBe('https://foo.com');
    expect(trimUrlTail('https://foo.com;')).toBe('https://foo.com');
    expect(trimUrlTail('https://foo.com?')).toBe('https://foo.com?'.replace(/\?$/, ''));
  });

  test('keeps closing paren when it balances an opener', () => {
    expect(trimUrlTail('https://en.wikipedia.org/wiki/Function_(mathematics)')).toBe(
      'https://en.wikipedia.org/wiki/Function_(mathematics)',
    );
  });

  test('trims unbalanced closing paren', () => {
    expect(trimUrlTail('https://foo.com/path)')).toBe('https://foo.com/path');
  });

  test('keeps closing bracket when balanced', () => {
    expect(trimUrlTail('https://foo.com/[a]')).toBe('https://foo.com/[a]');
  });

  test('trims unbalanced closing bracket', () => {
    expect(trimUrlTail('https://foo.com]')).toBe('https://foo.com');
  });

  test('trims stacked punctuation', () => {
    expect(trimUrlTail('https://foo.com).')).toBe('https://foo.com');
  });

  test('leaves URL alone when no trailing punctuation', () => {
    expect(trimUrlTail('https://foo.com/path')).toBe('https://foo.com/path');
  });
});

describe('InlineMarkdown angle autolinks', () => {
  test('keeps xref contents literal', () => {
    const html = renderInline('For more information, see the <xref:path_to_api`22?hello> class.');

    expect(html).toContain('<span>&lt;xref:path_to_api`22?hello&gt;</span>');
    expect(html).not.toContain('<code');
    expect(html).not.toContain('<em');
  });

  test('keeps URL and email autolinks clickable', () => {
    const html = renderInline('Visit <https://www.example.com> or <user@example.com>.');

    expect(html).toContain('href="https://www.example.com"');
    expect(html).toContain('href="mailto:user@example.com"');
  });

  test('keeps comparison text as plain prose', () => {
    const html = renderInline('Math: x < y > z.');

    expect(html).toBe('Math: x &lt; y &gt; z.');
  });

  test('keeps other scheme autolinks literal', () => {
    const html = renderInline('Open <file://path/to/file> or <custom:value_with-dash.ext>.');

    expect(html).toContain('<span>&lt;file://path/to/file&gt;</span>');
    expect(html).toContain('<span>&lt;custom:value_with-dash.ext&gt;</span>');
  });

  test('does not consume incomplete angle autolinks', () => {
    const html = renderInline('Broken <xref:path_to_api`22?hello is plain.');

    expect(html).toBe('Broken &lt;xref:path_to_api`22?hello is plain.');
  });

  test('preserves incomplete angle autolink prose', () => {
    const html = renderInline('Try <custom:scheme!');

    expect(html).toBe('Try &lt;custom:scheme!');
  });

  test('treats angle-bracket comparisons as prose', () => {
    const html = renderInline('Use a < b > c < d > e.');

    expect(html).toBe('Use a &lt; b &gt; c &lt; d &gt; e.');
  });

  test('renders adjacent angle autolinks correctly', () => {
    const html = renderInline('See <https://a.com> then <https://b.com>.');

    expect(html).toContain('href="https://a.com"');
    expect(html).toContain('href="https://b.com"');
  });
});

// The hrefs of every <a> in the rendered HTML, in order.
function linkHrefs(html: string): string[] {
  return [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}

describe('bare URL autolinks keep underscores (Workspaces ids: ws_, doc_, prj_)', () => {
  // A bare URL after other text used to be cut at the first `_` (or `~`,
  // `#`, `@`, `$`, `!`), because those end a plain-text chunk.
  test('a URL after text is one link through its underscores', () => {
    const url = 'http://localhost:3011/w/ws_01M5JCNXKERX0XDNABX0S8K9D0/docs/plan.md';
    const html = renderInline(`Open ${url} now.`);
    expect(linkHrefs(html)).toEqual([url]);
    expect(html).toContain(`>${url}</a> now.`);
  });

  test('two underscore runs, ~, %, query and fragment stay in the link; the comma does not', () => {
    const url = 'https://a.com/ws_x/doc_y/~me?q=a_b&r=c%20d#frag_1';
    const html = renderInline(`see ${url}, then`);
    expect(linkHrefs(html)).toEqual([url]);
    expect(html).toContain('</a>, then');
  });

  test('two URLs on one line are two whole links', () => {
    const html = renderInline('two: https://a.com/a_b and https://b.com/c_d.');
    expect(linkHrefs(html)).toEqual(['https://a.com/a_b', 'https://b.com/c_d']);
    expect(html).toContain('</a>.');
  });

  test('an unbalanced closing paren stays outside', () => {
    const html = renderInline('(see https://a.com/x_y)');
    expect(linkHrefs(html)).toEqual(['https://a.com/x_y']);
    expect(html).toContain('</a>)');
  });

  test('a trailing ! stays outside the link', () => {
    const html = renderInline('see https://a.com/a_b!');
    expect(linkHrefs(html)).toEqual(['https://a.com/a_b']);
    expect(html).toContain('</a>!');
  });

  test('$ inside a URL stays in it', () => {
    expect(linkHrefs(renderInline('pay https://a.com/x$y_z ok'))).toEqual(['https://a.com/x$y_z']);
  });

  // Guards the one-pass path: a URL that ends inside its plain-text chunk
  // must not get a loop turn of its own (each turn rescans the rest of the
  // text). 32,000 URLs render in about 0.1 s in one pass and several seconds
  // with a turn per URL, so the budget is far from both.
  test('a paragraph of many plain URLs renders in one pass', () => {
    const n = 32_000;
    const text = Array.from({ length: n }, (_, i) => `https://a.com/p${i}`).join(' ');
    const started = performance.now();
    const html = renderInline(text);
    const elapsed = performance.now() - started;
    expect(html.split('<a ').length - 1).toBe(n);
    expect(elapsed).toBeLessThan(2_000);
  });

  test('@ and # inside a URL stay in it', () => {
    expect(linkHrefs(renderInline('at https://a.com/@user_1#top'))).toEqual(['https://a.com/@user_1#top']);
  });

  test('a URL inside underscore emphasis is linked whole inside the emphasis', () => {
    const html = renderInline('an _italic https://a.com/x_y_ phrase');
    expect(linkHrefs(html)).toEqual(['https://a.com/x_y']);
    expect(html).toContain('<em>italic <a ');
    expect(html).toContain('</a></em> phrase');
  });

  test('a URL in inline code stays code', () => {
    const html = renderInline('code `https://a.com/x_y` here');
    expect(linkHrefs(html)).toEqual([]);
    expect(html).toContain('<code');
  });

  test('snake_case and _word_ outside URLs are unchanged', () => {
    expect(renderInline('snake_case and _word_ stay')).toBe('snake_case and <em>word</em> stay');
  });

  test('a scheme glued to a word is not linked', () => {
    expect(linkHrefs(renderInline('foohttps://a.com/x_y'))).toEqual([]);
  });
});

describe('InlineMarkdown math', () => {
  // KaTeX reaches InlineMath through the renderer slot now (utils/math.ts);
  // Plannotator's apps fill it by importing utils/math-eager. Register it
  // here explicitly so these assertions do not depend on which test file ran
  // first in bun's shared process, and restore whatever was there after.
  const saved = getMathRenderer();
  const savedSource = getMathRendererSource();
  beforeEach(() => setMathRenderer(katex));
  afterEach(() => {
    resetMathRenderer();
    if (saved) setMathRenderer(saved, savedSource ?? 'host');
  });

  test('renders the TeX as text in the same wrapper while no renderer is registered', () => {
    resetMathRenderer();
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Area is $A=\\pi r^2$.' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('math-inline');
    expect(html).toContain('data-math-tex="A=\\pi r^2"');
    expect(html).toContain('>A=\\pi r^2</span>');
  });

  test('renders inline math with KaTeX markup', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Area is $A=\\pi r^2$.' }));
    expect(html).toContain('katex');
    expect(html).toContain('math-inline');
    expect(html).toContain('mord mathnormal');
  });

  test('does not render escaped dollar-delimited text as math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Price is \\$5$ today' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$5$ today');
  });

  test('does not treat spaced dollar text as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Keep $ not math $ here' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$ not math $ here');
  });

  test('renders spaced dollar-delimited TeX as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: '$ \\varepsilon \\sim \\mathcal{N}(0,\\sigma^2) $' }));
    expect(html).toContain('katex');
    expect(html).toContain('math-inline');
    expect(html).toContain('data-math-tex="\\varepsilon \\sim \\mathcal{N}(0,\\sigma^2)"');
  });

  test('renders spaced single-variable dollar math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Target is $ y $.' }));
    expect(html).toContain('katex');
    expect(html).toContain('data-math-tex="y"');
  });

  test('does not treat spaced numeric dollar text as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Price is $ 5 $ today' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$ 5 $ today');
  });

  test('renders parenthesized inline math with KaTeX markup', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Area is \\(A=\\pi r^2\\).' }));
    expect(html).toContain('katex');
    expect(html).toContain('math-inline');
    expect(html).toContain('mord mathnormal');
  });

  test('leaves double-dollar text to the block parser', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: '$$x$$' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$$x$$');
  });

  test('does not render a dollar-amount range as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'This costs $5-$10 depending on tier.' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$5-$10 depending on tier.');
  });

  test('does not render comma-separated dollar amounts as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Budget: $50,000-$100,000 this year.' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$50,000-$100,000 this year.');
  });

  test('does not render per-unit dollar prices spanning prose as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Tier A is $5/mo and tier B is $10/mo.' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$5/mo and tier B is $10/mo.');
  });

  test('still renders a leading-digit formula not abutting a later amount', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Coefficient $2x + 1$ grows.' }));
    expect(html).toContain('katex');
    expect(html).toContain('data-math-tex="2x + 1"');
  });
});

describe('issue and mention refs (#1596)', () => {
  const render = (repoHost?: string) =>
    renderToStaticMarkup(
      createElement(InlineMarkdown, { text: 'Fixes #123, thanks @alice', githubRepo: 'group/sub/project', repoHost }),
    );

  test('GitLab host links to its own issues and users', () => {
    const html = render('gitlab.com');
    expect(html).toContain('href="https://gitlab.com/group/sub/project/-/issues/123"');
    expect(html).toContain('href="https://gitlab.com/alice"');
    expect(html).not.toContain('github.com');
  });

  test('unrecognized host renders the refs as unlinked spans', () => {
    const html = render('git.internal.example');
    expect(html).not.toContain('<a');
    expect(html).toContain('#123</span>');
    expect(html).toContain('@alice</span>');
  });
});

describe('digit-only #refs vs hex swatches (#1932)', () => {
  const render = (text: string, githubRepo?: string, repoHost?: string) =>
    renderToStaticMarkup(createElement(InlineMarkdown, { text, githubRepo, repoHost }));
  const isSwatch = (html: string) => html.includes('background-color');
  // Another test file may have loaded the Inbox app (which turns the flag on) earlier in this process.
  beforeEach(resetDigitHexIssueRefs);
  afterEach(resetDigitHexIssueRefs);

  test('flag off (every host but the Inbox): a digit-only value stays a swatch even with a repo', () => {
    const html = render('Fixes #186379.', 'home-assistant/core');
    expect(isSwatch(html)).toBe(true);
    expect(html).not.toContain('/issues/');
  });

  test('flag on, with a GitHub repo: 6- and 8-digit refs link as issues', () => {
    setDigitHexIssueRefs(true);
    for (const num of ['186379', '12345678']) {
      const html = render(`Fixes #${num}.`, 'home-assistant/core');
      expect(html).toContain(`href="https://github.com/home-assistant/core/issues/${num}"`);
      expect(isSwatch(html)).toBe(false);
    }
  });

  test('flag on, but no ref link can be built: stays a swatch', () => {
    setDigitHexIssueRefs(true);
    expect(isSwatch(render('#186379'))).toBe(true);
    expect(isSwatch(render('#186379', 'my-folder'))).toBe(true);
    expect(isSwatch(render('#186379', 'group/project', 'git.internal.example'))).toBe(true);
  });

  test('flag on, with a repo: hex with a letter, a leading zero, or no word boundary stays a swatch', () => {
    setDigitHexIssueRefs(true);
    for (const text of ['#a1b2c3', '#000000', '#003366ff', 'x#123456']) {
      const html = render(text, 'home-assistant/core');
      expect(isSwatch(html)).toBe(true);
      expect(html).not.toContain('/issues/');
    }
  });
});
