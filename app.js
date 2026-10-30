'use strict';

const CONFIG={
  RELAY_URL:'https://ent-relais.nonovernaison21.workers.dev',
  SUPABASE_URL:'https://wrrfblhxomsegdyadens.supabase.co',
  SUPABASE_KEY:'sb_publishable_Y6sU39QsYtTFnVeocHjAiA_4yFIEHFu'
};

const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
const startOfDay=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate());

function unfold(t){return t.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\n[ \t]/g,'').split('\n');}

function splitLine(line){
  let inQ=false,idx=-1;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"')inQ=!inQ;
    else if(c===':'&&!inQ){idx=i;break;}
  }
  if(idx<0)return null;
  const parts=line.slice(0,idx).split(';');
  const params={};
  for(const p of parts.slice(1)){const [k,...v]=p.split('=');params[k.toUpperCase()]=v.join('=').replace(/^"|"$/g,'');}
  return {name:parts[0].toUpperCase(),params,value:line.slice(idx+1)};
}
const unescapeText=s=>s.replace(/\\[nN]/g,'\n').replace(/\\,/g,',').replace(/\\;/g,';').replace(/\\\\/g,'\\');

function tzOffsetMs(utcMs,tz){
  const f=new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const p=Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x=>[x.type,x.value]));
  return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(utcMs/1000)*1000;
}
function wallToDate(y,mo,d,h,mi,s,tz){
  if(!tz)return new Date(y,mo-1,d,h,mi,s);
  try{
    const guess=Date.UTC(y,mo-1,d,h,mi,s);
    let t=guess-tzOffsetMs(guess,tz);
    t=guess-tzOffsetMs(t,tz);
    return new Date(t);
  }catch(e){return new Date(y,mo-1,d,h,mi,s);}
}
function parseDate(value,params){
  const m=value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if(!m)return null;
  const [,Y,M,D,h,mi,s,z]=m;
  if(h===undefined)return {date:new Date(+Y,+M-1,+D),allDay:true};
  if(z)return {date:new Date(Date.UTC(+Y,+M-1,+D,+h,+mi,+(s||0))),allDay:false};
  return {date:wallToDate(+Y,+M,+D,+h,+mi,+(s||0),params&&params.TZID),allDay:false};
}
function parseDuration(v){
  const m=v.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if(!m)return 0;
  return ((+m[1]||0)*86400+(+m[2]||0)*3600+(+m[3]||0)*60+(+m[4]||0))*1000;
}

const DAYS=['SU','MO','TU','WE','TH','FR','SA'];
function expandRule(ev,rule,ex){
  const r=Object.fromEntries(rule.split(';').map(x=>x.split('=')));
  const interval=+(r.INTERVAL||1);
  if(r.FREQ!=='DAILY'&&r.FREQ!=='WEEKLY')return [Object.assign({},ev,{unsupported:true})];
  const dur=ev.end-ev.start;
  const until=r.UNTIL?parseDate(r.UNTIL,{}):null;
  const limit=Math.min(until?until.date.getTime():Infinity,ev.start.getTime()+400*86400000);
  const by=r.BYDAY?r.BYDAY.split(',').map(x=>DAYS.indexOf(x.slice(-2))):[ev.start.getDay()];
  const max=+(r.COUNT||Infinity);
  const day0=startOfDay(ev.start);
  const mon0=addDays(day0,-((day0.getDay()+6)%7));
  const out=[];let count=0;
  for(let d=new Date(day0);d.getTime()<=limit&&count<max&&out.length<1500;d=addDays(d,1)){
    let ok;
    if(r.FREQ==='DAILY')ok=Math.round((d-day0)/86400000)%interval===0;
    else{
      const mon=addDays(d,-((d.getDay()+6)%7));
      ok=Math.round((mon-mon0)/(7*86400000))%interval===0&&by.includes(d.getDay());
    }
    if(!ok)continue;
    count++;
    const st=new Date(d.getFullYear(),d.getMonth(),d.getDate(),ev.start.getHours(),ev.start.getMinutes(),ev.start.getSeconds());
    if(ex.has(st.getTime()))continue;
    out.push(Object.assign({},ev,{start:st,end:new Date(st.getTime()+dur),recurring:true}));
  }
  return out;
}

function buildEvents(c){
  const p=c.props,first=n=>p[n]&&p[n][0];
  const ds=first('DTSTART');if(!ds)return [];
  const s=parseDate(ds.value,ds.params);if(!s)return [];
  const de=first('DTEND'),du=first('DURATION');
  const e=de&&parseDate(de.value,de.params);
  const end=e?e.date:new Date(s.date.getTime()+(s.allDay?86400000:(du?parseDuration(du.value):0)));
  const val=n=>first(n)?first(n).value:'';
  const ev={
    uid:val('UID'),
    title:unescapeText(val('SUMMARY')||'(sans titre)'),
    location:unescapeText(val('LOCATION')),
    description:unescapeText(val('DESCRIPTION')),
    categories:unescapeText(val('CATEGORIES')),
    status:val('STATUS').toUpperCase(),
    allDay:s.allDay,start:s.date,end,
    props:Object.keys(p),raw:c.raw.join('\n')
  };
  const rid=first('RECURRENCE-ID');
  if(rid){const r=parseDate(rid.value,rid.params);if(r)ev.override=r.date.getTime();}
  const rr=first('RRULE');
  if(!rr)return [ev];
  const ex=new Set();
  for(const x of (p['EXDATE']||[]))for(const v of x.value.split(',')){const d=parseDate(v,x.params);if(d)ex.add(d.date.getTime());}
  return expandRule(ev,rr.value,ex);
}

function parseICS(text){
  const events=[],cal={};
  let cur=null,alarm=0;
  for(const line of unfold(text)){
    const L=line.trimEnd();
    if(L==='BEGIN:VEVENT'){cur={raw:[],props:{}};continue;}
    if(L==='END:VEVENT'){if(cur)events.push(...buildEvents(cur));cur=null;continue;}
    if(L==='BEGIN:VALARM'){alarm++;continue;}
    if(L==='END:VALARM'){alarm=Math.max(0,alarm-1);continue;}
    if(alarm)continue;
    const pl=splitLine(L);if(!pl)continue;
    if(cur){cur.raw.push(L);(cur.props[pl.name]=cur.props[pl.name]||[]).push(pl);}
    else cal[pl.name]=pl.value;
  }
  const ov=new Set(events.filter(e=>e.override).map(e=>e.uid+'|'+e.override));
  return {events:events.filter(e=>!(e.recurring&&ov.has(e.uid+'|'+e.start.getTime()))),cal};
}

