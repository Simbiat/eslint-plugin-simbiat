/**
 * @file Rule: simbiat/require-listener-cleanup.
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
 * Inline handler (inlineHandler): An arrow function or function expression passed directly cannot be referenced in removeEventListener, so the listener will always leak.
 *
 * Bound handler on `add` (boundHandler): every .bind() call returns a fresh function object, so the reference stored by the browser can never be matched later.
 *
 * No matching removal (notRemoved): an addEventListener call whose combination of target + event-type + handler reference has no corresponding removeEventListener call in disconnectedCallback. Autofix is available when the handler is a class field reference (this.foo / this.#foo).
 *
 * Dynamic event type (dynamicType): a non-literal event type cannot be statically matched.
 *
 * Bound handler on removal (boundRemoval): `.bind()` in removeEventListener creates a new reference that will not match the originally registered listener.
 *
 * Options: baseClasses: string[] – additional class names to treat as HTMLElement. Defaults to ['HTMLElement'].
 */

import type { Rule } from 'eslint';
import { adaptNodeHandler } from '../utils/Adapters.mjs';
import { isExternalTarget, targetName } from '../utils/ASTHelpers.mjs';
import { baseClassesSchema } from '../utils/CustomElementsScope.mjs';

// Types

/** Minimal AST node shape used throughout this rule. */
interface ASTNode {
  readonly type: string
  readonly kind?: string
  readonly static?: boolean
  readonly computed?: boolean
  readonly body?: ASTNodeBody
  readonly superClass?: ASTNode | null
  readonly name?: string
  readonly key?: ASTNode
  readonly callee?: ASTNode
  readonly object?: ASTNode
  readonly property?: ASTNode
  readonly value?: ASTNode
  readonly arguments?: readonly ASTNode[]
  readonly loc?: { readonly start: { readonly column: number } }

  readonly [key: string]: unknown
}

/** Body of a block statement. */
interface ASTNodeBody {
  readonly body: readonly ASTNode[]
}

/** Result of a collected addEventListener / removeEventListener call. */
interface ListenerCall {
  readonly node: ASTNode
  readonly target: string
  readonly event_type: string | null
  readonly handler_text: string
  readonly handler_node: ASTNode
  readonly handler_inline: boolean
  readonly handler_bound: boolean
  readonly handler_is_field: boolean
}

/** Minimal ESLint SourceCode interface for what this rule needs. */
interface SourceCode {
  getText: (node?: unknown) => string
  getLastToken: (node: unknown) => unknown
  getTokenBefore: (node: unknown) => unknown
}

/** Rule options shape for the baseClasses option. */
interface RuleOptions {
  readonly baseClasses?: readonly string[]
}

/** State passed to the class-exit visitor handler. */
interface ClassCheckState {
  readonly base_classes: readonly string[]
  readonly source_code: SourceCode
  readonly context: Rule.RuleContext
}

// AST utilities

const SKIP_KEYS = new Set(['type', 'parent', 'loc', 'range', 'start', 'end']);

/**
 * Walks an AST subtree, calling `visit` for every node, without descending
 * into FunctionExpression / FunctionDeclaration / ArrowFunctionExpression
 * boundaries. This is used to collect calls that execute directly (not
 * inside a deferred callback).
 * @param node - Root node to walk.
 * @param visit - Callback invoked for every visited node.
 */
function walkNoFunctions(node: unknown, visit: (node: ASTNode) => void): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  const n = node as ASTNode;
  if (
    n.type === 'FunctionExpression'
    || n.type === 'FunctionDeclaration'
    || n.type === 'ArrowFunctionExpression'
  ) {
    return;
  }
  visit(n);
  for (const [key, val] of Object.entries(n)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    if (Array.isArray(val)) {
      for (const child of val) {
        walkNoFunctions(child, visit);
      }
    } else if (val !== null && typeof val === 'object' && typeof (val as ASTNode).type === 'string') {
      walkNoFunctions(val, visit);
    }
  }
}

// Target helpers

/**
 * Returns true when the handler argument is an inline function that cannot be removed.
 * @param node - Handler AST node to test.
 * @returns True if the handler is an inline function or arrow function.
 */
function isInlineHandler(node: ASTNode): boolean {
  return (
    node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
  );
}

/**
 * Returns true when the handler argument is a `.bind(…)` call.
 * Every call to `.bind()` returns a *new* function object, so the reference
 * passed to addEventListener can never equal the one passed to
 * removeEventListener – even when the source text looks identical.
 * @param node - Handler AST node to test.
 * @returns True if the handler is a .bind() call expression.
 */
