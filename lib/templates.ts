/**
 * Ready-made monitor expressions offered in the popup's Monitor section.
 * Clicking one appends its expression to the user's existing keywords input
 * (see lib/matcher.ts for the expression syntax these strings use).
 */
export interface ExpressionTemplate {
  id: string;
  label: string;
  expression: string;
}

export const EXPRESSION_TEMPLATES: ExpressionTemplate[] = [
  {
    id: 'availability',
    label: 'Product availability',
    expression: 'in stock, available',
  },
  {
    id: 'shopping-actions',
    label: 'Shopping actions',
    expression: 'add to cart, buy now',
  },
  {
    id: 'price-change',
    label: 'Price changes',
    expression: String.raw`$\d+\.\d{2}`,
  },
  {
    id: 'stock-and-price',
    label: 'Stock AND price',
    expression: '##(in stock OR available) AND (sale OR discount)##',
  },
];
