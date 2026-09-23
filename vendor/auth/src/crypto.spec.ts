import { randomBytes, scryptSync } from 'node:crypto'
import {
  CURRENT_SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  verifyPassword,
  type ScryptParams,
} from './crypto'

// Every test hashes at a cost the suite can afford; the production floor (N=2^17) is
// asserted separately as a constant rather than paid for dozens of times.
const TEST_PARAMS: ScryptParams = { N: 16, r: 8, p: 1 }

const LEGACY_PARAMS = { N: 16384, r: 8, p: 1 }

// The exact string the pre-versioning hashPassword produced, reproduced from Node's
// scryptSync defaults so the fallback is tested against real legacy output.
function legacyHash(plain: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(plain, salt, 64)
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

describe('hashPassword', () => {
  it('emits the versioned format carrying its own parameters', async () => {
    const stored = await hashPassword('pw-123456', TEST_PARAMS)
    const segments = stored.split('$')

    expect(segments).toHaveLength(4)
    expect(segments[0]).toBe('scrypt')
    expect(segments[1]).toBe('N=16,r=8,p=1')
    expect(stored.startsWith('scrypt$')).toBe(true)
  })

  it('never reuses a salt', async () => {
    const [first, second] = await Promise.all([
      hashPassword('pw-123456', TEST_PARAMS),
      hashPassword('pw-123456', TEST_PARAMS),
    ])

    expect(first).not.toBe(second)
    expect(first.split('$')[2]).not.toBe(second.split('$')[2])
    await expect(verifyPassword('pw-123456', first)).resolves.toBe(true)
    await expect(verifyPassword('pw-123456', second)).resolves.toBe(true)
  })

  it('never contains the plaintext', async () => {
    const stored = await hashPassword('pw-123456', TEST_PARAMS)

    expect(stored).not.toContain('pw-123456')
  })

  it('defaults to the OWASP scrypt floor', () => {
    expect(CURRENT_SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 })
  })
})

describe('verifyPassword', () => {
  it('round-trips the encoded parameters', async () => {
    for (const params of [TEST_PARAMS, { N: 32, r: 4, p: 2 }, { N: 64, r: 1, p: 1 }]) {
      const stored = await hashPassword('pw-123456', params)

      expect(stored.split('$')[1]).toBe(`N=${params.N},r=${params.r},p=${params.p}`)
      await expect(verifyPassword('pw-123456', stored)).resolves.toBe(true)
    }
  })

  it('accepts a correct password against the new format', async () => {
    const stored = await hashPassword('pw-123456', TEST_PARAMS)

    await expect(verifyPassword('pw-123456', stored)).resolves.toBe(true)
  })

  it('rejects a wrong password against the new format', async () => {
    const stored = await hashPassword('pw-123456', TEST_PARAMS)

    await expect(verifyPassword('wrong-pass', stored)).resolves.toBe(false)
    await expect(verifyPassword('', stored)).resolves.toBe(false)
  })

  it('still accepts a legacy scrypt$salt$hash written before the format was versioned', async () => {
    const stored = legacyHash('pw-123456')

    await expect(verifyPassword('pw-123456', stored)).resolves.toBe(true)
  })

  it('rejects a wrong password against a legacy hash', async () => {
    const stored = legacyHash('pw-123456')

    await expect(verifyPassword('wrong-pass', stored)).resolves.toBe(false)
  })

  it.each([
    ['empty', ''],
    ['scheme only', 'scrypt'],
    ['one segment', 'scrypt$'],
    ['unknown scheme', 'bcrypt$abc$def'],
    ['legacy with empty salt', 'scrypt$$abc'],
    ['legacy with empty hash', 'scrypt$abc$'],
    ['too many segments', 'scrypt$N=16,r=8,p=1$salt$hash$extra'],
    ['unparseable params', 'scrypt$N=abc,r=8,p=1$c2FsdA$aGFzaA'],
    ['params out of order', 'scrypt$r=8,N=16,p=1$c2FsdA$aGFzaA'],
    ['missing params key', 'scrypt$16,8,1$c2FsdA$aGFzaA'],
    ['non-power-of-two N', 'scrypt$N=17,r=8,p=1$c2FsdA$aGFzaA'],
    ['N below minimum', 'scrypt$N=1,r=8,p=1$c2FsdA$aGFzaA'],
    ['zero parallelism', 'scrypt$N=16,r=8,p=0$c2FsdA$aGFzaA'],
    ['memory bomb', 'scrypt$N=1048576,r=64,p=1$c2FsdA$aGFzaA'],
    ['non-base64url salt', 'scrypt$N=16,r=8,p=1$!!!$aGFzaA'],
    ['bare noise', 'not-a-hash'],
  ])('returns false without throwing for a malformed stored value (%s)', async (_label, stored) => {
    await expect(verifyPassword('pw-123456', stored)).resolves.toBe(false)
  })
})

describe('needsRehash', () => {
  // A format that cannot record parameters can never be retuned, so it migrates even when
  // its cost already matches the target.
  it('always flags a legacy hash, including at its own original cost', () => {
    expect(needsRehash(legacyHash('pw-123456'), CURRENT_SCRYPT_PARAMS)).toBe(true)
    expect(needsRehash(legacyHash('pw-123456'), LEGACY_PARAMS)).toBe(true)
    expect(needsRehash(legacyHash('pw-123456'), { N: 2, r: 1, p: 1 })).toBe(true)
  })

  it('flags a versioned hash below the target cost', async () => {
    const stored = await hashPassword('pw-123456', TEST_PARAMS)

    expect(needsRehash(stored, CURRENT_SCRYPT_PARAMS)).toBe(true)
    expect(needsRehash(stored, TEST_PARAMS)).toBe(false)
  })

  it('leaves a hash at or above the target cost alone', async () => {
    const stored = await hashPassword('pw-123456', { N: 64, r: 8, p: 1 })

    expect(needsRehash(stored, TEST_PARAMS)).toBe(false)
  })

  it('returns false for a value it cannot decode', () => {
    expect(needsRehash('not-a-hash')).toBe(false)
    expect(needsRehash('scrypt$N=17,r=8,p=1$c2FsdA$aGFzaA')).toBe(false)
  })
})
