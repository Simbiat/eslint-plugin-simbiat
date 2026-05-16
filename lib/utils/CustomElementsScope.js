// @ts-check

/**
 * Shared scope-tracking for custom-element constructor rules.
 *
 * Stack entry shapes:
 *   { kind: 'class', isHTMLEl: boolean, fieldNames: Set<string> }
 *   { kind: 'constructor' } ← constructor body of an HTMLElement subclass
 *   { kind: 'field', fieldName: string }
 *                              ← instance field initializer of an HTMLElement subclass
 *   { kind: 'fn' } ← nested function / arrow inside constructor or field initializer
 *
 * Invariant: 'constructor' and 'field' entries are only ever pushed when the
 * nearest enclosing 'class' entry has isHTMLEl === true.  This lets
 * isActiveScope simply check the top of the stack.
 *
 * Public API:
 *   isActiveScope(state) – true when directly inside a constructor OR
 *                                  a field initializer (not wrapped in a nested fn).
 *   getActiveScopeLocation(state) – human-readable string for use as {{location}}
 *                                   in rule messages, e.g. "the constructor" or
 *                                   "the field initializer for 'myField'".
 *   getClassFieldNames(state) – Set of PropertyDefinition names in the
 *                                  innermost enclosing class body.
 *   buildScopeVisitors(state) – returns all ESLint visitor entries needed to
 *                                  maintain the stack; spread into create().
 *   baseClassesSchema – shared JSON-Schema option fragment.
 */

import { adaptNodeHandler, adaptStateHandler } from './Adapters.js';

// Field-name collection

/**
 * Returns a Set of every public property name explicitly declared as a
 * PropertyDefinition (class field) in the class body.
 *
 * Private fields are omitted: `this.#foo` produces a PrivateIdentifier node,
 * not an Identifier, so those assignments can never reach the checks that
 * consult this set.
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
 * `True` when execution is directly inside either:
 *   • the constructor body of an HTMLElement subclass, or
 *   • an instance field initializer of an HTMLElement subclass,
 * AND there is no nested function or arrow function in between.
 *
 * Both 'constructor' and 'field' entries are only pushed when isHTMLEl is
 * true on the enclosing class, so we can check the top alone.
 *
 * @param {{ stack: Array<{kind: string}> }} state
 * @returns {boolean}
 */
export function isActiveScope(state) {
  const top = state.stack[state.stack.length - 1];
  return top?.kind === 'constructor' || top?.kind === 'field';
}

/**
 * Returns a human-readable phrase describing the currently active scope,
 * for use as the `{{location}}` template variable in rule messages.
 *
 * Examples:
 *   "the constructor"
 *   "the field initializer for 'myField'"
 *   "the field initializer for '#privateField'"
 *
 * Falls back to "the constructor" if called outside an active scope.
 *
 * @param {{ stack: Array<any> }} state
 * @returns {string}
 */
export function getActiveScopeLocation(state) {
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
  const is_html_el = node.superClass !== null && node.superClass.type === 'Identifier' && state.base_classes.includes(node.superClass.name);
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
 * Pushes a 'field' scope entry when entering a non-static instance field
 * initializer that belongs directly to an HTMLElement subclass.
 *
 * Conditions:
 *   • The PropertyDefinition must not be static.
 *   • It must have an initializer (value !== null) — without one there is
 *     nothing to analyze.
 *   • The direct parent class entry on the stack must have isHTMLEl === true.
 */
function onPropertyDefinitionEnter(state, node) {
  if (node.static || node.value === null) {
    return;
  }
  const top = state.stack[state.stack.length - 1];
  if (top?.kind !== 'class' || !top.isHTMLEl) {
    return;
  }

  // Determine a readable field name for messages.
  let field_name;
  const { key } = node;
  if (key.type === 'Identifier') {
    field_name = key.name;
  } else if (key.type === 'PrivateIdentifier') {
    field_name = `#${key.name}`;
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

function onPropertyDefinitionExit(state, node) {
  if (node.static || node.value === null) {
    return;
  }
  if (state.stack[state.stack.length - 1]?.kind === 'field') {
    state.stack.pop();
  }
}

/**
 * FunctionExpression covers both regular methods and the constructor body.
 *   • constructor body → push 'constructor'
 *   • any other fn inside constructor or field initializer → push 'fn'
 */
function onFunctionEnter(state, node) {
  const is_constructor_body = node.parent.type === 'MethodDefinition' && node.parent.kind === 'constructor';

  if (is_constructor_body) {
    const top_class = [...state.stack]
      .reverse()
      .find((e) => {
        return e.kind === 'class';
      });
    if (top_class?.isHTMLEl) {
      state.stack.push({ kind: 'constructor' });
    }
  } else if (
    state.stack.some((e) => {
      return e.kind === 'constructor' || e.kind === 'field';
    })
  ) {
    // Nested regular function inside constructor or field initializer.
    // `this` is rebound, so all CE checks inside it must be suppressed.
    state.stack.push({ kind: 'fn' });
  }
}

function onFunctionExit(state, node) {
  const top = state.stack[state.stack.length - 1];
  const is_constructor_body = node.parent.type === 'MethodDefinition' && node.parent.kind === 'constructor';
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
 * suppressed.  Push 'fn' whenever we're inside a constructor or field init.
 */
function onArrowEnter(state) {
  if (state.stack.some((e) => {
    return e.kind === 'constructor' || e.kind === 'field';
  })) {
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
 * Returns the ESLint visitor entries that maintain the scope stack.
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
