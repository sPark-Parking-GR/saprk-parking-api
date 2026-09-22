export const SUBSCRIPTION_BILLING_CONTEXT_TOKEN = 'SUBSCRIPTION_BILLING_CONTEXT'

/**
 * A SECOND context, and the only thing it is ever asked to do is verify the operator
 * webhook's signature — see OperatorSubscriptionWebhookVerifier for why that cannot go
 * through the shared one.
 */
export const OPERATOR_WEBHOOK_BILLING_CONTEXT_TOKEN = 'OPERATOR_WEBHOOK_BILLING_CONTEXT'
