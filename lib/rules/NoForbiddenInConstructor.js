// @ts-check

/**
 * Rule: simbiat/no-forbidden-in-constructor
 *
 * Flags things the Custom Elements spec says you CANNOT do in a constructor:
 *
 *   • this.setAttribute(…) / this.toggleAttribute(…)
 *     – attribute creation before upgrade is forbidden
 *   • this.children / this.childNodes / this.firstChild / this.lastChild /
 *     this.firstElementChild / this.lastElementChild / this.childElementCount
 *     – child-element access (children are absent at construction time)
 *   • this.querySelector(…) / this.querySelectorAll(…) /
 *     this.getElementsByTagName(…) / this.getElementsByClassName(…) /
 *     this.getElementsByName(…)
 *     – child-element queries for the same reason
 *
 * Not flagged: this.shadowRoot.*, this.attachShadow(), this.getAttribute(),
 * this.removeAttribute(), appendChild onto shadow-root elements, event
 * listeners on shadow-scoped elements.
 *
 * The rule only activates on classes that extend HTMLElement (or configured
 * base classes). Nested functions are skipped – their execution is deferred.
 *
 * Options:
 *   baseClasses: string[] – additional class names to treat as HTMLElement.
 *                            Defaults to ['HTMLElement'].
 */

import { adaptNodeHandler } from '../utils/Adapters.js';
import {
  isActiveScope,
  buildScopeVisitors,
  baseClassesSchema,
} from '../utils/CustomElementsScope.js';

// Forbidden member sets

const FORBIDDEN_CHILD_PROPS = new Set([
  'children',
  'childNodes',
  'firstChild',
  'lastChild',
  'firstElementChild',
  'lastElementChild',
  'childElementCount',
]);

const FORBIDDEN_CHILD_METHODS = new Set([
  'querySelector',
  'querySelectorAll',
  'getElementsByTagName',
  'getElementsByClassName',
  'getElementsByName',
]);

const FORBIDDEN_ATTR_METHODS = new Set(['setAttribute', 'toggleAttribute']);

// Visitor handlers

function onCallExpression(state, node) {
  if (!isActiveScope(state)) {
    return;
  }
  const { callee } = node;
  if (callee.type !== 'MemberExpression') {
    return;
  }
  // Only flag `this.method(…)` – not `this.shadowRoot.method(…)` etc.
  if (callee.object.type !== 'ThisExpression') {
    return;
  }
  if (callee.property.type !== 'Identifier') {
    return;
  }

  const method = callee.property.name;

  if (FORBIDDEN_ATTR_METHODS.has(method)) {
    state.context.report({
      node,
      messageId: 'attrMethod',
      data: { method }
    });
  } else if (FORBIDDEN_CHILD_METHODS.has(method)) {
    state.context.report({
      node,
      messageId: 'childMethod',
      data: { method }
    });
  }
}

function onMemberExpression(state, node) {
  if (!isActiveScope(state)) {
    return;
  }
  // Only flag `this.prop` – not `this.shadowRoot.prop` etc.
  if (node.object.type !== 'ThisExpression') {
    return;
  }
  if (node.property.type !== 'Identifier') {
    return;
  }
  if (node.computed) {
    return; // skip this['children'] – unusual enough to ignore
  }

  const prop = node.property.name;
  if (FORBIDDEN_CHILD_PROPS.has(prop)) {
    state.context.report({
      node,
      messageId: 'childProp',
      data: { prop }
    });
  }
}

// Rule definition

const noForbiddenInConstructor = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow attribute creation and own-child access in Custom Element constructors.',
      url: 'https://html.spec.whatwg.org/multipage/custom-elements.html#custom-element-conformance',
    },
    messages: {
      attrMethod:
        'Do not call this.{{method}}() in the constructor – attributes cannot be reliably set before the element is upgraded. Move this to connectedCallback.',
      childProp:
        'Do not read this.{{prop}} in the constructor – child elements are not present until the element is connected. Move this to connectedCallback.',
      childMethod:
        'Do not call this.{{method}}() in the constructor – child elements cannot be queried before the element is connected. Move this to connectedCallback.',
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
      'CallExpression': adaptNodeHandler(state, onCallExpression),
      'MemberExpression': adaptNodeHandler(state, onMemberExpression),
    };
  },
};

export default noForbiddenInConstructor;
