// @ts-check

/**
 * Rule: simbiat/no-forbidden-in-constructor
 *
 * Flags everything the Custom Elements spec says you cannot or should not do
 * during the construction phase — both in the constructor body and in instance
 * field initializers (which run as part of construction, before the element
 * is connected).
 *
 * Attribute / property writes
 *   Any `this.x = value` assignment where `x` is not declared as a class
 *   field (PropertyDefinition) in the current class body is flagged.
 *
 *   This intentionally covers all reflected HTML content attributes
 *   (id, className, title, tabIndex, dir, lang, hidden, draggable, …),
 *   all ARIA IDL attributes (ariaLabel, ariaHidden, ariaRole, …),
 *   all per-element IDL attributes (href, src, value, type, …),
 *   all event-handler properties (onclick, oninput, …), etc.
 *   without requiring a static list.
 *
 *   Well-known content-modifying properties (innerHTML, outerHTML,
 *   textContent, innerText) are reported with a more specific message.
 *
 * DOMTokenList mutation
 *   • this.classList.add / remove / toggle / replace (…)
 *   • this.part.add / remove / toggle / replace (…)
 *     - these modify reflected attribute values via a DOMTokenList proxy
 *
 * Chained attribute / style writes
 *   • this.dataset.<key> = value - sets a data-* attribute
 *   • this.style.<prop> = value - sets an inline CSS property
 *
 * Method-based attribute manipulation
 *   • this.setAttribute(…) / this.toggleAttribute(…)
 *
 * Child / content access
 *   (read) this.children / childNodes / firstChild / lastChild /
 *          firstElementChild / lastElementChild / childElementCount
 *   (call) this.querySelector / querySelectorAll / getElementsByTagName /
 *          getElementsByClassName / getElementsByName /
 *          appendChild / insertBefore / replaceChild / removeChild /
 *          append / prepend / replaceChildren /
 *          insertAdjacentHTML / insertAdjacentElement / insertAdjacentText /
 *          after / before / replaceWith / remove
 *
 * Forbidden global calls
 *   • document.write(…) / document.open(…)
 *
 * Illegal return (constructor only)
 *   • Any `return <expr>` that is not a bare `return` or `return this`
 *   (A bare return inside a field initializer is a syntax error; nested
 *   function returns are suppressed by the 'fn' scope marker.)
 *
 * Not flagged: this.shadowRoot.*, this.attachShadow(), this.getAttribute(),
 * this.removeAttribute(), appending to shadow-root elements, shadow-scoped
 * event listeners.
 *
 * Nested functions and arrow functions are skipped in all cases.
 * Static field initializers are skipped (they run at class definition time,
 * not at element construction time).
 *
 * Options:
 *   baseClasses: string[] - additional class names to treat as HTMLElement.
 *                            Defaults to ['HTMLElement'].
 */

import { adaptNodeHandler } from '../utils/adapters.js';
import {
  isActiveScope,
  getActiveScopeLocation,
  getClassFieldNames,
  buildScopeVisitors,
  baseClassesSchema,
} from '../utils/CustomElementsScope.js';

// Static member sets

/**
 * Reading any of these own-child properties is forbidden during construction
 * (child elements are absent until the element is connected).
 *
 * These are READ checks via onMemberExpression. Assignments to them would
 * also be caught by the "not a class field" write check, but we skip them
 * there to avoid double reports.
 */
const FORBIDDEN_CHILD_PROPS = new Set([
  'children',
  'childNodes',
  'firstChild',
  'lastChild',
  'firstElementChild',
  'lastElementChild',
  'childElementCount',
]);

/**
 * Calling any of these on `this` is forbidden during construction.
 * Covers: child queries, all DOM-mutation methods that gain / rearrange /
 * remove children, and ChildNode self-manipulation methods.
 */
const FORBIDDEN_CHILD_METHODS = new Set([
  // child queries
  'querySelector',
  'querySelectorAll',
  'getElementsByTagName',
  'getElementsByClassName',
  'getElementsByName',
  // classic DOM mutation
  'appendChild',
  'insertBefore',
  'replaceChild',
  'removeChild',
  // ParentNode / Element convenience
  'append',
  'prepend',
  'replaceChildren',
  // adjacent insertion
  'insertAdjacentHTML',
  'insertAdjacentElement',
  'insertAdjacentText',
  // ChildNode self-manipulation (no parent exists during construction)
  'after',
  'before',
  'replaceWith',
  'remove',
]);

