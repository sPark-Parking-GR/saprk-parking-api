import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { ListAuditLogDto } from './dto/audit.dto'
import type { AuditLogItem, AuditLogList } from './audit.types'

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAuditLogDto): Promise<AuditLogList> {
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.auditLog.count(),
    ])

    const actorIds = [...new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id)))]
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, displayName: true, email: true },
        })
      : []
    const actorNames = new Map(actors.map((actor) => [actor.id, actor.displayName ?? actor.email]))

    const items: AuditLogItem[] = rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorName: row.actorId ? (actorNames.get(row.actorId) ?? null) : null,
      actorRole: row.actorRole,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      createdAt: row.createdAt.toISOString(),
    }))

    return { items, total, skip: query.skip, take: query.take }
  }
}
