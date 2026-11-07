/* REST connector used by the existing Lapsus session. No ENT token lives here. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.LapsusPasserelle=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const ISSUER='https://repere.84.235.226.127.sslip.io/agenda';
  const SCOPES=['courses','homework','exams','messages','news'];
  const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
  const text=(value,limit=4000)=>typeof value==='string'?value.slice(0,limit):'';
  const parisDate=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
  function range(value){if(!value||!day(value.from)||!day(value.to)||value.from>value.to||Date.parse(value.to)-Date.parse(value.from)>93*86400000)throw new Error('La période demandée est invalide.');return value;}
  function course(row){
    if(!row||typeof row.id!=='string'||!row.id||row.id.length>200||typeof row.start!=='string'||typeof row.end!=='string'||!Number.isFinite(Date.parse(row.start))||!Number.isFinite(Date.parse(row.end))||Date.parse(row.end)<=Date.parse(row.start))throw new Error('L’emploi du temps reçu est incomplet. La dernière copie est conservée.');
    return {uid:'passerelle-course:'+row.id,title:text(row.title,1000)||'Cours',location:text(row.location,1000),description:'',categories:text(row.subject,200),status:(row.cancelled===true||/^(cancel+ed|annul)/i.test(String(row.status||'')))?'CANCELLED':'CONFIRMED',allDay:false,start:new Date(row.start),end:new Date(row.end),date:parisDate(row.start),kind:'course',managed:true,sequence:Number.isSafeInteger(row.sequence)?row.sequence:0,props:[],raw:''};
  }
  function work(row){
    if(!row||typeof row.id!=='string'||!row.id||row.id.length>200||!day(row.due)||!['homework','exam'].includes(row.kind))throw new Error('Le travail à faire reçu est incomplet. La dernière copie est conservée.');
    return {id:'passerelle-work:'+row.id,title:text(row.title,1000)||'Travail à faire',subject:text(row.subject,200)||'Matière non précisée',notes:text(row.details,20000),due:row.due,type:row.kind==='exam'?'eval':'hw',auto:true,managed:true};
  }
  function replaceRange(previous,incoming,window,dateOf){
    range(window);
    const ids=new Set(incoming.map(row=>row.uid||row.id));
    if(incoming.some(row=>dateOf(row)<window.from||dateOf(row)>window.to))throw new Error('Les données reçues dépassent la période demandée.');
    return [...(previous||[]).filter(row=>{const date=dateOf(row);return (date<window.from||date>window.to)&&!ids.has(row.uid||row.id);}),...incoming];
  }
  function replaceCourses(previous,rows,window){if(!Array.isArray(rows))throw new Error('L’emploi du temps reçu est invalide.');return replaceRange(previous,rows.map(course),window,row=>row.date||parisDate(row.start)).sort((a,b)=>new Date(a.start)-new Date(b.start));}
  function replaceWork(previous,rows,window){if(!Array.isArray(rows))throw new Error('Le travail à faire reçu est invalide.');return replaceRange(previous,rows.map(work),window,row=>row.due).sort((a,b)=>a.due.localeCompare(b.due));}
  function captureCallback(location,history){
    if(!location||location.pathname!=='/passerelle/ent/callback')return null;
    const query=new URLSearchParams(location.search);
    // Run before Supabase is initialized: this code belongs to Passerelle, not Supabase.
    history.replaceState(null,'','/');
    const value={code:query.get('code'),state:query.get('state'),iss:query.get('iss')};
    if(!/^[A-Za-z0-9_-]{43}$/.test(value.code||'')||!/^[A-Za-z0-9_-]{43}$/.test(value.state||'')||value.iss!==ISSUER)return {error:'Le retour ENT est invalide ou incomplet. Relance la connexion depuis les réglages.'};
    return value;
  }
  function metadata(value){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('La réponse de connexion ENT est invalide.');
    if(value.connectionId===null)return {connectionId:null};
    if(typeof value.connectionId!=='string'||!/^ment-[a-f0-9-]{36}$/i.test(value.connectionId)||!Array.isArray(value.scopes)||value.scopes.some(scope=>!SCOPES.includes(scope)))throw new Error('La réponse de connexion ENT est invalide.');
    return {connectionId:value.connectionId,status:text(value.status,40),scopes:[...value.scopes],schoolName:text(value.schoolName,200),student:value.student?{name:text(value.student.name,200),className:text(value.student.className,100)}:null,lastSync:Number.isFinite(value.lastSync)?value.lastSync:null,lastAttempt:Number.isFinite(value.lastAttempt)?value.lastAttempt:null,lastError:text(value.lastError,500)||null,stale:!!value.stale,nextSyncAt:Number.isFinite(value.nextSyncAt)?value.nextSyncAt:null,sourceVersion:text(value.sourceVersion,100)||null};
  }
  function createClient({getAccessToken,fetcher=(...args)=>fetch(...args),base='/api/passerelle'}={}){
    if(typeof getAccessToken!=='function')throw new Error('La session Lapsus est nécessaire.');
    if(base!=='/api/passerelle')throw new Error('Le connecteur doit utiliser la fonction du site Lapsus.');
    async function request(path,body,method,binary=false){
      const token=await getAccessToken();
      if(typeof token!=='string'||!token)throw Object.assign(new Error('Reconnecte-toi à Lapsus pour continuer.'),{status:401});
      const response=await fetcher(base+path,{method:method||(body===undefined?'GET':'POST'),credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(binary?40000:35000)});
      if(binary&&response.ok){const blob=await response.blob();if(blob.size>15*1024*1024)throw new Error('Ce document dépasse 15 Mo.');return blob;}
      let value;try{value=await response.json();}catch{throw new Error('La connexion ENT n’est pas disponible sur cette version de Lapsus.');}
      if(!response.ok)throw Object.assign(new Error(text(value.error,500)||'La connexion ENT est momentanément indisponible.'),{status:response.status,code:value.code});
      return value;
    }
    const connectionPath=id=>{if(!/^ment-[a-f0-9-]{36}$/i.test(id||''))throw new Error('Connexion ENT invalide.');return '/connections/'+encodeURIComponent(id);};
    return {
      async connect(scopes=SCOPES){
        if(!Array.isArray(scopes)||!scopes.length||scopes.some(scope=>!SCOPES.includes(scope)))throw new Error('Choisis les informations à connecter.');
        const result=await request('/connect',{scopes});let url;try{url=new URL(result.launchURL);}catch{throw new Error('Le lien de connexion ENT est invalide.');}
        if(url.origin!==new URL(ISSUER).origin||url.pathname!=='/agenda/ent-connect'||url.username||url.password||url.hash||[...url.searchParams.keys()].some(key=>key!=='session')||!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('session')||''))throw new Error('Le lien de connexion ENT est invalide.');
        return url.href;
      },
      async exchange(callback){if(callback?.error)throw new Error(callback.error);return metadata(await request('/exchange',{code:callback.code,state:callback.state,iss:callback.iss}));},
      async current(){return metadata(await request('/connection'));},
      async agenda(id,window){range(window);const result=await request(connectionPath(id)+'/agenda?'+new URLSearchParams(window));return {...metadata(result),events:result.events};},
      async homework(id,window){range(window);const result=await request(connectionPath(id)+'/homework?'+new URLSearchParams(window));return {...metadata(result),items:result.items,available:result.available===true,warning:text(result.warning,500)||null};},
      async school(id,section,query={}){
        if(!['messages','news'].includes(section)||Object.keys(query).some(key=>!['offset','folder','refresh'].includes(key)))throw new Error('Rubrique ENT invalide.');
        const result=await request(connectionPath(id)+'/school/'+section+(Object.keys(query).length?'?'+new URLSearchParams(query):''));
        if(typeof result.available!=='boolean'||!Array.isArray(result.items)||result.available&&result.items.some(item=>!item||!/^([a-f0-9]{64})$/.test(item.ref||'')||typeof item.title!=='string'))throw new Error('La réponse ENT est incomplète. La dernière copie est conservée.');
        return {...result,...metadata(result),section,warning:text(result.warning,500)||null};
      },
      async detail(id,ref){if(!/^[a-f0-9]{64}$/.test(ref||''))throw new Error('Contenu ENT invalide.');const value=await request(connectionPath(id)+'/detail/'+ref);if(!['message','news'].includes(value.kind))throw new Error('Contenu ENT invalide.');return {...value,...metadata(value)};},
      async file(id,ref){if(!/^[a-f0-9]{64}$/.test(ref||''))throw new Error('Document ENT invalide.');return request(connectionPath(id)+'/files/'+ref,undefined,'GET',true);},
      async activity(id){return metadata(await request(connectionPath(id)+'/activity',{}));},
      async sync(id){return metadata(await request(connectionPath(id)+'/sync',{}));},
      async disconnect(id){await request(connectionPath(id),undefined,'DELETE');},
      async disconnectCurrent({knownConnection=false}={}){
        try{await request('/connection',undefined,'DELETE');}
        catch(error){if(knownConnection||error.status!==503||error.code!=='ENT_CONNECTOR_UNCONFIGURED')throw error;}
      }
    };
  }
  return {createClient,captureCallback,replaceCourses,replaceWork,metadata,parisDate};
});
