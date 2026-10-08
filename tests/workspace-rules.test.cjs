const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../workspace-core.js');
const now=Date.parse('2026-10-08T09:00:00Z');

test('callbacks respect time, closed stages and malformed dates',()=>{
  assert.equal(core.isDue({stage:'new',raw:{next_call:'2026-10-08T10:00:00Z'}},now),false);
  assert.equal(core.isDue({stage:'contacted',raw:{next_call:'2026-10-08T08:00:00Z'}},now),true);
  for(const stage of ['paid','refused','not_interested'])assert.equal(core.isDue({stage,raw:{next_call:'2026-08-09'}},now),false);
  assert.equal(core.isDue({raw:{next_call:'bad-date'}},now),false);
});
test('next call avoids future callbacks and completed leads, rotates attempts',()=>{
  const leads=[
    {id:'closed',phone:'89991112233',stage:'refused',raw:{next_call:'2026-08-09'}},
    {id:'later',phone:'89991112233',stage:'new',raw:{next_call:'2026-10-09'}},
    {id:'just-called',phone:'89991112233',stage:'new',call_script:'script',raw:{calls:[{at:'2026-10-08T08:00:00Z',out:'no_answer'}]}},
    {id:'fresh',phone:'89991112233',stage:'new'}
  ];
  assert.equal(core.nextLead(leads,now).id,'fresh');
  leads.push({id:'due',phone:'89991112233',stage:'contacted',raw:{next_call:'2026-10-08T07:00:00Z'}});
  assert.equal(core.nextLead(leads,now).id,'due');
});
test('same-name companies in different cities are separate, uncertain matches stop',()=>{
  const existing=[{id:'one',company:'Зал',city:'Москва',phone:'+79991112233'}];
  assert.deepEqual(core.matchLead({company:'Зал',city:'Казань',phone:'+79992223344'},existing),{kind:'fresh'});
  assert.deepEqual(core.matchLead({company:'Зал',phone:'8 (999) 111-22-33'},existing),{kind:'existing',id:'one'});
  assert.deepEqual(core.matchLead({company:'Зал'},existing),{kind:'conflict'});
  assert.notEqual(core.identityKey({company:'Зал',city:'Москва'}),core.identityKey({company:'Зал',city:'Казань'}));
  const chain={id:'moscow',company:'Зал',city:'Москва',source_url:'https://example.invalid/'};
  const branch={company:'Зал',city:'Казань',source_url:'https://example.invalid/'};
  assert.equal(core.matchLead(branch,[chain]).kind,'fresh');assert.notEqual(core.identityKey(chain),core.identityKey(branch));
});
test('Russian amount formats, zero and bounded manager share',()=>{
  assert.equal(core.parseMoney('15 000,50'),15000.5);
  assert.equal(core.parseMoney('0'),0);
  assert.equal(core.parseMoney(''),null);
  for(const input of ['-100','100руб','1.2.3','Infinity','12,','101'])assert.throws(()=>core.parseMoney(input,{percent:true}));
});
test('phone list is not concatenated into a non-existent number',()=>{
  assert.equal(core.phone('8 (999) 111-22-33; +7 (999) 222-33-44'),'+79991112233');
  assert.equal(core.phone('позвонить позже'),'');
});

test('money shares always add up to original cents, including half-cent cases',()=>{
  assert.deepEqual(core.moneySplit(15000.5,35),{minor:1500050,managerMinor:525018,studioMinor:975032});
  assert.deepEqual(core.moneySplit(0,35),{minor:0,managerMinor:0,studioMinor:0});
  for(const a of [0.01,0.05,12345.67,1e12])for(const p of [0,12.35,35,50,100]){
    const s=core.moneySplit(a,p);assert.equal(s.managerMinor+s.studioMinor,s.minor);
  }
});

test('current and rollback Service Center versions load only from canonical assets',()=>{
  for(const moduleVersion of ['1.2.1','1.2.2']){
    const assetUrl='https://nexus.vertux.online/service-module/v'+moduleVersion+'/vertux-service-center.js';
    assert.equal(core.serviceAsset({moduleVersion,contractVersion:2,assetUrl},'https://nexus.vertux.online').url,assetUrl);
  }
  for(const patch of [{moduleVersion:'1.4.0'},{contractVersion:3},{assetUrl:'https://attacker.example/script.js'},{assetUrl:'https://nexus.vertux.online/service-module/v1.2.2/vertux-service-center.js?x=1'}]){
    assert.throws(()=>core.serviceAsset({moduleVersion:'1.2.2',contractVersion:2,...patch},'https://nexus.vertux.online'));
  }
});
