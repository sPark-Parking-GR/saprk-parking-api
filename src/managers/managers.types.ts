import type { OperatorMemberRole } from '@prisma/client'

/** Someone eligible to be assigned: a member of the owning operator, in an operator role. */
export interface ManagerCandidate {
  userId: string
  email: string
  displayName: string | null
  /** Their role INSIDE the owning operator, not the global UserRole. */
  memberRole: OperatorMemberRole
}

export interface ResourceManager {
  userId: string
  email: string
  displayName: string | null
  /**
   * Null only if the assignment outlived the membership. Every path that ends a membership
   * revokes the assignment in the same transaction, so this should not occur — it is
   * representable so such a row renders as the anomaly it is instead of vanishing from a
   * list that still grants access.
   */
  memberRole: OperatorMemberRole | null
  assignedAt: Date
  /**
   * The acting user's id, or the sentinel `system:backfill` for rows the manager-assignment
   * migration seeded. Not a foreign key — see the FacilityManager model.
   */
  assignedBy: string
}

/**
 * The whole picture for one resource's manager list. `candidates` is every member of the
 * owning operator who is eligible to be assigned, shipped alongside the current managers so
 * a picker renders from one round trip.
 */
export interface ResourceManagers {
  resourceId: string
  operatorId: string
  managers: ResourceManager[]
  candidates: ManagerCandidate[]
}
