import { ForbiddenException, Injectable } from '@nestjs/common'
import { hasPlatformPermission, type AuthUser } from '@spark/types'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { anyLifecycleStatus } from '../prisma/lifecycle.extension'
import type { ListAuditLogDto } from './dto/audit.dto'
import type { AuditLogItem, AuditLogList } from './audit.types'

// entityType values this service can resolve to a human-readable name. Kept in sync by
// hand with every `entityType:` literal audit writers pass — see audit.types.ts.
const RESOLVABLE_ENTITY_TYPES = new Set(['ParkingOperator', 'Facility', 'TariffPlan', 'User'])

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthUser, query: ListAuditLogDto): Promise<AuditLogList> {
    // Controller already gates on @RequirePermission('platform:tenant.read'); re-check in
    // the service layer per the both-layers authorization rule.
    if (!hasPlatformPermission(actor.role, 'platform:tenant.read')) {
      throw new ForbiddenException('Only platform admins may view the audit log')
    }

    // actorQuery takes precedence over actorId: it always comes from the filter UI, which
    // never sends both. An empty match set still narrows correctly ({ in: [] } excludes
    // every row) rather than falling through to "no filter".
    const actorId = query.actorQuery
      ? { in: await this.resolveActorIds(query.actorQuery) }
      : query.actorId

    // entityId alone (without entityType) does not benefit from the
    // @@index([entityType, entityId]) composite index and falls back to a sequential
    // scan; callers are expected to pass entityType alongside it for large tables.
    const where: Prisma.AuditLogWhereInput = {
      actorId,
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

    const [actorNames, entityLabels] = await Promise.all([
      this.resolveActorNames(rows),
      this.resolveEntityLabels(rows, actor),
    ])

    const items: AuditLogItem[] = rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorName: row.actorId ? (actorNames.get(row.actorId) ?? null) : null,
      actorRole: row.actorRole,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      entityLabel: entityLabels.get(`${row.entityType}:${row.entityId}`) ?? null,
      createdAt: row.createdAt.toISOString(),
    }))

    return { items, total, skip: query.skip, take: query.take }
  }

  // Both User lookups below name lifecycleStatus explicitly (anyLifecycleStatus) to opt out
  // of the lifecycle extension's default ACTIVE-only filter: an actor who has since been
  // archived, tombstoned, or anonymised by a purge still performed the action on record and
  // must stay findable and nameable in the trail.
  private async resolveActorIds(actorQuery: string): Promise<string[]> {
    const matches = await this.prisma.user.findMany({
      where: {
        lifecycleStatus: anyLifecycleStatus(),
        OR: [
          { email: { contains: actorQuery, mode: 'insensitive' } },
          { displayName: { contains: actorQuery, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
      take: 500,
    })
    return matches.map((m) => m.id)
  }

  private async resolveActorNames(
    rows: { actorId: string | null }[],
  ): Promise<Map<string, string>> {
    const actorIds = [
      ...new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id))),
    ]
    if (!actorIds.length) return new Map()

    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds }, lifecycleStatus: anyLifecycleStatus() },
      select: { id: true, displayName: true, email: true },
    })
    return new Map(actors.map((a) => [a.id, a.displayName ?? a.email]))
  }

  /**
   * Looks up the current name of each row's subject, keyed `${entityType}:${entityId}` so
   * callers with mixed entity types in one page resolve correctly. A row whose subject was
   * later purged (ParkingOperator, Facility and TariffPlan are hard-deleted on purge) simply
   * has no match and the row still renders — via entityId, in the caller's fallback — rather
   * than being dropped, since this never joins against AuditLog itself.
   *
   * Every lookup in namedRows() opts out of the lifecycle extension's default ACTIVE-only
   * filter (anyLifecycleStatus): an archived or tombstoned row is not gone, and a name
   * resolver that could only see ACTIVE rows would go blank on exactly the archive/tombstone
   * actions this log exists to record.
   *
   * entityType 'User' is withheld from an actor lacking identity:user.read: that permission
   * is the entire boundary between platform_admin and super_admin (see auth.ts), and this
   * lookup would otherwise hand a platform admin the displayName/email behind any user id
   * that appears in the trail.
   */
  private async resolveEntityLabels(
    rows: { entityType: string; entityId: string }[],
    actor: AuthUser,
  ): Promise<Map<string, string>> {
    const idsByType = new Map<string, string[]>()
    for (const row of rows) {
      if (!RESOLVABLE_ENTITY_TYPES.has(row.entityType)) continue
      if (row.entityType === 'User' && !hasPlatformPermission(actor.role, 'identity:user.read')) {
        continue
      }
      const ids = idsByType.get(row.entityType) ?? []
      if (!ids.includes(row.entityId)) ids.push(row.entityId)
      idsByType.set(row.entityType, ids)
    }

    const labels = new Map<string, string>()
    await Promise.all(
      [...idsByType.entries()].map(async ([entityType, ids]) => {
        const named = await this.namedRows(entityType, ids)
        for (const row of named) labels.set(`${entityType}:${row.id}`, row.name)
      }),
    )
    return labels
  }

  private namedRows(entityType: string, ids: string[]): Promise<{ id: string; name: string }[]> {
    switch (entityType) {
      case 'ParkingOperator':
        return this.prisma.parkingOperator.findMany({
          where: { id: { in: ids }, lifecycleStatus: anyLifecycleStatus() },
          select: { id: true, name: true },
        })
      case 'Facility':
        return this.prisma.facility.findMany({
          where: { id: { in: ids }, lifecycleStatus: anyLifecycleStatus() },
          select: { id: true, name: true },
        })
      case 'TariffPlan':
        return this.prisma.tariffPlan.findMany({
          where: { id: { in: ids }, lifecycleStatus: anyLifecycleStatus() },
          select: { id: true, name: true },
        })
      case 'User':
        return this.prisma.user
          .findMany({
            where: { id: { in: ids }, lifecycleStatus: anyLifecycleStatus() },
            select: { id: true, displayName: true, email: true },
          })
          .then((users) => users.map((u) => ({ id: u.id, name: u.displayName ?? u.email })))
      default:
        return Promise.resolve([])
    }
  }
}
