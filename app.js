'use strict';

// ---------- Configuration ----------
// Adresse du relais (Cloudflare Worker) qui lit ton lien ICS à la place du navigateur.
// Cette adresse n'est pas secrète : le relais n'accepte que ton site et ton ENT.
const CONFIG={
  RELAY_URL:'https://ent-relais.nonovernaison21.workers.dev',
  // Projet Supabase (la clé "publishable" est faite pour être publique : les règles RLS protègent les données)
  SUPABASE_URL:'https://wrrfblhxomsegdyadens.supabase.co',
  SUPABASE_KEY:'sb_publishable_Y6sU39QsYtTFnVeocHjAiA_4yFIEHFu'
};

/*PARSER-START*/
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
const startOfDay=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate());

// 1. Découpage du fichier en lignes (les lignes longues sont "repliées" dans le format ICS)
function unfold(t){return t.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\n[ \t]/g,'').split('\n');}

// 2. Une ligne ICS : NOM;PARAM=val:valeur
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

// 3. Dates et fuseaux horaires
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

// 4. Récurrences simples (DAILY et WEEKLY). Beaucoup de flux scolaires n'en ont pas du tout.
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

// 5. Construction d'un événement à partir de ses propriétés
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
    if(alarm)continue; // on ignore les rappels intégrés au fichier
    const pl=splitLine(L);if(!pl)continue;
    if(cur){cur.raw.push(L);(cur.props[pl.name]=cur.props[pl.name]||[]).push(pl);}
    else cal[pl.name]=pl.value;
  }
  // Un événement modifié (RECURRENCE-ID) remplace l'occurrence d'origine
  const ov=new Set(events.filter(e=>e.override).map(e=>e.uid+'|'+e.override));
  return {events:events.filter(e=>!(e.recurring&&ov.has(e.uid+'|'+e.start.getTime()))),cal};
}
/*PARSER-END*/

// ---------- Utilitaires ----------
const $=s=>document.querySelector(s);
// Les données locales (cache) sont rangées par compte : préfixe NS. Seuls ces réglages d'affichage sont communs.
let NS='';
const GLOBAL_KEYS=new Set(['view','mode','themePreference','theme']);
const K=k=>GLOBAL_KEYS.has(k)?k:NS+k;
const store={
  get(k,d){try{const v=localStorage.getItem(K(k));return v===null?d:JSON.parse(v);}catch(e){return d;}},
  set(k,v){try{localStorage.setItem(K(k),JSON.stringify(v));}catch(e){}}
};
const uid=()=>crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16);});
const isUuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
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
const defaultColorHex=t=>hslHex(hue(t),55,document.documentElement.dataset.theme==='dark'?62:40);
const subjectColor=t=>colors[t]||'hsl('+hue(t)+' 55% var(--ev-l))';
function rel(ms){const m=Math.max(1,Math.round(ms/60000));if(m<60)return m+' min';return Math.floor(m/60)+' h '+String(m%60).padStart(2,'0');}
const typing=()=>{const a=document.activeElement;return !!a&&(a.tagName==='INPUT'||a.tagName==='SELECT'||a.tagName==='TEXTAREA');};

