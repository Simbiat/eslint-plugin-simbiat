/**
 * @file Shared scope-tracking utilities for Custom Element ESLint rules.
 */

import { adaptNodeHandler, adaptStateHandler } from './Adapters.mjs';

// Types

/** Minimal shape of an ESLint/ESTree AST node as accessed by these utilities. */
interface ESLintNode {
  readonly type: string
  readonly kind?: string
  readonly parent?: ESLintNode
  readonly body?: { readonly body: readonly ESLintNode[] }
  readonly superClass?: ESLintNode | null
  readonly name?: string
  readonly value?: unknown
  readonly key?: ESLintNode
  readonly static?: boolean
}

/** Discriminated union of scope-stack entries. */
type ScopeEntry
  = {
  readonly kind: 'class'
  readonly isHTMLEl: boolean
  readonly fieldNames: Set<string>
} | {
  readonly kind: 'field'
  readonly fieldName: string
} | { readonly kind: 'constructor' } | { readonly kind: 'fn' };

/** State object shared across visitor callbacks for Custom Element scope rules. */
export interface ScopeState {
  readonly stack: ScopeEntry[]
  readonly base_classes: readonly string[]
}

// Field-name collection

/**
 * Returns a Set of every public property name explicitly declared as a
 * PropertyDefinition (class field) in the class body.
 *
 * Private fields are omitted: `this.#foo` produces a PrivateIdentifier node,
 * not an Identifier, so those assignments can never reach the checks that
 * consult this set.
 * @param class_node - ClassDeclaration or ClassExpression node.
 * @returns Set of declared field names.
 */
function collectClassFieldNames(class_node: ESLintNode): Set<string> {
  const names = new Set<string>();
  for (const member of class_node.body?.body ?? []) {
    if (member.type !== 'PropertyDefinition') {
      continue;
    }
    const { key } = member;
    if (!key) {
      continue;
    }
    if (key.type === 'Identifier' && typeof key.name === 'string') {
      names.add(key.name);
    } else if (key.type === 'Literal') {
      names.add(String(key.value));
    }
    // PrivateIdentifier (#foo) deliberately omitted – see note above.
  }
  return names;
}

// Scope predicates

/**
 * `True` when execution is directly inside either:
 * - the constructor body of an HTMLElement subclass, or
 * - an instance field initializer of an HTMLElement subclass,
 * AND there is no nested function or arrow function in between.
 *
 * Both 'constructor' and 'field' entries are only pushed when isHTMLEl is
 * true on the enclosing class, so we can check the top alone.
 * @param state - Current scope state.
 * @returns True when currently in an active Custom Element scope.
 */
export function isActiveScope(state: ScopeState): boolean {
  const top = state.stack[state.stack.length - 1];
  return top?.kind === 'constructor' || top?.kind === 'field';
}

/**
 * Returns a human-readable phrase describing the currently active scope,
 * for use as the `{{location}}` template variable in rule messages.
 *
 * Examples:
 * "the constructor"
 * "the field initializer for 'myField'"
 * "the field initializer for '#privateField'".
 *
 * Falls back to "the constructor" if called outside an active scope.
 * @param state - Current scope state.
 * @returns Human-readable scope location string.
 */
export function getActiveScopeLocation(state: ScopeState): string {
  const top = state.stack[state.stack.length - 1];
  if (top?.kind === 'field') {
    return `the field initializer for '${top.fieldName}'`;
  }
  return 'the constructor';
}

/**
 * Returns the `fieldNames` set of the innermost enclosing class on the stack,
 * or an empty Set when called outside any class body.
 *
 * Use this inside an `isActiveScope` guard to check whether the developer
 * explicitly declared a given property name as a class field.
 * @param state - Current scope state.
 * @returns Set of class field names from the nearest enclosing class.
 */
export function getClassFieldNames(state: ScopeState): Set<string> {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    // eslint-disable-next-line security/detect-object-injection
    const entry = state.stack[i];
    if (entry?.kind === 'class') {
      return entry.fieldNames;
    }
  }
  return new Set<string>();
}

// Visitor handlers

/**
 * Pushes a 'class' scope entry when entering a class declaration or expression.
 * @param state - Current scope state.
 * @param node - Class declaration or expression node (as unknown from ESLint).
 */
function onClassEnter(state: ScopeState, node: unknown): void {
  const class_node = node as ESLintNode;
  const super_class = class_node.superClass;
  const is_html_el = super_class?.type === 'Identifier' && typeof super_class.name === 'string' && state.base_classes.includes(super_class.name);
  state.stack.push({
    kind: 'class',
    isHTMLEl: is_html_el,
    fieldNames: collectClassFieldNames(class_node),
  });
}

/**
 * Pops the 'class' scope entry when leaving a class.
 * @param state - Current scope state.
 */
function onClassExit(state: ScopeState): void {
  state.stack.pop();
}

/**
 * Pushes a 'field' scope entry when entering a non-static instance field
 * initializer that belongs directly to an HTMLElement subclass.
 *
 * Conditions:
 * - The PropertyDefinition must not be static.
 * - It must have an initializer (value !== null) — without one there is nothing to analyze.
 * - The direct parent class entry on the stack must have isHTMLEl === true.
 * @param state - Current scope state.
 * @param node - PropertyDefinition node (as unknown from ESLint).
 */
