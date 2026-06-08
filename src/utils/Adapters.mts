/**
 * @file Adapter utilities to wrap stateful handlers into ESLint-compatible visitor callbacks.
 */

/**
 * Wraps a handler that expects (state, node) into the single-argument
 * signature ESLint passes to visitor callbacks.
 * @template S - The state type.
 * @param state - Rule state object to be threaded through.
 * @param handler - Two-argument handler to wrap.
 * @returns A single-argument visitor callback suitable for ESLint.
 */
export function adaptNodeHandler<S>(state: S, handler: (state: S, node: unknown) => void): (node: unknown) => void {
  return function adaptedNodeHandler(node: unknown): void {
    handler(state, node);
  };
}

/**
 * Wraps a handler that expects only (state) into the no-argument
 * signature ESLint passes to `:exit` visitor callbacks.
 * @template S - The state type.
 * @param state - Rule state object to be threaded through.
 * @param handler - Single-argument handler to wrap.
 * @returns A no-argument visitor callback suitable for ESLint.
 */
export function adaptStateHandler<S>(state: S, handler: (state: S) => void): () => void {
  return function adaptedStateHandler(): void {
    handler(state);
  };
}
