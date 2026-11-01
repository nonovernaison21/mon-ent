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
  key:'<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
  shield:'<path d="M12 3 5 6v5c0 4.5 2.9 8.2 7 10 4.1-1.8 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  warn:'<path d="M12 4 3 20h18z"/><path d="M12 10v4M12 17.5v.01"/>',
  trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  check:'<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  school:'<path d="M3 9.5 12 5l9 4.5-9 4.5z"/><path d="M7 12v4.2c0 1.2 2.2 2.3 5 2.3s5-1.1 5-2.3V12M21 9.5V15"/>',
  set:'<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'
};
const svg=(n,s)=>`<svg viewBox="0 0 24 24" width="${s||22}" height="${s||22}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

function reviveEvent(e){return Object.assign({},e,{start:new Date(e.start),end:new Date(e.end)});}

const VIEWS=[['home','Accueil','home'],['agenda','Agenda','cal'],['lycee','Mon lycée','school'],['set','Réglages','set']];
const DEFAULT_WORDS=['travail à faire','devoir à faire','devoir maison','devoirs','à faire','à rendre','à préparer','à apprendre','dm','homework'];
const EVAL_RE=/(^|[^a-z0-9])(devoir surveille|ds|dst|controle|interro|interrogation|evaluation|examen|bac blanc|partiel)([^a-z0-9]|$)/;

// Forçage de l'ouverture sur 'home' au démarrage, sans persister de vue 'réglages'
let view='home';
store.set('view','home');

let mode=store.get('mode','week');
let cursor=startOfDay(new Date());
let events=[];
let hwFeedEvents=[],evalFeedEvents=[],hw=[],autoDone={},ctrlDone={},ov={},words=DEFAULT_WORDS.slice(),colors={};
function resetState(){lyceePrefs=mergePrefs(null);mails=[];news=[];colors={};events=[];hwFeedEvents=[];evalFeedEvents=[];hw=[];autoDone={};ctrlDone={};ov={};words=DEFAULT_WORDS.slice();}
function loadState(){
  resetState();
  hwFeedEvents=store.get('hwFeedEvents',[]).map(reviveEvent);
  evalFeedEvents=store.get('evalFeedEvents',[]).map(reviveEvent);
  hw=store.get('homework',[]);autoDone=store.get('hwAutoDone',{});ctrlDone=store.get('ctrlDone',{});
  ov=store.get('overrides',{});words=store.get('hwWords',DEFAULT_WORDS.slice());colors=store.get('subjectColors',{});
  lyceePrefs=mergePrefs(store.get('lyceePrefs',null));mails=store.get('mails',[]);news=store.get('news',[]);
  const c=store.get('icsText','');if(c){try{loadICS(c);}catch(e){console.error(e);}}
  const ch=store.get('hwICStext','');
  if(ch){try{hwFeedEvents=parseICS(ch).events.sort((a,b)=>a.start-b.start);store.set('hwFeedEvents',hwFeedEvents);}catch(e){console.error(e);}}
  const ce=store.get('evalICStext','');
  if(ce){try{evalFeedEvents=parseICS(ce).events.sort((a,b)=>a.start-b.start);store.set('evalFeedEvents',evalFeedEvents);}catch(e){console.error(e);}}
}
let hwFilter='all',showDone=false;
// Préférences d'affichage de « Mon lycée » (enregistrées par compte dans Supabase : settings.lycee_prefs)
const LYCEE_DEFAULTS={
  mail:{count:3,preview:true,sort:'recent',unread:false},
  news:{count:3,images:true,sort:'recent'},
  hw:{count:5,sort:'asc',showDone:false,hidden:[]},
  profile:{name:'',klass:'',school:'',start:'home'}
};
const mergePrefs=p=>{const o=JSON.parse(JSON.stringify(LYCEE_DEFAULTS));for(const s in o)if(p&&p[s]&&typeof p[s]==='object')for(const k in o[s])if(p[s][k]!==undefined&&typeof p[s][k]===typeof o[s][k])o[s][k]=p[s][k];return o;};
let lyceePrefs=mergePrefs(null),mails=[],news=[];
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

// L'écran de chargement reste au moins LOADER_MIN ms (assez pour voir l'animation) ; s'il faut plus, il reste jusqu'à la fin.
const LOADER_MIN=4000;
let loaderSince=Date.now(),loaderTimer=null;
function showLoader(t,s){
  const l=$('#loader');if(!l)return;
  const a=$('#loaderTitle'),b=$('#loaderSub');
  if(a)a.textContent=t||'Chargement en cours…';if(b)b.textContent=s||'';
  if(loaderTimer){clearTimeout(loaderTimer);loaderTimer=null;}
  if(l.hidden)loaderSince=Date.now();
  l.hidden=false;
}
// force=true : on masque tout de suite (par exemple après une erreur de connexion)
function hideLoader(force){
  const l=$('#loader');if(!l)return;
  if(loaderTimer){clearTimeout(loaderTimer);loaderTimer=null;}
  const wait=force?0:Math.max(0,LOADER_MIN-(Date.now()-loaderSince));
  if(wait<=0){l.hidden=true;return;}
  loaderTimer=setTimeout(()=>{l.hidden=true;loaderTimer=null;},wait);
}
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

let profileBannerOff=false;
function profileBanner(){
  const p=lyceePrefs.profile;
  if(profileBannerOff)return '';
  const miss=[];
  if(!p.name)miss.push('ton prénom');if(!p.klass)miss.push('ta classe');if(!p.school)miss.push('le nom de ton lycée');
  if(!miss.length)return '';
  const txt=miss.length===1?miss[0]:miss.slice(0,-1).join(', ')+' et '+miss[miss.length-1];
  return `<div class="pbanner"><div class="pbi">${svg('school',22)}</div><div class="pbt"><strong>Complète ton profil</strong><span>Ajoute ${esc(txt)} pour personnaliser Lapsus.</span></div><button class="btn primary" data-act="view" data-v="lycee-profil">Compléter</button><button class="lnk2 pbx" data-act="pbdismiss" aria-label="Masquer pour l’instant" title="Masquer pour l’instant">×</button></div>`;
}
function viewHome(){
  if(!events.length&&!hw.length)return `<h1>Bienvenue</h1>
    <p class="sub">Aucun calendrier chargé pour l'instant.</p>${profileBanner()}
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
  <p class="sub">${lyceePrefs.profile.name?esc('Bonjour '+lyceePrefs.profile.name+' · '):''}${esc(resume)}${store.get('demo',false)?' · exemple fictif':''}</p>
  ${profileBanner()}
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

