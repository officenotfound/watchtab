/**
 * Expression parsing and matching engine for the page-monitor feature.
 *
 * Supports four expression syntaxes, entered comma-separated in one input:
 *   - plain keyword            case-insensitive substring match
 *   - ##...##  boolean         AND / OR / | with nested parentheses
 *   - @@xpath                  document.evaluate() against the scoped root
 *   - $pattern or $pattern/flags   regex, case-insensitive by default
 */

export type ExpressionKind = 'keyword' | 'boolean' | 'xpath' | 'regex';

export interface ExpressionResult {
  expr: string;
  kind: ExpressionKind;
  matched: boolean;
  error?: string;
  /** Literal substrings that matched, for DOM highlighting. Only populated for keyword/regex. */
  highlightTerms: string[];
}

/**
 * Splits a comma-separated expression list at the top level only, ignoring
 * commas nested inside parentheses (boolean expressions) or regex character
 * classes ([...]).
 */
export function parseTopLevelExpressions(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let bracketDepth = 0;
  let current = '';

  for (const ch of raw) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);

    if (ch === ',' && depth === 0 && bracketDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export function classifyExpression(expr: string): ExpressionKind {
  if (expr.startsWith('##')) return 'boolean';
  if (expr.startsWith('@@')) return 'xpath';
  if (expr.startsWith('$')) return 'regex';
  return 'keyword';
}

function evaluateKeyword(expr: string, text: string): ExpressionResult {
  const matched = text.toLowerCase().includes(expr.toLowerCase());
  return { expr, kind: 'keyword', matched, highlightTerms: matched ? [expr] : [] };
}

/** Parses `$pattern` or `$pattern/flags`, defaulting to the `i` flag when none is given. */
function parseRegexExpr(expr: string): { pattern: string; flags: string } {
  const body = expr.slice(1);
  const lastSlash = body.lastIndexOf('/');
  if (lastSlash > 0) {
    const candidateFlags = body.slice(lastSlash + 1);
    if (/^[gimsuy]*$/.test(candidateFlags)) {
      return { pattern: body.slice(0, lastSlash), flags: candidateFlags };
    }
  }
  return { pattern: body, flags: 'i' };
}

function evaluateRegex(expr: string, text: string): ExpressionResult {
  const { pattern, flags } = parseRegexExpr(expr);
  try {
    const re = new RegExp(pattern, flags);
    const match = text.match(re);
    return {
      expr,
      kind: 'regex',
      matched: match !== null,
      highlightTerms: match ? [match[0]] : [],
    };
  } catch {
    return {
      expr,
      kind: 'regex',
      matched: false,
      error: `Invalid regex: ${expr}`,
      highlightTerms: [],
    };
  }
}

function evaluateXPath(expr: string, root: Node): ExpressionResult {
  const xpath = expr.slice(2);
  try {
    const doc = root.ownerDocument ?? (root as Document);
    const result = doc.evaluate(xpath, root, null, XPathResult.ANY_TYPE, null);
    let matched: boolean;
    switch (result.resultType) {
      case XPathResult.BOOLEAN_TYPE:
        matched = result.booleanValue;
        break;
      case XPathResult.NUMBER_TYPE:
        matched = result.numberValue !== 0 && !Number.isNaN(result.numberValue);
        break;
      case XPathResult.STRING_TYPE:
        matched = result.stringValue.length > 0;
        break;
      default:
        matched = result.iterateNext() !== null;
    }
    return { expr, kind: 'xpath', matched, highlightTerms: [] };
  } catch {
    return {
      expr,
      kind: 'xpath',
      matched: false,
      error: `Invalid XPath: ${expr}`,
      highlightTerms: [],
    };
  }
}

type BoolToken = '(' | ')' | 'AND' | 'OR' | { term: string };

function tokenizeBoolean(body: string): BoolToken[] {
  const raw = body.split(/(\(|\)|\bAND\b|\bOR\b|\|)/i);
  const tokens: BoolToken[] = [];
  for (const piece of raw) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (trimmed === '(' || trimmed === ')') {
      tokens.push(trimmed);
    } else if (/^AND$/i.test(trimmed)) {
      tokens.push('AND');
    } else if (/^OR$/i.test(trimmed) || trimmed === '|') {
      tokens.push('OR');
    } else {
      tokens.push({ term: trimmed });
    }
  }
  return tokens;
}

