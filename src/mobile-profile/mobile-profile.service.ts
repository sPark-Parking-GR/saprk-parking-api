import { Injectable } from '@nestjs/common'
import type { MobileProfile } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import type { UpdateMobileProfileDto } from './dto/mobile-profile.dto'

@Injectable()
export class MobileProfileService {
  constructor(private readonly prisma: PrismaService) {}

  upsert(userId: string, data: UpdateMobileProfileDto): Promise<MobileProfile> {
    return this.prisma.mobileProfile.upsert({
      where: { userId },
      create: { userId, ...data, lastActiveAt: new Date() },
      update: { ...data, lastActiveAt: new Date() },
    })
  }
}
