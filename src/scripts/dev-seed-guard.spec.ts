import { assertDevSeedAllowed } from './dev-seed-guard'

describe('assertDevSeedAllowed', () => {
  it('refuses to run when NODE_ENV=production', () => {
    expect(() => assertDevSeedAllowed('production')).toThrow(/refuses to run/i)
  })

  it('names the bootstrap command to run instead', () => {
    expect(() => assertDevSeedAllowed('production')).toThrow(/bootstrap:admin/)
    expect(() => assertDevSeedAllowed('production')).toThrow(/BOOTSTRAP_ADMIN_EMAIL/)
  })

  it('allows development, test, and an unset NODE_ENV', () => {
    expect(() => assertDevSeedAllowed('development')).not.toThrow()
    expect(() => assertDevSeedAllowed('test')).not.toThrow()
    expect(() => assertDevSeedAllowed(undefined)).not.toThrow()
  })
})
