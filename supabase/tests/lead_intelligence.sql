-- Read-only structural assertions after an isolated migration/restore.
-- Behavioral data fixtures run in tests/lead-store-sql.test.mjs (PGlite/PG).
BEGIN;
DO $$ DECLARE t text; f record; n int; BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_lead_settings','workspace_lead_records','workspace_lead_jobs','workspace_lead_daily','workspace_lead_events','workspace_lead_replies','workspace_lead_usage'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relname=t AND c.relrowsecurity) THEN RAISE EXCEPTION 'RLS disabled on %',t; END IF;
    IF has_table_privilege('anon','public.'||t,'SELECT') OR has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'Unexpected client write/public read on %',t; END IF;
    IF NOT has_table_privilege('service_role','public.'||t,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Missing service privileges on %',t; END IF;
    SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name IN ('organization_id','product_id') AND is_nullable='NO';
    IF n<>2 THEN RAISE EXCEPTION 'Missing scope on %',t; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname=t AND tr.tgname='lead_scope_immutable') THEN RAISE EXCEPTION 'Mutable scope on %',t; END IF;
  END LOOP;
  IF has_function_privilege('anon','public.workspace_lead_rpc(uuid,uuid,text,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.workspace_lead_rpc(uuid,uuid,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Client can impersonate service RPC'; END IF;
  IF NOT has_function_privilege('service_role','public.workspace_lead_rpc(uuid,uuid,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Service RPC inaccessible'; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.workspace_lead_rpc(uuid,uuid,text,jsonb)'::regprocedure AND prosecdef) THEN RAISE EXCEPTION 'Public RPC must not be SECURITY DEFINER'; END IF;
  FOR f IN SELECT p.oid,p.proname,p.proconfig FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='workspace_private' AND p.proname LIKE 'lead_%' LOOP
    IF has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE') THEN RAISE EXCEPTION 'Exposed helper %',f.proname; END IF;
    IF NOT coalesce(f.proconfig @> ARRAY['search_path=""'],false) THEN RAISE EXCEPTION 'Unpinned search path on %',f.proname; END IF;
  END LOOP;
END $$;
ROLLBACK;
