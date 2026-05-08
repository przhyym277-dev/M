require('dotenv').config();
const http = require('http');
const QRCode = require('qrcode');
const Groq = require('groq-sdk');
const crm = require('./crm');
const { generateQuote } = require('./quote');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const OWNER_NUMBER = process.env.OWNER_PHONE;
const OWNER_LID = process.env.OWNER_LID;
const OWNER_JID = OWNER_NUMBER + '@s.whatsapp.net';

// 'assistant' | 'lead' — owner can switch modes
let ownerMode = 'assistant';

// Pending price quote approvals: Map<customerJid, { name, packageName, packageDetails }>
const pendingQuotes = new Map();

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

const SALES_PROMPT = `אתה "מאקס" — נציג מכירות של מאסטר קוד, חברה לבניית דפי נחיתה ופתרונות דיגיטליים.

כללי שפה:
- עברית תקינה, חמה ומשכנעת — לא רשמי, לא סלנג
- משפטים קצרים וחדים
- תמיד תסיים עם שאלה שמקדמת את הסגירה
- אמוג'י במידה

טכניקת מכירה:
- שאל שאלות כדי להבין את הצורך לפני שאתה מציג מחיר
- הדגש תוצאות ולא פיצ'רים ("לקוחות ימצאו אותך בגוגל" לא "SEO בסיסי")
- כשהלקוח מתעניין — צור דחיפות: "יש לנו חלון פנוי השבוע"
- התנגדות מחיר? חלק לתשלומים, הצג את הערך: "זה פחות מ-₪50 ליום"
- מטרה: לקבוע שיחה עם יאיר. כשמוכן — "מתי נוח לך לשיחה קצרה של 15 דקות?"

החבילות:
1. 🚀 כניסה — ₪1,200 | דף נחיתה, טופס לידים, SEO | 48 שעות
2. 📈 צמיחה דיגיטלית — ₪1,650 | + אנימציות, Analytics, WhatsApp | תמיכה 2 חודשים
3. 💎 Full-Stack — ₪2,400 | + Backend, DB, Dashboard, API | תמיכה 3 חודשים

תנאי תשלום: שליש מראש, יתרה במסירה. תוקף הצעה: 7 ימים.

איסוף מידע — נסה לקבל בטבעיות תוך כדי שיחה:
- שם הלקוח
- מייל (לשליחת הצעת מחיר)

כשלקוח מבקש הצעת מחיר מפורטת או כשהוא מוכן — הוסף: QUOTE_REQUEST:[שם החבילה הכי מתאימה]

בסוף כל תשובה הוסף:
STATUS:[new|interested|meeting_scheduled|cold]
NAME:[שם הלקוח או UNKNOWN]
EMAIL:[מייל הלקוח או UNKNOWN]`;

const ASSISTANT_PROMPT = `אתה עוזר אישי חכם של יאיר — בעל מאסטר קוד, חברה לבניית דפי נחיתה ופתרונות דיגיטליים.

האופי שלך:
- ישיר, ידידותי, מעשי
- עונה בעברית תקינה וקצרה — אל תפרגן יותר מדי מילים
- כשנשאל לדעה — תן דעה אמיתית, לא "זה תלוי..."

מה אתה יודע לעשות:
- לנסח: הצעות מחיר, מיילים, פוסטים לסושיאל, תיאורי שירות
- להציע רעיונות: שמות לעסקים, רעיונות שיווקיים, קמפיינים, כותרות לדפי נחיתה
- לתכנן: לוחות זמנים, רשימות משימות, אסטרטגיה
- לענות על שאלות כלליות: טכנולוגיה, עסקים, שיווק דיגיטלי
- לעזור עם קוד, לוגיקה, בעיות טכניות

כשיאיר אומר "תציע לי רעיונות" — תן לפחות 3-5 רעיונות קונקרטיים.
כשיאיר שואל "מה אתה חושב על X" — תן חוות דעת ברורה עם נימוק קצר.`;

const conversations = new Map();

