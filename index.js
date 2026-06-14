require('dotenv').config();
const http = require('http');
const QRCode = require('qrcode');
const Groq = require('groq-sdk');
const crm = require('./crm');
const { generateQuote } = require('./quote');
const { generateContract } = require('./contract');
const { handleGroupMessage, handleGroupParticipantUpdate } = require('./group-bot');
const { handlePrivateMessage, isMovieUser, createMovieCode, verifyMovieCode, checkMovieToken, getMoviesActiveGroupJid } = require('./private-bot');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const https = require('https');
const GROQ_KEYS = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
].filter(Boolean);
let groqKeyIndex = 0;
// Per-key cooldown when TPD is hit: key → timestamp it's blocked until
const groqKeyCooldown = new Map();
// Per-key token usage tracking (accumulated since last restart)
const groqKeyUsage = new Map();
const GROQ_DAILY_LIMIT = 100_000;

function getGroqClient() {
    return new Groq({ apiKey: GROQ_KEYS[groqKeyIndex] });
}

function nextAvailableKeyIndex() {
    const now = Date.now();
    for (let i = 0; i < GROQ_KEYS.length; i++) {
        const idx = (groqKeyIndex + i) % GROQ_KEYS.length;
        const blocked = groqKeyCooldown.get(idx) || 0;
        if (now >= blocked) return idx;
    }
    return -1; // all on cooldown
}
const OWNER_NUMBER = process.env.OWNER_PHONE;
const OWNER_LID = process.env.OWNER_LID;
const OWNER_JID = OWNER_NUMBER + '@s.whatsapp.net';
const RENDER_SERVICE_ID = 'srv-d7usaljtqb8s73csmle0';

// 'assistant' | 'lead' | 'learning' — owner can switch modes
let ownerMode = 'assistant';

// Pending price quote approvals: Map<customerJid, { name, packageName, packageDetails }>
const pendingQuotes = new Map();

// Active reminders
const activeReminders = [];
let reminderIdCounter = 1;

// Projects & income (loaded from env, saved to Render)
function loadJSON(key, fallback = []) {
    try { return JSON.parse(process.env[key] || 'null') || fallback; } catch { return fallback; }
}
let projects   = loadJSON('PROJECTS_DATA');
let incomeLog  = loadJSON('INCOME_DATA');
let calendar   = loadJSON('CALENDAR_DATA');
let calendarIdCounter = (calendar.length ? Math.max(...calendar.map(e => e.id)) + 1 : 1);

// Pending meeting approval from owner: { customerJid, name, slots: [{date,time,day},...] }
let pendingMeetingApproval = null;

// Do Not Disturb mode
let doNotDisturb = false;
let missedMessages = []; // { name, phone, text } — collected while DND is on

// Follow-up tracking: jid → timestamp of last alert sent
const followUpSentAt = new Map();

async function parseCalendarEvent(text) {
    const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    try {
        const completion = await getGroqClient().chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{
                role: 'system',
                content: `Parse a Hebrew calendar event and return ONLY JSON: {"title":"...","date":"YYYY-MM-DD","time":"HH:MM","duration":60}.
Current date in Israel: ${now}. Year is 2026.
Example: "פגישה עם דוד ב-12/05 בשעה 10:00" → {"title":"פגישה עם דוד","date":"2026-05-12","time":"10:00","duration":60}
Return ONLY valid JSON.`
            }, { role: 'user', content: text }],
            max_tokens: 100, temperature: 0,
        });
        return JSON.parse(completion.choices[0]?.message?.content || 'null');
    } catch { return null; }
}

async function parseReminderIntent(text) {
    const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    try {
        const completion = await getGroqClient().chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{
                role: 'system',
                content: `Parse a Hebrew reminder and return ONLY JSON: {"delayMinutes": <number>, "message": "<reminder text>"}.
Current time in Israel: ${now}.
Examples:
"תזכיר לי בעוד שעה לקרוא לדוד" → {"delayMinutes":60,"message":"לקרוא לדוד"}
"תזכורת ב-15:00 לשלוח חשבונית" → calculate minutes from now to 15:00 today, message: "לשלוח חשבונית"
"תזכיר לי בעוד 30 דקות לפגישה" → {"delayMinutes":30,"message":"פגישה"}
Return ONLY valid JSON, nothing else.`
            }, { role: 'user', content: text }],
            max_tokens: 80, temperature: 0,
        });
        return JSON.parse(completion.choices[0]?.message?.content || 'null');
    } catch { return null; }
}

async function scheduleReminder(text, delayMs) {
    const id = reminderIdCounter++;
    const fireAt = new Date(Date.now() + delayMs);
    const timeoutId = setTimeout(async () => {
        await notifyOwner(`⏰ *תזכורת:* ${text}`);
        const idx = activeReminders.findIndex(r => r.id === id);
        if (idx !== -1) activeReminders.splice(idx, 1);
    }, delayMs);
    activeReminders.push({ id, text, timeoutId, fireAt });
    return { id, fireAt };
}

function generateReport() {
    const db = crm.getAll();
    const customers = Object.values(db);
    if (customers.length === 0) return '📊 אין לקוחות עדיין.';
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = customers.filter(c => new Date(c.firstSeen) >= monthStart).length;
    const byStatus = { new: 0, interested: 0, meeting_scheduled: 0, closed: 0, cold: 0 };
    customers.forEach(c => { if (byStatus[c.status] !== undefined) byStatus[c.status]++; });
    const convRate = customers.length > 0 ? Math.round(byStatus.closed / customers.length * 100) : 0;
    return `📊 *דוח לקוחות*\n\n` +
        `סה"כ: ${customers.length} | החודש: ${thisMonth} חדשים\n\n` +
        `🆕 חדש: ${byStatus.new}\n` +
        `🔥 מתעניין: ${byStatus.interested}\n` +
        `📅 פגישה: ${byStatus.meeting_scheduled}\n` +
        `✅ סגור: ${byStatus.closed}\n` +
        `❄️ קר: ${byStatus.cold}\n\n` +
        `אחוז סגירה: *${convRate}%*`;
}

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function formatCalendar() {
    if (calendar.length === 0) return '📅 היומן ריק.';
    const now = new Date();
    const upcoming = calendar
        .filter(e => new Date(e.date + 'T' + (e.time || '00:00')) >= now)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .slice(0, 10);
    if (upcoming.length === 0) return '📅 אין אירועים קרובים.';
    return '📅 *יומן קרוב:*\n\n' + upcoming.map(e => {
        const d = new Date(e.date);
        const day = DAY_NAMES[d.getDay()];
        const dateStr = `${d.getDate()}/${d.getMonth() + 1}`;
        return `• *${day} ${dateStr}* ${e.time ? `ב-${e.time}` : ''} — ${e.title} (${e.id})`;
    }).join('\n');
}

function findFreeSlots(count = 2) {
    const slots = [];
    const now = new Date();
    for (let d = 1; d <= 10 && slots.length < count; d++) {
        const date = new Date(now);
        date.setDate(date.getDate() + d);
        const dow = date.getDay();
        if (dow === 5 || dow === 6) continue; // skip Friday & Saturday
        const dateStr = date.toISOString().slice(0, 10);
        const dayEvents = calendar.filter(e => e.date === dateStr);
        for (const hour of [9, 10, 11, 14, 15, 16]) {
            const timeStr = `${String(hour).padStart(2, '0')}:00`;
            const busy = dayEvents.some(e => {
                const eh = parseInt((e.time || '0').split(':')[0]);
                return hour >= eh && hour < eh + ((e.duration || 60) / 60);
            });
            if (!busy) {
                slots.push({ date: dateStr, time: timeStr, day: DAY_NAMES[dow] });
                break;
            }
        }
    }
    return slots;
}

function renderApiRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = https.request({
            hostname: 'api.render.com',
            path,
            method,
            headers: {
                'Authorization': `Bearer ${process.env.RENDER_API_KEY}`,
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
            }
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function saveEnvVar(key, value) {
    const data = await renderApiRequest('GET', `/v1/services/${RENDER_SERVICE_ID}/env-vars`);
    const arr = Array.isArray(data) ? data : [];
    const merged = arr.map(e => ({ key: e.envVar.key, value: e.envVar.value }))
        .filter(e => e.key !== key);
    merged.push({ key, value: String(value) });
    await renderApiRequest('PUT', `/v1/services/${RENDER_SERVICE_ID}/env-vars`, merged);
    process.env[key] = String(value);
}

async function saveKnowledgeToRender(knowledge) { await saveEnvVar('BUSINESS_KNOWLEDGE', knowledge); }

async function saveProjects()  { await saveEnvVar('PROJECTS_DATA',  JSON.stringify(projects)); }
async function saveIncome()    { await saveEnvVar('INCOME_DATA',    JSON.stringify(incomeLog)); }
async function saveCalendar()  { await saveEnvVar('CALENDAR_DATA',  JSON.stringify(calendar)); }

function formatProjects() {
    if (projects.length === 0) return '📋 אין פרויקטים פעילים.';
    const STATUS_ICON = { 'פעיל': '🔵', 'עיצוב': '🎨', 'פיתוח': '⚙️', 'בדיקות': '🧪', 'מסירה': '📦', 'הושלם': '✅', 'הקפאה': '❄️' };
    return '📋 *פרויקטים:*\n\n' + projects.map((p, i) => {
        const icon = STATUS_ICON[p.status] || '🔵';
        const price = p.price ? ` | ₪${Number(p.price).toLocaleString('he-IL')}` : '';
        return `${i + 1}. ${icon} *${p.name}*${price}\nסטטוס: ${p.status} | לקוח: ${p.client || '—'}`;
    }).join('\n\n');
}

function formatIncomeReport() {
    if (incomeLog.length === 0) return '💰 אין הכנסות מתועדות.';
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = incomeLog.filter(e => new Date(e.date) >= monthStart);
    const total = thisMonth.reduce((s, e) => s + e.amount, 0);
    const allTime = incomeLog.reduce((s, e) => s + e.amount, 0);
    const lines = thisMonth.map(e => `• ₪${e.amount.toLocaleString('he-IL')}${e.note ? ` — ${e.note}` : ''}`).join('\n');
    return `💰 *הכנסות החודש:* ₪${total.toLocaleString('he-IL')}\n\n${lines || 'אין עדיין'}\n\n📊 סה"כ כל הזמנים: ₪${allTime.toLocaleString('he-IL')}`;
}

function isOwnerPhone(jid) {
    return jid.includes(OWNER_NUMBER) || (OWNER_LID && jid.includes(OWNER_LID));
}

function getText(msg) {
    return msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || '';
}

let currentQR = null;
let botStatus = 'waiting';
let sock = null;

// Health check + QR server
const PORT = process.env.PORT || 3000;
// מאתר את קבוצת "בוטיקס" לשליחת קודי אימות לאתר הסרטים
let moviesGroupJid = null;
async function findMoviesGroup() {
    if (moviesGroupJid) return moviesGroupJid;
    const groups = await sock.groupFetchAllParticipating();
    for (const [gjid, g] of Object.entries(groups)) {
        if ((g.subject || '').includes('בוטיקס')) { moviesGroupJid = gjid; return gjid; }
    }
    return null;
}

http.createServer(async (req, res) => {
    // CORS — allow all origins for all routes
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url.startsWith('/movies-')) {
        const u = new URL(req.url, 'http://localhost');
        const phone = u.searchParams.get('phone') || '';
        const json = (obj) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        if (u.pathname === '/movies-check') {
            const groupJid = getMoviesActiveGroupJid();
            if (!groupJid) return json({ allowed: false, reason: 'no_active_group' });
            if (!sock || botStatus !== 'connected') return json({ allowed: false, reason: 'bot_offline' });
            try {
                const digits = String(phone).replace(/\D/g, '');
                const normalized = digits.startsWith('972') ? digits : digits.startsWith('0') ? '972' + digits.slice(1) : '972' + digits;
                const meta = await sock.groupMetadata(groupJid);
                const found = meta.participants.some(p => {
                    const num = (p.id || '').replace(/\D/g, '');
                    return num === normalized || num === digits;
                });
                return json({ allowed: found });
            } catch (e) {
                console.error('movies-check error:', e.message);
                return json({ allowed: false, reason: 'error' });
            }
        }
        if (u.pathname === '/movies-code') {
            if (!isMovieUser(phone)) return json({ sent: false, reason: 'not_allowed' });
            if (!sock || botStatus !== 'connected') return json({ sent: false, reason: 'bot_offline' });
            const r = createMovieCode(phone);
            if (r.error) return json({ sent: false, reason: r.error });
            try {
                const groupJid = await findMoviesGroup();
                if (!groupJid) return json({ sent: false, reason: 'group_not_found' });
                const userJid = `${r.phone}@s.whatsapp.net`;
                await sock.sendMessage(groupJid, {
                    text: `🎬 קוד אימות לאתר הסרטים עבור @${r.phone}:\n\n*${r.code}*\n\nהקוד תקף ל-5 דקות.`,
                    mentions: [userJid],
                });
                return json({ sent: true });
            } catch (e) {
                console.error('movies-code send error:', e.message);
                return json({ sent: false, reason: 'send_failed' });
            }
        }
        if (u.pathname === '/movies-verify') {
            const token = verifyMovieCode(phone, u.searchParams.get('code') || '');
            return json(token ? { ok: true, token } : { ok: false });
        }
    }
    if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: botStatus, hasQR: !!currentQR }));
        return;
    }
    if (req.url === '/qr-image') {
        if (!currentQR) { res.writeHead(204); res.end(); return; }
        const imgData = await QRCode.toDataURL(currentQR, { width: 260, margin: 2 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ img: imgData }));
        return;
    }
    if (req.url === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html dir="rtl"><head>
<meta charset="utf-8"/>
<title>חיבור WhatsApp</title>
<style>
  body{margin:0;font-family:sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .box{background:#fff;border-radius:16px;padding:32px;text-align:center;box-shadow:0 2px 16px #0001;width:300px}
  h2{margin:0 0 8px;color:#111;font-size:20px}
  .sub{color:#888;font-size:13px;margin-bottom:20px}
  #qr-img{width:240px;height:240px;border-radius:8px;display:block;margin:0 auto}
  .step{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #f0f0f0;font-size:14px}
  .dot{width:12px;height:12px;border-radius:50%;background:#ddd;flex-shrink:0}
  .dot.active{background:#25d366}
  .dot.spin{background:#f5a623;animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #status-msg{margin-top:16px;font-size:13px;color:#888;min-height:20px}
  #banner{display:none;background:#e8f5e9;color:#25d366;padding:8px;border-radius:8px;font-weight:bold;margin-bottom:8px;font-size:14px}
</style></head>
<body><div class="box">
  <h2>חיבור WhatsApp</h2>
  <p class="sub">סרוק עם המספר הייעודי של הבוט</p>
  <div id="banner"></div>
  <img id="qr-img" src="" alt="טוען QR..."/>
  <div id="status-msg">ממתין לסריקה...</div>
  <div class="step"><div class="dot active" id="d1"></div><span>ממתין לסריקה</span></div>
  <div class="step"><div class="dot" id="d2"></div><span>QR נסרק</span></div>
  <div class="step"><div class="dot" id="d3"></div><span>מתחבר ל-WhatsApp</span></div>
  <div class="step"><div class="dot" id="d4"></div><span>מחובר ומוכן!</span></div>
</div>
<script>
let lastStatus='waiting',lastQR='';
async function refresh(){
  try{
    const s=await fetch('/status').then(r=>r.json());
    if(s.status!==lastStatus){
      lastStatus=s.status;
      const msg=document.getElementById('status-msg');
      const d2=document.getElementById('d2'),d3=document.getElementById('d3'),d4=document.getElementById('d4');
      if(s.status==='scanned'){d2.className='dot active';d3.className='dot spin';msg.textContent='QR נסרק! מתחבר...';}
      else if(s.status==='connected'){d2.className='dot active';d3.className='dot active';d4.className='dot active';msg.style.color='#25d366';msg.style.fontWeight='bold';msg.textContent='✅ מחובר! הבוט פעיל.';document.getElementById('qr-img').style.display='none';document.getElementById('banner').style.display='none';}
    }
    if(s.hasQR&&s.status==='waiting'){
      const q=await fetch('/qr-image').then(r=>r.json());
      if(q.img&&q.img!==lastQR){lastQR=q.img;const img=document.getElementById('qr-img');img.src=q.img;img.style.outline='4px solid #25d366';const b=document.getElementById('banner');b.style.display='block';b.textContent='🔄 QR חדש — סרוק עכשיו!';setTimeout(()=>{img.style.outline='none';b.style.display='none';},5000);}
    }
  }catch(e){}
  setTimeout(refresh,2000);
}
refresh();
</script></body></html>`);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
}).listen(PORT, () => console.log(`Server on port ${PORT} | QR: /qr`));

const PACKAGES = {
    'כניסה':             { details: 'דף נחיתה מעוצב, טופס לידים, SEO בסיסי | 48 שעות' },
    'צמיחה דיגיטלית':   { details: '+ אנימציות, Analytics, WhatsApp | תמיכה 2 חודשים' },
    'full-stack':        { details: '+ Backend, DB, Dashboard, API | תמיכה 3 חודשים' },
};

const SALES_PROMPT = `אתה "מאקס" — נציג מכירות של מאסטר קוד.

על החברה:
מאסטר קוד בונה דפי נחיתה ואתרים לעסקים קטנים ובינוניים בישראל.
הבעלים: יאיר | טלפון: 0522091733
התמחות: דפי נחיתה שממירים, SEO, חנויות אונליין, מערכות ניהול, בוטים לוואטסאפ.
לקוחות טיפוסיים: בעלי עסקים, קוזמטיקאיות, מאמנים, עורכי דין, רופאים, יזמים.
יתרון תחרותי: מהירות (48 שעות לדף בסיסי), תמיכה אישית, מחירים הוגנים.

החבילות (תאר אותן ללקוח אבל אל תציין מחיר — המחיר יישלח בהצעה מפורטת):
1. 🚀 כניסה — דף נחיתה מעוצב, טופס לידים, SEO בסיסי, 48 שעות
2. 📈 צמיחה דיגיטלית — + אנימציות, Google Analytics, חיבור WhatsApp, תמיכה 2 חודשים
3. 💎 Full-Stack — + Backend, בסיס נתונים, Dashboard ניהול, API, תמיכה 3 חודשים

כלל מחיר — חשוב מאוד:
- לעולם אל תציין מחיר ספציפי בשיחה
- אם לקוח שואל כמה זה עולה — אמור: "המחיר תלוי בדרישות שלך, אכין לך הצעה מותאמת תוך דקות"
- המחיר יישלח ישירות בהצעת המחיר הרשמית

כללי שפה:
- עברית תקינה, חמה ומשכנעת
- משפטים קצרים וחדים, אמוג'י במידה
- תמיד תסיים עם שאלה שמקדמת סגירה

טכניקת מכירה:
- שאל שאלות להבנת הצורך לפני הצעה
- הדגש תוצאות: "לקוחות ימצאו אותך בגוגל" לא "SEO"
- דחיפות: "יש לנו חלון פנוי השבוע"
- כשמוכן לפגישה: "מתי נוח לך לשיחה קצרה של 15 דקות עם יאיר?"

איסוף מידע — בטבעיות תוך כדי שיחה:
- שם הלקוח
- מייל (לשליחת הצעה)

כשלקוח מוכן להצעת מחיר — אמור: "מצוין! אכין לך הצעה מפורטת ואשלח תוך דקות" והוסף חובה:
QUOTE_REQUEST:[שם החבילה המתאימה]

כשלקוח רוצה לקבוע פגישה/שיחה עם יאיר — אמור: "מעולה! אבדוק זמינות ואחזור אליך תוך דקות" והוסף חובה:
MEETING_REQUEST:[שם הלקוח]
שים לב: יאיר לא עובד ביום שישי ושבת — אל תציע זמנים אלו.

אל תאמר "יאיר יחזור אליך" — נהל את השיחה עצמאית עד לסגירה.

בסוף כל תשובה הוסף:
STATUS:[new|interested|meeting_scheduled|cold]
NAME:[שם הלקוח או UNKNOWN]
EMAIL:[מייל הלקוח או UNKNOWN]`;

const ASSISTANT_PROMPT = `אתה השותף העסקי החכם של יאיר — לא סתם AI, אלא יועץ שמכיר את העסק לעומק.

זהות:
- ישיר וחד — נותן תשובה, לא "זה תלוי..."
- מכיר את השוק הישראלי: מע"מ 18%, שוטף+30/60/90, ביט/פייבוקס, חשבונית מס קבלה
- יוזם — כשעוזר עם X, מציע גם את הצעד הבא הלוגי
- אמיתי — אומר גם כשרעיון לא טוב

על יאיר ועסקו:
- בעל מאסטר קוד — דפי נחיתה, אתרים, בוטים לוואטסאפ, SEO
- לקוחות: עסקים קטנים-בינוניים בישראל — קוזמטיקאיות, מאמנים, עורכי דין, יזמים

מחשבון פרויקטים — כשמבקשים הערכה:
פרק לרכיבים (עיצוב / פיתוח / תוכן / בדיקות), תן זמן בשעות ומחיר טווח מינימום–מקסימום.
הוסף תמיד: "מה שישנה את המחיר: [גורמים]"

כללי תפוקה:
- ניסוח הודעה/מייל → תן טקסט מוכן ישר, ללא הקדמות
- אסטרטגיה → 3 אפשרויות עם יתרון/חיסרון + המלצה אחת
- רעיונות → 3-5 קונקרטיים, לא כלליים
- תמיד תסיים עם הצעד הבא המומלץ

תחומי עזרה — הכל ללא יוצא מן הכלל:
עסקי, שיווק, קוד, פוסטים לסושיאל, ניסוח חוזים, גביית חובות, ספורט, בישול — כל מה שיאיר צריך.`;

const MEETING_PROMPT = `אתה יועץ מכירות בזמן אמת — יאיר בפגישה עם לקוח עכשיו.
ענה קצר, חד, מוכן לאמירה — משפט אחד עד שניים מקסימום.

כשלקוח מתנגד למחיר → תן משפט לאמירה עכשיו
כשלקוח לא בטוח → תן שאלה שתסגור אותו
כשלקוח שואל על מתחרה → תן יתרון אחד חד
כשיאיר מבקש לסגור → תן "משפט הסגירה" — ישיר

אל תסביר, אל תנתח — רק תן את המשפט לאמירה.`;

const CRISIS_PROMPT = `אתה יועץ לניהול לקוח בעייתי — יאיר צריך עזרה עכשיו.
תן תגובות מוכנות לשליחה ישירות ללקוח.

לקוח כועס → הרגע תחילה, אל תתנצל יותר מדי, הצע פתרון ספציפי
לקוח רוצה לבטל → שאל מה הבעיה, הצע תיקון — לא החזר כסף ישר
לקוח לא מרוצה מעיצוב → הודה + הצע סבב תיקונים מוגדר
לקוח לא משלם → תן הודעת גביה מנומסת אך נחרצת

פורמט תגובה:
💬 *לשלוח ללקוח:*
[הטקסט המוכן]

🧠 *האסטרטגיה:*
[הסבר קצר למה]`;

const LEARNING_PROMPT = `אתה לומד על העסק של יאיר כדי לעזור לו טוב יותר.
שאל שאלה ממוקדת אחת בכל פעם — קצרה וברורה.
אם קיבלת ידע קיים על העסק — בדוק מה חסר ושאל רק על הפערים.
נושאים ללמוד (אם עוד לא ידוע):
1. שירותים/מוצרים שהעסק מציע
2. מחיר כל שירות
3. מה כולל כל שירות
4. לוח זמנים לביצוע
5. תנאי תשלום
6. לקוחות טיפוסיים
7. יתרונות על המתחרים
8. תהליך עבודה עם לקוח חדש
9. כל מידע נוסף שיאיר רוצה לשתף

כשיאיר עונה — אשר בקצרה שהבנת ועבור לשאלה הבאה.
אל תשאל יותר משאלה אחת בכל פעם.
אל תשאל על מידע שכבר ידוע לך.`;

function buildSystemPrompt(mode) {
    const knowledge = process.env.BUSINESS_KNOWLEDGE;
    const knowledgeBlock = knowledge ? `\n\n---\nידע על העסק:\n${knowledge}` : '';
    const today = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const dateBlock = `\n\n📅 תאריך היום: ${today}`;
    if (mode === 'learning') return LEARNING_PROMPT;
    if (mode === 'meeting') return MEETING_PROMPT + knowledgeBlock;
    if (mode === 'crisis')  return CRISIS_PROMPT  + knowledgeBlock;
    if (mode === 'assistant') return ASSISTANT_PROMPT + knowledgeBlock;
    return SALES_PROMPT + dateBlock + knowledgeBlock;
}

const conversations = new Map();

function parseAIReply(raw) {
    const statusMatch = raw.match(/STATUS:\s*\[?([\w_]+)\]?/);
    const nameMatch   = raw.match(/NAME:\s*\[?(.+?)\]?\s*$/m);
    const emailMatch  = raw.match(/EMAIL:\s*\[?(.+?)\]?\s*$/m);
    const quoteMatch   = raw.match(/QUOTE_REQUEST:\s*\[?(.+?)\]?\s*$/m);
    const meetingMatch = raw.match(/MEETING_REQUEST:\s*\[?(.+?)\]?\s*$/m);
    // Remove entire lines that contain any of the meta tags
    const clean = raw
        .split('\n')
        .filter(line => !/STATUS:|NAME:|EMAIL:|QUOTE_REQUEST:|MEETING_REQUEST:/.test(line))
        .join('\n')
        .trim();
    return {
        reply:        clean,
        status:       statusMatch ? statusMatch[1] : null,
        name:         nameMatch  && nameMatch[1].trim()  !== 'UNKNOWN' ? nameMatch[1].trim()  : null,
        email:        emailMatch && emailMatch[1].trim() !== 'UNKNOWN' ? emailMatch[1].trim() : null,
        quoteRequest:   quoteMatch   ? quoteMatch[1].trim()   : null,
        meetingRequest: meetingMatch ? meetingMatch[1].trim() : null,
    };
}

async function getAIResponse(jid, userMessage, mode) {
    const systemPrompt = buildSystemPrompt(mode);
    if (!conversations.has(jid)) conversations.set(jid, []);
    const history = conversations.get(jid);
    history.push({ role: 'user', content: userMessage });
    if (history.length > 10) history.splice(0, history.length - 10);

    for (let attempt = 0; attempt < GROQ_KEYS.length; attempt++) {
        const keyIdx = nextAvailableKeyIndex();
        if (keyIdx === -1) {
            console.log('⛔ כל מפתחות Groq בהקפאה');
            return { reply: null, understood: false, allKeysDown: true };
        }
        groqKeyIndex = keyIdx;
        try {
            const client = getGroqClient();
            const completion = await client.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'system', content: systemPrompt }, ...history],
                max_tokens: 380,
                temperature: 0.7,
            });
            const raw = completion.choices[0]?.message?.content || '';
            history.push({ role: 'assistant', content: raw });
            const tokensUsed = completion.usage?.total_tokens || 0;
            groqKeyUsage.set(groqKeyIndex, (groqKeyUsage.get(groqKeyIndex) || 0) + tokensUsed);
            return { ...parseAIReply(raw), understood: true };
        } catch (err) {
            const is429 = err.message?.includes('429') || err.status === 429;
            if (is429) {
                const retryMatch = err.message?.match(/try again in (\d+)m([\d.]+)s/);
                const cooldownMs = retryMatch
                    ? (Number(retryMatch[1]) * 60 + Number(retryMatch[2])) * 1000 + 5000
                    : 25 * 60 * 1000;
                const refreshAt = Date.now() + cooldownMs;
                groqKeyCooldown.set(groqKeyIndex, refreshAt);
                const refreshTime = new Date(refreshAt).toLocaleTimeString('he-IL', {
                    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem'
                });
                const mins = Math.ceil(cooldownMs / 60000);
                console.log(`⚠️ Groq key ${groqKeyIndex + 1} הגיע ללימיט — מתחדש בשעה ${refreshTime}`);
                notifyOwner(`⚠️ *Groq מפתח ${groqKeyIndex + 1} נגמר*\nמתחדש בשעה *${refreshTime}* (בעוד ${mins} דק')`).catch(() => {});
                groqKeyIndex = (groqKeyIndex + 1) % GROQ_KEYS.length;
                continue;
            }
            console.error('Groq error:', err.message);
            return { reply: null, understood: false };
        }
    }
    return { reply: null, understood: false, allKeysDown: true };
}

function parseOwnerCommand(text) {
    const t = text.trim();
    if (/^api$|^סטטוס api$|^מפתחות$/i.test(t)) return { cmd: 'api_status' };
    if (/^נקה הכל$|^מחק הכל$/.test(t)) return { cmd: 'clear_all' };
    if (/^מצב למידה$|^למד$/.test(t))        return { cmd: 'mode_learning' };
    if (/^סיים למידה$|^שמור ידע$|^סיים$/.test(t)) return { cmd: 'save_learning' };
    if (/^עזרה$|^פקודות$|^help$/.test(t)) return { cmd: 'help' };
    if (/^לילה טוב$|^לילה טוב 🌙$/.test(t)) return { cmd: 'dnd_on' };
    if (/^בוקר טוב$|^בוקר טוב ☀️$/.test(t)) return { cmd: 'dnd_off' };
    if (/^דוח$|^סטטיסטיקות$|^סטט$/.test(t)) return { cmd: 'report' };
    if (/^תזכורות$|^תזכורות פעילות$/.test(t)) return { cmd: 'list_reminders' };
    if (/תזכיר לי|תזכורת ב/.test(t)) return { cmd: 'reminder', text: t };
    if (/^מחק תזכורת\s+(\d+)$/.test(t)) { const m = t.match(/^מחק תזכורת\s+(\d+)$/); return { cmd: 'delete_reminder', id: Number(m[1]) }; }
    // Meeting & crisis modes
    if (/^פגישה$|^מצב פגישה$/.test(t)) return { cmd: 'mode_meeting' };
    if (/^לקוח בעייתי$|^לקוח כועס$|^משבר לקוח$/.test(t)) return { cmd: 'mode_crisis' };
    // Projects
    if (/^פרויקטים$/.test(t)) return { cmd: 'projects_list' };
    const projNew = t.match(/^פרויקט חדש\s+(.+?)\s+(\d+)$/);
    if (projNew) return { cmd: 'project_add', name: projNew[1], price: Number(projNew[2]) };
    const projUpdate = t.match(/^עדכן\s+(.+?):\s*(.+)$/);
    if (projUpdate) return { cmd: 'project_update', name: projUpdate[1].trim(), status: projUpdate[2].trim() };
    const projClose = t.match(/^סגור פרויקט\s+(.+)$/);
    if (projClose) return { cmd: 'project_close', name: projClose[1].trim() };
    const projDel = t.match(/^מחק פרויקט\s+(.+)$/);
    if (projDel) return { cmd: 'project_delete', name: projDel[1].trim() };
    // Income
    if (/^הכנסות$/.test(t)) return { cmd: 'income_report' };
    const income = t.match(/^סגרתי\s+(\d+)(?:\s+(.+))?$/);
    if (income) return { cmd: 'income_add', amount: Number(income[1]), note: income[2] || null };
    // Calendar
    if (/^יומן$/.test(t)) return { cmd: 'calendar_show' };
    const calDel = t.match(/^מחק אירוע\s+(\d+)$/);
    if (calDel) return { cmd: 'calendar_delete', id: Number(calDel[1]) };
    const approveSlot = t.match(/^אשר פגישה\s+([1-3])$/);
    if (approveSlot && pendingMeetingApproval) return { cmd: 'meeting_approve', slotIndex: Number(approveSlot[1]) - 1 };
    if (/^אשר פגישה$|^אשר$/.test(t) && pendingMeetingApproval) return { cmd: 'meeting_approve', slotIndex: 0 };
    const meetingDecline = t.match(/^דחה פגישה(?:\s+(.+))?$/);
    if (meetingDecline && pendingMeetingApproval) return { cmd: 'meeting_decline', alt: meetingDecline[1] || null };
    const summaryMatch = t.match(/^סיכום\s+(.+)$/);
    if (summaryMatch) return { cmd: 'customer_summary', name: summaryMatch[1].trim() };
    // "הוסף אירוע [title] בתאריך [date] בשעה [time]" — parsed by AI
    if (/^הוסף אירוע|^אירוע חדש/.test(t)) return { cmd: 'calendar_add_raw', text: t };
    const broadcastMatch = t.match(/^שדר\s+([֐-׿\w]+)\s+([\s\S]+)$/);
    if (broadcastMatch) return { cmd: 'broadcast', filter: broadcastMatch[1].trim(), msg: broadcastMatch[2].trim() };
    const contractMatch = t.match(/^חוזה\s+([0-9]+)\s+(.+?)\s+([0-9]+)(?:\s+([0-9]+))?$/);
    if (contractMatch) return { cmd: 'contract', phone: contractMatch[1], service: contractMatch[2].trim(), amount: Number(contractMatch[3]), days: Number(contractMatch[4] || 14) };
    if (/^לקוחות$|^רשימה$/.test(t)) return { cmd: 'list' };
    if (/^מי דיבר$|^שמות$/.test(t))  return { cmd: 'names' };
    if (/^עבור למצב ליד$|^מצב ליד$/.test(t))           return { cmd: 'mode_lead' };
    if (/^חזור למצב רגיל$|^מצב רגיל$|^חזור$/.test(t)) return { cmd: 'mode_assistant' };

    // מחיר 1650  |  מחיר 0521234567 1650
    const priceMatch = t.match(/^מחיר\s+([0-9]+)(?:\s+([0-9]+))?$/);
    if (priceMatch) {
        if (priceMatch[2]) return { cmd: 'approve_quote', phone: priceMatch[1], amount: Number(priceMatch[2]) };
        return { cmd: 'approve_quote', phone: null, amount: Number(priceMatch[1]) };
    }

    const closedMatch = t.match(/^סגר עסקה\s+([0-9]+)$/);
    if (closedMatch) return { cmd: 'close_deal', phone: closedMatch[1] };
    const sendMatch = t.match(/^שלח(?:\s+\S+)?\s+ל([0-9]+)\s+(.+)$/s);
    if (sendMatch) return { cmd: 'send', phone: sendMatch[1], msg: sendMatch[2].trim() };
    const historyMatch = t.match(/^היסטוריה\s+([0-9]+)$/);
    if (historyMatch) return { cmd: 'history', phone: historyMatch[1] };
    const statusMatch = t.match(/^סטטוס\s+([0-9]+)\s+(.+)$/);
    if (statusMatch) return { cmd: 'setstatus', phone: statusMatch[1], status: statusMatch[2].trim() };
    return null;
}

function normalizePhone(phone) {
    if (phone.startsWith('0')) return '972' + phone.slice(1);
    return phone;
}

function jidToPhone(jid) {
    if (jid.endsWith('@lid')) return null; // no real phone for lid JIDs
    const num = jid.split('@')[0];
    if (num.startsWith('972')) return '0' + num.slice(3);
    return num;
}

function formatNamesList() {
    const db = crm.getAll();
    const customers = Object.values(db);
    if (customers.length === 0) return 'אין לקוחות עדיין.';
    const STATUS_EMOJI = { new: '🆕', interested: '🔥', meeting_scheduled: '📅', closed: '✅', cold: '❄️' };
    return '*מי דיבר עם הבוט:*\n\n' + customers.map(c => {
        const emoji = STATUS_EMOJI[c.status] || '•';
        const name  = c.name || c.phone;
        const email = c.email ? ` | 📧 ${c.email}` : '';
        return `${emoji} ${name}${email}`;
    }).join('\n');
}

async function scoreLead(jid) {
    try {
        const history = conversations.get(jid) || [];
        if (history.length < 2) return null;
        const msgs = history.slice(-8).map(m =>
            `${m.role === 'user' ? 'לקוח' : 'בוט'}: ${m.content.substring(0, 120)}`
        ).join('\n');
        const comp = await getGroqClient().chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{
                role: 'system',
                content: 'דרג את הליד מ-1 עד 10 לפי רמת העניין והסבירות לסגירה. 1=לא רלוונטי, 10=מוכן לסגור עכשיו. החזר רק מספר שלם בין 1-10, ללא טקסט נוסף.'
            }, { role: 'user', content: msgs }],
            max_tokens: 5, temperature: 0,
        });
        const n = parseInt(comp.choices[0]?.message?.content?.trim());
        return (n >= 1 && n <= 10) ? n : null;
    } catch { return null; }
}

async function sendMorningBriefing() {
    if (!sock || botStatus !== 'connected') return;
    try {
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const todayEvents = calendar.filter(e => e.date === todayStr)
            .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        const weekIncome = incomeLog
            .filter(e => new Date(e.date) >= weekStart)
            .reduce((s, e) => s + e.amount, 0);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthIncome = incomeLog
            .filter(e => new Date(e.date) >= monthStart)
            .reduce((s, e) => s + e.amount, 0);

        const db = crm.getAll();
        const hotLeads = Object.values(db).filter(c =>
            ['interested', 'meeting_scheduled'].includes(c.status)
        );

        let lines = ['☀️ *בוקר טוב יאיר!*\n'];

        if (todayEvents.length > 0) {
            lines.push('📅 *פגישות היום:*');
            todayEvents.forEach(e => lines.push(`• ${e.time || '—'} — ${e.title}`));
        } else {
            lines.push('📅 אין פגישות היום.');
        }

        lines.push('');
        if (hotLeads.length > 0) {
            lines.push(`🔥 *לידים חמים (${hotLeads.length}):*`);
            hotLeads.slice(0, 5).forEach(c => {
                const phone = crm.jidToPhone ? c.phone : c.phone.split('@')[0];
                const lastSeen = c.lastSeen ? new Date(c.lastSeen).toLocaleDateString('he-IL') : '—';
                lines.push(`• ${c.name || phone} | ${c.status} | נראה: ${lastSeen}`);
            });
        } else {
            lines.push('🔥 אין לידים חמים כרגע.');
        }

        lines.push('');
        lines.push(`💰 *הכנסות השבוע:* ₪${weekIncome.toLocaleString('he-IL')}`);
        lines.push(`📊 *סה"כ החודש:* ₪${monthIncome.toLocaleString('he-IL')}`);
        lines.push('\nיום מוצלח! 💪');

        await notifyOwner(lines.join('\n'));
    } catch (err) {
        console.error('שגיאה בבריפינג:', err.message);
    }
}

function scheduleMorningBriefing() {
    const now = new Date();
    const israelNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const target = new Date(israelNow);
    target.setHours(9, 0, 0, 0);
    if (israelNow >= target) target.setDate(target.getDate() + 1);
    const delay = target - israelNow;
    console.log(`⏰ בריפינג בוקר מתוזמן בעוד ${Math.round(delay / 60000)} דקות`);
    setTimeout(() => {
        sendMorningBriefing();
        scheduleMorningBriefing();
    }, delay);
}

function scheduleFollowUpCheck() {
    setInterval(async () => {
        if (!sock || botStatus !== 'connected') return;
        const db = crm.getAll();
        const now = Date.now();
        const H24 = 24 * 60 * 60 * 1000;
        const H48 = 48 * 60 * 60 * 1000;
        for (const c of Object.values(db)) {
            if (!['interested', 'meeting_scheduled'].includes(c.status)) continue;
            const lastIn = c.log.filter(l => l.direction === 'in').pop();
            if (!lastIn) continue;
            const lastOut = c.log.filter(l => l.direction === 'out').pop();
            const lastInTime = new Date(c.lastSeen).getTime();
            const sinceLastIn = now - lastInTime;
            if (sinceLastIn < H24) continue;
            // Only alert if last log is incoming (we haven't replied since)
            if (lastOut && c.log.indexOf(lastOut) > c.log.indexOf(lastIn)) continue;
            const lastAlerted = followUpSentAt.get(c.phone) || 0;
            if (now - lastAlerted < H48) continue;
            followUpSentAt.set(c.phone, now);
            const hours = Math.round(sinceLastIn / 3600000);
            const phone = c.phone.split('@')[0].replace(/^972/, '0');
            await notifyOwner(
                `🔔 *פולואו-אפ: ${c.name || phone}*\n` +
                `מספר: ${phone}\nסטטוס: ${c.status}\n` +
                `לא ענה כבר ${hours} שעות\n` +
                `הודעה אחרונה: "${lastIn.text.substring(0, 80)}"\n\n` +
                `לשליחת המשך: *שלח ל${phone} [הודעה]*`
            );
        }
    }, 2 * 60 * 60 * 1000); // every 2 hours
}

async function analyzeImage(msg, sock, question) {
    try {
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
        });
        const base64 = buffer.toString('base64');
        const mimeType = msg.message?.imageMessage?.mimetype || 'image/jpeg';
        const prompt = question || 'תאר את התמונה בפירוט בעברית.';
        const completion = await getGroqClient().chat.completions.create({
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
                ]
            }],
            max_tokens: 600,
            temperature: 0.5,
        });
        return completion.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
        console.error('שגיאה בניתוח תמונה:', err.message);
        return null;
    }
}

