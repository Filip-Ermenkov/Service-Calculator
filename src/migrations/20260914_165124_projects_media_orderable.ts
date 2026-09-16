import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'
import { generateNKeysBetween } from 'payload/shared'

/**
 * Drag ordering (`orderable: true`) for Projects and Media — adds Payload's
 * fractional-index `_order` column (+ the `_projects_v` version twin) and the
 * indexes, exactly as `migrate:create` generated them.
 *
 * HAND-ADDED: a backfill of `_order` for the rows that already exist.
 * Payload can cope without it — on the first drag it runs an "initial
 * migration" that re-saves every keyless document — but that path (a) fires
 * every afterChange hook per document, i.e. one CloudFront invalidation and one
 * translation pass EACH, and (b) assigns keys in whatever order the rows come
 * back, so the public Projects grid would silently reshuffle the moment someone
 * first touched a handle. Assigning the keys here, deterministically, keeps the
 * live order identical to what the site showed before this migration:
 *   • projects — newest completion date first (the old `-completionDate` sort);
 *   • media    — newest upload first (what a library reads as).
 * Fractional keys are minted with Payload's own generator, so they are the same
 * shape the app writes at runtime (`a0`, `a1`, … strings that sort correctly).
 */

async function backfillOrder(
  db: MigrateUpArgs['db'],
  table: 'media' | 'projects',
  orderBy: string,
): Promise<void> {
  const res = await db.execute(sql.raw(`SELECT id FROM "${table}" WHERE "_order" IS NULL ORDER BY ${orderBy}`))
  const rows = (res as unknown as { rows?: { id: number | string }[] }).rows ?? []
  if (rows.length === 0) return
  const keys = generateNKeysBetween(null, null, rows.length)
  for (let i = 0; i < rows.length; i++) {
    const id = Number(rows[i].id)
    await db.execute(sql.raw(`UPDATE "${table}" SET "_order" = '${keys[i]}' WHERE id = ${id}`))
    if (table === 'projects') {
      // Drafts are read from the versions table; keep every snapshot in step.
      await db.execute(sql.raw(`UPDATE "_projects_v" SET "version__order" = '${keys[i]}' WHERE parent_id = ${id}`))
    }
  }
}

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "media" ADD COLUMN "_order" varchar;
  ALTER TABLE "projects" ADD COLUMN "_order" varchar;
  ALTER TABLE "_projects_v" ADD COLUMN "version__order" varchar;
  CREATE INDEX "media__order_idx" ON "media" USING btree ("_order");
  CREATE INDEX "projects__order_idx" ON "projects" USING btree ("_order");
  CREATE INDEX "_projects_v_version_version__order_idx" ON "_projects_v" USING btree ("version__order");`)

  await backfillOrder(db, 'projects', '"completion_date" DESC NULLS LAST, id DESC')
  await backfillOrder(db, 'media', '"created_at" DESC NULLS LAST, id DESC')
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "media__order_idx";
  DROP INDEX "projects__order_idx";
  DROP INDEX "_projects_v_version_version__order_idx";
  ALTER TABLE "media" DROP COLUMN "_order";
  ALTER TABLE "projects" DROP COLUMN "_order";
  ALTER TABLE "_projects_v" DROP COLUMN "version__order";`)
}
