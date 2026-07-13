export interface AuditLogItem {
  id: string
  actorId: string | null
  actorName: string | null
  actorRole: string | null
  action: string
  entityType: string
  entityId: string
  createdAt: string
}

export interface AuditLogList {
  items: AuditLogItem[]
  total: number
  skip: number
  take: number
}
