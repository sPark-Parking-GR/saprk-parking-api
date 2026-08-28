import { Injectable } from '@nestjs/common'
import type { AuthUser, OperatorSupportTier } from '@spark/types'
import { PrismaService } from '../prisma/prisma.service'
import { EntitlementService } from '../subscriptions/entitlement.service'
import { OperatorAccessService } from './operator-access.service'
import { OperatorNotFoundError } from './operators.types'

/**
 * What tier of support an operator's plan entitles them to.
 *
 * Deliberately one boolean and nothing else. There is no support system to integrate with
 * yet, and inventing queues, SLAs or ticket routing ahead of one would be building against
 * an imagined interface; what a future integration genuinely needs is a truthful answer to
 * "is this tenant priority", derived from the plan rather than maintained by hand in a
 * second place.
 */
@Injectable()
export class OperatorSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OperatorAccessService,
    private readonly entitlements: EntitlementService,
  ) {}

  async supportTier(actor: AuthUser, operatorId: string): Promise<OperatorSupportTier> {
    // Service-layer half of the authorization the controller's decorator also asks for. The
    // scope is billing rather than a lesser one because the answer IS a plan term, and
    // org:billing.view is the scope no STAFF membership can hold.
    await this.access.assertScope(actor, operatorId, 'org:billing.view')

    // assertScope already answers a non-member with OperatorNotFoundError, but it returns
    // early for platform callers, who hold no memberships — without this an unknown id
    // would resolve to the default plan and be reported as a real non-priority tenant.
    const operator = await this.prisma.parkingOperator.findUnique({
      where: { id: operatorId },
      select: { id: true },
    })
    if (!operator) throw new OperatorNotFoundError(operatorId)

    return {
      operatorId,
      priority: await this.entitlements.hasFeature(operatorId, 'support.priority'),
    }
  }
}
