-- Additive, dedicated Workspace data plane. Requires finance isolation migration.
-- Offline verification: node --test tests/lead-store-sql.test.mjs
-- Production application is a separate release step after backup/restore review.
BEGIN;
DO $$ BEGIN
  IF to_regclass('workspace_private.scope') IS NULL OR
     to_regprocedure('workspace_private.current_role()') IS NULL THEN
    RAISE EXCEPTION 'Apply Workspace finance isolation before Lead Intelligence';
  END IF;
END $$;
ALTER TABLE workspace_private.scope ADD CONSTRAINT lead_scope_unique UNIQUE(organization_id,product_id);
GRANT USAGE ON SCHEMA workspace_private TO service_role;
GRANT SELECT ON workspace_private.scope TO service_role;
GRANT SELECT ON public.projects TO service_role;

CREATE FUNCTION workspace_private.lead_defaults() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT '{
 "enabled":true,"paused":false,"autoQuick":true,"autoDeep":true,
 "dailyQuick":500,"dailyDeep":50,"deepThreshold":60,"scheduleTime":"09:00",
 "timezone":"Europe/Moscow","staleDays":30,"retentionDays":90,"concurrency":2,"maxAttempts":3,
 "maxPagesQuick":2,"maxPagesDeep":6,"requestTimeoutMs":12000,"requestsPerHostDelayMs":1000,
 "aiEnabled":false,"aiProvider":"openrouter","dailyPlanRequests":10,"quickModel":"openai/gpt-4.1-mini","deepModel":"openai/gpt-4.1-mini",
 "dailyBudgetUsd":0,"companyBudgetUsd":0,"maxInputTokens":12000,"maxOutputTokens":1800,
 "industryProfiles":["hotel","restaurant","banquet","general"],
 "scoreWeights":{"fit":25,"opportunity":30,"contacts":20,"freshness":10,"confidence":15},
 "communication":{"mode":"drafts","dailySendLimit":0}
}'::jsonb $$;

