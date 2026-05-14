'use strict';

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
const groupHistory = new Map();   // jid -> [{sender, text}]
const groupCounters = new Map();  // jid -> {topic, count}

function addToHistory(jid, sender, text) {
    if (!groupHistory.has(jid)) groupHistory.set(jid, []);
    const arr = groupHistory.get(jid);
    arr.push({ sender, text });
    if (arr.length > 60) arr.shift();
}

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

        // ── פינג ──────────────────────────────────────────────────
        if (text === 'פינג') {
            await sock.sendMessage(jid, { text: '🏓 פונג! הבוט עובד מצוין ✅' });
            return true;
        }

        // ── זמן ───────────────────────────────────────────────────
        if (text === 'זמן') {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const dateStr = now.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });
            const dayIndex = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).getDay();
            await sock.sendMessage(jid, { text: `🕐 *שעה:* ${timeStr}\n📅 *תאריך:* ${dateStr}\n📆 *יום:* ${HEBREW_DAYS[dayIndex]}` });
            return true;
        }

        // ── תפריט ─────────────────────────────────────────────────
        if (text === 'פקודות' || text === 'עזרה' || text === 'תפריט') {
            await sock.sendMessage(jid, { text:
`🤖 *פקודות הבוט:*

🧠 *AI*
• \`AI [שאלה]\` / \`בוטי [שאלה]\`
• \`ראפ [נושא]\` — ראפ מאולתר
• \`תרגם [טקסט]\` — תרגום לאנגלית
• \`מי אמר [ציטוט]\` — מי בקבוצה היה אומר

🎲 *כיף*
• \`בדיחות\` • \`טיפ\` • \`עובדה\`
• \`נכון או אמת\` — שאלה למשחק
• \`ציטוט\` — ציטוט השראה
• \`טריוויה\` — שאלת טריוויה
• \`שידוך\` — שידוך בין חברים 💍
• \`תהילים\` • \`סמלים\`

⚡ *כלים*
• \`פינג\` • \`זמן\` • \`ספידטסט\`
• \`חשב [תרגיל]\` — מחשבון
• \`גימטריה [טקסט]\`
• \`הגרלה [א, ב, ג]\`
• \`בחר [א | ב | ג]\`
• \`חזור [טקסט]\` 🦜
• \`qr [טקסט]\` — יצירת QR
• \`תמלל\` — תמלול הקלטה (כתגובה)

📊 *קבוצה*
• \`סקר [שאלה]\` — סקר כן/לא
• \`תזכורת [X שעות/דקות] [הודעה]\`
• \`ספירה [נושא]\` — פותח ספירה
• \`++\` — מוסיף לספירה
• \`ספירה?\` — מציג ספירה נוכחית
• \`סיכום\` — סיכום AI של השיחה

🛡️ *ניהול (מנהלים בלבד)*
• \`הסרתקישורים\` / \`בטלהסרתקישורים\`
• \`הסרתסטיקרים\` / \`בטלהסרתסטיקרים\`
• \`אזהרות [מספר]\`
• \`נעל קבוצה\` / \`פתח קבוצה\`
• \`מנהלי קבוצה\` • \`ברוך הבא\`
• \`קישור\` • \`ניהול\` (כתגובה)` });
            return true;
        }

        // ── AI / בוטי ────────────────────────────────────────────
        if (text.startsWith('AI ') || text.startsWith('בוטי ')) {
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
        }

        // ── גימטריה ───────────────────────────────────────────────
        if (text.startsWith('גימטריה ')) {
            const input = text.slice('גימטריה '.length).trim();
            const value = calcGematria(input);
            await sock.sendMessage(jid, { text: `🔢 *גימטריה ל"${input}":* ${value}` });
            return true;
        }

        // ── הגרלה ─────────────────────────────────────────────────
        if (text.startsWith('הגרלה ')) {
            const input = text.slice('הגרלה '.length).trim();
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
        }

        // ── חשב ───────────────────────────────────────────────────
        if (text.startsWith('חשב ')) {
            const expr = text.slice('חשב '.length).trim();
            if (!/^[0-9+\-*/().\s%]+$/.test(expr)) {
                await sock.sendMessage(jid, { text: '❌ ביטוי לא חוקי' });
                return true;
            }
            let result;
            try { result = Function('"use strict";return(' + expr + ')')(); }
            catch { await sock.sendMessage(jid, { text: '❌ שגיאה בחישוב' }); return true; }
            await sock.sendMessage(jid, { text: `🧮 ${expr} = ${result}` });
            return true;
        }

        // ── חזור ──────────────────────────────────────────────────
        if (text.startsWith('חזור ')) {
            await sock.sendMessage(jid, { text: text.slice('חזור '.length).trim() + ' 🦜' });
            return true;
        }

        // ── ספידטסט ───────────────────────────────────────────────
        if (text === 'ספידטסט') {
            await sock.sendMessage(jid, { text: `⚡ *ספידטסט:* ${Date.now() - t}ms` });
            return true;
        }

        // ── בדיחות ────────────────────────────────────────────────
        if (text === 'בדיחות') {
            const joke = await askGroq('אתה קומיקאי ישראלי. ספר בדיחה קצרה ומצחיקה בעברית.', 'בדיחה');
            if (joke) await sock.sendMessage(jid, { text: joke + ' 😂' });
            return true;
        }

        // ── טיפ ───────────────────────────────────────────────────
        if (text === 'טיפ') {
            const tip = await askGroq('מומחה לחיים. טיפ יומי מעניין ומעשי בעברית, 1-2 משפטים.', 'טיפ');
            if (tip) await sock.sendMessage(jid, { text: `💡 *טיפ היום:* ${tip}` });
            return true;
        }

        // ── עובדה ─────────────────────────────────────────────────
        if (text === 'עובדה') {
            const fact = await askGroq('ידען. עובדה מעניינת ולא ידועה בעברית, 1-2 משפטים.', 'עובדה');
            if (fact) await sock.sendMessage(jid, { text: `🤓 *עובדה:* ${fact}` });
            return true;
        }

        // ── בחר ───────────────────────────────────────────────────
        if (text.startsWith('בחר ')) {
            const input = text.slice('בחר '.length).trim();
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
        }

        // ── שידוך ─────────────────────────────────────────────────
        if (text === 'שידוך') {
            if (!groupParticipants || groupParticipants.length < 2) {
                await sock.sendMessage(jid, { text: '⚠️ אין מספיק משתתפים' });
                return true;
            }
            const pool = [...groupParticipants].sort(() => Math.random() - 0.5);
            const p1 = pool[0]; const p2 = pool[1];
            const funny = await askGroq('קבוצת ווטסאפ', 'משפט מצחיק אחד על זוג חדש') || '💕';
            await sock.sendMessage(jid, {
                text: `💍 *שידוך!*\n@${p1.split('@')[0]} + @${p2.split('@')[0]}\n${funny}`,
                mentions: [p1, p2],
            });
            return true;
        }

        // ── QR ────────────────────────────────────────────────────
        if (text.startsWith('qr ') || text.startsWith('QR ')) {
            const input = text.slice(3).trim();
            const buf = await QRCode.toBuffer(input, { width: 300, margin: 2 });
            await sock.sendMessage(jid, { image: buf, caption: '🔳 QR: ' + input });
            return true;
        }

        // ── תמלל ──────────────────────────────────────────────────
        if (text === 'תמלל') {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
            if (!quoted) {
                await sock.sendMessage(jid, { text: '⚠️ ענה על הודעת קול כדי לתמלל' });
                return true;
            }
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const { toFile } = require('groq-sdk');
            const quotedMsg = {
                key: { remoteJid: jid, id: msg.message.extendedTextMessage.contextInfo.stanzaId, fromMe: false },
                message: msg.message.extendedTextMessage.contextInfo.quotedMessage,
            };
            const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {},
                { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const result = await getGroqClient().audio.transcriptions.create({
                file: await toFile(buffer, 'voice.ogg', { type: 'audio/ogg' }),
                model: 'whisper-large-v3-turbo', language: 'he',
            });
            await sock.sendMessage(jid, { text: `📑 *תמלול:*\n"${result.text}"` });
            return true;
        }

        // ── סמלים ─────────────────────────────────────────────────
        if (text === 'סמלים') {
            await sock.sendMessage(jid, { text: '✨ 🌟 ⭐ 💫 🔥 ❄️ 💎 🎯 ⚡ 🌈\n◆ ◇ ● ○ ■ □ ▲ △ ► ◄\n★ ☆ ♠ ♣ ♥ ♦ ♪ ♫ ✔ ✘\n↑ ↓ ← → ↗ ↙ ∞ ≈ ± ×' });
            return true;
        }

        // ── תהילים ────────────────────────────────────────────────
        if (text === 'תהילים') {
            const n = Math.floor(Math.random() * 150) + 1;
            const psalm = await askGroq('אתה מכיר תהילים בעל פה. כתוב את הפרק המבוקש.', `תהילים פרק ${n}`, 600);
            if (psalm) await sock.sendMessage(jid, { text: `📖 *תהילים פרק ${n}:*\n${psalm}` });
            return true;
        }

        // ── נכון או אמת ───────────────────────────────────────────
        if (text === 'נכון או אמת') {
            const q = await askGroq(
                'אתה מנחה משחקי מסיבה. צור שאלת "נכון או אמת" מצחיקה ומעניינת בעברית לקבוצת חברים. שאלה אחת בלבד.',
                'שאלת נכון או אמת'
            );
            if (q) await sock.sendMessage(jid, { text: `🔥 *נכון או אמת?*\n\n${q}` });
            return true;
        }

        // ── ציטוט ─────────────────────────────────────────────────
        if (text === 'ציטוט') {
            const quote = await askGroq(
                'אתה אוסף ציטוטים. תן ציטוט השראה מפורסם בעברית. בצורה: "הציטוט" — השם.',
                'ציטוט השראה'
            );
            if (quote) await sock.sendMessage(jid, { text: `✨ ${quote}` });
            return true;
        }

        // ── טריוויה ───────────────────────────────────────────────
        if (text === 'טריוויה') {
            const trivia = await askGroq(
                'אתה שואל שאלות טריוויה. צור שאלה מעניינת בעברית עם 4 אפשרויות (א/ב/ג/ד) ובסוף — ||התשובה: X||',
                'שאלת טריוויה',
                250
            );
            if (trivia) await sock.sendMessage(jid, { text: `🧠 *טריוויה!*\n\n${trivia}` });
            return true;
        }

        // ── ראפ ───────────────────────────────────────────────────
        if (text.startsWith('ראפ ')) {
            const topic = text.slice('ראפ '.length).trim();
            const rap = await askGroq(
                'אתה ראפר ישראלי. כתוב ראפ קצר (4-8 שורות) מצחיק בעברית עם חריזה על הנושא שיינתן.',
                `ראפ על: ${topic}`,
                300
            );
            if (rap) await sock.sendMessage(jid, { text: `🎤 *ראפ על "${topic}":*\n\n${rap}` });
            return true;
        }

        // ── תרגם ──────────────────────────────────────────────────
        if (text.startsWith('תרגם ')) {
            const input = text.slice('תרגם '.length).trim();
            const isHebrew = /[֐-׿]/.test(input);
            const targetLang = isHebrew ? 'אנגלית' : 'עברית';
            const translated = await askGroq(
                `תרגם את הטקסט ל${targetLang}. תן רק את התרגום, ללא הסברים.`,
                input,
                200
            );
            if (translated) await sock.sendMessage(jid, { text: `🌐 *תרגום ל${targetLang}:*\n${translated}` });
            return true;
        }

        // ── מי אמר ────────────────────────────────────────────────
        if (text.startsWith('מי אמר ')) {
            const quote = text.slice('מי אמר '.length).trim();
            const hist = groupHistory.get(jid) || [];
            const names = [...new Set(hist.map(m => m.sender).filter(Boolean))];
            const nameList = names.length > 0 ? names.join(', ') : 'חברים בקבוצה';
            const answer = await askGroq(
                `אתה מכיר את חברי הקבוצה: ${nameList}. בהתאם לאישיות שמשתמעת מהשמות, החלט בצורה מצחיקה מי הכי סביר שאמר את הציטוט. תן תשובה קצרה ומצחיקה בעברית.`,
                `מי היה אומר: "${quote}"?`,
                150
            );
            if (answer) await sock.sendMessage(jid, { text: `🤔 *מי אמר "${quote}"?*\n\n${answer}` });
            return true;
        }

        // ── סקר ───────────────────────────────────────────────────
        if (text.startsWith('סקר ')) {
            const question = text.slice('סקר '.length).trim();
            if (!question) {
                await sock.sendMessage(jid, { text: '⚠️ כתוב: סקר [שאלה]' });
                return true;
            }
            await sock.sendMessage(jid, {
                poll: { name: question, values: ['כן ✅', 'לא ❌', 'אולי 🤔'], selectableCount: 1 }
            });
            return true;
        }

        // ── תזכורת ────────────────────────────────────────────────
        if (text.startsWith('תזכורת ')) {
            const parts = text.slice('תזכורת '.length).trim().split(' ');
            const amount = parseInt(parts[0], 10);
            const unit = parts[1] || '';
            const reminderText = parts.slice(2).join(' ');
            if (isNaN(amount) || amount <= 0 || !reminderText) {
                await sock.sendMessage(jid, { text: '⚠️ כתוב: תזכורת [מספר] [שעות/דקות] [הודעה]\nדוגמה: תזכורת 2 שעות לצאת לאכול' });
                return true;
            }
            const isHours = unit.includes('שע');
            const ms = amount * (isHours ? 3600000 : 60000);
            const unitStr = isHours ? (amount === 1 ? 'שעה' : 'שעות') : (amount === 1 ? 'דקה' : 'דקות');
            await sock.sendMessage(jid, { text: `⏰ תזכורת נקבעה! אזכיר בעוד ${amount} ${unitStr}: "${reminderText}"` });
            setTimeout(async () => {
                try {
                    await sock.sendMessage(jid, { text: `⏰ *תזכורת!*\n${reminderText}` });
                } catch {}
            }, ms);
            return true;
        }

        // ── ספירה ─────────────────────────────────────────────────
        if (text.startsWith('ספירה ') && !text.startsWith('ספירה?')) {
            const topic = text.slice('ספירה '.length).trim();
            groupCounters.set(jid, { topic, count: 0 });
            await sock.sendMessage(jid, { text: `📊 *ספירה: ${topic}*\nמונה: 0\nכתבו ++ כדי להוסיף` });
            return true;
        }

        if (text === 'ספירה?') {
            const counter = groupCounters.get(jid);
            if (!counter) {
                await sock.sendMessage(jid, { text: '⚠️ אין ספירה פעילה. כתוב: ספירה [נושא]' });
            } else {
                await sock.sendMessage(jid, { text: `📊 *ספירה: ${counter.topic}*\nמונה: ${counter.count}` });
            }
            return true;
        }

        if (text === '++') {
            const counter = groupCounters.get(jid);
            if (!counter) {
                await sock.sendMessage(jid, { text: '⚠️ אין ספירה פעילה. כתוב: ספירה [נושא]' });
            } else {
                counter.count++;
                await sock.sendMessage(jid, { text: `📊 *${counter.topic}:* ${counter.count}` });
            }
            return true;
        }

        // ── סיכום ─────────────────────────────────────────────────
        if (text === 'סיכום') {
            const hist = groupHistory.get(jid) || [];
            if (hist.length < 3) {
                await sock.sendMessage(jid, { text: '⚠️ אין מספיק הודעות לסיכום עדיין' });
                return true;
            }
            const convo = hist.slice(-40).map(m => `${m.sender || 'מישהו'}: ${m.text}`).join('\n');
            const summary = await askGroq(
                'אתה מסכם שיחות ווטסאפ. תן סיכום קצר (3-5 נקודות) של מה שדובר, בעברית עם אמוג\'י.',
                `סכם את השיחה:\n${convo}`,
                400
            );
            if (summary) await sock.sendMessage(jid, { text: `📋 *סיכום השיחה:*\n\n${summary}` });
            return true;
        }

    } catch (err) {
        console.error('group-commands error:', err.message);
        await sock.sendMessage(jid, { text: '❌ שגיאה בביצוע הפקודה' });
        return true;
    }

    return false;
}

module.exports = { handleFunCommand, addToHistory };
