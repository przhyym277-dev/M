require('dotenv').config();
const http = require('http');
const QRCode = require('qrcode');
const Groq = require('groq-sdk');
const crm = require('./crm');
const { generateQuote } = require('./quote');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const https = require('https');
const GROQ_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter(Boolean);
let groqKeyIndex = 0;
function getGroqClient() { return new Groq({ apiKey: GROQ_KEYS[groqKeyIndex] }); }
const OWNER_NUMBER = process.env.OWNER_PHONE;
const OWNER_LID = process.env.OWNER_LID;
const OWNER_JID = OWNER_NUMBER + '@s.whatsapp.net';
const RENDER_SERVICE_ID = 'srv-d7usaljtqb8s73csmle0';

// 'assistant' | 'lead' | 'learning' — owner can switch modes
let ownerMode = 'assistant';

// Pending price quote approvals: Map<customerJid, { name, packageName, packageDetails }>
const pendingQuotes = new Map();

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

async function saveKnowledgeToRender(knowledge) {
    const data = await renderApiRequest('GET', `/v1/services/${RENDER_SERVICE_ID}/env-vars`);
    const arr = Array.isArray(data) ? data : [];
    const existing = arr.map(e => ({ key: e.envVar.key, value: e.envVar.value }));
    const merged = existing.filter(e => e.key !== 'BUSINESS_KNOWLEDGE');
    merged.push({ key: 'BUSINESS_KNOWLEDGE', value: knowledge });
    await renderApiRequest('PUT', `/v1/services/${RENDER_SERVICE_ID}/env-vars`, merged);
    process.env.BUSINESS_KNOWLEDGE = knowledge;
}

function isOwnerPhone(jid) {
    return jid.includes(OWNER_NUMBER) || (OWNER_LID && jid.includes(OWNER_LID));
}

function getText(msg) {
    return msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
}

let currentQR = null;
let botStatus = 'waiting';
let sock = null;

// Health check + QR server
const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
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

אל תאמר "יאיר יחזור אליך" — נהל את השיחה עצמאית עד לסגירה.

בסוף כל תשובה הוסף:
STATUS:[new|interested|meeting_scheduled|cold]
NAME:[שם הלקוח או UNKNOWN]
EMAIL:[מייל הלקוח או UNKNOWN]`;

const ASSISTANT_PROMPT = `אתה עוזר אישי חכם של יאיר.

על יאיר:
- בעל מאסטר קוד — חברה לבניית דפי נחיתה ופתרונות דיגיטליים בישראל
- מתמחה: אתרים, SEO, בוטים לוואטסאפ, חנויות אונליין
- טלפון: 0522091733

האופי שלך:
- ישיר, ידידותי, מעשי — לא פורמלי
- עונה בעברית קצרה וחדה
- נותן דעה אמיתית כשנשאל, לא "זה תלוי..."
- כשמבקשים רעיונות — לפחות 3-5 קונקרטיים, לא כלליים

תחומי עזרה — הכל:
- עסקי: הצעות מחיר, ניסוח חוזים, מיילים ללקוחות, אסטרטגיה עסקית
- שיווק: פוסטים לסושיאל, קמפיינים, כותרות, תיאורי מוצר
- טכנולוגיה: קוד, בעיות טכניות, בחירת כלים
- כללי: תכנון, החלטות, שאלות כלשהן — ספורט, בישול, חדשות, כל נושא
- אישי: לוחות זמנים, רשימות משימות, כל מה שיאיר צריך

