require('dotenv').config();
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Groq = require('groq-sdk');
const crm = require('./crm');

let currentQR = null;
let botStatus = 'waiting'; // waiting | scanned | connected

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
</style></head>
<body><div class="box">
  <h2>חיבור WhatsApp</h2>
  <p class="sub">סרוק עם המספר הייעודי של הבוט</p>
  <div id="banner" style="display:none;background:#e8f5e9;color:#25d366;padding:8px;border-radius:8px;font-weight:bold;margin-bottom:8px;font-size:14px"></div>
  <img id="qr-img" src="" alt="טוען QR..."/>
  <div id="status-msg">ממתין לסריקה...</div>
  <div class="step"><div class="dot active" id="d1"></div><span>ממתין לסריקה</span></div>
  <div class="step"><div class="dot" id="d2"></div><span>QR נסרק</span></div>
  <div class="step"><div class="dot" id="d3"></div><span>מתחבר ל-WhatsApp</span></div>
  <div class="step"><div class="dot" id="d4"></div><span>מחובר ומוכן!</span></div>
</div>
<script>
let lastStatus='waiting';
let lastQR='';
async function refresh(){
  try{
    const s=await fetch('/status').then(r=>r.json());
    if(s.status!==lastStatus){
      lastStatus=s.status;
      const msg=document.getElementById('status-msg');
      const d2=document.getElementById('d2'),d3=document.getElementById('d3'),d4=document.getElementById('d4');
      if(s.status==='scanned'){
        d2.className='dot active';d3.className='dot spin';
        msg.textContent='QR נסרק! מתחבר...';
        document.getElementById('qr-img').style.opacity='0.3';
      } else if(s.status==='connected'){
        d2.className='dot active';d3.className='dot active';d4.className='dot active';
        msg.style.color='#25d366';msg.style.fontWeight='bold';
        msg.textContent='✅ מחובר! הבוט פעיל.';
        document.getElementById('qr-img').style.display='none';
        document.getElementById('banner').style.display='none';
      }
    }
    if(s.hasQR && s.status==='waiting'){
      const q=await fetch('/qr-image').then(r=>r.json());
      if(q.img && q.img!==lastQR){
        lastQR=q.img;
        const img=document.getElementById('qr-img');
        img.src=q.img;
        img.style.outline='4px solid #25d366';
        const b=document.getElementById('banner');
        b.style.display='block';
        b.textContent='🔄 QR חדש — סרוק עכשיו!';
        setTimeout(()=>{img.style.outline='none';b.style.display='none';},5000);
      }
    }
  }catch(e){}
  setTimeout(refresh, 2000);
}
refresh();
</script>
</body></html>`);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
}).listen(PORT, () => console.log(`Server on port ${PORT} | QR: /qr`));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const OWNER_NUMBER = process.env.OWNER_PHONE;
const OWNER_LID = process.env.OWNER_LID;

function isOwnerPhone(phone) {
    return phone.includes(OWNER_NUMBER) || (OWNER_LID && phone.includes(OWNER_LID));
}

const SALES_PROMPT = `אתה "מאקס" — נציג המכירות של מאסטר קוד, חברה לבניית דפי נחיתה ופתרונות דיגיטליים.

כללי שפה:
- כתוב אך ורק בעברית תקינה ומקצועית
- סגנון: מנומס, חם, מקצועי — לא רשמי מדי, לא סלנג
- משפטים קצרים וברורים
- אמוג'י במידה
- מונחים טכניים באנגלית מותרים (SEO, Dashboard, API)
- אם הלקוח אמר את שמו — השתמש בו בשיחה

החבילות שלנו:
1. 🚀 כניסה — ₪1,200
   - דף נחיתה מעוצב ורספונסיבי
   - טופס לידים + SEO בסיסי
   - זמן אספקה: 48 שעות

2. 📈 צמיחה דיגיטלית — ₪1,650
   - כולל את כל חבילת כניסה
   - אנימציות, Analytics, A/B Testing, חיבור WhatsApp
   - תמיכה למשך חודשיים

3. 💎 Full-Stack — ₪2,400
   - כולל את כל חבילת צמיחה
   - Backend, מסד נתונים, Dashboard, API
   - תמיכה למשך שלושה חודשים

תנאי תשלום: שליש מראש, יתרה במסירה. תוקף הצעה: 7 ימים.

המטרה שלך: לענות על שאלות ולקבוע שיחת המשך עם יאיר.
כשהלקוח מביע עניין — הצע: "אשמח לקבוע עבורך שיחה קצרה של 15 דקות עם יאיר. מתי נוח לך?"

בסוף כל תשובה, הוסף שורה נסתרת בפורמט הבא (לא תוצג ללקוח, לשימוש פנימי בלבד):
STATUS:[new|interested|meeting_scheduled|cold]
NAME:[שם הלקוח אם אמר, אחרת UNKNOWN]

