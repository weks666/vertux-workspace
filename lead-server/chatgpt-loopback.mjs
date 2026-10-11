import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';

// This listener has no public nginx route. The owner reaches it through an
// explicitly opened SSH loopback tunnel; OpenAI credentials never reach the UI.
export async function createChatGPTLoopback({credentials,port=47922}){
  const origin=`http://127.0.0.1:${port}`,callback=origin+'/auth/callback';
  let transaction=null;
  const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.openai.com; frame-ancestors 'none'; base-uri 'none'"};
  const html=(title,text,form='')=>`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{background:#101116;color:#e9e9ef;font:17px/1.6 system-ui;max-width:650px;margin:12vh auto;padding:24px}h1{font-size:28px}button{background:#fff;color:#111;border:0;border-radius:12px;padding:14px 22px;font:inherit;cursor:pointer}a{color:#b9c8ff}</style><h1>${title}</h1><p>${text}</p>${form}</html>`;
  const server=createServer(async(req,res)=>{
    const send=(code,title,text,form,extraHeaders)=>res.writeHead(code,{...headers,...extraHeaders}).end(html(title,text,form));
    if(req.headers.host!==`127.0.0.1:${port}`||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return send(403,'Недоступно','Открой помощник через локальное подключение.');
    const url=new URL(req.url,origin);
    if(req.method==='GET'&&url.pathname==='/auth/health')return res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"ready":true}');
    // no-referrer makes a browser submit Origin: null on this navigation POST.
    // Keep the form same-origin; OAuth redirects and callbacks retain no-referrer.
    if(req.method==='GET'&&url.pathname==='/')return send(200,'Подключить ChatGPT к Workspace','Это твой личный Workspace. После входа сервер сможет использовать разрешённые лимиты подписки. Сам вход не включает анализ компаний. Пароль вводится только на странице OpenAI.','<form method="post" action="/auth/start"><button type="submit">Продолжить с ChatGPT</button></form>',{'Referrer-Policy':'same-origin'});
    if(req.method==='POST'&&url.pathname==='/auth/start'){
      if(req.headers.origin!==origin)return send(403,'Вход не начат','Открой главную страницу локального помощника.','<a href="/">Вернуться к началу входа</a>');
      try{
        const started=await credentials.begin({redirectUri:callback});
        const cookie=randomBytes(32).toString('hex');transaction={cookie,state:new URL(started.authorizationUrl).searchParams.get('state'),expiresAt:Date.now()+600000};
        res.writeHead(303,{...headers,Location:started.authorizationUrl,'Set-Cookie':`vertux_chatgpt_login=${cookie}; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=600`}).end();return;
      }catch{return send(503,'Вход недоступен','Повтори попытку позже. Данные для входа не передавались в Workspace.');}
    }
    if(req.method==='GET'&&url.pathname==='/auth/callback'){
      const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('vertux_chatgpt_login='))?.slice(21)||'';
      const pending=transaction;
      if(!pending||pending.expiresAt<Date.now()||cookie.length!==pending.cookie.length||!timingSafeEqual(Buffer.from(cookie),Buffer.from(pending.cookie))||url.searchParams.get('state')!==pending.state)return send(400,'Вход не подтверждён','Вернись в помощник и начни вход заново.');
      transaction=null;res.setHeader('Set-Cookie','vertux_chatgpt_login=; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=0');
      try{
        await credentials.callback({code:url.searchParams.get('code'),state:url.searchParams.get('state'),clientId:url.searchParams.get('client_id')||undefined,error:url.searchParams.get('error')||undefined});
        return send(200,'ChatGPT подключён','Вернись в Workspace → Исследования → Настройки, проверь подключение и выбери доступную модель. Анализ включается отдельно. Можно закрыть эту страницу.');
      }catch(error){
        if(error?.code==='chatgpt_region_unsupported')return send(403,'OpenAI недоступен с этого сервера','OpenAI не поддерживает обращения из региона текущего сервера. Повторный вход не устранит это ограничение. Исследования можно заказывать в чате; для автоматического подключения нужна поддерживаемая среда запуска.');
        return send(400,'Подключение не завершено','Не удалось завершить проверку входа. Это сообщение само по себе не означает, что подписка недоступна. Вернись в помощник или обратись за диагностикой подключения.','<a href="/">Вернуться к началу входа</a>');
      }
    }
    send(404,'Страница не найдена','Открой главную страницу локального помощника.');
  });
  server.requestTimeout=15000;server.headersTimeout=5000;server.maxHeadersCount=30;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,close:()=>new Promise(resolve=>server.close(resolve))};
}
