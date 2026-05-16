// @ts-check

/**
 * Rule: simbiat/require-super-first-in-constructor
 *
 * Enforces that the constructor of a Custom Element class:
 *
 *   1. Has `super()` as its very first statement.
 *   2. Calls `super()` with no arguments.
 *
 * Per the Custom Elements spec:
 *   "A parameter-less call to super() must be the first statement in the
 *    constructor body, to establish the correct prototype chain and this
 *    value before any further code is run."
 *
 * Only applies to classes that directly extend HTMLElement (or configured
 * base classes). Does not recurse into nested classes.
 *
 * Options:
 *   baseClasses: string[] – additional class names to treat as HTMLElement.
 *                            Defaults to ['HTMLElement'].
 */

import { baseClassesSchema } from '../utils/CustomElementsScope.js';

// Helpers

/**
 * Returns true if `stmt` is an expression statement containing a bare
 * `super(…)` call (not `super.method(…)` or any other form).
 *
 * @param {any} stmt
 * @returns {boolean}
 */
function isSuperCallStatement(stmt) {
  return (
    typeof stmt !== 'undefined'
    && stmt.type === 'ExpressionStatement'
    && stmt.expression.type === 'CallExpression'
    && stmt.expression.callee.type === 'Super'
  );
}

// Rule definition

const requireSuperFirstInConstructor = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a parameter-less super() as the first statement in Custom Element constructors.',
      url: 'https://html.spec.whatwg.org/multipage/custom-elements.html#custom-element-conformance',
    },
    messages: {
      missingSuperFirst:
        'The first statement in a Custom Element constructor must be a bare super() call.',
      superHasArguments:
        'super() in a Custom Element constructor must be called without arguments.',
    },
    schema: baseClassesSchema,
    fixable: null,
    hasSuggestions: false,
  },

  // noinspection JSUnusedGlobalSymbols
  create(context) {
    const base_classes = context.options[0]?.baseClasses ?? ['HTMLElement'];

    return {
      // Name required for plugin to work
      // eslint-disable-next-line sonarjs/function-name
      MethodDefinition(node) {
        if (node.kind !== 'constructor') {
          return;
        }

        // Confirm the containing class extends one of our base classes.
        // node → MethodDefinition
        // node.parent → ClassBody
        // node.parent.parent → ClassDeclaration | ClassExpression
        const class_node = node.parent?.parent;
        if (!class_node) {
          return;
        }
        if (!class_node.superClass) {
          return;
        }
        if (class_node.superClass.type !== 'Identifier') {
          return;
        }
        if (!base_classes.includes(class_node.superClass.name)) {
          return;
        }

        const body = node.value.body.body;

        // Check 1: super() must be the first statement
        if (!isSuperCallStatement(body[0])) {
          // Report on the constructor method itself so the location is clear.
          context.report({
            node,
            messageId: 'missingSuperFirst',
          });
          return; // no point checking arguments if super() isn't first
        }

        // Check 2: super() must have no arguments
        const super_call = body[0].expression;
        if (super_call.arguments.length > 0) {
          context.report({
            node: super_call,
            messageId: 'superHasArguments',
          });
        }
      },
    };
  },
};

export default requireSuperFirstInConstructor;
