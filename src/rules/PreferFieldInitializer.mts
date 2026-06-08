/**
 * @file Rule: simbiat/prefer-field-initializer.
 * Flags `this.x = expr` assignments in a class `constructor` where all the following hold:
 * 1. `x` already has a class field declaration (PropertyDefinition).
 * 2. The RHS does NOT reference a constructor parameter by name because those values are unavailable at a declaration site.
 * 3. The RHS does NOT reference a local variable declared inside the constructor body because those values are also unavailable at the declaration site.
 * 4. The RHS does NOT contain `this.anything` – field-initializer ordering versus constructor-assignment ordering can differ subtly, so those are left for the developer to evaluate.
 * Only top-level assignment statements in the constructor body are checked.
 * Assignments inside if / else / for / for-of / for-in / while / do-while / switch / try-catch blocks, or inside nested functions / arrow functions, are intentionally ignored – they are conditional or deferred and cannot be safely lifted to a field initializer.
 * No auto-fix is provided: the change involves removing the assignment AND updating the field declaration simultaneously; doing that incorrectly could silently break the program.
 */

import type { Rule } from 'eslint';
import { adaptNodeHandler, adaptStateHandler } from '../utils/Adapters.mjs';
import {
  collectFieldNames,
  collectParamNames,
  collectLocalNames,
  containsThisAccess,
  containsIdentifierRef,
} from '../utils/ASTHelpers.mjs';

// Types

/** Stack entry for a class scope. */
interface ClassEntry {
  readonly kind: 'class'
  readonly fieldNames: Set<string>
  readonly node: unknown
}

/** Stack entry for a constructor method scope. */
interface MethodEntry {
  readonly kind: 'method'
  readonly methodName: string
  readonly paramNames: Set<string>
  readonly localNames: Set<string>
}

/** Stack entry for a control-flow block (if/for/while/switch/try). */
interface BlockEntry {
  readonly kind: 'block'
}

/** Stack entry for a nested function or arrow function. */
interface FnEntry {
  readonly kind: 'fn'
}

/** Union of all possible stack entry types. */
type StackEntry = BlockEntry | ClassEntry | FnEntry | MethodEntry;

/** Rule state object. */
interface RuleState {
  readonly context: Rule.RuleContext
  readonly stack: StackEntry[]
}

/** Minimal shape of a MethodDefinition node as used by this rule. */
interface MethodDefinitionNode {
  readonly kind: string
  readonly parent?: { readonly parent?: unknown }
  readonly value: {
    readonly params: readonly unknown[]
    readonly body: unknown
  }
}

/** Minimal shape of an AssignmentExpression node as used by this rule. */
interface AssignmentNode {
  readonly operator: string
  readonly left: {
    readonly type: string
    readonly object: { readonly type: string }
    readonly property: {
      readonly type: string
      readonly name: string
    }
    readonly computed: boolean
  }
  readonly right: unknown
}

/** Minimal shape of a FunctionExpression node as used by this rule. */
interface FunctionExpressionNode {
  readonly parent?: { readonly type: string }
}

// Stack helpers

/**
 * `True` only when the top of the stack is a constructor-method entry with no
 * intervening 'block' or 'fn' markers.
 * @param stack - Current stack array.
 * @returns True when the top stack entry is a constructor method.
 */
function isDirectlyInMethod(stack: StackEntry[]): boolean {
  return stack[stack.length - 1]?.kind === 'method';
}

/**
 * Returns the field-name set of the class that owns the current method.
 * @param stack - Current stack array.
 * @returns Set of field names from the nearest enclosing class entry.
 */
function currentFieldNames(stack: StackEntry[]): Set<string> {
  for (let i = stack.length - 1; i >= 0; i--) {
    // eslint-disable-next-line security/detect-object-injection
    const entry = stack[i];
    if (entry?.kind === 'class') {
      return entry.fieldNames;
    }
  }
  return new Set<string>();
}

// Visitor handlers

/**
 * Pushes a 'class' entry when entering a class.
 * @param state - Rule state.
 * @param node - Class declaration or expression node (as unknown from ESLint).
 */
function onClass(state: RuleState, node: unknown): void {
  state.stack.push({
    kind: 'class',
    fieldNames: collectFieldNames(node),
    node,
  });
}

/**
 * Pops the 'class' entry when leaving a class.
 * @param state - Rule state.
 */
function onClassExit(state: RuleState): void {
  if (state.stack[state.stack.length - 1]?.kind === 'class') {
    state.stack.pop();
  }
}

/**
 * Pushes a 'method' entry when entering a constructor MethodDefinition.
 * @param state - Rule state.
 * @param node - MethodDefinition node (as unknown from ESLint).
 */
