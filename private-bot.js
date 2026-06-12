'use strict';

const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const { handleFunCommand } = require('./group-commands');
const murderGame = require('./murder-game');

const SUPER_ADMINS = new Set(['972522091733', '972508181322', '98668719951947', '188150102098030']);

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'private-settings.json');

let privateMode = 'all'; // 'all' | 'none' | 'whitelist'
let privateWhitelist = new Set();
let privateBlockedCommands = new Set(); // פקודות חסומות בפרטי (סרט, שיר, תמונה, סטיקר...)
let tutorUsers = new Set(); // משתמשים במצב שיעורים (מורה פרטי AI)
let movieUsers = new Set(); // מספרי טלפון מאושרים לאתר הסרטים StreamIL

function loadSettings() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return;
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        privateMode = data.mode || 'all';
        privateWhitelist = new Set(data.whitelist || []);
        privateBlockedCommands = new Set(data.blockedCommands || []);
        tutorUsers = new Set(data.tutorUsers || []);
        movieUsers = new Set(data.movieUsers || []);
        console.log(`✅ Private settings loaded (mode=${privateMode} whitelist=${privateWhitelist.size} blocked=${privateBlockedCommands.size} tutor=${tutorUsers.size} movies=${movieUsers.size})`);
    } catch (e) { console.error('private settings load error:', e.message); }
}

function saveSettings() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
            mode: privateMode,
            whitelist: [...privateWhitelist],
            blockedCommands: [...privateBlockedCommands],
            tutorUsers: [...tutorUsers],
            movieUsers: [...movieUsers],
        }, null, 2));
    } catch {}
}

loadSettings();

function isOwner(jid) {
    return SUPER_ADMINS.has(jid.split('@')[0]);
}

function canRespond(jid) {
    const nid = normJid(jid);
    if (isOwner(nid)) return true;
    if (privateMode === 'all') return true;
    if (privateMode === 'none') return false;
    if (privateWhitelist.has(nid)) return true;
    // fallback: compare by phone number only (strips domain)
    const phone = nid.split('@')[0].replace(/\D/g, '');
    for (const w of privateWhitelist) {
        if (w.split('@')[0].replace(/\D/g, '') === phone) return true;
    }
    return false;
}

function normalizePhone(input) {
    const digits = input.replace(/\D/g, '');
    return digits.startsWith('972') ? digits : `972${digits.replace(/^0/, '')}`;
}

const GROQ_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
let groqKeyIdx = 0;
const dmHistory = new Map();

const DEFAULT_PROMPT = 'אתה בוט ווטסאפ חכם ומצחיק. ענה בעברית, עם אמוג\'י. אם ביקשו תשובה ארוכה — תן אותה.';

const TUTOR_PROMPT = `אתה "מאסטר" — מורה פרטי AI לתלמידים בוואטסאפ, מבית מאסטר קוד.
המטרה שלך: שהתלמיד יבין באמת — לא לתת לו תשובות מוכנות.

כללים:
1. לעולם אל תיתן את התשובה הסופית מיד — הסבר את הדרך שלב-שלב והוביל את התלמיד להגיע אליה בעצמו
2. שאל שאלות מנחות: "מה לדעתך הצעד הראשון?", "מה קורה אם ננסה...?"
3. כשהתלמיד טועה — אל תגיד "טעות". הסבר בעדינות איפה הבלבול ותן רמז שמקדם
4. כשהתלמיד מצליח — פרגן בחום! 🎉
5. התאם את ההסבר לגיל ולרמה שמשתקפים מהשאלות שלו
6. הודעות קצרות וברורות — זה וואטסאפ, לא הרצאה. רעיון אחד בכל הודעה
7. עברית פשוטה וברורה, אמוג'י במידה
8. כל המקצועות: מתמטיקה, אנגלית, פיזיקה, לשון, תנ"ך, היסטוריה ועוד
9. אם התלמיד שלח תמונה של תרגיל — קרא אותו והתחל ללוות אותו שלב-שלב
10. בסוף כל נושא — תן שאלת תרגול קטנה כדי לוודא שהוא באמת הבין`;

