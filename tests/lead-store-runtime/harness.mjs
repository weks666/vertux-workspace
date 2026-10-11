// In-process PostgreSQL/WASM. No connections, credentials or production data.
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {createLeadStore} from '../../lead-server/store.mjs';
export {PGlite};

export const organizationId = '11111111-1111-4111-8111-111111111111';
export const productId = '22222222-2222-4222-8222-222222222222';
export const ownerId = '44444444-4444-4444-8444-444444444441';
export const managerId = '44444444-4444-4444-8444-444444444442';
export const viewerId = '44444444-4444-4444-8444-444444444443';
export const foreignId = '44444444-4444-4444-8444-444444444444';
export const uuid = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

export async function createDatabase(dataDir) {
  const db = new PGlite(dataDir);
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb,deleted_at timestamptz,banned_until timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}') $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid(),auth.jwt() TO anon,authenticated,service_role;
    CREATE TABLE public.projects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company text NOT NULL,site text,city text,address text,niche text,phone text,email text,source_url text,contacts jsonb,notes text,raw jsonb DEFAULT '{}',updated_at timestamptz DEFAULT now());
    ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY projects_read ON public.projects FOR SELECT TO authenticated USING(true);
    CREATE POLICY projects_write ON public.projects FOR ALL TO authenticated USING(true) WITH CHECK(true);
    SELECT set_config('workspace.release.organization_id','${organizationId}',false);
    SELECT set_config('workspace.release.product_id','${productId}',false);
  `);
  await db.exec(await readFile(new URL('../../supabase/migrations/20261008082314_workspace_finance_isolation.sql',import.meta.url),'utf8'));
  try { await db.exec(await readFile(new URL('../../supabase/migrations/20261010004715_workspace_lead_intelligence.sql',import.meta.url),'utf8')); }
  catch (e) { await db.close(); throw new Error(`Lead migration: ${e.message} (${e.code}); ${e.where || ''}`); }
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011185814_workspace_lead_batches_archive.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011204512_workspace_demo_jobs.sql',import.meta.url),'utf8'));
  for (const [id,role,org] of [[ownerId,'owner',organizationId],[managerId,'manager',organizationId],[viewerId,'viewer',organizationId],[foreignId,'owner',uuid(999)]]) {
    await db.query('INSERT INTO auth.users(id,raw_app_meta_data) VALUES($1,$2)',[id,{role,nexus_managed:true,nexus_access:'active',nexus_organization_id:org,nexus_product_id:productId}]);
  }
  return db;
}

// Each REST operation is executed inside the actual migrated PostgreSQL RPC.
export function createSqlStore(db, scope = {}) {
  let queue = Promise.resolve();
  const fetcher = async (_url, init) => {
    const body=JSON.parse(init.body);
    const next=queue.then(async()=>{
      try {
        const result=await db.transaction(async tx=>{
          await tx.exec('SET LOCAL ROLE service_role');
          return tx.query('SELECT public.workspace_lead_rpc($1,$2,$3,$4) AS result',[body.p_organization_id,body.p_product_id,body.p_action,body.p_payload]);
        });
        return new Response(JSON.stringify(result.rows[0].result),{status:200,headers:{'Content-Type':'application/json'}});
      } catch(e) { return new Response(JSON.stringify({message:e.message,code:e.code}),{status:400}); }
    });
    queue=next.catch(()=>{}); return next;
  };
  return createLeadStore({supabaseUrl:'http://127.0.0.1:54321',serviceKey:'ISOLATED_TEST_ONLY',organizationId,productId,...scope,fetcher});
}

export async function insertProject(db,n,values={}) {
  await db.query('INSERT INTO public.projects(id,company,site,city,niche) VALUES($1,$2,$3,$4,$5)',[uuid(n),values.company||`Fixture ${n}`,values.site||'https://fixture.test',values.city||'Moscow',values.niche||'hotel']);
  return uuid(n);
}

export const research = (kind='quick', score=70) => ({schemaVersion:1,kind,status:'completed',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*86400000).toISOString(),score:{total:score,priority:'high',components:{fit:20},reasons:[]},business:{industry:'hotel',description:'Isolated fixture',services:[],audience:[]},signals:[],pages:[{url:'https://fixture.test',text:'fixture source'}],materials:{summary:'Fixture draft',followUps:[]}});