// ---------- Grille horaire déduite de l'emploi du temps ----------
const pad2=n=>String(n).padStart(2,'0');
const minLabel=m=>Math.floor(m/60)+'h'+pad2(m%60);
const mergeSpans=a=>{a=a.slice().sort((x,y)=>x[0]-y[0]);const r=[];for(const [s,e] of a){if(r.length&&s<=r[r.length-1][1])r[r.length-1][1]=Math.max(r[r.length-1][1],e);else r.push([s,e]);}return r;};
// Pause du midi d'une journée : la plus longue plage libre entre 11 h et 14 h 30
function lunchOf(spans){
  const W0=11*60,W1=14*60+30;
  let free=[],cur=W0;
  for(const [s,e] of spans){if(e<=W0)continue;if(s>=W1)break;if(s>cur)free.push([cur,Math.min(s,W1)]);cur=Math.max(cur,e);}
  if(cur<W1)free.push([cur,W1]);
  free=free.filter(f=>f[1]-f[0]>=30).sort((x,y)=>(y[1]-y[0])-(x[1]-x[0]));
  if(!free.length)return null;
  let [a,b]=free[0];
  if(b-a>90){const st=Math.max(a,Math.min(Math.max(a,12*60),b-75));a=st;b=st+75;}
  return [a,b];
}
// Lit TOUT l'emploi du temps chargé : horaires de début et de fin qui reviennent, récréations, pause du midi habituelle
function scheduleModel(){
  const mm=d=>d.getHours()*60+d.getMinutes();
  const cs=events.filter(e=>e.kind==='course'&&!e.allDay&&e.status!=='CANCELLED'&&isoDay(e.start)===isoDay(e.end)&&mm(e.end)>mm(e.start));
  const sC={},eC={},byDay={};
  for(const e of cs){
    const s=mm(e.start),en=mm(e.end);
    sC[s]=(sC[s]||0)+1;eC[en]=(eC[en]||0)+1;
    (byDay[isoDay(e.start)]=byDay[isoDay(e.start)]||[]).push([s,en]);
  }
  const n=cs.length;
  if(!n){const marks=[];for(let h=8;h<=17;h++)marks.push(h*60);return {marks,lo:8*60,hi:17*60,breaks:[],defLunch:[12*60,13*60]};}
  const thr=n<12?1:Math.max(2,Math.round(n*0.03));
  const set=new Set();
  for(const k in sC)if(sC[k]>=thr)set.add(+k);
  for(const k in eC)if(eC[k]>=thr)set.add(+k);
  const marks=[...set].sort((a,b)=>a-b);
  const days=Object.keys(byDay),gapC={},lunches=[];
  for(const k of days){
    const m=mergeSpans(byDay[k]);
    for(let i=1;i<m.length;i++){const a=m[i-1][1],b=m[i][0],len=b-a;if(len>=5&&len<=30){const key=a+'-'+b;gapC[key]=(gapC[key]||0)+1;}}
    const lu=lunchOf(m);if(lu)lunches.push(lu);
  }
  const need=Math.max(2,Math.ceil(days.length*0.3));
  const breaks=Object.keys(gapC).filter(k=>gapC[k]>=need).map(k=>k.split('-').map(Number));
  let defLunch=[12*60,13*60];
  if(lunches.length){const ss=lunches.map(x=>x[0]).sort((a,b)=>a-b),ee=lunches.map(x=>x[1]).sort((a,b)=>a-b);const mid=Math.floor(lunches.length/2);defLunch=[ss[mid],ee[mid]];}
  return {marks,lo:marks[0],hi:marks[marks.length-1],breaks,defLunch};
}

