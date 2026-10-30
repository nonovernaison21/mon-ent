function render(){
  const todo=todoItems().length;
  $('#nav').innerHTML=VIEWS.map(([k,l,ic])=>`<button class="nv${k===view?' on':''}" data-act="view" data-v="${k}"${k===view?' aria-current="page"':''}>${svg(ic)}<span>${l}</span>${k==='hw'&&todo?`<i class="n">${todo}</i>`:''}</button>`).join('');
  const f={
    home:viewHome,agenda:viewAgenda,hw:viewHw,set:viewSet,
    'lycee-mail':viewLyceeMail,'lycee-actu':viewLyceeActu,'lycee-cahier':viewLyceeCahier,'lycee-profil':viewLyceeProfil,
    'connexion-ent':viewConnexionEnt,'connexion-apparence':viewConnexionApparence,'connexion-couleurs':viewConnexionCouleurs,'connexion-compte':viewConnexionCompte
  }[view]||viewHome;
  $('#main').innerHTML=f();
}