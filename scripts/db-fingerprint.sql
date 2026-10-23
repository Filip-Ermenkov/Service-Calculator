-- Read-only fingerprint of a database, for comparing a restored Neon branch
-- with production (infra/terraform/README.md → "Restoring the production
-- database"). Run it against both DIRECT URLs and diff the two outputs:
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "<direct url>" -X -q -v ON_ERROR_STOP=1 -f scripts/db-fingerprint.sql > prod.txt
--
-- Prints only counts, digests and timestamps — never row content.

-- Every table in public: row count and an md5 of its full content.
select t.table_name,
       (xpath('/row/n/text()', r.doc))[1]::text::int as rows,
       (xpath('/row/h/text()', r.doc))[1]::text      as md5
from information_schema.tables t
cross join lateral query_to_xml(
  format(
    'select count(*) as n, md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as h from public.%I x',
    E'\n', '', t.table_name),
  false, true, '') as r(doc)
where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
order by t.table_name;

-- The migration ledger.
select id, name, batch from payload_migrations order by id;

-- Latest content edits, in UTC so two runs compare cleanly.
set timezone = 'UTC';
select 'services' as tbl, max(updated_at) as latest from services
union all select 'company_info', max(updated_at) from company_info
union all select 'legal_info', max(updated_at) from legal_info;
