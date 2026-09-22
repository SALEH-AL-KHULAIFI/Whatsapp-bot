'use strict';
const {normalizeText}=require('./normalizer');
const {rank}=require('./scorer');
const intents=require('../data/intents');
const legacy=require('../replies');
const generated=require('../responses/generated');
const catalog=require('../responses/catalog');
const {brand}=require('../responses/branding');

function pick(a){return a[Math.floor(Math.random()*a.length)]}
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h>>>0}

function getReply(text){
 const clean=normalizeText(text); if(!clean)return null;
 const old=legacy.getAutomaticReply(clean); if(old)return brand(old,'legacy');
 const ranked=rank(clean,intents);
 if(ranked.length&&ranked[0].score>=5){
  const top=ranked[0],second=ranked[1];
  if(!second||top.score-second.score>=2||top.score>=9)return brand(pick(intents[top.id].responses),intents[top.id].category);
 }
 for(const [key,patterns] of Object.entries(catalog.intentPatterns)){
  if(patterns.some(x=>clean.includes(normalizeText(x))))return brand(catalog.getCatalogReply(key,hash(clean)),key);
 }
 return brand(generated.getReply(clean)||null);
}
module.exports={getReply};