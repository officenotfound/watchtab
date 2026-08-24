/**
 * Generates a reasonably stable CSS selector for an element, for the
 * "Search in Custom Area" element picker. Prefers #id; otherwise walks a
 * short nth-of-type structural path up the ancestor chain.
 */
export function generateSelector(el: Element): string {
  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }

  const path: string[] = [];
  let node: Element | null = el;
  let depth = 0;

  while (node && node.nodeType === Node.ELEMENT_NODE && depth < 5) {
    if (node.id) {
      path.unshift(`#${CSS.escape(node.id)}`);
      break;
    }

    const current: Element = node;
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      path.unshift(tag);
      break;
    }

    const siblingsOfTag: Element[] = Array.from(parent.children).filter(
      (sibling) => sibling.tagName === current.tagName,
    );
    const segment =
      siblingsOfTag.length > 1
        ? `${tag}:nth-of-type(${siblingsOfTag.indexOf(current) + 1})`
        : tag;

    path.unshift(segment);
    node = parent;
    depth++;
  }

  return path.join(' > ');
}
