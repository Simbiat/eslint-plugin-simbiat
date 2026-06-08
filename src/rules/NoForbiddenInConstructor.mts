/**
 * @file Rule: simbiat/no-forbidden-in-constructor.
 *
 * Flags everything the Custom Elements spec says you cannot or should not do
 * during the construction phase — both in the constructor body and in instance
 * field initializers (which run as part of construction, before the element
 * is connected).
 *
 * Attribute / property writes: any `this.x = value` assignment where `x` is not declared as a class field (PropertyDefinition) in the current class body is flagged.
 *
 * DOMTokenList mutation: this.classList.add / remove / toggle / replace (…), this.part.add / remove / toggle / replace (…)
 *
 * Chained attribute / style writes: this.dataset.<key> = value / this.style.<prop> = value
 *
 * Method-based attribute manipulation: this.setAttribute(…) / this.toggleAttribute(…)
 *
 * Child / content access (reads and mutations via children-related properties
 * and methods such as querySelector, appendChild, innerHTML, etc.)
 *
 * Forbidden global calls: document.write(…) / document.open(…)
 *
 * Illegal return (constructor only): any `return <expr>` that is not a bare `return` or `return this`.
 *
 * Options: baseClasses: string[] – additional class names to treat as HTMLElement. Defaults to ['HTMLElement'].
 */

import type { Rule } from 'eslint';
import { adaptNodeHandler } from '../utils/Adapters.mjs';
import {
  isActiveScope,
  getActiveScopeLocation,
  getClassFieldNames,
  buildScopeVisitors,
  baseClassesSchema,
  type ScopeState,
} from '../utils/CustomElementsScope.mjs';

// Types

/** Rule options shape for the baseClasses option. */
interface RuleOptions {
  readonly baseClasses?: readonly string[]
}

/** Extended state including the ESLint rule context. */
interface RuleState extends ScopeState {
  readonly context: Rule.RuleContext
}

/** Minimal MemberExpression node shape. */
interface MemberNode {
  readonly type: string
  readonly object: {
    readonly type: string
    readonly name?: string
  }
  readonly property: {
    readonly type: string
    readonly name: string
  }
  readonly computed: boolean
}

/** Minimal AssignmentExpression node shape. */
interface AssignmentNode {
  readonly operator: string
  readonly left: MemberNode & { readonly object: MemberNode & { readonly type: string } }
}

/** Minimal ReturnStatement node shape. */
interface ReturnNode {
  readonly argument: { readonly type: string } | null
}

/** Minimal CallExpression node shape. */
interface CallNode {
  readonly callee: MemberNode & {
    readonly object: MemberNode & { readonly type: string }
  }
}

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

/** DOMTokenList-typed properties whose mutating methods set reflected attrs. */
const TOKEN_LIST_PROPS = new Set(['classList', 'part']);

/** Mutating methods on DOMTokenList instances. */
const TOKEN_LIST_MUTATING_METHODS = new Set(['add', 'remove', 'toggle', 'replace']);

/**
 * Properties whose subproperties correspond to HTML attributes or CSS: dataset → data-* attributes / style → inline CSS properties.
 */
const CHAINED_WRITE_PROPS = new Set(['dataset', 'style']);

/** Calling document.x() where x is in this set is forbidden. */
const FORBIDDEN_DOCUMENT_METHODS = new Set(['write', 'open']);

// Visitor handlers

/**
 * Reports forbidden method calls on `this`, DOMTokenList members, or document.
 * @param state - Rule state including ESLint context and scope stack.
 * @param node - CallExpression node to inspect (as unknown from ESLint).
 */
function onCallExpression(state: RuleState, node: unknown): void {
  if (!isActiveScope(state)) {
    return;
  }
  const call = node as CallNode;
  const { callee } = call;
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
        node: node as Rule.Node,
        messageId: 'attrMethod',
        data: {
          method,
          location: getActiveScopeLocation(state),
        },
      });
    } else if (FORBIDDEN_CHILD_METHODS.has(method)) {
      state.context.report({
        node: node as Rule.Node,
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
      node: node as Rule.Node,
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
      node: node as Rule.Node,
      messageId: 'documentMethod',
      data: {
        method: callee.property.name,
        location: getActiveScopeLocation(state),
      },
    });
  }
}

/**
 * Flags reads of forbidden own-child properties on `this`.
 * @param state - Rule state including ESLint context and scope stack.
 * @param node - MemberExpression node to inspect (as unknown from ESLint).
 */
function onMemberExpression(state: RuleState, node: unknown): void {
  if (!isActiveScope(state)) {
    return;
  }
  const mem = node as MemberNode;
  // Only flag `this.prop` - not `this.shadowRoot.prop` etc.
  if (mem.object.type !== 'ThisExpression') {
    return;
  }
  if (mem.property.type !== 'Identifier') {
    return;
  }
  if (mem.computed) {
    return; // skip this['children'] - unusual enough to ignore
  }

  const prop = mem.property.name;
  if (FORBIDDEN_CHILD_PROPS.has(prop)) {
    state.context.report({
      node: node as Rule.Node,
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
 * 1. This.<contentProp> = … e.g., this.innerHTML = '<div>'
 * 2. `this.<anything>` = … where <anything> is not a declared class field
 * 3. This.dataset.<key> = … / this.style.<prop> = ….
 * Only simple `=` assignments; compound operators (+=, |=, …) are left alone.
 * @param state - Rule state including ESLint context and scope stack.
 * @param node - AssignmentExpression node to inspect (as unknown from ESLint).
 */
function onAssignmentExpression(state: RuleState, node: unknown): void {
  if (!isActiveScope(state)) {
    return;
  }
  const assign = node as AssignmentNode;
  if (assign.operator !== '=') {
    return;
  }
  const { left } = assign;
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
        node: node as Rule.Node,
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
        node: node as Rule.Node,
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
      node: node as Rule.Node,
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
 * constructor body, unless it is a simple early-return (return or return this)".
 * @param state - Rule state including ESLint context and scope stack.
 * @param node - ReturnStatement node to inspect (as unknown from ESLint).
 */
function onReturnStatement(state: RuleState, node: unknown): void {
  if (!isActiveScope(state)) {
    return;
  }
  const ret = node as ReturnNode;
  if (ret.argument === null) {
    return; // bare `return;` is fine
  }
  if (ret.argument?.type === 'ThisExpression') {
    return; // `return this;` is fine
  }
  state.context.report({
    node: node as Rule.Node,
    messageId: 'illegalReturn',
  });
}

// Rule definition

const noForbiddenInConstructor: Rule.RuleModule = {
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
    hasSuggestions: false,
  },

  /**
   * Creates rule.
   * @param context - Context to process.
   */
  create(context: Rule.RuleContext): Rule.RuleListener {
    const options = context.options[0] as RuleOptions | undefined;
    const state: RuleState = {
      context,
      stack: [],
      base_classes: options?.baseClasses ?? ['HTMLElement'],
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
