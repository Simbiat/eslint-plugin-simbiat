// @ts-check

/**
 * Rule: simbiat/prefer-field-initializer
 *
 * Flags `this.x = expr` assignments in a class `constructor` where all
 * the following hold:
 *
 *   1. `x` already has a class field declaration (PropertyDefinition).
 *   2. The RHS does NOT reference a constructor parameter by name because
 *      those values are unavailable at a declaration site.
 *   3. The RHS does NOT contain `this.anything` – field-initializer ordering
 *      vs. constructor-assignment ordering can differ subtly, so those are
 *      left for the developer to evaluate.
 *
 * Only top-level assignment statements in the constructor body are checked.
 * Assignments inside if/for/while blocks, ternaries, or nested functions are
 * intentionally ignored – they are conditional or deferred and cannot be
 * safely lifted.
 *
 * Known limitation: references to local variables defined earlier in the
 * constructor body (not parameters) are not detected and may produce false
 * positives. Suppress with `// eslint-disable-next-line` where needed.
 *
 * No auto-fix is provided: the change involves removing the assignment AND
 * updating the field declaration simultaneously; doing that incorrectly could
 * silently break the program.
 */

import { adaptNodeHandler, adaptStateHandler } from '../utils/Adapters.js';
import {
  collectFieldNames,
  collectParamNames,
  containsThisAccess,
  containsIdentifierRef,
} from '../utils/ASTHelpers.js';

// Stack helpers

/** `True` only when the top of the stack is a constructor method (no nesting). */
function isDirectlyInMethod(stack) {
  return stack[stack.length - 1]?.kind === 'method';
}

/** Returns the field-name set of the class that owns the current method. */
function currentFieldNames(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind === 'class') {
      return stack[i].fieldNames;
    }
  }
  return new Set();
}

// Visitor handlers

function onClass(state, node) {
  state.stack.push({
    kind: 'class',
    fieldNames: collectFieldNames(node),
    node,
  });
}

function onClassExit(state) {
  if (state.stack[state.stack.length - 1]?.kind === 'class') {
    state.stack.pop();
  }
}

function onMethodDefinition(state, node) {
  const top = state.stack[state.stack.length - 1];
  if (top?.kind !== 'class') {
    return;
  }
  if (top.node !== node.parent?.parent) {
    return;
  }
  if (node.kind !== 'constructor') {
    return;
  }
  const param_names = new Set();
  for (const param of node.value.params) {
    collectParamNames(param, param_names);
  }
  state.stack.push({
    kind: 'method',
    methodName: 'constructor',
    paramNames: param_names,
  });
}

function onMethodDefinitionExit(state) {
  if (state.stack[state.stack.length - 1]?.kind === 'method') {
    state.stack.pop();
  }
}

function onFunctionExpression(state, node) {
  if (node.parent.type === 'MethodDefinition') {
    return;
  }
  const top = state.stack[state.stack.length - 1];
  if (top?.kind === 'method' || top?.kind === 'fn') {
    state.stack.push({ kind: 'fn' });
  }
}

function onFunctionExpressionExit(state, node) {
  if (node.parent.type === 'MethodDefinition') {
    return;
  }
  if (state.stack[state.stack.length - 1]?.kind === 'fn') {
    state.stack.pop();
  }
}

function onArrowFunctionExpression(state) {
  const top = state.stack[state.stack.length - 1];
  if (top?.kind === 'method' || top?.kind === 'fn') {
    state.stack.push({ kind: 'fn' });
  }
}

function onArrowFunctionExpressionExit(state) {
  if (state.stack[state.stack.length - 1]?.kind === 'fn') {
    state.stack.pop();
  }
}

function onAssignmentExpression(state, node) {
  if (!isDirectlyInMethod(state.stack)) {
    return;
  }
  if (node.operator !== '=') {
    return;
  }
  const {
    left,
    right
  } = node;
  if (left.type !== 'MemberExpression') {
    return;
  }
  if (left.object.type !== 'ThisExpression') {
    return;
  }
  if (left.property.type !== 'Identifier') {
    return;
  }
  if (left.computed) {
    return;
  }
  const prop_name = left.property.name;
  if (!currentFieldNames(state.stack)
    .has(prop_name)) {
    return;
  }
  if (containsThisAccess(right)) {
    return;
  }
  const method_state = state.stack[state.stack.length - 1];
  if (containsIdentifierRef(right, method_state.paramNames)) {
    return;
  }
  state.context.report({
    node,
    messageId: 'preferInitializer',
    data: {
      name: prop_name,
      method: method_state.methodName,
    },
  });
}

// Rule definition

/**
 * Stack entry shapes:
 *   { kind: 'class', fieldNames: Set<string>, node: ClassNode }
 *   { kind: 'method', methodName: string, paramNames: Set<string> }
 *   { kind: 'fn' } ← nested function / arrow inside constructor
 */
const preferFieldInitializer = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Suggest moving this.x = … assignments in constructor to class field initializers.',
    },
    messages: {
      preferInitializer:
        '\'{{name}}\' is declared as a class field. Move its initializer to the field declaration instead of assigning it in {{method}}.',
    },
    schema: [],
    fixable: null,
    hasSuggestions: false,
  },

  create(context) {
    const state = {
      context,
      stack: []
    };

    return {
      'ClassDeclaration': adaptNodeHandler(state, onClass),
      'ClassExpression': adaptNodeHandler(state, onClass),
      'ClassDeclaration:exit': adaptStateHandler(state, onClassExit),
      'ClassExpression:exit': adaptStateHandler(state, onClassExit),
      'MethodDefinition': adaptNodeHandler(state, onMethodDefinition),
      'MethodDefinition:exit': adaptStateHandler(state, onMethodDefinitionExit),
      'FunctionExpression': adaptNodeHandler(state, onFunctionExpression),
      'FunctionExpression:exit': adaptNodeHandler(state, onFunctionExpressionExit),
      'ArrowFunctionExpression': adaptStateHandler(state, onArrowFunctionExpression),
      'ArrowFunctionExpression:exit': adaptStateHandler(state, onArrowFunctionExpressionExit),
      'AssignmentExpression': adaptNodeHandler(state, onAssignmentExpression),
    };
  },
};

export default preferFieldInitializer;
