import { LifecycleStatus } from '@prisma/client'

/**
 * The wire vocabulary for the four lifecycle resources. A closed union validated at the
 * HTTP boundary, never a model name: it is dispatched through exhaustive switches so a
 * caller-supplied string can never reach a Prisma delegate lookup or a SQL identifier.
 */
export const LIFECYCLE_RESOURCE_TYPES = ['user', 'operator', 'facility', 'tariff-plan'] as const

export type LifecycleResourceType = (typeof LIFECYCLE_RESOURCE_TYPES)[number]

/** AuditLog.entityType for each resource, so the trail joins with every other writer's. */
export const RESOURCE_ENTITY_TYPE: Record<LifecycleResourceType, string> = {
  user: 'User',
  operator: 'ParkingOperator',
  facility: 'Facility',
  'tariff-plan': 'TariffPlan',
}

/** Dotted audit-action prefix, matching what LifecycleService already writes. */
export const RESOURCE_AUDIT_PREFIX: Record<LifecycleResourceType, string> = {
  user: 'user',
  operator: 'operator',
  facility: 'facility',
  'tariff-plan': 'tariff_plan',
}

export const DESTRUCTIVE_ACTIONS = ['archive', 'tombstone', 'purge'] as const

export type DestructiveAction = (typeof DESTRUCTIVE_ACTIONS)[number]

/** States each transition may legally start from. Mirrors LifecycleService exactly. */
export const ACTION_SOURCE_STATES: Record<DestructiveAction, LifecycleStatus[]> = {
  archive: [LifecycleStatus.ACTIVE],
  tombstone: [LifecycleStatus.ACTIVE, LifecycleStatus.ARCHIVED],
  purge: [LifecycleStatus.TOMBSTONED],
}

/** A hard stop. The action is refused while this holds; `remedy` says how to clear it. */
export interface ImpactBlocker {
  code: string
  message: string
  remedy: string
}

/** A consequence the operator should see before consenting. Never refuses the action. */
export interface ImpactWarning {
  code: string
  message: string
  count: number
}

/** What the action will do to related rows if it proceeds. */
export interface ImpactEffect {
  entity: string
  action: 'archive' | 'tombstone' | 'unpublish' | 'delete' | 'anonymise' | 'retain' | 'detach'
  count: number
}

export interface ImpactReport {
  blockers: ImpactBlocker[]
  warnings: ImpactWarning[]
  effects: ImpactEffect[]
  requiresForce: boolean
}

export interface TrashItem {
  resourceType: LifecycleResourceType
  id: string
  name: string
  status: LifecycleStatus
  changedAt: string | null
  changedBy: string | null
  reason: string | null
  purgeAfter: string | null
}

export interface TrashPage {
  items: TrashItem[]
  total: number
  skip: number
  take: number
}

export interface ApprovalView {
  id: string
  action: string
  resourceType: string
  resourceId: string
  reason: string
  requestedBy: string
  requestedByRole: string
  status: string
  expiresAt: string
  decidedBy: string | null
  decidedAt: string | null
  decisionReason: string | null
  createdAt: string
}

export interface ApprovalList {
  items: ApprovalView[]
  total: number
}

export interface PurgeApprovalOutcome {
  approval: ApprovalView
  purged: boolean
}
