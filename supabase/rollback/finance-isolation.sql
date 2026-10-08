-- Emergency compatibility rollback; removes the new finance isolation.
-- Keep the release backup. Run only after pausing writes and restoring the old UI.
BEGIN;
LOCK TABLE public.projects, public.workspace_project_finance IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.projects DROP CONSTRAINT workspace_no_finance_in_raw;
UPDATE public.projects p SET raw=coalesce(p.raw,'{}'::jsonb)||jsonb_build_object('money',f.money)
FROM public.workspace_project_finance f WHERE f.project_id=p.id;
DROP TABLE public.workspace_project_finance;
DROP POLICY projects_read ON public.projects;
DROP POLICY projects_insert ON public.projects;
DROP POLICY projects_update ON public.projects;
DROP POLICY projects_delete ON public.projects;
CREATE POLICY projects_read ON public.projects FOR SELECT TO authenticated USING (true);
CREATE POLICY projects_write ON public.projects FOR ALL TO authenticated
  USING ((auth.jwt()->'app_metadata'->>'role') IN ('owner','admin','manager'))
  WITH CHECK ((auth.jwt()->'app_metadata'->>'role') IN ('owner','admin','manager'));
DROP FUNCTION workspace_private.current_role();
DROP TABLE workspace_private.scope;
DROP SCHEMA workspace_private;
NOTIFY pgrst, 'reload schema';
COMMIT;