async function askGroq(jid, text, systemPrompt = DEFAULT_PROMPT) {
    if (!dmHistory.has(jid)) dmHistory.set(jid, []);
    const history = dmHistory.get(jid);
    history.push({ role: 'user', content: text });
    if (history.length > 16) history.splice(0, history.length - 16);

    for (let i = 0; i < GROQ_KEYS.length; i++) {
        try {
            const client = new Groq({ apiKey: GROQ_KEYS[groqKeyIdx % GROQ_KEYS.length] });
            const r = await client.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...history,
                ],
                max_tokens: 1500,
                temperature: 0.8,
            });
            const reply = r.choices[0]?.message?.content?.trim() || null;
            if (reply) {
                history.push({ role: 'assistant', content: reply });
                if (history.length > 16) history.splice(0, history.length - 16);
            }
            return reply;
        } catch (err) {
            if ((err.status === 429 || err.message?.includes('429')) && i < GROQ_KEYS.length - 1) { groqKeyIdx++; continue; }
            console.error('private groq error:', err.message?.slice(0, 80));
            return null;
        }
    }
    return null;
}

async function readExerciseImage(sock, msg) {
    try {
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        const pino = require('pino');
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
        });
        const base64 = buffer.toString('base64');
        const mimeType = msg.message?.imageMessage?.mimetype || 'image/jpeg';
        for (let i = 0; i < GROQ_KEYS.length; i++) {
            try {
                const client = new Groq({ apiKey: GROQ_KEYS[groqKeyIdx % GROQ_KEYS.length] });
                const r = await client.chat.completions.create({
                    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: 'זו תמונה של תרגיל או שיעורי בית. העתק את התרגיל במדויק (טקסט, מספרים, נוסחאות) ותאר כל פרט שרלוונטי לפתרון. ענה בעברית.' },
                            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
                        ],
                    }],
                    max_tokens: 600,
                    temperature: 0.2,
                });
                const out = r.choices[0]?.message?.content?.trim();
                if (out) return out;
                return null;
            } catch (err) {
                if ((err.status === 429 || err.message?.includes('429')) && i < GROQ_KEYS.length - 1) { groqKeyIdx++; continue; }
                throw err;
            }
        }
        return null;
    } catch (err) {
        console.error('tutor image error:', err.message?.slice(0, 80));
        return null;
    }
}

const normJid = (id) => (id || '').replace(/:.*@/, '@');

function getText(msg) {
    return msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
}

