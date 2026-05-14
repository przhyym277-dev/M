require('dotenv').config();
const Groq = require('groq-sdk');
const QRCode = require('qrcode');
const pino = require('pino');

const GROQ_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
let groqKeyIndex = 0;
function getGroqClient() { return new Groq({ apiKey: GROQ_KEYS[groqKeyIndex % GROQ_KEYS.length] }); }
async function askGroq(system, user, maxTokens = 300) {
    for (let i = 0; i < GROQ_KEYS.length; i++) {
        try {
            const r = await getGroqClient().chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                max_tokens: maxTokens, temperature: 0.8,
            });
            return r.choices[0]?.message?.content?.trim() || null;
        } catch (err) {
            if ((err.status === 429 || err.message?.includes('429')) && i < GROQ_KEYS.length - 1) { groqKeyIndex++; continue; }
            return null;
        }
    }
    return null;
}

const groupConversations = new Map();

const GEMATRIA_MAP = {
    'א':1,'ב':2,'ג':3,'ד':4,'ה':5,'ו':6,'ז':7,'ח':8,'ט':9,
    'י':10,'כ':20,'ך':20,'ל':30,'מ':40,'ם':40,'נ':50,'ן':50,
    'ס':60,'ע':70,'פ':80,'ף':80,'צ':90,'ץ':90,
    'ק':100,'ר':200,'ש':300,'ת':400,
};

function calcGematria(text) {
    let val = 0;
    for (const ch of text) { if (GEMATRIA_MAP[ch]) val += GEMATRIA_MAP[ch]; }
    return val;
}

const HEBREW_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

