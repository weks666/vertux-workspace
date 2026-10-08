import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const assets=new Set(['index.html','styles.css','workspace-core.js','outreach.js','data.js','app.js','vendor/supabase.js','vendor/xlsx.full.min.js','manifest.webmanifest','icon.svg','tests/preview-fixture.js']);
export async function startPreview(port=47861){
  const serviceRoot=process.env.WORKSPACE_SERVICE_ASSETS||resolve(root,'../../projects/vertux-nexus/app/public/service-module/v1.2.3');
  const server=createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://127.0.0.1').pathname;
      if(pathname==='/sw.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end('self.addEventListener("install",()=>self.skipWaiting());');return;}
      let file=pathname==='/'?'index.html':pathname.slice(1),content;
      if(['/__service/vertux-service-center.js','/__service/vertux-service-center.css'].includes(pathname))content=await readFile(resolve(serviceRoot,pathname.split('/').at(-1)));
      else if(assets.has(file))content=await readFile(resolve(root,file));
      else{res.writeHead(404).end();return;}
      if(file==='index.html')content=String(content).replace('<script src="auth.js"></script>','<script src="tests/preview-fixture.js"></script>');
      if(file==='styles.css')content=String(content)+'\n.fixture-banner{height:30px;background:#32285a;color:#fff;font-size:12px;display:grid;place-items:center;text-align:center;padding:3px 8px}#app{height:calc(100vh - 30px)}@media(max-width:540px){.fixture-banner{height:44px;font-size:11.5px}#app{height:calc(100vh - 44px)}}';
      const type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[extname(file)]||'application/octet-stream';
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'}).end(content);
    }catch(_){res.writeHead(500).end('Preview asset unavailable');}
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){await startPreview();console.log('Isolated fixture preview: http://127.0.0.1:47861/');}
