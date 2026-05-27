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
 * Three problems are reported (five messageIds total):
 *
 * Inline handler (inlineHandler):
 *   document.addEventListener('click', () => {})
 *   An arrow function or function expression passed directly cannot be
 *   referenced in removeEventListener, so the listener will always leak.
 *   Store the handler as a class field instead.
 *
 * Bound handler on `add` (boundHandler):
 *   document.addEventListener('click', this.onClick.bind(this))
 *   Every .bind() call returns a fresh function object, so the reference
 *   stored by the browser can never be matched later. Store the already-bound
 *   function as a class field and pass that field to both calls.
 *
 * No matching removal (notRemoved):
 *   An addEventListener call whose combination of target + event-type +
 *   handler reference has no corresponding removeEventListener call anywhere
 *   in disconnectedCallback (or disconnectedCallback does not exist).
 *   Matching is by source text, so `this.handleClick` and
 *   `this.#handleClick` are both handled correctly.
 *   Autofix is available when the handler is a class field reference
 *   (this.foo / this.#foo): the matching removeEventListener call is inserted
 *   into disconnectedCallback, creating the method if it does not exist.
 *
 * Dynamic event type (dynamicType):
 *   document.addEventListener(this.eventType, handler)
 *   A non-literal event type cannot be statically matched, so the rule
 *   reports a warning asking the developer to verify cleanup manually.
 *
 * Bound handler on removal (boundRemoval):
 *   disconnectedCallback contains removeEventListener('click', this.onClick.bind(this))
 *   Even when the source text matches the addEventListener call, the .bind()
 *   creates a new reference that will not match the originally registered
 *   listener. Store the bound handler as a class field instead.
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

/**
 * True when the handler argument is a `.bind(…)` call.
 * Every call to `.bind()` returns a *new* function object, so the reference
 * passed to addEventListener can never equal the one passed to
 * removeEventListener – even when the source text looks identical.
 */
function isBoundHandler(node) {
  return (
    node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && node.callee.property.type === 'Identifier'
    && node.callee.property.name === 'bind'
  );
}

/**
 * True when the handler is a member expression on `this` - i.e., a class
 * field or method reference such as `this.onClick` or `this.#onClick`.
 * These are stable references that can be passed identically to both
 * addEventListener and removeEventListener, making autofix safe.
 */
function isClassFieldHandler(node) {
  return (
    node.type === 'MemberExpression'
    && node.object.type === 'ThisExpression'
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
 *     handler_node: any, // the handler argument AST node
 *     handler_inline: boolean, // true if handler is an inline fn
 *     handler_bound: boolean, // true if handler uses .bind()
 *     handler_is_field: boolean, // true if handler is this.foo / this.#foo
 *   }
 *
 * @param {any[]} statements
 * @param {'addEventListener'|'removeEventListener'} method_name
 * @param {any} source_code   – ESLint SourceCode object
 * @returns {Array<{node: any, target: string, event_type: string|null, handler_text: string, handler_node: any, handler_inline: boolean, handler_bound: boolean, handler_is_field: boolean}>}
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
        handler_node: handler_arg,
        handler_inline: isInlineHandler(handler_arg),
        handler_bound: isBoundHandler(handler_arg),
        handler_is_field: isClassFieldHandler(handler_arg),
      });
    });
  }

  return calls;
}

// Class body inspection

/**
 * Finds a named instance method in a class body and returns its
 * MethodDefinition node, or null if not found.
 *
 * @param {any} class_node
 * @param {string} name
 * @returns {any | null}
 */
function findMethod(class_node, name) {
  return (
    class_node.body.body.find((member) => {
      return member.type === 'MethodDefinition'
        && member.kind === 'method'
        && !member.static
        && member.key.type === 'Identifier'
        && member.key.name === name;
    }) ?? null
  );
}

/**
 * Returns a fixer function that inserts the matching removeEventListener call
 * into disconnectedCallback, creating the method if it does not yet exist.
 * Only called when the handler is a class field reference (this.foo / this.#foo).
 *
 * Extracted from the checkClass loop so that the internal ternary expressions
 * do not appear nested inside the outer `fix: condition ? fn: null` ternary.
 *
 * @param {object} add                  – collected addEventListener call info
 * @param {any}    connected_method     – MethodDefinition for connectedCallback
 * @param {any[]}  connected_stmts      – body statements of connectedCallback
 * @param {any}    disconnected_method  – MethodDefinition for disconnectedCallback, or null
 * @param {any}    source_code          – ESLint SourceCode object
 * @returns {(fixer: any) => any}
 */