function onMethodDefinition(state: RuleState, node: unknown): void {
  const method = node as MethodDefinitionNode;
  const top = state.stack[state.stack.length - 1];
  if (top?.kind !== 'class') {
    return;
  }
  if (top.node !== method.parent?.parent) {
    return;
  }
  if (method.kind !== 'constructor') {
    return;
  }

  // Collect constructor parameter names.
  const param_names = new Set<string>();
  for (const param of method.value.params) {
    collectParamNames(param, param_names);
  }

  // Pre-scan the entire constructor body for local variable names.
  const local_names = new Set<string>();
  collectLocalNames(method.value.body, local_names);

  state.stack.push({
    kind: 'method',
    methodName: 'constructor',
    paramNames: param_names,
    localNames: local_names,
  });
}

/**
 * Pops the 'method' entry when leaving a MethodDefinition.
 * @param state - Rule state.
 */
function onMethodDefinitionExit(state: RuleState): void {
  if (state.stack[state.stack.length - 1]?.kind === 'method') {
    state.stack.pop();
  }
}

/**
 * Pushes a 'block' marker when entering any control-flow statement.
 * @param state - Rule state.
 */
function onControlFlowEnter(state: RuleState): void {
  const top = state.stack[state.stack.length - 1];
  if (top?.kind === 'method' || top?.kind === 'block') {
    state.stack.push({ kind: 'block' });
  }
}

/**
 * Pops the 'block' marker when leaving a control-flow statement.
 * @param state - Rule state.
 */
function onControlFlowExit(state: RuleState): void {
  if (state.stack[state.stack.length - 1]?.kind === 'block') {
    state.stack.pop();
  }
}

/**
 * Pushes "fn" marker when entering a FunctionExpression that is not a method.
 * @param state - Rule state.
 * @param node - FunctionExpression node (as unknown from ESLint).
 */
function onFunctionExpression(state: RuleState, node: unknown): void {
  const fn = node as FunctionExpressionNode;
  if (fn.parent?.type === 'MethodDefinition') {
    return;
  }
  const top = state.stack[state.stack.length - 1];
  if (top?.kind === 'method' || top?.kind === 'fn' || top?.kind === 'block') {
    state.stack.push({ kind: 'fn' });
  }
}

/**
 * Pops the 'fn' marker when leaving a FunctionExpression.
 * @param state - Rule state.
 * @param node - FunctionExpression node (as unknown from ESLint).
 */
function onFunctionExpressionExit(state: RuleState, node: unknown): void {
  const fn = node as FunctionExpressionNode;
  if (fn.parent?.type === 'MethodDefinition') {
    return;
  }
  if (state.stack[state.stack.length - 1]?.kind === 'fn') {
    state.stack.pop();
  }
}

/**
 * Pushes "fn" marker when entering an ArrowFunctionExpression inside a method.
 * @param state - Rule state.
 */
function onArrowFunctionExpression(state: RuleState): void {
  const top = state.stack[state.stack.length - 1];
  if (top?.kind === 'method' || top?.kind === 'fn' || top?.kind === 'block') {
    state.stack.push({ kind: 'fn' });
  }
}

/**
 * Pops the 'fn' marker when leaving an ArrowFunctionExpression.
 * @param state - Rule state.
 */
function onArrowFunctionExpressionExit(state: RuleState): void {
  if (state.stack[state.stack.length - 1]?.kind === 'fn') {
    state.stack.pop();
  }
}

/**
 * Reports `this.x = expr` assignments where x is a declared field
 * whose initializer could be moved to the field declaration.
 * @param state - Rule state.
 * @param node - AssignmentExpression node to inspect (as unknown from ESLint).
 */
function onAssignmentExpression(state: RuleState, node: unknown): void {
  if (!isDirectlyInMethod(state.stack)) {
    return;
  }
  const assign = node as AssignmentNode;
  if (assign.operator !== '=') {
    return;
  }
  const {
    left,
    right,
  } = assign;
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
  if (method_state?.kind !== 'method') {
    return;
  }
  if (containsIdentifierRef(right, method_state.paramNames)) {
    return;
  }
  if (containsIdentifierRef(right, method_state.localNames)) {
    return;
  }
  state.context.report({
    node: node as Rule.Node,
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
 * { kind: 'class', fieldNames: Set<string>, node: ClassNode }
 * { kind: 'method', methodName: string, paramNames: Set<string>, localNames: Set<string> }
 * { kind: 'block' } ← inside a control-flow statement (if/for/while/switch/try)
 * { kind: 'fn' } ← inside a nested function or arrow function.
 */
const preferFieldInitializer: Rule.RuleModule = {
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
    hasSuggestions: false,
  },

  /**
   * Create rule.
   * @param context - Context to process.
   */
  create(context: Rule.RuleContext): Rule.RuleListener {
    const state: RuleState = {
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