type BoolNode = { type: 'AND' | 'OR'; children: BoolNode[] } | { type: 'TERM'; value: string };

interface Cursor {
  i: number;
}

function parsePrimary(tokens: BoolToken[], cur: Cursor): BoolNode {
  const tok = tokens[cur.i];
  if (tok === '(') {
    cur.i++;
    const node = parseOr(tokens, cur);
    if (tokens[cur.i] === ')') cur.i++;
    return node;
  }
  if (tok && typeof tok === 'object') {
    cur.i++;
    return { type: 'TERM', value: tok.term };
  }
  // Stray operator/paren with no term: treat as an empty, never-matching term.
  cur.i++;
  return { type: 'TERM', value: '' };
}

function parseAnd(tokens: BoolToken[], cur: Cursor): BoolNode {
  let left = parsePrimary(tokens, cur);
  while (tokens[cur.i] === 'AND') {
    cur.i++;
    const right = parsePrimary(tokens, cur);
    left = { type: 'AND', children: [left, right] };
  }
  return left;
}

function parseOr(tokens: BoolToken[], cur: Cursor): BoolNode {
  let left = parseAnd(tokens, cur);
  while (tokens[cur.i] === 'OR') {
    cur.i++;
    const right = parseAnd(tokens, cur);
    left = { type: 'OR', children: [left, right] };
  }
  return left;
}

function evaluateNode(node: BoolNode, text: string): boolean {
  if (node.type === 'TERM') {
    return node.value.length > 0 && text.toLowerCase().includes(node.value.toLowerCase());
  }
  if (node.type === 'AND') return node.children.every((c) => evaluateNode(c, text));
  return node.children.some((c) => evaluateNode(c, text));
}

function evaluateBoolean(expr: string, text: string): ExpressionResult {
  let body = expr.startsWith('##') ? expr.slice(2) : expr;
  if (body.endsWith('##')) body = body.slice(0, -2);
  body = body.trim();

  if (!body) {
    return { expr, kind: 'boolean', matched: false, error: 'Empty boolean expression', highlightTerms: [] };
  }

  try {
    const tokens = tokenizeBoolean(body);
    const cur: Cursor = { i: 0 };
    const ast = parseOr(tokens, cur);
    const matched = evaluateNode(ast, text);
    return { expr, kind: 'boolean', matched, highlightTerms: [] };
  } catch {
    return {
      expr,
      kind: 'boolean',
      matched: false,
      error: `Invalid boolean expression: ${expr}`,
      highlightTerms: [],
    };
  }
}

/**
 * Evaluates a single expression. `text` is the extracted visual/source
 * content used by keyword/regex/boolean matching; `root` is the scoped DOM
 * node used by XPath matching (structural, independent of extraction mode).
 */
export function evaluateExpression(expr: string, text: string, root: Node): ExpressionResult {
  const kind = classifyExpression(expr);
  switch (kind) {
    case 'keyword':
      return evaluateKeyword(expr, text);
    case 'regex':
      return evaluateRegex(expr, text);
    case 'boolean':
      return evaluateBoolean(expr, text);
    case 'xpath':
      return evaluateXPath(expr, root);
  }
}

export function evaluateAllExpressions(raw: string, text: string, root: Node): ExpressionResult[] {
  return parseTopLevelExpressions(raw).map((expr) => evaluateExpression(expr, text, root));
}

/** Cheap djb2 string hash, used to detect any-change diffs without storing full snapshots. */
export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36) + ':' + input.length.toString(36);
}
