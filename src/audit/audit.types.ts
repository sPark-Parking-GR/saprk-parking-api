export interface AuditLogItem {
  id: string
  actorId: string | null
  actorName: string | null
  actorRole: string | null
  action: string
  entityType: string
  entityId: string
  // The resolved human-readable name of the subject, when entityType is a resource this
  // service knows how to look up and the actor is authorized to see it. Null when the
  // type is unresolvable, the subject no longer exists, or (for entityType 'User')
  // the actor lacks identity:user.read — callers fall back to entityId.
  entityLabel: string | null
  createdAt: string
}

export interface AuditLogList {
  items: AuditLogItem[]
  total: number
  skip: number
  take: number
}
