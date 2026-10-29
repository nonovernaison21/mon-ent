'use strict';

// ---------- Configuration ----------
// Adresse du relais (Cloudflare Worker) qui lit ton lien ICS à la place du navigateur.
// Cette adresse n'est pas secrète : le relais n'accepte que ton site et ton ENT.
const CONFIG={
  RELAY_URL:'https://ent-relais.nonovernaison21.workers.dev'
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
const store={
  get(k,d){try{const v=localStorage.getItem(k);return v===null?d:JSON.parse(v);}catch(e){return d;}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
};
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
function hue(s){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))%360;return h;}
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
let hwFeedEvents=store.get('hwFeedEvents',[]).map(reviveEvent);
let evalFeedEvents=store.get('evalFeedEvents',[]).map(reviveEvent);
let hw=store.get('homework',[]);
let autoDone=store.get('hwAutoDone',{});
let ctrlDone=store.get('ctrlDone',{});
let ov=store.get('overrides',{});
let words=store.get('hwWords',DEFAULT_WORDS.slice());
let hwShow='todo';
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
  return `<div class="ev${cancelled?' cancelled':''}" style="--h:${hue(ev.title)}">
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
  const todo=todoItems().slice(0,5);
  const horizon=addDays(now,14);
  const evals=evalItems().filter(e=>!e.done&&parseISO(e.due)>=startOfDay(now)&&parseISO(e.due)<horizon).slice(0,4);
  return `<h1>${esc(cap(fmtDay(now)))}</h1>
  <p class="sub">${esc(resume)}${store.get('demo',false)?' · exemple fictif':''}</p>
  <div class="hero">
    ${tile('En ce moment',cur,'Pas de cours en ce moment.')}
    ${tile(nxt?'Ensuite · '+nxtWhen:'Ensuite',nxt,'Aucun cours à venir.')}
  </div>
  <h2>Aujourd'hui</h2>${list(today.map(e=>evRow(e)).join(''),'Rien de prévu.')}
  <h2>Devoirs à faire</h2>${list(todo.map(hwRow).join(''),'Aucun devoir en attente.')}
  ${evals.length?`<h2>Contrôles à venir</h2>${groupedControls(evals)}`:''}`;
}
function viewAgenda(){
  const f=d=>d.toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
  let title,body;
  if(mode==='day'){
    title=cap(fmtDay(cursor));
    const l=sched(cursor);
    body=list(l.map(e=>evRow(e)).join(''),'Pas de cours ce jour.');
  }else if(mode==='week'){
    const mon=mondayOf(cursor);
    title=`${f(mon)} – ${f(addDays(mon,6))}`;
    let cols='';
    for(let i=0;i<7;i++){
      const d=addDays(mon,i),l=sched(d);
      if(i>=5&&!l.length)continue;
      cols+=`<section class="day${sameDay(d,new Date())?' today':''}"><h3>${esc(cap(d.toLocaleDateString('fr-FR',{weekday:'long'})))} <span>${d.getDate()}</span></h3>${list(l.map(e=>evRow(e)).join(''),'Rien')}</section>`;
    }
    body=`<div class="weekgrid">${cols}</div>`;
  }else{
    const y=cursor.getFullYear(),m=cursor.getMonth(),last=new Date(y,m+1,0);
    title=cap(cursor.toLocaleDateString('fr-FR',{month:'long',year:'numeric'}));
    let d=mondayOf(new Date(y,m,1));
    let cells=['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'].map(x=>`<div class="dow">${x}</div>`).join('');
    while(d<=last){
      for(let i=0;i<7;i++){
        const l=sched(d).filter(e=>e.status!=='CANCELLED');
        const hues=[...new Set(l.map(e=>hue(e.title)))].slice(0,6);
        cells+=`<button class="cell${d.getMonth()!==m?' out':''}${sameDay(d,new Date())?' today':''}" data-act="gotoday" data-d="${isoDay(d)}" aria-label="${esc(fmtDay(d))}">
          <span class="dn">${d.getDate()}</span>
          <span class="dots">${hues.map(h=>`<i class="dot" style="--h:${h}"></i>`).join('')}</span>
        </button>`;
        d=addDays(d,1);
      }
    }
    body=`<div class="month">${cells}</div>`;
  }
  const seg=[['day','Jour'],['week','Semaine'],['month','Mois']].map(([k,l])=>`<button class="${k===mode?'on':''}" data-act="mode" data-v="${k}">${l}</button>`).join('');
  return `<h1>${esc(title)}</h1>
  <div class="tools"><div class="seg">${seg}</div>
    <div class="step"><button class="btn" data-act="prev" aria-label="Précédent">‹</button><button class="btn" data-act="today">Aujourd'hui</button><button class="btn" data-act="next" aria-label="Suivant">›</button></div>
  </div>${body}`;
}
function viewHw(){
  const all=hwItems();
  const todo=todoItems(),done=all.filter(h=>h.done).sort((a,b)=>byDue(b,a));
  const items=hwShow==='todo'?todo:done;
  const subjects=[...new Set(events.filter(e=>e.kind==='course').map(e=>e.title))].sort();
  const controls=evalItems().filter(e=>parseISO(e.due)>=startOfDay(new Date()));
  return `<h1>Devoirs et contrôles</h1>
  <form class="add" data-form="hw">
    <div class="row"><input name="title" placeholder="Nouveau devoir" required aria-label="Devoir">
    <input name="subject" list="subs" placeholder="Matière" aria-label="Matière"><datalist id="subs">${subjects.map(s=>`<option value="${esc(s)}">`).join('')}</datalist>
    <input name="due" type="date" required value="${isoDay(addDays(startOfDay(new Date()),1))}" aria-label="Pour le">
    <button class="btn primary">Ajouter</button></div>
  </form>
  <h2>Devoirs par matière</h2>
  <div class="tools"><div class="seg"><button class="${hwShow==='todo'?'on':''}" data-act="hwshow" data-v="todo">À faire · ${todo.length}</button><button class="${hwShow==='done'?'on':''}" data-act="hwshow" data-v="done">Faits · ${done.length}</button></div></div>
  ${groupedHomework(items)||`<p class="empty">${hwShow==='todo'?'Aucun devoir en attente.':'Rien de fait pour le moment.'}</p>`}
  <h2>Contrôles et évaluations par matière</h2>
  ${controls.length?groupedControls(controls):`<p class="empty">Aucun contrôle à venir. Ajoute le lien ICS des contrôles dans les réglages.</p>`}
  <p class="foot">Les devoirs et les contrôles viennent de leurs liens ICS respectifs. Ils n’apparaissent plus dans l’agenda des cours.</p>`;
}
function viewSet(){
  const url=store.get('icsUrl',''),homeworkUrl=store.get('homeworkUrl',''),controlsUrl=store.get('controlsUrl',''),n=store.get('notif',{on:false,min:10});
  const themePref=store.get('themePreference',store.get('theme','system'));
  const account=store.get('lapsusSession',null);
  const authPanel=`<div class="panel"><p>Connecté en tant que <strong>${esc(account?account.email:'')}</strong></p><p class="m">Ce compte est enregistré sur cet appareil. Pour retrouver tes données sur plusieurs appareils, il faudra connecter Lapsus à un service de comptes en ligne.</p><button class="btn" type="button" data-act="logout">Se déconnecter</button></div>`;
  return `<h1>Réglages</h1>
  <h2>Compte utilisateur</h2>${authPanel}
  <h2>Apparence</h2><div class="panel"><label class="fl" for="themeSelect">Thème</label><select id="themeSelect"><option value="light"${themePref==='light'?' selected':''}>Clair</option><option value="dark"${themePref==='dark'?' selected':''}>Sombre</option><option value="system"${themePref==='system'?' selected':''}>Système (selon ton appareil)</option></select><p class="m">Le mode Système suit automatiquement le thème clair ou sombre de Windows, macOS, iOS ou Android.</p></div>
  <h2>Emploi du temps</h2>
  <form class="panel" data-form="url">
    <label class="fl" for="icsUrl">Lien ICS de l’emploi du temps</label>
    <div class="row"><input id="icsUrl" type="url" placeholder="https://... ou webcal://..." value="${esc(url)}" autocomplete="off"><button class="btn primary">Enregistrer et synchroniser</button></div>
    <p class="m">Ce lien sert uniquement aux cours et aux horaires de l’agenda.</p>
    <div class="row"><button type="button" class="btn" data-act="sync">Actualiser maintenant</button>
    <label class="btn" for="icsFile">Importer un fichier .ics</label><input id="icsFile" type="file" accept=".ics,text/calendar" hidden>
    <button type="button" class="btn" data-act="demo">Voir un exemple</button></div>
  </form>
  <h2>Source des devoirs</h2>
  <form class="panel" data-form="feeds">
    <label class="fl" for="homeworkUrl">Lien ICS des devoirs</label>
    <div class="row"><input id="homeworkUrl" type="url" placeholder="Lien du calendrier des devoirs" value="${esc(homeworkUrl)}" autocomplete="off"></div>
    <p class="m">Les devoirs seront affichés dans l’onglet Devoirs, regroupés par matière avec leur contenu.</p>
    <label class="fl" for="controlsUrl">Lien ICS des contrôles et évaluations</label>
    <div class="row"><input id="controlsUrl" type="url" placeholder="Lien du calendrier des contrôles" value="${esc(controlsUrl)}" autocomplete="off"></div>
    <p class="m">Les contrôles seront regroupés par matière dans Devoirs. Ils ne seront pas affichés dans l’agenda des cours.</p>
    <button class="btn primary">Enregistrer les liens et synchroniser</button>
  </form>
  <h2>Notifications</h2>
  <div class="panel">
    <div class="row"><label class="chk"><input type="checkbox" id="notifOn" ${n.on?'checked':''}> Rappel avant chaque cours</label>
    <select id="notifMin" aria-label="Délai du rappel">${[5,10,15,30].map(x=>`<option value="${x}"${x===n.min?' selected':''}>${x} min avant</option>`).join('')}</select></div>
    <p class="m">Fonctionne tant que cette page reste ouverte. Un rappel des devoirs du lendemain part aussi après 18 h.</p>
  </div>
  <h2>Données</h2>
  <div class="panel"><button class="btn danger" data-act="wipe">Tout effacer</button>
    <p class="m">Supprime les liens, les calendriers en cache, les devoirs et les réglages de ce navigateur.</p></div>`;
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
    hw=[{id:'ex1',title:'Réviser le chapitre 3 (exemple)',subject:'NSI',due:isoDay(addDays(startOfDay(new Date()),2)),done:false}];
    saveHw();
  }
  setStatus('Exemple chargé');
  render();
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
const ACCOUNT_KEY='lapsusLocalAccounts';
async function passwordHash(password,saltHex){
  if(!globalThis.crypto||!crypto.subtle)throw new Error('Le chiffrement du navigateur est indisponible. Ouvre Lapsus depuis une adresse HTTPS.');
  const bytesToHex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
  const salt=saltHex?Uint8Array.from(saltHex.match(/.{2}/g).map(x=>parseInt(x,16))):crypto.getRandomValues(new Uint8Array(16));
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:150000,hash:'SHA-256'},material,256);
  return {salt:bytesToHex(salt),hash:bytesToHex(bits)};
}
const session=()=>store.get('lapsusSession',null);
function gateHTML(mode){
  const reg=mode!=='login';
  return `<div class="gate-card">
    <div class="gate-brand"><img src="logo.svg" alt="" width="32" height="32"><span>Lapsus</span></div>
    <p class="sub">${reg?'Crée ton compte pour commencer.':'Content de te revoir.'}</p>
    <div class="seg"><button type="button" class="${reg?'on':''}" data-act="authmode" data-v="register">Créer un compte</button><button type="button" class="${reg?'':'on'}" data-act="authmode" data-v="login">Se connecter</button></div>
    <form data-form="auth" id="authForm">
      <input type="hidden" name="authmode" value="${reg?'register':'login'}">
      <label class="fl" for="authEmail">Adresse e-mail</label>
      <input id="authEmail" name="email" type="email" autocomplete="email" required placeholder="toi@exemple.fr">
      <label class="fl" for="authPassword">Mot de passe</label>
      <input id="authPassword" name="password" type="password" minlength="8" autocomplete="${reg?'new-password':'current-password'}" required placeholder="8 caractères minimum">
      <p class="m" id="authHelp">${reg?'Le compte est conservé dans ce navigateur. N’utilise pas un mot de passe important.':'Saisis l’adresse e-mail et le mot de passe utilisés sur cet appareil.'}</p>
      <button class="btn primary" id="authSubmit">${reg?'Créer mon compte':'Se connecter'}</button>
      <p class="m" id="authMessage" role="status"></p>
    </form>
  </div>`;
}
// Affiche l'écran de connexion tant que personne n'est connecté (la session reste mémorisée ensuite).
function applyAuth(){
  const locked=!session(),g=$('#gate');
  document.body.classList.toggle('locked',locked);
  if(!g)return;
  if(locked){g.hidden=false;g.innerHTML=gateHTML(Object.keys(store.get(ACCOUNT_KEY,{})).length?'login':'register');}
  else{g.hidden=true;g.innerHTML='';}
}
function setAuthMode(mode){
  const form=$('#authForm');if(!form)return;
  const register=mode!=='login';
  form.elements.authmode.value=register?'register':'login';
  const submit=$('#authSubmit'),pass=$('#authPassword'),help=$('#authHelp');
  submit.textContent=register?'Créer mon compte':'Se connecter';
  pass.autocomplete=register?'new-password':'current-password';
  help.textContent=register?'Le compte est conservé dans ce navigateur. N’utilise pas un mot de passe important.':'Saisis l’adresse e-mail et le mot de passe utilisés sur cet appareil.';
  form.querySelectorAll('[data-act="authmode"]').forEach(b=>b.classList.toggle('on',b.dataset.v===(register?'register':'login')));
  const sub=document.querySelector('#gate .sub');if(sub)sub.textContent=register?'Crée ton compte pour commencer.':'Content de te revoir.';
  $('#authMessage').textContent='';
}
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-act]');if(!t)return;
  const a=t.dataset.act,id=t.dataset.id;
  if(a==='view'){view=t.dataset.v;store.set('view',view);render();window.scrollTo(0,0);}
  else if(a==='mode'){mode=t.dataset.v;store.set('mode',mode);render();}
  else if(a==='prev'||a==='next'){
    const n=a==='next'?1:-1;
    if(mode==='day')cursor=addDays(cursor,n);
    else if(mode==='week')cursor=addDays(cursor,7*n);
    else cursor=new Date(cursor.getFullYear(),cursor.getMonth()+n,1);
    render();
  }
  else if(a==='today'){cursor=startOfDay(new Date());render();}
  else if(a==='gotoday'){cursor=parseISO(t.dataset.d);mode='day';view='agenda';store.set('mode',mode);store.set('view',view);render();}
  else if(a==='theme'){const p=store.get('themePreference',store.get('theme','system'));applyTheme(p==='system'?'light':p==='light'?'dark':'system');}
  else if(a==='authmode'){setAuthMode(t.dataset.v);}
  else if(a==='logout'){store.set('lapsusSession',null);setStatus('');applyAuth();window.scrollTo(0,0);}
  else if(a==='sync'){refresh();}
  else if(a==='demo'){loadDemo();}
  else if(a==='hwshow'){hwShow=t.dataset.v;render();}
  else if(a==='hwtoggle'){
    const h=hwItems().find(x=>x.id===id);
    if(h){
      if(h.auto){if(autoDone[id])delete autoDone[id];else autoDone[id]=true;store.set('hwAutoDone',autoDone);}
      else{const m=hw.find(x=>x.id===id);if(m){m.done=!m.done;saveHw();}}
      render();
    }
  }
  else if(a==='ctrltoggle'){
    if(ctrlDone[id])delete ctrlDone[id];else ctrlDone[id]=true;
    store.set('ctrlDone',ctrlDone);render();
  }
  else if(a==='hwdel'){hw=hw.filter(x=>x.id!==id);saveHw();render();}
  else if(a==='wordsreset'){words=DEFAULT_WORDS.slice();store.set('hwWords',words);classify();setStatus('Mots par défaut remis');render();}
  else if(a==='wipe'){
    if(t.dataset.sure==='1'){
      ['icsUrl','icsText','homeworkUrl','controlsUrl','hwICStext','evalICStext','hwFeedEvents','evalFeedEvents','lastSync','homework','notif','demo','hwNotified','hwAutoDone','ctrlDone','overrides','hwWords','lapsusSession','lapsusLocalAccounts','themePreference'].forEach(k=>{try{localStorage.removeItem(k);}catch(x){}});
      hw=[];events=[];hwFeedEvents=[];evalFeedEvents=[];autoDone={};ctrlDone={};ov={};words=DEFAULT_WORDS.slice();setStatus('');applyAuth();render();
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
    hw.push({id:Date.now().toString(36)+Math.random().toString(36).slice(2,5),title:fd.get('title').trim(),subject:fd.get('subject').trim(),due:fd.get('due'),done:false});
    saveHw();render();
  }else if(f==='url'){
    store.set('icsUrl',$('#icsUrl').value.trim());
    refresh();
  }else if(f==='feeds'){
    store.set('homeworkUrl',$('#homeworkUrl').value.trim());
    store.set('controlsUrl',$('#controlsUrl').value.trim());
    refresh();
  }else if(f==='auth'){
    const fd=new FormData(e.target),email=String(fd.get('email')||'').trim().toLowerCase(),password=String(fd.get('password')||''),mode=String(fd.get('authmode')||'register');
    const msg=$('#authMessage');
    try{
      if(password.length<8)throw new Error('Le mot de passe doit contenir au moins 8 caractères.');
      const accounts=store.get(ACCOUNT_KEY,{});
      const result=await passwordHash(password,mode==='login'&&accounts[email]?accounts[email].salt:null);
      if(mode==='register'){
        if(accounts[email])throw new Error('Un compte existe déjà avec cette adresse sur cet appareil.');
        accounts[email]={salt:result.salt,hash:result.hash,createdAt:Date.now()};store.set(ACCOUNT_KEY,accounts);
      }else{
        if(!accounts[email]||accounts[email].hash!==result.hash)throw new Error('Adresse e-mail ou mot de passe incorrect.');
      }
      store.set('lapsusSession',{email,connectedAt:Date.now()});
      applyAuth();setStatus(mode==='register'?'Compte créé':'Connecté');render();window.scrollTo(0,0);
      if(store.get('icsUrl','')||store.get('homeworkUrl','')||store.get('controlsUrl',''))refresh();
    }catch(err){if(msg)msg.textContent=err.message;}
  }else if(f==='words'){
    words=$('#hwWords').value.split(',').map(s=>s.trim()).filter(Boolean);
    store.set('hwWords',words);classify();setStatus('Mots enregistrés');render();
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
    cfg.on=t.checked;store.set('notif',cfg);
  }else if(t.id==='notifMin'){
    const cfg=store.get('notif',{on:false,min:10});cfg.min=+t.value;store.set('notif',cfg);
  }else if(t.id==='themeSelect'){
    applyTheme(t.value);
  }
});

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
applyAuth();
try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(store.get('themePreference',store.get('theme','system'))==='system')applyTheme('system');});}catch(e){}
const cached=store.get('icsText','');
if(cached){try{loadICS(cached);}catch(e){console.error(e);}}
const cachedHw=store.get('hwICStext','');
if(cachedHw){try{hwFeedEvents=parseICS(cachedHw).events.sort((a,b)=>a.start-b.start);store.set('hwFeedEvents',hwFeedEvents);}catch(e){console.error(e);}}
const cachedEval=store.get('evalICStext','');
if(cachedEval){try{evalFeedEvents=parseICS(cachedEval).events.sort((a,b)=>a.start-b.start);store.set('evalFeedEvents',evalFeedEvents);}catch(e){console.error(e);}}
const last=store.get('lastSync',0);
if(last)setStatus('Dernière synchro : '+new Date(last).toLocaleString('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}));
render();
if(store.get('icsUrl','')||store.get('homeworkUrl','')||store.get('controlsUrl',''))refresh();
setInterval(refresh,10*60000);
setInterval(()=>{if((view==='home'||view==='agenda')&&!typing())render();checkNotifs();},30000);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&Date.now()-store.get('lastSync',0)>5*60000&&(store.get('icsUrl','')||store.get('homeworkUrl','')||store.get('controlsUrl','')))refresh();
});
