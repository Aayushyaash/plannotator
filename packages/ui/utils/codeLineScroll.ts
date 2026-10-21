/**
 * Find a rendered code line in a file area drawn by Pierre's `File`, and wait
 * for it when it is not there yet. Pierre draws the lines inside the shadow
 * root of a `diffs-container` it attaches in the element's constructor, and
 * may draw them some time after mount (a worker highlight, a large file), so a
 * fixed delay can fire before the line exists.
 */

function lineSelector(line: number): string {
  return `[data-line="${line}"]`;
}

/** The element of code line `line` under `root`, in its own DOM or a Pierre shadow root. */
export function findCodeLineElement(root: ParentNode, line: number): HTMLElement | null {
  const selector = lineSelector(line);
  const direct = root.querySelector<HTMLElement>(selector);
  if (direct) return direct;
  for (const container of root.querySelectorAll('diffs-container')) {
    const inShadow = container.shadowRoot?.querySelector<HTMLElement>(selector);
    if (inShadow) return inShadow;
  }
  return null;
}

/**
 * Call `onFound` once with code line `line` under `root`, in the frame after it
 * exists (so it has been laid out). Watches `root` and every Pierre shadow root
 * that appears under it until the line shows up. Returns a function that stops
 * watching; call it on unmount or when the line or file changes.
 */
export function whenCodeLineRendered(
  root: HTMLElement,
  line: number,
  onFound: (element: HTMLElement) => void,
): () => void {
  let stopped = false;
  let frame: number | null = null;
  const observers: MutationObserver[] = [];
  const watched = new Set<Node>();

  const stopWatching = () => {
    for (const observer of observers) observer.disconnect();
    observers.length = 0;
    watched.clear();
  };

  const watch = (node: Node) => {
    if (watched.has(node)) return;
    watched.add(node);
    const observer = new MutationObserver(check);
    observer.observe(node, { childList: true, subtree: true });
    observers.push(observer);
  };

  function check() {
    if (stopped || frame != null) return;
    if (findCodeLineElement(root, line)) {
      stopWatching();
      frame = requestAnimationFrame(() => {
        frame = null;
        if (stopped) return;
        // Look it up again: a highlight pass may have replaced the element.
        const element = findCodeLineElement(root, line);
        if (element) {
          stopped = true;
          onFound(element);
          return;
        }
        watch(root);
        check();
      });
      return;
    }
    for (const container of root.querySelectorAll('diffs-container')) {
      if (container.shadowRoot) watch(container.shadowRoot);
    }
  }

  watch(root);
  check();

  return () => {
    stopped = true;
    stopWatching();
    if (frame != null) cancelAnimationFrame(frame);
  };
}
