export const BOOTSTRAP_ADMIN_COMMAND = 'pnpm --filter @spark/api bootstrap:admin'

export function assertDevSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv !== 'production') return

  throw new Error(
    'db:seed:dev refuses to run with NODE_ENV=production.\n' +
      'It writes demo operators, facilities and dashboard accounts that all share a ' +
      'hardcoded password committed to this repository.\n' +
      `To create the first platform administrator on a real database, run:\n` +
      `  BOOTSTRAP_ADMIN_EMAIL=<email> ${BOOTSTRAP_ADMIN_COMMAND}`,
  )
}
