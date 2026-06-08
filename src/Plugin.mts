/**
 * @file Index file for the plugin.
 */
// @ts-check

import noForbiddenInConstructor from './rules/NoForbiddenInConstructor.mjs';
import noExternalListenersInConstructor from './rules/NoExternalListenersInConstructor.mjs';
import preferFieldInitializer from './rules/PreferFieldInitializer.mjs';
import requireListenerCleanup from './rules/RequireListenerCleanup.mjs';
import requireTypeParameter from './rules/RequireTypeParameter.mjs';
import requireSuperFirstInConstructor from './rules/RequireSuperFirstInConstructor.mjs';
import noKeypressEvent from './rules/NoKeypressEvent.mjs';

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
    'require-listener-cleanup': requireListenerCleanup,
    'no-keypress-event': noKeypressEvent,
  },
};

// Used by ESLint Config
// noinspection JSUnusedGlobalSymbols
export default Plugin;
