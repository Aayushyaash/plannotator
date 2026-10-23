/** Math in diagram labels is not drawn in the Guides webviews; this keeps KaTeX out of the bundle. */
const katex = {
  renderToString(): string {
    throw new Error("Math is not available in the Guides view.");
  },
  render(): void {
    throw new Error("Math is not available in the Guides view.");
  },
};
export default katex;
