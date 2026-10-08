// Isolated Electron dispatch check. No OS protocol or provider is invoked.
// Run with the existing Nexus checkout's Electron executable, not node.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const nexusRoot=process.env.WORKSPACE_NEXUS_APP||path.resolve(root,'../../projects/vertux-nexus/app');
const asar=require(require.resolve('@electron/asar',{paths:[nexusRoot]}));
const archive=process.env.WORKSPACE_NEXUS_ASAR||path.join(process.env.LOCALAPPDATA,'Programs','Vertux Nexus','resources','app.asar');
const evidence=path.join(root,'evidence/sales-audit');
fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',path.join(evidence,'telephony-electron-profile'));
app.disableHardwareAcceleration();
const guard=setTimeout(()=>{console.error('Electron telephony check timed out');app.exit(1);},15000);
app.whenReady().then(async()=>{
  const source=asar.extractFile(archive,'desktop/main.mjs').toString();
  const version=JSON.parse(asar.extractFile(archive,'package.json').toString()).version;
  const start=source.indexOf('  productWindow.webContents.setWindowOpenHandler(');
  const end=source.indexOf("  productWindow.webContents.on('will-redirect'",start);
  assert.ok(start>=0&&end>start,'Installed product handlers must be located');
  const handlers=source.slice(start,end);
  assert.ok(handlers.includes('const blockForeignNavigation ='));
  const handoffs=[];
  const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,partition:'telephony-isolated-test'}});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('data:')}));
  const scope={URL,productWindow:win,gatewayBound:false,ephemeralLocalNode:false,gatewayBaseUrl:'',exactLocalOrigin:null,
    allowedOrigin:'https://weks666.github.io',
    isWorkspaceAccountExternalUrl:()=>false,gatewayWindowUrlAllowed:()=>false,
    allowedProductUrl:url=>String(url).startsWith('https://weks666.github.io/vertux-workspace/'),
    openExternal:url=>{assert.match(url,/^tel:\+0+$/);handoffs.push(url);return Promise.resolve(true);},
    shell:{openExternal:()=>{throw new Error('OS protocol invocation forbidden in fixture');}},writeLog:()=>{}};
  vm.runInNewContext(handlers+'\nglobalThis.navigationProbe=blockForeignNavigation;',scope);
  let blocked=false;
  scope.navigationProbe({preventDefault:()=>{blocked=true;}},'tel:+00000000000');
  assert.ok(blocked,'Same-window TEL navigation is blocked by installed Nexus');
  await win.loadURL('data:text/html,<title>Isolated telephony dispatch fixture</title><button id="dial">Dial fixture</button>');
  await win.webContents.executeJavaScript("document.getElementById('dial').onclick=()=>window.open('tel:+00000000000','_blank','noopener,noreferrer');document.getElementById('dial').click();",true);
  for(let i=0;i<40&&!handoffs.length;i++)await new Promise(r=>setTimeout(r,25));
  assert.deepEqual(handoffs,['tel:+00000000000']);
  const receipt={at:new Date().toISOString(),status:'INSTALLED_HANDLER_FIXTURE_TESTED',nexusVersion:version,
    mainSha256:crypto.createHash('sha256').update(source).digest('hex'),sameWindowBlocked:blocked,
    newWindowHandoffs:handoffs.length,osProtocolInvocations:0,providerCalls:0};
  fs.writeFileSync(path.join(evidence,'telephony-electron.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));win.destroy();clearTimeout(guard);app.exit(0);
}).catch(e=>{console.error(e.message);clearTimeout(guard);app.exit(1);});