CREATE FUNCTION workspace_private.lead_validate_settings(v jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE k text; n numeric; bounds jsonb; item jsonb;
BEGIN
  IF jsonb_typeof(v) <> 'object' OR (v - ARRAY(SELECT jsonb_object_keys(workspace_private.lead_defaults()))) <> '{}'::jsonb
    OR NOT v ?& ARRAY(SELECT jsonb_object_keys(workspace_private.lead_defaults())) THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['enabled','paused','autoQuick','autoDeep','aiEnabled'] LOOP
    IF jsonb_typeof(v->k) <> 'boolean' THEN RETURN false; END IF;
  END LOOP;
  bounds := '{"dailyQuick":[0,10000],"dailyDeep":[0,1000],"dailyPlanRequests":[1,50],"deepThreshold":[0,100],"staleDays":[1,365],"retentionDays":[7,365],"concurrency":[1,6],"maxAttempts":[1,5],"maxPagesQuick":[1,4],"maxPagesDeep":[1,12],"requestTimeoutMs":[2000,30000],"requestsPerHostDelayMs":[500,30000],"maxInputTokens":[3000,32000],"maxOutputTokens":[300,4000]}'::jsonb;
  FOR k,item IN SELECT * FROM jsonb_each(bounds) LOOP
    IF jsonb_typeof(v->k) <> 'number' THEN RETURN false; END IF;
    n := (v->>k)::numeric;
    IF n <> trunc(n) OR n < (item->>0)::numeric OR n > (item->>1)::numeric THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['dailyBudgetUsd','companyBudgetUsd'] LOOP
    IF jsonb_typeof(v->k) <> 'number' THEN RETURN false; END IF;
    n := (v->>k)::numeric;
    IF n < 0 OR n > 10000 OR n*1000000000 <> trunc(n*1000000000) THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(v->'scheduleTime') <> 'string' OR v->>'scheduleTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    OR jsonb_typeof(v->'timezone') <> 'string'
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=v->>'timezone') THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['quickModel','deepModel'] LOOP
    IF jsonb_typeof(v->k) <> 'string' OR length(v->>k) NOT BETWEEN 3 AND 150 OR v->>k !~ '^[A-Za-z0-9._:/-]+$' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(v->'industryProfiles') <> 'array' OR jsonb_array_length(v->'industryProfiles') NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(v->'industryProfiles') LOOP
    IF jsonb_typeof(item) <> 'string' OR length(item#>>'{}') NOT BETWEEN 1 AND 60 THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(v->'scoreWeights') <> 'object' OR NOT (v->'scoreWeights') ?& ARRAY['fit','opportunity','contacts','freshness','confidence']
    OR ((v->'scoreWeights') - ARRAY['fit','opportunity','contacts','freshness','confidence']) <> '{}'::jsonb THEN RETURN false; END IF;
  n := 0;
  FOR k,item IN SELECT * FROM jsonb_each(v->'scoreWeights') LOOP
    IF jsonb_typeof(item) <> 'number' OR (item#>>'{}')::numeric NOT BETWEEN 0 AND 100 OR (item#>>'{}')::numeric<>trunc((item#>>'{}')::numeric) THEN RETURN false; END IF;
    n := n+(item#>>'{}')::numeric;
  END LOOP;
  IF n <> 100 OR v->'communication' <> '{"mode":"drafts","dailySendLimit":0}'::jsonb THEN RETURN false; END IF;
  IF jsonb_typeof(v->'aiProvider')<>'string' OR v->>'aiProvider' NOT IN ('openrouter','chatgpt_plan') THEN RETURN false; END IF;
  IF (v->>'maxPagesQuick')::int>(v->>'maxPagesDeep')::int OR (v->>'companyBudgetUsd')::numeric>(v->>'dailyBudgetUsd')::numeric
    OR ((v->>'aiEnabled')::boolean AND v->>'aiProvider'='openrouter' AND ((v->>'dailyBudgetUsd')::numeric<=0 OR (v->>'companyBudgetUsd')::numeric<=0)) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE TABLE public.workspace_lead_settings (
  organization_id uuid NOT NULL, product_id uuid NOT NULL,
  config jsonb NOT NULL DEFAULT workspace_private.lead_defaults() CHECK (workspace_private.lead_validate_settings(config)),
  last_schedule_date date, last_retention_date date, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,product_id),
  FOREIGN KEY(organization_id,product_id) REFERENCES workspace_private.scope(organization_id,product_id)
);
INSERT INTO public.workspace_lead_settings(organization_id,product_id) SELECT organization_id,product_id FROM workspace_private.scope;

CREATE TABLE public.workspace_lead_records (
  organization_id uuid NOT NULL, product_id uuid NOT NULL,
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending', quick jsonb, deep jsonb, score jsonb,
  materials jsonb, materials_revision bigint NOT NULL DEFAULT 0 CHECK(materials_revision>=0),
  materials_edited boolean NOT NULL DEFAULT false,
  checked_at timestamptz, expires_at timestamptz,
  excluded boolean NOT NULL DEFAULT false, opted_out boolean NOT NULL DEFAULT false,
  contact_permission jsonb, purged_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,product_id,project_id),
  FOREIGN KEY(organization_id,product_id) REFERENCES public.workspace_lead_settings(organization_id,product_id),
  CHECK(quick IS NULL OR jsonb_typeof(quick)='object'),
  CHECK(deep IS NULL OR jsonb_typeof(deep)='object'),
  CHECK(materials IS NULL OR jsonb_typeof(materials)='object')
);
CREATE TABLE public.workspace_lead_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, product_id uuid NOT NULL,
  project_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('quick','deep')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry','paused','completed','failed','cancelled')),
  priority integer NOT NULL DEFAULT 0 CHECK(priority BETWEEN -1000 AND 1000),
  manual boolean NOT NULL DEFAULT false, force boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), progress jsonb NOT NULL DEFAULT '{}',
  error_code text, worker_id text, lease_until timestamptz,
  materials_revision_snapshot bigint, next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz, completed_at timestamptz,
  UNIQUE(organization_id,product_id,id),
  FOREIGN KEY(organization_id,product_id,project_id) REFERENCES public.workspace_lead_records(organization_id,product_id,project_id) ON DELETE CASCADE,
  CHECK((status='running') = (worker_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX workspace_lead_records_updated ON public.workspace_lead_records(organization_id,product_id,updated_at,project_id);
CREATE UNIQUE INDEX workspace_lead_jobs_one_active ON public.workspace_lead_jobs(organization_id,product_id,project_id,kind)
  WHERE status IN ('queued','running','retry','paused');
CREATE INDEX workspace_lead_jobs_claim ON public.workspace_lead_jobs(organization_id,product_id,status,next_run_at,priority DESC,created_at);
CREATE TABLE public.workspace_lead_daily (
  organization_id uuid NOT NULL, product_id uuid NOT NULL, usage_date date NOT NULL,
  quick_started integer NOT NULL DEFAULT 0 CHECK(quick_started>=0), deep_started integer NOT NULL DEFAULT 0 CHECK(deep_started>=0),
  PRIMARY KEY(organization_id,product_id,usage_date),
  FOREIGN KEY(organization_id,product_id) REFERENCES public.workspace_lead_settings(organization_id,product_id)
);
CREATE TABLE public.workspace_lead_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, product_id uuid NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.workspace_lead_jobs(id) ON DELETE SET NULL,
  actor_id uuid, kind text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(organization_id,product_id) REFERENCES public.workspace_lead_settings(organization_id,product_id)
);
CREATE INDEX workspace_lead_events_recent ON public.workspace_lead_events(organization_id,product_id,created_at DESC);
CREATE TABLE public.workspace_lead_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, product_id uuid NOT NULL,
  project_id uuid NOT NULL, reply jsonb NOT NULL CHECK(jsonb_typeof(reply)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(organization_id,product_id,project_id) REFERENCES public.workspace_lead_records(organization_id,product_id,project_id) ON DELETE CASCADE
);
CREATE TABLE public.workspace_lead_usage (
  organization_id uuid NOT NULL, product_id uuid NOT NULL, request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.workspace_lead_jobs(id) ON DELETE SET NULL,
  model text NOT NULL CHECK(length(model) BETWEEN 1 AND 150),
  provider text NOT NULL DEFAULT 'openrouter' CHECK(provider IN ('openrouter','chatgpt_plan')),
  kind text NOT NULL DEFAULT 'api' CHECK(kind IN ('api','plan')),
  usage_date date NOT NULL, state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','uncertain','released')),
  reserved_nanos bigint NOT NULL CHECK(reserved_nanos>=0), cost_nanos bigint NOT NULL DEFAULT 0 CHECK(cost_nanos>=0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0), output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
  quoted_input_tokens bigint NOT NULL DEFAULT 0 CHECK(quoted_input_tokens>=0), quoted_output_tokens bigint NOT NULL DEFAULT 0 CHECK(quoted_output_tokens>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,product_id,request_id),
  FOREIGN KEY(organization_id,product_id) REFERENCES public.workspace_lead_settings(organization_id,product_id),
  -- Plan reservations consume a request quota, never a fabricated USD charge.
  CHECK((provider='chatgpt_plan' AND kind='plan' AND reserved_nanos=0 AND cost_nanos=0) OR (provider='openrouter' AND kind='api'))
);
CREATE INDEX workspace_lead_usage_day ON public.workspace_lead_usage(organization_id,product_id,usage_date);
CREATE INDEX workspace_lead_usage_company ON public.workspace_lead_usage(organization_id,product_id,project_id);

-- Defense in depth for service mistakes; scoped identities cannot be reassigned.
CREATE FUNCTION workspace_private.lead_immutable_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN RAISE EXCEPTION 'scope_mismatch'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_lead_settings','workspace_lead_records','workspace_lead_jobs','workspace_lead_daily','workspace_lead_events','workspace_lead_replies','workspace_lead_usage'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
    EXECUTE format('CREATE POLICY lead_read ON public.%I FOR SELECT TO authenticated USING ((SELECT workspace_private.current_role()) IN (''owner'',''admin'',''manager'',''viewer''))',t);
    EXECUTE format('CREATE TRIGGER lead_scope_immutable BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION workspace_private.lead_immutable_scope()',t);
  END LOOP;
END $$;

CREATE FUNCTION workspace_private.lead_event(org uuid,product uuid,project uuid,job uuid,actor uuid,event_kind text,data jsonb DEFAULT '{}') RETURNS void
LANGUAGE sql SET search_path='' AS $$
 INSERT INTO public.workspace_lead_events(organization_id,product_id,project_id,job_id,actor_id,kind,details)
 VALUES(org,product,project,job,actor,event_kind,data)
$$;

CREATE FUNCTION workspace_private.lead_sync_status(org uuid,product uuid,project uuid,fallback text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE l public.workspace_lead_records; state_value text; last_status text;
BEGIN
  SELECT * INTO l FROM public.workspace_lead_records WHERE organization_id=org AND product_id=product AND project_id=project FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF l.purged_at IS NOT NULL THEN state_value:='purged';
  ELSIF l.opted_out THEN state_value:='opted_out';
  ELSIF l.excluded THEN state_value:='excluded';
  ELSIF EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE organization_id=org AND product_id=product AND project_id=project AND status='running') THEN state_value:='researching';
  ELSIF EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE organization_id=org AND product_id=product AND project_id=project AND status IN ('queued','retry')) THEN state_value:='queued';
  ELSIF EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE organization_id=org AND product_id=product AND project_id=project AND status='paused') THEN state_value:='paused';
  ELSIF fallback IS NOT NULL THEN state_value:=fallback;
  ELSE
    SELECT status INTO last_status FROM public.workspace_lead_jobs WHERE organization_id=org AND product_id=product AND project_id=project ORDER BY updated_at DESC,id DESC LIMIT 1;
    state_value:=CASE last_status WHEN 'failed' THEN 'error' WHEN 'cancelled' THEN 'cancelled' ELSE coalesce(l.deep->>'status',l.quick->>'status','pending') END;
  END IF;
  UPDATE public.workspace_lead_records SET status=state_value,updated_at=clock_timestamp() WHERE organization_id=org AND product_id=product AND project_id=project;
END $$;

CREATE FUNCTION workspace_private.lead_enqueue(org uuid,product uuid,project uuid,job_kind text,forced boolean DEFAULT false,job_priority int DEFAULT 0,manual_job boolean DEFAULT false)
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

