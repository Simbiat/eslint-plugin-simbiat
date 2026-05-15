// @ts-check

/**
 * Wraps a handler that expects (state, node) into the single-argument
 * signature ESLint passes to visitor callbacks.
 *
 * @template S
 * @param {S} state
 * @param {(state: S, node: any) => void} handler
 * @returns {(node: any) => void}
 */
export function adaptNodeHandler(state, handler) {
  return function adaptedNodeHandler(node) {
    return handler(state, node);
  };
}

/**
 * Wraps a handler that expects only (state) into the no-argument
 * signature ESLint passes to `:exit` visitor callbacks.
 *
 * @template S
 * @param {S} state
 * @param {(state: S) => void} handler
 * @returns {() => void}
 */
export function adaptStateHandler(state, handler) {
  return function adaptedStateHandler() {
    return handler(state);
  };
}