אין נושא מחוץ לתחום — ענה על הכל.`;

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
    const knowledgeBlock = knowledge ? `\n\n---\nידע על העסק (מעודכן על ידי יאיר):\n${knowledge}` : '';
    if (mode === 'learning') return LEARNING_PROMPT;
    if (mode === 'assistant') return ASSISTANT_PROMPT + knowledgeBlock;
    return SALES_PROMPT + knowledgeBlock;
}

const conversations = new Map();

function parseAIReply(raw) {
    const statusMatch = raw.match(/STATUS:\s*\[?([\w_]+)\]?/);
    const nameMatch   = raw.match(/NAME:\s*\[?(.+?)\]?\s*$/m);
    const emailMatch  = raw.match(/EMAIL:\s*\[?(.+?)\]?\s*$/m);
    const quoteMatch  = raw.match(/QUOTE_REQUEST:\s*\[?(.+?)\]?\s*$/m);
    // Remove entire lines that contain any of the meta tags
    const clean = raw
        .split('\n')
        .filter(line => !/STATUS:|NAME:|EMAIL:|QUOTE_REQUEST:/.test(line))
        .join('\n')
        .trim();
    return {
        reply:        clean,
        status:       statusMatch ? statusMatch[1] : null,
        name:         nameMatch  && nameMatch[1].trim()  !== 'UNKNOWN' ? nameMatch[1].trim()  : null,
        email:        emailMatch && emailMatch[1].trim() !== 'UNKNOWN' ? emailMatch[1].trim() : null,
        quoteRequest: quoteMatch ? quoteMatch[1].trim() : null,
    };
}

async function getAIResponse(jid, userMessage, mode) {
    const systemPrompt = buildSystemPrompt(mode);
    if (!conversations.has(jid)) conversations.set(jid, []);
    const history = conversations.get(jid);
    history.push({ role: 'user', content: userMessage });
    if (history.length > 16) history.splice(0, history.length - 16);

    for (let attempt = 0; attempt < GROQ_KEYS.length; attempt++) {
        try {
            const client = getGroqClient();
            const completion = await client.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'system', content: systemPrompt }, ...history],
                max_tokens: 500,
                temperature: 0.7,
            });
            const raw = completion.choices[0]?.message?.content || '';
            history.push({ role: 'assistant', content: raw });
            return { ...parseAIReply(raw), understood: true };
        } catch (err) {
            const is429 = err.message?.includes('429') || err.status === 429;
            if (is429 && attempt < GROQ_KEYS.length - 1) {
                groqKeyIndex = (groqKeyIndex + 1) % GROQ_KEYS.length;
                console.log(`⚠️ Groq key ${attempt + 1} הגיע ללימיט, עובר למפתח ${groqKeyIndex + 1}`);
                continue;
            }
            console.error('Groq error:', err.message);
            return { reply: null, understood: false };
        }
    }
    return { reply: null, understood: false };
}

function parseOwnerCommand(text) {
    const t = text.trim();
    if (/^נקה הכל$|^מחק הכל$/.test(t)) return { cmd: 'clear_all' };
    if (/^מצב למידה$|^למד$/.test(t))        return { cmd: 'mode_learning' };
    if (/^סיים למידה$|^שמור ידע$|^סיים$/.test(t)) return { cmd: 'save_learning' };
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
        if (connection === 'open')       { currentQR = null; botStatus = 'connected'; console.log('✅ מאקס מוכן ומחובר!'); }
        if (connection === 'connecting') { botStatus = 'scanned'; console.log('🔄 מתחבר...'); }
        if (connection === 'close') {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut && code !== DisconnectReason.connectionReplaced;
            console.log('⚠️ התנתק, קוד:', code, '| מתחבר שוב:', shouldReconnect);
            botStatus = 'waiting';
            if (shouldReconnect) setTimeout(startBot, 3000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                if (msg.key.fromMe) continue;
                const jid = msg.key.remoteJid;
                if (!jid || jid === 'status@broadcast') continue;
                if (jid.endsWith('@g.us')) continue;

                const userText = getText(msg);
                if (!userText) continue;

                const isOwner = isOwnerPhone(jid);
                console.log(`📩 [${isOwner ? 'יאיר' : jid}]: ${userText}`);

                if (isOwner) {
                    const cmd = parseOwnerCommand(userText);

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
                    if (cmd?.cmd === 'clear_all') {
                        conversations.clear();
                        const fs = require('fs');
                        const crmPath = require('path').join(__dirname, 'crm.json');
                        fs.writeFileSync(crmPath, '{}', 'utf8');
                        pendingQuotes.clear();
                        await sock.sendMessage(jid, { text: '🗑️ נמחק הכל — CRM, היסטוריית שיחות, הצעות ממתינות.' });
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
                }

                const aiMode = isOwner ? ownerMode : 'sales';
                const aiJid  = (isOwner && ownerMode === 'learning') ? '__learning__' : jid;

                // Typing indicator (ignore errors — @lid JIDs may not support presence)
                const presence = (type) => Promise.race([
                    sock.sendPresenceUpdate(type, jid).catch(() => {}),
                    new Promise(r => setTimeout(r, 1500))
                ]);
                await presence('composing');
                const { reply, understood, status, name, email, quoteRequest } = await getAIResponse(aiJid, userText, aiMode);
                await presence('paused');

                if (!understood || !reply) {
                    console.log(`❌ Groq נכשל`);
                    if (!isOwner) {
                        await sock.sendMessage(jid, { text: 'רגע אחד, בודק עבורך... 🔄' });
                        await notifyOwner(`🔔 לקוח ממתין לתשובה\nשם: ${crm.getCustomer(jid)?.name || 'לא ידוע'}\nמספר: ${jidToPhone(jid)}\nהודעה: "${userText}"`);
                    } else {
                        await sock.sendMessage(jid, { text: '❌ שגיאה בחיבור ל-AI.' });
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
                    if (customer && customer.log.length === 1) {
                        await notifyOwner(`👋 *לקוח חדש פנה!*\nמספר: ${jidToPhone(jid)}\nהודעה: "${userText}"`);
                    }

                    // Hot lead notifications
                    if (status && status !== prevStatus) {
                        if (status === 'meeting_scheduled') {
                            await notifyOwner(`🔥 *ליד חם!* ${name || jidToPhone(jid)} רוצה לקבוע פגישה!\nמספר: ${jidToPhone(jid)}\nהודעה: "${userText}"`);
                        } else if (status === 'interested') {
                            await notifyOwner(`⚡ *${name || jidToPhone(jid)} מתעניין!*\nמספר: ${jidToPhone(jid)}`);
                        }
                    }

                    // Quote request — ask owner for approval
                    if (quoteRequest) {
                        const pkgKey = Object.keys(PACKAGES).find(k => quoteRequest.toLowerCase().includes(k.toLowerCase())) || quoteRequest;
                        const pkgDetails = PACKAGES[pkgKey]?.details || quoteRequest;
                        pendingQuotes.set(jid, { name: name || null, packageName: pkgKey, packageDetails: pkgDetails });
                        await notifyOwner(
                            `💼 *${name || jidToPhone(jid)} מבקש הצעת מחיר*\n` +
                            `מספר: ${jidToPhone(jid)}\n` +
                            `חבילה: ${pkgKey}\n` +
                            (email ? `מייל: ${email}\n` : '') +
                            `\nכמה תרצה לגבות? שלח: *מחיר [סכום]*\nלדוגמה: מחיר 1500`
                        );
                    }
                }

                console.log(`💬 תשובה ל-${isOwner ? `יאיר (${ownerMode})` : jid}`);
                await sock.sendMessage(jid, { text: reply }, { quoted: msg });

            } catch (err) {
                console.error('❌ שגיאה בהודעה:', err.message);
            }
        }
    });
}

process.on('unhandledRejection', (err) => console.error('שגיאה:', err.message));
startBot();
