-- Dedicated Vertux Workspace data plane. Run inside a transaction after backup.
-- Operator sets workspace.release.organization_id and workspace.release.product_id.
-- No credentials or user-generated authorization fields are accepted here.
CREATE SCHEMA IF NOT EXISTS workspace_private;
REVOKE ALL ON SCHEMA workspace_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA workspace_private TO authenticated;

CREATE TABLE workspace_private.scope (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL
);
REVOKE ALL ON workspace_private.scope FROM PUBLIC, anon, authenticated;
INSERT INTO workspace_private.scope(organization_id,product_id)
VALUES (current_setting('workspace.release.organization_id')::uuid,
        current_setting('workspace.release.product_id')::uuid);

-- Read current server-owned membership metadata, not potentially stale JWT roles.
-- SECURITY DEFINER is narrowly scoped: no arguments, no dynamic SQL, no user data
-- returned, exact product/organization binding, an empty search_path, explicit ACL.
CREATE FUNCTION workspace_private.current_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.raw_app_meta_data->>'role'
  FROM auth.users u CROSS JOIN workspace_private.scope s
  WHERE u.id = (SELECT auth.uid())
    AND u.deleted_at IS NULL
    AND (u.banned_until IS NULL OR u.banned_until <= now())
    AND u.raw_app_meta_data->>'nexus_managed' = 'true'
    AND u.raw_app_meta_data->>'nexus_access' = 'active'
    AND u.raw_app_meta_data->>'nexus_organization_id' = s.organization_id::text
    AND u.raw_app_meta_data->>'nexus_product_id' = s.product_id::text
    AND u.raw_app_meta_data->>'role' IN ('owner','admin','manager','viewer')
$$;
REVOKE ALL ON FUNCTION workspace_private.current_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION workspace_private.current_role() TO authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.projects WHERE raw ? 'money'
             AND jsonb_typeof(raw->'money') IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'Finance migration requires object-shaped legacy money';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
             AND tablename='projects' AND policyname NOT IN ('projects_read','projects_write')) THEN
    RAISE EXCEPTION 'Unexpected projects policy: inspect before migrating';
  END IF;
END $$;

CREATE TABLE public.workspace_project_finance (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  money jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(money)='object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.workspace_project_finance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_project_finance FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_project_finance TO authenticated;
GRANT ALL ON public.workspace_project_finance TO service_role;
CREATE POLICY finance_read ON public.workspace_project_finance FOR SELECT TO authenticated
  USING ((SELECT workspace_private.current_role()) IN ('owner','admin'));
CREATE POLICY finance_insert ON public.workspace_project_finance FOR INSERT TO authenticated
  WITH CHECK ((SELECT workspace_private.current_role()) IN ('owner','admin'));
CREATE POLICY finance_update ON public.workspace_project_finance FOR UPDATE TO authenticated
  USING ((SELECT workspace_private.current_role()) IN ('owner','admin'))
  WITH CHECK ((SELECT workspace_private.current_role()) IN ('owner','admin'));
CREATE POLICY finance_delete ON public.workspace_project_finance FOR DELETE TO authenticated
  USING ((SELECT workspace_private.current_role()) IN ('owner','admin'));

INSERT INTO public.workspace_project_finance(project_id,money,updated_at)
SELECT id,raw->'money',coalesce(updated_at,clock_timestamp())
FROM public.projects WHERE raw ? 'money';
UPDATE public.projects SET raw=raw-'money' WHERE raw ? 'money';
ALTER TABLE public.projects ADD CONSTRAINT workspace_no_finance_in_raw
  CHECK (NOT (coalesce(raw,'{}'::jsonb) ? 'money'));

DROP POLICY projects_read ON public.projects;
DROP POLICY projects_write ON public.projects;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.projects FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
CREATE POLICY projects_read ON public.projects FOR SELECT TO authenticated
  USING ((SELECT workspace_private.current_role()) IN ('owner','admin','manager','viewer'));
CREATE POLICY projects_insert ON public.projects FOR INSERT TO authenticated
  WITH CHECK ((SELECT workspace_private.current_role()) IN ('owner','admin','manager'));
CREATE POLICY projects_update ON public.projects FOR UPDATE TO authenticated
  USING ((SELECT workspace_private.current_role()) IN ('owner','admin','manager'))
  WITH CHECK ((SELECT workspace_private.current_role()) IN ('owner','admin','manager'));
CREATE POLICY projects_delete ON public.projects FOR DELETE TO authenticated
  USING ((SELECT workspace_private.current_role()) IN ('owner','admin'));

NOTIFY pgrst, 'reload schema';
