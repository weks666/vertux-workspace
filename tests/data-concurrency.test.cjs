const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const core=require('../workspace-core.js');
const source=fs.readFileSync(path.join(__dirname,'../data.js'),'utf8');
function setup(rows){
  const state={rows:structuredClone(rows),finances:[],writes:0,conflictOnce:false,financeConflictOnce:false};
  const client={from(table){
    let patch=null,insert=null,filters=[],columns='*',range=null;
    const query={select(c){columns=c;return this;},order(){return this;},range(a,b){range=[a,b];return this;},eq(k,v){filters.push([k,v]);return this;},is(k,v){filters.push([k,v]);return this;},update(v){patch=v;return this;},insert(v){insert=v;return this;},single(){return execute(true);},maybeSingle(){return execute(true);},then(resolve,reject){return execute(false).then(resolve,reject);}};
    async function execute(single){
      if(patch&&state.conflictOnce){state.conflictOnce=false;state.rows[0].raw.calls.push({id:'other-manager'});state.rows[0].raw.next_call='2026-10-12';state.rows[0].updated_at='2026-10-08T12:00:01Z';}
      const source=table==='workspace_project_finance'?state.finances:state.rows;
      if(patch&&table==='workspace_project_finance'&&state.financeConflictOnce){state.financeConflictOnce=false;source[0].money.paid_at='2026-10-07T12:00:00';source[0].updated_at='2026-10-08T12:00:01Z';}
      if(insert){if(source.some(r=>r.project_id===insert.project_id))return {data:null,error:{code:'23505'}};source.push(structuredClone(insert));filters.push(['project_id',insert.project_id]);}
      let matched=source.filter(r=>filters.every(([k,v])=>r[k]===v));
      if(range)matched=matched.slice(range[0],range[1]+1);
      if(patch){matched.forEach(r=>Object.assign(r,structuredClone(patch)));state.writes++;}
      let result=matched.map(r=>columns.startsWith('*,finance:')?{...r,finance:state.finances.find(f=>f.project_id===r.id)||null}:columns==='*'?r:Object.fromEntries(columns.split(',').map(k=>[k,r[k]])));
      return {data:structuredClone(single?result[0]||null:result),error:null};
    }
    return query;
  }};
  const context={window:{WorkspaceCore:core,VCAuth:{client:()=>client},crypto:require('node:crypto').webcrypto},URL,console,localStorage:{getItem:()=>null},fetch:()=>{throw new Error('network forbidden');}};
  vm.runInNewContext(source,context);return {...state,state,VC:context.window.VC};
}
test('parallel manager writes preserve current call history and reminder',async()=>{
  const {state,VC}=setup([{id:'one',updated_at:'2026-10-08T12:00:00Z',raw:{calls:[],custom_note:'kept'}}]);
  state.conflictOnce=true;
  const stale={id:'one',raw:{calls:[]}};
  await VC.logCall(stale,{id:'this-manager',at:'2026-10-08T13:00:00Z',out:'talked'});
  assert.deepEqual(state.rows[0].raw.calls.map(c=>c.id),['other-manager','this-manager']);
  assert.equal(state.rows[0].raw.next_call,'2026-10-12');
  assert.equal(state.rows[0].raw.custom_note,'kept');
  await Promise.all([VC.saveRaw(stale,{next_call:'2026-10-13'}),VC.saveRaw(stale,{notes_for_test:'kept'})]);
  assert.equal(state.rows[0].raw.custom_note,'kept');assert.equal(state.rows[0].raw.next_call,'2026-10-13');assert.equal(state.rows[0].raw.notes_for_test,'kept');
  await assert.rejects(VC.saveRaw(stale,{money:{amount:1}}),/отдельно/);
});
test('finance uses its own table and retries a competing owner change without overwriting the date',async()=>{
  const {state,VC}=setup([{id:'one',raw:{calls:[]}}]);
  state.finances.push({project_id:'one',money:{amount:100,percent:20},updated_at:'2026-10-08T12:00:00Z'});
  state.financeConflictOnce=true;
  const p={id:'one'};
  await VC.saveMoney(p,m=>({...m,amount:125.5}));
  assert.equal(state.finances[0].money.amount,125.5);
  assert.equal(state.finances[0].money.paid_at,'2026-10-07T12:00:00');
  assert.equal(p.finance.money.amount,125.5);
  assert.equal('money' in state.rows[0].raw,false);
  await Promise.all([VC.saveMoney({id:'two'},m=>({...m,amount:200})),VC.saveMoney({id:'two'},m=>({...m,percent:35}))]);
  assert.deepEqual(state.finances.find(f=>f.project_id==='two').money,{amount:200,percent:35});
});
test('zero-row save is an error rather than a false success',async()=>{
  const {VC}=setup([]);await assert.rejects(VC.saveNotes('missing','note'),/не сохранена/);
});
test('project loading and import plan cover more than the old 1000-row limit',async()=>{
  const rows=Array.from({length:1101},(_,i)=>({id:String(i),company:'Company '+i,phone:'+79991112233',raw:{}}));
  const {VC}=setup(rows);assert.equal((await VC.loadProjects()).length,1101);
  const plan=await VC.planImport([{company:'Company 1100',phone:'89991112233'}]);
  assert.equal(plan.existing[0].id,'1100');assert.equal(plan.fresh.length,0);
});
test('lowercase Rockefeller headers preserve calls/scripts and distinct cities',()=>{
  const {VC}=setup([]),rows=[{company:'Зал',city:'Москва',phone:'89991112233',call_script:'script'},{company:'Зал',city:'Казань',phone:'89992223344',call_script:'script'}];
  const mapped=VC.mapRows(rows,VC.detectFormat(rows));assert.equal(mapped.rows.length,2);assert.equal(mapped.rows[0].call_script,'script');
});

test('enrichment does not erase known contacts with empty incoming cells',async()=>{
  const {state,VC}=setup([{id:'one',company:'Зал',city:'Москва',phone:'89991112233',site:'https://example.invalid/',raw:{calls:[{id:'kept'}]},notes:'Согласована встреча',processed:true}]);
  await VC.runImport({fresh:[],existing:[{id:'one',company:'Зал',city:'',phone:null,site:null,notes:'',processed:false,call_script:'Обновление',raw:{}}],conflicts:[]},'merge');
  const r=state.rows[0];assert.equal(r.phone,'89991112233');assert.equal(r.city,'Москва');assert.equal(r.site,'https://example.invalid/');assert.equal(r.processed,true);assert.equal(r.notes,'Согласована встреча');assert.equal(r.raw.calls[0].id,'kept');assert.equal(r.call_script,'Обновление');
});
