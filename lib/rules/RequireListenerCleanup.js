// @ts-check

/**
 * Rule: simbiat/require-listener-cleanup
 *
 * Verifies that every `addEventListener` call on an external target inside
 * `connectedCallback` of an HTMLElement subclass has a matching
 * `removeEventListener` call in `disconnectedCallback`.
 *
 * "External targets" are: document, window, `document.body`,
 * document.documentElement, document.head.
 * (Self-listeners on `this` and shadow-root listeners are not checked.)
 *
 * Three problems are reported:
 *
 * Inline handler:
 *   document.addEventListener('click', () => {})
 *   An arrow function or function expression passed directly cannot be
 *   referenced in removeEventListener, so the listener will always leak.
 *   Store the handler as a class field instead.
 *
 * No matching removal:
 *   An addEventListener call whose combination of target + event-type +
 *   handler reference has no corresponding removeEventListener call anywhere
 *   in disconnectedCallback (or disconnectedCallback does not exist).
 *   Matching is by source text, so `this.handleClick` and
 *   `this.#handleClick` are both handled correctly.
 *
 * Dynamic event type
 *   document.addEventListener(this.eventType, handler)
 *   A non-literal event type cannot be statically matched, so the rule
 *   reports a warning asking the developer to verify cleanup manually.
 *
 * Limitations:
 *   • Calls inside nested functions / arrow functions within connectedCallback
 *     are not analyzed (they are deferred / conditional in ways that cannot
 *     be reliably tracked).
 *   • Calls made via helper methods invoked from connectedCallback are not
 *     detected.
 *   • MutationObserver / ResizeObserver / IntersectionObserver cleanup is
 *     not yet checked.
 *
 * Options:
 *   baseClasses: string[] – additional class names to treat as HTMLElement.
 *                            Defaults to ['HTMLElement'].
 */

import { isExternalTarget, targetName } from '../utils/ASTHelpers.js';
import { baseClassesSchema } from '../utils/CustomElementsScope.js';

// AST utilities

const SKIP_KEYS = new Set(['type', 'parent', 'loc', 'range', 'start', 'end']);

/**
 * Walks an AST subtree, calling `visit` for every node, without descending
 * into FunctionExpression / FunctionDeclaration / ArrowFunctionExpression
 * boundaries.  This is used to collect calls that execute directly (not
 * inside a deferred callback).
 *
 * @param {any} node
 * @param {(node: any) => void} visit
 */
function walkNoFunctions(node, visit) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (
    node.type === 'FunctionExpression'
    || node.type === 'FunctionDeclaration'
    || node.type === 'ArrowFunctionExpression'
  ) {
    return;
  }
  visit(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        walkNoFunctions(child, visit);
      }
    } else if (val !== null && typeof val === 'object' && typeof val.type === 'string') {
      walkNoFunctions(val, visit);
    }
  }
}

// Target helpers

/** True when the handler argument is an inline function that cannot be removed. */
function isInlineHandler(node) {
  return (
    node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
  );
}

// Call collection

/**
 * Collects all addEventListener or removeEventListener calls on external
 * targets from a list of statements, without descending into nested functions.
 *
 * Returns an array of:
 *   {
 *     node: CallExpression,
 *     target: string, // e.g. 'document', 'document.body'
 *     event_type: string | null, // null if not a string literal
 *     handler_text: string, // source text of the handler arg
 *     handler_inline: boolean, // true if handler is an inline fn
 *   }
 *
 * @param {any[]} statements
 * @param {'addEventListener'|'removeEventListener'} method_name
 * @param {any} source_code   – ESLint SourceCode object
 * @returns {Array<{node: any, target: string, event_type: string|null, handler_text: string, handler_inline: boolean}>}
 */
function collectListenerCalls(statements, method_name, source_code) {
  const calls = [];

  for (const stmt of statements) {
    walkNoFunctions(stmt, (node) => {
      if (node.type !== 'CallExpression') {
        return;
      }
      const { callee } = node;
      if (
        callee.type !== 'MemberExpression'
        || callee.property.type !== 'Identifier'
        || callee.property.name !== method_name
      ) {
        return;
      }
      if (!isExternalTarget(callee.object)) {
        return;
      }

      // Require at least (type, handler) arguments.
      const [type_arg, handler_arg] = node.arguments;
      if (!type_arg || !handler_arg) {
        return;
      }

      calls.push({
        node,
        target: targetName(callee.object, '(unknown)'),
        event_type: type_arg.type === 'Literal' ? String(type_arg.value) : null,
        handler_text: source_code.getText(handler_arg),
        handler_inline: isInlineHandler(handler_arg),
      });
    });
  }

  return calls;
}

