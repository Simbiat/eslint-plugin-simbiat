/**
 * @file AST helper utilities for the prefer-field-initializer and related rules.
 */

// Types

/** Minimal shape of an ESLint/ESTree AST node as accessed by these utilities. */
interface ESLintNode {
  readonly type: string
  readonly body?: { readonly body: readonly ESLintNode[] }
  readonly key?: ESLintNode
  readonly name?: string
  readonly value?: unknown
  readonly left?: ESLintNode
  readonly argument?: ESLintNode | null
  readonly properties?: readonly ESLintNode[]
  readonly elements?: ReadonlyArray<ESLintNode | null>
  readonly parameter?: ESLintNode
  readonly id?: ESLintNode
  readonly computed?: boolean
  readonly object?: ESLintNode
  readonly property?: ESLintNode

  readonly [key: string]: unknown
}

// Field / parameter name collection

/**
 * Collects all declared field names (PropertyDefinition keys) from a class
 * node's body into a `Set<string>`.
 * @param class_node - ClassDeclaration or ClassExpression node.
 * @returns Set of declared field name strings.
 */
export function collectFieldNames(class_node: unknown): Set<string> {
  const node = class_node as ESLintNode;
  const names = new Set<string>();
  for (const member of node.body?.body ?? []) {
    if (member.type !== 'PropertyDefinition') {
      continue;
    }
    const key = member.key;
    let name: string | null;
    if (key?.type === 'Identifier' && typeof key.name === 'string') {
      name = key.name;
    } else if (key?.type === 'Literal') {
      name = String(key.value);
    } else {
      name = null;
    }
    if (name !== null) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Recursively collects all binding names introduced by a parameter or
 * destructuring pattern node into `out`.
 * Handles: Identifier, AssignmentPattern, RestElement, ObjectPattern,
 * ArrayPattern, and TypeScript's TSParameterProperty.
 * @param param - Parameter or pattern node to collect names from.
 * @param out - Set to accumulate discovered binding names into.
 */
export function collectParamNames(param: unknown, out: Set<string>): void {
  if (param === null || typeof param === 'undefined' || typeof param !== 'object') {
    return;
  }
  const p = param as ESLintNode;
  switch (p.type) {
    case 'Identifier':
      if (typeof p.name === 'string') {
        out.add(p.name);
      }
      break;
    case 'AssignmentPattern':
      collectParamNames(p.left, out);
      break;
    case 'RestElement':
      collectParamNames(p.argument, out);
      break;
    case 'ObjectPattern':
      for (const prop of p.properties ?? []) {
        collectParamNames(prop.type === 'RestElement' ? prop : prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of p.elements ?? []) {
        collectParamNames(el, out); // el may be null for holes
      }
      break;
    case 'TSParameterProperty':
      // TypeScript: constructor(private foo: string) – foo is both param and field.
      collectParamNames(p.parameter, out);
      break;
    default:
      break;
  }
}

// AST traversal predicates

/** Keys that should never be traversed as child AST nodes. */
const SKIP_KEYS = new Set(['type', 'parent', 'loc', 'range', 'start', 'end']);

/**
 * Recursively walks an AST node, collecting variable declarator binding names into `out`,
 * without descending into nested function boundaries.
 * @param node - AST node to walk.
 * @param out - Set to accumulate discovered local variable names into.
 */
function walkNode(node: unknown, out: Set<string>): void {
  if (node === null || typeof node === 'undefined' || typeof node !== 'object') {
    return;
  }
  const n = node as ESLintNode;
  // Stop at nested-function boundaries – their locals are a different scope.
  if (
    n.type === 'FunctionExpression'
    || n.type === 'FunctionDeclaration'
    || n.type === 'ArrowFunctionExpression'
  ) {
    return;
  }
  if (n.type === 'VariableDeclarator') {
    // id may be Identifier, ObjectPattern, ArrayPattern, etc.
    collectParamNames(n.id, out);
    // Don't walk the init expression – we only care about declared names.
    return;
  }
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    // eslint-disable-next-line security/detect-object-injection
    const val: unknown = n[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        walkNode(child, out);
      }
    } else if (val !== null && typeof val === 'object' && typeof (val as ESLintNode).type === 'string') {
      walkNode(val, out);
    }
  }
}

/**
 * Pre-scans a constructor body (BlockStatement) and collects the binding
 * names of every VariableDeclarator into `out`, without descending into
 * nested FunctionExpression / FunctionDeclaration / ArrowFunctionExpression
 * nodes (those have their own scope and are irrelevant here).
 *
 * This is called once at constructor-entry time so that later
 * `this.x = rhs` checks can suppress false positives when `rhs` references
 * a locally declared variable rather than a constructor parameter.
 * @param body_node - BlockStatement (the constructor body).
 * @param out - Set to accumulate discovered local names into.
 */
export function collectLocalNames(body_node: unknown, out: Set<string>): void {
  walkNode(body_node, out);
}

/**
 * Returns true if `node` (or any descendant) is a MemberExpression whose
 * object is a ThisExpression, e.g. `this.foo`.
 *
 * Does NOT recurse into regular FunctionExpression / FunctionDeclaration
 * because `this` is rebound there. DOES recurse into ArrowFunctionExpression
 * because arrow functions inherit `this` lexically.
 * @param node - AST node to inspect.
 * @returns True if the node or a descendant accesses `this`.
 */
export function containsThisAccess(node: unknown): boolean {
  if (node === null || typeof node === 'undefined' || typeof node !== 'object') {
    return false;
  }
  const n = node as ESLintNode;
  // `this` is rebound in regular functions – stop recursing.
  if (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') {
    return false;
  }
  if (
    n.type === 'MemberExpression'
    && n.object?.type === 'ThisExpression'
  ) {
    return true;
  }
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    // eslint-disable-next-line security/detect-object-injection
    const val: unknown = n[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (containsThisAccess(child)) {
          return true;
        }
      }
    } else if (
      val !== null
      && typeof val === 'object'
      && typeof (val as ESLintNode).type === 'string'
      && containsThisAccess(val)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if `node` (or any descendant) contains an Identifier whose
 * name is in `names`.
 *
 * Same `this`-rebinding rules as `containsThisAccess`.
 * Stops at non-computed property keys in MemberExpression and Property to
 * avoid false positives on `{ foo: bar }` or `obj.foo` where `foo` is in names.
 * @param node - AST node to inspect.
 * @param names - Set of identifier names to search for.
 * @returns True if the node or a descendant references one of the given names.
 */
export function containsIdentifierRef(node: unknown, names: Set<string>): boolean {
  if (names.size === 0) {
    return false;
  }
  if (node === null || typeof node === 'undefined' || typeof node !== 'object') {
    return false;
  }
  const n = node as ESLintNode;
  if (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') {
    return false;
  }
  if (n.type === 'Identifier') {
    return typeof n.name === 'string' && names.has(n.name);
  }
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    // Skip non-computed property keys to avoid treating `{ paramName: val }`
    // or `obj.paramName` as a reference to the parameter.
    if (
      (n.type === 'Property' && key === 'key' && n.computed !== true)
      || (n.type === 'MemberExpression' && key === 'property' && n.computed !== true)
    ) {
      continue;
    }
    // eslint-disable-next-line security/detect-object-injection
    const val: unknown = n[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (containsIdentifierRef(child, names)) {
          return true;
        }
      }
    } else if (
      val !== null
      && typeof val === 'object'
      && typeof (val as ESLintNode).type === 'string'
      && containsIdentifierRef(val, names)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Human-readable stringification of a known external-target node.
 * @param node - AST node representing the target.
 * @param text - Fallback text when the target cannot be stringified.
 * @returns Human-readable name for the target node.
 */
export function targetName(node: unknown, text = 'external target'): string {
  const n = node as ESLintNode;
  if (n.type === 'Identifier') {
    return typeof n.name === 'string' ? n.name : text;
  }
  if (n.type === 'MemberExpression' && n.computed !== true) {
    const obj = n.object?.type === 'Identifier' && typeof (n.object).name === 'string'
      ? String((n.object).name)
      : '…';
    const prop = n.property?.type === 'Identifier' && typeof (n.property).name === 'string'
      ? String((n.property).name)
      : '…';
    return `${obj}.${prop}`;
  }
  return text;
}

/**
 * Returns true for nodes that represent a "global" event-listener target:
 * `document`, `window`, `document.body`, `document.documentElement`,
 * `document.head`.
 * @param node - AST node to test.
 * @returns True when the node is a known external event-listener target.
 */
export function isExternalTarget(node: unknown): boolean {
  const n = node as ESLintNode;
  if (n.type === 'Identifier') {
    return n.name === 'document' || n.name === 'window';
  }
  if (
    n.type === 'MemberExpression'
    && n.computed !== true
    && n.object?.type === 'Identifier'
    && (n.object).name === 'document'
    && n.property?.type === 'Identifier'
  ) {
    return ['body', 'documentElement', 'head'].includes(String((n.property).name));
  }
  return false;
}
