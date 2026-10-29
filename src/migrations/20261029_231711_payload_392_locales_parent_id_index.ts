import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE INDEX "services_calculator_fields_options_locales_parent_id_idx" ON "services_calculator_fields_options_locales" USING btree ("_parent_id");
  CREATE INDEX "services_calculator_fields_locales_parent_id_idx" ON "services_calculator_fields_locales" USING btree ("_parent_id");
  CREATE INDEX "services_locales_parent_id_idx" ON "services_locales" USING btree ("_parent_id");
  CREATE INDEX "_services_v_version_calculator_fields_options_locales_pa_idx" ON "_services_v_version_calculator_fields_options_locales" USING btree ("_parent_id");
  CREATE INDEX "_services_v_version_calculator_fields_locales_parent_id_idx" ON "_services_v_version_calculator_fields_locales" USING btree ("_parent_id");
  CREATE INDEX "_services_v_locales_parent_id_idx" ON "_services_v_locales" USING btree ("_parent_id");
  CREATE INDEX "projects_locales_parent_id_idx" ON "projects_locales" USING btree ("_parent_id");
  CREATE INDEX "_projects_v_locales_parent_id_idx" ON "_projects_v_locales" USING btree ("_parent_id");
  CREATE INDEX "career_listings_locales_parent_id_idx" ON "career_listings_locales" USING btree ("_parent_id");
  CREATE INDEX "company_info_locales_parent_id_idx" ON "company_info_locales" USING btree ("_parent_id");
  CREATE INDEX "legal_info_locales_parent_id_idx" ON "legal_info_locales" USING btree ("_parent_id");
  CREATE INDEX "_legal_info_v_locales_parent_id_idx" ON "_legal_info_v_locales" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "services_calculator_fields_options_locales_parent_id_idx";
  DROP INDEX "services_calculator_fields_locales_parent_id_idx";
  DROP INDEX "services_locales_parent_id_idx";
  DROP INDEX "_services_v_version_calculator_fields_options_locales_pa_idx";
  DROP INDEX "_services_v_version_calculator_fields_locales_parent_id_idx";
  DROP INDEX "_services_v_locales_parent_id_idx";
  DROP INDEX "projects_locales_parent_id_idx";
  DROP INDEX "_projects_v_locales_parent_id_idx";
  DROP INDEX "career_listings_locales_parent_id_idx";
  DROP INDEX "company_info_locales_parent_id_idx";
  DROP INDEX "legal_info_locales_parent_id_idx";
  DROP INDEX "_legal_info_v_locales_parent_id_idx";`)
}
