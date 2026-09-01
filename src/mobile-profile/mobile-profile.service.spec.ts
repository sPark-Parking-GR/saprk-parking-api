import type { PrismaService } from '../prisma/prisma.service'
import { MobileProfileService } from './mobile-profile.service'

function makeHarness() {
  const prisma = { mobileProfile: { upsert: jest.fn().mockResolvedValue({ id: 'mp-1' }) } }
  const service = new MobileProfileService(prisma as unknown as PrismaService)
  return { service, prisma }
}

describe('MobileProfileService', () => {
  it('upserts keyed on the caller\'s own userId, never the body', async () => {
    const { service, prisma } = makeHarness()

    await service.upsert('user-1', { pushToken: 'tok', locale: 'el-GR' })

    expect(prisma.mobileProfile.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: {
        userId: 'user-1',
        pushToken: 'tok',
        locale: 'el-GR',
        lastActiveAt: expect.any(Date),
      },
      update: { pushToken: 'tok', locale: 'el-GR', lastActiveAt: expect.any(Date) },
    })
  })
})
