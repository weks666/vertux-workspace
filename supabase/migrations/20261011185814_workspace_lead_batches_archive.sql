-- Additive archive and import-run labels; existing CRM records and history stay.
BEGIN;
ALTER TABLE public.projects
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archive_reason text CHECK (length(archive_reason)<=300),
  ADD COLUMN lead_batch_id text CHECK (length(lead_batch_id) BETWEEN 1 AND 100),
  ADD COLUMN lead_batch_name text CHECK (length(lead_batch_name) BETWEEN 1 AND 160);
ALTER TABLE public.workspace_lead_records ADD COLUMN archived_previous_excluded boolean;
CREATE INDEX projects_lead_batch ON public.projects(lead_batch_id,archived_at);

CREATE FUNCTION workspace_private.lead_archive_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.projects WHERE id=NEW.project_id AND archived_at IS NOT NULL) THEN
    IF NEW.archived_previous_excluded IS NULL THEN NEW.archived_previous_excluded:=NEW.excluded; END IF;
    NEW.excluded:=true;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION workspace_private.lead_archive_gate() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER workspace_lead_archive_gate BEFORE INSERT OR UPDATE OF excluded ON public.workspace_lead_records
  FOR EACH ROW EXECUTE FUNCTION workspace_private.lead_archive_gate();

CREATE FUNCTION workspace_private.lead_project_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.workspace_lead_settings; l public.workspace_lead_records; stamp timestamptz:=clock_timestamp();
BEGIN
  IF NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN RETURN NEW; END IF;
  -- Match the RPC lock order; a claimed worker cannot complete across archival.
  SELECT ls.* INTO STRICT s FROM public.workspace_lead_settings ls JOIN workspace_private.scope ws USING(organization_id,product_id) FOR UPDATE OF ls;
  SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=NEW.id AND organization_id=s.organization_id AND product_id=s.product_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.archived_at IS NOT NULL THEN
    UPDATE public.workspace_lead_records SET archived_previous_excluded=CASE WHEN OLD.archived_at IS NULL THEN excluded ELSE archived_previous_excluded END,
      excluded=true,status='excluded',updated_at=stamp WHERE project_id=NEW.id;
    UPDATE public.workspace_lead_jobs SET status='cancelled',worker_id=NULL,lease_until=NULL,error_code='archived',updated_at=stamp
      WHERE project_id=NEW.id AND status IN ('queued','running','retry','paused');
  ELSE
    UPDATE public.workspace_lead_records SET excluded=coalesce(archived_previous_excluded,excluded),archived_previous_excluded=NULL,updated_at=stamp WHERE project_id=NEW.id;
    PERFORM workspace_private.lead_sync_status(s.organization_id,s.product_id,NEW.id,
      CASE WHEN l.opted_out THEN 'opted_out' WHEN l.purged_at IS NOT NULL THEN 'purged' WHEN coalesce(l.archived_previous_excluded,l.excluded) THEN 'excluded' ELSE coalesce(l.deep->>'status',l.quick->>'status','pending') END);
  END IF;
  PERFORM workspace_private.lead_event(s.organization_id,s.product_id,NEW.id,NULL,auth.uid(),
    CASE WHEN NEW.archived_at IS NULL THEN 'company_restored' ELSE 'company_archived' END,
    jsonb_build_object('batchId',NEW.lead_batch_id,'reason',NEW.archive_reason));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION workspace_private.lead_project_archive() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER workspace_projects_archive AFTER UPDATE OF archived_at ON public.projects
  FOR EACH ROW EXECUTE FUNCTION workspace_private.lead_project_archive();
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
  -- A reviewed imported brief stays fresh until expiry; explicit manual Deep remains available.
  IF NOT manual_job AND NOT forced AND l.quick->>'kind'='curated' AND l.expires_at>clock_timestamp() THEN RETURN NULL; END IF;
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
-- Keep the scheduler's selected set and reported counts consistent with the enqueue gate.
DO $patch$
DECLARE definition text; marker text:=$text$AND quick IS NOT NULL AND coalesce((score->>'total')::int,0)>=(cfg->>'deepThreshold')::int$text$;
BEGIN
  definition:=pg_get_functiondef('public.workspace_lead_rpc(uuid,uuid,text,jsonb)'::regprocedure);
  IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'scheduler_version_mismatch'; END IF;
  EXECUTE replace(definition,marker,marker||$text$
        AND (quick->>'kind' IS DISTINCT FROM 'curated' OR expires_at IS NULL OR expires_at<=stamp)$text$);
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;
