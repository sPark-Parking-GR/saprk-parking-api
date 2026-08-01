import { Injectable } from '@nestjs/common'
import { LifecycleStatus, Prisma } from '@prisma/client'
import { LifecycleResourceNotFoundError } from '../common/errors/domain.errors'
import { unhonouredBookingsWhere } from '../facilities/facilities.service'
import { anyLifecycleStatus } from '../prisma/lifecycle.extension'
import { PrismaService } from '../prisma/prisma.service'
import { unsettledWhere } from './lifecycle-purge.service'
import {
  ACTION_SOURCE_STATES,
  RESOURCE_ENTITY_TYPE,
  type DestructiveAction,
  type ImpactBlocker,
  type ImpactEffect,
  type ImpactReport,
  type ImpactWarning,
  type LifecycleResourceType,
} from './lifecycle.types'

interface Subject {
  lifecycleStatus: LifecycleStatus
  purgeAfter: Date | null
  operatorId?: string
  isDefault?: boolean
  isActive?: boolean
  deletedAt?: Date | null
}

/**
 * The dry run behind every destructive action: what would happen, what stops it, and what
 * the administrator has to be told before consenting.
 *
 * Blockers mirror what the services actually enforce, one for one — never a stricter
 * opinion of their own. A preview that refuses something the action would allow (or the
 * reverse) is worse than no preview, because it teaches administrators to ignore it. The
 * enforcement twins are LifecycleService (archive/tombstone) and LifecyclePurgeService's
 * `*Refs` methods (purge); the shared `unsettledWhere` predicate is imported rather than
 * restated, and the remaining counts are asserted against the real actions in the e2e suite.
 *
 * Read in ONE repeatable-read, explicitly read-only transaction: the counts have to agree
 * with each other or the summary describes a state that never existed, and READ ONLY is
 * the guarantee that a preview cannot write no matter what a future edit adds here.
 */
