export const INVENTORY_QUEUE = 'inventory'

export const RELEASE_EXPIRED_HOLDS_JOB = 'release-expired-holds'

export const CLEANUP_INTERVAL_MS = 60_000

export const LIFECYCLE_QUEUE = 'lifecycle'

export const PURGE_TOMBSTONED_JOB = 'purge-tombstoned-resources'

// Hourly: purge eligibility is measured in days, so a tighter cadence buys nothing.
export const PURGE_INTERVAL_MS = 3_600_000

export const ENGAGEMENT_QUEUE = 'engagement'

export const DRIVER_SAVINGS_SUMMARY_JOB = 'driver-savings-summary'

// Daily, even though each rider hears from it at most once every 30 days. The cadence a
// rider experiences is set by DriverSavingsService's per-rider dedup against its own trailing
// window, not by the scheduler — so a daily sweep gives every rider a rolling monthly nudge
// anchored on when they actually started saving, spreads the send volume across the month,
// and picks up anyone who became eligible yesterday. An every-30-days scheduler would instead
// mail the entire subscriber base in one burst on a phase that silently re-anchors itself
// whenever the scheduler is recreated.
export const SAVINGS_SUMMARY_INTERVAL_MS = 86_400_000