async function handleFunCommand(sock, msg, jid, text, pushName, groupParticipants) {
    const t = Date.now();
    try {

        if (text === '!פינג') {
            try {
                await sock.sendMessage(jid, { text: '🏓 פונג! הבוט עובד מצוין ✅' });
                return true;
            } catch (e) { console.error('פינג error:', e.message); return true; }
        }

        if (text === '!זמן') {
            try {
                const now = new Date();
                const timeStr = now.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const dateStr = now.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });
                const dayIndex = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).getDay();
                await sock.sendMessage(jid, { text: `🕐 *שעה:* ${timeStr}\n📅 *תאריך:* ${dateStr}\n📆 *יום:* ${HEBREW_DAYS[dayIndex]}` });
                return true;
            } catch (e) { console.error('זמן error:', e.message); return true; }
        }

        if (text === '!פקודות' || text === '!עזרה' || text === '!תפריט') {
            await sock.sendMessage(jid, { text:
`🤖 *פקודות הבוט:*

🧠 *AI*
• \`AI [שאלה]\` — שאל את הבוט
• \`בוטי [שאלה]\` — אותו דבר

⚡ *כלים*
• \`!פינג\` — בדוק שהבוט עובד
• \`!זמן\` — שעה ותאריך
• \`!חשב [תרגיל]\` — מחשבון
• \`!גימטריה [טקסט]\` — חישוב גימטריה
• \`!הגרלה [א, ב, ג]\` — הגרלה אקראית
• \`!בחר [א | ב | ג]\` — בחירה אקראית
• \`!חזור [טקסט]\` — חוזר אחריך 🦜
• \`!ספידטסט\` — מהירות תגובה
• \`!qr [טקסט]\` — יצירת QR
• \`!תמלל\` — תמלול הודעה קולית (כתגובה)

🎲 *כיף*
• \`!בדיחות\` — בדיחה אקראית
• \`!טיפ\` — טיפ יומי
• \`!עובדה\` — עובדה מעניינת
• \`!שידוך\` — שידוך בין חברים 💍
• \`!תהילים\` — פרק תהילים אקראי
• \`!סמלים\` — סמלים מיוחדים

🛡️ *ניהול קבוצה (מנהלים בלבד)*
• \`!הסרתקישורים\` / \`!בטלהסרתקישורים\`
• \`!הסרתסטיקרים\` / \`!בטלהסרתסטיקרים\`
• \`!אזהרות [מספר]\` — סף אזהרות להסרה
• \`!נעל קבוצה\` / \`!פתח קבוצה\`
• \`!מנהלי קבוצה\` — תייג מנהלים
• \`!ברוך הבא\` — הודעת קבלת פנים
• \`!קישור\` — קישור הזמנה לקבוצה
• \`!ניהול\` — קידום למנהל (כתגובה)` });
            return true;
        }

        if (text.startsWith('AI ') || text.startsWith('בוטי ')) {
            try {
                const question = text.startsWith('AI ') ? text.slice(3).trim() : text.slice('בוטי '.length).trim();
                if (!groupConversations.has(jid)) groupConversations.set(jid, []);
                const history = groupConversations.get(jid);
                history.push({ role: 'user', content: question });
                if (history.length > 8) history.splice(0, history.length - 8);
                let reply = null;
                for (let i = 0; i < GROQ_KEYS.length; i++) {
                    try {
                        const r = await getGroqClient().chat.completions.create({
                            model: 'llama-3.3-70b-versatile',
                            messages: [
                                { role: 'system', content: 'אתה בוט חברים חכם ומצחיק. עברית, קצר, אמוג\'י.' },
                                ...history,
                            ],
                            max_tokens: 300, temperature: 0.8,
                        });
                        reply = r.choices[0]?.message?.content?.trim() || null;
                        break;
                    } catch (err) {
                        if ((err.status === 429 || err.message?.includes('429')) && i < GROQ_KEYS.length - 1) { groqKeyIndex++; continue; }
                        break;
                    }
                }
                if (reply) {
                    history.push({ role: 'assistant', content: reply });
                    if (history.length > 8) history.splice(0, history.length - 8);
                    await sock.sendMessage(jid, { text: reply });
                }
                return true;
            } catch (e) { console.error('בוטי error:', e.message); return true; }
        }

        if (text.startsWith('!גימטריה ')) {
            try {
                const input = text.slice('!גימטריה '.length).trim();
                const value = calcGematria(input);
                await sock.sendMessage(jid, { text: `🔢 *גימטריה ל"${input}":* ${value}` });
                return true;
            } catch (e) { console.error('גימטריה error:', e.message); return true; }
        }

        if (text.startsWith('!הגרלה ')) {
            try {
                const input = text.slice('!הגרלה '.length).trim();
                const items = input.includes(',')
                    ? input.split(',').map(s => s.trim()).filter(Boolean)
                    : input.split(/\s+/).filter(Boolean);
                if (items.length < 2) {
                    await sock.sendMessage(jid, { text: '⚠️ הכנס לפחות 2 אפשרויות' });
                    return true;
                }
                const chosen = items[Math.floor(Math.random() * items.length)];
                await sock.sendMessage(jid, { text: `🎲 *ההגרלה בחרה:* ${chosen} (מתוך ${items.length} אפשרויות)` });
                return true;
            } catch (e) { console.error('הגרלה error:', e.message); return true; }
        }

        if (text.startsWith('!חשב ')) {
            try {
                const expr = text.slice('!חשב '.length).trim();
                if (!/^[0-9+\-*/().\s%]+$/.test(expr)) {
                    await sock.sendMessage(jid, { text: '❌ ביטוי לא חוקי' });
                    return true;
                }
                let result;
                try {
                    result = Function('"use strict";return(' + expr + ')')();
                } catch (evalErr) {
                    await sock.sendMessage(jid, { text: '❌ שגיאה בחישוב' });
                    return true;
                }
                await sock.sendMessage(jid, { text: `🧮 ${expr} = ${result}` });
                return true;
            } catch (e) { console.error('חשב error:', e.message); return true; }
        }

        if (text.startsWith('!חזור ')) {
            try {
                const input = text.slice('!חזור '.length).trim();
                await sock.sendMessage(jid, { text: input + ' 🦜' });
                return true;
            } catch (e) { console.error('חזור error:', e.message); return true; }
        }

        if (text === '!ספידטסט') {
            try {
                const ms = Date.now() - t;
                await sock.sendMessage(jid, { text: `⚡ *ספידטסט:* ${ms}ms` });
                return true;
            } catch (e) { console.error('ספידטסט error:', e.message); return true; }
        }

        if (text === '!בדיחות') {
            try {
                const joke = await askGroq('אתה קומיקאי ישראלי. ספר בדיחה קצרה ומצחיקה בעברית.', 'בדיחה');
                if (joke) await sock.sendMessage(jid, { text: joke + ' 😂' });
                return true;
            } catch (e) { console.error('בדיחות error:', e.message); return true; }
        }

        if (text === '!טיפ') {
            try {
                const tip = await askGroq('מומחה לחיים. טיפ יומי מעניין ומעשי בעברית, 1-2 משפטים.', 'טיפ');
                if (tip) await sock.sendMessage(jid, { text: `💡 *טיפ היום:* ${tip}` });
                return true;
            } catch (e) { console.error('טיפ error:', e.message); return true; }
        }

        if (text === '!עובדה') {
            try {
                const fact = await askGroq('ידען. עובדה מעניינת ולא ידועה בעברית, 1-2 משפטים.', 'עובדה');
                if (fact) await sock.sendMessage(jid, { text: `🤓 *עובדה:* ${fact}` });
                return true;
            } catch (e) { console.error('עובדה error:', e.message); return true; }
        }

        if (text.startsWith('!בחר ')) {
            try {
                const input = text.slice('!בחר '.length).trim();
                const items = input.includes(' | ')
                    ? input.split(' | ').map(s => s.trim()).filter(Boolean)
                    : input.split(',').map(s => s.trim()).filter(Boolean);
                if (items.length < 2) {
                    await sock.sendMessage(jid, { text: '⚠️ הכנס לפחות 2 אפשרויות מופרדות ב-| או פסיק' });
                    return true;
                }
                const choice = items[Math.floor(Math.random() * items.length)];
                await sock.sendMessage(jid, { text: `🎯 בחרתי: *${choice}*` });
                return true;
            } catch (e) { console.error('בחר error:', e.message); return true; }
        }

        if (text === '!שידוך') {
            try {
                if (!groupParticipants || groupParticipants.length < 2) {
                    await sock.sendMessage(jid, { text: '⚠️ אין מספיק משתתפים' });
                    return true;
                }
                const pool = [...groupParticipants].sort(() => Math.random() - 0.5);
                const p1 = pool[0];
                const p2 = pool[1];
                const funny = await askGroq('קבוצת ווטסאפ', 'משפט מצחיק אחד על זוג חדש') || '💕';
                await sock.sendMessage(jid, {
                    text: `💍 *שידוך!*\n@${p1.split('@')[0]} + @${p2.split('@')[0]}\n${funny}`,
                    mentions: [p1, p2],
                });
                return true;
            } catch (e) { console.error('שידוך error:', e.message); return true; }
        }

        if (text.startsWith('!qr ') || text.startsWith('!QR ')) {
            try {
                const input = text.slice(4).trim();
                const buf = await QRCode.toBuffer(input, { width: 300, margin: 2 });
                await sock.sendMessage(jid, { image: buf, caption: '🔳 QR: ' + input });
                return true;
            } catch (e) { console.error('qr error:', e.message); return true; }
        }

        if (text === '!תמלל') {
            try {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
                if (!quoted) {
                    await sock.sendMessage(jid, { text: '⚠️ ענה על הודעת קול כדי לתמלל' });
                    return true;
                }
                const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                const { toFile } = require('groq-sdk');
                const quotedMsg = {
                    key: {
                        remoteJid: jid,
                        id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                        fromMe: false,
                    },
                    message: msg.message.extendedTextMessage.contextInfo.quotedMessage,
                };
                const buffer = await downloadMediaMessage(
                    quotedMsg, 'buffer', {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );
                const result = await getGroqClient().audio.transcriptions.create({
                    file: await toFile(buffer, 'voice.ogg', { type: 'audio/ogg' }),
                    model: 'whisper-large-v3-turbo',
                    language: 'he',
                });
                await sock.sendMessage(jid, { text: `📑 *תמלול:*\n"${result.text}"` });
                return true;
            } catch (e) { console.error('תמלל error:', e.message); return true; }
        }

        if (text === '!סמלים') {
            try {
                await sock.sendMessage(jid, {
                    text: '✨ 🌟 ⭐ 💫 🔥 ❄️ 💎 🎯 ⚡ 🌈\n◆ ◇ ● ○ ■ □ ▲ △ ► ◄\n★ ☆ ♠ ♣ ♥ ♦ ♪ ♫ ✔ ✘\n↑ ↓ ← → ↗ ↙ ∞ ≈ ± ×',
                });
                return true;
            } catch (e) { console.error('סמלים error:', e.message); return true; }
        }

        if (text === '!תהילים') {
            try {
                const n = Math.floor(Math.random() * 150) + 1;
                const psalm = await askGroq(
                    'אתה מכיר תהילים בעל פה. כתוב את הפרק המבוקש.',
                    `תהילים פרק ${n}`,
                    600
                );
                if (psalm) await sock.sendMessage(jid, { text: `📖 *תהילים פרק ${n}:*\n${psalm}` });
                return true;
            } catch (e) { console.error('תהילים error:', e.message); return true; }
        }

    } catch (err) {
        console.error('group-commands error:', err.message);
        await sock.sendMessage(jid, { text: '❌ שגיאה בביצוע הפקודה' });
        return true;
    }

    return false;
}

module.exports = { handleFunCommand };
