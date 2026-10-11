-- Dedicated subscription demo jobs. Existing curated briefs/materials are preserved.
BEGIN;
ALTER TABLE public.workspace_lead_records ADD COLUMN demo jsonb
  CHECK(demo IS NULL OR (jsonb_typeof(demo)='object' AND octet_length(demo::text)<=200000));
ALTER TABLE public.workspace_lead_jobs DROP CONSTRAINT workspace_lead_jobs_kind_check;
ALTER TABLE public.workspace_lead_jobs ADD CONSTRAINT workspace_lead_jobs_kind_check CHECK(kind IN ('quick','deep','demo'));
DO $patch$
DECLARE d text; p record;
BEGIN
  d:=pg_get_functiondef('workspace_private.lead_defaults()'::regprocedure);
  IF position('"deepModel":"openai/gpt-4.1-mini"' IN d)=0 THEN RAISE EXCEPTION 'defaults_version_mismatch'; END IF;
  EXECUTE replace(d,'"deepModel":"openai/gpt-4.1-mini"','"deepModel":"openai/gpt-4.1-mini","demoModel":"openai/gpt-4.1-mini"');
  d:=pg_get_functiondef('workspace_private.lead_validate_settings(jsonb)'::regprocedure);
  IF position($s$ARRAY['quickModel','deepModel']$s$ IN d)=0 THEN RAISE EXCEPTION 'settings_version_mismatch'; END IF;
  EXECUTE replace(d,$s$ARRAY['quickModel','deepModel']$s$,$s$ARRAY['quickModel','deepModel','demoModel']$s$);
  UPDATE public.workspace_lead_settings SET config=config||jsonb_build_object('demoModel',config->>'deepModel');
  d:=pg_get_functiondef('workspace_private.lead_enqueue(uuid,uuid,uuid,text,boolean,integer,boolean)'::regprocedure);
  IF position($s$job_kind NOT IN ('quick','deep')$s$ IN d)=0 THEN RAISE EXCEPTION 'enqueue_version_mismatch'; END IF;
  d:=replace(d,$s$job_kind NOT IN ('quick','deep')$s$,$s$job_kind NOT IN ('quick','deep','demo')$s$);
  d:=replace(d,$s$  IF NOT EXISTS(SELECT 1 FROM public.projects$s$,$s$  IF job_kind='demo' AND (NOT manual_job OR NOT EXISTS(SELECT 1 FROM public.workspace_lead_settings WHERE organization_id=org AND product_id=product AND (config->>'aiEnabled')::boolean AND config->>'aiProvider'='chatgpt_plan')) THEN RAISE EXCEPTION 'ai_disabled'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.projects$s$);
  EXECUTE d;
  d:=pg_get_functiondef('public.workspace_lead_rpc(uuid,uuid,text,jsonb)'::regprocedure);
  FOR p IN SELECT * FROM (VALUES
    ($s$j2.kind='deep' AND d.deep_started$s$,$s$j2.kind IN ('deep','demo') AND d.deep_started$s$),
    ($s$CASE WHEN j.kind='deep' THEN 1 ELSE 0 END$s$,$s$CASE WHEN j.kind IN ('deep','demo') THEN 1 ELSE 0 END$s$),
    ($s$CASE WHEN attempts>=(cfg->>'maxAttempts')::int THEN 'failed'$s$,$s$CASE WHEN kind='demo' OR attempts>=(cfg->>'maxAttempts')::int THEN 'failed'$s$),
    ($s$state_value:=CASE WHEN j.attempts>=(cfg->>'maxAttempts')::int THEN 'failed'$s$,$s$state_value:=CASE WHEN j.kind='demo' OR j.attempts>=(cfg->>'maxAttempts')::int THEN 'failed'$s$),
    ($s$quick=NULL,deep=NULL$s$,$s$quick=NULL,deep=NULL,demo=NULL$s$),
    ($s$  ELSIF p_action='enqueue' THEN$s$,$s$  ELSIF p_action='enqueue' THEN
    IF p_payload->>'kind'='demo' AND actor IS NOT NULL AND actor_role<>'owner' THEN RAISE EXCEPTION 'scope_mismatch'; END IF;$s$),
    ($s$      UPDATE public.workspace_lead_records SET quick=CASE$s$,$s$      IF j.kind='demo' THEN
        IF v->>'status' IS DISTINCT FROM 'completed' OR v->'ai'->>'status' IS DISTINCT FROM 'generated' OR v->'ai'->>'billing' IS DISTINCT FROM 'chatgpt_plan' OR jsonb_typeof(v->'html') IS DISTINCT FROM 'string' OR coalesce(length(v->>'html'),0) NOT BETWEEN 100 AND 100000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
        UPDATE public.workspace_lead_records SET demo=v,updated_at=stamp WHERE project_id=j.project_id;
        UPDATE public.workspace_lead_jobs SET status='completed',worker_id=NULL,lease_until=NULL,completed_at=stamp,updated_at=stamp,progress='{"stage":"completed"}' WHERE id=jid;
        PERFORM workspace_private.lead_sync_status(p_organization_id,p_product_id,j.project_id,coalesce(l.deep->>'status',l.quick->>'status','pending'));
        PERFORM workspace_private.lead_event(p_organization_id,p_product_id,j.project_id,jid,NULL,'demo_generated');
        RETURN (SELECT to_jsonb(x) FROM public.workspace_lead_records x WHERE project_id=j.project_id);
      END IF;
      UPDATE public.workspace_lead_records SET quick=CASE$s$)
  ) AS patches(before_text,after_text) LOOP
    IF position(p.before_text IN d)=0 THEN RAISE EXCEPTION 'demo_rpc_version_mismatch'; END IF;
    d:=replace(d,p.before_text,p.after_text);
  END LOOP;
  EXECUTE d;
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;
