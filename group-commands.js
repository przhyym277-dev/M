'use strict';

require('dotenv').config();
const Groq = require('groq-sdk');
const QRCode = require('qrcode');
const pino = require('pino');
const https = require('https');
const http  = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const youtubedl = require('youtube-dl-exec');
const playdl = require('play-dl');
const { isCommandLocked } = require('./group-admin');
let sharp; try { sharp = require('sharp'); } catch {}

function downloadBuffer(url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: timeoutMs }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
    });
}

// Init SoundCloud client ID once on startup
playdl.getFreeClientID()
    .then(id => playdl.setToken({ soundcloud: { client_id: id } }))
    .catch(() => {});

const COOKIES_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');
if (process.env.YOUTUBE_COOKIES) {
    try { fs.writeFileSync(COOKIES_FILE, Buffer.from(process.env.YOUTUBE_COOKIES, 'base64').toString('utf8')); }
    catch {}
}

const YTDL_COMMON = {
    noWarnings: true,
    noCheckCertificates: true,
    jsRuntimes: `node:${process.execPath}`,
    extractorArgs: 'youtube:player_client=tv_embedded,android,ios,web_creator',
    ...(fs.existsSync(COOKIES_FILE) ? { cookies: COOKIES_FILE } : {}),
};

function cleanQuery(q) {
    return q
        .replace(/\(prod\.?\s*by[^)]*\)/gi, '')
        .replace(/\(official\s*(video|audio|lyric[s]?)[^)]*\)/gi, '')
        .replace(/\(clip\s*officiel[^)]*\)/gi, '')
        .replace(/\([^)]{0,6}\)/g, '')  // remove short parentheses like (HQ)
        .replace(/&/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 80);
}

const SC_COMMON = {
    noWarnings: true,
    noCheckCertificates: true,
    jsRuntimes: `node:${process.execPath}`,
    dumpSingleJson: true,
    format: 'bestaudio[ext=mp3]/bestaudio',
};

async function tryScSearch(q) {
    console.log(`🔍 scsearch: "${q}"`);
    const data = await youtubedl(`scsearch3:${q}`, {
        ...SC_COMMON,
        flatPlaylist: true,
    });
    if (data?.entries?.length) return data.entries;
    if (data?.id) return [data];
    return [];
}

async function downloadFromSoundCloud(query) {
    const cleaned = cleanQuery(query);
    const variants = [cleaned, query, cleaned.split(' ').slice(0, 3).join(' ')].filter((v, i, a) => v && a.indexOf(v) === i);

    for (const q of variants) {
        let entries = [];
        try { entries = await tryScSearch(q); } catch {}

        for (const entry of entries) {
            const trackUrl = entry.url || entry.webpage_url;
            if (!trackUrl) continue;
            console.log(`🎵 SC trying: "${entry.title}"`);
            try {
                const info = await youtubedl(trackUrl, SC_COMMON);
                if (!info?.url) continue;
                if ((info.duration || 0) > 660) continue;
                const buffer = await downloadBuffer(info.url);
                console.log(`✅ SC done: ${Math.round(buffer.length / 1024)}KB (${info.ext})`);
                const mimetype = info.ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
                return { buffer, title: info.title, mimetype };
            } catch {
                // 404 or unavailable — try next entry
            }
        }
    }

    throw new Error(`לא נמצא ב-SoundCloud: "${cleaned}"`);
}

async function downloadSong(query) {
    const urlMatch = query.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);

    // Only use YouTube when a direct URL is given
    if (urlMatch) {
        const videoId = urlMatch[1];
        try {
            console.log(`🎵 yt-dlp YT URL: ${videoId}`);
            const info = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
                ...YTDL_COMMON,
                dumpSingleJson: true,
                format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
                noPlaylist: true,
            });
            if (info?.url) {
                if ((info.duration || 0) > 660) throw new Error('השיר ארוך מדי (מקסימום 11 דקות)');
                console.log(`⬇️ YT stream (${info.ext})`);
                const buffer = await downloadBuffer(info.url);
                console.log(`✅ YT done: ${Math.round(buffer.length / 1024)}KB`);
                const mimetype = info.ext === 'webm' ? 'audio/ogg' : 'audio/mp4';
                return { buffer, title: info.title, mimetype };
            }
        } catch (e) {
            console.log(`⚠️ YT failed: ${e.message.slice(0, 80)} — trying SoundCloud`);
        }
        return await downloadFromSoundCloud(query);
    }

    // Search by name → SoundCloud first, YouTube as last resort
    try {
        return await downloadFromSoundCloud(query);
    } catch (scErr) {
        // only block non-retriable errors (e.g. "ארוך מדי")
        if (scErr.message === 'השיר ארוך מדי') throw scErr;
        console.log(`⚠️ SC failed (${scErr.message.slice(0, 60)}) — trying YouTube`);
    }

    // Last resort: YouTube search + download
    try {
        const search = await youtubedl(`ytsearch1:${query}`, {
            ...YTDL_COMMON,
            dumpSingleJson: true,
            flatPlaylist: true,
        });
        const entry = search?.entries?.[0];
        if (!entry?.id) throw new Error('לא נמצא ב-YouTube');
        console.log(`✅ YT found: "${entry.title}" — attempting download`);
        const info = await youtubedl(`https://www.youtube.com/watch?v=${entry.id}`, {
            ...YTDL_COMMON,
            dumpSingleJson: true,
            format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
            noPlaylist: true,
        });
        if (!info?.url) throw new Error('YT: לא ניתן לקבל קישור');
        if ((info.duration || 0) > 660) throw new Error('השיר ארוך מדי');
        const buffer = await downloadBuffer(info.url);
        const mimetype = info.ext === 'webm' ? 'audio/ogg' : 'audio/mp4';
        return { buffer, title: info.title, mimetype };
    } catch (ytErr) {
        throw new Error(`לא נמצא השיר לא ב-SoundCloud ולא ב-YouTube`);
    }
}

