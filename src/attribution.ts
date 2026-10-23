/**
 * Compatibility facade for the public attribution surface. Implementations
 * live in the bounded validator and transition modules below this path.
 */
export {
  runWbdShow,
  validateAuthoritativeBead,
  type ValidatedBead,
  type WbdShowRunner,
} from "./attribution/authoritative-bead.js";
export {
  AttributionTransitions,
  type TransitionContext,
  type TransitionResult,
} from "./attribution/transitions.js";
