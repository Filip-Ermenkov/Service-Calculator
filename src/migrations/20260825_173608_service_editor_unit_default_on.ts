import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "home_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"service_card_limit" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "services_calculator_fields" ADD COLUMN "default_on" boolean DEFAULT false;
  ALTER TABLE "services_calculator_fields_locales" ADD COLUMN "unit" varchar;
  ALTER TABLE "_services_v_version_calculator_fields" ADD COLUMN "default_on" boolean DEFAULT false;
  ALTER TABLE "_services_v_version_calculator_fields_locales" ADD COLUMN "unit" varchar;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "home_settings" CASCADE;
  ALTER TABLE "services_calculator_fields" DROP COLUMN "default_on";
  ALTER TABLE "services_calculator_fields_locales" DROP COLUMN "unit";
  ALTER TABLE "_services_v_version_calculator_fields" DROP COLUMN "default_on";
  ALTER TABLE "_services_v_version_calculator_fields_locales" DROP COLUMN "unit";`)
}
