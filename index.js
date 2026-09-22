const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
let getReply = null;
const unknownEscalation = require('./responses/unknown_escalation');
const unknownAttempts = new Map();

const app = express();
const PORT = Number(process.env.PORT || 3000);

let latestQr = null;
let latestQrDataUrl = null;
let connected = false;
let starting = false;
let reconnectTimer = null;
let activeSocket = null;
let socketGeneration = 0;
let qrVersion = 0;

const AUTH_DIR = path.join(__dirname, 'auth');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_BUCKET = 'whatsapp-auth';
const supabase = SUPABASE_URL && SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
  : null;
let authSyncTimer = null;
let authSyncRunning = false;
let authSyncQueued = false;

// Anti-spam / safety controls.
// These limits only affect automatic replies; the bot never initiates chats.
const userReplyState = new Map();
const duplicateState = new Map();
const processedMessageIds = new Map();
const conversationHistory = new Map();

const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_REPLIES = 30;
const PER_USER_COOLDOWN_MS = 1200;
const DUPLICATE_BLOCK_MS = 8 * 1000;
const GLOBAL_SEND_COOLDOWN_MS = 250;
let lastAutomaticSendAt = 0;

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function isBroadcastJid(jid) {
  return typeof jid === 'string' && (jid === 'status@broadcast' || jid.endsWith('@broadcast'));
}

function isSpamOrDuplicate(jid, normalizedText, messageId) {
  const now = Date.now();

  if (messageId) {
    const processedAt = processedMessageIds.get(messageId) || 0;
    if (processedAt && now - processedAt < RATE_WINDOW_MS) return true;
    processedMessageIds.set(messageId, now);
  }

  const state = userReplyState.get(jid) || { timestamps: [], lastReplyAt: 0 };

  state.timestamps = state.timestamps.filter((time) => now - time < RATE_WINDOW_MS);

  if (now - state.lastReplyAt < PER_USER_COOLDOWN_MS) {
    userReplyState.set(jid, state);
    return true;
  }

  const duplicateKey = jid + ':' + normalizedText;
  const lastSameMessageAt = duplicateState.get(duplicateKey) || 0;
  if (now - lastSameMessageAt < DUPLICATE_BLOCK_MS) {
    return true;
  }

  if (state.timestamps.length >= RATE_MAX_REPLIES) {
    userReplyState.set(jid, state);
    return true;
  }

  state.timestamps.push(now);
  state.lastReplyAt = now;
  userReplyState.set(jid, state);
  duplicateState.set(duplicateKey, now);

  // Keep memory bounded on a long-running Render instance.
  if (userReplyState.size > 2000) {
    for (const [key, value] of userReplyState) {
      if (now - value.lastReplyAt > RATE_WINDOW_MS) userReplyState.delete(key);
    }
  }
  if (duplicateState.size > 5000) {
    for (const [key, value] of duplicateState) {
      if (now - value > DUPLICATE_BLOCK_MS) duplicateState.delete(key);
    }
  }
  if (processedMessageIds.size > 10000) {
    for (const [key, value] of processedMessageIds) {
      if (now - value > RATE_WINDOW_MS) processedMessageIds.delete(key);
    }
  }

  return false;
}

function getConversationHistory(jid) {
  return conversationHistory.get(jid) || [];
}

function rememberConversation(jid, role, text) {
  const history = conversationHistory.get(jid) || [];
  history.push({ role, text: String(text || '').slice(0, 4000) });
  while (history.length > 10) history.shift();
  conversationHistory.set(jid, history);

  if (conversationHistory.size > 2000) {
    const first = conversationHistory.keys().next().value;
    if (first) conversationHistory.delete(first);
  }
}

async function sendBotText(sock, jid, text) {
  if (!text) return false;
  const sent = await sendAutomaticReply(sock, jid, text);
  if (sent) rememberConversation(jid, 'model', text);
  return sent;
}

async function sendAutomaticReply(sock, jid, reply) {
  const now = Date.now();
  const wait = Math.max(0, GLOBAL_SEND_COOLDOWN_MS - (now - lastAutomaticSendAt));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  if (!sock || !connected || sock !== activeSocket) return false;
  await sock.sendMessage(jid, { text: reply });
  lastAutomaticSendAt = Date.now();
  return true;
}

async function ensureSupabaseBucket() {
  if (!supabase) throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');

  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw new Error('Supabase bucket check failed: ' + listError.message);

  if (!buckets.some((bucket) => bucket.name === SUPABASE_BUCKET)) {
    const { error } = await supabase.storage.createBucket(SUPABASE_BUCKET, {
      public: false
    });
    if (error && !String(error.message).toLowerCase().includes('already exists')) {
      throw new Error('Supabase bucket creation failed: ' + error.message);
    }
    console.log('Created private Supabase bucket: ' + SUPABASE_BUCKET);
  }
}

