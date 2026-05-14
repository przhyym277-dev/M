'use strict';
require('dotenv').config();

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');

const { handleFunCommand } = require('./group-commands');
const { handleAdminCommand, handleAutoModeration, handleWelcome } = require('./group-admin');

let groupSock = null;
let groupBotStatus = 'waiting';
let groupCurrentQR = null;

function getText(msg) {
    return msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
}

async function startGroupBot(httpServer) {
    // Register HTTP routes on the shared server
    if (httpServer) {
        const origListeners = httpServer.listeners('request');
        httpServer.removeAllListeners('request');
        httpServer.on('request', async (req, res) => {
            if (req.url === '/qr-group') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html dir="rtl"><head>
<meta charset="utf-8"/><title>חיבור בוט חברים</title>
<style>body{margin:0;font-family:sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:16px;padding:32px;text-align:center;box-shadow:0 2px 16px #0001;width:300px}h2{margin:0 0 8px;color:#111}#qr-img{width:240px;height:240px;border-radius:8px;display:block;margin:0 auto}#msg{margin-top:12px;font-size:13px;color:#888}</style></head>
<body><div class="box"><h2>בוט חברים 🤖</h2><p style="color:#888;font-size:13px;margin-bottom:16px">סרוק עם מספר הבוט</p>
<img id="qr-img" src="" alt="טוען..."/>
<div id="msg">ממתין לסריקה...</div></div>
<script>
async function refresh(){
  try{
    const r=await fetch('/qr-group-image').then(x=>x.json());
    if(r.img){document.getElementById('qr-img').src=r.img;}
    if(r.status==='connected'){document.getElementById('msg').textContent='✅ מחובר!';document.getElementById('qr-img').style.display='none';}
  }catch(e){}
  setTimeout(refresh,2500);
}
refresh();
</script></body></html>`);
                return;
            }
            if (req.url === '/qr-group-image') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (groupBotStatus === 'connected') { res.end(JSON.stringify({ status: 'connected' })); return; }
                if (!groupCurrentQR) { res.end(JSON.stringify({ status: groupBotStatus })); return; }
                const img = await QRCode.toDataURL(groupCurrentQR, { width: 260, margin: 2 });
                res.end(JSON.stringify({ img, status: groupBotStatus }));
                return;
            }
            // Pass through to original handlers
            for (const l of origListeners) l.call(httpServer, req, res);
        });
    }

    await connectGroupBot();
}

async function connectGroupBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_state_group');
    const { version } = await fetchLatestBaileysVersion();

    groupSock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['בוט חברים', 'Chrome', '1.0'],
    });

    groupSock.ev.on('creds.update', saveCreds);

    groupSock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { groupCurrentQR = qr; groupBotStatus = 'waiting'; console.log('📱 [GroupBot] QR זמין — /qr-group'); }
        if (connection === 'open')  { groupCurrentQR = null; groupBotStatus = 'connected'; console.log('✅ [GroupBot] מחובר!'); }
        if (connection === 'close') {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const reconnect = code !== DisconnectReason.loggedOut && code !== DisconnectReason.connectionReplaced;
            console.log('⚠️ [GroupBot] התנתק, קוד:', code);
            groupBotStatus = 'waiting';
            if (reconnect) setTimeout(connectGroupBot, 3000);
        }
    });

    // Welcome new participants
    groupSock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        if (action === 'add') {
            try { await handleWelcome(groupSock, id, participants); } catch {}
        }
    });

    groupSock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                if (msg.key.fromMe) continue;
                const jid = msg.key.remoteJid;
                if (!jid || !jid.endsWith('@g.us')) continue;

                const text = getText(msg).trim();
                if (!text && !msg.message?.audioMessage && !msg.message?.stickerMessage) continue;

                const senderJid = msg.key.participant || msg.participant || '';

                // Get group metadata to check roles
                let isSenderAdmin = false;
                let isBotAdmin = false;
                try {
                    const meta = await groupSock.groupMetadata(jid);
                    const botJid = groupSock.user?.id?.replace(/:.*@/, '@') || '';
                    isSenderAdmin = meta.participants.some(p => p.id === senderJid && p.admin);
                    isBotAdmin    = meta.participants.some(p => p.id === botJid && p.admin);
                } catch {}

                // Auto-moderation (link/sticker removal)
                const moderated = await handleAutoModeration(groupSock, msg, jid, senderJid, isBotAdmin);
                if (moderated) continue;

                if (!text) continue;

                // Group participants for שידוך
                let groupParticipants = [];
                try {
                    const meta = await groupSock.groupMetadata(jid);
                    groupParticipants = meta.participants.map(p => p.id);
                } catch {}

                // Fun commands
                const funHandled = await handleFunCommand(groupSock, msg, jid, text, msg.pushName || '', groupParticipants);
                if (funHandled) continue;

                // Admin commands
                await handleAdminCommand(groupSock, msg, jid, text, senderJid, isSenderAdmin, isBotAdmin);

            } catch (err) {
                console.error('❌ [GroupBot] שגיאה:', err.message);
            }
        }
    });
}

module.exports = { startGroupBot };
