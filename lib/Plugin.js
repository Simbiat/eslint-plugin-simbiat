// @ts-check

/**
 * eslint-plugin-simbiat
 *
 * All custom ESLint rules for the Simbiat project, exposed under a single
 * `simbiat` plugin namespace.
 *
 * Flat-config usage (eslint.config.js):
 *
 *   import simbiat from 'eslint-plugin-simbiat';
 *
 *   export default [
 *     {
 *       plugins: { simbiat },
 *       rules: {
 *         // Custom Elements – constructor constraints
 *         'simbiat/no-forbidden-in-constructor': 'error',
 *         'simbiat/no-external-listeners-in-constructor': 'warn',
 *         'simbiat/require-super-first-in-constructor': 'error',
 *
 *         // Class fields
 *         'simbiat/prefer-field-initializer': 'warn',
 *
 *         // TypeScript querySelector
 *         'simbiat/require-type-parameter': 'warn',
 *       },
 *     },
 *   ];
 *
 * Both CE constructor rules accept an optional options object:
 *   { baseClasses: ['HTMLElement', 'LitElement', 'BaseComponent'] }
 */

import noForbiddenInConstructor from './rules/NoForbiddenInConstructor.js';
import noExternalListenersInConstructor from './rules/NoExternalListenersInConstructor.js';
import preferFieldInitializer from './rules/PreferFieldInitializer.js';
import requireTypeParameter from './rules/RequireTypeParameter.js';
import requireSuperFirstInConstructor from './rules/RequireSuperFirstInConstructor.js';

const Plugin = {
  meta: {
    name: 'eslint-plugin-simbiat',
    url: 'https://github.com/simbiat/eslint-plugin-simbiat',
  },
  rules: {
    'no-forbidden-in-constructor': noForbiddenInConstructor,
    'no-external-listeners-in-constructor': noExternalListenersInConstructor,
    'prefer-field-initializer': preferFieldInitializer,
    'require-type-parameter': requireTypeParameter,
    'require-super-first-in-constructor': requireSuperFirstInConstructor,
  },
};

export default Plugin;
