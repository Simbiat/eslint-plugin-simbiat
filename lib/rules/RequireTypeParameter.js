// @ts-check

/**
 * Rule: simbiat/require-type-parameter
 *
 * Flags `querySelector` and `querySelectorAll` calls in TypeScript files that
 * lack a type parameter, e.g. `querySelector<HTMLAnchorElement>('.link')`.
 *
 * Only activates on .ts / .tsx files; JS files are left alone.
 * No auto-fix is provided: the correct type depends on the selector and must
 * be supplied by the developer.
 */

const requireTypeParameter = {
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
    fixable: null,
    hasSuggestions: false,
  },

  create(context) {
    // Limit to TypeScript source files only.
    const filename = context.filename ?? '';
    if (!filename.endsWith('.ts') && !filename.endsWith('.tsx')) {
      return {};
    }

    // noinspection JSUnusedGlobalSymbols
    return {
      // eslint-disable-next-line sonarjs/function-name
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') {
          return;
        }

        const { property } = node.callee;
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
        const has_type_arg = (node.typeParameters?.params?.length > 0) || (node.typeArguments?.params?.length > 0);

        if (!has_type_arg) {
          context.report({
            node: property,
            messageId: 'missingTypeParam',
            data: { method: property.name },
          });
        }
      },
    };
  },
};

export default requireTypeParameter;
