'use strict';

const Groq = require('groq-sdk');
const { handleFunCommand, addToHistory, groupHistory } = require('./group-commands');
const { handleAdminCommand, handleAutoModeration, handleWelcome, checkDailyLimit, incrementDailyCount } = require('./group-admin');
const { getMoviesActiveGroupJid, setMoviesActiveGroupJid } = require('./private-bot');

const GLOBAL_SUPER_ADMINS = new Set(['972522091733', '972508181322', '98668719951947', '188150102098030']);
const BOT_OWNERS = { '972522091733': 'יאיר פרץ', '972508181322': 'יאיר פריש' };
const GROQ_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
let groqKeyIdx = 0;
const groupAiHistory = new Map(); // jid → [{role, content}]

const SYSTEM_PROMPT = `אתה "בוטי" — חבר הכי מצחיק של הקבוצה, לא בוט רשמי.
דבר בעברית לא פורמלית, קצר, עם סלנג ואמוג'י.
תגובות קצרות — משפט-שניים מקסימום אלא אם ממש ביקשו להרחיב.
יש לך חוצפה מצחיקה, תמיד עם twist. אל תהיה שמלה ואל תסביר את עצמך.
אל תגלה מי הבעלים שלך אלא אם שאלו ישירות.`;

async function askGroqReply(question, groupJid) {
    if (!groupAiHistory.has(groupJid)) groupAiHistory.set(groupJid, []);
    const history = groupAiHistory.get(groupJid);

    // הוסף הקשר מהשיחה הכללית של הקבוצה
    const recent = (groupHistory.get(groupJid) || []).slice(-12);
    const contextBlock = recent.length
        ? `\nמה שדיברו לאחרונה בקבוצה:\n${recent.map(m => `${m.sender}: ${m.text}`).join('\n')}`
        : '';

    history.push({ role: 'user', content: question });
    if (history.length > 16) history.splice(0, history.length - 16);

    for (let i = 0; i < GROQ_KEYS.length; i++) {
        try {
            const client = new Groq({ apiKey: GROQ_KEYS[groqKeyIdx % GROQ_KEYS.length] });
            const r = await client.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT + contextBlock },
                    ...history,
                ],
                max_tokens: 200, temperature: 0.9,
            });
            const reply = r.choices[0]?.message?.content?.trim() || null;
            if (reply) history.push({ role: 'assistant', content: reply });
            return reply;
        } catch (err) {
            if ((err.status === 429 || err.message?.includes('429')) && i < GROQ_KEYS.length - 1) { groqKeyIdx++; continue; }
            history.pop();
            return null;
        }
    }
    history.pop();
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

    // ── בדיקת מגבלת הודעות יומית ─────────────────────────────
    if (!GLOBAL_SUPER_ADMINS.has(senderJid.split('@')[0]) && !checkDailyLimit(jid)) return;

    if (text) addToHistory(jid, msg.pushName || senderJid.split('@')[0], text);

    // ── תגובה לבוט → AI ───────────────────────────────────────
    const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
    const botPhoneNum = normJid(sock.user?.id || '').split('@')[0].replace(/\D/g, '');
    const botLidNum   = normJid(sock.user?.lid || process.env.OWNER_LID || '').split('@')[0].replace(/\D/g, '');
    const ctxParticipant = ctxInfo?.participant || '';
    const ctxNum      = ctxParticipant.replace(/\D/g, '');
    const isReplyToBot = ctxInfo?.fromMe === true
        || (ctxNum && botPhoneNum && ctxNum === botPhoneNum)
        || (ctxNum && botLidNum   && ctxNum === botLidNum)
        || (!!ctxInfo?.quotedMessage && !ctxParticipant);
    console.log(`💬 reply-check: fromMe=${ctxInfo?.fromMe} participant="${ctxParticipant}" ctxNum=${ctxNum} botPhone=${botPhoneNum} botLid=${botLidNum} → isReplyToBot=${isReplyToBot}`);
    if (isReplyToBot && text) {
        const reply = await askGroqReply(text, jid);
        if (reply) {
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        } else {
            await sock.sendMessage(jid, { text: 'מצטער, לא הצלחתי לחשוב כרגע 😅' }, { quoted: msg });
        }
        return;
    }

    // ── פקודות אישור/כיבוי סרטים (אדמין קבוצה בלבד) ────────────
    if (text === 'אישור סרטים') {
        if (!isSenderAdmin) {
            await sock.sendMessage(jid, { text: '🔒 רק מנהלי הקבוצה יכולים להפעיל פקודה זו.' }, { quoted: msg });
            return;
        }
        const current = getMoviesActiveGroupJid();
        if (current && current !== jid) {
            await sock.sendMessage(jid, { text: '⚠️ כבר קיימת קבוצה פעילה אחרת. כבה אותה קודם עם הפקודה *כיבוי סרטים* בקבוצה ההיא.' }, { quoted: msg });
            return;
        }
        setMoviesActiveGroupJid(jid);
        await sock.sendMessage(jid, { text: '✅ *הקבוצה הזו הוגדרה כקבוצת הסרטים הפעילה!*\n\nעכשיו כל מי שחבר בקבוצה יוכל להיכנס לאתר StreamIL.\nלכיבוי שלח: *כיבוי סרטים*' }, { quoted: msg });
        return;
    }

    if (text === 'כיבוי סרטים') {
        if (!isSenderAdmin) {
            await sock.sendMessage(jid, { text: '🔒 רק מנהלי הקבוצה יכולים להפעיל פקודה זו.' }, { quoted: msg });
            return;
        }
        if (getMoviesActiveGroupJid() !== jid) {
            await sock.sendMessage(jid, { text: '⚠️ הקבוצה הזו אינה הקבוצה הפעילה כרגע.' }, { quoted: msg });
            return;
        }
        setMoviesActiveGroupJid(null);
        await sock.sendMessage(jid, { text: '🔴 *אישור הסרטים כובה.*\nכעת אף אחד לא יוכל להיכנס לאתר דרך קבוצה זו.' }, { quoted: msg });
        return;
    }

    const funHandled = await handleFunCommand(sock, msg, jid, text, msg.pushName || '', groupParticipants, senderJid, isSenderAdmin);
    if (funHandled) { incrementDailyCount(jid); return; }

    const adminHandled = await handleAdminCommand(sock, msg, jid, text, senderJid, isSenderAdmin, isBotAdmin);
    if (adminHandled) incrementDailyCount(jid);
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