const isMobileView=()=>window.innerWidth<=760;
function timeGrid(mon) {
  const now = new Date();
  const isMobile = isMobileView();
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
  const M = scheduleModel();
  let h0 = M.lo, h1 = M.hi;
  // un cours hors des horaires habituels agrandit la grille (rien n'est jamais coupé)
  days.forEach(({ d, l }) => l.filter(e => !e.allDay && isoDay(e.start) === isoDay(e.end)).forEach(e => {
    h0 = Math.min(h0, mm(e.start)); h1 = Math.max(h1, mm(e.end));
  }));
  const HH = 60, H = (h1 - h0) * HH / 60;
  const y = min => (min - h0) * HH / 60;

  const labelSet = [...new Set(M.marks.concat([h0, h1]))].filter(m => m >= h0 && m <= h1).sort((a, b) => a - b);
  const labels = [];
  for (const m of labelSet) if (!labels.length || m - labels[labels.length - 1] >= 14) labels.push(m);
  const hours = labels.map(m => `<i style="top:${y(m)}px">${minLabel(m)}</i>`).join('');

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
      return `<div class="blk${cancelled ? ' cancelled' : ''}${live ? ' live' : ''}" style="top:${top}px;height:${hgt}px;left:calc(${it.lane}*100%/${it.n});width:calc(100%/${it.n} - 3px);--c:${esc(subjectColor(ev.title))}" title="${esc(tip)}"><b>${esc(ev.title)}</b>${hgt > 34 ? `<span>${fmtTime(ev.start)} – ${fmtTime(ev.end)}</span>` : ''}${hgt > 52 && ev.location ? `<span>${esc(ev.location)}</span>` : ''}${cancelled && hgt > 34 ? '<em>Annulé</em>' : ''}</div>`;
    }).join('');

    // récréations habituelles de l'emploi du temps + pause du midi de CETTE journée
    const spans = mergeSpans(l.filter(e => !e.allDay && e.status !== 'CANCELLED' && isoDay(e.start) === isoDay(e.end)).map(e => [mm(e.start), mm(e.end)]));
    const lu = spans.length ? lunchOf(spans) : M.defLunch;
    const bandsData = M.breaks.map(([s, e]) => ({ s, e, label: '' })).concat(lu ? [{ s: lu[0], e: lu[1], label: 'Déjeuner' }] : []);
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
  const mob=isMobileView();
  const thisWeek=sameDay(mon,mondayOf(new Date()));
  const isToday=sameDay(cursor,new Date());
  const title=mob?cap(cursor.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})):f(mon)+' – '+f(sun);
  const sub=mob?(isToday?'Aujourd’hui':cursor.getFullYear()+' · semaine du '+f(mon)):(thisWeek?'Cette semaine':'Semaine du '+mon.toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'}));
  const here=mob?isToday:thisWeek;
  return `<h1>${esc(title)}</h1>
  <p class="sub">${esc(sub)}</p>
  <div class="tools">
    <div class="step"><button class="btn" data-act="prev" aria-label="${mob?'Jour précédent':'Semaine précédente'}">‹</button><button class="btn" data-act="next" aria-label="${mob?'Jour suivant':'Semaine suivante'}">›</button></div>
    <div class="step"><input type="date" id="agendaDate" value="${isoDay(cursor)}" aria-label="Choisir une date"><button class="btn" data-act="today"${here?' disabled':''}>${mob?'Aujourd’hui':'Cette semaine'}</button></div>
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


// ---------- Mon lycée : aperçus ----------
const safeImg=u=>/^(https:\/\/|data:image\/)/.test(u||'')?u:'';
function fmtMailDate(ts){
  const d=new Date(ts),now=new Date();
  if(sameDay(d,now))return fmtTime(d);
  if(sameDay(d,addDays(now,-1)))return 'Hier';
  return d.toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
}
function shownHw(){
  const P=lyceePrefs.hw,today=isoDay(startOfDay(new Date()));
  const items=hwItems().filter(h=>h.due>=today&&(P.showDone||!h.done)&&!P.hidden.includes(h.subject||''));
  items.sort(P.sort==='desc'?(a,b)=>byDue(b,a):byDue);
  return items;
}
function shownMails(){
  const P=lyceePrefs.mail;
  const ms=mails.filter(m=>!P.unread||!m.read);
  ms.sort(P.sort==='old'?(a,b)=>a.at-b.at:(a,b)=>b.at-a.at);
  return ms;
}
function shownNews(){
  const P=lyceePrefs.news;
  const ns=news.slice();
  ns.sort(P.sort==='old'?(a,b)=>a.at-b.at:(a,b)=>b.at-a.at);
  return ns;
}
function mailRow(m,full){
  const P=lyceePrefs.mail;
  const head=`<div class="mh"><span class="mf">${esc(m.from)}</span><span class="md">${esc(fmtMailDate(m.at))}</span></div><div class="ms">${esc(m.subject)}</div>${P.preview&&m.preview?`<div class="mp">${esc(m.preview)}</div>`:''}`;
  if(!full)return `<div class="mail${m.read?'':' unread'}">${head}</div>`;
  return `<details class="mail${m.read?'':' unread'}"><summary>${head}</summary>${m.body?`<div class="mbody">${esc(m.body)}</div>`:''}</details>`;
}
function newsRow(n,full){
  const P=lyceePrefs.news,img=P.images?safeImg(n.image):'';
  return `<article class="news${img?'':' noimg'}${full?' full':''}">${img?`<img src="${esc(img)}" alt="" loading="lazy">`:''}<div><h3 class="nt">${esc(n.title)}</h3><p class="nd">${esc(cap(new Date(n.at).toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})))}</p>${n.summary?`<p class="ns">${esc(n.summary)}</p>`:''}</div></article>`;
}
function viewLycee(){
  const P=lyceePrefs,pf=P.profile;
  const hws=shownHw().slice(0,P.hw.count),ms=shownMails().slice(0,P.mail.count),ns=shownNews().slice(0,P.news.count);
  const info=[pf.klass,pf.school].filter(Boolean).join(' · ');
  return `<h1>Mon lycée</h1>
  <p class="sub">${esc(info||'Tes devoirs, tes mails et les actualités de ton lycée.')}</p>
  ${secHead('Devoirs')}
  ${list(hws.map(hwRow).join(''),'Aucun devoir à venir.')}
  <button class="btn more" data-act="view" data-v="hw">Afficher tous les devoirs</button>
  ${secHead('Mails')}
  ${list(ms.map(m=>mailRow(m,false)).join(''),P.mail.unread&&mails.length?'Aucun mail non lu.':'Aucun mail pour l’instant. Ils arriveront ici avec la connexion à l’ENT.')}
  <button class="btn more" data-act="view" data-v="mails">Afficher tous les mails</button>
  ${secHead('Actualités')}
  ${list(ns.map(n=>newsRow(n,false)).join(''),'Aucune actualité pour l’instant. Elles arriveront ici avec la connexion à l’ENT.')}
  <button class="btn more" data-act="view" data-v="news">Afficher toutes les actualités</button>`;
}
function viewMails(){
  const ms=shownMails();
  return `<div class="sub-header"><button class="btn" data-act="view" data-v="lycee">‹ Retour à Mon lycée</button></div><h1>Mails</h1>
  <p class="sub">${mails.length?`${ms.length} mail${ms.length>1?'s':''}${lyceePrefs.mail.unread?' non lus':''}`:'Tes mails de l’ENT.'}</p>
  ${list(ms.map(m=>mailRow(m,true)).join(''),lyceePrefs.mail.unread&&mails.length?'Aucun mail non lu.':'Aucun mail pour l’instant. Ils arriveront ici avec la connexion à l’ENT.')}
  <p class="foot">Affichage réglable dans Réglages › Mon lycée › Mails.</p>`;
}
function viewNews(){
  const ns=shownNews();
  return `<div class="sub-header"><button class="btn" data-act="view" data-v="lycee">‹ Retour à Mon lycée</button></div><h1>Actualités</h1>
  <p class="sub">${news.length?`${ns.length} actualité${ns.length>1?'s':''}`:'Les actualités de ton lycée.'}</p>
  ${list(ns.map(n=>newsRow(n,true)).join(''),'Aucune actualité pour l’instant. Elles arriveront ici avec la connexion à l’ENT.')}
  <p class="foot">Affichage réglable dans Réglages › Mon lycée › Actualités.</p>`;
}

// ---------- Réglages de Mon lycée ----------
function setPref(path,v){
  const [s,k]=path.split('.');
  if(!lyceePrefs[s]||!(k in lyceePrefs[s]))return;
  lyceePrefs[s][k]=v;
  store.set('lyceePrefs',lyceePrefs);pushSettings();render();
}
const prefSeg=(path,cur,opts,num)=>`<div class="seg">${opts.map(([v,l])=>`<button type="button" class="${String(cur)===String(v)?'on':''}" data-act="lpset" data-p="${path}" data-v="${v}"${num?' data-n="1"':''}>${l}</button>`).join('')}</div>`;
const prefChk=(path,on,label)=>`<label class="chk lpchk"><input type="checkbox" data-lpbool="${path}" ${on?'checked':''}> ${label}</label>`;
const backSet='<div class="sub-header"><button class="btn" data-act="view" data-v="set">‹ Retour aux réglages</button></div>';
function viewLyceeMail(){
  const P=lyceePrefs.mail;
  return `${backSet}<h1>Mails</h1>
  <div class="panel">
    <div class="lprow"><label class="fl">Nombre de mails dans l’aperçu</label>${prefSeg('mail.count',P.count,[[3,'3'],[5,'5'],[10,'10']],true)}</div>
    <div class="lprow"><label class="fl">Tri</label>${prefSeg('mail.sort',P.sort,[['recent','Plus récents'],['old','Plus anciens']])}</div>
    <div class="lprow">${prefChk('mail.preview',P.preview,'Afficher un aperçu du contenu')}</div>
    <div class="lprow">${prefChk('mail.unread',P.unread,'Afficher seulement les mails non lus')}</div>
    <p class="m">Le nombre concerne l’aperçu de Mon lycée. Le tri, l’aperçu et le filtre s’appliquent aussi à la page « Tous les mails ».</p>
  </div>`;
}
function viewLyceeActu(){
  const P=lyceePrefs.news;
  return `${backSet}<h1>Actualités</h1>
  <div class="panel">
    <div class="lprow"><label class="fl">Nombre d’actualités dans l’aperçu</label>${prefSeg('news.count',P.count,[[3,'3'],[5,'5'],[10,'10']],true)}</div>
    <div class="lprow"><label class="fl">Tri</label>${prefSeg('news.sort',P.sort,[['recent','Plus récentes'],['old','Plus anciennes']])}</div>
    <div class="lprow">${prefChk('news.images',P.images,'Afficher les images')}</div>
    <p class="m">Le nombre concerne l’aperçu de Mon lycée. Le tri et les images s’appliquent aussi à la page « Toutes les actualités ».</p>
  </div>`;
}
function viewLyceeCahier(){
  const P=lyceePrefs.hw;
  const subs=[...new Set(hwItems().map(h=>h.subject).filter(Boolean).concat(events.filter(e=>e.kind==='course').map(e=>e.title)))].sort((a,b)=>a.localeCompare(b,'fr'));
  return `${backSet}<h1>Cahier de textes</h1>
  <div class="panel">
    <div class="lprow"><label class="fl">Nombre de devoirs dans l’aperçu</label>${prefSeg('hw.count',P.count,[[3,'3'],[5,'5'],[10,'10'],[15,'15']],true)}</div>
    <div class="lprow"><label class="fl">Tri par date</label>${prefSeg('hw.sort',P.sort,[['asc','Les plus proches'],['desc','Les plus lointains']])}</div>
    <div class="lprow">${prefChk('hw.showDone',P.showDone,'Afficher les devoirs terminés')}</div>
    <p class="m">Ces réglages s’appliquent à l’aperçu des devoirs dans Mon lycée. La page « Tous les devoirs » reste complète.</p>
  </div>
  <h2>Matières affichées</h2>
  <div class="panel">${subs.length?subs.map(s=>`<div class="lprow">${`<label class="chk lpchk"><input type="checkbox" data-lpsub="${esc(s)}" ${P.hidden.includes(s)?'':'checked'}> ${esc(s)}</label>`}</div>`).join(''):'<p class="m">Charge ton emploi du temps ou tes devoirs pour choisir les matières à afficher.</p>'}</div>`;
}
function viewLyceeProfil(){
  const P=lyceePrefs.profile;
  const created=user&&user.created_at?new Date(user.created_at).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'}):'';
  return `${backSet}<h1>Mon profil</h1>
  <div class="panel">
    <p><span class="m">E-mail</span><br><strong>${esc(user?user.email:'')}</strong></p>${created?`<p><span class="m">Compte créé le</span><br><strong>${esc(created)}</strong></p>`:''}
    <div class="lprow"><label class="fl" for="pfName">Prénom</label><input id="pfName" data-lptext="profile.name" value="${esc(P.name)}" maxlength="40" autocomplete="given-name" placeholder="Comment t’appeler ?"></div>
    <div class="lprow"><label class="fl" for="pfClass">Classe</label><input id="pfClass" data-lptext="profile.klass" value="${esc(P.klass)}" maxlength="40" placeholder="Ex. Terminale 3">
    </div>
    <div class="lprow"><label class="fl" for="pfSchool">Établissement</label><input id="pfSchool" data-lptext="profile.school" value="${esc(P.school)}" maxlength="60" placeholder="Nom de ton lycée"></div>
    <div class="lprow"><label class="fl">Page d’ouverture</label>${prefSeg('profile.start',P.start,[['home','Accueil'],['agenda','Agenda'],['lycee','Mon lycée']])}</div>
    <p class="m">Ton prénom s’affiche sur l’accueil, ta classe et ton établissement sous « Mon lycée ». La page d’ouverture est celle qui s’affiche à ta connexion. Tout est enregistré sur ton compte.</p>
  </div>`;
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

let secData={passkeys:null,pkErr:''};
async function loadSecurity(){
  if(!user||!sb)return;
  try{
    if(sb.auth.passkey&&typeof sb.auth.passkey.list==='function'){
      const r=await sb.auth.passkey.list();
      secData.passkeys=r.error?null:(r.data||[]);secData.pkErr=r.error?frAuthError(r.error):'';
    }
  }catch(e){secData.pkErr=frAuthError(e);}
  if(view==='connexion-compte')render();
}
async function addPasskey(){
  if(!passkeyOK())return infoModal('warn','Pas disponible','Les clés d’accès ne sont pas disponibles sur cet appareil ou ce navigateur.',true);
  try{
    const r=await sb.auth.registerPasskey();
    if(r.error)throw r.error;
    await loadSecurity();
    infoModal('check','Clé d’accès ajoutée','Tu peux maintenant te connecter avec Face ID, Touch ID ou le code de cet appareil.');
  }catch(err){
    const m=frAuthError(err);
    if(m!=='Opération annulée.')infoModal('warn','Ajout impossible',m,true);
  }
}
async function deletePasskey(id){
  try{
    const r=await sb.auth.passkey.delete({passkeyId:id});
    if(r&&r.error)throw r.error;
    await loadSecurity();
  }catch(err){infoModal('warn','Suppression impossible',frAuthError(err),true);}
}
function viewConnexionCompte(){
  const rowM=(ic,name,status,btn)=>`<div class="mx"><span class="mxi">${ic}</span><div class="mxt"><div class="mxn">${name}</div><div class="m">${status}</div></div>${btn||''}</div>`;
  const pks=secData.passkeys;
  const fmt=d=>d?new Date(d).toLocaleDateString('fr-FR',{day:'numeric',month:'short',year:'numeric'}):'';
  const pkRows=Array.isArray(pks)&&pks.length?pks.map(k=>rowM(svg('key',20),esc(k.friendly_name||'Clé d’accès'),esc('Ajoutée le '+fmt(k.created_at)+(k.last_used_at?' · utilisée le '+fmt(k.last_used_at):'')),`<button class="btn danger" type="button" data-act="pkdel" data-id="${esc(k.id)}">Supprimer</button>`)).join(''):`<p class="m">${esc(secData.pkErr||(passkeyOK()?'Aucune clé d’accès pour l’instant. Ajoutes-en une pour te connecter avec Face ID, Touch ID ou le code de ton appareil.':'Les clés d’accès ne sont pas disponibles sur cet appareil ou ce navigateur.'))}</p>`;
  return `<div class="sub-header"><button class="btn" data-act="view" data-v="set">‹ Retour aux réglages</button></div><h1>Compte</h1>
  <div class="panel"><p>Connecté en tant que <strong>${esc(user?user.email:'')}</strong></p><p class="m">Tes devoirs, contrôles cochés et réglages sont enregistrés en ligne.</p><div class="row"><button class="btn" type="button" data-act="logout">Se déconnecter</button></div></div>
  <h2>Clés d’accès</h2>
  <div class="panel">${pkRows}${passkeyOK()?'<div class="row" style="margin-top:10px"><button class="btn primary" type="button" data-act="pkadd">Ajouter une clé d’accès</button></div>':''}</div>
  <h2>Conditions d’utilisation</h2><div class="panel"><p class="m">Les règles d’utilisation de Lapsus et la façon dont tes données sont traitées.</p><a class="btn" href="conditions.html" target="_blank" rel="noopener">Lire les conditions d’utilisation</a></div>
  <h2>Zone sensible</h2><div class="panel"><div class="row"><button class="btn" type="button" data-act="wipe">Tout effacer</button><button class="btn danger" type="button" data-act="deleteaccount">Supprimer le compte</button></div><p class="m">« Tout effacer » supprime tes données mais garde ton compte. « Supprimer le compte » supprime aussi ton compte de connexion. Ces actions sont définitives.</p></div>`;
}

function viewSet(){
  const n=store.get('notif',{on:false,min:10});
  const lyceeLinks=`<div class="panel" style="display:flex;flex-direction:column;gap:8px;"><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="lycee-mail">Mails</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="lycee-actu">Actualités</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="lycee-cahier">Cahier de textes</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="lycee-profil">Mon profil</button></div>`;
  const connLinks=`<div class="panel" style="display:flex;flex-direction:column;gap:8px;"><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="connexion-ent">ENT</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="connexion-apparence">Apparence & Couleurs</button><button class="btn" style="text-align:left;width:100%;" data-act="view" data-v="connexion-compte">Compte</button></div>`;
  return `<h1>Réglages</h1><h2>Mon lycée</h2>${lyceeLinks}<h2>Sécurité &amp; connexion</h2>${connLinks}<h2>Notifications</h2><div class="panel"><div class="row"><label class="chk"><input type="checkbox" id="notifOn" ${n.on?'checked':''}> Rappel avant chaque cours</label><select id="notifMin" aria-label="Délai du rappel">${[5,10,15,30].map(x=>`<option value="${x}"${x===n.min?' selected':''}>${x} min avant</option>`).join('')}</select></div><p class="m">Fonctionne tant que cette page reste ouverte.</p></div>`;
}

function render(){
  const todo=todoItems().length;
  const navEl=$('#nav');
  const navKey=['hw','mails','news'].includes(view)?'lycee':view;
  if(navEl) navEl.innerHTML=VIEWS.map(([k,l,ic])=>`<button class="nv${k===navKey?' on':''}" data-act="view" data-v="${k}"${k===navKey?' aria-current="page"':''}>${svg(ic)}<span>${l}</span>${k==='lycee'&&todo?`<i class="n">${todo}</i>`:''}</button>`).join('');
  const f={
    home:viewHome,agenda:viewAgenda,lycee:viewLycee,mails:viewMails,news:viewNews,hw:viewHw,set:viewSet,
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
function demoMails(){
  const now=Date.now(),h=3600e3;
  return [
    {id:'dm1',from:'Vie scolaire',subject:'Cours de jeudi déplacé',preview:'Le cours de mathématiques de jeudi est déplacé à 10h20 en salle B2. Merci de prévenir tes camarades.',body:'Bonjour,\n\nLe cours de mathématiques de jeudi est déplacé à 10h20 en salle B2.\nMerci de prévenir tes camarades.\n\nLa vie scolaire',at:now-2*h,read:false},
    {id:'dm2',from:'Secrétariat',subject:'Inscription aux examens blancs',preview:'Les inscriptions aux examens blancs sont ouvertes jusqu’à vendredi. Pense à rendre le coupon signé.',body:'Bonjour,\n\nLes inscriptions aux examens blancs sont ouvertes jusqu’à vendredi.\nPense à rendre le coupon signé à la vie scolaire.\n\nLe secrétariat',at:now-26*h,read:false},
    {id:'dm3',from:'CDI',subject:'Nouveaux ouvrages disponibles',preview:'De nouveaux romans et documentaires sont arrivés au CDI, viens les découvrir sur les horaires d’ouverture.',body:'Bonjour,\n\nDe nouveaux romans et documentaires sont arrivés au CDI.\nViens les découvrir pendant les horaires d’ouverture.\n\nLes documentalistes',at:now-3*24*h,read:true},
    {id:'dm4',from:'Professeur principal',subject:'Réunion parents-professeurs',preview:'La réunion parents-professeurs aura lieu mardi prochain à 17h30. Les invitations sont distribuées cette semaine.',body:'Bonjour,\n\nLa réunion parents-professeurs aura lieu mardi prochain à 17h30.\nLes invitations sont distribuées cette semaine.\n\nCordialement',at:now-5*24*h,read:true}
  ];
}
function demoNews(){
  const now=Date.now(),day=24*3600e3;
  const img=(a,b)=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="208" height="156"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="208" height="156" fill="url(#g)"/></svg>`);
  return [
    {id:'dn1',title:'Journée portes ouvertes du lycée',summary:'Le lycée ouvre ses portes samedi : visites des laboratoires, ateliers des élèves et rencontres avec les équipes pédagogiques.',image:img('#0b7a75','#3cc4bb'),at:now-1*day},
    {id:'dn2',title:'Tournoi inter-classes de volley',summary:'Les inscriptions pour le tournoi de volley sont ouvertes. Les matchs auront lieu pendant la pause du midi, au gymnase.',image:img('#ffc24d','#ff8a4d'),at:now-3*day},
    {id:'dn3',title:'Semaine de la science',summary:'Expériences, conférences et ateliers : toute la semaine, les classes présentent leurs projets scientifiques au CDI.',image:img('#3b6fd4','#7aa2f7'),at:now-6*day},
    {id:'dn4',title:'Nouveau menu de la cantine',summary:'Le menu change : davantage de produits locaux et une option végétarienne chaque jour.',image:'',at:now-8*day}
  ];
}
function loadDemo(){
  const t=demoICS();
  mails=demoMails();news=demoNews();store.set('mails',mails);store.set('news',news);
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
    await remote(sb.from('school_mails').delete().eq('user_id',user.id));
    await remote(sb.from('school_news').delete().eq('user_id',user.id));
    await remote(sb.from('settings').delete().eq('user_id',user.id));
  }
}

