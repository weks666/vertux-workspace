-- Isolated restored database only. All fixture changes are rolled back.
BEGIN;
DO $$ BEGIN
  IF current_database() NOT LIKE 'workspace_release_test_%' THEN
    RAISE EXCEPTION 'Refusing fixture writes outside isolated restore database';
  END IF;
END $$;
INSERT INTO auth.users(id,raw_app_meta_data)
SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  jsonb_build_object('role',CASE n WHEN 1 THEN 'owner' WHEN 2 THEN 'manager' WHEN 3 THEN 'viewer' WHEN 9 THEN 'admin' ELSE 'owner' END,
  'nexus_managed',n<>8,'nexus_access',CASE WHEN n=6 THEN 'suspended' ELSE 'active' END,
  'nexus_product_id',CASE WHEN n=5 THEN '00000000-0000-4000-8000-999999999998' ELSE s.product_id::text END,
  'nexus_organization_id',CASE WHEN n=4 THEN '00000000-0000-4000-8000-999999999999' ELSE s.organization_id::text END)
FROM generate_series(1,9) n CROSS JOIN workspace_private.scope s;
UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id='00000000-0000-4000-8000-000000000007';
INSERT INTO public.projects(id,company,raw) VALUES ('00000000-0000-4000-8000-000000000099','ISOLATED FIXTURE','{}');
INSERT INTO public.workspace_project_finance(project_id,money)
VALUES ('00000000-0000-4000-8000-000000000099','{"amount":123.45,"percent":35}');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.projects WHERE id='00000000-0000-4000-8000-000000000099';
  IF n<>1 THEN RAISE EXCEPTION 'manager cannot read lead'; END IF;
  SELECT count(*) INTO n FROM public.workspace_project_finance;
  IF n<>0 THEN RAISE EXCEPTION 'manager sees finance'; END IF;
  UPDATE public.projects SET notes='fixture manager note' WHERE id='00000000-0000-4000-8000-000000000099';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'manager cannot edit lead'; END IF;
  UPDATE public.workspace_project_finance SET money='{"amount":1}' WHERE project_id='00000000-0000-4000-8000-000000000099';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'manager can overwrite finance'; END IF;
  DELETE FROM public.workspace_project_finance WHERE project_id='00000000-0000-4000-8000-000000000099';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'manager can delete finance'; END IF;
  DELETE FROM public.projects WHERE id='00000000-0000-4000-8000-000000000099';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'manager can delete lead and cascade finance'; END IF;
  BEGIN
    INSERT INTO public.workspace_project_finance VALUES ('00000000-0000-4000-8000-000000000099','{}',now());
    RAISE EXCEPTION 'manager can insert finance';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.projects SET raw='{"money":{"amount":1}}' WHERE id='00000000-0000-4000-8000-000000000099';
    RAISE EXCEPTION 'manager can inject raw money';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.projects WHERE id='00000000-0000-4000-8000-000000000099';
  IF n<>1 THEN RAISE EXCEPTION 'viewer cannot read lead'; END IF;
  UPDATE public.projects SET notes='not allowed' WHERE id='00000000-0000-4000-8000-000000000099';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'viewer can edit lead'; END IF;
  BEGIN
    INSERT INTO public.projects(id,company) VALUES ('00000000-0000-4000-8000-000000000098','not allowed');
    RAISE EXCEPTION 'viewer can insert lead';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;

DO $$ DECLARE actor int; n int; BEGIN
  FOREACH actor IN ARRAY ARRAY[4,5,6,7,8] LOOP
    PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-'||lpad(actor::text,12,'0'),true);
    SELECT count(*) INTO n FROM public.projects;
    IF n<>0 THEN RAISE EXCEPTION 'invalid member can read leads: case %',actor; END IF;
    SELECT count(*) INTO n FROM public.workspace_project_finance;
    IF n<>0 THEN RAISE EXCEPTION 'invalid member can read finance: case %',actor; END IF;
    BEGIN
      INSERT INTO public.projects(id,company) VALUES ('00000000-0000-4000-8000-000000000098','not allowed');
      RAISE EXCEPTION 'invalid member can insert lead: case %',actor;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
END $$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.workspace_project_finance WHERE project_id='00000000-0000-4000-8000-000000000099';
  IF n<>1 THEN RAISE EXCEPTION 'owner cannot read finance'; END IF;
  UPDATE public.workspace_project_finance SET money='{"amount":234.56}' WHERE project_id='00000000-0000-4000-8000-000000000099';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'owner cannot save finance'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',true);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.workspace_project_finance WHERE project_id='00000000-0000-4000-8000-000000000099') THEN
    RAISE EXCEPTION 'admin cannot read finance';
  END IF;
END $$;

RESET ROLE;
-- A stale token that still says owner cannot override the current server record.
UPDATE auth.users SET raw_app_meta_data=jsonb_set(raw_app_meta_data,'{nexus_access}','"suspended"')
WHERE id='00000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"app_metadata":{"role":"owner","nexus_access":"active"}}',true);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.projects) OR EXISTS(SELECT 1 FROM public.workspace_project_finance) THEN
    RAISE EXCEPTION 'stale role bypassed current membership';
  END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.projects; RAISE EXCEPTION 'anonymous can read leads';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM public.workspace_project_finance; RAISE EXCEPTION 'anonymous can read finance';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK;
