'use strict';
function normalizeText(input){return String(input||'').normalize('NFKC').toLowerCase().replace(/[ًٌٍَُِّْـ]/g,'').replace(/[إأآٱ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/\s+/g,' ').trim();}
module.exports={normalizeText};