/** Calling these attribute-manipulation methods on `this` is forbidden. */
const FORBIDDEN_ATTR_METHODS = new Set(['setAttribute', 'toggleAttribute']);

/**
 * Writing to any of these properties replaces or deeply modifies element
 * content. Reported with a specific message rather than the generic one.
 */
const FORBIDDEN_CONTENT_PROP_WRITES = new Set([
  'innerHTML',
  'outerHTML',
  'textContent',
  'innerText',
]);

/**
 * DOMTokenList-typed properties whose mutating methods set reflected attrs.
 */
const TOKEN_LIST_PROPS = new Set(['classList', 'part']);

/** Mutating methods on DOMTokenList instances. */
const TOKEN_LIST_MUTATING_METHODS = new Set(['add', 'remove', 'toggle', 'replace']);

/**
 * Properties whose subproperties correspond to HTML attributes or CSS:
 *   dataset → data-* attributes
 *   style → inline CSS properties
 */
const CHAINED_WRITE_PROPS = new Set(['dataset', 'style']);

/** Calling document.x() where x is in this set is forbidden. */
const FORBIDDEN_DOCUMENT_METHODS = new Set(['write', 'open']);

// Visitor handlers

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

  // this.method(…)
  if (callee.object.type === 'ThisExpression') {
    const method = callee.property.name;
    if (FORBIDDEN_ATTR_METHODS.has(method)) {
      state.context.report({
        node,
        messageId: 'attrMethod',
        data: {
          method,
          location: getActiveScopeLocation(state),
        },
      });
    } else if (FORBIDDEN_CHILD_METHODS.has(method)) {
      state.context.report({
        node,
        messageId: 'childMethod',
        data: {
          method,
          location: getActiveScopeLocation(state),
        },
      });
    }
    return;
  }

  // this.classList.add / this.part.remove / …
  if (
    callee.object.type === 'MemberExpression'
    && !callee.object.computed
    && callee.object.object.type === 'ThisExpression'
    && callee.object.property.type === 'Identifier'
    && TOKEN_LIST_PROPS.has(callee.object.property.name)
    && TOKEN_LIST_MUTATING_METHODS.has(callee.property.name)
  ) {
    state.context.report({
      node,
      messageId: 'tokenListMutation',
      data: {
        prop: callee.object.property.name,
        method: callee.property.name,
        location: getActiveScopeLocation(state),
      },
    });
    return;
  }

  // document.write(…) / document.open(…)
  if (
    callee.object.type === 'Identifier'
    && callee.object.name === 'document'
    && FORBIDDEN_DOCUMENT_METHODS.has(callee.property.name)
  ) {
    state.context.report({
      node,
      messageId: 'documentMethod',
      data: {
        method: callee.property.name,
        location: getActiveScopeLocation(state),
      },
    });
  }
}

/** Flags reads of forbidden own-child properties. */
function onMemberExpression(state, node) {
  if (!isActiveScope(state)) {
    return;
  }
  // Only flag `this.prop` - not `this.shadowRoot.prop` etc.
  if (node.object.type !== 'ThisExpression') {
    return;
  }
  if (node.property.type !== 'Identifier') {
    return;
  }
  if (node.computed) {
    return; // skip this['children'] - unusual enough to ignore
  }

  const prop = node.property.name;
  if (FORBIDDEN_CHILD_PROPS.has(prop)) {
    state.context.report({
      node,
      messageId: 'childProp',
      data: {
        prop,
        location: getActiveScopeLocation(state),
      },
    });
  }
}

/**
 * Flags three categories of write during construction:
 *
 *   1. this.<contentProp> = … e.g., this.innerHTML = '<div>'
 *      → contentPropWrite message
 *
 *   2. `this.<anything>` = … where <anything> is not a declared class field
 *      → undeclaredPropWrite message
 *      Covers every reflected HTML attribute, ARIA IDL property, per-element
 *      attribute, event-handler property, and any other undeclared property.
 *
 *   3. this.dataset.<key> = … / this.style.<prop> = …
 *      → chainedPropWrite message
 *
 * Only simple `=` assignments; compound operators (+=, |=, …) are left alone.
 */