// Class body inspection

/**
 * Finds a named instance method in a class body and returns its statement
 * list, or null if not found.
 *
 * @param {any} class_node
 * @param {string} name
 * @returns {any[] | null}
 */
function getMethodStatements(class_node, name) {
  for (const member of class_node.body.body) {
    if (
      member.type === 'MethodDefinition'
      && member.kind === 'method'
      && !member.static
      && member.key.type === 'Identifier'
      && member.key.name === name
    ) {
      return member.value.body.body;
    }
  }
  return null;
}

/**
 * Checks an HTMLElement subclass for external addEventListener calls that are
 * not cleaned up in disconnectedCallback.
 *
 * @param {any} node
 * @param {string[]} base_classes
 * @param {any} source_code
 * @param {any} context
 */
function checkClass(node, base_classes, source_code, context) {
  // Only check classes that directly extend a known base class.
  if (!node.superClass || node.superClass.type !== 'Identifier') {
    return;
  }
  if (!base_classes.includes(node.superClass.name)) {
    return;
  }

  const connected_stmts = getMethodStatements(node, 'connectedCallback');
  if (!connected_stmts) {
    return; // nothing in connectedCallback to check
  }

  const disconnected_stmts = getMethodStatements(node, 'disconnectedCallback') ?? [];

  const add_calls = collectListenerCalls(connected_stmts, 'addEventListener', source_code);
  const rem_calls = collectListenerCalls(disconnected_stmts, 'removeEventListener', source_code);

  for (const add of add_calls) {
    // Inline handler: can never be removed
    if (add.handler_inline) {
      context.report({
        node: add.node,
        messageId: 'inlineHandler',
        data: {
          eventType: add.event_type ?? '(dynamic)',
          target: add.target,
        },
      });
      continue;
    }

    // Dynamic event type: cannot match statically
    if (add.event_type === null) {
      context.report({
        node: add.node,
        messageId: 'dynamicType',
        data: { target: add.target },
      });
      continue;
    }

    // Check for matching removeEventListener
    // All three need to match: target, event type, and handler source text.
    const matched = rem_calls.some((rem) => {
      return rem.target === add.target
        && rem.event_type === add.event_type
        && rem.handler_text === add.handler_text;
    });

    if (!matched) {
      context.report({
        node: add.node,
        messageId: 'notRemoved',
        data: {
          eventType: add.event_type,
          target: add.target,
        },
      });
    }
  }
}

// Rule definition

const requireListenerCleanup = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require removeEventListener in disconnectedCallback for each addEventListener on external targets in connectedCallback.',
    },
    messages: {
      inlineHandler:
        'The \'{{eventType}}\' listener on {{target}} uses an inline function that can never be passed to removeEventListener – the listener will leak. '
        + 'Store the handler as a class field (e.g. #handler = (e) => { … }) and remove it in disconnectedCallback.',

      notRemoved:
        'The \'{{eventType}}\' listener on {{target}} added in connectedCallback has no matching removeEventListener call in disconnectedCallback. '
        + 'Add: {{target}}.removeEventListener(\'{{eventType}}\', <handler>) inside disconnectedCallback.',

      dynamicType:
        'A listener with a dynamic event type on {{target}} is added in connectedCallback. '
        + 'Ensure a matching removeEventListener call with the same type and handler exists in disconnectedCallback.',
    },
    schema: baseClassesSchema,
    fixable: null,
    hasSuggestions: false,
  },

  // noinspection JSUnusedGlobalSymbols
  create(context) {
    const base_classes = context.options[0]?.baseClasses ?? ['HTMLElement'];
    // `sourceCode` is the current API; fall back to the deprecated getter for
    // older ESLint versions.
    const source_code = context.sourceCode ?? context.getSourceCode();

    return {
      'ClassDeclaration:exit': (node) => {
        checkClass(node, base_classes, source_code, context);
      },
      'ClassExpression:exit': (node) => {
        checkClass(node, base_classes, source_code, context);
      },
    };
  },
};

export default requireListenerCleanup;
