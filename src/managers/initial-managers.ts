import { LifecycleStatus, OperatorMemberRole, UserRole, type Prisma } from '@prisma/client'

/**
 * Who a freshly created facility or tariff plan lands assigned to.
 *
 * An operator caller is the obvious answer — they created it, and without a row they could
 * not open what they just wrote. A platform admin creating on a tenant's behalf is not: a
 * row for them would grant nothing they do not already have, and leaving the resource with
 * no managers at all would make it invisible to the tenant it was created FOR, recoverable
 * only by a second, separate platform-admin action. So it lands with the operator's ADMIN
 * members, who can then delegate it onward themselves.
 *
 * An operator with no eligible admins (an unclaimed ingestion tenant, a shell operator
 * whose invite is still outstanding) yields nothing, which is correct: there is nobody to
 * hand it to yet, and it stays platform-admin-only until there is.
 *
 * The user terms are spelled out because the default lifecycle filter does not reach
 * through a relation filter — without them an archived account would be seeded a grant.
 */
export async function initialManagerIds(
  tx: Prisma.TransactionClient,
  operatorId: string,
  creator: { id: string; isPlatformAdmin: boolean },
): Promise<string[]> {
  if (!creator.isPlatformAdmin) return [creator.id]

  const admins = await tx.operatorMembership.findMany({
    where: {
      operatorId,
      role: OperatorMemberRole.ADMIN,
      user: {
        role: { in: [UserRole.OPERATOR_ADMIN, UserRole.OPERATOR_STAFF] },
        lifecycleStatus: LifecycleStatus.ACTIVE,
        deletedAt: null,
      },
    },
    select: { userId: true },
  })

  return admins.map((row) => row.userId)
}