function parseAIReply(raw) {
    const statusMatch = raw.match(/STATUS:\s*([\w_]+)/);
    const nameMatch   = raw.match(/NAME:\s*(.+)/);
    const emailMatch  = raw.match(/EMAIL:\s*(.+)/);
    const quoteMatch  = raw.match(/QUOTE_REQUEST:\s*(.+)/);
    const clean = raw
        .replace(/STATUS:\s*[\w_]+/g, '')
        .replace(/NAME:\s*.+/g, '')
        .replace(/EMAIL:\s*.+/g, '')
        .replace(/QUOTE_REQUEST:\s*.+/g, '')
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
    const systemPrompt = mode === 'assistant' ? ASSISTANT_PROMPT : SALES_PROMPT;
    if (!conversations.has(jid)) conversations.set(jid, []);
    const history = conversations.get(jid);
    history.push({ role: 'user', content: userMessage });
    if (history.length > 20) history.splice(0, history.length - 20);
    try {
        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'system', content: systemPrompt }, ...history],
            max_tokens: 500,
            temperature: 0.7
        });
        const raw = response.choices[0].message.content;
        history.push({ role: 'assistant', content: raw });
        return { ...parseAIReply(raw), understood: true };
    } catch (err) {
        console.error('Groq error:', err.message);
        return { reply: null, understood: false };
    }
}

function parseOwnerCommand(text) {
    const t = text.trim();
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
            const shouldReconnect = code !== DisconnectReason.loggedOut;
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
                            const pdfBuf = await generateQuote({
                                customerName:   quoteData.name || 'לקוח',
                                packageName:    quoteData.packageName,
                                packageDetails: quoteData.packageDetails,
                                price:          cmd.amount,
                            });
                            const fileName = `הצעת מחיר - ${quoteData.name || 'לקוח'}.pdf`;
                            await sock.sendMessage(targetJid, {
                                document: pdfBuf,
                                mimetype: 'application/pdf',
                                fileName,
                                caption: `📄 הצעת המחיר שלך מוכנה! לשאלות — אני כאן 😊`
                            });
                            crm.addLog(targetJid, 'out', `[הצעת מחיר נשלחה: ${quoteData.packageName} ₪${cmd.amount}]`);
                            await sock.sendMessage(jid, { text: `✅ הצעת מחיר נשלחה ל-${quoteData.name || targetJid} — ${quoteData.packageName} ₪${cmd.amount}` });
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
                }

                const aiMode = isOwner ? ownerMode : 'sales';

                // Typing indicator
                await sock.sendPresenceUpdate('composing', jid);
                const { reply, understood, status, name, email, quoteRequest } = await getAIResponse(jid, userText, aiMode);
                await sock.sendPresenceUpdate('paused', jid);

                if (!understood || !reply) {
                    console.log(`❌ Groq נכשל`);
                    if (!isOwner) {
                        await sock.sendMessage(jid, { text: 'תודה על פנייתך. אני מעביר ליאיר והוא יחזור אליך בהקדם.' });
                        await notifyOwner(`🔔 לקוח ממתין\nמספר: ${jid}\nהודעה: "${userText}"`);
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

                    // Hot lead notifications
                    if (status && status !== prevStatus) {
                        if (status === 'meeting_scheduled') {
                            await notifyOwner(`🔥 *ליד חם!* ${name || jid} רוצה לקבוע פגישה!\nמספר: ${jid}\nהודעה: "${userText}"`);
                        } else if (status === 'interested') {
                            await notifyOwner(`⚡ *${name || jid} מתעניין!*\nמספר: ${jid}`);
                        }
                    }

                    // Quote request — ask owner for approval
                    if (quoteRequest) {
                        const pkgKey = Object.keys(PACKAGES).find(k => quoteRequest.toLowerCase().includes(k.toLowerCase())) || quoteRequest;
                        const pkgDetails = PACKAGES[pkgKey]?.details || quoteRequest;
                        pendingQuotes.set(jid, { name: name || null, packageName: pkgKey, packageDetails: pkgDetails });
                        await notifyOwner(
                            `💼 *${name || jid} מבקש הצעת מחיר*\n` +
                            `מספר: ${jid}\n` +
                            `חבילה: ${pkgKey}\n` +
                            (email ? `מייל: ${email}\n` : '') +
                            `\nשלח: *מחיר [סכום]* כדי לשלוח PDF ללקוח`
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