function onPropertyDefinitionEnter(state: ScopeState, node: unknown): void {
  const prop = node as ESLintNode;
  if (prop.static === true || prop.value === null) {
    return;
  }
  const top = state.stack[state.stack.length - 1];
  if (top?.kind !== 'class' || !top.isHTMLEl) {
    return;
  }

  // Determine a readable field name for messages.
  let field_name: string;
  const { key } = prop;
  if (!key) {
    return;
  }
  if (key.type === 'Identifier') {
    field_name = typeof key.name === 'string' ? key.name : '(computed)';
  } else if (key.type === 'PrivateIdentifier') {
    field_name = typeof key.name === 'string' ? `#${key.name}` : '#(unknown)';
  } else if (key.type === 'Literal') {
    field_name = String(key.value);
  } else {
    field_name = '(computed)';
  }

  state.stack.push({
    kind: 'field',
    fieldName: field_name,
  });
}

/**
 * Pops the 'field' scope entry when leaving a property definition.
 * @param state - Current scope state.
 * @param node - PropertyDefinition node (as unknown from ESLint).
 */
function onPropertyDefinitionExit(state: ScopeState, node: unknown): void {
  const prop = node as ESLintNode;
  if (prop.static === true || prop.value === null) {
    return;
  }
  if (state.stack[state.stack.length - 1]?.kind === 'field') {
    state.stack.pop();
  }
}

/**
 * FunctionExpression covers both regular methods and the constructor body.
 * - constructor body → push 'constructor'
 * - any other fn inside constructor or field initializer → push 'fn'.
 * @param state - Current scope state.
 * @param node - FunctionExpression node (as unknown from ESLint).
 */
function onFunctionEnter(state: ScopeState, node: unknown): void {
  const fn = node as ESLintNode;
  const is_constructor_body
    = fn.parent?.type === 'MethodDefinition' && fn.parent.kind === 'constructor';

  if (is_constructor_body) {
    const top_class = [...state.stack].reverse()
                                      .find((e) => {
                                        return e.kind === 'class';
                                      });
    if (top_class?.kind === 'class' && top_class.isHTMLEl) {
      state.stack.push({ kind: 'constructor' });
    }
  } else if (state.stack.some((e) => {
    return e.kind === 'constructor' || e.kind === 'field';
  })) {
    // Nested regular function inside constructor or field initializer.
    // `this` is rebound, so all CE checks inside it must be suppressed.
    state.stack.push({ kind: 'fn' });
  }
}

/**
 * Pops the scope entry pushed by `onFunctionEnter` when leaving a function.
 * @param state - Current scope state.
 * @param node - FunctionExpression node (as unknown from ESLint).
 */
function onFunctionExit(state: ScopeState, node: unknown): void {
  const fn = node as ESLintNode;
  const top = state.stack[state.stack.length - 1];
  const is_constructor_body
    = fn.parent?.type === 'MethodDefinition' && fn.parent.kind === 'constructor';
  if (
    (is_constructor_body && top?.kind === 'constructor')
    || (!is_constructor_body && top?.kind === 'fn')
  ) {
    state.stack.pop();
  }
}

/**
 * Arrow functions inherit `this` lexically, so they can still access the
 * element — but their body is deferred (callback), so checks must be
 * suppressed. Push 'fn' whenever we're inside a constructor or field init.
 * @param state - Current scope state.
 */
function onArrowEnter(state: ScopeState): void {
  if (state.stack.some((e) => {
    return e.kind === 'constructor' || e.kind === 'field';
  })) {
    state.stack.push({ kind: 'fn' });
  }
}

/**
 * Pops the 'fn' scope entry pushed by `onArrowEnter`.
 * @param state - Current scope state.
 */
function onArrowExit(state: ScopeState): void {
  if (state.stack[state.stack.length - 1]?.kind === 'fn') {
    state.stack.pop();
  }
}

// Visitor builder

/**
 * Returns the ESLint visitor entries that maintain the scope stack.
 * Spread these into your `create()` return value alongside rule-specific
 * visitors.
 * @param state - Scope state with stack and base_classes.
 * @returns Record of ESLint visitor callbacks for scope tracking.
 */
export function buildScopeVisitors(state: ScopeState): Record<string, (node: unknown) => void> {
  return {
    'ClassDeclaration': adaptNodeHandler(state, onClassEnter),
    'ClassExpression': adaptNodeHandler(state, onClassEnter),
    'ClassDeclaration:exit': adaptStateHandler(state, onClassExit),
    'ClassExpression:exit': adaptStateHandler(state, onClassExit),
    'PropertyDefinition': adaptNodeHandler(state, onPropertyDefinitionEnter),
    'PropertyDefinition:exit': adaptNodeHandler(state, onPropertyDefinitionExit),
    'FunctionExpression': adaptNodeHandler(state, onFunctionEnter),
    'FunctionExpression:exit': adaptNodeHandler(state, onFunctionExit),
    'ArrowFunctionExpression': adaptStateHandler(state, onArrowEnter),
    'ArrowFunctionExpression:exit': adaptStateHandler(state, onArrowExit),
  };
}

// Shared option schema

/** JSON-Schema fragment accepted by all CE constructor/lifecycle rules. */
export const baseClassesSchema = [
  {
    type: 'object',
    properties: {
      baseClasses: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
      },
    },
    additionalProperties: false,
  },
];
