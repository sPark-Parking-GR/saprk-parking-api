import { ForbiddenException, Injectable } from '@nestjs/common'
import { hasPlatformPermission, type AuthUser } from '@spark/types'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import type { ListAuditLogDto } from './dto/audit.dto'
import type { AuditLogItem, AuditLogList } from './audit.types'

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthUser, query: ListAuditLogDto): Promise<AuditLogList> {
    // Controller already gates on @RequirePermission('platform:tenant.read'); re-check in
    // the service layer per the both-layers authorization rule.
    if (!hasPlatformPermission(actor.role, 'platform:tenant.read')) {
      throw new ForbiddenException('Only platform admins may view the audit log')
    }

    // entityId alone (without entityType) does not benefit from the
    // @@index([entityType, entityId]) composite index and falls back to a sequential
    // scan; callers are expected to pass entityType alongside it for large tables.
    const where: Prisma.AuditLogWhereInput = {
      actorId: query.actorId,
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      createdAt:
        query.createdFrom || query.createdTo
          ? { gte: query.createdFrom, lte: query.createdTo }
          : undefined,
    }

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.auditLog.count({ where }),
    ])

    const actorIds = [
      ...new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id))),
    ]
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, displayName: true, email: true },
        })
      : []
    const actorNames = new Map(actors.map((a) => [a.id, a.displayName ?? a.email]))

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
