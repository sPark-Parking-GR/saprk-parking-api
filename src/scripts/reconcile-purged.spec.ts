import { LifecycleStatus } from '@prisma/client'
import {
  ReconcileRefusedError,
  formatReport,
  parseArgs,
  reconcilePurged,
  type IdentityStore,
  type ReconcileStore,
  type StrandedMembership,
} from './reconcile-purged'

const STRANDED: StrandedMembership = {
  id: 'mem-1',
  userId: 'purged-1',
  operatorId: 'op-a',
  role: 'ADMIN',
}

function makeHarness(memberships: StrandedMembership[] = [STRANDED]) {
  const store = {
    findStrandedMemberships: jest.fn().mockResolvedValue(memberships),
    deleteMemberships: jest.fn().mockResolvedValue(memberships.length),
    findAnyUserByEmail: jest.fn().mockResolvedValue(null),
  }
  const identities = {
    findIdentityByEmail: jest.fn().mockResolvedValue('fb-1'),
    deleteIdentity: jest.fn().mockResolvedValue(undefined),
  }
  return {
    store: store as unknown as ReconcileStore & typeof store,
    identities: identities as unknown as IdentityStore & typeof identities,
  }
}

describe('parseArgs', () => {
  it('withholds --apply by default, so a bare run cannot destroy a credential', () => {
    expect(parseArgs(['owner@biz.com']).apply).toBe(false)
    expect(parseArgs(['--apply', 'owner@biz.com']).apply).toBe(true)
  })

  it('normalises case, because addresses are stored and looked up lowercased', () => {
    expect(parseArgs(['Owner@Biz.com']).emails).toEqual(['owner@biz.com'])
  })

  it('collapses a repeated address so its credential is not looked up twice', () => {
    expect(parseArgs(['a@b.com', 'A@B.com']).emails).toEqual(['a@b.com'])
  })

  it('refuses a malformed address rather than asking Firebase about it', () => {
    expect(() => parseArgs(['not-an-email'])).toThrow(ReconcileRefusedError)
  })

  it('runs the membership half alone when no address is named', () => {
    expect(parseArgs([]).emails).toEqual([])
    expect(parseArgs(['--apply']).emails).toEqual([])
  })
})

describe('reconcilePurged — dry run', () => {
  it('reports what it would do and changes nothing', async () => {
    const { store, identities } = makeHarness()

    const report = await reconcilePurged(store, identities, {
      apply: false,
      emails: ['owner@biz.com'],
    })

    expect(report).toEqual({
      applied: false,
      memberships: [STRANDED],
      credentials: [{ email: 'owner@biz.com', action: 'release', uid: 'fb-1' }],
    })
    expect(store.deleteMemberships).not.toHaveBeenCalled()
    expect(identities.deleteIdentity).not.toHaveBeenCalled()
  })
})

describe('reconcilePurged — applying', () => {
  it('releases the memberships purged accounts still hold', async () => {
    const { store, identities } = makeHarness()

    await reconcilePurged(store, identities, { apply: true, emails: [] })

    expect(store.deleteMemberships).toHaveBeenCalledWith(['mem-1'])
  })

  it('destroys the stranded credential so the address can be registered again', async () => {
    const { store, identities } = makeHarness()

    await reconcilePurged(store, identities, { apply: true, emails: ['owner@biz.com'] })

    expect(identities.deleteIdentity).toHaveBeenCalledWith('fb-1')
  })

  /**
   * The whole risk of this command. An address that still belongs to a local account is a
   * person who can sign in today, and destroying their credential locks them out with no
   * way back — so ownership is checked against the database before Firebase is asked
   * anything at all.
   */
  it.each([LifecycleStatus.ACTIVE, LifecycleStatus.ARCHIVED, LifecycleStatus.TOMBSTONED])(
    'refuses an address a %s account still owns, without asking Firebase',
    async (lifecycleStatus) => {
      const { store, identities } = makeHarness()
      store.findAnyUserByEmail.mockResolvedValue({ id: 'u1', lifecycleStatus })

      const report = await reconcilePurged(store, identities, {
        apply: true,
        emails: ['owner@biz.com'],
      })

      expect(report.credentials).toEqual([
        { email: 'owner@biz.com', action: 'owned', userId: 'u1', lifecycleStatus },
      ])
      expect(identities.findIdentityByEmail).not.toHaveBeenCalled()
      expect(identities.deleteIdentity).not.toHaveBeenCalled()
    },
  )

  it('still cleans the rest when one named address turns out to be owned', async () => {
    const { store, identities } = makeHarness()
    store.findAnyUserByEmail.mockImplementation((email: string) =>
      email === 'live@biz.com' ? { id: 'u1', lifecycleStatus: LifecycleStatus.ACTIVE } : null,
    )

    await reconcilePurged(store, identities, {
      apply: true,
      emails: ['live@biz.com', 'owner@biz.com'],
    })

    expect(identities.deleteIdentity).toHaveBeenCalledTimes(1)
    expect(store.deleteMemberships).toHaveBeenCalled()
  })

  // Re-running after a successful pass, or against an address that was never registered.
  it('treats an absent credential as done, not as a failure', async () => {
    const { store, identities } = makeHarness([])
    identities.findIdentityByEmail.mockResolvedValue(null)

    const report = await reconcilePurged(store, identities, {
      apply: true,
      emails: ['owner@biz.com'],
    })

    expect(report.credentials).toEqual([{ email: 'owner@biz.com', action: 'absent' }])
    expect(identities.deleteIdentity).not.toHaveBeenCalled()
    expect(store.deleteMemberships).not.toHaveBeenCalled()
  })
})

describe('formatReport', () => {
  it('says plainly that a dry run changed nothing', () => {
    const output = formatReport({ applied: false, memberships: [STRANDED], credentials: [] })

    expect(output).toContain('would release 1')
    expect(output).toContain('Dry run. Nothing was changed.')
  })

  it('names the account blocking a skipped address, so the operator can act on it', () => {
    const output = formatReport({
      applied: true,
      memberships: [],
      credentials: [
        {
          email: 'owner@biz.com',
          action: 'owned',
          userId: 'u1',
          lifecycleStatus: LifecycleStatus.ACTIVE,
        },
      ],
    })

    expect(output).toContain('SKIPPED')
    expect(output).toContain('u1')
    expect(output).toContain('ACTIVE')
  })
})