@Injectable()
export class LifecycleImpactService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(
    resourceType: LifecycleResourceType,
    id: string,
    action: DestructiveAction,
  ): Promise<ImpactReport> {
    const report = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
        const subject = await this.loadSubject(tx, resourceType, id)
        return this.describe(tx, resourceType, id, action, subject)
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    )

    return report
  }

  private async describe(
    tx: Prisma.TransactionClient,
    resourceType: LifecycleResourceType,
    id: string,
    action: DestructiveAction,
    subject: Subject,
  ): Promise<ImpactReport> {
    const blockers: ImpactBlocker[] = []
    const warnings: ImpactWarning[] = []
    const effects: ImpactEffect[] = []

    if (!ACTION_SOURCE_STATES[action].includes(subject.lifecycleStatus)) {
      blockers.push({
        code: 'INVALID_LIFECYCLE_STATE',
        message: `${RESOURCE_ENTITY_TYPE[resourceType]} ${id} is ${subject.lifecycleStatus} and cannot be ${action}d from there`,
        remedy: `Only a ${ACTION_SOURCE_STATES[action].join(' or ')} resource can be ${action}d.`,
      })
    }

    // An admin-initiated purge deliberately overrides the retention countdown the sweep
    // waits for — that is the point of the endpoint — so it is a consent prompt, not a stop.
    if (action === 'purge' && subject.purgeAfter && subject.purgeAfter.getTime() > Date.now()) {
      warnings.push({
        code: 'PURGE_BEFORE_RETENTION_WINDOW',
        message: `The recovery window does not lapse until ${subject.purgeAfter.toISOString()}. Purging now forfeits it.`,
        count: 1,
      })
    }

    switch (resourceType) {
      case 'facility':
        await this.facility(tx, id, action, subject, blockers, warnings, effects)
        break
      case 'tariff-plan':
        await this.tariffPlan(tx, id, action, subject, blockers, warnings, effects)
        break
      case 'operator':
        await this.operator(tx, id, action, blockers, warnings, effects)
        break
      case 'user':
        await this.user(tx, id, action, subject, blockers, warnings, effects)
        break
    }

    return { blockers, warnings, effects, requiresForce: warnings.length > 0 }
  }

  private async facility(
    tx: Prisma.TransactionClient,
    id: string,
    action: DestructiveAction,
    subject: Subject,
    blockers: ImpactBlocker[],
    warnings: ImpactWarning[],
    effects: ImpactEffect[],
  ): Promise<void> {
    const [unhonoured, bookings, assignments, saved, reviews, images, rules] = await Promise.all([
      tx.booking.count({ where: unhonouredBookingsWhere(id) }),
      tx.booking.count({ where: { facilityId: id } }),
      tx.facilityTariffAssignment.count({ where: { facilityId: id } }),
      tx.savedFacility.count({ where: { facilityId: id } }),
      tx.review.count({ where: { facilityId: id } }),
      tx.facilityImage.count({ where: { facilityId: id } }),
      tx.facilityRule.count({ where: { facilityId: id } }),
    ])

    if (action !== 'purge' && unhonoured > 0) {
      blockers.push({
        code: 'FACILITY_HAS_UNHONOURED_BOOKINGS',
        message: `${unhonoured} booking(s) are still to be honoured at this facility.`,
        remedy:
          'Cancel and refund them through the facility deactivation flow, or wait until they end.',
      })
    }

    if (action === 'purge' && bookings > 0) {
      blockers.push({
        code: 'FACILITY_PINNED_BY_BOOKINGS',
        message: `${bookings} booking(s) reference this facility and carry payment records.`,
        remedy:
          'None. Bookings are ON DELETE RESTRICT financial history; this facility can only remain a tombstone.',
      })
    }

    if (action === 'archive' && subject.isActive) {
      warnings.push({
        code: 'FACILITY_WILL_UNPUBLISH',
        message: 'The facility is published and will be removed from public search.',
        count: 1,
      })
    }
    if (saved > 0) {
      warnings.push({
        code: 'FACILITY_SAVED_BY_USERS',
        message: `${saved} customer(s) have saved this facility.`,
        count: saved,
      })
    }
    if (assignments > 0) {
      warnings.push({
        code: 'FACILITY_HAS_TARIFF_ASSIGNMENTS',
        message: `${assignments} tariff assignment(s) will stop pricing this facility.`,
        count: assignments,
      })
    }

    effects.push({ entity: 'Facility', action: this.selfEffect(action), count: 1 })
    if (action !== 'purge') {
      effects.push({ entity: 'Facility', action: 'unpublish', count: 1 })
      effects.push({ entity: 'Booking', action: 'retain', count: bookings })
      return
    }
    effects.push({ entity: 'FacilityTariffAssignment', action: 'delete', count: assignments })
    effects.push({ entity: 'SavedFacility', action: 'delete', count: saved })
    effects.push({ entity: 'Review', action: 'delete', count: reviews })
    effects.push({ entity: 'FacilityImage', action: 'delete', count: images })
    effects.push({ entity: 'FacilityRule', action: 'delete', count: rules })
  }

  private async tariffPlan(
    tx: Prisma.TransactionClient,
    id: string,
    action: DestructiveAction,
    subject: Subject,
    _blockers: ImpactBlocker[],
    warnings: ImpactWarning[],
    effects: ImpactEffect[],
  ): Promise<void> {
    const [assignments, windows, tiers, caps] = await Promise.all([
      tx.facilityTariffAssignment.count({ where: { tariffPlanId: id } }),
      tx.rateWindow.count({ where: { planId: id } }),
      tx.rateTier.count({ where: { planId: id } }),
      tx.rateCap.count({ where: { planId: id } }),
    ])

    // Nothing blocks a plan purge: the schedule cascades, and bookings pin a plan by
    // (id, version) value rather than by foreign key. See LifecyclePurgeService.
    if (subject.isDefault && subject.isActive) {
      warnings.push({
        code: 'TARIFF_PLAN_IS_OPERATOR_DEFAULT',
        message:
          "This is the operator's active default plan. Facilities with no explicit assignment lose their fallback price.",
        count: 1,
      })
    }
    if (assignments > 0) {
      warnings.push({
        code: 'TARIFF_PLAN_ASSIGNED_TO_FACILITIES',
        message: `${assignments} facility/vehicle-type assignment(s) price through this plan.`,
        count: assignments,
      })
    }
    if (action === 'purge') {
      warnings.push({
        code: 'TARIFF_PLAN_PINNED_PRICING_UNRESOLVABLE',
        message:
          'Bookings that pinned this plan keep their price but can no longer resolve the plan it came from.',
        count: 1,
      })
    }

    effects.push({ entity: 'TariffPlan', action: this.selfEffect(action), count: 1 })
    if (action !== 'purge') return
    effects.push({ entity: 'FacilityTariffAssignment', action: 'delete', count: assignments })
    effects.push({ entity: 'RateWindow', action: 'delete', count: windows })
    effects.push({ entity: 'RateTier', action: 'delete', count: tiers })
    effects.push({ entity: 'RateCap', action: 'delete', count: caps })
  }

  private async operator(
    tx: Prisma.TransactionClient,
    id: string,
    action: DestructiveAction,
    blockers: ImpactBlocker[],
    warnings: ImpactWarning[],
    effects: ImpactEffect[],
  ): Promise<void> {
    const [
      activeFacilities,
      allFacilities,
      ownershipPeriods,
      promotionPlans,
      memberships,
      invites,
    ] = await Promise.all([
      tx.facility.count({ where: { operatorId: id, lifecycleStatus: LifecycleStatus.ACTIVE } }),
      tx.facility.count({ where: { operatorId: id, lifecycleStatus: anyLifecycleStatus() } }),
      tx.facilityOwnershipPeriod.count({ where: { operatorId: id } }),
      tx.promotionPlan.count({ where: { operatorId: id } }),
      tx.operatorMembership.count({ where: { operatorId: id } }),
      tx.operatorInvite.count({ where: { operatorId: id } }),
    ])

    if (action !== 'purge' && activeFacilities > 0) {
      blockers.push({
        code: 'OPERATOR_HAS_ACTIVE_FACILITIES',
        message: `${activeFacilities} facilit${activeFacilities === 1 ? 'y is' : 'ies are'} still active under this operator.`,
        remedy: 'Archive every facility this operator owns first.',
      })
    }

    if (action === 'purge') {
      if (allFacilities > 0) {
        blockers.push({
          code: 'OPERATOR_PINNED_BY_FACILITIES',
          message: `${allFacilities} facilit${allFacilities === 1 ? 'y' : 'ies'} in some lifecycle state still reference this operator.`,
          remedy: 'Purge those facilities first; a tombstoned facility still pins its operator.',
        })
      }
      if (ownershipPeriods > 0) {
        blockers.push({
          code: 'OPERATOR_PINNED_BY_OWNERSHIP_HISTORY',
          message: `${ownershipPeriods} ownership period(s) attribute historical revenue to this operator.`,
          remedy: 'None. Ownership periods are the basis of past payouts and are never removed.',
        })
      }
      if (promotionPlans > 0) {
        blockers.push({
          code: 'OPERATOR_PINNED_BY_PROMOTION_PLANS',
          message: `${promotionPlans} promotion plan(s) reference this operator.`,
          remedy: 'Remove the promotion plans first.',
        })
      }
    }

    if (memberships > 0) {
      warnings.push({
        code: 'OPERATOR_HAS_MEMBERS',
        message: `${memberships} staff membership(s) lose access to this operator.`,
        count: memberships,
      })
    }
    if (invites > 0) {
      warnings.push({
        code: 'OPERATOR_HAS_INVITES',
        message: `${invites} invite(s) reference this operator.`,
        count: invites,
      })
    }

    effects.push({ entity: 'ParkingOperator', action: this.selfEffect(action), count: 1 })
    if (action !== 'purge') return
    effects.push({ entity: 'OperatorMembership', action: 'delete', count: memberships })
    effects.push({ entity: 'OperatorInvite', action: 'detach', count: invites })
  }

  private async user(
    tx: Prisma.TransactionClient,
    id: string,
    action: DestructiveAction,
    subject: Subject,
    blockers: ImpactBlocker[],
    warnings: ImpactWarning[],
    effects: ImpactEffect[],
  ): Promise<void> {
    const [unsettled, bookings, vehicles, resetTokens, memberships] = await Promise.all([
      tx.booking.count({ where: unsettledWhere(id) }),
      tx.booking.count({ where: { userId: id } }),
      tx.vehicle.count({ where: { userId: id } }),
      tx.passwordResetToken.count({ where: { userId: id } }),
      tx.operatorMembership.count({ where: { userId: id } }),
    ])

    if (action === 'purge' && unsettled > 0) {
      blockers.push({
        code: 'USER_HAS_UNSETTLED_BOOKINGS',
        message: `${unsettled} booking(s) still have money or a bay in flight.`,
        remedy: 'Settle, complete or refund them before anonymising the account.',
      })
    }

    if (action !== 'purge') {
      warnings.push({
        code: 'USER_SESSIONS_REVOKED',
        message: 'Every live session for this account is revoked immediately.',
        count: 1,
      })
    }
    if (bookings > 0) {
      warnings.push({
        code: 'USER_HAS_BOOKING_HISTORY',
        message: `${bookings} booking(s) are retained as financial history under an anonymised account.`,
        count: bookings,
      })
    }
    if (memberships > 0) {
      warnings.push({
        code: 'USER_IS_OPERATOR_MEMBER',
        message: `${memberships} operator membership(s) belong to this account.`,
        count: memberships,
      })
    }
    if (action === 'purge' && subject.deletedAt) {
      warnings.push({
        code: 'USER_ALREADY_ANONYMISED',
        message: 'This account was already anonymised by self-service deletion.',
        count: 1,
      })
    }

    effects.push({
      entity: 'User',
      action: action === 'purge' ? 'anonymise' : this.selfEffect(action),
      count: 1,
    })
    if (action !== 'purge') return
    effects.push({ entity: 'Vehicle', action: 'delete', count: vehicles })
    effects.push({ entity: 'PasswordResetToken', action: 'delete', count: resetTokens })
    effects.push({ entity: 'Booking', action: 'retain', count: bookings })
  }

  private selfEffect(action: DestructiveAction): ImpactEffect['action'] {
    return action === 'archive' ? 'archive' : action === 'tombstone' ? 'tombstone' : 'delete'
  }

  private async loadSubject(
    tx: Prisma.TransactionClient,
    resourceType: LifecycleResourceType,
    id: string,
  ): Promise<Subject> {
    const where = { id, lifecycleStatus: anyLifecycleStatus() }
    const entityType = RESOURCE_ENTITY_TYPE[resourceType]

    switch (resourceType) {
      case 'facility': {
        const row = await tx.facility.findFirst({
          where,
          select: { lifecycleStatus: true, purgeAfter: true, operatorId: true, isActive: true },
        })
        if (!row) throw new LifecycleResourceNotFoundError(entityType, id)
        return row
      }
      case 'tariff-plan': {
        const row = await tx.tariffPlan.findFirst({
          where,
          select: {
            lifecycleStatus: true,
            purgeAfter: true,
            operatorId: true,
            isActive: true,
            isDefault: true,
          },
        })
        if (!row) throw new LifecycleResourceNotFoundError(entityType, id)
        return row
      }
      case 'operator': {
        const row = await tx.parkingOperator.findFirst({
          where,
          select: { lifecycleStatus: true, purgeAfter: true },
        })
        if (!row) throw new LifecycleResourceNotFoundError(entityType, id)
        return row
      }
      case 'user': {
        const row = await tx.user.findFirst({
          where,
          select: { lifecycleStatus: true, purgeAfter: true, deletedAt: true },
        })
        if (!row) throw new LifecycleResourceNotFoundError(entityType, id)
        return row
      }
    }
  }
}
