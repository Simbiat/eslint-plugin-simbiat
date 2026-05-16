// @ts-check

/**
 * Shared scope-tracking for custom-element constructor rules.
 *
 * Stack entry shapes:
 *   { kind: 'class', isHTMLEl: boolean, fieldNames: Set<string> }
 *   { kind: 'constructor' } ← constructor body of an HTMLElement subclass
 *   { kind: 'fn' } ← nested function / arrow inside constructor
 *
 * `isActiveScope(state)` – true only when directly inside the constructor,
 *                             not wrapped in a nested function/arrow.
 * `getClassFieldNames(state)` – Set of all PropertyDefinition names declared
 *                               in the innermost enclosing class body.
 */

import { adaptNodeHandler, adaptStateHandler } from './Adapters.js';

// Field-name collection

/**
 * Returns a Set of every property name explicitly declared as a
 * PropertyDefinition in the class body.
 *
 * Private fields are intentionally excluded: `this.#foo` produces a
 * PrivateIdentifier node (not Identifier) on the left-hand side of an
 * assignment, so those assignments can never reach the checks that consult
 * this set.
 *
 * @param {any} class_node – ClassDeclaration | ClassExpression
 * @returns {Set<string>}
 */
function collectClassFieldNames(class_node) {
  const names = new Set();
  for (const member of class_node.body.body) {
    if (member.type !== 'PropertyDefinition') {
      continue;
    }
    const { key } = member;
    if (key.type === 'Identifier') {
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
 * True only when directly inside the constructor of an HTMLElement subclass,
 * with no nested function or arrow function in between.
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

/**
 * Returns the `fieldNames` set of the innermost enclosing class on the stack,
 * or an empty Set when called outside any class body.
 *
 * Use this inside an `isActiveScope` guard to check whether the developer
 * explicitly declared a given property name as a class field.
 *
 * @param {{ stack: Array<any> }} state
 * @returns {Set<string>}
 */
export function getClassFieldNames(state) {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    if (state.stack[i].kind === 'class') {
      return state.stack[i].fieldNames ?? new Set();
    }
  }
  return new Set();
}

// Visitor handlers

function onClassEnter(state, node) {
  const is_html_el =
    node.superClass !== null &&
    node.superClass.type === 'Identifier' &&
    state.base_classes.includes(node.superClass.name);
  state.stack.push({
    kind: 'class',
    isHTMLEl: is_html_el,
    fieldNames: collectClassFieldNames(node),
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
 * Returns the eight ESLint visitor entries that maintain the scope stack.
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

/** JSON-Schema fragment accepted by all CE constructor rules. */
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