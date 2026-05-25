// @ts-check

/**
 * Rule: no-keypress-event
 *
 * Flags the deprecated `keypress` event and suggests replacing it with `keydown`.
 *
 * Covers two patterns:
 *   - element.addEventListener('keypress', handler) → suggestion offered
 *   - element.removeEventListener('keypress', handler) → flagged, no suggestion
 *   - element.onkeypress = handler → suggestion offered
 */

const DEPRECATED = 'keypress';
const REPLACEMENT = 'keydown';

/**
 * Checks addEventListener / removeEventListener calls whose first argument is
 * the literal string 'keypress'.  A fix suggestion is only offered for
 * addEventListener — renaming inside removeEventListener requires the developer
 * to also update the paired registration, so a manual edit is safer.
 *
 * @param {import('eslint').Rule.RuleContext} context
 * @param {any} node - CallExpression
 */
function checkListenerCall(context, node) {
  if (
    node.callee.type !== 'MemberExpression'
    || node.callee.property.type !== 'Identifier'
  ) {
    return;
  }

  const method = node.callee.property.name;
  const is_add = method === 'addEventListener';
  const is_remove = method === 'removeEventListener';

  if (!is_add && !is_remove) {
    return;
  }

  const [event_arg] = node.arguments;
  if (
    !event_arg
    || event_arg.type !== 'Literal'
    || event_arg.value !== DEPRECATED
  ) {
    return;
  }

  context.report({
    node: event_arg,
    messageId: 'avoidKeypress',
    suggest: is_add
      ? [
        {
          messageId: 'replaceWithKeydown',
          fix(fixer) {
            const quote = event_arg.raw[0];
            return fixer.replaceText(event_arg, `${quote}${REPLACEMENT}${quote}`);
          },
        },
      ]
      : [],
  });
}

/**
 * Flags `element.onkeypress = handler` assignments and suggests renaming the
 * property to `onkeydown`.
 *
 * @param {import('eslint').Rule.RuleContext} context
 * @param {any} node - AssignmentExpression
 */
function checkOnkeypressAssignment(context, node) {
  if (
    node.left.type !== 'MemberExpression'
    || node.left.computed
    || node.left.property.type !== 'Identifier'
    || node.left.property.name !== 'onkeypress'
  ) {
    return;
  }

  context.report({
    node: node.left.property,
    messageId: 'avoidOnkeypress',
    suggest: [
      {
        messageId: 'replaceWithOnkeydown',
        fix(fixer) {
          return fixer.replaceText(node.left.property, 'onkeydown');
        },
      },
    ],
  });
}

/** @type {import('eslint').Rule.RuleModule} */
const noKeypressEvent = {
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

  create(context) {
    return {
      // eslint-disable-next-line sonarjs/function-name
      CallExpression(node) {
        checkListenerCall(context, node);
      },
      // eslint-disable-next-line sonarjs/function-name
      AssignmentExpression(node) {
        checkOnkeypressAssignment(context, node);
      },
    };
  },
};

export default noKeypressEvent;