// ── pending multi-step flows & games ─────────────────────────
const pendingUserActions = new Map(); // `${jid}:${senderJid}` → action
const activeGames        = new Map(); // jid → game state

function formatDuration(secs) {
    if (!secs) return '';
    return `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
}

async function searchTracks(query) {
    // SoundCloud via play-dl (no yt-dlp needed)
    try {
        const results = await playdl.search(query, { source: { soundcloud: 'tracks' }, limit: 5 });
        if (results.length) {
            console.log(`✅ play-dl SC: ${results.length} results`);
            return results.map(r => ({
                title: r.name || 'ללא שם',
                duration: r.durationInSec ? formatDuration(r.durationInSec) : '',
                url: r.url,
                source: 'sc',
            }));
        }
    } catch (err) {
        console.error('play-dl SC search error:', String(err).slice(0, 120));
    }
    // YouTube fallback via yt-dlp
    try {
        const data = await youtubedl(`ytsearch5:${query}`, {
            noWarnings: true, noCheckCertificates: true,
            jsRuntimes: `node:${process.execPath}`,
            extractorArgs: 'youtube:player_client=tv_embedded,android',
            dumpSingleJson: true, flatPlaylist: true,
        });
        const entries = (data?.entries || []).filter(e => e.id).slice(0, 5);
        console.log(`✅ YT search: ${entries.length} results`);
        return entries.map(e => ({
            title: e.title || e.id,
            duration: formatDuration(e.duration),
            url: `https://www.youtube.com/watch?v=${e.id}`,
            source: 'yt',
        }));
    } catch (err) {
        console.error('YT search error:', String(err).slice(0, 120));
        return [];
    }
}

async function streamToBuffer(readable) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readable.on('data', c => chunks.push(c));
        readable.on('end', () => resolve(Buffer.concat(chunks)));
        readable.on('error', reject);
    });
}

async function downloadAsMp3(url, title) {
    // SoundCloud URL → stream via play-dl
    if (url.includes('soundcloud.com')) {
        try {
            const streamObj = await playdl.stream(url);
            const buffer = await streamToBuffer(streamObj.stream);
            if (buffer.length > 500) {
                console.log(`✅ play-dl download: ${Math.round(buffer.length/1024)}KB type=${streamObj.type}`);
                const mimetype = streamObj.type === 'ogg/opus' ? 'audio/ogg' : 'audio/mpeg';
                return { buffer, title, mimetype };
            }
        } catch (err) {
            console.error('play-dl stream error:', String(err).slice(0, 120));
        }
    }
    // yt-dlp fallback
    try { return await downloadFromSoundCloud(cleanQuery(title)); } catch {}
    const info = await youtubedl(url, {
        ...YTDL_COMMON, dumpSingleJson: true,
        format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio', noPlaylist: true,
    });
    if (!info?.url) throw new Error('לא ניתן להוריד');
    if ((info.duration || 0) > 660) throw new Error('השיר ארוך מדי');
    const buffer = await downloadBuffer(info.url);
    return { buffer, title: info.title || title, mimetype: info.ext === 'webm' ? 'audio/ogg' : 'audio/mp4' };
}

async function downloadAsMp4(ytUrl, title) {
    const info = await youtubedl(ytUrl, {
        ...YTDL_COMMON, dumpSingleJson: true,
        format: 'best[ext=mp4][height<=480]/best[ext=mp4]/best', noPlaylist: true,
    });
    if (!info?.url) throw new Error('לא ניתן להוריד');
    if ((info.duration || 0) > 600) throw new Error('הוידאו ארוך מדי (מקסימום 10 דקות)');
    const buffer = await downloadBuffer(info.url, 90000);
    if (buffer.length > 50 * 1024 * 1024) throw new Error('הקובץ גדול מדי (מעל 50MB)');
    return { buffer, title: info.title || title };
}

