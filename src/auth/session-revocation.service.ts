import { Injectable } from '@nestjs/common'
import { isRevokedByWatermark } from '@spark/auth'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class SessionRevocationService {
  constructor(private readonly prisma: PrismaService) {}

  async isRevoked(userId: string, issuedAtSeconds: number): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { sessionsValidFrom: true, deletedAt: true },
    })
    // Fail closed: a token outliving the row it authenticates is a deleted account with
    // a working session.
    if (!user) return true
    // A deleted account is refused whatever the watermark says. Deletion moves the
    // watermark too, so this is belt and braces — but it is the check that does not depend
    // on clock skew between an issuer's `iat` and our own now(), and the row it guards can
    // never legitimately authenticate again.
    if (user.deletedAt) return true
    return isRevokedByWatermark(issuedAtSeconds, user.sessionsValidFrom)
  }
}