// ---------- Icônes ----------
const ICON={
  home:'<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  cal:'<rect x="3" y="4.5" width="18" height="16.5" rx="3.5"/><path d="M3 10h18M8 2.5v4M16 2.5v4"/>',
  hw:'<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="m8.5 12.2 2.5 2.5 4.5-5"/>',
  set:'<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  out:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  moon:'<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>'
};
const svg=(n,s)=>`<svg viewBox="0 0 24 24" width="${s||22}" height="${s||22}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

// Reconstitue les dates enregistrées en cache local.
function reviveEvent(e){return Object.assign({},e,{start:new Date(e.start),end:new Date(e.end)});}

// ---------- État ----------
const VIEWS=[['home','Accueil','home'],['agenda','Agenda','cal'],['hw','Devoirs','hw'],['set','Réglages','set']];
// Mots qui, dans le titre ou la description d'un événement, indiquent un devoir (modifiable dans les réglages)
const DEFAULT_WORDS=['travail à faire','devoir à faire','devoir maison','devoirs','à faire','à rendre','à préparer','à apprendre','dm','homework'];
// Ces mots indiquent une évaluation : elle reste dans l'agenda
const EVAL_RE=/(^|[^a-z0-9])(devoir surveille|ds|dst|controle|interro|interrogation|evaluation|examen|bac blanc|partiel)([^a-z0-9]|$)/;

let view=store.get('view','home');
let mode=store.get('mode','week');
if(['day','week','month'].includes(view)){mode=view;view='agenda';}
if(!VIEWS.some(v=>v[0]===view))view='home';
if(!['day','week','month'].includes(mode))mode='week';
let cursor=startOfDay(new Date());
let events=[];
let hwFeedEvents=[],evalFeedEvents=[],hw=[],autoDone={},ctrlDone={},ov={},words=DEFAULT_WORDS.slice(),colors={};
function resetState(){colors={};events=[];hwFeedEvents=[];evalFeedEvents=[];hw=[];autoDone={};ctrlDone={};ov={};words=DEFAULT_WORDS.slice();}
// Recharge l'état depuis le cache local du compte connecté
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
const openSecs=new Set();
let hwRx=null;
const saveHw=()=>store.set('homework',hw);

// ---------- Classement cours / devoirs / évaluations ----------
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
function stripLabel(t){
  const ws=words.map(w=>w.trim()).filter(Boolean).sort((a,b)=>b.length-a.length);
  if(!ws.length)return t;
  return t.replace(new RegExp('^('+ws.map(rxEsc).join('|')+')(?=[\\s:\\-–]|$)\\s*[:\\-–]?\\s*','i'),'');
}
function hwFromEvent(e){
  let title=e.title.trim(),subject='';
  const m=title.match(/^(.{2,40}?)\s*[:：]\s*(.+)$/);
  if(m){
    if(hwRx&&hwRx.test(norm(m[1])))title=m[2];
    else{subject=m[1];title=m[2];}
  }
  title=stripLabel(title).trim()||e.title;
  return {title:cap(title),subject,due:isoDay(e.start),notes:e.description||''};
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
const byDue=(a,b)=>a.due.localeCompare(b.due);
function todoItems(){return hwItems().filter(h=>!h.done).sort(byDue);}
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

// ---------- Écran de chargement ----------
function showLoader(t,s){const l=$('#loader');if(!l)return;const a=$('#loaderTitle'),b=$('#loaderSub');if(a)a.textContent=t||'Chargement en cours…';if(b)b.textContent=s||'';l.hidden=false;}
function hideLoader(){const l=$('#loader');if(l)l.hidden=true;}
async function withLoader(t,s,p){showLoader(t,s);try{return await p;}finally{hideLoader();}}

// ---------- Synchronisation ----------
function setStatus(t,err){const s=$('#status');s.textContent=t;s.className='status'+(err?' err':'');}
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

// ---------- Composants ----------
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

// ---------- Vues ----------
function secHead(title,btn){return `<div class="sech"><h2>${esc(title)}</h2>${btn||''}</div>`;}
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
function lunchCfg(){
  const l=store.get('lunch',{s:'12:00',e:'13:00'});
  const m=t=>{const [h,mi]=String(t||'').split(':').map(Number);return (h||0)*60+(mi||0);};
  return {s:m(l.s),e:m(l.e),raw:l};
}
// Grille horaire (ordinateur) : colonne des heures à gauche, un bloc par cours à sa vraie place
function timeGrid(mon){
  const days=[];
  for(let i=0;i<7;i++){const d=addDays(mon,i),l=sched(d);if(i>=5&&!l.length)continue;days.push({d,l});}
  const mm=e=>e.getHours()*60+e.getMinutes();
  const lunch=lunchCfg();
  const dayItems=days.map(({d,l})=>{
    const ds=startOfDay(d),de=addDays(ds,1);
    return l.filter(e=>!e.allDay).map(e=>({e,s:e.start<ds?0:mm(e.start),e2:e.end>=de?1440:mm(e.end)})).filter(x=>x.e2>x.s).sort((a,b)=>a.s-b.s||a.e2-b.e2);
  });
  let lo=Infinity,hi=-Infinity;
  dayItems.forEach(a=>a.forEach(x=>{lo=Math.min(lo,x.s);hi=Math.max(hi,x.e2);}));
  if(!isFinite(lo)){lo=480;hi=1020;}
  if(lunch.e>lunch.s&&lunch.s<hi&&lunch.e>lo){lo=Math.min(lo,lunch.s);hi=Math.max(hi,lunch.e);}
  const h0=Math.max(0,Math.floor(lo/60)),h1=Math.min(24,Math.ceil(hi/60));
  const HH=60,H=(h1-h0)*HH,y=min=>(min-h0*60)*HH/60;
  const hours=[];for(let h=h0;h<=h1;h++)hours.push(`<i style="top:${(h-h0)*HH}px">${h} h</i>`);
  const now=new Date(),nowMin=mm(now);
  const cols=days.map(({d,l},idx)=>{
    const items=dayItems[idx];
    // répartition côte à côte des cours qui se chevauchent
    let cluster=[],cEnd=-1;
    const flush=()=>{if(!cluster.length)return;const lanes=[];for(const it of cluster){let k=lanes.findIndex(end=>end<=it.s);if(k<0){k=lanes.length;lanes.push(0);}lanes[k]=it.e2;it.lane=k;}cluster.forEach(it=>{it.n=lanes.length;});cluster=[];cEnd=-1;};
    for(const it of items){if(cluster.length&&it.s>=cEnd)flush();cluster.push(it);cEnd=Math.max(cEnd,it.e2);}
    flush();
    const blocks=items.map(it=>{
      const ev=it.e,cancelled=ev.status==='CANCELLED',live=!cancelled&&ev.start<=now&&ev.end>now;
      const top=y(it.s),hgt=Math.max(18,y(it.e2)-top-2);
      const tip=[ev.title,fmtTime(ev.start)+' - '+fmtTime(ev.end),ev.location,ev.description].filter(Boolean).join('\n');
      return `<div class="blk${cancelled?' cancelled':''}${live?' live':''}" style="top:${top}px;height:${hgt}px;left:calc(${it.lane}*100%/${it.n});width:calc(100%/${it.n} - 3px);--c:${esc(subjectColor(ev.title))}" title="${esc(tip)}"><b>${esc(ev.title)}</b>${hgt>34?`<span>${fmtTime(ev.start)} – ${fmtTime(ev.end)}</span>`:''}${hgt>52&&ev.location?`<span>${esc(ev.location)}</span>`:''}${cancelled&&hgt>34?'<em>Annulé</em>':''}</div>`;
    }).join('');
    const band=(cls,a,b,label)=>{const a2=Math.max(a,h0*60),b2=Math.min(b,h1*60);return b2>a2?`<div class="band ${cls}" style="top:${y(a2)}px;height:${y(b2)-y(a2)}px">${label&&y(b2)-y(a2)>22?`<span>${label}</span>`:''}</div>`:'';};
    const hasLunch=lunch.e>lunch.s;
    const bands=band('am',h0*60,hasLunch?lunch.s:h1*60,'')+(hasLunch?band('lunch',lunch.s,lunch.e,'Déjeuner')+band('pm',lunch.e,h1*60,''):'');
    const isToday=sameDay(d,now);
    const nl=isToday&&nowMin>=h0*60&&nowMin<=h1*60?`<div class="nowline" style="top:${y(nowMin)}px"></div>`:'';
    return `<div class="dcol${isToday?' today':''}" style="height:${H}px">${bands}${blocks}${nl}</div>`;
  }).join('');
  const heads=days.map(({d,l})=>{
    const chips=l.filter(e=>e.allDay).map(e=>`<em class="chip">${esc(e.title)}</em>`).join('');
    return `<div class="th${sameDay(d,now)?' today':''}">${esc(cap(d.toLocaleDateString('fr-FR',{weekday:'long'})))} <span>${d.getDate()}</span>${chips}</div>`;
  }).join('');
  return `<div class="tgrid" style="--cols:${days.length};--hh:${HH}px"><div></div>${heads}<div class="times" style="height:${H}px">${hours.join('')}</div>${cols}</div>`;
}
function viewAgenda(){
  const f=d=>d.toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
  const mon=mondayOf(cursor),sun=addDays(mon,6);
  const thisWeek=sameDay(mon,mondayOf(new Date()));
  let cols='',nc=0;
  for(let i=0;i<7;i++){
    const d=addDays(mon,i),l=sched(d);
    if(i>=5&&!l.length)continue;
    nc++;
    cols+=`<section class="day${sameDay(d,new Date())?' today':''}"><h3>${esc(cap(d.toLocaleDateString('fr-FR',{weekday:'long'})))} <span>${d.getDate()}</span></h3>${list(l.map(e=>evRow(e)).join(''),'Rien')}</section>`;
  }
  return `<h1>${esc(f(mon)+' – '+f(sun))}</h1>
  <p class="sub">${thisWeek?'Cette semaine':'Semaine du '+esc(mon.toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'}))}</p>
  <div class="tools">
    <div class="step"><button class="btn" data-act="prev" aria-label="Semaine précédente">‹</button><button class="btn" data-act="next" aria-label="Semaine suivante">›</button></div>
    <div class="step"><input type="date" id="agendaDate" value="${isoDay(cursor)}" aria-label="Choisir une date"><button class="btn" data-act="today"${thisWeek?' disabled':''}>Cette semaine</button></div>
  </div>
  ${timeGrid(mon)}
  <div class="weekgrid">${cols}</div>`;
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
  <p class="foot">Les devoirs et les contrôles viennent de leurs liens ICS respectifs. Ils n’apparaissent plus dans l’agenda des cours.</p>`;
}
function acc(id,title,body,lvl){return `<details class="acc l${lvl}" data-sec="${id}"${openSecs.has(id)?' open':''}><summary>${title}</summary><div class="accb">${body}</div></details>`;}
function viewSet(){
  const url=store.get('icsUrl',''),homeworkUrl=store.get('homeworkUrl',''),controlsUrl=store.get('controlsUrl',''),n=store.get('notif',{on:false,min:10});
  const themePref=store.get('themePreference',store.get('theme','system'));
  const authPanel=`<div class="panel"><p>Connecté en tant que <strong>${esc(user?user.email:'')}</strong></p><p class="m">Tes devoirs, contrôles cochés et réglages sont enregistrés en ligne : tu les retrouves sur tous tes appareils.</p><button class="btn" type="button" data-act="logout">Se déconnecter</button></div>`;
  const soon=t=>`<div class="panel"><p class="m">${t}</p></div>`;
  const created=user&&user.created_at?new Date(user.created_at).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'}):'';
  const today=isoDay(startOfDay(new Date()));
  const cahier=hwItems().filter(h=>h.due>=today).sort(byDue).slice(0,30);
  const lycee=
    acc('mail','Mail',soon('Les mails de l’ENT s’afficheront ici. Ils ne passent pas par un lien ICS : cela demandera la connexion directe à l’ENT, qu’on mettra en place ensuite.'),2)+
    acc('actu','Actus',soon('Les actualités du lycée s’afficheront ici. Comme pour les mails, elles viendront de la connexion directe à l’ENT.'),2)+
    acc('cahier','Cahier de texte',`${list(cahier.map(hwRow).join(''),'Aucun devoir à venir dans le cahier de texte.')}<p class="m">Issu du lien ICS des devoirs et de ceux que tu as ajoutés.</p>`,2)+
    acc('profil','Mon profil',`<div class="panel"><p><span class="m">E-mail</span><br><strong>${esc(user?user.email:'')}</strong></p>${created?`<p><span class="m">Compte créé le</span><br><strong>${esc(created)}</strong></p>`:''}<p class="m">Ton nom, ta classe et ton établissement s’afficheront ici avec la connexion à l’ENT.</p></div>`,2);
  const ent=`<form class="panel" data-form="url">
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
    <p class="m">Les devoirs sont affichés dans l’onglet Devoirs, regroupés par matière avec leur contenu.</p>
    <label class="fl" for="controlsUrl">Lien ICS des contrôles et évaluations</label>
    <div class="row"><input id="controlsUrl" type="url" placeholder="Lien du calendrier des contrôles" value="${esc(controlsUrl)}" autocomplete="off"></div>
    <p class="m">Les contrôles sont regroupés par matière dans Devoirs. Ils ne sont pas affichés dans l’agenda des cours.</p>
    <button class="btn primary">Enregistrer les liens et synchroniser</button>
  </form>`;
  const look=`<div class="panel"><div class="seg">${[['light','Clair'],['dark','Sombre'],['system','Système']].map(([k,l])=>`<button class="${themePref===k?'on':''}" data-act="themeset" data-v="${k}">${l}</button>`).join('')}</div><p class="m">Le mode Système suit automatiquement le thème clair ou sombre de ton appareil.</p></div>`;
  const subs=[...new Set(events.filter(e=>e.kind==='course').map(e=>e.title))].sort((a,b)=>a.localeCompare(b,'fr'));
  const pal=`<div class="panel">${subs.length?subs.map(s=>{const c=colors[s]||defaultColorHex(s);return `<div class="crow"><span class="cn">${esc(s)}</span>${colors[s]?`<button class="lnk" data-act="colorreset" data-k="${esc(s)}">Par défaut</button>`:''}<input type="color" value="${c}" data-color="${esc(s)}" aria-label="Couleur de ${esc(s)}"></div>`;}).join(''):'<p class="m">Charge ton emploi du temps pour choisir la couleur de chaque matière.</p>'}<p class="m">La couleur sert dans l’emploi du temps et sur l’accueil. Par défaut, chaque matière a une couleur automatique.</p></div>`;
  const lc=lunchCfg().raw;
  const lunchP=`<div class="panel"><div class="row"><label class="fl" for="lunchS" style="margin:0">De</label><input type="time" id="lunchS" value="${esc(lc.s)}"><label class="fl" for="lunchE" style="margin:0">à</label><input type="time" id="lunchE" value="${esc(lc.e)}"></div><p class="m">Cette plage est affichée en hachuré dans l’agenda. Ce qui est avant correspond au matin, ce qui est après à l’après-midi. Réglage propre à cet appareil.</p></div>`;
  const conn=acc('ent','ENT',ent,2)+acc('look','Apparence',look,2)+acc('colors','Couleur par matière',pal,2)+acc('lunch','Pause du midi',lunchP,2);
  return `<h1>Réglages</h1>
  <h2>Compte utilisateur</h2>${authPanel}
  <h2>Mon lycée</h2>${acc('lycee','Mon lycée',lycee,1)}
  <h2>Connexion</h2>${acc('conn','Connexion',conn,1)}
  <h2>Notifications</h2>
  <div class="panel">
    <div class="row"><label class="chk"><input type="checkbox" id="notifOn" ${n.on?'checked':''}> Rappel avant chaque cours</label>
    <select id="notifMin" aria-label="Délai du rappel">${[5,10,15,30].map(x=>`<option value="${x}"${x===n.min?' selected':''}>${x} min avant</option>`).join('')}</select></div>
    <p class="m">Fonctionne tant que cette page reste ouverte. Un rappel des devoirs du lendemain part aussi après 18 h.</p>
  </div>
  <h2>Données</h2>
  <div class="panel"><button class="btn danger" data-act="wipe">Tout effacer</button>
    <p class="m">Supprime les liens, les devoirs, les éléments cochés et les réglages de ton compte, sur tous tes appareils.</p></div>`;
}

function render(){
  const todo=todoItems().length;
  $('#nav').innerHTML=VIEWS.map(([k,l,ic])=>`<button class="nv${k===view?' on':''}" data-act="view" data-v="${k}"${k===view?' aria-current="page"':''}>${svg(ic)}<span>${l}</span>${k==='hw'&&todo?`<i class="n">${todo}</i>`:''}</button>`).join('');
  const f={home:viewHome,agenda:viewAgenda,hw:viewHw,set:viewSet}[view]||viewHome;
  $('#main').innerHTML=f();
}

// ---------- Exemple ----------
function demoICS(){
  const pad=n=>String(n).padStart(2,'0');
  const ymdOf=d=>d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate());
  const slots=[['0800','0955'],['1010','1205'],['1400','1555']];
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
  const t0=startOfDay(new Date());
  add(ymdOf(addDays(t0,1)),'1800','1805','MATHEMATIQUES : Travail à faire - exercices 3 à 5 page 42','','À rendre en début de cours');
  add(ymdOf(addDays(t0,3)),'1800','1805','PHYSIQUE-CHIMIE : Devoir maison - rapport de TP','','');
  add(ymdOf(addDays(t0,6)),'1600','1700','DS MATHEMATIQUES','B204','Chapitres 1 à 3');
  L.push('END:VCALENDAR');
  return L.join('\n');
}
function loadDemo(){
  const t=demoICS();
  loadICS(t);store.set('icsText',t);store.set('demo',true);
  if(!hw.length){
    hw=[{id:uid(),title:'Réviser le chapitre 3 (exemple)',subject:'NSI',due:isoDay(addDays(startOfDay(new Date()),2)),done:false}];
    saveHw();pushHwRow(hw[0]);
  }
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

// ---------- Actions ----------
function resolvedTheme(pref){
  if(pref==='system')return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  return pref==='dark'?'dark':'light';
}
function applyTheme(pref){
  if(!['light','dark','system'].includes(pref))pref='system';
  store.set('themePreference',pref);
  const actual=resolvedTheme(pref);
  document.documentElement.dataset.theme=actual;
  // Compatibilité avec les anciennes versions.
  store.set('theme',pref);
  const b=$('#themeBtn');if(b){b.innerHTML=svg(actual==='dark'?'sun':'moon',20);b.setAttribute('aria-label','Thème actuel : '+(pref==='system'?'système':pref==='dark'?'sombre':'clair')+'. Cliquer pour changer.');}
  const select=$('#themeSelect');if(select&&select.value!==pref)select.value=pref;
}
// ---------- Compte et données en ligne (Supabase) ----------
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
function setTheme(p){applyTheme(p);pushSettings();}

// Première connexion : reprend les données qui étaient déjà enregistrées dans ce navigateur
function migrateLegacy(){
  try{
    if(localStorage.getItem('legacyMigrated'))return false;
    localStorage.setItem('legacyMigrated','1');
    let any=false;
    for(const k of ['icsUrl','homeworkUrl','controlsUrl','notif','hwWords','homework','hwAutoDone','ctrlDone','icsText','hwICStext','evalICStext','lastSync','demo']){
      const v=localStorage.getItem(k);if(v!==null){localStorage.setItem(NS+k,v);any=true;}
    }
    if(!any)return false;
    loadState();
    hw=hw.map(h=>Object.assign({},h,{id:isUuid(h.id)?h.id:uid()}));saveHw();
    return true;
  }catch(e){return false;}
}
async function pushAll(){
  await pushSettings();
  if(hw.length)await remote(sb.from('homework').upsert(hw.map(hwRowData)));
  const rows=Object.keys(autoDone).map(id=>({user_id:user.id,kind:'hw',item_id:id})).concat(Object.keys(ctrlDone).map(id=>({user_id:user.id,kind:'ctrl',item_id:id})));
  if(rows.length)await remote(sb.from('done_items').upsert(rows,{onConflict:'user_id,kind,item_id'}));
}
// Récupère les données du compte (elles remplacent le cache local)
async function pullRemote(){
  if(!user||!sb)return;
  try{
    const [s,h,d]=await Promise.all([
      sb.from('settings').select('*').maybeSingle(),
      sb.from('homework').select('*').order('due'),
      sb.from('done_items').select('kind,item_id')
    ]);
    for(const r of [s,h,d])if(r.error)throw r.error;
    if(!s.data&&!h.data.length&&!d.data.length&&migrateLegacy()){await pushAll();return;}
    if(s.data){
      store.set('icsUrl',s.data.ics_url||'');store.set('homeworkUrl',s.data.homework_url||'');store.set('controlsUrl',s.data.controls_url||'');
      if(s.data.notif)store.set('notif',s.data.notif);
      if(Array.isArray(s.data.hw_words)){words=s.data.hw_words;store.set('hwWords',words);}
      if(s.data.subject_colors&&typeof s.data.subject_colors==='object'){colors=s.data.subject_colors;store.set('subjectColors',colors);}
      applyTheme(s.data.theme);
    }
    hw=h.data.map(r=>({id:r.id,title:r.title,subject:r.subject,due:r.due,notes:r.notes,done:r.done}));saveHw();
    autoDone={};ctrlDone={};
    for(const r of d.data){if(r.kind==='hw')autoDone[r.item_id]=true;else ctrlDone[r.item_id]=true;}
    store.set('hwAutoDone',autoDone);store.set('ctrlDone',ctrlDone);
    if(events.length)classify();
  }catch(e){setStatus('Synchronisation du compte impossible : '+(e.message||e),true);}
}
async function enterApp(){
  NS='u:'+user.id+':';
  loadState();
  applyAuth();
  const last=store.get('lastSync',0);
  if(last)setStatus('Dernière synchro : '+new Date(last).toLocaleString('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}));
  render();window.scrollTo(0,0);
  await pullRemote();
  render();
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
  if(/rate limit|too many/i.test(m))return 'Trop de tentatives, réessaie dans quelques minutes.';
  if(/password/i.test(m)&&/(short|least|weak)/i.test(m))return 'Mot de passe trop faible : 8 caractères minimum.';
  if(/network|fetch/i.test(m))return 'Connexion impossible. Vérifie ta connexion internet.';
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
// Affiche l'écran de connexion tant que personne n'est connecté (la session reste mémorisée ensuite).
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
  const am=$('#authMessage');am.style.color='';am.textContent='';
}
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-act]');if(!t)return;
  const a=t.dataset.act,id=t.dataset.id;
  if(a==='view'){view=t.dataset.v;store.set('view',view);render();window.scrollTo(0,0);}
  else if(a==='prev'||a==='next'){cursor=addDays(cursor,(a==='next'?7:-7));render();}
  else if(a==='today'){cursor=startOfDay(new Date());render();}
  else if(a==='gotoweek'){cursor=startOfDay(new Date());view='agenda';store.set('view',view);render();window.scrollTo(0,0);}
  else if(a==='hwfilter'){hwFilter=t.dataset.v;render();}
  else if(a==='toggledone'){showDone=!showDone;render();}
  else if(a==='themeset'){setTheme(t.dataset.v);render();}
  else if(a==='colorreset'){delete colors[t.dataset.k];store.set('subjectColors',colors);pushSettings();render();}
  else if(a==='theme'){const p=store.get('themePreference',store.get('theme','system'));setTheme(p==='system'?'light':p==='light'?'dark':'system');}
  else if(a==='authmode'){setAuthMode(t.dataset.v);}
  else if(a==='logout'){const u=user;leaveApp();if(sb)sb.auth.signOut().catch(()=>{});}
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
  else if(a==='wordsreset'){words=DEFAULT_WORDS.slice();store.set('hwWords',words);classify();pushSettings();setStatus('Mots par défaut remis');render();}
  else if(a==='wipe'){
    if(t.dataset.sure==='1'){wipeAll();
    }else{
      t.dataset.sure='1';t.textContent='Confirmer : tout effacer';
      setTimeout(()=>{if(t.isConnected){t.dataset.sure='';t.textContent='Tout effacer';}},4000);
    }
  }
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
      if(!sb)throw new Error('Impossible de charger le service de comptes. Vérifie ta connexion et recharge la page.');
      if(password.length<8)throw new Error('Le mot de passe doit contenir au moins 8 caractères.');
      const btn=$('#authSubmit');if(btn)btn.disabled=true;
      showLoader(mode==='register'?'Création de ton compte…':'Connexion en cours…','Ton espace arrive.');
      let res;
      const exists=async()=>{try{const r=await sb.rpc('email_exists',{p_email:email});return r.error?null:!!r.data;}catch(x){return null;}};
      if(mode==='register'){
        if(await exists()===true)throw new Error('EXISTS');
        res=await sb.auth.signUp({email,password});
        if(res.error)throw res.error;
        if(res.data.user&&Array.isArray(res.data.user.identities)&&res.data.user.identities.length===0)throw new Error('EXISTS');
        localStorage.setItem('hasAccount','1');
        if(!res.data.session){
          if(btn)btn.disabled=false;
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
        localStorage.setItem('hasAccount','1');
      }
      user=res.data.session.user;
      await enterApp();
      setStatus(mode==='register'?'Compte créé':'Connecté');
    }catch(err){const btn=$('#authSubmit');if(btn)btn.disabled=false;if(msg){msg.style.color='';msg.textContent=frAuthError(err);}}finally{hideLoader();}
  }else if(f==='words'){
    words=$('#hwWords').value.split(',').map(s=>s.trim()).filter(Boolean);
    store.set('hwWords',words);classify();pushSettings();setStatus('Mots enregistrés');render();
  }
});
document.addEventListener('change',async e=>{
  const t=e.target;
  if(t.id==='icsFile'&&t.files[0]){
    try{
      const text=await t.files[0].text();
      if(!text.includes('BEGIN:VCALENDAR'))throw new Error("Ce fichier n'est pas un calendrier ICS");
      loadICS(text);store.set('icsText',text);store.set('demo',false);
      setStatus('Fichier importé : '+events.length+' événements');
      render();
    }catch(err){setStatus(err.message,true);}
  }else if(t.id==='notifOn'){
    const cfg=store.get('notif',{on:false,min:10});
    if(t.checked){
      if(typeof Notification==='undefined'){t.checked=false;setStatus('Notifications non supportées ici',true);return;}
      const perm=await Notification.requestPermission();
      if(perm!=='granted'){t.checked=false;setStatus('Permission de notification refusée',true);return;}
    }
    cfg.on=t.checked;store.set('notif',cfg);pushSettings();
  }else if(t.id==='notifMin'){
    const cfg=store.get('notif',{on:false,min:10});cfg.min=+t.value;store.set('notif',cfg);pushSettings();
  }else if(t.id==='lunchS'||t.id==='lunchE'){
    const l=Object.assign({s:'12:00',e:'13:00'},store.get('lunch',{}));
    if(t.value){l[t.id==='lunchS'?'s':'e']=t.value;store.set('lunch',l);render();}
  }else if(t.id==='agendaDate'){
    if(t.value){cursor=parseISO(t.value);render();}
  }else if(t.dataset&&t.dataset.color!==undefined){
    colors[t.dataset.color]=t.value;store.set('subjectColors',colors);pushSettings();render();
  }
});
// Garde en mémoire les sections de réglages ouvertes
document.addEventListener('toggle',e=>{const d=e.target;if(d&&d.dataset&&d.dataset.sec){if(d.open)openSecs.add(d.dataset.sec);else openSecs.delete(d.dataset.sec);}},true);

