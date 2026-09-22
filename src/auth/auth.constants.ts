export const AUTH_CONTEXT_TOKEN = 'AUTH_CONTEXT'

// The raw Firebase strategy, unwrapped from the composite router. Injected by the
// invite module so operator provisioning always creates a Firebase identity,
// regardless of the global AUTH_PROVIDER default.
export const FIREBASE_AUTH_PROVIDER_TOKEN = 'FIREBASE_AUTH_PROVIDER'
