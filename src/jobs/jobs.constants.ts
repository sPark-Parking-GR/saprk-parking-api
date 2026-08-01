export const INVENTORY_QUEUE = 'inventory'

export const RELEASE_EXPIRED_HOLDS_JOB = 'release-expired-holds'

export const CLEANUP_INTERVAL_MS = 60_000

export const LIFECYCLE_QUEUE = 'lifecycle'

export const PURGE_TOMBSTONED_JOB = 'purge-tombstoned-resources'

// Hourly: purge eligibility is measured in days, so a tighter cadence buys nothing.
export const PURGE_INTERVAL_MS = 3_600_000