function onAssignmentExpression(state, node) {
  if (!isActiveScope(state)) {
    return;
  }
  if (node.operator !== '=') {
    return;
  }
  const { left } = node;
  if (left.type !== 'MemberExpression') {
    return;
  }

  // Branch 1: this.prop = value
  if (
    !left.computed
    && left.object.type === 'ThisExpression'
    && left.property.type === 'Identifier'
  ) {
    const prop = left.property.name;
    const location = getActiveScopeLocation(state);

    if (FORBIDDEN_CONTENT_PROP_WRITES.has(prop)) {
      state.context.report({
        node,
        messageId: 'contentPropWrite',
        data: {
          prop,
          location,
        },
      });
      return;
    }

    // Avoid double-reporting what onMemberExpression already flags as childProp.
    if (FORBIDDEN_CHILD_PROPS.has(prop)) {
      return;
    }

    // Everything else that is not an explicit class field is potentially a
    // reflected HTML/ARIA attribute (or state that should be declared).
    if (!getClassFieldNames(state)
      .has(prop)) {
      state.context.report({
        node,
        messageId: 'undeclaredPropWrite',
        data: {
          prop,
          location,
        },
      });
    }
    return;
  }

  // Branch 2: this.dataset.<key> = value / this.style.<prop> = value
  if (
    left.object.type === 'MemberExpression'
    && !left.object.computed
    && left.object.object.type === 'ThisExpression'
    && left.object.property.type === 'Identifier'
    && CHAINED_WRITE_PROPS.has(left.object.property.name)
  ) {
    state.context.report({
      node,
      messageId: 'chainedPropWrite',
      data: {
        prop: left.object.property.name,
        location: getActiveScopeLocation(state),
      },
    });
  }
}

/**
 * Flags `return <expr>` inside the constructor unless the expression is
 * absent (`return;`) or is exactly `this` (`return this;`).
 *
 * Per spec: "A return statement must not appear anywhere inside the
 * constructor body, unless it is a simple early-return (return or return this)."
 *
 * This handler naturally only fires for constructor scope: a bare `return`
 * in a field initializer is a syntax error, and nested function returns are
 * suppressed by the 'fn' scope marker.
 */
function onReturnStatement(state, node) {
  if (!isActiveScope(state)) {
    return;
  }
  const { argument } = node;
  if (argument === null) {
    return; // bare `return;` is fine
  }
  if (argument.type === 'ThisExpression') {
    return; // `return this;` is fine
  }
  state.context.report({
    node,
    messageId: 'illegalReturn',
  });
}

// Rule definition

const noForbiddenInConstructor = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow spec-forbidden operations in Custom Element constructors and field initializers.',
      url: 'https://html.spec.whatwg.org/multipage/custom-elements.html#custom-element-conformance',
    },
    messages: {
      attrMethod:
        'Do not call this.{{method}}() in {{location}} - attributes cannot be reliably set before the element is upgraded. Move this to connectedCallback.',
      childProp:
        'Do not read this.{{prop}} in {{location}} - child elements are not present until the element is connected. Move this to connectedCallback.',
      childMethod:
        'Do not call this.{{method}}() in {{location}} - child elements cannot be accessed or modified before the element is connected. Move this to connectedCallback.',
      contentPropWrite:
        'Do not assign to this.{{prop}} in {{location}} - this modifies element content before it is connected. Move this to connectedCallback.',
      undeclaredPropWrite:
        'this.{{prop}} is not declared as a class field (found in {{location}}). '
        + 'If \'{{prop}}\' is a reflected HTML or ARIA attribute, move this assignment to connectedCallback. '
        + 'If it is custom element state, declare it as a class field instead.',
      tokenListMutation:
        'Do not call this.{{prop}}.{{method}}() in {{location}} - this modifies a reflected attribute. Move this to connectedCallback.',
      chainedPropWrite:
        'Do not write to this.{{prop}} properties in {{location}} - this modifies element attributes or styles. Move this to connectedCallback.',
      documentMethod:
        'Do not call document.{{method}}() in {{location}} - this is explicitly forbidden by the Custom Elements spec.',
      illegalReturn:
        'The constructor must not return a value other than undefined or this.',
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
      MemberExpression: adaptNodeHandler(state, onMemberExpression),
      AssignmentExpression: adaptNodeHandler(state, onAssignmentExpression),
      ReturnStatement: adaptNodeHandler(state, onReturnStatement),
    };
  },
};

export default noForbiddenInConstructor;
