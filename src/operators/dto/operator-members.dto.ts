import { OperatorMemberRole } from '@prisma/client'
import { ORG_PERMISSIONS } from '@spark/types'
import { z } from 'zod'

export const changeMemberRoleSchema = z.object({
  role: z.nativeEnum(OperatorMemberRole),
})

export type ChangeMemberRoleDto = z.infer<typeof changeMemberRoleSchema>

/**
 * The complete set, not a delta. A partial update would make "remove this scope" and "leave
 * it alone" the same request, and the caller is a form that already knows every box's state.
 */
export const setMemberScopesSchema = z.object({
  scopes: z.array(z.enum(ORG_PERMISSIONS)).max(ORG_PERMISSIONS.length),
})

export type SetMemberScopesDto = z.infer<typeof setMemberScopesSchema>