async function deleteAccountModal(){
  try {
    showLoader('Suppression du compte…', 'Nettoyage des données.');
    if(user && sb){
      await sb.from('homework').delete().eq('user_id', user.id);
      await sb.from('done_items').delete().eq('user_id', user.id);
      await sb.from('settings').delete().eq('user_id', user.id);
      // supprime aussi le compte de connexion (fonction SQL delete_my_account)
      try{await sb.rpc('delete_my_account');}catch(e){}
      try{await sb.auth.signOut();}catch(e){}
    }
    try{Object.keys(localStorage).filter(k=>NS&&k.startsWith(NS)).forEach(k=>localStorage.removeItem(k));}catch(x){}
    leaveApp();
    infoModal('check','Compte supprimé','Ton compte et toutes tes données ont bien été supprimés.');
  } catch(err) {
    infoModal('warn','Suppression impossible','Une erreur est survenue : '+(err.message||err),true);
  } finally {
    hideLoader();
  }
}

// Lien de réinitialisation / de confirmation reçu par e-mail : on lit l'adresse AVANT que Supabase ne la nettoie
const URL_HASH0=location.hash||'',URL_QS0=location.search||'';
let recoveryPending=/type=recovery/.test(URL_HASH0+URL_QS0);
const linkError=(/error_code=([a-z_]+)/.exec(URL_HASH0+URL_QS0)||[])[1]||'';
let user=null;
const session=()=>user;
let sb=null;
try{sb=window.supabase.createClient(CONFIG.SUPABASE_URL,CONFIG.SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,experimental:{passkey:true}}});}catch(e){console.error(e);}
const hasFeeds=()=>store.get('icsUrl','')||store.get('homeworkUrl','')||store.get('controlsUrl','');
async function remote(p){
  if(!user||!sb)return;
  try{const r=await p;if(r&&r.error)throw r.error;}
  catch(e){setStatus('Sauvegarde en ligne impossible : '+(e.message||e),true);}
}
function settingsRow(){
  return {user_id:user.id,ics_url:store.get('icsUrl',''),homework_url:store.get('homeworkUrl',''),controls_url:store.get('controlsUrl',''),
    theme:store.get('themePreference','system'),notif:store.get('notif',{on:false,min:10}),hw_words:words,subject_colors:colors,lycee_prefs:lyceePrefs,updated_at:new Date().toISOString()};
}
const pushSettings=()=>remote(user&&sb?sb.from('settings').upsert(settingsRow()):null);
const hwRowData=h=>({id:h.id,user_id:user.id,title:h.title,subject:h.subject||'',due:h.due,notes:h.notes||'',done:!!h.done});
const pushHwRow=h=>remote(user&&sb?sb.from('homework').upsert(hwRowData(h)):null);
const pushDone=(kind,id,on)=>remote(user&&sb?(on?sb.from('done_items').upsert({user_id:user.id,kind,item_id:id},{onConflict:'user_id,kind,item_id'}):sb.from('done_items').delete().eq('kind',kind).eq('item_id',id)):null);
function applyThemePref(p){
  store.set('themePreference',p);
  const dark=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme',dark?'dark':'light');
}
function setTheme(p){applyThemePref(p);pushSettings();}

