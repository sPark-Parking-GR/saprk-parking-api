import type { AuthJsCreateUserInput, AuthJsUserRecord, AuthJsUserStore } from '@spark/auth'
import type { UserRole as ContractRole } from '@spark/types'
import { UserRole } from '@prisma/client'
import type { PrismaService } from '../prisma/prisma.service'

export const TO_PRISMA: Record<ContractRole, UserRole> = {
  guest: UserRole.USER,
  user: UserRole.USER,
  operator_staff: UserRole.OPERATOR_STAFF,
  operator_admin: UserRole.OPERATOR_ADMIN,
  platform_admin: UserRole.PLATFORM_ADMIN,
  super_admin: UserRole.SUPER_ADMIN,
}

// Exported for callers that read a role straight out of Prisma and have to record it
// somewhere the contract vocabulary is expected — the audit log's actorRole, whose every
// other writer takes the role off a verified token and so writes 'user', not 'USER'.
export const FROM_PRISMA: Record<UserRole, ContractRole> = {
  [UserRole.USER]: 'user',
  [UserRole.OPERATOR_STAFF]: 'operator_staff',
  [UserRole.OPERATOR_ADMIN]: 'operator_admin',
  [UserRole.PLATFORM_ADMIN]: 'platform_admin',
  [UserRole.SUPER_ADMIN]: 'super_admin',
}

interface UserRow {
  id: string
  email: string
  role: UserRole
  emailVerified: boolean
  displayName: string | null
  avatarUrl: string | null
  passwordHash: string | null
  firebaseUid: string | null
  sessionsValidFrom: Date | null
}

export class PrismaAuthJsUserStore implements AuthJsUserStore {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<AuthJsUserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { email } })
    return user ? this.toRecord(user) : null
  }

  async findById(id: string): Promise<AuthJsUserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { id } })
    return user ? this.toRecord(user) : null
  }

  async createUser(input: AuthJsCreateUserInput): Promise<AuthJsUserRecord> {
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        role: TO_PRISMA[input.role],
        displayName: input.displayName ?? null,
        firebaseUid: input.firebaseUid ?? null,
      },
    })
    return this.toRecord(user)
  }

  async deleteUser(id: string): Promise<void> {
    await this.prisma.user.delete({ where: { id } })
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { passwordHash } })
  }

  // Compare-and-set, so an opportunistic rehash can only replace the exact hash it
  // verified against. updateMany matching nothing is a no-op, which is the wanted
  // outcome: whatever wrote in the meantime is newer and must survive.
  async upgradePassword(id: string, expectedHash: string, passwordHash: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id, passwordHash: expectedHash },
      data: { passwordHash },
    })
  }

  async revokeSessions(id: string, at: Date): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { sessionsValidFrom: at } })
  }

  private toRecord(user: UserRow): AuthJsUserRecord {
    return {
      id: user.id,
      email: user.email,
      role: FROM_PRISMA[user.role],
      emailVerified: user.emailVerified,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      passwordHash: user.passwordHash ?? '',
      firebaseUid: user.firebaseUid,
      sessionsValidFrom: user.sessionsValidFrom,
    }
  }
}
