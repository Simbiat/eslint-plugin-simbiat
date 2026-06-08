/**
 * @file Rule: simbiat/no-external-listeners-in-constructor.
 *
 * Flags `addEventListener` calls on `document`, `window`, `document.body`,
 * `document.documentElement`, or `document.head` that appear *directly* in
 * the constructor body of a Custom Element (not inside a nested
 * callback/arrow function).
 *
 * These listeners belong in `connectedCallback`, paired with removal in
 * `disconnectedCallback`; otherwise they leak if the element is moved or
 * re-inserted into the DOM.
 *
 * Options:
 * baseClasses: string[] – additional class names to treat as HTMLElement. Defaults to ['HTMLElement'].
 */

import type { Rule } from 'eslint';
import { adaptNodeHandler } from '../utils/Adapters.mjs';
import { isExternalTarget, targetName } from '../utils/ASTHelpers.mjs';
import {
  isActiveScope,
  buildScopeVisitors,
  baseClassesSchema,
  type ScopeState,
} from '../utils/CustomElementsScope.mjs';

// Types

/** Rule options shape for the baseClasses option. */
interface RuleOptions {
  readonly baseClasses?: readonly string[]
}

/** Extended state including the ESLint rule context. */
interface RuleState extends ScopeState {
  readonly context: Rule.RuleContext
}

/** Minimal shape of a CallExpression node as used by this rule. */
interface CallExpressionNode {
  readonly callee: {
    readonly type: string
    readonly property: {
      readonly type: string
      readonly name: string
    }
    readonly object: unknown
  }
}

// Visitor handler

/**
 * Reports `addEventListener` calls on external targets found directly in the constructor.
 * @param state - Rule state including ESLint context and scope stack.
 * @param node - CallExpression node to inspect (as unknown from ESLint).
 */
function onCallExpression(state: RuleState, node: unknown): void {
  if (!isActiveScope(state)) {
    return;
  }
  const call = node as CallExpressionNode;
  const { callee } = call;
  if (callee.type !== 'MemberExpression') {
    return;
  }
  if (callee.property.type !== 'Identifier') {
    return;
  }
  if (callee.property.name !== 'addEventListener') {
    return;
  }
  if (!isExternalTarget(callee.object)) {
    return;
  }

  state.context.report({
    node: node as Rule.Node,
    messageId: 'externalListener',
    data: { target: targetName(callee.object) },
  });
}

// Rule definition

const noExternalListenersInConstructor: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Discourage addEventListener on document / window in Custom Element constructors.',
    },
    messages: {
      externalListener:
        'Avoid attaching listeners to {{target}} in the constructor. '
        + 'Add them in connectedCallback and remove them in disconnectedCallback; '
        + 'otherwise listeners will be lost if the element is moved or re-inserted.',
    },
    schema: baseClassesSchema,
    hasSuggestions: false,
  },

  /**
   * Create rule.
   * @param context - Contect to process.
   */
  create(context: Rule.RuleContext): Rule.RuleListener {
    const options = context.options[0] as RuleOptions | undefined;
    const state: RuleState = {
      context,
      stack: [],
      base_classes: options?.baseClasses ?? ['HTMLElement'],
    };

    return {
      ...buildScopeVisitors(state),
      CallExpression: adaptNodeHandler(state, onCallExpression),
    };
  },
};

export default noExternalListenersInConstructor;