const $=s=>document.querySelector(s);
let NS='';
const GLOBAL_KEYS=new Set(['view','mode','themePreference','theme']);
const K=k=>GLOBAL_KEYS.has(k)?k:NS+k;
const store={
  get(k,d){try{const v=localStorage.getItem(K(k));return v===null?d:JSON.parse(v);}catch(e){return d;}},
  set(k,v){try{localStorage.setItem(K(k),JSON.stringify(v));}catch(e){}}
};
const uid=()=>crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16);});
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
const fmtTime=d=>d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
const fmtDay=d=>d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'});
const isoDay=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseISO=s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);};
const mondayOf=d=>addDays(startOfDay(d),-((d.getDay()+6)%7));
const sameDay=(a,b)=>a.toDateString()===b.toDateString();
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const rxEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function hslHex(h,s,l){s/=100;l/=100;const a=s*Math.min(l,1-l);const f=n=>{const k=(n+h/30)%12;const c=l-a*Math.max(Math.min(k-3,9-k,1),-1);return Math.round(255*c).toString(16).padStart(2,'0');};return '#'+f(0)+f(8)+f(4);}
function hue(s){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))%360;return h;}
const subjectColor=t=>colors[t]||'hsl('+hue(t)+' 55% var(--ev-l))';
function rel(ms){const m=Math.max(1,Math.round(ms/60000));if(m<60)return m+' min';return Math.floor(m/60)+' h '+String(m%60).padStart(2,'0');}
const typing=()=>!!document.activeElement&&['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName);

const ICON={
  home:'<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  cal:'<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M3 10h18M8 2.5v4M16 2.5v4"/>',
  hw:'<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="m8.5 12.2 2.5 2.5 4.5-5"/>',
  set:'<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'
};
const svg=(n,s)=>`<svg viewBox="0 0 24 24" width="${s||22}" height="${s||22}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

function reviveEvent(e){return Object.assign({},e,{start:new Date(e.start),end:new Date(e.end)});}

const VIEWS=[['home','Accueil','home'],['agenda','Agenda','cal'],['hw','Devoirs','hw'],['set','Réglages','set']];
const DEFAULT_WORDS=['travail à faire','devoir à faire','devoir maison','devoirs','à faire','à rendre','à préparer','à apprendre','dm','homework'];
const EVAL_RE=/(^|[^a-z0-9])(devoir surveille|ds|dst|controle|interro|interrogation|evaluation|examen|bac blanc|partiel)([^a-z0-9]|$)/;

// Forçage de l'ouverture sur 'home' au démarrage, sans persister de vue 'réglages'
let view='home';
store.set('view','home');

let mode=store.get('mode','week');
let cursor=startOfDay(new Date());
let events=[];
let hwFeedEvents=[],evalFeedEvents=[],hw=[],autoDone={},ctrlDone={},ov={},words=DEFAULT_WORDS.slice(),colors={};
function resetState(){colors={};events=[];hwFeedEvents=[];evalFeedEvents=[];hw=[];autoDone={};ctrlDone={};ov={};words=DEFAULT_WORDS.slice();}
function loadState(){
  resetState();
  hwFeedEvents=store.get('hwFeedEvents',[]).map(reviveEvent);
  evalFeedEvents=store.get('evalFeedEvents',[]).map(reviveEvent);
  hw=store.get('homework',[]);autoDone=store.get('hwAutoDone',{});ctrlDone=store.get('ctrlDone',{});
  ov=store.get('overrides',{});words=store.get('hwWords',DEFAULT_WORDS.slice());colors=store.get('subjectColors',{});
  const c=store.get('icsText','');if(c){try{loadICS(c);}catch(e){console.error(e);}}
  const ch=store.get('hwICStext','');
  if(ch){try{hwFeedEvents=parseICS(ch).events.sort((a,b)=>a.start-b.start);store.set('hwFeedEvents',hwFeedEvents);}catch(e){console.error(e);}}
  const ce=store.get('evalICStext','');
  if(ce){try{evalFeedEvents=parseICS(ce).events.sort((a,b)=>a.start-b.start);store.set('evalFeedEvents',evalFeedEvents);}catch(e){console.error(e);}}
}
let hwFilter='all',showDone=false;
let hwRx=null;
const saveHw=()=>store.set('homework',hw);

function buildRx(){
  const ws=words.map(w=>norm(w).trim()).filter(Boolean);
  hwRx=ws.length?new RegExp('(^|[^a-z0-9])('+ws.map(rxEsc).join('|')+')([^a-z0-9]|$)'):null;
}
function classify(){
  buildRx();
  for(const e of events){
    e.key=(e.uid||e.title)+'|'+e.start.getTime();
    const o=ov[e.key];
    if(o){e.kind=o;continue;}
    const t=norm(e.title);
    if(EVAL_RE.test(t+' '+norm(e.description))){e.kind='eval';continue;}
    if(hwRx&&hwRx.test(t+' '+norm(e.description))){e.kind='hw';continue;}
    e.kind='course';
  }
}
function feedItemFromEvent(e,type){
  let title=(e.title||'').trim(),subject=(e.categories||'').split(',')[0].trim();
  const m=title.match(/^(.{2,45}?)\s*[:：]\s*(.+)$/);
  if(m){
    const prefix=m[1].trim();
    if(!subject&&!/(devoir|travail|controle|contrôle|évaluation|evaluation|interro|ds|dst)/i.test(prefix))subject=prefix;
    title=m[2].trim();
  }
  if(!subject){
    const dash=title.match(/^(.{2,45}?)\s+[–—-]\s+(.+)$/);
    if(dash&&!/(devoir|travail|controle|contrôle|évaluation|evaluation|interro|ds|dst)/i.test(dash[1])){subject=dash[1].trim();title=dash[2].trim();}
  }
  return {id:(e.uid||e.title)+'|'+e.start.getTime(),title:cap(title||e.title||'(sans titre)'),subject:subject||'Matière non précisée',due:isoDay(e.start),notes:e.description||'',allDay:e.allDay,start:e.start,end:e.end,type};
}
function hwItems(){
  const imported=hwFeedEvents.filter(e=>e.status!=='CANCELLED').map(e=>{const x=feedItemFromEvent(e,'hw');return Object.assign({auto:true,done:!!autoDone[x.id]},x);});
  const man=hw.map(h=>Object.assign({},h,{auto:false}));
  return imported.concat(man);
}
function evalItems(){return evalFeedEvents.filter(e=>e.status!=='CANCELLED').map(e=>{const x=feedItemFromEvent(e,'eval');x.done=!!ctrlDone[x.id];return x;}).sort(byDue);}
function todoItems(){
  const allHw=hwItems().filter(h=>!h.done);
  const ctrls=evalItems().filter(c=>!c.done&&parseISO(c.due)>=startOfDay(new Date()));
  return allHw.concat(ctrls);
}
const byDue=(a,b)=>a.due.localeCompare(b.due);
const sched=day=>{const s=startOfDay(day),e=addDays(s,1);return events.filter(ev=>ev.kind==='course'&&ev.start<e&&ev.end>s);};
function groupItems(items){
  const groups={};
  for(const item of items){const subject=(item.subject||'Matière non précisée').trim()||'Matière non précisée';(groups[subject]||(groups[subject]=[])).push(item);}
  return Object.keys(groups).sort((a,b)=>a.localeCompare(b,'fr')).map(subject=>({subject,items:groups[subject].sort(byDue)}));
}
function groupedHomework(items){return groupItems(items).map(g=>`<section class="subject-group"><h3>${esc(g.subject)} <span>${g.items.length}</span></h3>${list(g.items.map(hwRow).join(''),'Aucun élément.')}</section>`).join('');}
function controlRow(h){const d=dueLabel(h.due);return `<div class="hw control-item${h.done?' done':''}">
    <input type="checkbox" data-act="ctrltoggle" data-id="${esc(h.id)}" ${h.done?'checked':''} aria-label="Marquer comme fait">
    <div class="hb"><div class="ht">${esc(h.title)}</div><div class="m"><span class="${d.c}">${esc(d.t)}</span></div>${h.notes?`<details><summary>Contenu et détails</summary><div class="notes">${esc(h.notes)}</div></details>`:''}</div></div>`;}
function groupedControls(items){return groupItems(items).map(g=>`<section class="subject-group"><h3>${esc(g.subject)} <span>${g.items.length}</span></h3>${list(g.items.map(controlRow).join(''),'Aucun contrôle.')}</section>`).join('');}

function loadICS(text){
  const r=parseICS(text);
  events=r.events.sort((a,b)=>a.start-b.start);
  classify();
}

function showLoader(t,s){const l=$('#loader');if(!l)return;const a=$('#loaderTitle'),b=$('#loaderSub');if(a)a.textContent=t||'Chargement en cours…';if(b)b.textContent=s||'';l.hidden=false;}
function hideLoader(){const l=$('#loader');if(l)l.hidden=true;}
async function withLoader(t,s,p){showLoader(t,s);try{return await p;}finally{hideLoader();}}

function setStatus(t,err){const s=$('#status');if(s){s.textContent=t;s.className='status'+(err?' err':'');}}
async function fetchCalendarUrl(url){
  const r=await fetch(CONFIG.RELAY_URL+'?url='+encodeURIComponent(url),{cache:'no-store'});
  if(!r.ok){let m='Erreur '+r.status;try{const j=await r.json();if(j.error)m=j.error;}catch(e){}throw new Error(m);}
  const text=await r.text();
  if(!text.includes('BEGIN:VCALENDAR'))throw new Error('Ce lien ne renvoie pas un calendrier ICS');
  return text;
}
async function refresh(){
  if(!session())return;
  const feeds=[
    {key:'icsUrl',cache:'icsText',name:'emploi du temps',apply:text=>{loadICS(text);}},
    {key:'homeworkUrl',cache:'hwICStext',name:'devoirs',apply:text=>{hwFeedEvents=parseICS(text).events.sort((a,b)=>a.start-b.start);store.set('hwFeedEvents',hwFeedEvents);}},
    {key:'controlsUrl',cache:'evalICStext',name:'contrôles',apply:text=>{evalFeedEvents=parseICS(text).events.sort((a,b)=>a.start-b.start);store.set('evalFeedEvents',evalFeedEvents);}}
  ];
  const configured=feeds.filter(f=>store.get(f.key,''));
  if(!configured.length){setStatus('Ajoute un lien ICS dans les réglages');return;}
  setStatus('Actualisation...');
  const results=await Promise.all(configured.map(async f=>{
    try{
      const text=await fetchCalendarUrl(store.get(f.key,''));
      f.apply(text);store.set(f.cache,text);
      if(f.key==='icsUrl'){store.set('demo',false);store.set('lastSync',Date.now());}
      return {name:f.name,ok:true};
    }catch(err){
      const cached=store.get(f.cache,'');
      if(cached){try{f.apply(cached);}catch(e){}}
      return {name:f.name,ok:false,error:err.message};
    }
  }));
  const failed=results.filter(r=>!r.ok);
  if(failed.length)setStatus('Erreur '+failed.map(r=>r.name+': '+r.error).join(' · '),true);
  else{store.set('lastSync',Date.now());setStatus('Synchronisé à '+fmtTime(new Date()));}
  if(!typing())render();
}

function evRow(ev,showDate){
  const now=new Date();
  const cancelled=ev.status==='CANCELLED';
  const live=!ev.allDay&&!cancelled&&ev.start<=now&&ev.end>now;
  const tm=ev.allDay?'<b>Jour</b><span>entier</span>':`<b>${fmtTime(ev.start)}</b><span>${fmtTime(ev.end)}</span>`;
  const sub=[showDate?cap(fmtDay(ev.start)):'',ev.location].filter(Boolean).map(esc).join(' · ');
  return `<div class="ev${cancelled?' cancelled':''}" style="--c:${esc(subjectColor(ev.title))}">
    <div class="tm">${tm}</div>
    <div class="bd">
      <div class="t">${esc(ev.title)}${ev.kind==='eval'?'<span class="badge warn">Évaluation</span>':''}${cancelled?'<span class="badge bad">Annulé</span>':''}${live?'<span class="badge ok">En cours</span>':''}</div>
      ${sub?`<div class="m">${sub}</div>`:''}
      <details><summary>Détails</summary>${ev.description?`<div class="notes">${esc(ev.description)}</div>`:''}</details>
    </div>
  </div>`;
}
function dueLabel(iso){
  const n=Math.round((parseISO(iso)-startOfDay(new Date()))/86400000);
  if(n<0)return {t:`en retard (${-n} j)`,c:'late'};
  if(n===0)return {t:"aujourd'hui",c:'soon'};
  if(n===1)return {t:'demain',c:'soon'};
  return {t:parseISO(iso).toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'short'}),c:''};
}
function hwRow(h){
  const d=dueLabel(h.due);
  const act=h.auto?'':`<button class="lnk" data-act="hwdel" data-id="${esc(h.id)}">Supprimer</button>`;
  return `<div class="hw${h.done?' done':''}">
    <input type="checkbox" data-act="hwtoggle" data-id="${esc(h.id)}" ${h.done?'checked':''} aria-label="Marquer comme fait">
    <div class="hb"><div class="ht">${esc(h.title)}</div>
      <div class="m">${h.subject?esc(h.subject)+' · ':''}<span class="${d.c}">${esc(d.t)}</span></div>
      ${h.notes?`<details><summary>Détails</summary><div class="notes">${esc(h.notes)}</div></details>`:''}
    </div>
    ${act}
  </div>`;
}
const list=(html,empty)=>html?`<div class="list">${html}</div>`:`<p class="empty">${esc(empty)}</p>`;

function secHead(title, rightHtml = '') {
  return `<div class="sech"><h2>${esc(title)}</h2>${rightHtml}</div>`;
}

function viewHome(){
  if(!events.length&&!hw.length)return `<h1>Bienvenue</h1>
    <p class="sub">Aucun calendrier chargé pour l'instant.</p>
    <div class="row"><button class="btn primary" data-act="view" data-v="set">Ajouter mon lien ICS</button><button class="btn" data-act="demo">Voir un exemple</button></div>`;
  const now=new Date();
  const act=events.filter(e=>e.kind==='course'&&!e.allDay&&e.status!=='CANCELLED');
  const cur=act.find(e=>e.start<=now&&e.end>now);
  const nxt=act.find(e=>e.start>now);
  const today=sched(now);
  const real=today.filter(e=>!e.allDay&&e.status!=='CANCELLED');
  const resume=real.length?`${real.length} cours, de ${fmtTime(real[0].start)} à ${fmtTime(real.reduce((m,e)=>e.end>m?e.end:m,real[0].end))}`:"Pas de cours aujourd'hui";
  const nxtWhen=nxt?(sameDay(nxt.start,now)?'dans '+rel(nxt.start-now):cap(fmtDay(nxt.start))+' à '+fmtTime(nxt.start)):'';
  const tile=(label,ev,none)=>`<div class="tile${label==='En ce moment'?' now':''}"><div class="lab">${esc(label)}</div>${ev
    ?`<div class="big">${esc(ev.title)}</div><div class="m">${fmtTime(ev.start)} - ${fmtTime(ev.end)}${ev.location?' · '+esc(ev.location):''}</div>`
    :`<div class="m">${esc(none)}</div>`}</div>`;
  const tmr=isoDay(addDays(startOfDay(now),1));
  const tomorrow=hwItems().filter(h=>h.due===tmr).sort((a,b)=>(a.done-b.done)||a.title.localeCompare(b.title,'fr'));
  const horizon=addDays(now,14);
  const evals=evalItems().filter(e=>!e.done&&parseISO(e.due)>=startOfDay(now)&&parseISO(e.due)<horizon).slice(0,4);
  return `<h1>${esc(cap(fmtDay(now)))}</h1>
  <p class="sub">${esc(resume)}${store.get('demo',false)?' · exemple fictif':''}</p>
  <div class="hero">
    ${tile('En ce moment',cur,'Pas de cours en ce moment.')}
    ${tile(nxt?'Ensuite · '+nxtWhen:'Ensuite',nxt,'Aucun cours à venir.')}
  </div>
  ${secHead('Aperçu de ma journée','<button class="lnk2" data-act="gotoweek">Voir la semaine ›</button>')}
  ${list(today.map(e=>evRow(e)).join(''),'Rien de prévu.')}
  ${secHead('Devoirs pour demain','<button class="lnk2" data-act="view" data-v="hw">Tous les devoirs ›</button>')}
  ${list(tomorrow.map(hwRow).join(''),'Aucun devoir pour demain.')}
  ${evals.length?`<h2>Contrôles à venir</h2>${groupedControls(evals)}`:''}`;
}

function getFixedBands(dayEvents, dayDate) {
  const ds = startOfDay(dayDate);
  const mm = e => e.getHours() * 60 + e.getMinutes();
  const morningRec = { s: 10 * 60 + 5, e: 10 * 60 + 20, label: '' };
  const afternoonRec = { s: 14 * 60 + 55, e: 15 * 60 + 10, label: '' };
  const windowStart = 11 * 60 + 15;
  const windowEnd = 14 * 60;
  const conflicting = dayEvents.filter(e => {
    if (e.allDay || e.status === 'CANCELLED') return false;
    const s = e.start < ds ? 0 : mm(e.start);
    const en = mm(e.end);
    return s < windowEnd && en > windowStart;
  });
  let lunchStart = 12 * 60, lunchEnd = 13 * 60;
  if (conflicting.length) {
    let bestStart = windowStart, maxDuration = 0;
    const sorted = conflicting.map(e => ({
      s: Math.max(windowStart, mm(e.start)),
      e: Math.min(windowEnd, mm(e.end))
    })).sort((a, b) => a.s - b.s);
    let cursorTime = windowStart;
    for (const block of sorted) {
      if (block.s - cursorTime > maxDuration) { maxDuration = block.s - cursorTime; bestStart = cursorTime; lunchEnd = block.s; }
      cursorTime = Math.max(cursorTime, block.e);
    }
    if (windowEnd - cursorTime > maxDuration) { bestStart = cursorTime; lunchEnd = windowEnd; }
    lunchStart = bestStart;
    if (lunchEnd - lunchStart < 45) lunchEnd = Math.min(windowEnd, lunchStart + 60);
    if (lunchEnd - lunchStart > 90) lunchEnd = lunchStart + 75;
  }
  const lunch = { s: lunchStart, e: lunchEnd, label: 'Déjeuner' };
  return [morningRec, lunch, afternoonRec];
}

function timeGrid(mon) {
  const now = new Date();
  const isMobile = window.innerWidth <= 760;
  let days = [];
  if (isMobile) {
    days = [{ d: cursor, l: sched(cursor) }];
  } else {
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i), l = sched(d);
      if (i >= 5 && !l.length) continue;
      days.push({ d, l });
    }
  }

  const mm = e => e.getHours() * 60 + e.getMinutes();
  const h0 = 8.25 * 60, h1 = 18 * 60;
  const HH = 60, H = (18 - 8.25) * HH;
  const y = min => (min - h0) * HH / 60;

  const hoursList = [
    { m: 8*60+15, label: '8h15' }, { m: 9*60+10, label: '9h10' },
    { m: 10*60+5, label: '10h05' }, { m: 10*60+20, label: '10h20' },
    { m: 11*60+15, label: '11h15' }, { m: 12*60+10, label: '12h10' },
    { m: 13*60+5, label: '13h05' }, { m: 14*60, label: '14h00' },
    { m: 14*60+55, label: '14h55' }, { m: 15*60+10, label: '15h10' },
    { m: 16*60+5, label: '16h05' }, { m: 17*60, label: '17h00' }
  ];
  const hours = hoursList.map(h => `<i style="top:${y(h.m)}px">${h.label}</i>`).join('');

  const cols = days.map(({ d, l }) => {
    const ds = startOfDay(d), de = addDays(ds, 1);
    const items = l.filter(e => !e.allDay).map(e => ({
      e, s: e.start < ds ? h0 : Math.max(h0, mm(e.start)), e2: e.end >= de ? h1 : Math.min(h1, mm(e.end))
    })).filter(x => x.e2 > x.s).sort((a, b) => a.s - b.s || a.e2 - b.e2);

    let cluster = [], cEnd = -1;
    const flush = () => {
      if (!cluster.length) return;
      const lanes = [];
      for (const it of cluster) {
        let k = lanes.findIndex(end => end <= it.s);
        if (k < 0) { k = lanes.length; lanes.push(0); }
        lanes[k] = it.e2; it.lane = k;
      }
      cluster.forEach(it => { it.n = lanes.length; });
      cluster = []; cEnd = -1;
    };
    for (const it of items) {
      if (cluster.length && it.s >= cEnd) flush();
      cluster.push(it); cEnd = Math.max(cEnd, it.e2);
    }
    flush();

    const blocks = items.map(it => {
      const ev = it.e, cancelled = ev.status === 'CANCELLED', live = !cancelled && ev.start <= now && ev.end > now;
      const top = y(it.s), hgt = Math.max(18, y(it.e2) - top - 2);
      const tip = [ev.title, fmtTime(ev.start) + ' - ' + fmtTime(ev.end), ev.location, ev.description].filter(Boolean).join('\n');
      return `<div class="blk${cancelled ? ' cancelled' : ''}${live ? ' live' : ''}" style="top:${top}px;height:${hgt}px;left:calc(${it.lane}*100%/${it.n});width:calc(100%/${it.n} - 3px);--c:${esc(subjectColor(ev.title))}" title="${esc(tip)}"><b>${esc(ev.title)}</b>${hgt > 34 ? `<span>${fmtTime(ev.start)} – ${fmtTime(ev.end)}</span>` : ''}${hgt > 52 && ev.location ? `<span>${esc(ev.location)}</span>` : ''}</div>`;
    }).join('');

    const bandsData = getFixedBands(l, d);
    const bands = bandsData.map(b => {
      const a2 = Math.max(b.s, h0), b2 = Math.min(b.e, h1);
      const isLunch = b.label === 'Déjeuner';
      return b2 > a2 ? `<div class="${isLunch ? 'band lunch' : 'band pm'}" style="top:${y(a2)}px;height:${y(b2) - y(a2)}px">${b.label && y(b2) - y(a2) > 22 ? `<span>${b.label}</span>` : ''}</div>` : '';
    }).join('');

    const isToday = sameDay(d, now), nowMin = mm(now);
    const nl = isToday && nowMin >= h0 && nowMin <= h1 ? `<div class="nowline" style="top:${y(nowMin)}px"></div>` : '';
    return `<div class="dcol${isToday ? ' today' : ''}" style="height:${H}px">${bands}${blocks}${nl}</div>`;
  }).join('');

  const heads = days.map(({ d, l }) => {
    const chips = l.filter(e => e.allDay).map(e => `<em class="chip">${esc(e.title)}</em>`).join('');
    return `<div class="th${sameDay(d, now) ? ' today' : ''}">${esc(cap(d.toLocaleDateString('fr-FR', { weekday: 'long' })))} <span>${d.getDate()}</span>${chips}</div>`;
  }).join('');

  return `<div class="tgrid" style="--cols:${days.length};--hh:${HH}px"><div></div>${heads}<div class="times" style="height:${H}px">${hours}</div>${cols}</div>`;
}

function viewAgenda(){
  const f=d=>d.toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
  const mon=mondayOf(cursor),sun=addDays(mon,6);
  const thisWeek=sameDay(mon,mondayOf(new Date()));
  return `<h1>${esc(f(mon)+' – '+f(sun))}</h1>
  <p class="sub">${thisWeek?'Cette semaine':'Semaine du '+esc(mon.toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'}))}</p>
  <div class="tools">
    <div class="step"><button class="btn" data-act="prev" aria-label="Semaine précédente">‹</button><button class="btn" data-act="next" aria-label="Semaine suivante">›</button></div>
    <div class="step"><input type="date" id="agendaDate" value="${isoDay(cursor)}" aria-label="Choisir une date"><button class="btn" data-act="today"${thisWeek?' disabled':''}>Cette semaine</button></div>
  </div>
  ${timeGrid(mon)}`;
}

function viewHw(){
  const all=hwItems();
  const ctrls=evalItems().filter(e=>parseISO(e.due)>=startOfDay(new Date()));
  const hwList=(showDone?all:all.filter(h=>!h.done)).sort(byDue);
  const ctList=showDone?ctrls:ctrls.filter(c=>!c.done);
  const nHw=all.filter(h=>!h.done).length,nCt=ctrls.filter(c=>!c.done).length;
  const seg=[['all','Tout',nHw+nCt],['hw','Devoirs',nHw],['ctrl','Contrôles',nCt]].map(([k,l,n])=>`<button class="${hwFilter===k?'on':''}" data-act="hwfilter" data-v="${k}">${l} · ${n}</button>`).join('');
  const subjects=[...new Set(events.filter(e=>e.kind==='course').map(e=>e.title))].sort();
  const showHw=hwFilter!=='ctrl',showCt=hwFilter!=='hw';
  return `<h1>Devoirs et contrôles</h1>
  <form class="add" data-form="hw">
    <div class="row"><input name="title" placeholder="Nouveau devoir" required aria-label="Devoir">
    <input name="subject" list="subs" placeholder="Matière" aria-label="Matière"><datalist id="subs">${subjects.map(s=>`<option value="${esc(s)}">`).join('')}</datalist>
    <input name="due" type="date" required value="${isoDay(addDays(startOfDay(new Date()),1))}" aria-label="Pour le">
    <button class="btn primary">Ajouter</button></div>
  </form>
  <div class="tools"><div class="seg">${seg}</div><button class="quiet" data-act="toggledone">${showDone?'Masquer les devoirs faits':'Afficher les devoirs faits'}</button></div>
  ${showHw?`<h2>Devoirs par matière</h2>${groupedHomework(hwList)||`<p class="empty">${showDone?'Aucun devoir.':'Aucun devoir en attente.'}</p>`}`:''}
  ${showCt?`<h2>Contrôles et évaluations par matière</h2>${ctList.length?groupedControls(ctList):`<p class="empty">${showDone?'Aucun contrôle à venir.':'Aucun contrôle à venir. Ajoute le lien ICS des contrôles dans Réglages › Connexion › ENT.'}</p>`}`:''}
  <p class="foot">Les devoirs et les contrôles viennent de leurs liens ICS respectifs.</p>`;
}

function viewLyceeMail(){return `<div class="sub-header"><button class="btn" data-act="view" data-v="set">‹ Retour aux réglages</button></div><h1>Mail</h1><div class="panel"><p class="m">Les mails de l’ENT s’afficheront ici.</p></div>`;}
function viewLyceeActu(){return `<div class="sub-header"><button class="btn" data-act="view" data-v="set">‹ Retour aux réglages</button></div><h1>Actus</h1><div class="panel"><p class="m">Les actualités du lycée s’afficheront ici.</p></div>`;}
function viewLyceeCahier(){
  const today=isoDay(startOfDay(new Date()));
  const cahier=hwItems().filter(h=>h.due>=today).sort(byDue).slice(0,30);
  return `<div class="sub-header"><button class="btn" data-act="view" data-v="set">‹ Retour aux réglages</button></div><h1>Cahier de texte</h1>${list(cahier.map(hwRow).join(''),'Aucun devoir à venir dans le cahier de texte.')}`;
}
function viewLyceeProfil(){
  const created=user&&user.created_at?new Date(user.created_at).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'}):'';
  return `<div class="sub-header"><button class="btn" data-act="view" data-v="set">‹ Retour aux réglages</button></div><h1>Mon profil</h1><div class="panel"><p><span class="m">E-mail</span><br><strong>${esc(user?user.email:'')}</strong></p>${created?`<p><span class="m">Compte créé le</span><br><strong>${esc(created)}</strong></p>`:''}<p class="m">Ton nom, ta classe et ton établissement s’afficheront ici avec la connexion à l’ENT.</p></div>`;
}

function viewConnexionEnt(){
  const url=store.get('icsUrl',''),homeworkUrl=store.get('homeworkUrl',''),controlsUrl=store.get('controlsUrl','');
  return `<div class="sub-header"><button class="btn" data-act="view" data-v="set">‹ Retour aux réglages</button></div>
  <h1>ENT</h1>
  <form class="panel" data-form="url">
    <label class="fl" for="icsUrl">Lien ICS de l’emploi du temps</label>
    <div class="row"><input id="icsUrl" type="url" placeholder="https://... ou webcal://..." value="${esc(url)}" autocomplete="off"><button class="btn primary">Enregistrer et synchroniser</button></div>
    <p class="m">Ce lien sert uniquement aux cours et aux horaires de l’agenda.</p>
    <div class="row"><button type="button" class="btn" data-act="sync">Actualiser maintenant</button>
    <label class="btn" for="icsFile">Importer un fichier .ics</label><input id="icsFile" type="file" accept=".ics,text/calendar" hidden>
    <button type="button" class="btn" data-act="demo">Voir un exemple</button></div>
  </form>
  <form class="panel" data-form="feeds" style="margin-top:12px">
    <label class="fl" for="homeworkUrl">Lien ICS des devoirs</label>
    <div class="row"><input id="homeworkUrl" type="url" placeholder="Lien du calendrier des devoirs" value="${esc(homeworkUrl)}" autocomplete="off"></div>
    <label class="fl" for="controlsUrl">Lien ICS des contrôles et évaluations</label>
    <div class="row"><input id="controlsUrl" type="url" placeholder="Lien du calendrier des contrôles" value="${esc(controlsUrl)}" autocomplete="off"></div>
    <button class="btn primary">Enregistrer les liens et synchroniser</button>
  </form>
  <div class="panel" style="margin-top:12px">
    <p class="m"><a href="https://repere.84.235.226.127.sslip.io/agenda/" target="_blank" rel="noopener" class="lnk">Passerelle — Espace scolaire</a></p>
  </div>`;
}

// Vue Apparence fusionnée avec la sélection des couleurs par matière en bas
function viewConnexionApparence(){
  const themePref=store.get('themePreference',store.get('theme','system'));
  const subs=[...new Set(events.filter(e=>e.kind==='course').map(e=>e.title))].sort((a,b)=>a.localeCompare(b,'fr'));
  const pal=subs.length?subs.map(s=>{const c=colors[s]||hslHex(hue(s),55,document.documentElement.dataset.theme==='dark'?62:40);return `<div class="crow"><span class="cn">${esc(s)}</span>${colors[s]?`<button class="lnk" data-act="colorreset" data-k="${esc(s)}">Par défaut</button>`:''}<input type="color" value="${c}" data-color="${esc(s)}" aria-label="Couleur de ${esc(s)}"></div>`;}).join(''):'<p class="m">Charge ton emploi du temps pour choisir la couleur de chaque matière.</p>';
  
  return `<div class="sub-header"><button class="btn" data-act="view" data-v="set">‹ Retour aux réglages</button></div>
  <h1>Apparence</h1>
  <div class="panel">
    <div class="seg">${[['light','Clair'],['dark','Sombre'],['system','Système']].map(([k,l])=>`<button class="${themePref===k?'on':''}" data-act="themeset" data-v="${k}">${l}</button>`).join('')}</div>
    <p class="m">Le mode Système suit automatiquement le thème clair ou sombre de ton appareil.</p>
  </div>
  <h2>Couleur par matière</h2>
  <div class="panel">
    ${pal}
    <p class="m">La couleur sert dans l’emploi du temps et sur l’accueil.</p>
  </div>`;
}

function viewConnexionCompte(){
  return `<div class="sub-header"><button class="btn" data-act="view" data-v="set">‹ Retour aux réglages</button></div><h1>Compte</h1><div class="panel"><p>Connecté en tant que <strong>${esc(user?user.email:'')}</strong></p><p class="m">Tes devoirs, contrôles cochés et réglages sont enregistrés en ligne.</p><div class="row"><button class="btn" type="button" data-act="logout">Se déconnecter</button><button class="btn" type="button" data-act="wipe">Tout effacer</button><button class="btn danger" type="button" data-act="deleteaccount">Supprimer le compte</button></div></div>`;
}

function viewSet(){
  const n=store.get('notif',{on:false,min:10});
  const lyceeLinks=`<div class="panel" style="display:flex;flex-direction:column;gap:8px;"><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="lycee-mail">Mail</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="lycee-actu">Actus</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="lycee-cahier">Cahier de texte</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="lycee-profil">Mon profil</button></div>`;
  const connLinks=`<div class="panel" style="display:flex;flex-direction:column;gap:8px;"><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="connexion-ent">ENT</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="connexion-apparence">Apparence & Couleurs</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="connexion-compte">Compte</button></div>`;
  return `<h1>Réglages</h1><h2>Mon lycée</h2>${lyceeLinks}<h2>Connexion</h2>${connLinks}<h2>Notifications</h2><div class="panel"><div class="row"><label class="chk"><input type="checkbox" id="notifOn" ${n.on?'checked':''}> Rappel avant chaque cours</label><select id="notifMin" aria-label="Délai du rappel">${[5,10,15,30].map(x=>`<option value="${x}"${x===n.min?' selected':''}>${x} min avant</option>`).join('')}</select></div><p class="m">Fonctionne tant que cette page reste ouverte.</p></div>`;
}

function render(){
  const todo=todoItems().length;
  const navEl=$('#nav');
  if(navEl) navEl.innerHTML=VIEWS.map(([k,l,ic])=>`<button class="nv${k===view?' on':''}" data-act="view" data-v="${k}"${k===view?' aria-current="page"':''}>${svg(ic)}<span>${l}</span>${k==='hw'&&todo?`<i class="n">${todo}</i>`:''}</button>`).join('');
  const f={
    home:viewHome,agenda:viewAgenda,hw:viewHw,set:viewSet,
    'lycee-mail':viewLyceeMail,'lycee-actu':viewLyceeActu,'lycee-cahier':viewLyceeCahier,'lycee-profil':viewLyceeProfil,
    'connexion-ent':viewConnexionEnt,'connexion-apparence':viewConnexionApparence,'connexion-compte':viewConnexionCompte
  }[view]||viewHome;
  const mainEl=$('#main');
  if(mainEl) mainEl.innerHTML=f();
}

function demoICS(){
  const pad=n=>String(n).padStart(2,'0');
  const ymdOf=d=>d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate());
  const slots=[['0815','0910'],['0910','1005'],['1020','1115']];
  const plan=[
    [[0,'MATHEMATIQUES','B204'],[1,'NSI','Salle info 2'],[2,'PHYSIQUE-CHIMIE','C101']],
    [[0,'SCIENCES INGENIEUR','Labo SI'],[1,'MATHEMATIQUES','B204'],[2,'ANGLAIS','A12']],
    [[0,'NSI','Salle info 2'],[1,'HISTOIRE-GEOGRAPHIE','A07']],
    [[0,'PHYSIQUE-CHIMIE','C101'],[1,'SCIENCES INGENIEUR','Labo SI'],[2,'MATHEMATIQUES','B204']],
    [[0,'ANGLAIS','A12'],[1,'NSI','Salle info 2'],[2,'EPS','Gymnase']]
  ];
  const mon=mondayOf(new Date());
  const L=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Lapsus//Exemple//FR','X-WR-CALNAME:Exemple','X-WR-TIMEZONE:Europe/Paris'];
  let n=0;
  const add=(ymd,st,en,title,loc,desc,status)=>{
    L.push('BEGIN:VEVENT','UID:demo-'+(n++),'DTSTART;TZID=Europe/Paris:'+ymd+'T'+st+'00','DTEND;TZID=Europe/Paris:'+ymd+'T'+en+'00','SUMMARY:'+title);
    if(loc)L.push('LOCATION:'+loc);
    L.push('DESCRIPTION:'+(desc||'Exemple fictif'));
    if(status)L.push('STATUS:'+status);
    L.push('END:VEVENT');
  };
  for(let w=-1;w<=2;w++)for(let d=0;d<5;d++){
    const ymd=ymdOf(addDays(mon,w*7+d));
    for(const [s,title,room] of plan[d])add(ymd,slots[s][0],slots[s][1],title,room,'',(w===1&&d===3&&s===2)?'CANCELLED':'');
  }
  L.push('END:VCALENDAR');
  return L.join('\n');
}
function loadDemo(){
  const t=demoICS();
  loadICS(t);store.set('icsText',t);store.set('demo',true);
  setStatus('Exemple chargé');
  render();
}

async function wipeAll(){
  try{Object.keys(localStorage).filter(k=>NS&&k.startsWith(NS)).forEach(k=>localStorage.removeItem(k));}catch(x){}
  resetState();setStatus('Données effacées');render();
  if(user&&sb){
    await remote(sb.from('homework').delete().eq('user_id',user.id));
    await remote(sb.from('done_items').delete().eq('user_id',user.id));
    await remote(sb.from('settings').delete().eq('user_id',user.id));
  }
}

async function deleteAccountModal(){
  const confirmed = confirm("Êtes-vous sûr de vouloir supprimer définitivement votre compte et toutes vos données ? Cette action est irréversible.");
  if(!confirmed) return;
  try {
    showLoader('Suppression du compte...', 'Nettoyage des données.');
    if(user && sb){
      await sb.from('homework').delete().eq('user_id', user.id);
      await sb.from('done_items').delete().eq('user_id', user.id);
      await sb.from('settings').delete().eq('user_id', user.id);
    }
    wipeAll();
    leaveApp();
    alert('Votre compte a bien été supprimé.');
  } catch(err) {
    alert('Erreur lors de la suppression : ' + (err.message || err));
  } finally {
    hideLoader();
  }
}

let user=null;
const session=()=>user;
let sb=null;
try{sb=window.supabase.createClient(CONFIG.SUPABASE_URL,CONFIG.SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});}catch(e){console.error(e);}
const hasFeeds=()=>store.get('icsUrl','')||store.get('homeworkUrl','')||store.get('controlsUrl','');
async function remote(p){
  if(!user||!sb)return;
  try{const r=await p;if(r&&r.error)throw r.error;}
  catch(e){setStatus('Sauvegarde en ligne impossible : '+(e.message||e),true);}
}
function settingsRow(){
  return {user_id:user.id,ics_url:store.get('icsUrl',''),homework_url:store.get('homeworkUrl',''),controls_url:store.get('controlsUrl',''),
    theme:store.get('themePreference','system'),notif:store.get('notif',{on:false,min:10}),hw_words:words,subject_colors:colors,updated_at:new Date().toISOString()};
}
const pushSettings=()=>remote(user&&sb?sb.from('settings').upsert(settingsRow()):null);
const hwRowData=h=>({id:h.id,user_id:user.id,title:h.title,subject:h.subject||'',due:h.due,notes:h.notes||'',done:!!h.done});
const pushHwRow=h=>remote(user&&sb?sb.from('homework').upsert(hwRowData(h)):null);
const pushDone=(kind,id,on)=>remote(user&&sb?(on?sb.from('done_items').upsert({user_id:user.id,kind,item_id:id},{onConflict:'user_id,kind,item_id'}):sb.from('done_items').delete().eq('kind',kind).eq('item_id',id)):null);
function setTheme(p){
  store.set('themePreference',p);
  const dark=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme',dark?'dark':'light');
  pushSettings();
}

async function enterApp(){
  NS='u:'+user.id+':';
  loadState();
  applyAuth();
  const last=store.get('lastSync',0);
  if(last)setStatus('Dernière synchro : '+new Date(last).toLocaleString('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}));
  render();window.scrollTo(0,0);
  if(hasFeeds())refresh();
}
function leaveApp(){user=null;NS='';resetState();setStatus('');applyAuth();window.scrollTo(0,0);}
function frAuthError(err){
  const m=String((err&&err.message)||err||'');
  if(m==='NOACCOUNT')return 'Ce compte n’existe pas. Inscris-toi pour le créer.';
  if(m==='EXISTS')return 'Ce compte existe déjà. Utilise « Se connecter ».';
  if(m==='BADPASS')return 'Mot de passe incorrect.';
  if(m==='BADLOGIN'||/invalid login/i.test(m))return 'Adresse e-mail ou mot de passe incorrect.';
  if(/not confirmed/i.test(m))return 'Adresse e-mail pas encore confirmée : clique sur le lien reçu par e-mail.';
  if(/already registered|already exists/i.test(m))return 'Un compte existe déjà avec cette adresse. Utilise « Se connecter ».';
  return m||'Une erreur est survenue.';
}
function gateHTML(mode){
  const reg=mode==='register';
  return `<div class="gate-card">
    <div class="gate-brand"><img src="logo.svg" alt="" width="32" height="32"><span>Lapsus</span></div>
    <p class="sub">${reg?'Crée ton compte pour commencer.':'Content de te revoir.'}</p>
    <div class="seg"><button type="button" class="${reg?'':'on'}" data-act="authmode" data-v="login">Se connecter</button><button type="button" class="${reg?'on':''}" data-act="authmode" data-v="register">S’inscrire</button></div>
    <form data-form="auth" id="authForm">
      <input type="hidden" name="authmode" value="${reg?'register':'login'}">
      <label class="fl" for="authEmail">Adresse e-mail</label>
      <input id="authEmail" name="email" type="email" autocomplete="email" required placeholder="toi@exemple.fr">
      <label class="fl" for="authPassword">Mot de passe</label>
      <input id="authPassword" name="password" type="password" minlength="8" autocomplete="${reg?'new-password':'current-password'}" required placeholder="8 caractères minimum">
      <p class="m" id="authHelp">${reg?'Au moins 8 caractères.':'Saisis l’adresse e-mail et le mot de passe de ton compte.'}</p>
      <button class="btn primary" id="authSubmit">${reg?'S’inscrire':'Se connecter'}</button>
      <p class="m" id="authMessage" role="status"></p>
    </form>
  </div>`;
}
function applyAuth(){
  const locked=!session(),g=$('#gate');
  document.body.classList.toggle('locked',locked);
  document.querySelectorAll('.top,.shell').forEach(el=>{el.style.display=locked?'none':'';});
  if(!g)return;
  if(locked){g.hidden=false;g.innerHTML=gateHTML('login');}
  else{g.hidden=true;g.innerHTML='';}
}
function setAuthMode(mode){
  const form=$('#authForm');if(!form)return;
  const register=mode!=='login';
  form.elements.authmode.value=register?'register':'login';
  const submit=$('#authSubmit'),pass=$('#authPassword'),help=$('#authHelp');
  submit.textContent=register?'S’inscrire':'Se connecter';
  pass.autocomplete=register?'new-password':'current-password';
  help.textContent=register?'Au moins 8 caractères.':'Saisis l’adresse e-mail et le mot de passe de ton compte.';
  document.querySelectorAll('#gate [data-act="authmode"]').forEach(b=>b.classList.toggle('on',b.dataset.v===(register?'register':'login')));
  const sub=document.querySelector('#gate .sub');if(sub)sub.textContent=register?'Crée ton compte pour commencer.':'Content de te revoir.';
  const am=$('#authMessage');if(am){am.style.color='';am.textContent='';}
}

document.addEventListener('click',e=>{
  const t=e.target.closest('[data-act]');if(!t)return;
  const a=t.dataset.act,id=t.dataset.id;
  if(a==='view'){view=t.dataset.v;render();window.scrollTo(0,0);}
  else if(a==='prev'||a==='next'){cursor=addDays(cursor,(a==='next'?7:-7));render();}
  else if(a==='today'){cursor=startOfDay(new Date());render();}
  else if(a==='gotoweek'){cursor=startOfDay(new Date());view='agenda';render();window.scrollTo(0,0);}
  else if(a==='hwfilter'){hwFilter=t.dataset.v;render();}
  else if(a==='toggledone'){showDone=!showDone;render();}
  else if(a==='themeset'){setTheme(t.dataset.v);render();}
  else if(a==='colorreset'){delete colors[t.dataset.k];store.set('subjectColors',colors);pushSettings();render();}
  else if(a==='theme'){const p=store.get('themePreference',store.get('theme','system'));setTheme(p==='system'?'light':p==='light'?'dark':'system');}
  else if(a==='authmode'){setAuthMode(t.dataset.v);}
  else if(a==='logout'){leaveApp();if(sb)sb.auth.signOut().catch(()=>{});}
  else if(a==='deleteaccount'){deleteAccountModal();}
  else if(a==='sync'){withLoader('Synchronisation en cours…','Je récupère ton emploi du temps et tes devoirs.',refresh());}
  else if(a==='demo'){loadDemo();}
  else if(a==='hwtoggle'){
    const h=hwItems().find(x=>x.id===id);
    if(h){
      if(h.auto){if(autoDone[id])delete autoDone[id];else autoDone[id]=true;store.set('hwAutoDone',autoDone);pushDone('hw',id,!!autoDone[id]);}
      else{const m=hw.find(x=>x.id===id);if(m){m.done=!m.done;saveHw();pushHwRow(m);}}
      render();
    }
  }
  else if(a==='ctrltoggle'){
    if(ctrlDone[id])delete ctrlDone[id];else ctrlDone[id]=true;
    store.set('ctrlDone',ctrlDone);pushDone('ctrl',id,!!ctrlDone[id]);render();
  }
  else if(a==='hwdel'){hw=hw.filter(x=>x.id!==id);saveHw();remote(user&&sb?sb.from('homework').delete().eq('id',id):null);render();}
  else if(a==='wipe'){if(confirm("Confirmer : tout effacer ?"))wipeAll();}
});

document.addEventListener('submit',async e=>{
  const f=e.target.dataset.form;if(!f)return;
  e.preventDefault();
  if(f==='hw'){
    const fd=new FormData(e.target);
    const item={id:uid(),title:fd.get('title').trim(),subject:fd.get('subject').trim(),due:fd.get('due'),done:false};
    hw.push(item);saveHw();pushHwRow(item);render();
  }else if(f==='url'){
    store.set('icsUrl',$('#icsUrl').value.trim());
    pushSettings();await withLoader('Synchronisation en cours…','Je récupère ton emploi du temps.',refresh());
  }else if(f==='feeds'){
    store.set('homeworkUrl',$('#homeworkUrl').value.trim());
    store.set('controlsUrl',$('#controlsUrl').value.trim());
    pushSettings();await withLoader('Synchronisation en cours…','Je récupère tes devoirs et tes contrôles.',refresh());
  }else if(f==='auth'){
    const fd=new FormData(e.target),email=String(fd.get('email')||'').trim().toLowerCase(),password=String(fd.get('password')||''),mode=String(fd.get('authmode')||'register');
    const msg=$('#authMessage');
    try{
      if(!sb)throw new Error('Impossible de charger le service de comptes.');
      if(password.length<8)throw new Error('Le mot de passe doit contenir au moins 8 caractères.');
      let res;
      if(mode==='register'){
        res=await sb.auth.signUp({email,password});
        if(res.error)throw res.error;
      }else{
        res=await sb.auth.signInWithPassword({email,password});
        if(res.error)throw res.error;
      }
      user=res.data.session.user;
      await enterApp();
    }catch(err){if(msg)msg.textContent=frAuthError(err);}finally{hideLoader();}
  }
});

document.addEventListener('change',async e=>{
  const t=e.target;
  if(t.id==='icsFile'&&t.files[0]){
    try{
      const text=await t.files[0].text();
      loadICS(text);store.set('icsText',text);store.set('demo',false);
      render();
    }catch(err){setStatus(err.message,true);}
  }else if(t.id==='notifOn'){
    const cfg=store.get('notif',{on:false,min:10});
    if(t.checked&&typeof Notification!=='undefined')await Notification.requestPermission();
    cfg.on=t.checked;store.set('notif',cfg);pushSettings();
  }else if(t.id==='notifMin'){
    const cfg=store.get('notif',{on:false,min:10});cfg.min=+t.value;store.set('notif',cfg);pushSettings();
  }else if(t.id==='agendaDate'){
    if(t.value){cursor=parseISO(t.value);render();}
  }else if(t.dataset&&t.dataset.color!==undefined){
    colors[t.dataset.color]=t.value;store.set('subjectColors',colors);pushSettings();render();
  }
});

(async function boot(){
  try{
    try{localStorage.removeItem('lapsusSession');}catch(e){}
    if(sb){
      try{const r=await sb.auth.getSession();user=r.data&&r.data.session?r.data.session.user:null;}catch(e){user=null;}
    }
    showLoader('Chargement en cours…','Ton espace arrive.');
    if(user){try{await enterApp();}catch(e){console.error(e);}}
    else{applyAuth();}
  } catch(err) {
    console.error("Erreur critique au démarrage :", err);
  } finally {
    hideLoader();
  }
})();