-- A trigger executes atomically with the existing CSV/XLSX import. It never does
-- network I/O. Security definer is required because CRM users cannot write queues.
CREATE FUNCTION workspace_private.lead_project_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.workspace_lead_settings; l public.workspace_lead_records; before_data jsonb; after_data jsonb;
BEGIN
  after_data := jsonb_build_array(to_jsonb(NEW)->'company',to_jsonb(NEW)->'site',to_jsonb(NEW)->'city',to_jsonb(NEW)->'address',to_jsonb(NEW)->'niche',to_jsonb(NEW)->'phone',to_jsonb(NEW)->'email',to_jsonb(NEW)->'source_url',to_jsonb(NEW)->'contacts');
  IF TG_OP='UPDATE' THEN
    before_data := jsonb_build_array(to_jsonb(OLD)->'company',to_jsonb(OLD)->'site',to_jsonb(OLD)->'city',to_jsonb(OLD)->'address',to_jsonb(OLD)->'niche',to_jsonb(OLD)->'phone',to_jsonb(OLD)->'email',to_jsonb(OLD)->'source_url',to_jsonb(OLD)->'contacts');
    IF before_data=after_data THEN RETURN NEW; END IF;
  END IF;
  SELECT ls.* INTO s FROM public.workspace_lead_settings ls JOIN workspace_private.scope ws USING(organization_id,product_id) FOR UPDATE OF ls;
  INSERT INTO public.workspace_lead_records(organization_id,product_id,project_id) VALUES(s.organization_id,s.product_id,NEW.id) ON CONFLICT(project_id) DO NOTHING;
  SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=NEW.id;
  IF l.excluded OR l.opted_out OR l.purged_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    UPDATE public.workspace_lead_records SET expires_at=clock_timestamp(),quick=CASE WHEN quick IS NULL THEN NULL ELSE jsonb_set(quick,'{expiresAt}',to_jsonb(clock_timestamp())) END,
      deep=CASE WHEN deep IS NULL THEN NULL ELSE jsonb_set(deep,'{expiresAt}',to_jsonb(clock_timestamp())) END,updated_at=clock_timestamp() WHERE project_id=NEW.id;
    -- Invalidate an in-flight snapshot before replacing its queue entry.
    UPDATE public.workspace_lead_jobs SET status='cancelled',worker_id=NULL,lease_until=NULL,error_code='source_changed',updated_at=clock_timestamp()
      WHERE project_id=NEW.id AND status IN ('queued','running','retry','paused');
  END IF;
  IF (s.config->>'enabled')::boolean AND (s.config->>'autoQuick')::boolean THEN
    PERFORM workspace_private.lead_enqueue(s.organization_id,s.product_id,NEW.id,'quick',true,0,false);
  ELSE
    PERFORM workspace_private.lead_sync_status(s.organization_id,s.product_id,NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_lead_project_changed AFTER INSERT OR UPDATE ON public.projects
FOR EACH ROW EXECUTE FUNCTION workspace_private.lead_project_changed();

CREATE FUNCTION public.workspace_lead_rpc(p_organization_id uuid,p_product_id uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
  cfg jsonb; s public.workspace_lead_settings; l public.workspace_lead_records; j public.workspace_lead_jobs; u public.workspace_lead_usage;
  actor uuid; actor_role text; project uuid; jid uuid; v jsonb; result jsonb; row_data record;
  today date; local_now timestamp; cap bigint; used bigint; company_used bigint; amount bigint; n int; queued_quick int:=0; queued_deep int:=0;
  input_count bigint; output_count bigint; state_value text; stamp timestamptz := clock_timestamp();
  selected_deep uuid[]; deep_deferred boolean:=false; ran_schedule boolean:=false;
  page_limit int; page_cursor uuid; page_items jsonb; changed_since timestamptz; page_result jsonb;
  daily_cap bigint; company_cap bigint; numeric_key text; provider_value text; usage_kind text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM workspace_private.scope WHERE organization_id=p_organization_id AND product_id=p_product_id) THEN RAISE EXCEPTION 'scope_mismatch'; END IF;
  IF jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  -- One product lock serializes admission, budget reservations, and daily schedule.
  IF p_action IN ('overview','detail','get_project','get_settings') THEN
    SELECT * INTO s FROM public.workspace_lead_settings WHERE organization_id=p_organization_id AND product_id=p_product_id;
  ELSE
    SELECT * INTO s FROM public.workspace_lead_settings WHERE organization_id=p_organization_id AND product_id=p_product_id FOR UPDATE;
  END IF;
  cfg:=s.config;
  -- Derive membership, lease and calendar decisions after any lock wait.
  stamp:=clock_timestamp();
  actor := nullif(p_payload->>'actorId','')::uuid;
  IF actor IS NOT NULL THEN
    SELECT raw_app_meta_data->>'role' INTO actor_role FROM auth.users
      WHERE id=actor AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<=stamp)
      AND raw_app_meta_data->>'nexus_managed'='true' AND raw_app_meta_data->>'nexus_access'='active'
      AND raw_app_meta_data->>'nexus_organization_id'=p_organization_id::text
      AND raw_app_meta_data->>'nexus_product_id'=p_product_id::text;
    IF actor_role IS NULL OR actor_role NOT IN ('owner','admin','manager','viewer') THEN RAISE EXCEPTION 'scope_mismatch'; END IF;
    IF p_action NOT IN ('overview','detail','get_project','get_settings') AND actor_role='viewer' THEN RAISE EXCEPTION 'scope_mismatch'; END IF;
    IF p_action IN ('save_settings','purge') AND actor_role NOT IN ('owner','admin') THEN RAISE EXCEPTION 'scope_mismatch'; END IF;
    IF p_action IN ('claim','heartbeat','complete','fail','reserve_usage','settle_usage','schedule','suspend_ai') THEN RAISE EXCEPTION 'scope_mismatch'; END IF;
  END IF;
  local_now:=stamp AT TIME ZONE (cfg->>'timezone'); today:=local_now::date;
  project:=nullif(p_payload->>'projectId','')::uuid; jid:=nullif(p_payload->>'jobId','')::uuid;

  IF p_action='get_settings' THEN RETURN cfg;
  ELSIF p_action='suspend_ai' THEN
    IF coalesce(p_payload->>'code','') !~ '^[a-z][a-z0-9_]{0,79}$' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    IF cfg->>'aiProvider'='chatgpt_plan' AND (cfg->>'aiEnabled')::boolean THEN
      UPDATE public.workspace_lead_settings SET config=jsonb_set(config,'{aiEnabled}','false'::jsonb),updated_at=stamp
        WHERE organization_id=p_organization_id AND product_id=p_product_id RETURNING config INTO cfg;
      PERFORM workspace_private.lead_event(p_organization_id,p_product_id,NULL,NULL,NULL,'ai_suspended',jsonb_build_object('provider','chatgpt_plan','code',p_payload->>'code'));
    END IF;
    RETURN cfg;
  ELSIF p_action='save_settings' THEN
    IF jsonb_typeof(p_payload->'settings') <> 'object' THEN RAISE EXCEPTION 'invalid_settings'; END IF;
    v:=cfg||(p_payload->'settings');
    IF NOT workspace_private.lead_validate_settings(v) THEN RAISE EXCEPTION 'invalid_settings'; END IF;
    UPDATE public.workspace_lead_settings SET config=v,updated_at=stamp WHERE organization_id=p_organization_id AND product_id=p_product_id;
    PERFORM workspace_private.lead_event(p_organization_id,p_product_id,NULL,NULL,actor,'settings_changed',jsonb_build_object('keys',(SELECT jsonb_agg(key) FROM jsonb_object_keys(p_payload->'settings') key)));
    RETURN v;
  ELSIF p_action='get_project' THEN
    SELECT to_jsonb(p) INTO result FROM public.projects p WHERE id=project;
    IF result IS NULL THEN RAISE EXCEPTION 'not_found'; END IF; RETURN result;
  ELSIF p_action='overview' THEN
    page_limit:=coalesce((p_payload->>'limit')::int,500); page_cursor:=nullif(p_payload->>'cursor','')::uuid; changed_since:=nullif(p_payload->>'since','')::timestamptz;
    IF page_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO page_items FROM (
      SELECT project_id,status,coalesce(deep->'business'->'industry',quick->'business'->'industry') AS industry,
        CASE WHEN quick IS NULL THEN NULL ELSE jsonb_build_object('kind',quick->'kind','status',quick->'status','business',jsonb_build_object('industry',quick->'business'->'industry'),'ai',quick->'ai') END AS quick,
        CASE WHEN deep IS NULL THEN NULL ELSE jsonb_build_object('kind',deep->'kind','status',deep->'status','business',jsonb_build_object('industry',deep->'business'->'industry'),'ai',deep->'ai') END AS deep,
        CASE WHEN score IS NULL THEN NULL ELSE jsonb_build_object('total',score->'total','priority',score->'priority','services',score->'services') END AS score,
        materials_revision,checked_at,expires_at,excluded,opted_out,updated_at
        FROM public.workspace_lead_records WHERE organization_id=p_organization_id AND product_id=p_product_id AND (page_cursor IS NULL OR project_id>page_cursor)
          AND (changed_since IS NULL OR updated_at>=changed_since)
        ORDER BY project_id LIMIT page_limit+1
    ) x;
    page_result:=jsonb_build_object('serverTime',stamp,
      'leads',CASE WHEN jsonb_array_length(page_items)>page_limit THEN page_items-page_limit ELSE page_items END,
      'total',(SELECT count(*) FROM public.workspace_lead_records WHERE organization_id=p_organization_id AND product_id=p_product_id),
      'nextCursor',CASE WHEN jsonb_array_length(page_items)>page_limit THEN page_items->(page_limit-1)->>'project_id' ELSE NULL END);
    IF page_cursor IS NOT NULL THEN RETURN page_result; END IF;
    SELECT jsonb_build_object('settings',cfg,
      'jobs',coalesce((SELECT jsonb_agg(to_jsonb(x)-'worker_id') FROM (SELECT * FROM public.workspace_lead_jobs WHERE organization_id=p_organization_id AND product_id=p_product_id ORDER BY created_at DESC LIMIT 100) x),'[]'::jsonb),
      'events',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM public.workspace_lead_events WHERE organization_id=p_organization_id AND product_id=p_product_id ORDER BY created_at DESC LIMIT 100) x),'[]'::jsonb),
      'usage',jsonb_build_object('day',today,'timezone',cfg->>'timezone','costNanos',(SELECT coalesce(sum(cost_nanos),0) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='openrouter' AND usage_date=today AND state<>'released'),
        'reservedNanos',(SELECT coalesce(sum(greatest(reserved_nanos,cost_nanos)),0) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='openrouter' AND usage_date=today AND state IN ('reserved','uncertain')),
        'inputTokens',(SELECT coalesce(sum(input_tokens),0) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND usage_date=today),
        'outputTokens',(SELECT coalesce(sum(output_tokens),0) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND usage_date=today),
        'uncertainRequests',(SELECT count(*) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND state IN ('reserved','uncertain')),
        'companyCount',(SELECT count(DISTINCT project_id) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='openrouter' AND usage_date=today AND cost_nanos>0 AND state='settled'),
        'totalCostNanos',(SELECT coalesce(sum(cost_nanos),0) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='openrouter' AND state='settled'),
        'companies',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT project_id,sum(cost_nanos) AS "costNanos",sum(input_tokens) AS "inputTokens",sum(output_tokens) AS "outputTokens" FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='openrouter' AND state='settled' AND usage_date=today GROUP BY project_id ORDER BY sum(cost_nanos) DESC LIMIT 5000) x),'[]'::jsonb),
        'apiRequests',(SELECT count(*) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='openrouter' AND usage_date=today),
        'dailyPlanRequests',(cfg->>'dailyPlanRequests')::int,
        'planRequests',(SELECT count(*) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='chatgpt_plan' AND usage_date=today),
        'planCompletedRequests',(SELECT count(*) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='chatgpt_plan' AND usage_date=today AND state='settled'),
        'planReservedRequests',(SELECT count(*) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='chatgpt_plan' AND usage_date=today AND state='reserved'),
        'planUncertainRequests',(SELECT count(*) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='chatgpt_plan' AND usage_date=today AND state='uncertain'),
        'planInputTokens',(SELECT coalesce(sum(input_tokens),0) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='chatgpt_plan' AND usage_date=today),
        'planOutputTokens',(SELECT coalesce(sum(output_tokens),0) FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='chatgpt_plan' AND usage_date=today)),
      'analytics',jsonb_build_object('processedQuick',(SELECT count(*) FROM public.workspace_lead_records WHERE organization_id=p_organization_id AND product_id=p_product_id AND quick IS NOT NULL),
        'processedDeep',(SELECT count(*) FROM public.workspace_lead_records WHERE organization_id=p_organization_id AND product_id=p_product_id AND deep IS NOT NULL),
        'priorityCounts',coalesce((SELECT jsonb_object_agg(priority,number) FROM (SELECT coalesce(score->>'priority','unknown') AS priority,count(*) AS number FROM public.workspace_lead_records WHERE organization_id=p_organization_id AND product_id=p_product_id GROUP BY 1) x),'{}'::jsonb),
        'replyCounts',coalesce((SELECT jsonb_object_agg(classification,number) FROM (SELECT coalesce(reply->>'classification','unknown') AS classification,count(*) AS number FROM public.workspace_lead_replies WHERE organization_id=p_organization_id AND product_id=p_product_id GROUP BY 1) x),'{}'::jsonb))) INTO result;
    RETURN result||page_result;
  ELSIF p_action='detail' THEN
    IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=project) THEN RAISE EXCEPTION 'not_found'; END IF;
    RETURN jsonb_build_object('lead',(SELECT to_jsonb(x) FROM public.workspace_lead_records x WHERE project_id=project AND organization_id=p_organization_id AND product_id=p_product_id),
      'jobs',coalesce((SELECT jsonb_agg(to_jsonb(x)-'worker_id') FROM (SELECT * FROM public.workspace_lead_jobs WHERE project_id=project AND organization_id=p_organization_id AND product_id=p_product_id ORDER BY created_at DESC LIMIT 100) x),'[]'::jsonb),
      'events',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM public.workspace_lead_events WHERE project_id=project AND organization_id=p_organization_id AND product_id=p_product_id ORDER BY created_at DESC LIMIT 100) x),'[]'::jsonb),
      'replies',coalesce((SELECT jsonb_agg(x.reply||jsonb_build_object('id',x.id,'created_at',x.created_at)) FROM (SELECT * FROM public.workspace_lead_replies WHERE project_id=project AND organization_id=p_organization_id AND product_id=p_product_id ORDER BY created_at DESC LIMIT 100) x),'[]'::jsonb));
  ELSIF p_action='enqueue' THEN
    result:=workspace_private.lead_enqueue(p_organization_id,p_product_id,project,p_payload->>'kind',coalesce((p_payload->>'force')::boolean,false),coalesce((p_payload->>'priority')::int,0),coalesce((p_payload->>'manual')::boolean,true));
    IF actor IS NOT NULL THEN PERFORM workspace_private.lead_event(p_organization_id,p_product_id,project,(result->>'id')::uuid,actor,'enqueue_requested',jsonb_build_object('kind',p_payload->>'kind')); END IF;
    RETURN result;
  ELSIF p_action='claim' THEN
    IF NOT (cfg->>'enabled')::boolean OR (cfg->>'paused')::boolean THEN RETURN NULL; END IF;
    IF length(coalesce(p_payload->>'workerId','')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    FOR j IN SELECT * FROM public.workspace_lead_jobs WHERE organization_id=p_organization_id AND product_id=p_product_id AND status='running' AND lease_until<=stamp FOR UPDATE LOOP
      UPDATE public.workspace_lead_jobs SET status=CASE WHEN attempts>=(cfg->>'maxAttempts')::int THEN 'failed' ELSE 'retry' END,
        worker_id=NULL,lease_until=NULL,error_code='lease_expired',next_run_at=stamp+interval '30 seconds',updated_at=stamp WHERE id=j.id;
      PERFORM workspace_private.lead_sync_status(p_organization_id,p_product_id,j.project_id,CASE WHEN j.attempts>=(cfg->>'maxAttempts')::int THEN 'error' ELSE 'queued' END);
      PERFORM workspace_private.lead_event(p_organization_id,p_product_id,j.project_id,j.id,NULL,'lease_expired');
    END LOOP;
    SELECT count(*) INTO n FROM public.workspace_lead_jobs WHERE organization_id=p_organization_id AND product_id=p_product_id AND status='running';
    IF n>=(cfg->>'concurrency')::int THEN RETURN NULL; END IF;
    INSERT INTO public.workspace_lead_daily(organization_id,product_id,usage_date) VALUES(p_organization_id,p_product_id,today) ON CONFLICT DO NOTHING;
    SELECT j2.* INTO j FROM public.workspace_lead_jobs j2 JOIN public.workspace_lead_records l2 ON l2.project_id=j2.project_id
      JOIN public.workspace_lead_daily d ON d.organization_id=j2.organization_id AND d.product_id=j2.product_id AND d.usage_date=today
      WHERE j2.organization_id=p_organization_id AND j2.product_id=p_product_id AND j2.status IN ('queued','retry') AND j2.next_run_at<=stamp
        AND NOT l2.excluded AND NOT l2.opted_out AND l2.purged_at IS NULL AND j2.attempts<(cfg->>'maxAttempts')::int
        AND (j2.kind<>'deep' OR j2.manual OR local_now::time>=(cfg->>'scheduleTime')::time)
        AND ((j2.kind='quick' AND d.quick_started<(cfg->>'dailyQuick')::int) OR (j2.kind='deep' AND d.deep_started<(cfg->>'dailyDeep')::int))
        AND NOT EXISTS(SELECT 1 FROM public.workspace_lead_jobs other WHERE other.project_id=j2.project_id AND other.status='running')
      ORDER BY j2.manual DESC,j2.priority DESC,j2.created_at,j2.id FOR UPDATE OF j2 SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=j.project_id;
    UPDATE public.workspace_lead_jobs SET status='running',attempts=attempts+1,worker_id=(p_payload->>'workerId')||':'||gen_random_uuid()::text,
      lease_until=stamp+interval '90 seconds',started_at=coalesce(started_at,stamp),updated_at=stamp,error_code=NULL,materials_revision_snapshot=l.materials_revision,
      progress=jsonb_build_object('stage','starting') WHERE id=j.id RETURNING * INTO j;
    UPDATE public.workspace_lead_daily SET quick_started=quick_started+CASE WHEN j.kind='quick' THEN 1 ELSE 0 END,
      deep_started=deep_started+CASE WHEN j.kind='deep' THEN 1 ELSE 0 END WHERE organization_id=p_organization_id AND product_id=p_product_id AND usage_date=today;
    PERFORM workspace_private.lead_sync_status(p_organization_id,p_product_id,j.project_id);
    PERFORM workspace_private.lead_event(p_organization_id,p_product_id,j.project_id,j.id,NULL,'started',jsonb_build_object('kind',j.kind,'attempt',j.attempts));
    RETURN to_jsonb(j)||jsonb_build_object('project',(SELECT to_jsonb(p) FROM public.projects p WHERE id=j.project_id),'previous',to_jsonb(l));
  ELSIF p_action IN ('heartbeat','complete','fail','control_job') THEN
    SELECT * INTO j FROM public.workspace_lead_jobs WHERE id=jid AND organization_id=p_organization_id AND product_id=p_product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    IF p_action<>'control_job' AND (j.status<>'running' OR j.worker_id IS DISTINCT FROM p_payload->>'workerId' OR j.lease_until<=stamp) THEN RAISE EXCEPTION 'stale_lease'; END IF;
    IF p_action='heartbeat' THEN
      v:=coalesce(p_payload->'progress','{}'::jsonb);
      IF jsonb_typeof(v)<>'object' OR octet_length(v::text)>4000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
      UPDATE public.workspace_lead_jobs SET lease_until=stamp+interval '90 seconds',progress=v,updated_at=stamp WHERE id=jid RETURNING * INTO j;
      RETURN to_jsonb(j);
    ELSIF p_action='complete' THEN
      v:=p_payload->'result';
      IF jsonb_typeof(v)<>'object' OR v->>'kind' IS DISTINCT FROM j.kind OR octet_length(v::text)>1000000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
      SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=j.project_id FOR UPDATE;
      IF l.excluded OR l.opted_out OR l.purged_at IS NOT NULL THEN RAISE EXCEPTION 'stale_lease'; END IF;
      UPDATE public.workspace_lead_records SET quick=CASE WHEN j.kind='quick' THEN v-'materials' ELSE quick END,
        deep=CASE WHEN j.kind='deep' THEN v-'materials' ELSE deep END,score=coalesce(v->'score',score),status=coalesce(v->>'status','completed'),
        checked_at=coalesce((v->>'checkedAt')::timestamptz,stamp),expires_at=coalesce((v->>'expiresAt')::timestamptz,stamp+make_interval(days=>(cfg->>'staleDays')::int)),
        materials=CASE WHEN jsonb_typeof(v->'materials')='object' AND NOT materials_edited AND materials_revision=j.materials_revision_snapshot THEN v->'materials' ELSE materials END,
        materials_revision=materials_revision+CASE WHEN jsonb_typeof(v->'materials')='object' AND NOT materials_edited AND materials_revision=j.materials_revision_snapshot THEN 1 ELSE 0 END,
        updated_at=stamp WHERE project_id=j.project_id RETURNING * INTO l;
      UPDATE public.workspace_lead_jobs SET status='completed',worker_id=NULL,lease_until=NULL,completed_at=stamp,updated_at=stamp,progress='{"stage":"completed"}' WHERE id=jid;
      PERFORM workspace_private.lead_sync_status(p_organization_id,p_product_id,j.project_id,coalesce(v->>'status','completed'));
      SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=j.project_id;
      PERFORM workspace_private.lead_event(p_organization_id,p_product_id,j.project_id,jid,NULL,'completed',jsonb_build_object('kind',j.kind,'status',l.status));
      RETURN to_jsonb(l);
    ELSIF p_action='fail' THEN
      state_value:=CASE WHEN j.attempts>=(cfg->>'maxAttempts')::int THEN 'failed' ELSE 'retry' END;
      UPDATE public.workspace_lead_jobs SET status=state_value,worker_id=NULL,lease_until=NULL,error_code=left(regexp_replace(coalesce(p_payload->>'code','research_failed'),'[^A-Za-z0-9_-]','','g'),80),
        next_run_at=stamp+make_interval(secs=>least(3600,30*power(2,least(j.attempts-1,7)))::int),updated_at=stamp WHERE id=jid RETURNING * INTO j;
      PERFORM workspace_private.lead_sync_status(p_organization_id,p_product_id,j.project_id,CASE WHEN state_value='failed' THEN 'error' ELSE 'queued' END);
      PERFORM workspace_private.lead_event(p_organization_id,p_product_id,j.project_id,jid,NULL,state_value,jsonb_build_object('errorCode',j.error_code));
      RETURN to_jsonb(j);
    ELSE
      state_value:=p_payload->>'operation';
      IF state_value='pause' AND j.status IN ('queued','retry','running') THEN state_value:='paused';
      ELSIF state_value='resume' AND j.status='paused' THEN state_value:='queued';
      ELSIF state_value='retry' AND j.status IN ('failed','cancelled') THEN
        IF EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE project_id=j.project_id AND kind=j.kind AND status IN ('queued','retry','running','paused')) THEN RAISE EXCEPTION 'job_conflict'; END IF;
        state_value:='queued';
      ELSIF state_value='cancel' AND j.status IN ('queued','retry','running','paused') THEN state_value:='cancelled';
      ELSE RAISE EXCEPTION 'invalid_transition'; END IF;
      SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=j.project_id;
      IF state_value='queued' AND (l.excluded OR l.opted_out OR l.purged_at IS NOT NULL) THEN RAISE EXCEPTION 'excluded'; END IF;
      UPDATE public.workspace_lead_jobs SET status=state_value,worker_id=NULL,lease_until=NULL,next_run_at=stamp,
        attempts=CASE WHEN p_payload->>'operation'='retry' OR (p_payload->>'operation'='resume' AND attempts>=(cfg->>'maxAttempts')::int) THEN 0 ELSE attempts END,error_code=NULL,updated_at=stamp WHERE id=jid RETURNING * INTO j;
      PERFORM workspace_private.lead_sync_status(p_organization_id,p_product_id,j.project_id,state_value);
      PERFORM workspace_private.lead_event(p_organization_id,p_product_id,j.project_id,jid,actor,'job_'||(p_payload->>'operation'));
      RETURN to_jsonb(j);
    END IF;
  ELSIF p_action IN ('save_materials','save_policy','add_reply','purge') THEN
    IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=project) THEN RAISE EXCEPTION 'not_found'; END IF;
    INSERT INTO public.workspace_lead_records(organization_id,product_id,project_id) VALUES(p_organization_id,p_product_id,project) ON CONFLICT DO NOTHING;
    SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=project AND organization_id=p_organization_id AND product_id=p_product_id FOR UPDATE;
    IF p_action='save_materials' THEN
      IF l.materials_revision IS DISTINCT FROM (p_payload->>'revision')::bigint THEN RAISE EXCEPTION 'revision_conflict'; END IF;
      v:=p_payload->'materials';
      IF jsonb_typeof(v)<>'object' OR octet_length(v::text)>60000 OR (v-ARRAY['summary','proposal','callScript','emailSubject','emailBody','icebreaker','followUps'])<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_payload'; END IF;
      FOR row_data IN SELECT * FROM jsonb_each(v) LOOP
        IF row_data.key='followUps' THEN
          IF jsonb_typeof(row_data.value)<>'array' OR jsonb_array_length(row_data.value)>10 OR EXISTS(SELECT 1 FROM jsonb_array_elements(row_data.value) e WHERE jsonb_typeof(e)<>'string') THEN RAISE EXCEPTION 'invalid_payload'; END IF;
        ELSIF jsonb_typeof(row_data.value)<>'string' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
      END LOOP;
      UPDATE public.workspace_lead_records SET materials=v,materials_revision=materials_revision+1,materials_edited=true,updated_at=stamp WHERE project_id=project RETURNING * INTO l;
      PERFORM workspace_private.lead_event(p_organization_id,p_product_id,project,NULL,actor,'materials_edited',jsonb_build_object('revision',l.materials_revision));
    ELSIF p_action='save_policy' THEN
      IF (p_payload ? 'excluded' AND jsonb_typeof(p_payload->'excluded')<>'boolean') OR (p_payload ? 'optedOut' AND jsonb_typeof(p_payload->'optedOut')<>'boolean') THEN RAISE EXCEPTION 'invalid_payload'; END IF;
      IF p_payload ? 'contactPermission' AND (jsonb_typeof(p_payload->'contactPermission') NOT IN ('object','null') OR octet_length((p_payload->'contactPermission')::text)>4000) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
      UPDATE public.workspace_lead_records SET excluded=coalesce((p_payload->>'excluded')::boolean,excluded),opted_out=coalesce((p_payload->>'optedOut')::boolean,opted_out),
        contact_permission=CASE WHEN p_payload ? 'contactPermission' THEN nullif(p_payload->'contactPermission','null'::jsonb) ELSE contact_permission END,
        purged_at=CASE WHEN p_payload->>'excluded'='false' THEN NULL ELSE purged_at END,updated_at=stamp WHERE project_id=project RETURNING * INTO l;
      PERFORM workspace_private.lead_event(p_organization_id,p_product_id,project,NULL,actor,'policy_changed',jsonb_build_object('excluded',l.excluded,'optedOut',l.opted_out));
    ELSIF p_action='add_reply' THEN
      v:=p_payload->'reply';
      IF jsonb_typeof(v)<>'object' OR octet_length(v::text)>30000 OR length(coalesce(v->>'classification','')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
      INSERT INTO public.workspace_lead_replies(organization_id,product_id,project_id,reply) VALUES(p_organization_id,p_product_id,project,v) RETURNING v||jsonb_build_object('id',id,'created_at',created_at) INTO result;
      IF v->>'classification' IN ('refusal','opt_out','unsubscribe') THEN UPDATE public.workspace_lead_records SET opted_out=true,updated_at=stamp WHERE project_id=project RETURNING * INTO l; END IF;
      PERFORM workspace_private.lead_event(p_organization_id,p_product_id,project,NULL,actor,'reply_classified',jsonb_build_object('classification',v->>'classification'));
    ELSE
      DELETE FROM public.workspace_lead_jobs WHERE project_id=project AND organization_id=p_organization_id AND product_id=p_product_id;
      DELETE FROM public.workspace_lead_replies WHERE project_id=project AND organization_id=p_organization_id AND product_id=p_product_id;
      DELETE FROM public.workspace_lead_events WHERE project_id=project AND organization_id=p_organization_id AND product_id=p_product_id;
      UPDATE public.workspace_lead_records SET status='purged',quick=NULL,deep=NULL,score=NULL,materials=NULL,materials_revision=materials_revision+1,materials_edited=false,
        checked_at=NULL,expires_at=NULL,excluded=true,contact_permission=NULL,purged_at=stamp,updated_at=stamp WHERE project_id=project;
      PERFORM workspace_private.lead_event(p_organization_id,p_product_id,NULL,NULL,actor,'privacy_purge');
      RETURN jsonb_build_object('deleted',true);
    END IF;
    IF l.excluded OR l.opted_out THEN
      UPDATE public.workspace_lead_jobs SET status='cancelled',worker_id=NULL,lease_until=NULL,error_code=CASE WHEN l.opted_out THEN 'opted_out' ELSE 'excluded' END,updated_at=stamp WHERE project_id=project AND status IN ('queued','running','retry','paused');
      UPDATE public.workspace_lead_records SET status=CASE WHEN l.opted_out THEN 'opted_out' ELSE 'excluded' END WHERE project_id=project RETURNING * INTO l;
    END IF;
    IF p_action IN ('save_policy','add_reply') THEN
      PERFORM workspace_private.lead_sync_status(p_organization_id,p_product_id,project,coalesce(l.deep->>'status',l.quick->>'status','pending'));
      SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=project;
    END IF;
    IF p_action='add_reply' THEN RETURN result; END IF; RETURN to_jsonb(l);
  ELSIF p_action='schedule' THEN
    -- Privacy maintenance remains active while research is disabled or paused.
    IF s.last_retention_date IS DISTINCT FROM today THEN
      DELETE FROM public.workspace_lead_events WHERE organization_id=p_organization_id AND product_id=p_product_id AND created_at<stamp-make_interval(days=>(cfg->>'retentionDays')::int);
      DELETE FROM public.workspace_lead_replies WHERE organization_id=p_organization_id AND product_id=p_product_id AND created_at<stamp-make_interval(days=>(cfg->>'retentionDays')::int);
      UPDATE public.workspace_lead_records SET
        quick=CASE WHEN coalesce((quick->>'checkedAt')::timestamptz,checked_at)<stamp-make_interval(days=>(cfg->>'retentionDays')::int) THEN quick-'pages' ELSE quick END,
        deep=CASE WHEN coalesce((deep->>'checkedAt')::timestamptz,checked_at)<stamp-make_interval(days=>(cfg->>'retentionDays')::int) THEN deep-'pages' ELSE deep END
        WHERE organization_id=p_organization_id AND product_id=p_product_id;
      UPDATE public.workspace_lead_settings SET last_retention_date=today WHERE organization_id=p_organization_id AND product_id=p_product_id;
    END IF;
    IF NOT (cfg->>'enabled')::boolean OR (cfg->>'paused')::boolean OR local_now::time<(cfg->>'scheduleTime')::time THEN
      RETURN jsonb_build_object('ran',false,'date',today,'quick',0,'deep',0); END IF;
    IF s.last_schedule_date IS DISTINCT FROM today THEN
      INSERT INTO public.workspace_lead_records(organization_id,product_id,project_id) SELECT p_organization_id,p_product_id,id FROM public.projects ON CONFLICT DO NOTHING;
      ran_schedule:=true;
    END IF;
    IF (cfg->>'autoQuick')::boolean AND s.last_schedule_date IS DISTINCT FROM today THEN
      FOR row_data IN SELECT project_id FROM public.workspace_lead_records WHERE organization_id=p_organization_id AND product_id=p_product_id AND NOT excluded AND NOT opted_out AND purged_at IS NULL
        AND (quick IS NULL OR coalesce((quick->>'expiresAt')::timestamptz,expires_at)<=stamp)
        AND NOT EXISTS(SELECT 1 FROM public.workspace_lead_jobs j2 WHERE j2.project_id=workspace_lead_records.project_id AND kind='quick' AND j2.status IN ('queued','running','retry','paused'))
        ORDER BY checked_at NULLS FIRST,project_id LIMIT (cfg->>'dailyQuick')::int LOOP
        PERFORM workspace_private.lead_enqueue(p_organization_id,p_product_id,row_data.project_id,'quick',false,0,false); queued_quick:=queued_quick+1;
      END LOOP;
    END IF;
    UPDATE public.workspace_lead_settings SET last_schedule_date=today WHERE organization_id=p_organization_id AND product_id=p_product_id;
    -- Defer the top-N decision until the admitted automatic Quick batch has
    -- finished. Imports later in the day get the same continuation on a tick.
    SELECT (cfg->>'autoQuick')::boolean AND (
      EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE organization_id=p_organization_id AND product_id=p_product_id AND kind='quick' AND NOT manual AND status='running')
      OR (coalesce((SELECT quick_started FROM public.workspace_lead_daily WHERE organization_id=p_organization_id AND product_id=p_product_id AND usage_date=today),0)<(cfg->>'dailyQuick')::int
        AND EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE organization_id=p_organization_id AND product_id=p_product_id AND kind='quick' AND NOT manual AND status IN ('queued','retry') AND attempts<(cfg->>'maxAttempts')::int))) INTO deep_deferred;
    IF (cfg->>'autoDeep')::boolean AND NOT deep_deferred THEN
      cap:=greatest(0,(cfg->>'dailyDeep')::int-coalesce((SELECT deep_started FROM public.workspace_lead_daily WHERE organization_id=p_organization_id AND product_id=p_product_id AND usage_date=today),0)
        -(SELECT count(*) FROM public.workspace_lead_jobs WHERE organization_id=p_organization_id AND product_id=p_product_id AND kind='deep' AND (status='retry' OR (status='queued' AND (manual OR attempts>0)))));
      SELECT coalesce(array_agg(x.project_id),'{}'::uuid[]) INTO selected_deep FROM (
        SELECT project_id FROM public.workspace_lead_records WHERE organization_id=p_organization_id AND product_id=p_product_id AND NOT excluded AND NOT opted_out AND purged_at IS NULL
        AND quick IS NOT NULL AND coalesce((score->>'total')::int,0)>=(cfg->>'deepThreshold')::int
        AND (deep IS NULL OR coalesce((deep->>'expiresAt')::timestamptz,expires_at)<=stamp)
        AND NOT EXISTS(SELECT 1 FROM public.workspace_lead_jobs j2 WHERE j2.project_id=workspace_lead_records.project_id AND kind='deep' AND (j2.status IN ('running','retry','paused') OR (j2.status='queued' AND (j2.manual OR j2.attempts>0))))
        ORDER BY coalesce((score->>'total')::int,0) DESC,checked_at,project_id LIMIT cap
      ) x;
      FOR row_data IN UPDATE public.workspace_lead_jobs SET status='cancelled',error_code='reprioritized',updated_at=stamp WHERE organization_id=p_organization_id AND product_id=p_product_id
        AND kind='deep' AND NOT manual AND status='queued' AND attempts=0 AND NOT project_id=ANY(selected_deep) RETURNING project_id LOOP
        PERFORM workspace_private.lead_sync_status(p_organization_id,p_product_id,row_data.project_id);
      END LOOP;
      FOR row_data IN SELECT project_id,coalesce((score->>'total')::int,0) AS score_value FROM public.workspace_lead_records WHERE project_id=ANY(selected_deep) ORDER BY coalesce((score->>'total')::int,0) DESC,project_id LOOP
        IF NOT EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE project_id=row_data.project_id AND kind='deep' AND status='queued') THEN
          PERFORM workspace_private.lead_enqueue(p_organization_id,p_product_id,row_data.project_id,'deep',false,row_data.score_value,false); queued_deep:=queued_deep+1;
        ELSE
          UPDATE public.workspace_lead_jobs SET priority=row_data.score_value WHERE project_id=row_data.project_id AND kind='deep' AND status='queued' AND NOT manual;
        END IF;
      END LOOP;
    END IF;
    ran_schedule:=ran_schedule OR queued_quick>0 OR queued_deep>0;
    IF ran_schedule THEN PERFORM workspace_private.lead_event(p_organization_id,p_product_id,NULL,NULL,NULL,'scheduled',jsonb_build_object('date',today,'quick',queued_quick,'deep',queued_deep)); END IF;
    RETURN jsonb_build_object('ran',ran_schedule,'date',today,'quick',queued_quick,'deep',queued_deep,'deepDeferred',deep_deferred);
  ELSIF p_action='reserve_usage' THEN
    FOREACH numeric_key IN ARRAY ARRAY['costNanos','inputTokens','outputTokens','dailyCapNanos','companyCapNanos','dailyPlanCap'] LOOP
      IF p_payload ? numeric_key AND (jsonb_typeof(p_payload->numeric_key)<>'number' OR (p_payload->>numeric_key)::numeric<>trunc((p_payload->>numeric_key)::numeric)
        OR (p_payload->>numeric_key)::numeric<0 OR (p_payload->>numeric_key)::numeric>9007199254740991) THEN RAISE EXCEPTION 'invalid_usage'; END IF;
    END LOOP;
    amount:=(p_payload->>'costNanos')::bigint; input_count:=coalesce((p_payload->>'inputTokens')::bigint,0); output_count:=coalesce((p_payload->>'outputTokens')::bigint,0);
    IF amount IS NULL OR amount<0 OR amount>10000000000000 OR input_count<0 OR output_count<0 OR length(coalesce(p_payload->>'requestId','')) NOT BETWEEN 1 AND 200 OR length(coalesce(p_payload->>'model','')) NOT BETWEEN 1 AND 150 THEN RAISE EXCEPTION 'invalid_usage'; END IF;
    provider_value:=coalesce(p_payload->>'provider','openrouter');
    usage_kind:=coalesce(p_payload->>'kind',CASE WHEN provider_value='chatgpt_plan' THEN 'plan' ELSE 'api' END);
    IF provider_value NOT IN ('openrouter','chatgpt_plan') OR usage_kind NOT IN ('api','plan')
      OR (provider_value='chatgpt_plan' AND (usage_kind<>'plan' OR amount<>0))
      OR (provider_value='openrouter' AND usage_kind<>'api') THEN RAISE EXCEPTION 'invalid_usage'; END IF;
    SELECT * INTO u FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND request_id=p_payload->>'requestId';
    IF FOUND THEN
      IF u.project_id IS DISTINCT FROM project OR u.job_id IS DISTINCT FROM jid OR u.model IS DISTINCT FROM p_payload->>'model' OR u.reserved_nanos<>amount OR u.quoted_input_tokens<>input_count OR u.quoted_output_tokens<>output_count OR u.provider<>provider_value OR u.kind<>usage_kind THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
      RETURN to_jsonb(u)||jsonb_build_object('duplicate',true);
    END IF;
    IF NOT (cfg->>'enabled')::boolean OR (cfg->>'paused')::boolean OR NOT (cfg->>'aiEnabled')::boolean THEN RAISE EXCEPTION 'ai_disabled'; END IF;
    IF provider_value<>cfg->>'aiProvider' THEN RAISE EXCEPTION 'ai_provider_mismatch'; END IF;
    SELECT * INTO l FROM public.workspace_lead_records WHERE project_id=project AND organization_id=p_organization_id AND product_id=p_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    IF l.excluded OR l.opted_out OR l.purged_at IS NOT NULL THEN RAISE EXCEPTION 'excluded'; END IF;
    IF jid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.workspace_lead_jobs WHERE id=jid AND organization_id=p_organization_id AND product_id=p_product_id AND project_id=project AND status='running' AND lease_until>stamp AND worker_id=p_payload->>'workerId') THEN RAISE EXCEPTION 'stale_lease'; END IF;
    IF provider_value='chatgpt_plan' THEN
      -- Admission is serialized by the same product lock as USD reservations.
      -- All attempts keep their daily slot, including uncertain/released ones.
      SELECT count(*) INTO used FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='chatgpt_plan' AND usage_date=today;
      daily_cap:=least((cfg->>'dailyPlanRequests')::bigint,coalesce((p_payload->>'dailyPlanCap')::bigint,50));
      IF used>=daily_cap THEN RAISE EXCEPTION 'plan_quota_exceeded'; END IF;
    ELSE
      SELECT coalesce(sum(CASE WHEN state IN ('reserved','uncertain') THEN greatest(reserved_nanos,cost_nanos) WHEN state='settled' THEN cost_nanos ELSE 0 END),0) INTO used FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='openrouter' AND usage_date=today;
      SELECT coalesce(sum(CASE WHEN state IN ('reserved','uncertain') THEN greatest(reserved_nanos,cost_nanos) WHEN state='settled' THEN cost_nanos ELSE 0 END),0) INTO company_used FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND provider='openrouter' AND project_id=project;
      daily_cap:=least(((cfg->>'dailyBudgetUsd')::numeric*1000000000)::bigint,coalesce((p_payload->>'dailyCapNanos')::bigint,9223372036854775807));
      company_cap:=least(((cfg->>'companyBudgetUsd')::numeric*1000000000)::bigint,coalesce((p_payload->>'companyCapNanos')::bigint,9223372036854775807));
      IF daily_cap<=0 OR company_cap<=0 OR used+amount>daily_cap OR company_used+amount>company_cap THEN RAISE EXCEPTION 'budget_exceeded'; END IF;
    END IF;
    INSERT INTO public.workspace_lead_usage(organization_id,product_id,request_id,project_id,job_id,model,provider,kind,usage_date,reserved_nanos,quoted_input_tokens,quoted_output_tokens)
      VALUES(p_organization_id,p_product_id,p_payload->>'requestId',project,jid,p_payload->>'model',provider_value,usage_kind,today,amount,input_count,output_count) RETURNING * INTO u;
    RETURN to_jsonb(u)||jsonb_build_object('duplicate',false);
  ELSIF p_action='settle_usage' THEN
    SELECT * INTO u FROM public.workspace_lead_usage WHERE organization_id=p_organization_id AND product_id=p_product_id AND request_id=p_payload->>'requestId' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    FOREACH numeric_key IN ARRAY ARRAY['costNanos','inputTokens','outputTokens'] LOOP
      IF p_payload ? numeric_key AND (jsonb_typeof(p_payload->numeric_key)<>'number' OR (p_payload->>numeric_key)::numeric<>trunc((p_payload->>numeric_key)::numeric)
        OR (p_payload->>numeric_key)::numeric<0 OR (p_payload->>numeric_key)::numeric>9007199254740991) THEN RAISE EXCEPTION 'invalid_usage'; END IF;
    END LOOP;
    amount:=coalesce((p_payload->>'costNanos')::bigint,0); input_count:=coalesce((p_payload->>'inputTokens')::bigint,0); output_count:=coalesce((p_payload->>'outputTokens')::bigint,0); state_value:=p_payload->>'state';
    IF amount<0 OR amount>9007199254740991 OR input_count<0 OR output_count<0 OR state_value IS NULL OR state_value NOT IN ('settled','uncertain','released') OR (state_value='released' AND amount<>0) THEN RAISE EXCEPTION 'invalid_usage'; END IF;
    IF u.provider='chatgpt_plan' AND amount<>0 THEN RAISE EXCEPTION 'invalid_usage'; END IF;
    IF u.state IN ('settled','released') THEN
      IF u.state<>state_value OR u.cost_nanos<>amount OR u.input_tokens<>input_count OR u.output_tokens<>output_count THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
      RETURN to_jsonb(u);
    END IF;
    IF u.state='uncertain' AND state_value='released' THEN RAISE EXCEPTION 'invalid_transition'; END IF;
    UPDATE public.workspace_lead_usage SET state=state_value,cost_nanos=greatest(cost_nanos,amount),input_tokens=greatest(input_tokens,input_count),output_tokens=greatest(output_tokens,output_count),updated_at=stamp
      WHERE organization_id=p_organization_id AND product_id=p_product_id AND request_id=u.request_id RETURNING * INTO u;
    RETURN to_jsonb(u);
  END IF;
  RAISE EXCEPTION 'invalid_action';
END $$;

-- Every callable privileged operation is explicitly service-only; the import
-- trigger is uncallable by clients and derives scope from the dedicated DB.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='workspace_private' AND p.proname LIKE 'lead_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.workspace_lead_rpc(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_lead_rpc(uuid,uuid,text,jsonb) TO service_role;
-- Actor freshness checks read only identity/membership columns, never passwords.
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT SELECT(id,raw_app_meta_data,deleted_at,banned_until) ON auth.users TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
