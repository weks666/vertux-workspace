-- Operator-only rollback after stopping lead-server and exporting lead tables.
-- Removes Lead Intelligence data; preserves companies, CRM history, finance,
-- workspace_private.scope/current_role and all existing import behavior.
BEGIN;
DROP TRIGGER workspace_lead_project_changed ON public.projects;
DROP FUNCTION public.workspace_lead_rpc(uuid,uuid,text,jsonb);
DROP FUNCTION workspace_private.lead_project_changed();
DROP FUNCTION workspace_private.lead_enqueue(uuid,uuid,uuid,text,boolean,integer,boolean);
DROP FUNCTION workspace_private.lead_sync_status(uuid,uuid,uuid,text);
DROP FUNCTION workspace_private.lead_event(uuid,uuid,uuid,uuid,uuid,text,jsonb);
DROP TABLE public.workspace_lead_usage;
DROP TABLE public.workspace_lead_replies;
DROP TABLE public.workspace_lead_events;
DROP TABLE public.workspace_lead_jobs;
DROP TABLE public.workspace_lead_daily;
DROP TABLE public.workspace_lead_records;
DROP TABLE public.workspace_lead_settings;
DROP FUNCTION workspace_private.lead_immutable_scope();
DROP FUNCTION workspace_private.lead_validate_settings(jsonb);
DROP FUNCTION workspace_private.lead_defaults();
ALTER TABLE workspace_private.scope DROP CONSTRAINT lead_scope_unique;
NOTIFY pgrst,'reload schema';
COMMIT;
