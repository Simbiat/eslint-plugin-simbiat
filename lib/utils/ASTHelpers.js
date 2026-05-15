// @ts-check

/**
 * AST helper utilities for the prefer-field-initializer rule.
 */

// Field / parameter name collection

/**
 * Collects all declared field names (PropertyDefinition keys) from a class
 * node's body into a `Set<string>`.
 *
 * @param {any} class_node
 * @returns {Set<string>}
 */
export function collectFieldNames(class_node) {
  const names = new Set();
  for (const member of class_node.body.body) {
    if (member.type !== 'PropertyDefinition') {
      continue;
    }
    const key = member.key;
    let name;
    if (key.type === 'Identifier') {
      name = key.name;
    } else if (key.type === 'Literal') {
      name = String(key.value);
    } else {
      name = null;
    }
    if (name) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Recursively collects all binding names introduced by a parameter node into
 * `out`. Handles: Identifier, AssignmentPattern, RestElement, ObjectPattern,
 * ArrayPattern, and TypeScript's TSParameterProperty.
 *
 * @param {any} param
 * @param {Set<string>} out
 */
export function collectParamNames(param, out) {
  if (!param) {
    return;
  }
  switch (param.type) {
    case 'Identifier':
      out.add(param.name);
      break;
    case 'AssignmentPattern':
      collectParamNames(param.left, out);
      break;
    case 'RestElement':
      collectParamNames(param.argument, out);
      break;
    case 'ObjectPattern':
      for (const prop of param.properties) {
        collectParamNames(prop.type === 'RestElement' ? prop : prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of param.elements) {
        collectParamNames(el, out); // el may be null for holes
      }
      break;
    case 'TSParameterProperty':
      // TypeScript: constructor(private foo: string) – foo is both param and field.
      collectParamNames(param.parameter, out);
      break;
    default:
      break;
  }
}

// AST traversal predicates

/** Keys that should never be traversed as child AST nodes. */
const SKIP_KEYS = new Set(['type', 'parent', 'loc', 'range', 'start', 'end']);

/**
 * Returns true if `node` (or any descendant) is a MemberExpression whose
 * object is a ThisExpression, e.g. `this.foo`.
 *
 * Does NOT recurse into regular FunctionExpression / FunctionDeclaration
 * because `this` is rebound there. DOES recurse into ArrowFunctionExpression
 * because arrow functions inherit `this` lexically.
 *
 * @param {any} node
 * @returns {boolean}
 */
export function containsThisAccess(node) {
  if (!node || typeof node !== 'object') {
    return false;
  }
  // `this` is rebound in regular functions – stop recursing.
  if (
    node.type === 'FunctionExpression'
    || node.type === 'FunctionDeclaration'
  ) {
    return false;
  }
  if (
    node.type === 'MemberExpression'
    && node.object
    && node.object.type === 'ThisExpression'
  ) {
    return true;
  }
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (containsThisAccess(child)) {
          return true;
        }
      }
    } else if (
      val !== null
      && typeof val === 'object'
      && typeof val.type === 'string'
      && containsThisAccess(val)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if `node` (or any descendant) contains an Identifier whose
 * name is in `names`.
 *
 * Same `this`-rebinding rules as `containsThisAccess`.
 * Stops at non-computed property keys in MemberExpression and Property to
 * avoid false positives on `{ foo: bar }` or `obj.foo` where `foo` ∈ names.
 *
 * @param {any} node
 * @param {Set<string>} names
 * @returns {boolean}
 */
export function containsIdentifierRef(node, names) {
  if (names.size === 0) {
    return false;
  }
  if (!node || typeof node !== 'object') {
    return false;
  }
  if (
    node.type === 'FunctionExpression'
    || node.type === 'FunctionDeclaration'
  ) {
    return false;
  }
  if (node.type === 'Identifier') {
    return names.has(node.name);
  }
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    // Skip non-computed property keys to avoid treating `{ paramName: val }`
    // or `obj.paramName` as a reference to the parameter.
    if (
      (node.type === 'Property' && key === 'key' && !node.computed)
      || (node.type === 'MemberExpression' && key === 'property' && !node.computed)
    ) {
      continue;
    }
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (containsIdentifierRef(child, names)) {
          return true;
        }
      }
    } else if (
      val !== null
      && typeof val === 'object'
      && typeof val.type === 'string'
      && containsIdentifierRef(val, names)
    ) {
      return true;
    }
  }
  return false;
}