async function transcribeAudio(msg, sock) {
    try {
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
        });
        const { toFile } = require('groq-sdk');
        const file = await toFile(buffer, 'voice.ogg', { type: 'audio/ogg' });
        const result = await getGroqClient().audio.transcriptions.create({
            file,
            model: 'whisper-large-v3-turbo',
            language: 'he',
        });
        return result.text?.trim() || null;
    } catch (err) {
        console.error('שגיאה בתמלול:', err.message);
        return null;
    }
}

async function notifyOwner(text) {
    if (!sock || botStatus !== 'connected') return;
    try { await sock.sendMessage(OWNER_JID, { text }); } catch (err) {
        console.error('שגיאה בהתראה לבעלים:', err.message);
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_state');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['מאקס', 'Chrome', '1.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { currentQR = qr; botStatus = 'waiting'; console.log('📱 QR זמין — פתח /qr לסריקה'); }
        if (connection === 'open') {
            currentQR = null; botStatus = 'connected';
            console.log('✅ מאקס מוכן ומחובר!');
            scheduleMorningBriefing();
            scheduleFollowUpCheck();
        }
        if (connection === 'connecting') { botStatus = 'scanned'; console.log('🔄 מתחבר...'); }
        if (connection === 'close') {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut && code !== DisconnectReason.connectionReplaced;
            console.log('⚠️ התנתק, קוד:', code, '| מתחבר שוב:', shouldReconnect);
            botStatus = 'waiting';
            if (shouldReconnect) setTimeout(startBot, 3000);
        }
    });

    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        try { await handleGroupParticipantUpdate(sock, id, participants, action); } catch {}
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                if (msg.key.fromMe) continue;
                const jid = msg.key.remoteJid;
                if (!jid || jid === 'status@broadcast') continue;
                if (jid.endsWith('@g.us')) {
                    await handleGroupMessage(sock, msg);
                    continue;
                }

                // Private messages → private-bot handler
                await handlePrivateMessage(sock, msg);
                continue;

                let userText = getText(msg);
                const hasAudio = !!(msg.message?.audioMessage);
                const hasImage = !!(msg.message?.imageMessage);
                if (!userText && !hasAudio && !hasImage) continue;

                const pushName = msg.pushName || null;
                const isOwner = isOwnerPhone(jid);

                // Save pushName to CRM for @lid contacts that have no real phone
                if (!isOwner && pushName && !crm.getCustomer(jid)?.name) {
                    crm.getOrCreate(jid);
                    crm.setName(jid, pushName);
                }

                const displayId = jidToPhone(jid) || crm.getCustomer(jid)?.name || pushName || jid.split('@')[0];

                // Voice message — transcribe before processing
                let voiceTranscript = null;
                if (!userText && hasAudio) {
                    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
                    voiceTranscript = await transcribeAudio(msg, sock);
                    if (!voiceTranscript) {
                        if (isOwner) await sock.sendMessage(jid, { text: '❌ לא הצלחתי לתמלל את ההודעה הקולית.' });
                        continue;
                    }
                    userText = voiceTranscript;
                }

                // Image message — analyze and inject into conversation
                let imageDescription = null;
                if (hasImage) {
                    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
                    const caption = msg.message.imageMessage.caption || null;
                    imageDescription = await analyzeImage(msg, sock, caption);
                    if (!imageDescription) {
                        if (isOwner) await sock.sendMessage(jid, { text: '❌ לא הצלחתי לנתח את התמונה.' });
                        continue;
                    }
                    // Build a synthetic message for the AI: image description + optional caption
                    userText = caption
                        ? `[שלח תמונה — תיאור: ${imageDescription}]\nשאלה/הערה: ${caption}`
                        : `[שלח תמונה — תיאור: ${imageDescription}]`;
                    console.log(`🖼️ תמונה מנותחת: "${imageDescription.substring(0, 80)}"`);
                }

                if (!userText) continue;

                console.log(`📩 [${isOwner ? 'יאיר' : displayId}]${voiceTranscript ? ' 🎤' : ''}: ${userText}`);

                if (isOwner) {
                    const cmd = parseOwnerCommand(userText);

                    if (cmd?.cmd === 'api_status') {
                        const now = Date.now();
                        const lines = ['🔑 *סטטוס מפתחות Groq:*\n'];
                        GROQ_KEYS.forEach((k, i) => {
                            const blocked = groqKeyCooldown.get(i) || 0;
                            const used = groqKeyUsage.get(i) || 0;
                            const remaining = Math.max(0, GROQ_DAILY_LIMIT - used);
                            const pct = Math.round(used / GROQ_DAILY_LIMIT * 100);
                            const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
                            if (blocked > now) {
                                const refreshTime = new Date(blocked).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
                                const minsLeft = Math.ceil((blocked - now) / 60000);
                                lines.push(`❌ מפתח ${i + 1} — נגמר\n   מתחדש בשעה *${refreshTime}* (עוד ${minsLeft} דק')`);
                            } else {
                                lines.push(`✅ מפתח ${i + 1} — פעיל\n   ${bar} ${pct}%\n   נוצלו: ${used.toLocaleString('he-IL')} | נשאר: ~${remaining.toLocaleString('he-IL')} טוקנים`);
                            }
                        });
                        const active = GROQ_KEYS.filter((_, i) => (groqKeyCooldown.get(i) || 0) <= now).length;
                        lines.push(`\nפעילים: ${active}/${GROQ_KEYS.length}`);
                        await sock.sendMessage(jid, { text: lines.join('\n') });
                        continue;
                    }
                    if (cmd?.cmd === 'mode_learning') {
                        ownerMode = 'learning';
                        conversations.delete('__learning__');
                        await sock.sendMessage(jid, { text: '📚 *מצב למידה פעיל*\nאשאל אותך שאלות על העסק אחת-אחת.\nכשתסיים — כתוב: *סיים למידה*' });
                        const existing = process.env.BUSINESS_KNOWLEDGE;
                        const startMsg = existing
                            ? `זה הידע שכבר יש לי על העסק:\n${existing}\n\nאני אשאל רק על מה שחסר.`
                            : 'שלום, אני מוכן ללמוד על העסק שלך. נתחיל?';
                        const { reply } = await getAIResponse('__learning__', startMsg, 'learning');
                        if (reply) await sock.sendMessage(jid, { text: reply });
                        continue;
                    }
                    if (cmd?.cmd === 'save_learning') {
                        await sock.sendMessage(jid, { text: '⏳ שומר את הידע...' });
                        try {
                            const history = conversations.get('__learning__') || [];
                            const existingKnowledge = process.env.BUSINESS_KNOWLEDGE || '';
                            const summaryCompletion = await getGroqClient().chat.completions.create({
                                model: 'llama-3.3-70b-versatile',
                                messages: [
                                    { role: 'system', content: `אתה מעדכן את בסיס הידע של העסק.
הידע הקיים:
${existingKnowledge}

השיחה הוסיפה מידע חדש. המשימה שלך: מזג את הידע הקיים עם המידע החדש לכתיבה אחת מסודרת.
אל תמחק מידע קיים — רק עדכן או הוסף.
כתוב בעברית, בצורה ברורה ומובנית.` },
                                    ...history,
                                    { role: 'user', content: 'כתוב את בסיס הידע המעודכן המלא על העסק.' }
                                ],
                                max_tokens: 1200,
                            });
                            const merged = summaryCompletion.choices[0]?.message?.content || '';
                            if (!merged) throw new Error('הסיכום ריק');
                            console.log('💾 שומר ידע:', merged.substring(0, 100) + '...');
                            await saveKnowledgeToRender(merged);
                            ownerMode = 'assistant';
                            conversations.delete('__learning__');
                            await sock.sendMessage(jid, { text: `✅ *הידע עודכן!*\n\n${merged}` });
                        } catch (err) {
                            console.error('שגיאה בשמירת ידע:', err.message);
                            await sock.sendMessage(jid, { text: `❌ שגיאה בשמירה: ${err.message}` });
                        }
                        continue;
                    }
                    if (cmd?.cmd === 'dnd_on') {
                        doNotDisturb = true;
                        missedMessages = [];
                        await sock.sendMessage(jid, { text: '🌙 *לילה טוב!*\nהבוט במצב שקט — לא יענה ללקוחות.\nאודיע לך בבוקר מי כתב.' });
                        continue;
                    }
                    if (cmd?.cmd === 'dnd_off') {
                        doNotDisturb = false;
                        if (missedMessages.length === 0) {
                            await sock.sendMessage(jid, { text: '☀️ *בוקר טוב!* לא הגיעו הודעות בלילה.' });
                        } else {
                            const summary = missedMessages.map((m, i) =>
                                `${i + 1}. *${m.name}* — "${m.text.substring(0, 60)}"`
                            ).join('\n');
                            await sock.sendMessage(jid, { text: `☀️ *בוקר טוב!* בזמן שישנת:\n\n${summary}\n\nהבוט חוזר לענות.` });
                        }
                        missedMessages = [];
                        continue;
                    }
                    if (cmd?.cmd === 'help') {
                        await sock.sendMessage(jid, { text: `🤖 *מה אני יכול לעשות:*

👥 *לקוחות ו-CRM*
• \`לקוחות\` — רשימת כל הלקוחות
• \`מי דיבר\` — שמות קצרים
• \`היסטוריה [מספר]\` — שיחה מלאה עם לקוח
• \`סטטוס [מספר] [סטטוס]\` — עדכון סטטוס
• \`שלח ל[מספר] [הודעה]\` — שליחה ישירה

💼 *הצעות מחיר*
• \`מחיר [סכום]\` — שולח הצעה ללקוח ממתין
• \`מחיר [טלפון] [סכום]\` — הצעה ללקוח ספציפי
• \`סגר עסקה [מספר]\` — סימון כסגור

📋 *פרויקטים*
• \`פרויקטים\` — רשימת פרויקטים
• \`פרויקט חדש [שם] [מחיר]\` — הוספה
• \`עדכן [שם]: [סטטוס]\` — עדכון סטטוס
• \`סגור פרויקט [שם]\` — סיום פרויקט
• \`מחק פרויקט [שם]\` — מחיקה

💰 *הכנסות*
• \`סגרתי [סכום]\` — רישום הכנסה
• \`סגרתי [סכום] [הערה]\` — עם הערה
• \`הכנסות\` — דוח חודשי

⏰ *תזכורות*
• \`תזכיר לי בעוד שעה [מה]\`
• \`תזכיר לי ב-15:00 [מה]\`
• \`תזכורות\` — רשימה פעילה
• \`מחק תזכורת [מספר]\`

🎭 *מצבים מיוחדים*
• \`פגישה\` — ייעוץ בזמן אמת בפגישה
• \`לקוח כועס\` — תגובות מוכנות לשימור
• \`מצב ליד\` — לדמות שיחה עם לקוח
• \`מצב למידה\` — ללמד את הבוט על העסק
• \`חזור\` — חזרה למצב רגיל

📊 *דוחות*
• \`דוח\` — סטטיסטיקות לידים וסגירות

📅 *יומן*
• \`יומן\` — הצגת אירועים קרובים
• \`הוסף אירוע פגישה עם דוד ב-12/05 בשעה 10:00\`
• \`מחק אירוע [מספר]\`
• \`אשר פגישה 1\` / \`2\` / \`3\` — אישור אפשרות פגישה
• \`דחה פגישה [זמן חלופי]\` — דחיה + הצעת זמן

🌙 *מצב שקט*
• \`לילה טוב\` — הבוט מפסיק לענות ללקוחות
• \`בוקר טוב\` — חוזר לפעילות + סיכום מי כתב

👤 *סיכום וניתוח לקוח*
• \`סיכום [שם]\` — ניתוח AI על לקוח לפי היסטוריה
• ⭐ ניקוד ליד אוטומטי 1-10 בכל שינוי סטטוס

📢 *שידור*
• \`שדר מתעניינים [הודעה]\` — שליחה לכולם בסטטוס
• \`שדר חדשים [הודעה]\` | \`שדר קרים [הודעה]\`
• \`שדר כולם [הודעה]\` — לכל הלקוחות

📜 *חוזה*
• \`חוזה [טלפון] [חבילה] [סכום]\`
• \`חוזה [טלפון] [חבילה] [סכום] [ימי עבודה]\`

🗑️ *ניהול*
• \`נקה הכל\` — מחיקת הכל (חוץ מידע עסקי)` });
                        continue;
                    }
                    if (cmd?.cmd === 'mode_meeting') {
                        ownerMode = 'meeting';
                        conversations.delete(jid);
                        await sock.sendMessage(jid, { text: '🤝 *מצב פגישה פעיל*\nאני כאן לייעץ בזמן אמת.\nתאר את המצב ואתן לך מה לאמר ישר.\nלחזרה: *חזור*' });
                        continue;
                    }
                    if (cmd?.cmd === 'mode_crisis') {
                        ownerMode = 'crisis';
                        conversations.delete(jid);
                        await sock.sendMessage(jid, { text: '🚨 *מצב לקוח בעייתי*\nתאר מה קורה — אתן לך תגובה מוכנה לשליחה.\nלחזרה: *חזור*' });
                        continue;
                    }
                    if (cmd?.cmd === 'projects_list') {
                        await sock.sendMessage(jid, { text: formatProjects() });
                        continue;
                    }
                    if (cmd?.cmd === 'project_add') {
                        projects.push({ name: cmd.name, client: cmd.name, status: 'פעיל', price: cmd.price, date: new Date().toISOString().slice(0, 10) });
                        await saveProjects();
                        await sock.sendMessage(jid, { text: `✅ פרויקט *${cmd.name}* נוסף | ₪${cmd.price.toLocaleString('he-IL')}` });
                        continue;
                    }
                    if (cmd?.cmd === 'project_update') {
                        const p = projects.find(p => p.name.includes(cmd.name));
                        if (!p) { await sock.sendMessage(jid, { text: `❌ לא נמצא פרויקט "${cmd.name}"` }); continue; }
                        p.status = cmd.status;
                        await saveProjects();
                        await sock.sendMessage(jid, { text: `✅ *${p.name}* → ${cmd.status}` });
                        continue;
                    }
                    if (cmd?.cmd === 'project_close') {
                        const p = projects.find(p => p.name.includes(cmd.name));
                        if (!p) { await sock.sendMessage(jid, { text: `❌ לא נמצא פרויקט "${cmd.name}"` }); continue; }
                        p.status = 'הושלם';
                        await saveProjects();
                        await sock.sendMessage(jid, { text: `✅ פרויקט *${p.name}* הושלם! 🎉` });
                        continue;
                    }
                    if (cmd?.cmd === 'project_delete') {
                        const idx = projects.findIndex(p => p.name.includes(cmd.name));
                        if (idx === -1) { await sock.sendMessage(jid, { text: `❌ לא נמצא פרויקט "${cmd.name}"` }); continue; }
                        const name = projects[idx].name;
                        projects.splice(idx, 1);
                        await saveProjects();
                        await sock.sendMessage(jid, { text: `🗑️ פרויקט *${name}* נמחק.` });
                        continue;
                    }
                    if (cmd?.cmd === 'income_add') {
                        incomeLog.push({ amount: cmd.amount, note: cmd.note, date: new Date().toISOString().slice(0, 10) });
                        await saveIncome();
                        const monthTotal = incomeLog.filter(e => e.date.slice(0, 7) === new Date().toISOString().slice(0, 7)).reduce((s, e) => s + e.amount, 0);
                        await sock.sendMessage(jid, { text: `💰 נרשמו ₪${cmd.amount.toLocaleString('he-IL')}${cmd.note ? ` — ${cmd.note}` : ''}\n📊 סה"כ החודש: ₪${monthTotal.toLocaleString('he-IL')}` });
                        continue;
                    }
                    if (cmd?.cmd === 'income_report') {
                        await sock.sendMessage(jid, { text: formatIncomeReport() });
                        continue;
                    }
                    if (cmd?.cmd === 'calendar_show') {
                        await sock.sendMessage(jid, { text: formatCalendar() });
                        continue;
                    }
                    if (cmd?.cmd === 'calendar_delete') {
                        const idx = calendar.findIndex(e => e.id === cmd.id);
                        if (idx === -1) { await sock.sendMessage(jid, { text: `❌ אירוע ${cmd.id} לא נמצא.` }); continue; }
                        const title = calendar[idx].title;
                        calendar.splice(idx, 1);
                        await saveCalendar();
                        await sock.sendMessage(jid, { text: `🗑️ האירוע "${title}" נמחק.` });
                        continue;
                    }
                    if (cmd?.cmd === 'calendar_add_raw') {
                        const parsed = await parseCalendarEvent(cmd.text);
                        if (!parsed) { await sock.sendMessage(jid, { text: '❌ לא הבנתי את האירוע. נסה: "הוסף אירוע פגישה עם דוד בתאריך 12/05 בשעה 10:00"' }); continue; }
                        parsed.id = calendarIdCounter++;
                        calendar.push(parsed);
                        await saveCalendar();
                        const d = new Date(parsed.date);
                        await sock.sendMessage(jid, { text: `✅ נוסף: *${parsed.title}*\n📅 ${DAY_NAMES[d.getDay()]} ${d.getDate()}/${d.getMonth()+1} ב-${parsed.time || ''}` });
                        continue;
                    }
                    if (cmd?.cmd === 'meeting_approve') {
                        const m = pendingMeetingApproval;
                        pendingMeetingApproval = null;
                        const slot = m.slots[cmd.slotIndex] || m.slots[0];
                        const d = new Date(slot.date);
                        const slotText = `${DAY_NAMES[d.getDay()]} ${d.getDate()}/${d.getMonth()+1} בשעה ${slot.time}`;
                        calendar.push({ id: calendarIdCounter++, title: `פגישה עם ${m.name}`, date: slot.date, time: slot.time, duration: 60 });
                        await saveCalendar();
                        await sock.sendMessage(m.customerJid, { text: `✅ מעולה! קבענו פגישה ל${slotText}.\nיאיר ייצור איתך קשר לקראת הפגישה 😊` });
                        crm.addLog(m.customerJid, 'out', `[פגישה נקבעה: ${slotText}]`);
                        crm.setStatus(m.customerJid, 'meeting_scheduled');
                        await sock.sendMessage(jid, { text: `✅ פגישה אושרה ונקבעה ביומן!\n${slotText}` });
                        continue;
                    }
                    if (cmd?.cmd === 'meeting_decline') {
                        const m = pendingMeetingApproval;
                        if (cmd.alt) {
                            pendingMeetingApproval = null;
                            await sock.sendMessage(m.customerJid, { text: `שלום! הבדקתי את הזמינות — ${cmd.alt} מתאים לך?` });
                            crm.addLog(m.customerJid, 'out', `[הצעת זמן חלופי: ${cmd.alt}]`);
                            await sock.sendMessage(jid, { text: `✅ נשלחה הצעת זמן חלופי: "${cmd.alt}"` });
                        } else {
                            await sock.sendMessage(jid, { text: '⏰ מתי כן פנוי? שלח: "דחה פגישה [זמן חלופי]"\nלדוגמה: "דחה פגישה יום ראשון ב-11:00"' });
                        }
                        continue;
                    }
                    if (cmd?.cmd === 'report') {
                        await sock.sendMessage(jid, { text: generateReport() });
                        continue;
                    }
                    if (cmd?.cmd === 'list_reminders') {
                        if (activeReminders.length === 0) {
                            await sock.sendMessage(jid, { text: '⏰ אין תזכורות פעילות.' });
                        } else {
                            const lines = activeReminders.map(r => {
                                const t = r.fireAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
                                return `${r.id}. בשעה ${t} — ${r.text}`;
                            });
                            await sock.sendMessage(jid, { text: `⏰ *תזכורות פעילות:*\n${lines.join('\n')}\n\nלמחיקה: *מחק תזכורת [מספר]*` });
                        }
                        continue;
                    }
                    if (cmd?.cmd === 'delete_reminder') {
                        const idx = activeReminders.findIndex(r => r.id === cmd.id);
                        if (idx === -1) {
                            await sock.sendMessage(jid, { text: `❌ תזכורת ${cmd.id} לא נמצאה.` });
                        } else {
                            clearTimeout(activeReminders[idx].timeoutId);
                            activeReminders.splice(idx, 1);
                            await sock.sendMessage(jid, { text: `✅ תזכורת ${cmd.id} נמחקה.` });
                        }
                        continue;
                    }
                    if (cmd?.cmd === 'reminder') {
                        await sock.sendMessage(jid, { text: '⏳ מגדיר תזכורת...' });
                        const parsed = await parseReminderIntent(cmd.text);
                        if (!parsed || !parsed.delayMinutes || parsed.delayMinutes <= 0) {
                            await sock.sendMessage(jid, { text: '❌ לא הצלחתי להבין את הזמן. נסה: "תזכיר לי בעוד שעה לקרוא לדוד"' });
                        } else {
                            const { id, fireAt } = await scheduleReminder(parsed.message, parsed.delayMinutes * 60 * 1000);
                            const timeStr = fireAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
                            await sock.sendMessage(jid, { text: `✅ תזכורת ${id} נקבעה לשעה ${timeStr}\n📝 ${parsed.message}` });
                        }
                        continue;
                    }
                    if (cmd?.cmd === 'clear_all') {
                        conversations.clear();
                        const fs = require('fs');
                        const crmPath = require('path').join(__dirname, 'crm.json');
                        fs.writeFileSync(crmPath, '{}', 'utf8');
                        pendingQuotes.clear();
                        pendingMeetingApproval = null;
                        projects = [];
                        incomeLog = [];
                        calendar = [];
                        calendarIdCounter = 1;
                        await Promise.all([saveProjects(), saveIncome(), saveCalendar()]);
                        await sock.sendMessage(jid, { text: '🗑️ *נמחק הכל!*\n✅ CRM, שיחות, הצעות, פרויקטים, הכנסות, יומן — הכל נקי.\n🧠 ידע העסקי נשמר.' });
                        continue;
                    }
                    if (cmd?.cmd === 'list') {
                        await sock.sendMessage(jid, { text: crm.formatList() });
                        continue;
                    }
                    if (cmd?.cmd === 'names') {
                        await sock.sendMessage(jid, { text: formatNamesList() });
                        continue;
                    }
                    if (cmd?.cmd === 'mode_lead') {
                        ownerMode = 'lead';
                        conversations.delete(jid);
                        await sock.sendMessage(jid, { text: '🎭 *מצב ליד פעיל*\nאני מדבר אליך כאילו אתה לקוח חדש.\nלחזרה: "חזור למצב רגיל"' });
                        continue;
                    }
                    if (cmd?.cmd === 'mode_assistant') {
                        ownerMode = 'assistant';
                        conversations.delete(jid);
                        await sock.sendMessage(jid, { text: '✅ *חזרתי למצב עוזר אישי*\nמה תרצה?' });
                        continue;
                    }
                    if (cmd?.cmd === 'approve_quote') {
                        // Find which customer to send the quote to
                        let targetJid = null;
                        let quoteData = null;

                        if (cmd.phone) {
                            // Owner specified a phone number
                            targetJid = normalizePhone(cmd.phone) + '@s.whatsapp.net';
                            quoteData = pendingQuotes.get(targetJid);
                        } else {
                            // Take the first pending quote
                            const first = pendingQuotes.entries().next().value;
                            if (first) { targetJid = first[0]; quoteData = first[1]; }
                        }

                        if (!targetJid || !quoteData) {
                            await sock.sendMessage(jid, { text: '❌ אין הצעת מחיר ממתינה. ציין מספר: מחיר [טלפון] [סכום]' });
                            continue;
                        }

                        pendingQuotes.delete(targetJid);

                        try {
                            const htmlBuf = await generateQuote({
                                customerName:   quoteData.name || 'לקוח',
                                packageName:    quoteData.packageName,
                                packageDetails: quoteData.packageDetails,
                                price:          cmd.amount,
                            });
                            const displayName = quoteData.name || 'לקוח';
                            const fileName = `הצעת מחיר - ${displayName}.html`;
                            await sock.sendMessage(targetJid, {
                                document: htmlBuf,
                                mimetype: 'text/html',
                                fileName,
                                caption: `📄 הצעת המחיר שלך מוכנה! פתח את הקובץ לצפייה 😊`
                            });
                            crm.addLog(targetJid, 'out', `[הצעת מחיר נשלחה: ${quoteData.packageName} ₪${cmd.amount}]`);
                            crm.setStatus(targetJid, 'meeting_scheduled');
                            // Add to AI conversation so bot remembers
                            if (!conversations.has(targetJid)) conversations.set(targetJid, []);
                            conversations.get(targetJid).push({ role: 'assistant', content: `שלחתי לך הצעת מחיר רשמית לחבילת ${quoteData.packageName} במחיר ₪${cmd.amount}. ממתין לתגובתך.` });
                            await sock.sendMessage(jid, { text: `✅ הצעת מחיר נשלחה ל-${quoteData.name || jidToPhone(targetJid)} — ${quoteData.packageName} ₪${cmd.amount}` });
                        } catch (err) {
                            console.error('שגיאה ביצירת PDF:', err.message);
                            await sock.sendMessage(jid, { text: `❌ שגיאה ביצירת PDF: ${err.message}` });
                        }
                        continue;
                    }
                    if (cmd?.cmd === 'send') {
                        const normalized = normalizePhone(cmd.phone);
                        const targetJid  = normalized + '@s.whatsapp.net';
                        try {
                            await sock.sendMessage(targetJid, { text: cmd.msg });
                            crm.addLog(targetJid, 'out', cmd.msg);
                            await sock.sendMessage(jid, { text: `✅ ההודעה נשלחה ל-${cmd.phone}` });
                        } catch (err) {
                            await sock.sendMessage(jid, { text: `❌ שגיאה: ${err.message}` });
                        }
                        continue;
                    }
                    if (cmd?.cmd === 'history') {
                        const ph = normalizePhone(cmd.phone) + '@s.whatsapp.net';
                        await sock.sendMessage(jid, { text: crm.formatHistory(ph) });
                        continue;
                    }
                    if (cmd?.cmd === 'setstatus') {
                        const ph = normalizePhone(cmd.phone) + '@s.whatsapp.net';
                        crm.setStatus(ph, cmd.status);
                        await sock.sendMessage(jid, { text: `✅ סטטוס עודכן ל-${cmd.status}` });
                        continue;
                    }
                    if (cmd?.cmd === 'close_deal') {
                        const ph = normalizePhone(cmd.phone) + '@s.whatsapp.net';
                        crm.setStatus(ph, 'closed');
                        crm.addLog(ph, 'out', '[עסקה נסגרה]');
                        const c = crm.getCustomer(ph);
                        await sock.sendMessage(jid, { text: `✅ עסקה נסגרה! ${c?.name || jidToPhone(ph)} 🎉` });
                        continue;
                    }
                    if (cmd?.cmd === 'broadcast') {
                        const STATUS_MAP = {
                            'מתעניינים': 'interested', 'חדשים': 'new',
                            'פגישות': 'meeting_scheduled', 'קרים': 'cold',
                            'סגורים': 'closed',
                        };
                        const filterStatus = STATUS_MAP[cmd.filter] || null;
                        const db = crm.getAll();
                        const targets = Object.values(db).filter(c =>
                            (filterStatus ? c.status === filterStatus : true) &&
                            c.phone.endsWith('@s.whatsapp.net')
                        );
                        if (targets.length === 0) {
                            await sock.sendMessage(jid, { text: `❌ אין לקוחות בסטטוס "${cmd.filter}"` });
                            continue;
                        }
                        await sock.sendMessage(jid, { text: `📢 שולח ל-${targets.length} לקוחות...` });
                        let sent = 0;
                        for (const c of targets) {
                            try {
                                await sock.sendMessage(c.phone, { text: cmd.msg });
                                crm.addLog(c.phone, 'out', `[שידור] ${cmd.msg.substring(0, 60)}`);
                                sent++;
                                await new Promise(r => setTimeout(r, 1500));
                            } catch {}
                        }
                        await sock.sendMessage(jid, { text: `✅ השידור הסתיים — נשלח ל-${sent}/${targets.length} לקוחות.` });
                        continue;
                    }
                    if (cmd?.cmd === 'contract') {
                        const targetJid = normalizePhone(cmd.phone) + '@s.whatsapp.net';
                        const customer = crm.getCustomer(targetJid);
                        const customerName = customer?.name || cmd.phone;
                        const pkgKey = Object.keys(PACKAGES).find(k => cmd.service.toLowerCase().includes(k.toLowerCase())) || cmd.service;
                        const pkgDetails = PACKAGES[pkgKey]?.details || cmd.service;
                        try {
                            const buf = await generateContract({
                                customerName,
                                serviceName: pkgKey,
                                serviceDetails: pkgDetails,
                                price: cmd.amount,
                                deliveryDays: cmd.days,
                            });
                            await sock.sendMessage(targetJid, {
                                document: buf,
                                mimetype: 'text/html',
                                fileName: `חוזה עבודה — ${customerName}.html`,
                                caption: `📄 חוזה העבודה שלנו מוכן! פתח את הקובץ, קרא ושלח לי אישור 😊`,
                            });
                            crm.addLog(targetJid, 'out', `[חוזה נשלח: ${pkgKey} ₪${cmd.amount}]`);
                            await sock.sendMessage(jid, { text: `✅ חוזה נשלח ל-${customerName} — ${pkgKey} ₪${cmd.amount.toLocaleString('he-IL')}` });
                        } catch (err) {
                            await sock.sendMessage(jid, { text: `❌ שגיאה ביצירת חוזה: ${err.message}` });
                        }
                        continue;
                    }
                    if (cmd?.cmd === 'customer_summary') {
                        const db = crm.getAll();
                        const found = Object.values(db).find(c =>
                            (c.name && c.name.includes(cmd.name)) ||
                            (c.phone && c.phone.includes(cmd.name))
                        );
                        if (!found) {
                            await sock.sendMessage(jid, { text: `❌ לא נמצא לקוח בשם "${cmd.name}"` });
                            continue;
                        }
                        await sock.sendMessage(jid, { text: '⏳ מנתח...' });
                        const STATUS_EMOJI = { new: '🆕', interested: '🔥', meeting_scheduled: '📅', closed: '✅', cold: '❄️' };
                        const lastMessages = found.log.slice(-12).map(l =>
                            `${l.direction === 'in' ? 'לקוח' : 'בוט'}: ${l.text}`
                        ).join('\n');
                        try {
                            const comp = await getGroqClient().chat.completions.create({
                                model: 'llama-3.3-70b-versatile',
                                messages: [{
                                    role: 'system',
                                    content: 'אתה מנתח שיחות מכירה לבעלים של עסק. תן סיכום קצר ומעשי על לקוח: רמת עניין, מה הוא מחפש, חששות שהעלה, והמלצה לצעד הבא. עברית קצרה וחדה.'
                                }, {
                                    role: 'user',
                                    content: `שם: ${found.name || cmd.name}\nסטטוס: ${found.status}\nהודעות:\n${lastMessages || 'אין היסטוריה'}`
                                }],
                                max_tokens: 300, temperature: 0.4,
                            });
                            const analysis = comp.choices[0]?.message?.content || '';
                            await sock.sendMessage(jid, { text: `${STATUS_EMOJI[found.status] || '•'} *${found.name || cmd.name}*\nסטטוס: ${found.status}\n\n${analysis}` });
                        } catch {
                            await sock.sendMessage(jid, { text: `${STATUS_EMOJI[found.status] || '•'} *${found.name || cmd.name}*\nסטטוס: ${found.status} | הודעות: ${found.log.length}` });
                        }
                        continue;
                    }
                }

                // DND mode — don't respond to customers
                if (doNotDisturb && !isOwner) {
                    crm.getOrCreate(jid);
                    crm.addLog(jid, 'in', userText);
                    missedMessages.push({ name: displayName, text: userText });
                    console.log(`🌙 DND — הודעה מ-${displayName} נשמרה`);
                    continue;
                }

                const aiMode = isOwner ? ownerMode : 'sales';
                const aiJid  = (isOwner && ownerMode === 'learning') ? '__learning__' : jid;

                // Typing indicator (ignore errors — @lid JIDs may not support presence)
                const presence = (type) => Promise.race([
                    sock.sendPresenceUpdate(type, jid).catch(() => {}),
                    new Promise(r => setTimeout(r, 1500))
                ]);
                await presence('composing');
                const { reply, understood, status, name, email, quoteRequest, meetingRequest } = await getAIResponse(aiJid, userText, aiMode);
                await presence('paused');

                if (!understood || !reply) {
                    console.log(`❌ Groq נכשל — כל המפתחות בהקפאה`);
                    // Find the soonest key to recover
                    const now = Date.now();
                    const soonestRefresh = Math.min(...[...groqKeyCooldown.values()].filter(t => t > now));
                    const refreshTime = isFinite(soonestRefresh)
                        ? new Date(soonestRefresh).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })
                        : null;
                    if (!isOwner) {
                        const customerMsg = refreshTime
                            ? `שלום! יאיר יחזור אליך בקרוב 😊\n_(המערכת מתחדשת בשעה ${refreshTime})_`
                            : 'שלום! יאיר יחזור אליך בקרוב 😊';
                        await sock.sendMessage(jid, { text: customerMsg });
                        await notifyOwner(
                            `🔔 *לקוח ממתין לתשובה*\n` +
                            `שם: ${crm.getCustomer(jid)?.name || 'לא ידוע'}\n` +
                            `מספר: ${jidToPhone(jid) || jid}\n` +
                            `הודעה: "${userText}"\n\n` +
                            `⛔ כל מפתחות Groq נגמרו${refreshTime ? ` — מתחדש בשעה *${refreshTime}*` : ''}`
                        );
                    } else {
                        const ownerMsg = refreshTime
                            ? `⛔ כל מפתחות Groq נגמרו.\nמתחדש בשעה *${refreshTime}*`
                            : '⛔ כל מפתחות Groq נגמרו. בדוק את הלימיטים.';
                        await sock.sendMessage(jid, { text: ownerMsg });
                    }
                    continue;
                }

                if (!isOwner) {
                    crm.getOrCreate(jid);
                    crm.addLog(jid, 'in', userText);
                    crm.addLog(jid, 'out', reply);

                    const prevStatus = crm.getCustomer(jid)?.status;
                    if (status) crm.setStatus(jid, status);
                    if (name)   crm.setName(jid, name);
                    if (email)  crm.setEmail(jid, email);

                    // Notify owner on first message from new customer
                    const customer = crm.getCustomer(jid);
                    const phone = jidToPhone(jid);
                    const displayName = name || customer?.name || pushName || displayId;
                    const phoneLine = phone ? `\nמספר: ${phone}` : `\nשם: ${displayName}`;

                    if (customer && customer.log.length === 1) {
                        await notifyOwner(`👋 *לקוח חדש פנה!*${phoneLine}\nהודעה: "${userText}"`);
                    }

                    // Hot lead notifications
                    if (status && status !== prevStatus) {
                        if (status === 'meeting_scheduled') {
                            await notifyOwner(`🔥 *ליד חם!* ${displayName} רוצה לקבוע פגישה!${phoneLine}\nהודעה: "${userText}"`);
                        } else if (status === 'interested') {
                            scoreLead(jid).then(score => {
                                const stars = score ? ` | ⭐ ${score}/10` : '';
                                notifyOwner(`⚡ *${displayName} מתעניין!*${phoneLine}${stars}`);
                            }).catch(() => notifyOwner(`⚡ *${displayName} מתעניין!*${phoneLine}`));
                        }
                    }

                    // Meeting request — propose slots to customer, notify owner
                    if (meetingRequest) {
                        const slots = findFreeSlots(3);
                        if (slots.length === 0) {
                            await notifyOwner(`📅 *${displayName} רוצה לקבוע פגישה*\n${phoneLine}\nאין זמן פנוי ביומן — תוסיף זמינות ב: *הוסף אירוע*`);
                            crm.addLog(jid, 'out', '[בקשת פגישה — אין זמן פנוי]');
                        } else {
                            const nums = ['1️⃣', '2️⃣', '3️⃣'];
                            const slotsText = slots.map((s, i) => {
                                const d = new Date(s.date);
                                return `${nums[i]} *${s.day} ${d.getDate()}/${d.getMonth()+1}* בשעה ${s.time}`;
                            }).join('\n');
                            pendingMeetingApproval = { customerJid: jid, name: displayName, slots };
                            // Send options to customer
                            await sock.sendMessage(jid, { text: `📅 בדקתי זמינות! הנה האפשרויות הפנויות:\n\n${slotsText}\n\nאיזה זמן מתאים לך?` });
                            crm.addLog(jid, 'out', `[הצעת זמנים לפגישה: ${slots.map(s=>s.date+' '+s.time).join(', ')}]`);
                            // Notify owner to approve
                            const ownerSlots = slots.map((s, i) => {
                                const d = new Date(s.date);
                                return `${i+1}. ${s.day} ${d.getDate()}/${d.getMonth()+1} ב-${s.time}`;
                            }).join('\n');
                            await notifyOwner(`📅 *${displayName} רוצה לקבוע פגישה*\n${phoneLine}\n\nהצעתי ללקוח:\n${ownerSlots}\n\nלאחר שיבחר, אשר:\n*אשר פגישה 1* / *אשר פגישה 2* / *אשר פגישה 3*\nלדחות: *דחה פגישה [זמן אחר]*`);
                        }
                    }

                    // Quote request — ask owner for approval
                    if (quoteRequest) {
                        const pkgKey = Object.keys(PACKAGES).find(k => quoteRequest.toLowerCase().includes(k.toLowerCase())) || quoteRequest;
                        const pkgDetails = PACKAGES[pkgKey]?.details || quoteRequest;
                        pendingQuotes.set(jid, { name: name || null, packageName: pkgKey, packageDetails: pkgDetails });
                        await notifyOwner(
                            `💼 *${displayName} מבקש הצעת מחיר*\n` +
                            (phone ? `מספר: ${phone}\n` : `שם: ${displayName}\n`) +
                            `חבילה: ${pkgKey}\n` +
                            (email ? `מייל: ${email}\n` : '') +
                            `\nכמה תרצה לגבות? שלח: *מחיר [סכום]*\nלדוגמה: מחיר 1500`
                        );
                    }
                }

                console.log(`💬 תשובה ל-${isOwner ? `יאיר (${ownerMode})` : jid}`);
                let finalReply = reply;
                if (voiceTranscript) finalReply = `🎤 _"${voiceTranscript}"_\n\n${reply}`;
                else if (imageDescription) finalReply = `🖼️ _ניתוח תמונה_\n\n${reply}`;
                await sock.sendMessage(jid, { text: finalReply }, { quoted: msg });

            } catch (err) {
                console.error('❌ שגיאה בהודעה:', err.message);
            }
        }
    });
}

process.on('unhandledRejection', (err) => console.error('שגיאה:', err.message));

// ── הבטח שyt-dlp קיים על הדיסק הקבוע ─────────────────────────
const { execSync } = require('child_process');
const _fs = require('fs');
const YTDLP_PATH = _fs.existsSync('/data') ? '/data/yt-dlp' : require('path').join(__dirname, 'yt-dlp');
process.env.YOUTUBE_DL_PATH = YTDLP_PATH;
if (!_fs.existsSync(YTDLP_PATH) || _fs.statSync(YTDLP_PATH).size < 10000) {
    console.log('⬇️ מוריד yt-dlp...');
    try {
        execSync(`curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "${YTDLP_PATH}" && chmod +x "${YTDLP_PATH}"`, { timeout: 60000 });
        console.log('✅ yt-dlp הותקן ב-' + YTDLP_PATH);
    } catch (e) {
        console.error('❌ הורדת yt-dlp נכשלה:', e.message?.slice(0, 80));
    }
} else {
    console.log('✅ yt-dlp קיים:', YTDLP_PATH);
}

startBot();