function buildRemovalFix(add, connected_method, connected_stmts, disconnected_method, source_code) {
  return (fixer) => {
    // Detect the line ending convention used in this file.
    const eol = source_code.getText()
                           .includes('\r\n')
      ? '\r\n'
      : '\n';
    const method_indent = ' '.repeat(connected_method.loc.start.column);
    // Quote the event type safely.
    const quoted_type = add.event_type.includes('\'')
      ? `"${add.event_type}"`
      : `'${add.event_type}'`;
    const remove_stmt = `${add.target}.removeEventListener(${quoted_type}, ${add.handler_text});`;
    if (disconnected_method) {
      // Infer body indent from disconnectedCallback's own statements, falling
      // back to connectedCallback's body indent if the method is currently empty.
      const dis_stmts = disconnected_method.value.body.body;
      const ref_stmt = dis_stmts[0] ?? connected_stmts[0];
      const body_indent = ref_stmt
        ? ' '.repeat(ref_stmt.loc.start.column)
        : `${method_indent}  `;
      // Insert AFTER the previous token. Otherwise, steals the whitespace before curly brace.
      const body_node = disconnected_method.value.body;
      const prev_token = source_code.getTokenBefore(source_code.getLastToken(body_node));
      return fixer.insertTextAfter(prev_token, `${eol}${body_indent}${remove_stmt}`);
    }
    // No disconnectedCallback at all - infer body indent from connectedCallback
    // and generate the entire method immediately after connectedCallback.
    const body_indent = connected_stmts[0]
      ? ' '.repeat(connected_stmts[0].loc.start.column)
      : `${method_indent}  `;
    return fixer.insertTextAfter(
      connected_method,
      `${eol}${eol}${method_indent}disconnectedCallback() {${eol}${body_indent}${remove_stmt}${eol}${method_indent}}`,
    );
  };
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

  const connected_method = findMethod(node, 'connectedCallback');
  if (!connected_method) {
    return; // nothing in connectedCallback to check
  }
  const connected_stmts = connected_method.value.body.body;

  const disconnected_method = findMethod(node, 'disconnectedCallback');
  const disconnected_stmts = disconnected_method?.value.body.body ?? [];

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

    // Bound handler: .bind() always produces a new reference, so removal is impossible
    if (add.handler_bound) {
      context.report({
        node: add.node,
        messageId: 'boundHandler',
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

    // Check for matching removeEventListener.
    // All three need to match: target, event type, and handler source text.
    const matched_rem = rem_calls.find((rem) => {
      return rem.target === add.target
        && rem.event_type === add.event_type
        && rem.handler_text === add.handler_text;
    });

    if (matched_rem) {
      // Text matched, but the removal uses .bind() – a new reference each time,
      // so the original listener will never actually be removed.
      if (matched_rem.handler_bound) {
        context.report({
          node: matched_rem.node,
          messageId: 'boundRemoval',
          data: {
            eventType: add.event_type,
            target: add.target,
          },
        });
      }
    } else {
      context.report({
        node: add.node,
        messageId: 'notRemoved',
        data: {
          eventType: add.event_type,
          target: add.target,
        },
        // Autofix is only safe when the handler is a stable `this.foo` /
        // `this.#foo` reference. Other expressions (bare identifiers, calls,
        // etc.) might not be stable across connectedCallback invocations.
        fix: add.handler_is_field
          ? buildRemovalFix(add, connected_method, connected_stmts, disconnected_method, source_code)
          : null,
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

      boundHandler:
        'The \'{{eventType}}\' listener on {{target}} uses a .bind() call, which creates a new function reference each time – '
        + 'it can never be matched by removeEventListener and will leak. '
        + 'Store the bound handler as a class field (e.g. #handler = this.onEvent.bind(this)) and remove it in disconnectedCallback.',

      boundRemoval:
        'The \'{{eventType}}\' listener on {{target}} is removed with a .bind() call, which creates a new function reference and will not match '
        + 'the originally added listener – the listener will leak. '
        + 'Store the bound handler as a class field (e.g. #handler = this.onEvent.bind(this)) and pass that field to both addEventListener and removeEventListener.',

      notRemoved:
        'The \'{{eventType}}\' listener on {{target}} added in connectedCallback has no matching removeEventListener call in disconnectedCallback. '
        + 'Add: {{target}}.removeEventListener(\'{{eventType}}\', <handler>) inside disconnectedCallback.',

      dynamicType:
        'A listener with a dynamic event type on {{target}} is added in connectedCallback. '
        + 'Ensure a matching removeEventListener call with the same type and handler exists in disconnectedCallback.',
    },
    schema: baseClassesSchema,
    fixable: 'code',
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