async function restoreAuthFromSupabase() {
  if (!supabase) throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');

  await fs.promises.mkdir(AUTH_DIR, { recursive: true });
  await ensureSupabaseBucket();

  const { data: files, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .list('', { limit: 1000, sortBy: { column: 'name', order: 'asc' } });

  if (error) throw new Error('Supabase auth list failed: ' + error.message);

  let restored = 0;
  for (const file of files || []) {
    if (!file?.name) continue;

    const { data, error: downloadError } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .download(file.name);

    if (downloadError) {
      throw new Error('Supabase auth download failed for ' + file.name + ': ' + downloadError.message);
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    await fs.promises.writeFile(path.join(AUTH_DIR, file.name), buffer);
    restored++;
  }

  console.log('Restored ' + restored + ' WhatsApp auth file(s) from Supabase.');
}

async function syncAuthToSupabase() {
  if (!supabase) return;
  if (authSyncRunning) {
    authSyncQueued = true;
    return;
  }

  authSyncRunning = true;
  try {
    await ensureSupabaseBucket();
    const files = await fs.promises.readdir(AUTH_DIR, { withFileTypes: true });
    const localFiles = files.filter((file) => file.isFile()).map((file) => file.name);

    for (const fileName of localFiles) {
      const buffer = await fs.promises.readFile(path.join(AUTH_DIR, fileName));
      const { error } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(fileName, buffer, {
          upsert: true,
          contentType: 'application/json'
        });

      if (error) {
        throw new Error('Supabase auth upload failed for ' + fileName + ': ' + error.message);
      }
    }

    console.log('WhatsApp auth synced to Supabase (' + localFiles.length + ' file(s)).');
  } finally {
    authSyncRunning = false;
    if (authSyncQueued) {
      authSyncQueued = false;
      scheduleAuthSync();
    }
  }
}

function scheduleAuthSync() {
  clearTimeout(authSyncTimer);
  authSyncTimer = setTimeout(() => {
    syncAuthToSupabase().catch((error) => {
      console.error('Auth sync error:', error.message);
    });
  }, 1500);
}

async function clearAuthStateEverywhere() {
  clearTimeout(authSyncTimer);
  authSyncTimer = null;
  authSyncQueued = false;

  await fs.promises.mkdir(AUTH_DIR, { recursive: true });

  const localFiles = await fs.promises.readdir(AUTH_DIR, { withFileTypes: true });
  for (const file of localFiles) {
    if (file.isFile()) {
      await fs.promises.rm(path.join(AUTH_DIR, file.name), { force: true });
    }
  }

  if (supabase) {
    await ensureSupabaseBucket();
    const { data: files, error: listError } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .list('', { limit: 1000 });

    if (listError) throw new Error('Supabase auth cleanup list failed: ' + listError.message);

    const names = (files || []).filter((file) => file?.name).map((file) => file.name);
    if (names.length) {
      const { error: removeError } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .remove(names);

      if (removeError) throw new Error('Supabase auth cleanup failed: ' + removeError.message);
    }
  }

  console.log('Cleared logged-out WhatsApp auth state from local storage and Supabase.');
}

async function updateQr(qr) {
  latestQr = qr;
  latestQrDataUrl = await QRCode.toDataURL(qr, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 420
  });
  qrVersion++;
}

app.get('/', (req, res) => {
  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Bot</title>
<style>
body{font-family:Arial,sans-serif;text-align:center;background:#f5f5f5;margin:0;padding:24px}
.card{max-width:520px;margin:auto;background:white;border-radius:18px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.1)}
#qr{width:420px;max-width:92vw;height:auto;border-radius:8px}
.status{font-size:18px;margin:14px 0}
button{padding:10px 18px;border:0;border-radius:10px;cursor:pointer}
</style>
</head>
<body>
<div class="card">
<h2>WhatsApp Bot</h2>
<div id="status" class="status">جاري تحميل حالة الاتصال...</div>
<div id="qrbox"></div>
<p>WhatsApp → Linked devices → Link a device</p>
</div>
<script>
let lastVersion = -1;

async function refreshState(){
  try{
    const r = await fetch('/qr-state?t=' + Date.now(), {cache:'no-store'});
    const s = await r.json();

    const status = document.getElementById('status');
    const box = document.getElementById('qrbox');

    if(s.connected){
      status.textContent = '✅ WhatsApp متصل';
      box.innerHTML = '';
      return;
    }

    if(s.qr){
      status.textContent = '📱 امسح رمز QR من واتساب';
      if(s.version !== lastVersion){
        box.innerHTML = '<img id="qr" src="' + s.qr + '" alt="WhatsApp QR">';
        lastVersion = s.version;
      }
    } else {
      status.textContent = '⏳ جاري تجهيز رمز QR...';
    }
  }catch(e){
    document.getElementById('status').textContent = '⚠️ تعذر الحصول على حالة البوت';
  }
}

refreshState();
setInterval(refreshState, 1000);
</script>
</body>
</html>`);
});

app.get('/qr-state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    connected,
    qr: latestQrDataUrl,
    version: qrVersion
  });
});

app.get('/health', (req, res) => res.status(200).json({
  status: 'ok',
  connected,
  qrAvailable: Boolean(latestQr)
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log('HTTP server listening on port ' + PORT);
  try {
    ({ getReply } = require('./engine'));
    console.log('Local reply engine loaded successfully.');
  } catch (engineError) {
    console.error('Local reply engine load error:', engineError?.message || engineError);
  }
});

async function scheduleReconnect(delay = 5000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await startBot();
  }, delay);
}

async function startBot() {
  if (starting || (activeSocket && connected)) return;
  starting = true;
  const generation = ++socketGeneration;

  try {
    await restoreAuthFromSupabase();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    activeSocket = sock;

    sock.ev.on('creds.update', async (update) => {
      await saveCreds(update);
      scheduleAuthSync();
    });

    sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
      if (generation !== socketGeneration || sock !== activeSocket) return;

      if (qr) {
        connected = false;
        try {
          await updateQr(qr);
          console.log('New WhatsApp QR generated.');
        } catch (err) {
          console.error('QR generation error:', err);
        }
      }

      if (connection === 'open') {
        connected = true;
        latestQr = null;
        latestQrDataUrl = null;
        starting = false;
        console.log('WhatsApp connected successfully.');
        scheduleAuthSync();
      }

      if (connection === 'close') {
        connected = false;
        latestQr = null;
        latestQrDataUrl = null;
        starting = false;
        const code = lastDisconnect?.error?.output?.statusCode;

        if (sock === activeSocket) activeSocket = null;
        if (code !== DisconnectReason.loggedOut) {
          console.log('Connection closed; reconnecting in 5 seconds...');
          scheduleReconnect(5000);
        } else {
          console.log('WhatsApp logged out. Clearing old auth and preparing a fresh QR...');
          try {
            await clearAuthStateEverywhere();
            scheduleReconnect(1500);
          } catch (cleanupError) {
            console.error('Logged-out auth cleanup error:', cleanupError);
            console.log('Fresh QR cannot be generated until old auth is cleared.');
          }
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (generation !== socketGeneration || sock !== activeSocket) return;
      if (type !== 'notify') return;

      for (const msg of messages || []) {
        if (!msg?.message) continue;

        const jid = msg.key?.remoteJid || '';
        const messageId = msg.key?.id || '';

        if (msg.key?.fromMe) {
          console.log('Incoming message ignored: fromMe=true.');
          continue;
        }

        if (isGroupJid(jid) || isBroadcastJid(jid)) {
          console.log('Incoming message ignored: group/broadcast.');
          continue;
        }

        // Baileys can wrap normal text inside ephemeral/view-once messages.
        // Unwrap these layers so the local reply engine always receives the text.
        function unwrapMessage(message) {
          let current = message;
          for (let i = 0; i < 4 && current; i++) {
            if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
            else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
            else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
            else break;
          }
          return current || message;
        }

        const body = unwrapMessage(msg.message);
        const text =
          body.conversation ||
          body.extendedTextMessage?.text ||
          body.imageMessage?.caption ||
          body.videoMessage?.caption ||
          body.documentMessage?.caption ||
          body.documentWithCaptionMessage?.message?.documentMessage?.caption ||
          '';

        console.log('Incoming WhatsApp message:', JSON.stringify({
          jid,
          messageId,
          type,
          hasText: Boolean(String(text).trim())
        }));

        if (!String(text).trim()) {
          console.log('Incoming message has no supported text/caption.');
          continue;
        }

        const normalized = text
          .trim()
          .toLowerCase()
          .replace(/[ًٌٍَُِّْـ]/g, '')
          .replace(/[إأآ]/g, 'ا')
          .replace(/ة/g, 'ه')
          .replace(/ى/g, 'ي')
          .replace(/[؟?!.,،؛:]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (!normalized) continue;

        if (isSpamOrDuplicate(jid, normalized, msg.key.id)) {
          console.log('Automatic reply suppressed by anti-spam/rate-limit.');
          continue;
        }

        rememberConversation(jid, 'user', normalized);

        try {
          if (typeof getReply !== 'function') throw new Error('Local reply engine is not loaded.');
          const localReply = getReply(normalized);
          let reply;
          if (localReply) {
            unknownAttempts.delete(jid);
            reply = localReply;
          } else {
            const attempts = (unknownAttempts.get(jid) || 0) + 1;
            unknownAttempts.set(jid, Math.min(attempts, unknownEscalation.LEVELS.length));
            reply = unknownEscalation.getEscalationReply(attempts - 1);
            console.log('Unknown-request escalation level:', Math.min(attempts, unknownEscalation.LEVELS.length));
          }
          const sent = await sendBotText(sock, jid, reply);
          if (sent) console.log('Local reply sent.');
        } catch (sendError) {
          console.error('Automatic reply error:', sendError?.message || sendError);
          try {
            await sendBotText(sock, jid, '⚠️ حدث خطأ مؤقت أثناء معالجة رسالتك. أعد المحاولة بعد لحظة.');
          } catch (fallbackError) {
            console.error('Fallback reply error:', fallbackError?.message || fallbackError);
          }
        }
      }
    });
  } catch (err) {
    starting = false;
    if (activeSocket && generation === socketGeneration) activeSocket = null;
    console.error('Bot startup error:', err);
    scheduleReconnect(5000);
  }
}

startBot();