function isBoundHandler(node: ASTNode): boolean {
  return (
    node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.property?.type === 'Identifier'
    && node.callee.property.name === 'bind'
  );
}

/**
 * Returns true when the handler is a member expression on `this` - i.e., a class
 * field or method reference such as `this.onClick` or `this.#onClick`.
 * These are stable references that can be passed identically to both
 * addEventListener and removeEventListener, making autofix safe.
 * @param node - Handler AST node to test.
 * @returns True if the handler is a `this.foo` or `this.#foo` reference.
 */
function isClassFieldHandler(node: ASTNode): boolean {
  return (
    node.type === 'MemberExpression'
    && node.object?.type === 'ThisExpression'
  );
}

// Call collection

/**
 * Collects all addEventListener or removeEventListener calls on external
 * targets from a list of statements, without descending into nested functions.
 * @param statements - Array of statement nodes to scan.
 * @param method_name - Either 'addEventListener' or 'removeEventListener'.
 * @param source_code - ESLint SourceCode object for text retrieval.
 * @returns Array of collected listener call descriptors.
 */
function collectListenerCalls(
  statements: readonly ASTNode[],
  method_name: 'addEventListener' | 'removeEventListener',
  source_code: SourceCode,
): ListenerCall[] {
  const calls: ListenerCall[] = [];

  for (const stmt of statements) {
    walkNoFunctions(stmt, (node) => {
      if (node.type !== 'CallExpression') {
        return;
      }
      const { callee } = node;
      if (
        callee?.type !== 'MemberExpression'
        || callee.property?.type !== 'Identifier'
        || callee.property.name !== method_name
      ) {
        return;
      }
      if (!isExternalTarget(callee.object)) {
        return;
      }

      // Require at least (type, handler) arguments.
      const type_arg = node.arguments?.[0];
      const handler_arg = node.arguments?.[1];
      if (typeof type_arg === 'undefined' || typeof handler_arg === 'undefined') {
        return;
      }

      calls.push({
        node,
        target: targetName(callee.object, '(unknown)'),
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Literal.value is always a primitive at runtime
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
 * @param class_node - The class declaration or expression node.
 * @param name - Name of the method to find.
 * @returns The MethodDefinition node if found, otherwise null.
 */
function findMethod(class_node: ASTNode, name: string): ASTNode | null {
  return (
    class_node.body?.body.find((member) => {
      return member.type === 'MethodDefinition'
        && member.kind === 'method'
        && member.static !== true
        && member.key?.type === 'Identifier'
        && member.key.name === name;
    }) ?? null
  );
}

/**
 * Returns a fixer function that inserts the matching removeEventListener call
 * into disconnectedCallback, creating the method if it does not yet exist.
 * Only called when the handler is a class field reference (this.foo / this.#foo).
 * @param add - Collected addEventListener call info.
 * @param connected_method - MethodDefinition for connectedCallback.
 * @param connected_stmts - Body statements of connectedCallback.
 * @param disconnected_method - MethodDefinition for disconnectedCallback, or null.
 * @param source_code - ESLint SourceCode object.
 * @returns A fixer function to insert the removeEventListener call.
 */
function buildRemovalFix(
  add: ListenerCall,
  connected_method: ASTNode,
  connected_stmts: readonly ASTNode[],
  disconnected_method: ASTNode | null,
  source_code: SourceCode,
): (fixer: Rule.RuleFixer) => Rule.Fix {
  return (fixer) => {
    // Detect the line ending convention used in this file.
    const eol = source_code.getText()
                           .includes('\r\n')
      ? '\r\n'
      : '\n';
    const method_indent = ' '.repeat(connected_method.loc?.start.column ?? 0);
    // Quote the event type safely.
    const event_type = add.event_type ?? '';
    const quoted_type = event_type.includes('\'')
      ? `"${event_type}"`
      : `'${event_type}'`;
    const remove_stmt = `${add.target}.removeEventListener(${quoted_type}, ${add.handler_text});`;
    if (disconnected_method !== null) {
      // Infer body indent from disconnectedCallback's own statements, falling
      // back to connectedCallback's body indent if the method is currently empty.
      const dis_stmts = disconnected_method.value?.body?.body ?? [];
      const ref_stmt = dis_stmts[0] ?? connected_stmts[0];
      const body_indent = typeof ref_stmt?.loc === 'undefined'
        ? `${method_indent}  `
        : ' '.repeat(ref_stmt.loc.start.column);
      // Insert AFTER the previous token. Otherwise, steals the whitespace before curly brace.
      const body_node = disconnected_method.value?.body;
      const prev_token = source_code.getTokenBefore(source_code.getLastToken(body_node));
      return fixer.insertTextAfter(prev_token as Rule.Node, `${eol}${body_indent}${remove_stmt}`);
    }
    // No disconnectedCallback at all - infer body indent from connectedCallback
    // and generate the entire method immediately after connectedCallback.
    const body_indent = typeof connected_stmts[0]?.loc === 'undefined'
      ? `${method_indent}  `
      : ' '.repeat(connected_stmts[0].loc.start.column);
    return fixer.insertTextAfter(
      connected_method as unknown as Rule.Node,
      `${eol}${eol}${method_indent}disconnectedCallback() {${eol}${body_indent}${remove_stmt}${eol}${method_indent}}`,
    );
  };
}

/**
 * Checks an HTMLElement subclass for external addEventListener calls that are
 * not cleaned up in disconnectedCallback.
 * @param node - Class declaration or expression node to inspect.
 * @param base_classes - List of base class names considered as HTMLElement.
 * @param source_code - ESLint SourceCode object.
 * @param context - ESLint rule context.
 */
function checkClass(
  node: ASTNode,
  base_classes: readonly string[],
  source_code: SourceCode,
  context: Rule.RuleContext,
): void {
  // Only check classes that directly extend a known base class.
  if (node.superClass?.type !== 'Identifier') {
    return;
  }
  if (!base_classes.includes(node.superClass.name ?? '')) {
    return;
  }

  const connected_method = findMethod(node, 'connectedCallback');
  if (connected_method === null) {
    return; // nothing in connectedCallback to check
  }
  const connected_stmts = connected_method.value?.body?.body ?? [];

  const disconnected_method = findMethod(node, 'disconnectedCallback');
  const disconnected_stmts = disconnected_method?.value?.body?.body ?? [];

  const add_calls = collectListenerCalls(connected_stmts, 'addEventListener', source_code);
  const rem_calls = collectListenerCalls(disconnected_stmts, 'removeEventListener', source_code);

  for (const add of add_calls) {
    // Inline handler: can never be removed
    if (add.handler_inline) {
      context.report({
        node: add.node as unknown as Rule.Node,
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
        node: add.node as unknown as Rule.Node,
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
        node: add.node as unknown as Rule.Node,
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

    if (typeof matched_rem === 'undefined') {
      context.report({
        node: add.node as unknown as Rule.Node,
        messageId: 'notRemoved',
        data: {
          eventType: add.event_type,
          target: add.target,
        },
        // Autofix is only safe when the handler is a stable `this.foo` /
        // `this.#foo` reference.
        fix: add.handler_is_field
          ? buildRemovalFix(add, connected_method, connected_stmts, disconnected_method, source_code)
          : null,
      });
    } else if (matched_rem.handler_bound) {
      // Text matched, but the removal uses .bind() – a new reference each time,
      // so the original listener will never actually be removed.
      context.report({
        node: matched_rem.node as unknown as Rule.Node,
        messageId: 'boundRemoval',
        data: {
          eventType: add.event_type,
          target: add.target,
        },
      });
    }
  }
}

// Rule visitor handler (top-level, adapted via adaptNodeHandler in `create`)

/**
 * Top-level ESLint visitor for ClassDeclaration / ClassExpression exit nodes.
 * @param state - Class check state with base classes, source code, and context.
 * @param node - Class node from ESLint.
 */
function onClassExit(state: ClassCheckState, node: unknown): void {
  checkClass(node as ASTNode, state.base_classes, state.source_code, state.context);
}

// Rule definition
const requireListenerCleanup: Rule.RuleModule = {
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

  /**
   * Creates the rule listeners.
   * @param context - ESLint rule context.
   * @returns Rule listener object.
   */
  create(context: Rule.RuleContext): Rule.RuleListener {
    const options = context.options[0] as RuleOptions | undefined;
    const base_classes: readonly string[] = options?.baseClasses ?? ['HTMLElement'];
    // `sourceCode` is the current API; fall back to the deprecated getter for
    // older ESLint versions.
    const legacy_context = context as unknown as { getSourceCode: () => SourceCode };
    const source_code: SourceCode = (context.sourceCode as unknown as SourceCode | undefined) ?? legacy_context.getSourceCode();
    const check_state: ClassCheckState = {
      base_classes,
      source_code,
      context,
    };

    return {
      'ClassDeclaration:exit': adaptNodeHandler(check_state, onClassExit),
      'ClassExpression:exit': adaptNodeHandler(check_state, onClassExit),
    };
  },
};

export default requireListenerCleanup;
