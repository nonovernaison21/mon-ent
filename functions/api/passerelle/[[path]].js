// Runs in Cloudflare Pages Functions. No server key is included in browser code.
const ORIGIN='https://mon-ent.pages.dev';
const ISSUER='https://repere.84.235.226.127.sslip.io/agenda';
const COOKIE='lapsus_ent_transaction',TTL=12*60000;
const SCOPES=['courses','homework','exams','messages','news'];
const ID=/^ment-[a-f0-9-]{36}$/;
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0));
class RequestError extends Error{constructor(message,status=400,code){super(message);this.status=status;this.code=code;}}
const fail=(message,status=400,code)=>{throw new RequestError(message,status,code);};
const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff',...extra}});

async function readBytes(message,limit){
  if(Number(message.headers.get('content-length')||0)>limit)fail('La réponse ou la demande est trop volumineuse.',413);
  if(!message.body)return new Uint8Array();
  const reader=message.body.getReader();let count=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>limit){await reader.cancel();fail('La réponse ou la demande est trop volumineuse.',413);}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return bytes;
}
async function readJSON(message,limit){
  const bytes=await readBytes(message,limit);if(!bytes.length)return {};
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{fail('Le message reçu est invalide.');}
}
function configuration(env){
  if(!env.PASSERELLE_MANAGED_KEY)fail('La connexion ENT n’est pas encore configurée dans Lapsus.',503,'ENT_CONNECTOR_UNCONFIGURED');
  if(!/^[A-Za-z0-9_-]{43}$/.test(env.PASSERELLE_MANAGED_KEY||''))fail('La connexion ENT n’est pas encore configurée dans Lapsus.',503);
  let auth;try{auth=new URL(env.LAPSUS_SUPABASE_URL);}catch{fail('La connexion des comptes Lapsus n’est pas configurée.',503);}
  if(auth.protocol!=='https:'||!auth.hostname.endsWith('.supabase.co')||auth.username||auth.password||auth.port||auth.pathname!=='/'||auth.search||auth.hash)fail('La configuration de connexion Lapsus est invalide.',503);
  const publicKey=env.LAPSUS_SUPABASE_PUBLISHABLE_KEY||'';
  let publishable=/^sb_publishable_[A-Za-z0-9_-]{10,500}$/.test(publicKey);
  if(!publishable&&publicKey.split('.').length===3){try{publishable=JSON.parse(new TextDecoder().decode(decode(publicKey.split('.')[1]))).role==='anon';}catch{}}
  if(!publishable)fail('Configurez une clé publique Supabase, jamais une clé secrète de service.',503);
  return {key:env.PASSERELLE_MANAGED_KEY,auth:auth.origin,publicKey};
}
async function cookieKey(secret){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode('lapsus-managed-ent-cookie-v1:'+secret)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
async function seal(value,secret){const iv=crypto.getRandomValues(new Uint8Array(12));const content=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await cookieKey(secret),new TextEncoder().encode(JSON.stringify(value))));const bytes=new Uint8Array(iv.length+content.length);bytes.set(iv);bytes.set(content,iv.length);return encode(bytes);}
async function open(value,secret){try{if(!/^[A-Za-z0-9_-]{50,2000}$/.test(value||''))throw new Error();const bytes=decode(value);return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},await cookieKey(secret),bytes.slice(12))));}catch{fail('La connexion ENT a expiré. Relancez-la depuis Lapsus.',410);}}
const cookieHeader=(value,maxAge)=>`${COOKIE}=${value}; Path=/api/passerelle; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const cookieValue=request=>(request.headers.get('cookie')||'').split(';').map(row=>row.trim().split('=')).find(([name])=>name===COOKIE)?.[1];

export function createHandler({fetcher=(...args)=>fetch(...args),now=()=>Date.now(),logger=entry=>console.warn(JSON.stringify(entry))}={}){
 return async function handle({request,env}){
  const url=new URL(request.url),path=url.pathname.slice('/api/passerelle'.length);let clearCookie=false,phase='request';
  try{
   if(url.origin!==ORIGIN||!url.pathname.startsWith('/api/passerelle/'))fail('Adresse de service non autorisée.',403);
   const origin=request.headers.get('origin');
   if(origin&&origin!==ORIGIN||!['GET','POST','DELETE'].includes(request.method)||request.method!=='GET'&&origin!==ORIGIN)fail('Origine ou méthode de la demande refusée.',403);
   phase='configuration';
   const config=configuration(env),bearer=request.headers.get('authorization')||'';
   if(!/^Bearer [A-Za-z0-9._-]{30,8192}$/.test(bearer))fail('Connectez-vous à votre compte Lapsus.',401);
   const remote=async(target,url,options)=>{
    phase=target==='auth'?'authentication':'passerelle';
    let response;
    // workerd accepts manual/follow only. Never forward credentials through a redirect.
    try{response=await fetcher(url,{...options,redirect:'manual'});}
    catch{fail(target==='auth'?'La vérification du compte Lapsus est temporairement indisponible.':'La liaison avec Passerelle est temporairement indisponible.',502,target==='auth'?'LAPSUS_AUTH_UNAVAILABLE':'PASSERELLE_UNAVAILABLE');}
    if(response.status>=300&&response.status<400){
     await response.body?.cancel().catch(()=>{});
     fail(target==='auth'?'La connexion des comptes Lapsus doit être vérifiée par l’administrateur.':'La liaison avec Passerelle doit être vérifiée par l’administrateur.',502,target==='auth'?'LAPSUS_AUTH_REDIRECT':'PASSERELLE_REDIRECT');
    }
    return response;
   };
   // Ask Auth for the current user. Never trust a client-supplied subject or metadata.
   const check=await remote('auth',config.auth+'/auth/v1/user',{headers:{apikey:config.publicKey,Authorization:bearer},signal:AbortSignal.timeout(12000)});
   if(!check.ok){if(check.status>=500)fail('La connexion Lapsus est temporairement indisponible.',503);fail('Votre session Lapsus a expiré. Reconnectez-vous.',401);}
   const user=await readJSON(check,128*1024);
   if(!/^[a-fA-F0-9-]{36}$/.test(user.id||'')||user.is_anonymous===true||Date.parse(user.banned_until)>now())fail('Un compte Lapsus actif est nécessaire.',401);
   const upstream=async(route,{method='GET',body,binary=false}={})=>{
    const response=await remote('passerelle',ISSUER+'/api/managed-ent'+route,{method,headers:{Authorization:'Bearer '+config.key,'X-Lapsus-User':user.id,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(binary?35000:30000)});
    if(!response.ok){await response.body?.cancel().catch(()=>{});const messages={401:'La connexion entre Lapsus et Passerelle doit être reconfigurée.',403:'Ces données ne sont pas autorisées pour cette connexion.',404:'Cette connexion ENT n’existe plus. Reconnectez votre ENT.',409:'La connexion ENT a changé. Relancez-la depuis Lapsus.',410:/\/(detail|files)\//.test(route)?'Ce contenu a expiré. Actualise sa liste puis rouvre-le.':'La demande de connexion a expiré.',429:'Trop de demandes. Réessayez dans quelques minutes.',503:'La récupération ENT est temporairement indisponible.'};fail(messages[response.status]||'La récupération ENT est momentanément indisponible.',response.status>=400&&response.status<600?response.status:502);}
    if(binary)return new Response(await readBytes(response,15*1024*1024),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':response.headers.get('Content-Disposition')||'attachment','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    const value=await readJSON(response,2*1024*1024);
    return value;
   };
   if(path==='/connect'&&request.method==='POST'){
    const input=await readJSON(request,4096);
    if(!exact(input,['scopes'])||!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.length>SCOPES.length||new Set(input.scopes).size!==input.scopes.length||input.scopes.some(value=>!SCOPES.includes(value)))fail('Choisissez les données ENT à connecter.');
    const state=encode(crypto.getRandomValues(new Uint8Array(32))),verifier=encode(crypto.getRandomValues(new Uint8Array(32)));
    const codeChallenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    const value=await upstream('/sessions',{method:'POST',body:{externalUserId:user.id,scopes:input.scopes,state,codeChallenge}});
    const launch=new URL(value.launchURL);
    if(launch.origin!==new URL(ISSUER).origin||launch.username||launch.password||launch.hash||launch.pathname!=='/agenda/ent-connect'||[...launch.searchParams.keys()].length!==1||!/^[A-Za-z0-9_-]{43}$/.test(launch.searchParams.get('session')||''))fail('La demande de connexion reçue est invalide.',502);
    phase='transaction';
    const sealed=await seal({userId:user.id,state,verifier,expiresAt:now()+TTL},config.key);
    return json({launchURL:launch.href,expiresAt:value.expiresAt},200,{'Set-Cookie':cookieHeader(sealed,TTL/1000)});
   }
   if(path==='/exchange'&&request.method==='POST'){
    phase='transaction';clearCookie=true;const transaction=await open(cookieValue(request),config.key),input=await readJSON(request,4096);
    if(!exact(input,['code','state','iss'])||transaction.userId!==user.id||transaction.expiresAt<=now()||transaction.expiresAt>now()+TTL||input.state!==transaction.state||input.iss!==ISSUER||!/^[A-Za-z0-9_-]{43}$/.test(input.code||''))fail('Cette connexion ne correspond pas à votre compte Lapsus. Relancez-la.',409);
    const value=await upstream('/exchange',{method:'POST',body:{code:input.code,codeVerifier:transaction.verifier}});
    return json(value,200,{'Set-Cookie':cookieHeader('',0)});
   }
   if(path==='/connection'&&request.method==='GET'&&!url.search)return json(await upstream('/connection'));
   if(path==='/connection'&&request.method==='DELETE'&&!url.search)return json(await upstream('/connection',{method:'DELETE'}));
   const school=/^\/connections\/(ment-[a-f0-9-]{36})\/school\/(messages|news)$/.exec(path);
   if(school&&request.method==='GET'){
    const allowed=school[2]==='messages'?['offset','folder','refresh']:['offset','refresh'];
    if([...url.searchParams.keys()].some(key=>!allowed.includes(key)||url.searchParams.getAll(key).length!==1))fail('Paramètres de consultation invalides.');
    const offset=url.searchParams.get('offset'),folder=url.searchParams.get('folder'),refresh=url.searchParams.get('refresh');
    if(offset!==null&&!/^\d{1,5}$/.test(offset)||folder!==null&&(!folder||folder.length>250)||refresh!==null&&refresh!=='1')fail('Paramètres de consultation invalides.');
    return json(await upstream('/connections/'+school[1]+'/school/'+school[2]+url.search));
   }
   const content=/^\/connections\/(ment-[a-f0-9-]{36})\/(detail|files)\/([a-f0-9]{64})$/.exec(path);
   if(content&&request.method==='GET'&&!url.search){const route='/connections/'+content[1]+'/'+content[2]+'/'+content[3];return content[2]==='files'?await upstream(route,{binary:true}):json(await upstream(route));}
   const match=/^\/connections\/(ment-[a-f0-9-]{36})(?:\/(status|agenda|homework|activity|sync))?$/.exec(path);
   if(!match||!ID.test(match[1]))fail('Service introuvable.',404);
   const [,id,action]=match;
   if(!action&&request.method==='DELETE'&&!url.search)return json(await upstream('/connections/'+id,{method:'DELETE'}));
   if(['status','agenda','homework'].includes(action)&&request.method==='GET'){
    let suffix='';
    if(action!=='status'){
     if([...url.searchParams.keys()].some(key=>!['from','to'].includes(key))||url.searchParams.getAll('from').length!==1||url.searchParams.getAll('to').length!==1)fail('Période de consultation invalide.');
     const from=url.searchParams.get('from'),to=url.searchParams.get('to');
     if(!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(to||''))fail('Indiquez les dates de consultation.');
     suffix='?'+new URLSearchParams({from,to});
    }else if(url.search)fail('La demande contient des paramètres inattendus.');
    return json(await upstream('/connections/'+id+'/'+action+suffix));
   }
   if(['activity','sync'].includes(action)&&request.method==='POST'&&!url.search){const input=await readJSON(request,1024);if(!exact(input,[]))fail('La demande contient des paramètres inattendus.');return json(await upstream('/connections/'+id+'/'+action,{method:'POST',body:{}}));}
   fail('Service introuvable.',404);
  }catch(error){
   const known=error instanceof RequestError,status=known?error.status:502,code=known?error.code:'ENT_CONNECTOR_FAILURE';
   let reference;
   if(status>=500){
    reference=crypto.randomUUID();
    // Fixed fields only: never log error.message, URL, headers, user identity or credentials.
    try{logger({event:'lapsus.ent.failure',reference,phase,code:code||'ENT_HTTP_'+status,status});}catch{}
   }
   return json({error:known?error.message:'Une erreur technique empêche la connexion ENT. Réessayez dans un instant.',...(code?{code}:{}),...(reference?{reference}:{})},status,clearCookie?{'Set-Cookie':cookieHeader('',0)}:{});
  }
 };
}
export const onRequest=createHandler();