async function handlePrivateMessage(sock, msg) {
    const jid = normJid(msg.key.remoteJid);
    const text = getText(msg).trim();
    const hasImage = !!msg.message?.imageMessage;
    // תמונה בלי טקסט מותרת רק במצב שיעורים (צילום תרגיל)
    if (!text && !(hasImage && tutorUsers.has(jid))) return;

    console.log(`📩 [פרטי] jid=${jid} mode=${privateMode} whitelist=${privateWhitelist.size}: ${text.slice(0, 60)}`);

    // ── פקודות בעלים ──────────────────────────────────────────────
    if (isOwner(jid)) {
        if (text === 'פרטי הכל') {
            privateMode = 'all'; saveSettings();
            await sock.sendMessage(jid, { text: '✅ הבוט יענה לכולם בפרטי.' }); return;
        }
        if (text === 'פרטי כבוי') {
            privateMode = 'none'; saveSettings();
            await sock.sendMessage(jid, { text: '🔕 הבוט לא יענה לאף אחד בפרטי (מלבד הבעלים).' }); return;
        }
        if (text === 'פרטי רשימה') {
            const modeText = privateMode === 'all' ? '🌍 עונה לכולם' : privateMode === 'none' ? '🔕 לא עונה לאף אחד' : `📋 רשימה לבנה`;
            const list = privateWhitelist.size > 0
                ? '\n\n' + [...privateWhitelist].map(j => `• +${j.split('@')[0]}`).join('\n')
                : '\n\n_(הרשימה ריקה)_';
            const blocked = privateBlockedCommands.size > 0
                ? `\n\n🔒 *פקודות חסומות בפרטי:* ${[...privateBlockedCommands].join(', ')}`
                : '';
            await sock.sendMessage(jid, { text: `📱 *הגדרות פרטי:*\nמצב: ${modeText}${privateMode === 'whitelist' ? list : ''}${blocked}\n\nלחסום פקודה: *פרטי חסום [שם]*\nלפתוח פקודה: *פרטי פתח [שם]*` }); return;
        }
        if (text.startsWith('פרטי הוסף ')) {
            const phone = normalizePhone(text.slice('פרטי הוסף '.length));
            let targetJid = `${phone}@s.whatsapp.net`;
            try {
                const [result] = await sock.onWhatsApp(phone) || [];
                if (result?.exists && result.jid) targetJid = normJid(result.jid);
            } catch {}
            privateWhitelist.add(targetJid);
            if (privateMode !== 'whitelist') { privateMode = 'whitelist'; }
            saveSettings();
            await sock.sendMessage(jid, { text: `✅ +${phone} נוסף לרשימה המורשים.\nJID: ${targetJid}\nמצב: רשימה לבנה (${privateWhitelist.size} אנשים)` }); return;
        }
        if (text.startsWith('פרטי חסום ')) {
            const cmd = text.slice('פרטי חסום '.length).trim();
            privateBlockedCommands.add(cmd);
            saveSettings();
            await sock.sendMessage(jid, { text: `🔒 פקודת *${cmd}* חסומה בפרטי.\nלפתיחה: *פרטי פתח ${cmd}*` }); return;
        }
        if (text.startsWith('פרטי פתח ')) {
            const cmd = text.slice('פרטי פתח '.length).trim();
            privateBlockedCommands.delete(cmd);
            saveSettings();
            await sock.sendMessage(jid, { text: `🔓 פקודת *${cmd}* פתוחה בפרטי.` }); return;
        }
        if (text.toLowerCase().includes('בדיקת הורדה')) {
            await sock.sendMessage(jid, { text: '🔍 בודק...' });
            const youtubedl = require('youtube-dl-exec');
            const results = [];

            // 1. version check
            try {
                const ver = await youtubedl.exec('--version', {});
                results.push(`✅ yt-dlp גרסה: ${(ver?.stdout || '').trim().slice(0, 30)}`);
            } catch (e) {
                results.push(`❌ yt-dlp לא עובד: ${e.message?.slice(0, 100)}`);
                await sock.sendMessage(jid, { text: results.join('\n') }); return;
            }

            // test sources
            const testSources = [
                { name: 'archive.org (Night of the Living Dead)', url: 'https://archive.org/details/Night_of_the_Living_Dead_1968' },
                { name: 'archive.org (Metropolis 1927)',          url: 'https://archive.org/details/Metropolis_1927' },
                { name: 'vidsrc.xyz',   url: 'https://vidsrc.xyz/embed/movie/tt1375666' },
                { name: 'vidsrc.cc',    url: 'https://vidsrc.cc/v2/embed/movie/tt1375666' },
                { name: 'cineb.rs',     url: 'https://cineb.rs/movie/watch-inception-tt1375666.html' },
                { name: 'autoembed',    url: 'https://player.autoembed.cc/embed/movie/tt1375666' },
            ];
            for (const s of testSources) {
                try {
                    const out = await youtubedl(s.url, { getUrl: true, noWarnings: true, noPlaylist: true, format: 'best[height<=480]/best' });
                    const line = (out || '').toString().trim().split('\n')[0];
                    results.push(line.startsWith('http') ? `✅ ${s.name}:\n${line.slice(0, 120)}` : `❌ ${s.name}: "${line.slice(0, 80)}"`);
                } catch (e) {
                    const err = (e.stderr || e.message || '').slice(0, 100);
                    results.push(`❌ ${s.name}:\n${err}`);
                }
            }

            await sock.sendMessage(jid, { text: results.join('\n\n') }); return;
        }
        if (text.toLowerCase().includes('filemoon')) {
            await sock.sendMessage(jid, { text: '🔍 בודק FileMoon API...' });
            const https = require('https');
            function fetchUrl(url, timeoutMs = 10000) {
                return new Promise(resolve => {
                    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: timeoutMs }, res => {
                        let body = '';
                        res.on('data', c => { if (body.length < 2000) body += c.toString(); });
                        res.on('end', () => resolve({ status: res.statusCode, body, location: res.headers.location }));
                    });
                    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
                    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
                });
            }
            const tests = [
                { name: 'API בסיס',       url: 'https://filemoon.sx/api' },
                { name: 'חיפוש inception', url: 'https://filemoon.sx/api/file/search?name=inception' },
                { name: 'חיפוש movie',    url: 'https://filemoon.sx/api/search?q=inception' },
                { name: 'רשימת קבצים',    url: 'https://filemoon.sx/api/file/list' },
                { name: 'embed link',     url: 'https://filemoon.sx/e/inception' },
            ];
            const lines = [];
            for (const t of tests) {
                const r = await fetchUrl(t.url);
                const preview = r.body?.slice(0, 150).replace(/\n/g, ' ') || r.error || '';
                lines.push(`*${t.name}* [${r.status}]\n${preview}`);
            }
            await sock.sendMessage(jid, { text: `📋 *FileMoon בדיקה:*\n\n${lines.join('\n\n')}` }); return;
        }
        if (text === 'בדיקת מקורות') {
            await sock.sendMessage(jid, { text: '🔍 בודק מקורות הורדה מ-Render... (30 שניות)' });
            const https = require('https');
            const http = require('http');
            function testUrl(url, timeoutMs = 8000) {
                return new Promise(resolve => {
                    const mod = url.startsWith('https') ? https : http;
                    const start = Date.now();
                    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: timeoutMs }, res => {
                        const ms = Date.now() - start;
                        let body = '';
                        res.on('data', c => { if (body.length < 500) body += c.toString(); });
                        res.on('end', () => resolve({ status: res.statusCode, ms, body: body.slice(0, 200) }));
                    });
                    req.on('error', e => resolve({ status: 0, ms: Date.now() - start, error: e.message.slice(0, 60) }));
                    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: timeoutMs, error: 'timeout' }); });
                });
            }
            const sources = [
                { name: 'YTS API',         url: 'https://yts.mx/api/v2/list_movies.json?query_term=inception&limit=1' },
                { name: 'Torrentio',       url: 'https://torrentio.strem.fun/stream/movie/tt1375666.json' },
                { name: '1337x',           url: 'https://www.1337x.to/search/inception/1/' },
                { name: 'RARBG mirror',    url: 'https://rargb.to/search/?search=inception' },
                { name: 'Nyaa',            url: 'https://nyaa.si/?q=inception&c=0_0&f=0' },
                { name: 'Archive.org',     url: 'https://archive.org/advancedsearch.php?q=inception&output=json&rows=1' },
                { name: 'Pixeldrain',      url: 'https://pixeldrain.com/api/misc/top_list' },
                { name: 'Gofile',          url: 'https://api.gofile.io/getServer' },
                { name: 'FileMoon API',    url: 'https://filemoon.sx/api' },
                { name: 'Vidsrc.me',       url: 'https://vidsrc.me/embed/movie/tt1375666' },
                { name: 'MoviesAPI.club',  url: 'https://moviesapi.club/movie/tt1375666' },
                { name: 'Multiembed',      url: 'https://multiembed.mov/?video_id=tt1375666&tmdb=1' },
            ];
            const results = await Promise.all(sources.map(async s => {
                const r = await testUrl(s.url);
                const ok = r.status >= 200 && r.status < 400;
                const hasJson = r.body?.startsWith('{') || r.body?.startsWith('[');
                const blocked = r.body?.toLowerCase().includes('blocked') || r.body?.toLowerCase().includes('cloudflare') || r.body?.toLowerCase().includes('403');
                return `${ok && !blocked ? '✅' : '❌'} *${s.name}* — ${r.error || `${r.status} (${r.ms}ms)${hasJson ? ' JSON✓' : ''}`}`;
            }));
            await sock.sendMessage(jid, { text: `📊 *תוצאות בדיקת מקורות:*\n\n${results.join('\n')}` }); return;
        }
        if (text.startsWith('פרטי הסר ')) {
            const phone = normalizePhone(text.slice('פרטי הסר '.length));
            const targetJid = `${phone}@s.whatsapp.net`;
            privateWhitelist.delete(targetJid);
            saveSettings();
            await sock.sendMessage(jid, { text: `🗑️ +${phone} הוסר מהרשימה. (${privateWhitelist.size} נשארו)` }); return;
        }
    }

    // ── משחק רוצח — פרטי ─────────────────────────────────────────
    const normSenderJid = normJid(jid);

    // הרוצח בוחר קורבן
    if (text.startsWith('הרג ')) {
        const game = murderGame.getByMurderer(normSenderJid);
        if (game) {
            const targetName = text.slice('הרג '.length).trim();
            const target = game.players.find(p => p.alive && p.name.toLowerCase().includes(targetName.toLowerCase()) && p.jid !== normSenderJid);
            if (!target) {
                await sock.sendMessage(jid, { text: `⚠️ לא מצאתי שחקן חי בשם "${targetName}".\nהשחקנים החיים:\n${game.players.filter(p => p.alive && p.jid !== normSenderJid).map(p => `• ${p.name}`).join('\n')}` });
                return;
            }
            game.victimJid = target.jid;
            if (game.phaseTimer) clearTimeout(game.phaseTimer);
            await sock.sendMessage(jid, { text: `✅ בחרת ב-*${target.name}*. ממתין לבוקר...` });
            await murderGame.processNightEnd(sock, game.groupJid);
            return;
        }
    }

    // שחקן מבקש לדעת תפקידו
    if (text === 'תפקיד') {
        const game = murderGame.getByPlayer(normSenderJid);
        if (game) {
            const player = game.players.find(p => murderGame.normJ(p.jid) === normSenderJid);
            if (player?.role) {
                const roleText = player.role === 'murderer'
                    ? `🔪 *אתה הרוצח!*\nהשחקנים:\n${game.players.map(p=>`• ${p.name}`).join('\n')}\n\nשלח *הרג [שם]* בפרטי כאשר הלילה מגיע.`
                    : `👮 *אתה אזרח!*\nמצא את הרוצח וצבע: *הצבע [שם]* בקבוצה.`;
                await sock.sendMessage(jid, { text: roleText });
                return;
            }
        }
    }

    // ── בדיקת הרשאה ──────────────────────────────────────────────
    if (!canRespond(jid)) return;

    // ── אתר הסרטים StreamIL — הצטרפות לרשימת המאושרים 🎬 ────────
    if (text.startsWith('הוסף אותי לסרטים')) {
        const arg = text.slice('הוסף אותי לסרטים'.length).replace(/\D/g, '');
        let phone = null;
        if (arg.length >= 9) phone = normalizePhone(arg);
        else if (jid.endsWith('@s.whatsapp.net')) phone = normalizePhone(jid.split('@')[0]);
        else if (msg.key?.senderPn) phone = normalizePhone(msg.key.senderPn.split('@')[0]);
        if (!phone) {
            await sock.sendMessage(jid, { text: '🎬 לא הצלחתי לזהות את מספר הטלפון שלך.\nכתוב את הפקודה עם המספר, למשל:\n*הוסף אותי לסרטים 0501234567*' });
            return;
        }
        const local = '0' + phone.replace(/^972/, '');
        if (movieUsers.has(phone)) {
            await sock.sendMessage(jid, { text: `🎬 אתה כבר ברשימה! היכנס לאתר עם המספר *${local}* 🍿` });
            return;
        }
        movieUsers.add(phone);
        saveSettings();
        console.log(`🎬 movie access added: ${phone}`);
        await sock.sendMessage(jid, { text: `🎬 *נוספת לרשימת הסרטים!*\n\nהיכנס לאתר והקלד את מספר הטלפון שלך:\n*${local}*\n\nצפייה מהנה! 🍿` });
        return;
    }

    // ── מצב שיעורים — מורה פרטי AI 🎓 ───────────────────────────
    if (text === 'שיעורים') {
        tutorUsers.add(jid);
        dmHistory.delete(jid);
        saveSettings();
        await sock.sendMessage(jid, { text: '📚 *מצב שיעורים פעיל!*\n\nאני מאסטר — המורה הפרטי שלך 🎓\nשלח לי שאלה מכל מקצוע, או צלם תרגיל ושלח — ונפתור אותו יחד, שלב אחרי שלב.\n\nליציאה כתוב: *סיום שיעורים*' });
        return;
    }
    if (tutorUsers.has(jid)) {
        if (/^(סיום שיעורים|סיים שיעורים|יציאה משיעורים)$/.test(text)) {
            tutorUsers.delete(jid);
            dmHistory.delete(jid);
            saveSettings();
            await sock.sendMessage(jid, { text: '👋 יצאת ממצב שיעורים. כל הכבוד על הלמידה! 🎉\nלחזרה כתוב: *שיעורים*' });
            return;
        }
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});
        let studentText = text;
        if (hasImage) {
            const exercise = await readExerciseImage(sock, msg);
            if (!exercise) {
                await sock.sendMessage(jid, { text: '😅 לא הצלחתי לקרוא את התמונה. נסה לצלם שוב באור טוב, או פשוט כתוב לי את התרגיל.' });
                return;
            }
            studentText = text
                ? `[התלמיד שלח תמונה של תרגיל: ${exercise}]\nהתלמיד כתב: ${text}`
                : `[התלמיד שלח תמונה של תרגיל: ${exercise}]`;
        }
        const reply = await askGroq(jid, studentText, TUTOR_PROMPT);
        await sock.sendMessage(jid, { text: reply || 'מצטער, לא הצלחתי לחשוב כרגע 😅 נסה שוב בעוד רגע.' });
        return;
    }

    // ── בדיקת חסימת פקודות בפרטי ────────────────────────────────
    const cmdWord = text.split(' ')[0];
    if (privateBlockedCommands.has(cmdWord)) {
        await sock.sendMessage(jid, { text: `🔒 פקודת *${cmdWord}* אינה זמינה בפרטי.` }); return;
    }

    // ── פקודות קבוצה (ללא בדיקת פרימיום) ───────────────────────
    const handled = await handleFunCommand(sock, msg, jid, text, msg.pushName || '', [], jid, true);
    if (handled) return;

    // ── AI לכל הודעה אחרת ────────────────────────────────────────
    const reply = await askGroq(jid, text);
    if (reply) {
        await sock.sendMessage(jid, { text: reply });
    } else {
        await sock.sendMessage(jid, { text: 'מצטער, לא הצלחתי לחשוב כרגע 😅' });
    }
}

function isMovieUser(phone) {
    if (!phone) return false;
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 9) return false;
    return movieUsers.has(normalizePhone(digits));
}

module.exports = { handlePrivateMessage, isMovieUser };