// Récupère les données du compte (réglages, préférences, devoirs, éléments cochés, mails, actualités)
async function pullRemote(){
  if(!user||!sb)return;
  try{
    const [s,h,d,m,n]=await Promise.all([
      sb.from('settings').select('*').maybeSingle(),
      sb.from('homework').select('*').order('due'),
      sb.from('done_items').select('kind,item_id'),
      sb.from('school_mails').select('*').order('received_at',{ascending:false}).limit(200),
      sb.from('school_news').select('*').order('published_at',{ascending:false}).limit(100)
    ]);
    for(const r of [s,h,d])if(r.error)throw r.error;
    if(s.data){
      store.set('icsUrl',s.data.ics_url||'');store.set('homeworkUrl',s.data.homework_url||'');store.set('controlsUrl',s.data.controls_url||'');
      if(s.data.notif)store.set('notif',s.data.notif);
      if(Array.isArray(s.data.hw_words)){words=s.data.hw_words;store.set('hwWords',words);}
      if(s.data.subject_colors&&typeof s.data.subject_colors==='object'){colors=s.data.subject_colors;store.set('subjectColors',colors);}
      if(s.data.lycee_prefs&&Object.keys(s.data.lycee_prefs).length){lyceePrefs=mergePrefs(s.data.lycee_prefs);store.set('lyceePrefs',lyceePrefs);}
      if(s.data.theme)applyThemePref(s.data.theme);
    }
    hw=h.data.map(r=>({id:r.id,title:r.title,subject:r.subject,due:r.due,notes:r.notes,done:r.done}));saveHw();
    autoDone={};ctrlDone={};
    for(const r of d.data){if(r.kind==='hw')autoDone[r.item_id]=true;else ctrlDone[r.item_id]=true;}
    store.set('hwAutoDone',autoDone);store.set('ctrlDone',ctrlDone);
    // mails / actualités : on garde l'exemple local seulement s'il n'y a rien en ligne
    if(!m.error&&m.data.length){mails=m.data.map(r=>({id:r.id,from:r.sender,subject:r.subject,preview:r.preview,body:r.body,at:new Date(r.received_at).getTime(),read:r.read}));store.set('mails',mails);}
    else if(!store.get('demo',false)){mails=[];store.set('mails',mails);}
    if(!n.error&&n.data.length){news=n.data.map(r=>({id:r.id,title:r.title,summary:r.summary,image:r.image_url,at:new Date(r.published_at).getTime()}));store.set('news',news);}
    else if(!store.get('demo',false)){news=[];store.set('news',news);}
    if(events.length)classify();
  }catch(e){setStatus('Synchronisation du compte impossible : '+(e.message||e),true);}
}

