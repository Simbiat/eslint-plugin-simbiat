/**
 * @file Rule: simbiat/require-super-first-in-constructor.
 *
 * Enforces that the constructor of a Custom Element class:
 *
 * 1. Has `super()` as its very first statement.
 * 2. Calls `super()` with no arguments.
 *
 * Per the Custom Elements spec: "A parameter-less call to super() must be the first statement in the constructor body, to establish the correct prototype chain and this value before any further code is run."
 *
 * Only applies to classes that directly extend HTMLElement (or configured
 * base classes). Does not recurse into nested classes.
 *
 * Options: baseClasses: string[] – additional class names to treat as HTMLElement. Defaults to ['HTMLElement'].
 */

import type { Rule } from 'eslint';
import { adaptNodeHandler } from '../utils/Adapters.mjs';
import { baseClassesSchema } from '../utils/CustomElementsScope.mjs';

// Types

/** Rule options shape for the baseClasses option. */
interface RuleOptions {
  readonly baseClasses?: readonly string[]
}

/** State passed to the MethodDefinition visitor handler. */
interface RuleCheckState {
  readonly context: Rule.RuleContext
  readonly base_classes: readonly string[]
}

/** Minimal shape of a statement node used in super-call checks. */
interface StmtNode {
  readonly type: string
  readonly expression?: {
    readonly type: string
    readonly callee?: { readonly type: string }
    readonly arguments: readonly unknown[]
  }
}

/** Minimal shape of a MethodDefinition node as used by this rule. */
interface MethodDefNode {
  readonly kind: string
  readonly parent?: {
    readonly parent?: {
      readonly superClass?: {
        readonly type: string
        readonly name?: string
      } | null
    }
  }
  readonly value: {
    readonly body: { readonly body: readonly StmtNode[] }
  }
}

// Helpers

/**
 * Returns true if `stmt` is an expression statement containing a bare
 * `super(…)` call (not `super.method(…)` or any other form).
 * @param stmt - Statement node to test.
 * @returns True when the statement is a bare super() call.
 */
function isSuperCallStatement(stmt: StmtNode | undefined): boolean {
  return (
    stmt?.type === 'ExpressionStatement'
    && stmt.expression?.type === 'CallExpression'
    && stmt.expression.callee?.type === 'Super'
  );
}

// Rule visitor handler

/**
 * Checks a MethodDefinition node and reports if super() is not the first
 * statement or is called with arguments in a Custom Element constructor.
 * @param context - ESLint rule context for reporting.
 * @param base_classes - Class names to treat as HTMLElement base classes.
 * @param node - MethodDefinition node to inspect.
 */
function checkMethodDefinition(context: Rule.RuleContext, base_classes: readonly string[], node: Rule.Node): void {
  const method = node as unknown as MethodDefNode;
  if (method.kind !== 'constructor') {
    return;
  }

  // node → MethodDefinition, node.parent → ClassBody, node.parent.parent → Class
  const class_node = method.parent?.parent;
  if (!class_node) {
    return;
  }
  const super_class = class_node.superClass;
  if (super_class === null || typeof super_class === 'undefined') {
    return;
  }
  if (super_class.type !== 'Identifier') {
    return;
  }
  if (!base_classes.includes(super_class.name ?? '')) {
    return;
  }

  const body = method.value.body.body;

  // Check 1: super() must be the first statement.
  if (!isSuperCallStatement(body[0])) {
    context.report({
      node,
      messageId: 'missingSuperFirst',
    });
    return; // no point checking arguments if super() isn't first
  }

  // Check 2: super() must have no arguments.
  const super_call = body[0]?.expression;
  if ((super_call?.arguments.length ?? 0) > 0) {
    context.report({
      node: super_call as unknown as Rule.Node,
      messageId: 'superHasArguments',
    });
  }
}

// Rule visitor handler (top-level, adapted via adaptNodeHandler in `create`)

/**
 * Top-level ESLint visitor for MethodDefinition nodes.
 * @param state - Rule check state containing context and base classes.
 * @param node - MethodDefinition node from ESLint.
 */
function onMethodDefinition(state: RuleCheckState, node: unknown): void {
  checkMethodDefinition(state.context, state.base_classes, node as Rule.Node);
}

// Rule definition

const requireSuperFirstInConstructor: Rule.RuleModule = {
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
    const check_state: RuleCheckState = {
      context,
      base_classes,
    };

    return {
      MethodDefinition: adaptNodeHandler(check_state, onMethodDefinition),
    };
  },
};

export default requireSuperFirstInConstructor;