אם אינך יודע לענות — ציין שאתה מעביר את הפנייה ליאיר ושיחזור בהקדם.`;

const ASSISTANT_PROMPT = `אתה עוזר אישי של יאיר, בעל מאסטר קוד.
כתוב בעברית תקינה, ידידותית וקצרה.
אתה יכול לעזור עם: ניסוח הודעות, רעיונות, תכנון, שאלות כלליות.
ענה תמיד בעברית, במשפטים קצרים וממוקדים.`;

const conversations = new Map();

function parseAIReply(raw) {
    const statusMatch = raw.match(/STATUS:\s*([\w_]+)/);
    const nameMatch = raw.match(/NAME:\s*(.+)/);
    const clean = raw
        .replace(/STATUS:\s*[\w_]+/g, '')
        .replace(/NAME:\s*.+/g, '')
        .trim();
    return {
        reply: clean,
        status: statusMatch ? statusMatch[1] : null,
        name: nameMatch && nameMatch[1] !== 'UNKNOWN' ? nameMatch[1].trim() : null
    };
}

async function getAIResponse(userPhone, userMessage, isOwner) {
    const systemPrompt = isOwner ? ASSISTANT_PROMPT : SALES_PROMPT;

    if (!conversations.has(userPhone)) conversations.set(userPhone, []);
    const history = conversations.get(userPhone);
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

// פירוש פקודות בעל עסק
function parseOwnerCommand(text) {
    const t = text.trim();

    if (/^לקוחות$|^רשימה$/.test(t)) return { cmd: 'list' };

    const sendMatch = t.match(/^שלח(?:\s+\S+)?\s+ל([0-9]+)\s+(.+)$/s);
    if (sendMatch) return { cmd: 'send', phone: sendMatch[1], msg: sendMatch[2].trim() };

    const historyMatch = t.match(/^היסטוריה\s+([0-9]+)$/);
    if (historyMatch) return { cmd: 'history', phone: historyMatch[1] };

    const statusMatch = t.match(/^סטטוס\s+([0-9]+)\s+(.+)$/);
    if (statusMatch) return { cmd: 'setstatus', phone: statusMatch[1], status: statusMatch[2].trim() };

    return null;
}

console.log('מאתחל Puppeteer...');
const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const fs = require('fs');
const chromePath = CHROME_PATHS.find(p => fs.existsSync(p));
if (chromePath) console.log('משתמש ב-Chrome:', chromePath);

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: process.env.DATA_PATH || './' }),
    puppeteer: {
        headless: true,
        executablePath: chromePath || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});
client.on('loading_screen', (percent, message) => {
    console.log(`טוען: ${percent}% - ${message}`);
});
process.on('unhandledRejection', (err) => console.error('שגיאה:', err.message));

client.on('qr', (qr) => {
    currentQR = qr;
    botStatus = 'waiting';
    console.log('\n📱 סרוק QR בדפדפן: https://mastercode-whatsapp-agent.onrender.com/qr\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    botStatus = 'scanned';
    currentQR = null;
    console.log('🔄 QR נסרק — מתחבר...');
});

client.on('ready', () => {
    botStatus = 'connected';
    currentQR = null;
    console.log('✅ מאקס מוכן ומחובר!');
});

client.on('message', async (message) => {
    try {
    if (message.from === 'status@broadcast') return;
    if (message.fromMe) return;
    if (message.from.includes('@g.us')) return;

    const userPhone = message.from;
    const userText = message.body;
    const isOwner = isOwnerPhone(userPhone);

    console.log(`📩 [${isOwner ? 'יאיר' : userPhone}]: ${userText}`);

    // פקודות בעל עסק
    if (isOwner) {
        const cmd = parseOwnerCommand(userText);

        if (cmd?.cmd === 'list') {
            await message.reply(crm.formatList());
            return;
        }

        if (cmd?.cmd === 'send') {
            const normalized = cmd.phone.startsWith('0')
                ? '972' + cmd.phone.slice(1)
                : cmd.phone;
            const targetPhone = normalized + '@c.us';
            try {
                await client.sendMessage(targetPhone, cmd.msg);
                crm.addLog(targetPhone, 'out', cmd.msg);
                await message.reply(`✅ ההודעה נשלחה ל-${cmd.phone}`);
            } catch (err) {
                await message.reply(`❌ שגיאה בשליחה: ${err.message}`);
            }
            return;
        }

        if (cmd?.cmd === 'history') {
            const ph = cmd.phone.startsWith('972') ? cmd.phone + '@c.us' : '972' + cmd.phone.replace(/^0/, '') + '@c.us';
            await message.reply(crm.formatHistory(ph));
            return;
        }

        if (cmd?.cmd === 'setstatus') {
            const ph = cmd.phone.startsWith('972') ? cmd.phone + '@c.us' : '972' + cmd.phone.replace(/^0/, '') + '@c.us';
            crm.setStatus(ph, cmd.status);
            await message.reply(`✅ סטטוס עודכן ל-${cmd.status}`);
            return;
        }
    }

    // שיחה רגילה
    const { reply, understood, status, name } = await getAIResponse(userPhone, userText, isOwner);

    if (!understood || !reply) {
        console.log(`❌ Groq לא הצליח לענות ל-${isOwner ? 'יאיר' : userPhone}`);
        if (!isOwner) {
            await message.reply('תודה על פנייתך. אני מעביר את הבקשה ליאיר והוא יחזור אליך בהקדם.');
            await client.sendMessage(
                OWNER_NUMBER + '@c.us',
                `🔔 לקוח ממתין לתשובה\nמספר: ${userPhone}\nהודעה: "${userText}"`
            );
        } else {
            await message.reply('❌ שגיאה בחיבור ל-AI. בדוק את ה-GROQ_API_KEY.');
        }
        return;
    }
    console.log(`💬 שולח תשובה ל-${isOwner ? 'יאיר' : userPhone}`);

    // עדכון CRM ללקוחות (לא לבעל העסק)
    if (!isOwner) {
        crm.getOrCreate(userPhone);
        crm.addLog(userPhone, 'in', userText);
        crm.addLog(userPhone, 'out', reply);
        if (status) crm.setStatus(userPhone, status);
        if (name) crm.setName(userPhone, name);
    }

    await message.reply(reply);
    } catch (err) {
        console.error('❌ שגיאה בטיפול בהודעה:', err.message);
    }
});

client.initialize();