async function enterApp(){
  NS='u:'+user.id+':';
  loadState();
  applyAuth();
  await pullRemote();
  const last=store.get('lastSync',0);
  if(last)setStatus('Dernière synchro : '+new Date(last).toLocaleString('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}));
  view=({home:'home',agenda:'agenda',lycee:'lycee'})[lyceePrefs.profile.start]||'home';
  render();window.scrollTo(0,0);
  if(hasFeeds())refresh();
}
function leaveApp(){user=null;NS='';resetState();setStatus('');applyAuth();window.scrollTo(0,0);}
const TERMS_VERSION='2026-10-31';
function frAuthError(err){
  const m=String((err&&err.message)||err||'');
  const mc=m+' '+String((err&&(err.code||err.name))||'');
  if(/passkey_disabled/i.test(mc))return 'Les clés d’accès ne sont pas encore activées sur ce site.';
  if(/NotAllowedError|AbortError|cancel|timed out|timeout/i.test(mc))return 'Opération annulée.';
  if(/credential_not_found|credential not found/i.test(mc))return 'Cette clé d’accès n’est reliée à aucun compte.';
  if(/credential_exists/i.test(mc))return 'Cet appareil a déjà une clé d’accès pour ce compte.';
  if(/too_many_passkeys/i.test(mc))return 'Tu as atteint le nombre maximum de clés d’accès.';
  if(/unsupported provider|provider is not enabled|validation_failed/i.test(mc))return 'Cette méthode de connexion n’est pas encore activée sur ce site.';
  if(/manual linking|linking is disabled/i.test(mc))return 'La liaison de comptes n’est pas activée (réglage « Allow manual linking » de Supabase).';
  if(/at least 2|minimum of 2|cannot unlink|last identity/i.test(mc))return 'Tu dois garder au moins une méthode de connexion.';
  if(/rate limit|too many|over_email_send_rate_limit|seconds/i.test(m))return 'Trop de demandes. Réessaie dans quelques minutes.';
  if(/different from the old|same password/i.test(m))return 'Choisis un mot de passe différent de l’ancien.';
  if(/session missing|expired|invalid.*(token|link)/i.test(m))return 'Ce lien a expiré. Refais une demande avec « Mot de passe oublié ? ».';
  if(/weak|pwned|easy to guess|compromised/i.test(m))return 'Ce mot de passe est trop facile à deviner. Choisis-en un plus solide.';
  if(m==='TERMS')return 'Tu dois accepter les conditions d’utilisation pour t’inscrire.';
  if(m==='NOACCOUNT')return 'Ce compte n’existe pas. Inscris-toi pour le créer.';
  if(m==='EXISTS')return 'Ce compte existe déjà. Utilise « Se connecter ».';
  if(m==='BADPASS')return 'Mot de passe incorrect.';
  if(m==='BADLOGIN'||/invalid login/i.test(m))return 'Adresse e-mail ou mot de passe incorrect.';
  if(/not confirmed/i.test(m))return 'Adresse e-mail pas encore confirmée : clique sur le lien reçu par e-mail.';
  if(/already registered|already exists/i.test(m))return 'Un compte existe déjà avec cette adresse. Utilise « Se connecter ».';
  return m||'Une erreur est survenue.';
}
const siteUrl=()=>location.origin+location.pathname.replace(/index\.html$/,'');
function cleanUrl(){try{history.replaceState(null,'',location.pathname);}catch(e){}}
function resetHTML(){
  return `<div class="gate-card">
    <div class="gate-brand"><img src="logo.svg" alt="" width="32" height="32"><span>Lapsus</span></div>
    <p class="sub">Choisis ton nouveau mot de passe.</p>
    <form data-form="reset" id="resetForm">
      <label class="fl" for="newPass">Nouveau mot de passe</label>
      <input id="newPass" type="password" minlength="8" autocomplete="new-password" required placeholder="8 caractères minimum">
      <label class="fl" for="newPass2">Confirme le mot de passe</label>
      <input id="newPass2" type="password" minlength="8" autocomplete="new-password" required placeholder="Retape le mot de passe">
      <button class="btn primary" id="resetSubmit">Enregistrer le mot de passe</button>
      <p class="m" id="resetMessage" role="status"></p>
      <button type="button" class="lnk2 forgot" data-act="resetcancel">Retour à la connexion</button>
    </form>
  </div>`;
}
function showReset(){applyAuth();const g=$('#gate');if(g){g.hidden=false;g.innerHTML=resetHTML();}}
// Fenêtre « Mot de passe oublié ? »
let forgotEmail='';
function showModal(html){const m=$('#modal');if(!m)return;m.innerHTML='<div class="modal" role="dialog" aria-modal="true">'+html+'</div>';m.hidden=false;setTimeout(()=>{const f=m.querySelector('input,button.primary');if(f)f.focus();},30);}
function closeModal(){modalOk=null;const m=$('#modal');if(m){m.hidden=true;m.innerHTML='';}}
let modalOk=null;
// Fenêtre de confirmation aux couleurs de Lapsus. o: {icon,title,text,ok,danger,typeWord,onOk}
function askModal(o){
  modalOk=o.onOk||null;
  const word=o.typeWord?`<label class="fl" for="mWord">Tape <strong>${esc(o.typeWord)}</strong> pour confirmer</label><input id="mWord" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${esc(o.typeWord)}" data-word="${esc(o.typeWord)}">`:'';
  showModal(`<div class="mok${o.danger?' warn':''}">${svg(o.icon||'warn',26)}</div><div class="mt">${esc(o.title)}</div><p class="m">${esc(o.text||'')}</p>${word}<div class="row mrow"><button type="button" class="btn" data-act="modalclose">Annuler</button><button type="button" class="btn ${o.danger?'danger':'primary'}" id="mOk" data-act="modalok"${o.typeWord?' disabled':''}>${esc(o.ok||'Confirmer')}</button></div>`);
}
function infoModal(icon,title,text,danger){
  modalOk=null;
  showModal(`<div class="mok${danger?' warn':''}">${svg(icon,26)}</div><div class="mt">${esc(title)}</div><p class="m">${esc(text)}</p><div class="row mrow"><button type="button" class="btn primary" data-act="modalclose">Fermer</button></div>`);
}
function doLogout(){leaveApp();if(sb)sb.auth.signOut().catch(()=>{});}
function forgotHTML(stage,err){
  if(stage==='ask')return `<form data-form="forgot" novalidate>
    <div class="mt">Mot de passe oublié ?</div>
    <p class="m">Entre l’adresse e-mail de ton compte. On t’enverra un lien pour choisir un nouveau mot de passe.</p>
    <label class="fl" for="fEmail">Adresse e-mail</label>
    <input id="fEmail" type="email" autocomplete="email" placeholder="toi@exemple.fr" value="${esc(forgotEmail)}">
    <p class="m merr" id="fErr" role="alert">${esc(err||'')}</p>
    <div class="row mrow"><button type="button" class="btn" data-act="modalclose">Annuler</button><button class="btn primary">Continuer</button></div>
  </form>`;
  if(stage==='confirm')return `<div class="mt">Envoyer le lien ?</div>
    <p class="m">Un e-mail de réinitialisation va être envoyé à <strong>${esc(forgotEmail)}</strong>. Confirmes-tu l’envoi ?</p>
    <p class="m merr" id="fErr" role="alert">${esc(err||'')}</p>
    <div class="row mrow"><button type="button" class="btn" data-act="forgotback">Modifier</button><button type="button" class="btn primary" id="fSend" data-act="forgotsend">Envoyer le lien</button></div>`;
  return `<div class="mok">${svg('check',26)}</div><div class="mt">Vérifie ta boîte mail</div>
    <p class="m">Si un compte existe avec <strong>${esc(forgotEmail)}</strong>, tu vas recevoir un e-mail avec un lien pour choisir un nouveau mot de passe. Pense à regarder tes spams. Le lien a une durée limitée.</p>
    <div class="row mrow"><button type="button" class="btn primary" data-act="modalclose">Fermer</button></div>`;
}
async function forgotSend(){
  const b=$('#fSend');if(b){b.disabled=true;b.textContent='Envoi…';}
  try{
    if(!sb)throw new Error('Service indisponible. Recharge la page.');
    const r=await sb.auth.resetPasswordForEmail(forgotEmail,{redirectTo:siteUrl()});
    if(r.error)throw r.error;
    showModal(forgotHTML('sent'));
  }catch(err){showModal(forgotHTML('confirm',frAuthError(err)));}
}
const passkeyOK=()=>!!(sb&&sb.auth&&typeof sb.auth.signInWithPasskey==='function'&&typeof sb.auth.registerPasskey==='function'&&window.PublicKeyCredential);
function gateMsg(t){const m=$('#authMessage');if(m){m.style.color='';m.textContent=t;}}
async function passkeySignIn(){
  if(!(sb&&sb.auth&&typeof sb.auth.signInWithPasskey==='function'&&window.PublicKeyCredential))return gateMsg('Les clés d’accès ne sont pas disponibles sur cet appareil ou ce navigateur.');
  gateMsg('');
  try{
    const r=await sb.auth.signInWithPasskey();
    if(r.error)throw r.error;
    user=(r.data&&(r.data.user||(r.data.session&&r.data.session.user)))||null;
    if(!user)throw new Error('Connexion impossible.');
    showLoader('Connexion en cours…','Ton espace arrive.');
    await enterApp();setStatus('Connecté');
  }catch(err){hideLoader(true);user=null;gateMsg(frAuthError(err));}
  finally{hideLoader();}
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
      <label class="chk terms" id="termsRow"${reg?'':' hidden'}><input type="checkbox" id="authTerms"><span>J’accepte les <a href="conditions.html" target="_blank" rel="noopener">conditions d’utilisation</a></span></label>
      <button class="btn primary" id="authSubmit">${reg?'S’inscrire':'Se connecter'}</button>
      <p class="m" id="authMessage" role="status"></p>
      <button type="button" class="lnk2 forgot" id="forgotBtn" data-act="forgot"${reg?' hidden':''}>Mot de passe oublié ?</button>
    </form>
    <div class="or"><span>ou</span></div>
    <button type="button" class="btn sso" id="passkeyBtn" data-act="passkeylogin"${reg?' hidden':''}>${svg('key',20)}<span>Se connecter avec une clé d’accès</span></button>

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
  const tr=$('#termsRow');if(tr)tr.hidden=!register;
  const fb=$('#forgotBtn');if(fb)fb.hidden=register;
  const pb=$('#passkeyBtn');if(pb)pb.hidden=register;
  const am=$('#authMessage');if(am){am.style.color='';am.textContent='';}
}

document.addEventListener('click',e=>{
  if(e.target&&e.target.id==='modal'){closeModal();return;}
  const t=e.target.closest('[data-act]');if(!t)return;
  const a=t.dataset.act,id=t.dataset.id;
  if(a==='view'){view=t.dataset.v;render();window.scrollTo(0,0);if(view==='connexion-compte')loadSecurity();}
  else if(a==='forgot'){forgotEmail=(($('#authEmail')||{}).value||'').trim();showModal(forgotHTML('ask'));}
  else if(a==='modalclose'){closeModal();}
  else if(a==='pbdismiss'){profileBannerOff=true;render();}
  else if(a==='passkeylogin'){passkeySignIn();}
  else if(a==='pkadd'){addPasskey();}
  else if(a==='pkdel'){const pid=t.dataset.id;askModal({icon:'trash',danger:true,title:'Supprimer cette clé d’accès ?',text:'Tu ne pourras plus l’utiliser pour te connecter depuis cet appareil.',ok:'Supprimer',onOk:()=>deletePasskey(pid)});}
  else if(a==='forgotback'){showModal(forgotHTML('ask'));}
  else if(a==='forgotsend'){forgotSend();}
  else if(a==='resetcancel'){(async()=>{try{await sb.auth.signOut();}catch(x){}recoveryPending=false;cleanUrl();user=null;applyAuth();})();}
  else if(a==='prev'||a==='next'){
    const dir=a==='next'?1:-1;
    if(isMobileView()){
      // téléphone : on avance jour par jour (le week-end est sauté s'il n'y a pas de cours)
      let d=cursor;
      for(let i=0;i<7;i++){d=addDays(d,dir);const we=d.getDay()===0||d.getDay()===6;if(!we||sched(d).length)break;}
      cursor=startOfDay(d);
    }else cursor=addDays(cursor,7*dir);
    render();
  }
  else if(a==='today'){cursor=startOfDay(new Date());render();}
  else if(a==='gotoweek'){cursor=startOfDay(new Date());view='agenda';render();window.scrollTo(0,0);}
  else if(a==='hwfilter'){hwFilter=t.dataset.v;render();}
  else if(a==='toggledone'){showDone=!showDone;render();}
  else if(a==='themeset'){setTheme(t.dataset.v);render();}
  else if(a==='lpset'){setPref(t.dataset.p,t.dataset.n?Number(t.dataset.v):t.dataset.v);}
  else if(a==='colorreset'){delete colors[t.dataset.k];store.set('subjectColors',colors);pushSettings();render();}
  else if(a==='theme'){const p=store.get('themePreference',store.get('theme','system'));setTheme(p==='system'?'light':p==='light'?'dark':'system');}
  else if(a==='authmode'){setAuthMode(t.dataset.v);}
  else if(a==='logout'){askModal({icon:'out',title:'Se déconnecter ?',text:'Tu devras te reconnecter avec ton adresse e-mail et ton mot de passe. Tes données restent enregistrées sur ton compte.',ok:'Se déconnecter',onOk:doLogout});}
  else if(a==='modalok'){const f=modalOk;closeModal();if(f)f();}
  else if(a==='deleteaccount'){askModal({icon:'trash',danger:true,title:'Supprimer le compte ?',text:'Ton compte et toutes tes données (devoirs, éléments cochés, liens, réglages) seront supprimés définitivement. Cette action est irréversible.',typeWord:'SUPPRIMER',ok:'Supprimer le compte',onOk:deleteAccountModal});}
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
  else if(a==='wipe'){askModal({icon:'warn',danger:true,title:'Tout effacer ?',text:'Tes devoirs, éléments cochés, liens et réglages seront supprimés de ton compte, sur tous tes appareils. Ton compte est conservé. Cette action est définitive.',ok:'Tout effacer',onOk:wipeAll});}
});

document.addEventListener('submit',async e=>{
  const f=e.target.dataset.form;if(!f)return;
  e.preventDefault();
  if(f==='forgot'){
    const v=(($('#fEmail')||{}).value||'').trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)){forgotEmail=v;showModal(forgotHTML('ask','Entre une adresse e-mail valide.'));return;}
    forgotEmail=v;showModal(forgotHTML('confirm'));return;
  }
  if(f==='reset'){
    const p1=$('#newPass').value,p2=$('#newPass2').value,msg=$('#resetMessage'),btn=$('#resetSubmit');
    msg.style.color='';msg.textContent='';
    if(p1.length<8){msg.textContent='Le mot de passe doit contenir au moins 8 caractères.';return;}
    if(p1!==p2){msg.textContent='Les deux mots de passe ne correspondent pas.';return;}
    btn.disabled=true;
    try{
      const r=await sb.auth.updateUser({password:p1});
      if(r.error)throw r.error;
      recoveryPending=false;cleanUrl();
      const s=await sb.auth.getSession();user=s.data.session.user;
      showLoader('Mot de passe modifié','Ton espace arrive.');
      await enterApp();setStatus('Mot de passe modifié');
    }catch(err){btn.disabled=false;msg.textContent=frAuthError(err);}
    finally{hideLoader();}
    return;
  }
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
    let failed=false;
    try{
      if(!sb)throw new Error('Impossible de charger le service de comptes.');
      if(password.length<8)throw new Error('Le mot de passe doit contenir au moins 8 caractères.');
      if(mode==='register'){const tc=$('#authTerms');if(!tc||!tc.checked)throw new Error('TERMS');}
      showLoader(mode==='register'?'Création de ton compte…':'Connexion en cours…','Ton espace arrive.');
      let res;
      const exists=async()=>{try{const r=await sb.rpc('email_exists',{p_email:email});return r.error?null:!!r.data;}catch(x){return null;}};
      if(mode==='register'){
        if(await exists()===true)throw new Error('EXISTS');
        res=await sb.auth.signUp({email,password,options:{data:{terms_accepted_at:new Date().toISOString(),terms_version:TERMS_VERSION}}});
        if(res.error)throw res.error;
        if(res.data.user&&Array.isArray(res.data.user.identities)&&res.data.user.identities.length===0)throw new Error('EXISTS');
        if(!res.data.session){
          hideLoader(true);failed=true;
          setAuthMode('login');
          const m2=$('#authMessage');if(m2){m2.style.color='var(--ok)';m2.textContent='Compte créé ! Confirme ton adresse avec le lien reçu par e-mail, puis connecte-toi.';}
          return;
        }
      }else{
        res=await sb.auth.signInWithPassword({email,password});
        if(res.error){
          if(/invalid login/i.test(res.error.message||'')){
            const ex=await exists();
            throw new Error(ex===false?'NOACCOUNT':ex===true?'BADPASS':'BADLOGIN');
          }
          throw res.error;
        }
      }
      user=res.data.session.user;
      await enterApp();
    }catch(err){failed=true;hideLoader(true);if(msg)msg.textContent=frAuthError(err);}finally{if(!failed)hideLoader();}
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
  }else if(t.dataset&&t.dataset.lpbool){
    setPref(t.dataset.lpbool,t.checked);
  }else if(t.dataset&&t.dataset.lpsub!==undefined){
    const hid=new Set(lyceePrefs.hw.hidden);if(t.checked)hid.delete(t.dataset.lpsub);else hid.add(t.dataset.lpsub);
    setPref('hw.hidden',[...hid]);
  }else if(t.dataset&&t.dataset.lptext){
    setPref(t.dataset.lptext,t.value.trim().slice(0,60));
  }
});

