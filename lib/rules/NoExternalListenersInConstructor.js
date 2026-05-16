// @ts-check

/**
 * Rule: simbiat/no-external-listeners-in-constructor
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
 *   baseClasses: string[] – additional class names to treat as HTMLElement.
 *                            Defaults to ['HTMLElement'].
 */

import { adaptNodeHandler } from '../utils/Adapters.js';
import { isExternalTarget, targetName } from '../utils/ASTHelpers.js';
import {
  isActiveScope,
  buildScopeVisitors,
  baseClassesSchema,
} from '../utils/CustomElementsScope.js';

// Visitor handler

function onCallExpression(state, node) {
  if (!isActiveScope(state)) {
    return;
  }
  const { callee } = node;
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
    node,
    messageId: 'externalListener',
    data: { target: targetName(callee.object) },
  });
}

// Rule definition

const noExternalListenersInConstructor = {
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
    fixable: null,
    hasSuggestions: false,
  },

  // noinspection JSUnusedGlobalSymbols
  create(context) {
    const state = {
      context,
      stack: [],
      base_classes: context.options[0]?.baseClasses ?? ['HTMLElement'],
    };

    return {
      ...buildScopeVisitors(state),
      CallExpression: adaptNodeHandler(state, onCallExpression),
    };
  },
};

export default noExternalListenersInConstructor;
