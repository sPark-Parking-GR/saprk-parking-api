import { OperatorMemberRole } from '@prisma/client'
import { isStaffGrantableScope, ORG_PERMISSIONS, STAFF_FORBIDDEN_SCOPES } from '@spark/types'
import { z } from 'zod'

export const changeMemberRoleSchema = z.object({
  role: z.nativeEnum(OperatorMemberRole),
})

export type ChangeMemberRoleDto = z.infer<typeof changeMemberRoleSchema>

/**
 * The complete set, not a delta. A partial update would make "remove this scope" and "leave
 * it alone" the same request, and the caller is a form that already knows every box's state.
 *
 * The route only ever writes STAFF scopes — an ADMIN's set is derived and the service
 * refuses to edit it — so the staff exclusion applies to every body that reaches here and is
 * rejected at the boundary rather than deeper in.
 */
export const setMemberScopesSchema = z.object({
  scopes: z
    .array(z.enum(ORG_PERMISSIONS))
    .max(ORG_PERMISSIONS.length)
    .refine((scopes) => scopes.every(isStaffGrantableScope), {
      message: `a staff member may never hold ${STAFF_FORBIDDEN_SCOPES.join(', ')}`,
    }),
})

export type SetMemberScopesDto = z.infer<typeof setMemberScopesSchema>
