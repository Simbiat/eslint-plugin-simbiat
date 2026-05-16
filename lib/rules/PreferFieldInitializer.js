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
 *   3. The RHS does NOT reference a local variable declared inside the
 *      constructor body because those values are also unavailable at
 *      the declaration site.
 *   4. The RHS does NOT contain `this.anything` – field-initializer ordering
 *      vs. constructor-assignment ordering can differ subtly, so those are
 *      left for the developer to evaluate.
 *
 * Only top-level assignment statements in the constructor body are checked.
 * Assignments inside if / else / for / for-of / for-in / while / do-while /
 * switch / try-catch blocks, or inside nested functions / arrow functions,
 * are intentionally ignored – they are conditional or deferred and cannot be
 * safely lifted to a field initializer.
 *
 * No auto-fix is provided: the change involves removing the assignment AND
 * updating the field declaration simultaneously; doing that incorrectly could
 * silently break the program.
 */

import { adaptNodeHandler, adaptStateHandler } from '../utils/Adapters.js';
import {
  collectFieldNames,
  collectParamNames,
  collectLocalNames,
  containsThisAccess,
  containsIdentifierRef,
} from '../utils/ASTHelpers.js';

// Stack helpers

/**
 * `True` only when the top of the stack is a constructor-method entry with no
 * intervening 'block' or 'fn' markers.  A 'block' marker is pushed whenever
 * we enter any control-flow statement (if / for / while / switch / try) so
 * that assignments inside those statements are correctly excluded.
 */
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

  // Collect constructor parameter names.
  const param_names = new Set();
  for (const param of node.value.params) {
    collectParamNames(param, param_names);
  }

  // Pre-scan the entire constructor body for local variable names so that
  // assignments whose RHS references a local (not just a parameter) are
  // correctly suppressed.  Pre-scanning at entry time means forward-declared
  // locals are also covered.
  const local_names = new Set();
  collectLocalNames(node.value.body, local_names);

  state.stack.push({
    kind: 'method',
    methodName: 'constructor',
    paramNames: param_names,
    localNames: local_names,
  });
}

function onMethodDefinitionExit(state) {
  if (state.stack[state.stack.length - 1]?.kind === 'method') {
    state.stack.pop();
  }
}

/**
 * Pushes a 'block' marker when entering any control-flow statement that is
 * directly inside a constructor or an already-nested block.  This makes
 * `isDirectlyInMethod` return false for any assignment inside an if / for /
 * while / switch / try body, which matches the documented behavior.
 */
function onControlFlowEnter(state) {
  const top = state.stack[state.stack.length - 1];
  if (top?.kind === 'method' || top?.kind === 'block') {
    state.stack.push({ kind: 'block' });
  }
}

function onControlFlowExit(state) {
  if (state.stack[state.stack.length - 1]?.kind === 'block') {
    state.stack.pop();
  }
}

function onFunctionExpression(state, node) {
  if (node.parent.type === 'MethodDefinition') {
    return;
  }
  const top = state.stack[state.stack.length - 1];
  if (top?.kind === 'method' || top?.kind === 'fn' || top?.kind === 'block') {
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
  if (top?.kind === 'method' || top?.kind === 'fn' || top?.kind === 'block') {
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
    right,
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
  if (containsIdentifierRef(right, method_state.localNames)) {
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
 *   { kind: 'method', methodName: string, paramNames: Set<string>, localNames: Set<string> }
 *   { kind: 'block' } ← inside a control-flow statement (if/for/while/switch/try)
 *   { kind: 'fn' } ← inside a nested function or arrow function
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
      stack: [],
    };

    // Control-flow statement types whose bodies must not be treated as
    // top-level constructor statements.
    const cf_enter = adaptStateHandler(state, onControlFlowEnter);
    const cf_exit = adaptStateHandler(state, onControlFlowExit);

    return {
      'ClassDeclaration': adaptNodeHandler(state, onClass),
      'ClassExpression': adaptNodeHandler(state, onClass),
      'ClassDeclaration:exit': adaptStateHandler(state, onClassExit),
      'ClassExpression:exit': adaptStateHandler(state, onClassExit),
      'MethodDefinition': adaptNodeHandler(state, onMethodDefinition),
      'MethodDefinition:exit': adaptStateHandler(state, onMethodDefinitionExit),

      // Control-flow blocks – push 'block' so assignments inside are ignored.
      'IfStatement': cf_enter,
      'IfStatement:exit': cf_exit,
      'ForStatement': cf_enter,
      'ForStatement:exit': cf_exit,
      'ForInStatement': cf_enter,
      'ForInStatement:exit': cf_exit,
      'ForOfStatement': cf_enter,
      'ForOfStatement:exit': cf_exit,
      'WhileStatement': cf_enter,
      'WhileStatement:exit': cf_exit,
      'DoWhileStatement': cf_enter,
      'DoWhileStatement:exit': cf_exit,
      'SwitchStatement': cf_enter,
      'SwitchStatement:exit': cf_exit,
      'TryStatement': cf_enter,
      'TryStatement:exit': cf_exit,

      // Nested functions / arrows – push 'fn' to suppress entirely.
      'FunctionExpression': adaptNodeHandler(state, onFunctionExpression),
      'FunctionExpression:exit': adaptNodeHandler(state, onFunctionExpressionExit),
      'ArrowFunctionExpression': adaptStateHandler(state, onArrowFunctionExpression),
      'ArrowFunctionExpression:exit': adaptStateHandler(state, onArrowFunctionExpressionExit),

      'AssignmentExpression': adaptNodeHandler(state, onAssignmentExpression),
    };
  },
};

export default preferFieldInitializer;