// ---------- Notifications (page ouverte uniquement) ----------
const notified=new Set();
function checkNotifs(){
  if(!session())return;
  const cfg=store.get('notif',{on:false,min:10});
  if(!cfg.on||typeof Notification==='undefined'||Notification.permission!=='granted')return;
  const now=Date.now();
  for(const ev of events){
    if(ev.kind!=='course'||ev.allDay||ev.status==='CANCELLED')continue;
    const diff=(ev.start-now)/60000;
    if(diff>0&&diff<=cfg.min&&!notified.has(ev.key)){
      notified.add(ev.key);
      new Notification(ev.title,{body:fmtTime(ev.start)+(ev.location?' · '+ev.location:'')});
    }
  }
  const d=new Date();
  if(d.getHours()>=18&&store.get('hwNotified','')!==isoDay(d)){
    const tom=isoDay(addDays(startOfDay(d),1)),due=todoItems().filter(h=>h.due===tom);
    if(due.length){store.set('hwNotified',isoDay(d));new Notification('Devoirs pour demain',{body:due.map(h=>h.title).join('\n')});}
  }
}

// ---------- Démarrage ----------
// Nettoyage des anciens réglages du relais (la clé n'est plus utilisée)
try{localStorage.removeItem('relay');localStorage.removeItem('relayKey');}catch(e){}
applyTheme(store.get('themePreference',store.get('theme','system')));
{const lb=$('#logoutBtn');if(lb)lb.innerHTML=svg('out',20);}
try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(store.get('themePreference',store.get('theme','system'))==='system')applyTheme('system');});}catch(e){}
setInterval(refresh,10*60000);
setInterval(()=>{if(user&&(view==='home'||view==='agenda')&&!typing())render();checkNotifs();},30000);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&user&&Date.now()-store.get('lastSync',0)>5*60000&&hasFeeds())refresh();
});
// Déconnexion depuis un autre onglet, ou session expirée
if(sb)sb.auth.onAuthStateChange(ev=>{if(ev==='SIGNED_OUT'&&user)leaveApp();});
(async function boot(){
  try{localStorage.removeItem('lapsusSession');localStorage.removeItem('lapsusLocalAccounts');}catch(e){}
  if(sb){
    try{const r=await sb.auth.getSession();user=r.data&&r.data.session?r.data.session.user:null;}catch(e){user=null;}
  }
  showLoader('Chargement en cours…','Ton espace arrive.');
  if(user){try{await enterApp();}catch(e){console.error(e);}}
  else{
    applyAuth();
    if(!sb){const m=$('#authMessage');if(m)m.textContent='Impossible de charger le service de comptes. Vérifie ta connexion et recharge la page.';}
  }
  hideLoader();
})();
