/**
 * @file Rule: simbiat/require-type-parameter.
 *
 * Flags `querySelector`, `querySelectorAll`, and `closest` calls in TypeScript
 * files that lack a type parameter, e.g. `querySelector<HTMLAnchorElement>('.link')`.
 *
 * Only activates on .ts / .tsx files; JS files are left alone.
 * No auto-fix is provided: the correct type depends on the selector and must
 * be supplied by the developer.
 */

import type { Rule } from 'eslint';
import { adaptNodeHandler } from '../utils/Adapters.mjs';

/** Minimal CallExpression shape for type-argument checks. */
interface CallNode {
  readonly callee: {
    readonly type: string
    readonly property: {
      readonly type: string
      readonly name: string
    }
  }
  readonly typeParameters?: { readonly params: readonly unknown[] }
  readonly typeArguments?: { readonly params: readonly unknown[] }
}

/**
 * Top-level ESLint visitor for CallExpression nodes.
 * Checks `querySelector`/`querySelectorAll`/`closest` calls for a missing type parameter.
 * @param context - ESLint rule context.
 * @param node - CallExpression node from ESLint.
 */
function onCallExpression(context: Rule.RuleContext, node: unknown): void {
  const call = node as CallNode;
  if (call.callee.type !== 'MemberExpression') {
    return;
  }

  const { property } = call.callee;
  if (property.type !== 'Identifier') {
    return;
  }
  if (
    property.name !== 'querySelector'
    && property.name !== 'querySelectorAll'
    && property.name !== 'closest'
  ) {
    return;
  }

  // @typescript-eslint/parser attaches type arguments as either
  // `typeParameters` (older versions) or `typeArguments` (v6+).
  const has_type_arg = (call.typeParameters?.params.length ?? 0) > 0 || (call.typeArguments?.params.length ?? 0) > 0;

  if (!has_type_arg) {
    context.report({
      node: property as unknown as Rule.Node,
      messageId: 'missingTypeParam',
      data: { method: property.name },
    });
  }
}

const requireTypeParameter: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require a type parameter on querySelector / querySelectorAll / closest calls in TypeScript files.',
    },
    messages: {
      missingTypeParam:
        'Provide a type parameter to {{method}} to be more explicit and reduce casting.',
    },
    schema: [],
    hasSuggestions: false,
  },

  /**
   * Creates the rule listeners.
   * @param context - ESLint rule context.
   * @returns Rule listener object.
   */
  create(context: Rule.RuleContext): Rule.RuleListener {
    // Limit to TypeScript source files only.
    const filename = context.filename ?? '';
    if (!filename.endsWith('.ts') && !filename.endsWith('.tsx')) {
      return {};
    }

    return {
      CallExpression: adaptNodeHandler(context, onCallExpression),
    };
  },
};

export default requireTypeParameter;
