'use strict';
const {normalizeText}=require('./normalizer');
function score(text,patterns){const t=normalizeText(text);let s=0;for(const x of patterns||[]){const p=normalizeText(typeof x==='string'?x:x.phrase),w=typeof x==='string'?2:Number(x.weight||1);if(t===p)s+=w+5;else if(t.includes(p))s+=w;}return s}
function rank(text,intents){return Object.entries(intents).map(([id,c])=>({id,score:score(text,c.patterns)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score)}module.exports={score,rank};