// @ts-check

/**
 * Shared scope-tracking for custom-element constructor rules.
 *
 * Stack entry shapes:
 *   { kind: 'class', isHTMLEl: boolean }
 *   { kind: 'constructor' } ← constructor body of an HTMLElement subclass
 *   { kind: 'fn' } ← nested function / arrow inside constructor
 *
 * `isActiveScope(state)` returns true only when execution is directly inside
 * the constructor body (not wrapped in a nested function/arrow).
 */

import { adaptNodeHandler, adaptStateHandler } from './Adapters.js';

// Scope predicates

/**
 * True only when directly inside the constructor of an HTMLElement subclass,
 * with no nested function or arrow in between.
 *
 * @param {{ stack: Array<{kind: string, isHTMLEl?: boolean}> }} state
 * @returns {boolean}
 */
export function isActiveScope(state) {
  const top = state.stack[state.stack.length - 1];
  if (top?.kind !== 'constructor') {
    return false;
  }
  for (let i = state.stack.length - 2; i >= 0; i--) {
    if (state.stack[i].kind === 'class') {
      return /** @type {any} */ (state.stack[i]).isHTMLEl === true;
    }
  }
  return false;
}

// Visitor handlers

function onClassEnter(state, node) {
  const is_html_el =
    node.superClass !== null &&
    node.superClass.type === 'Identifier' &&
    state.base_classes.includes(node.superClass.name);
  state.stack.push({
    kind: 'class',
    isHTMLEl: is_html_el
  });
}

function onClassExit(state) {
  state.stack.pop();
}

/**
 * FunctionExpression covers both regular methods and the constructor body.
 * We push a 'constructor' marker when we enter the constructor of an
 * HTMLElement subclass, and `fn` marker for any other nested function.
 */
function onFunctionEnter(state, node) {
  const is_constructor_body =
    node.parent.type === 'MethodDefinition' &&
    node.parent.kind === 'constructor';

  if (is_constructor_body) {
    const top_class = [...state.stack]
      .reverse()
      .find((e) => e.kind === 'class');
    if (top_class?.isHTMLEl) {
      state.stack.push({ kind: 'constructor' });
    }
  } else if (state.stack.some((e) => e.kind === 'constructor')) {
    state.stack.push({ kind: 'fn' });
  }
}

function onFunctionExit(state, node) {
  const top = state.stack[state.stack.length - 1];
  const is_constructor_body =
    node.parent.type === 'MethodDefinition' &&
    node.parent.kind === 'constructor';

  if (
    (is_constructor_body && top?.kind === 'constructor') ||
    (!is_constructor_body && top?.kind === 'fn')
  ) {
    state.stack.pop();
  }
}

function onArrowEnter(state) {
  if (state.stack.some((e) => e.kind === 'constructor')) {
    state.stack.push({ kind: 'fn' });
  }
}

function onArrowExit(state) {
  if (state.stack[state.stack.length - 1]?.kind === 'fn') {
    state.stack.pop();
  }
}

// Visitor builder

/**
 * Returns the six ESLint visitor entries that maintain the scope stack.
 * Spread these into your `create()` return value alongside rule-specific
 * visitors.
 *
 * @param {{ stack: any[], base_classes: string[] }} state
 * @returns {Record<string, Function>}
 */
export function buildScopeVisitors(state) {
  return {
    'ClassDeclaration': adaptNodeHandler(state, onClassEnter),
    'ClassExpression': adaptNodeHandler(state, onClassEnter),
    'ClassDeclaration:exit': adaptStateHandler(state, onClassExit),
    'ClassExpression:exit': adaptStateHandler(state, onClassExit),
    'FunctionExpression': adaptNodeHandler(state, onFunctionEnter),
    'FunctionExpression:exit': adaptNodeHandler(state, onFunctionExit),
    'ArrowFunctionExpression': adaptStateHandler(state, onArrowEnter),
    'ArrowFunctionExpression:exit': adaptStateHandler(state, onArrowExit),
  };
}

// Shared option schema

/** JSON-Schema fragment accepted by both CE constructor rules. */
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
