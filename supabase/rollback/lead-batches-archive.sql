-- Operator-only rollback: archive/run metadata must be backed up first.
BEGIN;
DO $patch$
DECLARE definition text; marker text:=$text$
        AND (quick->>'kind' IS DISTINCT FROM 'curated' OR expires_at IS NULL OR expires_at<=stamp)$text$;
BEGIN
  definition:=pg_get_functiondef('public.workspace_lead_rpc(uuid,uuid,text,jsonb)'::regprocedure);
  IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'scheduler_version_mismatch'; END IF;
  EXECUTE replace(definition,marker,'');
END $patch$;
DROP TRIGGER workspace_projects_archive ON public.projects;
DROP TRIGGER workspace_lead_archive_gate ON public.workspace_lead_records;
UPDATE public.workspace_lead_records SET excluded=coalesce(archived_previous_excluded,excluded) WHERE archived_previous_excluded IS NOT NULL;
SELECT workspace_private.lead_sync_status(organization_id,product_id,project_id,coalesce(deep->>'status',quick->>'status','pending')) FROM public.workspace_lead_records WHERE archived_previous_excluded IS NOT NULL;
DROP FUNCTION workspace_private.lead_project_archive();
DROP FUNCTION workspace_private.lead_archive_gate();
ALTER TABLE public.workspace_lead_records DROP COLUMN archived_previous_excluded;
ALTER TABLE public.projects DROP COLUMN archived_at,DROP COLUMN archive_reason,DROP COLUMN lead_batch_id,DROP COLUMN lead_batch_name;
CREATE OR REPLACE FUNCTION workspace_private.lead_enqueue(org uuid,product uuid,project uuid,job_kind text,forced boolean DEFAULT false,job_priority int DEFAULT 0,manual_job boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE l public.workspace_lead_records; j public.workspace_lead_jobs;
BEGIN
  IF job_kind NOT IN ('quick','deep') THEN RAISE EXCEPTION 'invalid_kind'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=project) THEN RAISE EXCEPTION 'not_found'; END IF;
  INSERT INTO public.workspace_lead_records(organization_id,product_id,project_id) VALUES(org,product,project) ON CONFLICT(project_id) DO NOTHING;
  SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=project AND organization_id=org AND product_id=product FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_mismatch'; END IF;
  IF l.excluded OR l.purged_at IS NOT NULL THEN RAISE EXCEPTION 'excluded'; END IF;
  IF l.opted_out THEN RAISE EXCEPTION 'opted_out'; END IF;
  SELECT * INTO j FROM public.workspace_lead_jobs WHERE organization_id=org AND product_id=product AND project_id=project AND kind=job_kind AND status IN ('queued','running','retry','paused');
  IF FOUND THEN RETURN to_jsonb(j); END IF;
  IF NOT forced AND ((job_kind='quick' AND l.quick IS NOT NULL) OR (job_kind='deep' AND l.deep IS NOT NULL))
    AND coalesce((CASE WHEN job_kind='quick' THEN l.quick ELSE l.deep END->>'expiresAt')::timestamptz,l.expires_at) > clock_timestamp() THEN
    SELECT * INTO j FROM public.workspace_lead_jobs WHERE organization_id=org AND product_id=product AND project_id=project AND kind=job_kind AND status='completed' ORDER BY completed_at DESC LIMIT 1;
    IF FOUND THEN RETURN to_jsonb(j); END IF;
    RETURN NULL;
  END IF;
  INSERT INTO public.workspace_lead_jobs(organization_id,product_id,project_id,kind,priority,manual,force)
  VALUES(org,product,project,job_kind,job_priority,manual_job,forced) RETURNING * INTO j;
  PERFORM workspace_private.lead_sync_status(org,product,project);
  PERFORM workspace_private.lead_event(org,product,project,j.id,NULL,'queued',jsonb_build_object('kind',job_kind,'manual',manual_job));
  RETURN to_jsonb(j);
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
