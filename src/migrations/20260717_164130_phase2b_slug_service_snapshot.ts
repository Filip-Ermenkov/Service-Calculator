import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "services" ADD COLUMN "slug" varchar;
  ALTER TABLE "_services_v" ADD COLUMN "version_slug" varchar;
  ALTER TABLE "projects" ADD COLUMN "service_name" varchar;
  ALTER TABLE "_projects_v" ADD COLUMN "version_service_name" varchar;

  -- Backfill service slugs from the English title; guarantee uniqueness by
  -- appending the id on any collision. (New/edited services get their slug from
  -- the app-level formatSlug hook, which also folds accents; this SQL fallback is
  -- a one-time pass over pre-existing rows — refine any awkward slug in the admin.)
  WITH base AS (
    SELECT s.id,
      NULLIF(regexp_replace(regexp_replace(lower(trim(coalesce(sl.title,''))),
        '[^a-z0-9]+','-','g'), '(^-+|-+$)','','g'), '') AS slug
    FROM services s
    LEFT JOIN services_locales sl ON sl._parent_id = s.id AND sl._locale = 'en'
  )
  UPDATE services s SET slug = CASE
    WHEN b.slug IS NULL THEN 'service-' || s.id
    WHEN (SELECT count(*) FROM base b2 WHERE b2.slug = b.slug) > 1 THEN b.slug || '-' || s.id
    ELSE b.slug END
  FROM base b WHERE b.id = s.id AND s.slug IS NULL;

  -- Backfill the service-name snapshot from each project's current linked service.
  UPDATE projects p SET service_name = sl.title
  FROM services_locales sl
  WHERE sl._parent_id = p.service_id AND sl._locale = 'en' AND p.service_id IS NOT NULL;

  CREATE UNIQUE INDEX "services_slug_idx" ON "services" USING btree ("slug");
  CREATE INDEX "_services_v_version_version_slug_idx" ON "_services_v" USING btree ("version_slug");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "services_slug_idx";
  DROP INDEX "_services_v_version_version_slug_idx";
  ALTER TABLE "services" DROP COLUMN "slug";
  ALTER TABLE "_services_v" DROP COLUMN "version_slug";
  ALTER TABLE "projects" DROP COLUMN "service_name";
  ALTER TABLE "_projects_v" DROP COLUMN "version_service_name";`)
}
