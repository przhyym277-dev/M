'use strict';

const Groq = require('groq-sdk');
const { handleFunCommand, addToHistory } = require('./group-commands');
const { handleAdminCommand, handleAutoModeration, handleWelcome } = require('./group-admin');

const GLOBAL_SUPER_ADMINS = new Set(['972522091733', '972508181322']);
const BOT_OWNERS = { '972522091733': 'יאיר פרץ', '972508181322': 'יאיר פריש' };
const GROQ_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
let groqKeyIdx = 0;
async function askGroqReply(question) {
    for (let i = 0; i < GROQ_KEYS.length; i++) {
        try {
            const client = new Groq({ apiKey: GROQ_KEYS[groqKeyIdx % GROQ_KEYS.length] });
            const r = await client.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: 'אתה בוט ווטסאפ חכם ומצחיק. ענה בעברית, קצר, עם אמוג\'י. הבעלים שלך הם יאיר פרץ ויאיר פריש.' },
                    { role: 'user', content: question },
                ],
                max_tokens: 300, temperature: 0.8,
            });
            return r.choices[0]?.message?.content?.trim() || null;
        } catch (err) {
            if ((err.status === 429 || err.message?.includes('429')) && i < GROQ_KEYS.length - 1) { groqKeyIdx++; continue; }
            return null;
        }
    }
    return null;
}

function getGroupText(msg) {
    return msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
}

const normJid = (id) => (id || '').replace(/:.*@/, '@');

const ALLOWED_GROUP_ADDERS = ['972522091733', '972508181322'];

async function handleGroupMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    const text = getGroupText(msg).trim();
    const senderJid = normJid(msg.key.participant || msg.participant || '');

    console.log(`👥 [קבוצה] ${jid.split('@')[0].slice(-6)} | ${msg.pushName || senderJid.split('@')[0]}: ${text || '[מדיה]'}`);

    if (!text && !msg.message?.audioMessage && !msg.message?.stickerMessage) return;

    let isSenderAdmin = false;
    let isBotAdmin = false;
    let groupParticipants = [];
    try {
        const meta = await sock.groupMetadata(jid);
        const botJid = normJid(sock.user?.id || '');
        const botPhone = (process.env.OWNER_PHONE || '').replace(/\D/g, '');
        const botLid   = (process.env.OWNER_LID   || '').replace(/\D/g, '');
        isSenderAdmin = meta.participants.some(p => normJid(p.id) === senderJid && p.admin)
            || GLOBAL_SUPER_ADMINS.has(senderJid.split('@')[0]);
        isBotAdmin    = meta.participants.some(p => {
            const pid = normJid(p.id);
            const num = pid.replace(/\D/g, '');
            return p.admin && (pid === botJid || num === botPhone || num === botLid);
        });
        groupParticipants = meta.participants.map(p => normJid(p.id));
        console.log(`🔍 senderJid=${senderJid} isSenderAdmin=${isSenderAdmin} botJid=${botJid} isBotAdmin=${isBotAdmin}`);
    } catch {}

    const moderated = await handleAutoModeration(sock, msg, jid, senderJid, isBotAdmin, isSenderAdmin);
    if (moderated) return;

    if (!text) return;

    if (text) addToHistory(jid, msg.pushName || senderJid.split('@')[0], text);

    // ── תגובה לבוט → AI ───────────────────────────────────────
    const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
    const botPhoneNum = normJid(sock.user?.id || '').split('@')[0].replace(/\D/g, '');
    const botLidNum   = (process.env.OWNER_LID || '').replace(/\D/g, '');
    const ctxNum      = (ctxInfo?.participant || '').replace(/\D/g, '');
    const isReplyToBot = ctxInfo?.fromMe === true
        || (ctxNum && botPhoneNum && ctxNum === botPhoneNum)
        || (ctxNum && botLidNum   && ctxNum === botLidNum);
    if (isReplyToBot && text) {
        const reply = await askGroqReply(text);
        if (reply) await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        return;
    }

    const funHandled = await handleFunCommand(sock, msg, jid, text, msg.pushName || '', groupParticipants, senderJid);
    if (funHandled) return;

    await handleAdminCommand(sock, msg, jid, text, senderJid, isSenderAdmin, isBotAdmin);
}

async function handleGroupParticipantUpdate(sock, id, participants, action) {
    if (action === 'add') {
        // Check if the bot itself was just added to the group
        const botPhone = normJid(sock.user?.id || '').split('@')[0].replace(/\D/g, '');
        const botWasAdded = participants.some(p => normJid(p).split('@')[0].replace(/\D/g, '') === botPhone);
        if (botWasAdded) {
            try {
                const meta = await sock.groupMetadata(id);
                const admins = meta.participants.filter(p => p.admin);
                const allowed = admins.some(a => {
                    const num = normJid(a.id).split('@')[0].replace(/\D/g, '');
                    return ALLOWED_GROUP_ADDERS.includes(num);
                });
                if (!allowed) {
                    await sock.sendMessage(id, { text: '🚫 אין לי הרשאה להצטרף לקבוצה זו. להצטרפות פנה למנהל מורשה.' });
                    await sock.groupLeave(id);
                    return;
                }
            } catch {}
        }
        try { await handleWelcome(sock, id, participants); } catch {}
    }
}

module.exports = { handleGroupMessage, handleGroupParticipantUpdate };
