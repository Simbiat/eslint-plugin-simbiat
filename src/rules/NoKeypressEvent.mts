/**
 * @file Rule: no-keypress-event.
 *
 * Flags the deprecated `keypress` event and suggests replacing it with `keydown`.
 *
 * Covers two patterns:
 * - element.addEventListener('keypress', handler) → suggestion offered
 * - element.removeEventListener('keypress', handler) → flagged, no suggestion
 * - element.onkeypress = handler → suggestion offered.
 */

import type { Rule } from 'eslint';
import { adaptNodeHandler } from '../utils/Adapters.mjs';

const DEPRECATED = 'keypress';
const REPLACEMENT = 'keydown';

/** Minimal shape of a CallExpression node for listener-call checks. */
interface CallNode {
  readonly callee: {
    readonly type: string
    readonly property: {
      readonly type: string
      readonly name: string
    }
  }
  readonly arguments: ReadonlyArray<{
    readonly type: string
    readonly value: unknown
    readonly raw: string
  }>
}

/** Minimal shape of an AssignmentExpression node for onkeypress checks. */
interface AssignNode {
  readonly left: {
    readonly type: string
    readonly computed: boolean
    readonly property: {
      readonly type: string
      readonly name: string
    }
  }
}

/**
 * Checks addEventListener / removeEventListener calls whose first argument is
 * the literal string 'keypress'. A fix suggestion is only offered for
 * addEventListener — renaming inside removeEventListener requires the developer
 * to also update the paired registration, so a manual edit is safer.
 * @param context - ESLint rule context.
 * @param node - CallExpression node to inspect.
 */
function checkListenerCall(context: Rule.RuleContext, node: unknown): void {
  const call = node as CallNode;
  if (
    call.callee.type !== 'MemberExpression'
    || call.callee.property.type !== 'Identifier'
  ) {
    return;
  }

  const method = call.callee.property.name;
  const is_add = method === 'addEventListener';
  const is_remove = method === 'removeEventListener';

  if (!is_add && !is_remove) {
    return;
  }

  const event_arg = call.arguments[0];
  if (
    event_arg?.type !== 'Literal'
    || event_arg.value !== DEPRECATED
  ) {
    return;
  }

  context.report({
    node: event_arg as unknown as Rule.Node,
    messageId: 'avoidKeypress',
    suggest: is_add
      ? [
        {
          messageId: 'replaceWithKeydown',
          /**
           * Replaces the 'keypress' literal with 'keydown' in the source.
           * @param fixer - ESLint rule fixer.
           * @returns The text replacement fix.
           */
          fix(fixer: Rule.RuleFixer): Rule.Fix {
            const quote = event_arg.raw[0];
            return fixer.replaceText(event_arg as unknown as Rule.Node, `${quote}${REPLACEMENT}${quote}`);
          },
        },
      ]
      : [],
  });
}

/**
 * Flags `element.onkeypress = handler` assignments and suggests renaming the
 * property to `onkeydown`.
 * @param context - ESLint rule context.
 * @param node - AssignmentExpression node to inspect.
 */
function checkOnkeypressAssignment(context: Rule.RuleContext, node: unknown): void {
  const assign = node as AssignNode;
  if (
    assign.left.type !== 'MemberExpression'
    || assign.left.computed
    || assign.left.property.type !== 'Identifier'
    || assign.left.property.name !== 'onkeypress'
  ) {
    return;
  }

  context.report({
    node: assign.left.property as unknown as Rule.Node,
    messageId: 'avoidOnkeypress',
    suggest: [
      {
        messageId: 'replaceWithOnkeydown',
        /**
         * Replaces the 'onkeypress' property with 'onkeydown' in the source.
         * @param fixer - ESLint rule fixer.
         * @returns The text replacement fix.
         */
        fix(fixer: Rule.RuleFixer): Rule.Fix {
          return fixer.replaceText(assign.left.property as unknown as Rule.Node, 'onkeydown');
        },
      },
    ],
  });
}

/**
 * Top-level ESLint visitor for CallExpression nodes.
 * @param context - ESLint rule context.
 * @param node - CallExpression node.
 */
function onCallExpression(context: Rule.RuleContext, node: unknown): void {
  checkListenerCall(context, node);
}

/**
 * Top-level ESLint visitor for AssignmentExpression nodes.
 * @param context - ESLint rule context.
 * @param node - AssignmentExpression node.
 */
function onAssignmentExpression(context: Rule.RuleContext, node: unknown): void {
  checkOnkeypressAssignment(context, node);
}

const noKeypressEvent: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    hasSuggestions: true,
    docs: {
      description: 'Disallow the deprecated `keypress` event in favour of `keydown`.',
      url: 'https://github.com/simbiat/eslint-plugin-simbiat',
    },
    messages: {
      avoidKeypress:
        '`keypress` is deprecated, use `keydown` instead.',
      replaceWithKeydown:
        '`keypress` is deprecated, use `keydown` instead.',
      avoidOnkeypress:
        '`onkeypress` is deprecated, use `onkeydown` instead.',
      replaceWithOnkeydown:
        '`onkeypress` is deprecated, use `onkeydown` instead.',
    },
    schema: [],
  },

  /**
   * Creates the rule listeners.
   * @param context - ESLint rule context.
   * @returns Rule listener object.
   */
  create(context: Rule.RuleContext): Rule.RuleListener {
    return {
      CallExpression: adaptNodeHandler(context, onCallExpression),
      AssignmentExpression: adaptNodeHandler(context, onAssignmentExpression),
    };
  },
};

export default noKeypressEvent;
