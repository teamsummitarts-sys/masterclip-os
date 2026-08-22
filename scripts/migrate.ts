/**
 * Applies pending migrations and reports what the database now holds.
 *
 * `createDb()` migrates on startup, so the app never depends on this being run
 * — but the quickstart, the build audit and package.json all name it, and it
 * was missing, so `pnpm migrate` failed with a module-not-found before it
 * touched anything. Running it explicitly is also the honest way to see the
 * schema state before starting a worker, and the only way to migrate a
 * PostgreSQL deployment ahead of a deploy rather than during one.
 */
import { createDb, migrationStatus } from '@masterclip/database'
import { applyEnvFile, loadConfig } from '@masterclip/shared'

async function main(): Promise<void> {
  applyEnvFile()
  const config = loadConfig()
  const target = config.DB_DRIVER === 'postgres' ? config.DATABASE_URL.replace(/:[^:@/]*@/, ':***@') : config.SQLITE_PATH

  // createDb runs the migrations; asking for the status afterwards reports the
  // result rather than guessing at it.
  const db = await createDb()
  try {
    const status = await migrationStatus(db)
    const applied = status.filter((m) => m.applied)
    console.log(`${config.DB_DRIVER} → ${target}`)
    for (const migration of status) console.log(`  ${migration.applied ? 'applied' : 'PENDING'}  ${migration.id}`)
    console.log(`${applied.length}/${status.length} migrations applied`)
    if (applied.length !== status.length) process.exitCode = 1
  } finally {
    await db.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