// Empêche le zoom au pincement sur iPhone (le double tap est déjà bloqué par le style)
['gesturestart','gesturechange','gestureend'].forEach(t=>document.addEventListener(t,e=>e.preventDefault()));

// Si on passe de téléphone à ordinateur (ou on tourne l'écran), l'agenda se réaffiche tout de suite
let wasMobileView=isMobileView();
window.addEventListener('resize',()=>{const m=isMobileView();if(m!==wasMobileView){wasMobileView=m;if(user&&view==='agenda')render();}});

document.addEventListener('input',e=>{
  const t=e.target;
  if(t&&t.id==='mWord'){const b=$('#mOk');if(b)b.disabled=t.value.trim().toUpperCase()!==t.dataset.word;}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){const m=$('#modal');if(m&&!m.hidden)closeModal();}});
if(sb)sb.auth.onAuthStateChange(ev=>{
  if(ev==='PASSWORD_RECOVERY')recoveryPending=true;
  if(ev==='SIGNED_OUT'&&user)leaveApp();
});

(async function boot(){
  try{
    try{localStorage.removeItem('lapsusSession');}catch(e){}
    if(sb){
      try{const r=await sb.auth.getSession();user=r.data&&r.data.session?r.data.session.user:null;}catch(e){user=null;}
    }
    showLoader('Chargement en cours…','Ton espace arrive.');
    if(recoveryPending&&sb){user=null;cleanUrl();showReset();}
    else if(user){try{await enterApp();}catch(e){console.error(e);}}
    else{
      applyAuth();
      if(linkError){cleanUrl();const m=$('#authMessage');if(m)m.textContent='Ce lien a expiré ou a déjà été utilisé. Refais une demande avec « Mot de passe oublié ? ».';}
    }
  } catch(err) {
    console.error("Erreur critique au démarrage :", err);
  } finally {
    hideLoader();
  }
})();