async function generateImage(prompt) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&model=flux-schnell&seed=${Math.floor(Math.random() * 99999)}`;
    return await downloadBuffer(url, 40000);
}

// ── tic-tac-toe ───────────────────────────────────────────────
const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
function boardText(board) {
    const c = i => board[i] === 'X' ? '❌' : board[i] === 'O' ? '⭕' : NUM_EMOJI[i];
    return `${c(0)} ${c(1)} ${c(2)}\n${c(3)} ${c(4)} ${c(5)}\n${c(6)} ${c(7)} ${c(8)}`;
}
const WIN_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function checkWin(board, p) { return WIN_LINES.some(([a,b,c]) => board[a]===p&&board[b]===p&&board[c]===p); }
function getBotMove(board) {
    for (const [a,b,c] of WIN_LINES) {
        if (board[a]==='O'&&board[b]==='O'&&!board[c]) return c;
        if (board[a]==='O'&&!board[b]&&board[c]==='O') return b;
        if (!board[a]&&board[b]==='O'&&board[c]==='O') return a;
    }
    for (const [a,b,c] of WIN_LINES) {
        if (board[a]==='X'&&board[b]==='X'&&!board[c]) return c;
        if (board[a]==='X'&&!board[b]&&board[c]==='X') return b;
        if (!board[a]&&board[b]==='X'&&board[c]==='X') return a;
    }
    if (!board[4]) return 4;
    for (const i of [0,2,6,8]) if (!board[i]) return i;
    for (let i = 0; i < 9; i++) if (!board[i]) return i;
    return -1;
}

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
const groupHistory    = new Map();  // jid -> [{sender, text}]
const groupCounters   = new Map();  // jid -> {topic, count}
const groupLists      = new Map();  // jid -> string[]

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
function calcGematria(t) { let v=0; for (const c of t) if (GEMATRIA_MAP[c]) v+=GEMATRIA_MAP[c]; return v; }

const HEBREW_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

const COUNTRY_CODES = [
    ['972','🇮🇱','ישראל'],['1','🇺🇸','ארה"ב / קנדה'],['44','🇬🇧','בריטניה'],
    ['49','🇩🇪','גרמניה'],['33','🇫🇷','צרפת'],['39','🇮🇹','איטליה'],
    ['34','🇪🇸','ספרד'],['7','🇷🇺','רוסיה'],['91','🇮🇳','הודו'],
    ['55','🇧🇷','ברזיל'],['61','🇦🇺','אוסטרליה'],['81','🇯🇵','יפן'],['86','🇨🇳','סין'],
];
function getCountryInfo(phone) {
    for (const [code, flag, name] of COUNTRY_CODES) {
        if (phone.startsWith(code)) return `${flag} ${name}`;
    }
    return '🌍 לא ידוע';
}

const LOCKABLE_PREFIXES = [
    ['ראפ ','ראפ'],['תרגם ','תרגם'],['מחמאה ','מחמאה'],['עלבון ','עלבון'],
    ['מתכון ','מתכון'],['תרגיל ','תרגיל'],['מילה ','מילה'],['שיר ','שיר'],
    ['סקר ','סקר'],['הצבעה ','הצבעה'],['אנונימי ','אנונימי'],['תזכורת ','תזכורת'],
    ['ספירה ','ספירה'],['מי אמר ','מי אמר'],['גימטריה ','גימטריה'],
    ['הגרלה ','הגרלה'],['חשב ','חשב'],['חזור ','חזור'],['מזל ','מזל'],
    ['qr ','qr'],['QR ','qr'],['פרופיל ','פרופיל'],
    ['תמונה ','תמונה'],['סטיקר ','סטיקר'],
];
const LOCKABLE_EXACT = new Set(['בדיחות','טיפ','עובדה','ציטוט','טריוויה','חידה','נכון או אמת','שידוך','רולטה','סיכום','תמלל','פרופיל','משחקים','ניחוש','איקס עיגול']);

function getLockedCommandName(text) {
    if (LOCKABLE_EXACT.has(text)) return text;
    for (const [prefix, name] of LOCKABLE_PREFIXES) {
        if (text.startsWith(prefix)) return name;
    }
    return null;
}

async function handleFunCommand(sock, msg, jid, text, pushName, groupParticipants, senderJid = '') {
    const t = Date.now();
    try {

        // ── pending multi-step actions ─────────────────────────────
        const pendingKey = `${jid}:${senderJid}`;
        const pending = pendingUserActions.get(pendingKey);
        if (pending) {
            if (Date.now() > pending.expiresAt) { pendingUserActions.delete(pendingKey); }
            else if (pending.type === 'song_results') {
                const n = parseInt(text.trim(), 10);
                if (!isNaN(n) && n >= 1 && n <= pending.results.length) {
                    const chosen = pending.results[n - 1];
                    pendingUserActions.set(pendingKey, { type: 'song_format', result: chosen, expiresAt: Date.now() + 3 * 60 * 1000 });
                    await sock.sendMessage(jid, {
                        text: `🎵 *${chosen.title}*${chosen.duration ? ` (${chosen.duration})` : ''}\n\nבאיזה פורמט?\n1️⃣ MP3 — שמע\n2️⃣ MP4 — וידאו`,
                    }, { quoted: msg });
                    return true;
                }
            } else if (pending.type === 'song_format') {
                const choice = text.trim().toLowerCase();
                if (['1','mp3','1️⃣','2','mp4','2️⃣'].includes(choice)) {
                    const wantMp4 = ['2','mp4','2️⃣'].includes(choice);
                    pendingUserActions.delete(pendingKey);
                    const { result } = pending;
                    await sock.sendMessage(jid, { text: `⬇️ מוריד *${result.title}*...` }, { quoted: msg });
                    try {
                        if (wantMp4) {
                            const { buffer, title } = await downloadAsMp4(result.url, result.title);
                            if (buffer.length > 50 * 1024 * 1024) { await sock.sendMessage(jid, { text: '❌ הקובץ גדול מדי' }); return true; }
                            await sock.sendMessage(jid, { video: buffer, mimetype: 'video/mp4', fileName: `${title}.mp4` }, { quoted: msg });
                        } else {
                            const { buffer, title, mimetype } = await downloadAsMp3(result.url, result.title);
                            if (buffer.length > 20 * 1024 * 1024) { await sock.sendMessage(jid, { text: '❌ הקובץ גדול מדי' }); return true; }
                            await sock.sendMessage(jid, { audio: buffer, mimetype, ptt: false }, { quoted: msg });
                            await sock.sendMessage(jid, { text: `🎵 *${title}*` });
                        }
                    } catch (e) {
                        await sock.sendMessage(jid, { text: `❌ שגיאה בהורדה: ${e.message.slice(0, 80)}` });
                    }
                    return true;
                }
            }
        }

        // ── active game handler ────────────────────────────────────
        const game = activeGames.get(jid);
        if (game) {
            if (game.type === 'guess') {
                const n = parseInt(text.trim(), 10);
                if (!isNaN(n) && n >= 1 && n <= 100) {
                    game.attempts++;
                    if (n === game.secret) {
                        activeGames.delete(jid);
                        await sock.sendMessage(jid, { text: `🎉 *כן!* המספר היה *${game.secret}*! ניצחת ב-${game.attempts} ניסיונות! 🏆` }, { quoted: msg });
                    } else {
                        const hint = n < game.secret ? '⬆️ גבוה יותר' : '⬇️ נמוך יותר';
                        await sock.sendMessage(jid, { text: `${hint} (ניסיון ${game.attempts})` }, { quoted: msg });
                    }
                    return true;
                }
                if (text.trim() === 'עצור') { activeGames.delete(jid); await sock.sendMessage(jid, { text: `🛑 משחק הופסק. המספר היה *${game.secret}*.` }); return true; }
            }
            if (game.type === 'tictactoe' && game.playerJid === senderJid) {
                const move = parseInt(text.trim(), 10) - 1;
                if (!isNaN(move) && move >= 0 && move < 9 && !game.board[move]) {
                    game.board[move] = 'X';
                    if (checkWin(game.board, 'X')) {
                        activeGames.delete(jid);
                        await sock.sendMessage(jid, { text: `${boardText(game.board)}\n\n🏆 ניצחת! כל הכבוד!` }, { quoted: msg });
                        return true;
                    }
                    if (game.board.every(c => c)) {
                        activeGames.delete(jid);
                        await sock.sendMessage(jid, { text: `${boardText(game.board)}\n\n🤝 תיקו!` }, { quoted: msg });
                        return true;
                    }
                    const botMove = getBotMove(game.board);
                    game.board[botMove] = 'O';
                    if (checkWin(game.board, 'O')) {
                        activeGames.delete(jid);
                        await sock.sendMessage(jid, { text: `${boardText(game.board)}\n\n🤖 הבוט ניצח! נסה שוב` }, { quoted: msg });
                        return true;
                    }
                    if (game.board.every(c => c)) {
                        activeGames.delete(jid);
                        await sock.sendMessage(jid, { text: `${boardText(game.board)}\n\n🤝 תיקו!` }, { quoted: msg });
                        return true;
                    }
                    await sock.sendMessage(jid, { text: `${boardText(game.board)}\n\n✍️ תורך — שלח מספר 1-9` }, { quoted: msg });
                    return true;
                }
                if (text.trim() === 'עצור') { activeGames.delete(jid); await sock.sendMessage(jid, { text: '🛑 המשחק הופסק.' }); return true; }
            }
        }

        // ── בדיקת נעילה ───────────────────────────────────────────
        const lockedName = getLockedCommandName(text);
        if (lockedName && isCommandLocked(jid, lockedName)) {
            await sock.sendMessage(jid, { text: '🔒 פקודה זו נעולה על ידי מנהל הקבוצה.' });
            return true;
        }

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
• \`ראפ [נושא]\` • \`תרגם [טקסט]\`
• \`מחמאה [שם]\` • \`עלבון [שם]\`
• \`מי אמר [ציטוט]\` • \`סיכום\`

🎲 *כיף*
• \`בדיחות\` • \`טיפ\` • \`עובדה\`
• \`ציטוט\` • \`טריוויה\` • \`חידה\`
• \`נכון או אמת\` • \`מזל [מזל]\`
• \`שידוך\` • \`רולטה\`
• \`תהילים\` • \`סמלים\`

📚 *ידע*
• \`מתכון [מנה]\` — מתכון מלא
• \`תרגיל [שריר]\` — תרגיל כושר
• \`מילה [מילה]\` — הגדרה + דוגמה

⚡ *כלים*
• \`פינג\` • \`זמן\` • \`ספידטסט\`
• \`חשב [תרגיל]\` • \`גימטריה [טקסט]\`
• \`הגרלה [א, ב, ג]\` • \`בחר [א | ב]\`
• \`חזור [טקסט]\` 🦜 • \`qr [טקסט]\`
• \`תמלל\` (כתגובה להקלטה)
• \`שיר [שם / URL]\` — חיפוש 10 תוצאות + הורדה 🎵
• \`תמונה [תיאור]\` — יצירת תמונה 🎨
• \`סטיקר [תיאור]\` — יצירת סטיקר 🖼️
• \`משחקים\` — ניחוש / איקס עיגול 🎮
• \`פרופיל [@משתמש]\` — פרטי חבר קבוצה

📊 *קבוצה*
• \`סקר [שאלה]\` — סקר כן/לא/אולי
• \`הצבעה [שאלה] | [א] | [ב] | [ג]\`
• \`אנונימי [הודעה]\` — שלח בסתר
• \`תזכורת [X שעות/דקות] [הודעה]\`
• \`רשימה + [פריט]\` — הוסף לרשימה
• \`רשימה - [מספר]\` — הסר מרשימה
• \`רשימה?\` — הצג רשימה
• \`רשימה נקה\` — נקה הכל
• \`ספירה [נושא]\` / \`++\` / \`ספירה?\`

🛡️ *ניהול (מנהלים בלבד)*
• \`הסרתקישורים\` / \`בטלהסרתקישורים\`
• \`הסרתסטיקרים\` / \`בטלהסרתסטיקרים\`
• \`אזהרות [מספר]\`
• \`נעל קבוצה\` / \`פתח קבוצה\`
• \`מנהלי קבוצה\` • \`ברוך הבא\`
• \`קישור\` • \`ניהול\` (כתגובה)` });
            return true;
        }

        // ── פרופיל ────────────────────────────────────────────────
        if (text === 'פרופיל' || text.startsWith('פרופיל ')) {
            let targetJid = null;
            let targetName = null;
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
            const quotedName = msg.message?.extendedTextMessage?.contextInfo?.pushName;
            if (mentioned && mentioned.length > 0) {
                targetJid = mentioned[0];
            } else if (quoted) {
                targetJid = quoted;
                targetName = quotedName || null;
            } else {
                const phoneMatch = text.match(/\d{7,15}/);
                if (phoneMatch) targetJid = `${phoneMatch[0]}@s.whatsapp.net`;
            }
            if (!targetJid) {
                targetJid = msg.key.participant || msg.key.remoteJid;
                targetName = pushName || null;
            }
            const phone = (targetJid.split('@')[0]).replace(/\D/g, '');
            const country = getCountryInfo(phone);
            const displayName = targetName || 'לא ידוע';
            let pfpBuf = null;
            try {
                const pfpUrl = await sock.profilePictureUrl(targetJid, 'image');
                pfpBuf = await downloadBuffer(pfpUrl, 10000);
            } catch {}
            const profileText =
                `👤 *פרופיל משתמש*\n\n` +
                `📛 *שם:* ${displayName}\n` +
                `📱 *מספר:* +${phone}\n` +
                `🆔 *מזהה:* ${targetJid}\n` +
                `🌍 *ארץ:* ${country}`;
            if (pfpBuf) {
                await sock.sendMessage(jid, { image: pfpBuf, caption: profileText, mentions: [targetJid] });
            } else {
                await sock.sendMessage(jid, { text: profileText, mentions: [targetJid] });
            }
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
                        messages: [{ role: 'system', content: 'אתה בוט חברים חכם ומצחיק. עברית, קצר, אמוג\'י.' }, ...history],
                        max_tokens: 300, temperature: 0.8,
                    });
                    reply = r.choices[0]?.message?.content?.trim() || null;
                    break;
                } catch (err) {
                    if ((err.status === 429 || err.message?.includes('429')) && i < GROQ_KEYS.length - 1) { groqKeyIndex++; continue; }
                    console.error('Groq AI error:', err.status, err.message?.slice(0, 120));
                    break;
                }
            }
            if (reply) {
                history.push({ role: 'assistant', content: reply });
                if (history.length > 8) history.splice(0, history.length - 8);
                await sock.sendMessage(jid, { text: reply });
            } else {
                await sock.sendMessage(jid, { text: 'מצטער, לא הצלחתי לחשוב כרגע 😅 נסה שוב' }, { quoted: msg });
            }
            return true;
        }

        // ── גימטריה ───────────────────────────────────────────────
        if (text.startsWith('גימטריה ')) {
            const input = text.slice('גימטריה '.length).trim();
            await sock.sendMessage(jid, { text: `🔢 *גימטריה ל"${input}":* ${calcGematria(input)}` });
            return true;
        }

        // ── הגרלה ─────────────────────────────────────────────────
        if (text.startsWith('הגרלה ')) {
            const input = text.slice('הגרלה '.length).trim();
            const items = input.includes(',') ? input.split(',').map(s=>s.trim()).filter(Boolean) : input.split(/\s+/).filter(Boolean);
            if (items.length < 2) { await sock.sendMessage(jid, { text: '⚠️ הכנס לפחות 2 אפשרויות' }); return true; }
            const chosen = items[Math.floor(Math.random() * items.length)];
            await sock.sendMessage(jid, { text: `🎲 *ההגרלה בחרה:* ${chosen} (מתוך ${items.length})` });
            return true;
        }

        // ── חשב ───────────────────────────────────────────────────
        if (text.startsWith('חשב ')) {
            const expr = text.slice('חשב '.length).trim();
            if (!/^[0-9+\-*/().\s%]+$/.test(expr)) { await sock.sendMessage(jid, { text: '❌ ביטוי לא חוקי' }); return true; }
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
            const items = input.includes(' | ') ? input.split(' | ').map(s=>s.trim()).filter(Boolean) : input.split(',').map(s=>s.trim()).filter(Boolean);
            if (items.length < 2) { await sock.sendMessage(jid, { text: '⚠️ הפרד ב-| או פסיק' }); return true; }
            await sock.sendMessage(jid, { text: `🎯 בחרתי: *${items[Math.floor(Math.random() * items.length)]}*` });
            return true;
        }

        // ── שידוך ─────────────────────────────────────────────────
        if (text === 'שידוך') {
            if (!groupParticipants || groupParticipants.length < 2) { await sock.sendMessage(jid, { text: '⚠️ אין מספיק משתתפים' }); return true; }
            const pool = [...groupParticipants].sort(() => Math.random() - 0.5);
            const p1 = pool[0]; const p2 = pool[1];
            const funny = await askGroq('קבוצת ווטסאפ', 'משפט מצחיק אחד על זוג חדש') || '💕';
            await sock.sendMessage(jid, { text: `💍 *שידוך!*\n@${p1.split('@')[0]} + @${p2.split('@')[0]}\n${funny}`, mentions: [p1, p2] });
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
            if (!quoted) { await sock.sendMessage(jid, { text: '⚠️ ענה על הודעת קול כדי לתמלל' }); return true; }
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const { toFile } = require('groq-sdk');
            const quotedMsg = {
                key: { remoteJid: jid, id: msg.message.extendedTextMessage.contextInfo.stanzaId, fromMe: false },
                message: msg.message.extendedTextMessage.contextInfo.quotedMessage,
            };
            const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const result = await getGroqClient().audio.transcriptions.create({ file: await toFile(buffer, 'voice.ogg', { type: 'audio/ogg' }), model: 'whisper-large-v3-turbo', language: 'he' });
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
            const psalm = await askGroq('אתה מכיר תהילים בעל פה.', `תהילים פרק ${n}`, 600);
            if (psalm) await sock.sendMessage(jid, { text: `📖 *תהילים פרק ${n}:*\n${psalm}` });
            return true;
        }

        // ── נכון או אמת ───────────────────────────────────────────
        if (text === 'נכון או אמת') {
            const q = await askGroq('מנחה משחקי מסיבה. שאלת "נכון או אמת" מצחיקה לקבוצת חברים, שאלה אחת בלבד.', 'שאלה');
            if (q) await sock.sendMessage(jid, { text: `🔥 *נכון או אמת?*\n\n${q}` });
            return true;
        }

        // ── ציטוט ─────────────────────────────────────────────────
        if (text === 'ציטוט') {
            const quote = await askGroq('אוסף ציטוטים. ציטוט השראה מפורסם. פורמט: "הציטוט" — השם.', 'ציטוט');
            if (quote) await sock.sendMessage(jid, { text: `✨ ${quote}` });
            return true;
        }

        // ── טריוויה ───────────────────────────────────────────────
        if (text === 'טריוויה') {
            const trivia = await askGroq('שואל טריוויה. שאלה בעברית עם 4 אפשרויות (א/ב/ג/ד) ובסוף ||התשובה: X||', 'טריוויה', 250);
            if (trivia) await sock.sendMessage(jid, { text: `🧠 *טריוויה!*\n\n${trivia}` });
            return true;
        }

        // ── חידה ──────────────────────────────────────────────────
        if (text === 'חידה') {
            const riddle = await askGroq(
                'אתה מציג חידות. כתוב חידה בעברית ואחריה את התשובה המוסתרת בפורמט: ||תשובה: X||',
                'חידה מעניינת', 200
            );
            if (riddle) await sock.sendMessage(jid, { text: `🎭 *חידה:*\n\n${riddle}` });
            return true;
        }

        // ── ראפ ───────────────────────────────────────────────────
        if (text.startsWith('ראפ ')) {
            const topic = text.slice('ראפ '.length).trim();
            const rap = await askGroq('ראפר ישראלי. ראפ קצר (4-8 שורות) מצחיק בעברית עם חריזה.', `ראפ על: ${topic}`, 300);
            if (rap) await sock.sendMessage(jid, { text: `🎤 *ראפ על "${topic}":*\n\n${rap}` });
            return true;
        }

        // ── תרגם ──────────────────────────────────────────────────
        if (text.startsWith('תרגם ')) {
            const input = text.slice('תרגם '.length).trim();
            const isHebrew = /[֐-׿]/.test(input);
            const targetLang = isHebrew ? 'אנגלית' : 'עברית';
            const translated = await askGroq(`תרגם ל${targetLang}. תן רק את התרגום.`, input, 200);
            if (translated) await sock.sendMessage(jid, { text: `🌐 *תרגום ל${targetLang}:*\n${translated}` });
            return true;
        }

        // ── מחמאה ─────────────────────────────────────────────────
        if (text.startsWith('מחמאה ')) {
            const name = text.slice('מחמאה '.length).trim().replace('@', '');
            const comp = await askGroq('אתה מחלק מחמאות מצחיקות וחמות. מחמאה אחת קצרה ומצחיקה בעברית.', `מחמאה עבור ${name}`, 150);
            if (comp) await sock.sendMessage(jid, { text: `💐 *מחמאה ל${name}:*\n${comp}` });
            return true;
        }

        // ── עלבון ─────────────────────────────────────────────────
        if (text.startsWith('עלבון ')) {
            const name = text.slice('עלבון '.length).trim().replace('@', '');
            const insult = await askGroq('אתה מחלק עלבונות קלים ומצחיקים לחלוטין. עלבון אחד קצר בעברית, לא פוגע באמת, כמו בין חברים.', `עלבון עבור ${name}`, 150);
            if (insult) await sock.sendMessage(jid, { text: `😈 *עלבון ל${name}:*\n${insult}` });
            return true;
        }

        // ── רולטה ─────────────────────────────────────────────────
        if (text === 'רולטה') {
            if (!groupParticipants || groupParticipants.length === 0) { await sock.sendMessage(jid, { text: '⚠️ אין משתתפים' }); return true; }
            const victim = groupParticipants[Math.floor(Math.random() * groupParticipants.length)];
            const callout = await askGroq('קבוצת חברים, ווטסאפ. משפט מצחיק של "רולטה רוסית" שנוחת על מישהו. קצר ומצחיק.', 'רולטה', 100) || '🎯 נפגע!';
            await sock.sendMessage(jid, { text: `🔫 *רולטה!*\n@${victim.split('@')[0]}... ${callout}`, mentions: [victim] });
            return true;
        }

        // ── מזל ───────────────────────────────────────────────────
        if (text.startsWith('מזל ')) {
            const sign = text.slice('מזל '.length).trim();
            const horoscope = await askGroq(
                'אתה אסטרולוג מצחיק. כתוב הורוסקופ יומי קצר ומצחיק בעברית למזל שיינתן.',
                `הורוסקופ יומי למזל ${sign}`, 200
            );
            if (horoscope) await sock.sendMessage(jid, { text: `⭐ *מזל ${sign} להיום:*\n\n${horoscope}` });
            return true;
        }

        // ── מתכון ─────────────────────────────────────────────────
        if (text.startsWith('מתכון ')) {
            const dish = text.slice('מתכון '.length).trim();
            const recipe = await askGroq(
                'אתה שף מנוסה. כתוב מתכון קצר בעברית: מצרכים + הוראות הכנה (ממוספרות). קצר ומעשי.',
                `מתכון ל: ${dish}`, 500
            );
            if (recipe) await sock.sendMessage(jid, { text: `🍳 *מתכון ל${dish}:*\n\n${recipe}` });
            return true;
        }

        // ── תרגיל ─────────────────────────────────────────────────
        if (text.startsWith('תרגיל ')) {
            const muscle = text.slice('תרגיל '.length).trim();
            const exercise = await askGroq(
                'אתה מאמן כושר. תאר תרגיל אחד מצוין בעברית: שם התרגיל, איך מבצעים (3-4 שלבים), כמה חזרות.',
                `תרגיל ל: ${muscle}`, 300
            );
            if (exercise) await sock.sendMessage(jid, { text: `💪 *תרגיל ל${muscle}:*\n\n${exercise}` });
            return true;
        }

        // ── מילה ──────────────────────────────────────────────────
        if (text.startsWith('מילה ')) {
            const word = text.slice('מילה '.length).trim();
            const def = await askGroq(
                'אתה מילון עברי. תן הגדרה קצרה של המילה + משפט לדוגמה. פורמט: *הגדרה:* X\n*לדוגמה:* Y',
                `המילה: ${word}`, 200
            );
            if (def) await sock.sendMessage(jid, { text: `📖 *${word}*\n${def}` });
            return true;
        }

        // ── מי אמר ────────────────────────────────────────────────
        if (text.startsWith('מי אמר ')) {
            const quote = text.slice('מי אמר '.length).trim();
            const hist = groupHistory.get(jid) || [];
            const names = [...new Set(hist.map(m => m.sender).filter(Boolean))];
            const nameList = names.length > 0 ? names.join(', ') : 'חברים בקבוצה';
            const answer = await askGroq(
                `חברי הקבוצה: ${nameList}. בהתאם לאישיות, מי הכי סביר שאמר את הציטוט? תשובה מצחיקה קצרה בעברית.`,
                `מי היה אומר: "${quote}"?`, 150
            );
            if (answer) await sock.sendMessage(jid, { text: `🤔 *מי אמר "${quote}"?*\n\n${answer}` });
            return true;
        }

        // ── סקר ───────────────────────────────────────────────────
        if (text.startsWith('סקר ')) {
            const question = text.slice('סקר '.length).trim();
            if (!question) { await sock.sendMessage(jid, { text: '⚠️ כתוב: סקר [שאלה]' }); return true; }
            await sock.sendMessage(jid, { poll: { name: question, values: ['כן ✅', 'לא ❌', 'אולי 🤔'], selectableCount: 1 } });
            return true;
        }

        // ── הצבעה ─────────────────────────────────────────────────
        if (text.startsWith('הצבעה ')) {
            const parts = text.slice('הצבעה '.length).split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 3) {
                await sock.sendMessage(jid, { text: '⚠️ כתוב: הצבעה [שאלה] | [א] | [ב] | [ג]\nדוגמה: הצבעה מה אוכלים? | פיצה | שווארמה | סושי' });
                return true;
            }
            const question = parts[0];
            const options = parts.slice(1).slice(0, 12);
            await sock.sendMessage(jid, { poll: { name: question, values: options, selectableCount: 1 } });
            return true;
        }

        // ── אנונימי ───────────────────────────────────────────────
        if (text.startsWith('אנונימי ')) {
            const anonMsg = text.slice('אנונימי '.length).trim();
            if (!anonMsg) { await sock.sendMessage(jid, { text: '⚠️ כתוב: אנונימי [הודעה]' }); return true; }
            await sock.sendMessage(jid, { text: `🎭 *הודעה אנונימית:*\n${anonMsg}` });
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
            setTimeout(async () => { try { await sock.sendMessage(jid, { text: `⏰ *תזכורת!*\n${reminderText}` }); } catch {} }, ms);
            return true;
        }

        // ── רשימה ─────────────────────────────────────────────────
        if (text.startsWith('רשימה')) {
            if (!groupLists.has(jid)) groupLists.set(jid, []);
            const list = groupLists.get(jid);
            const rest = text.slice('רשימה'.length).trim();

            if (rest.startsWith('+ ') || rest.startsWith('+')) {
                const item = rest.slice(1).trim();
                if (!item) { await sock.sendMessage(jid, { text: '⚠️ כתוב: רשימה + [פריט]' }); return true; }
                list.push(item);
                await sock.sendMessage(jid, { text: `✅ נוסף: *${item}*\nסה"כ: ${list.length} פריטים` });
                return true;
            }

            if (rest.startsWith('- ') || (rest.startsWith('-') && rest.length > 1)) {
                const idx = parseInt(rest.slice(1).trim(), 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= list.length) {
                    await sock.sendMessage(jid, { text: `⚠️ מספר לא תקין. יש ${list.length} פריטים.` });
                    return true;
                }
                const removed = list.splice(idx, 1)[0];
                await sock.sendMessage(jid, { text: `🗑️ הוסר: *${removed}*` });
                return true;
            }

            if (rest === 'נקה') {
                const count = list.length;
                list.length = 0;
                await sock.sendMessage(jid, { text: `🧹 הרשימה נוקתה (${count} פריטים הוסרו)` });
                return true;
            }

            if (rest === '?' || rest === '') {
                if (list.length === 0) { await sock.sendMessage(jid, { text: '📋 הרשימה ריקה\nהוסף: רשימה + [פריט]' }); return true; }
                const display = list.map((item, i) => `${i + 1}. ${item}`).join('\n');
                await sock.sendMessage(jid, { text: `📋 *הרשימה (${list.length}):*\n${display}` });
                return true;
            }
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
            if (!counter) { await sock.sendMessage(jid, { text: '⚠️ אין ספירה פעילה. כתוב: ספירה [נושא]' }); }
            else { await sock.sendMessage(jid, { text: `📊 *ספירה: ${counter.topic}*\nמונה: ${counter.count}` }); }
            return true;
        }

        if (text === '++') {
            const counter = groupCounters.get(jid);
            if (!counter) { await sock.sendMessage(jid, { text: '⚠️ אין ספירה פעילה. כתוב: ספירה [נושא]' }); }
            else { counter.count++; await sock.sendMessage(jid, { text: `📊 *${counter.topic}:* ${counter.count}` }); }
            return true;
        }

        // ── שיר ───────────────────────────────────────────────────
        if (text.startsWith('שיר ')) {
            const query = text.slice('שיר '.length).trim();
            // Direct YouTube URL → old single-step download
            if (query.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)) {
                await sock.sendMessage(jid, { text: `🎵 מוריד...` }, { quoted: msg });
                try {
                    const { buffer, title, mimetype } = await downloadSong(query);
                    if (buffer.length > 20 * 1024 * 1024) { await sock.sendMessage(jid, { text: '❌ השיר גדול מדי' }); return true; }
                    await sock.sendMessage(jid, { audio: buffer, mimetype, ptt: false }, { quoted: msg });
                    await sock.sendMessage(jid, { text: `🎵 *${title}*` });
                } catch (e) { await sock.sendMessage(jid, { text: `❌ שגיאה: ${e.message.slice(0, 80)}` }); }
                return true;
            }
            // Search → show 10 results
            await sock.sendMessage(jid, { text: `🔍 מחפש: *${query}*...` }, { quoted: msg });
            const results = await searchTracks(query);
            if (!results.length) { await sock.sendMessage(jid, { text: '❌ לא נמצאו תוצאות' }); return true; }
            const list = results.map((r, i) => `${i + 1}. ${r.title}${r.duration ? ` (${r.duration})` : ''}`).join('\n');
            await sock.sendMessage(jid, { text: `🎵 *תוצאות עבור "${query}":*\n\n${list}\n\nשלח מספר 1-${results.length} לבחירה` }, { quoted: msg });
            pendingUserActions.set(pendingKey, { type: 'song_results', results, expiresAt: Date.now() + 5 * 60 * 1000 });
            return true;
        }

        // ── תמונה ─────────────────────────────────────────────────
        if (text.startsWith('תמונה ')) {
            const prompt = text.slice('תמונה '.length).trim();
            await sock.sendMessage(jid, { text: `🎨 יוצר תמונה: *${prompt}*\n⏳ כ-10 שניות...` }, { quoted: msg });
            try {
                const imgBuf = await generateImage(prompt);
                if (!imgBuf || imgBuf.length < 1000 || imgBuf[0] === 0x3C) throw new Error('שירות יצירת התמונה לא זמין כרגע');
                try {
                    await sock.sendMessage(jid, { image: imgBuf, caption: `🎨 *${prompt}*` }, { quoted: msg });
                } catch { await sock.sendMessage(jid, { image: imgBuf, caption: `🎨 *${prompt}*` }); }
            } catch (e) {
                try { await sock.sendMessage(jid, { text: `❌ שגיאה ביצירת תמונה: ${e.message.slice(0, 80)}` }); } catch {}
            }
            return true;
        }

        // ── סטיקר ─────────────────────────────────────────────────
        if (text.startsWith('סטיקר ')) {
            await sock.sendMessage(jid, { text: '🖼️ פקודת הסטיקרים בתחזוקה כרגע, נחזור בקרוב! 🔧' });
            return true;
        }

        // ── משחקים ────────────────────────────────────────────────
        if (text === 'משחקים') {
            const cur = activeGames.get(jid);
            const active = cur ? `\n\n🎮 *משחק פעיל:* ${cur.type === 'guess' ? 'ניחוש מספרים' : 'איקס עיגול'} (כתוב *עצור* לסיום)` : '';
            await sock.sendMessage(jid, { text: `🎮 *משחקים זמינים:*\n\n1️⃣ *ניחוש* — ניחוש מספרים 1-100\n2️⃣ *איקס עיגול* — נגד הבוט${active}` });
            return true;
        }

        if (text === 'ניחוש') {
            if (activeGames.has(jid)) { await sock.sendMessage(jid, { text: '⚠️ יש כבר משחק פעיל. כתוב *עצור* קודם.' }); return true; }
            const secret = Math.floor(Math.random() * 100) + 1;
            activeGames.set(jid, { type: 'guess', secret, attempts: 0, playerJid: senderJid });
            await sock.sendMessage(jid, { text: `🔢 *ניחוש מספרים!*\nבחרתי מספר בין 1 ל-100.\nשלח ניחוש! (כתוב *עצור* לסיום)` });
            return true;
        }

        if (text === 'איקס עיגול') {
            if (activeGames.has(jid)) { await sock.sendMessage(jid, { text: '⚠️ יש כבר משחק פעיל. כתוב *עצור* קודם.' }); return true; }
            const board = Array(9).fill('');
            activeGames.set(jid, { type: 'tictactoe', board, playerJid: senderJid });
            await sock.sendMessage(jid, { text: `❌⭕ *איקס עיגול!*\nאתה ❌, הבוט ⭕\n\n${boardText(board)}\n\nשלח מספר 1-9 לבחירת מיקום` });
            return true;
        }

        // ── סיכום ─────────────────────────────────────────────────
        if (text === 'סיכום') {
            const hist = groupHistory.get(jid) || [];
            if (hist.length < 3) { await sock.sendMessage(jid, { text: '⚠️ אין מספיק הודעות לסיכום עדיין' }); return true; }
            const convo = hist.slice(-40).map(m => `${m.sender || 'מישהו'}: ${m.text}`).join('\n');
            const summary = await askGroq('מסכם שיחות ווטסאפ. 3-5 נקודות קצרות בעברית עם אמוג\'י.', `סכם:\n${convo}`, 400);
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
