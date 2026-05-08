require('dotenv').config();
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Groq = require('groq-sdk');
const crm = require('./crm');

let currentQR = null;

// Health check + QR server
const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
    if (req.url === '/qr') {
        if (!currentQR) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h2>הבוט כבר מחובר, אין צורך בסריקה</h2>');
            return;
        }
        const imgData = await QRCode.toDataURL(currentQR);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;background:#fff">
            <h2>סרוק עם WhatsApp של המספר הייעודי</h2>
            <img src="${imgData}" style="width:300px;height:300px"/>
            <p>רענן את הדף אם הקוד פג תוקף</p>
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

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: process.env.DATA_PATH || './' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => {
    currentQR = qr;
    console.log('\n📱 פתח את הכתובת הזו בדפדפן כדי לסרוק QR:');
    console.log(`   https://mastercode-whatsapp-agent.onrender.com/qr\n`);
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    currentQR = null;
    console.log('✅ מאקס מוכן ומחובר!');
});

client.on('message', async (message) => {
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
        if (!isOwner) {
            await message.reply('תודה על פנייתך. אני מעביר את הבקשה ליאיר והוא יחזור אליך בהקדם.');
            await client.sendMessage(
                OWNER_NUMBER + '@c.us',
                `🔔 לקוח ממתין לתשובה\nמספר: ${userPhone}\nהודעה: "${userText}"`
            );
        }
        return;
    }

    // עדכון CRM ללקוחות (לא לבעל העסק)
    if (!isOwner) {
        crm.getOrCreate(userPhone);
        crm.addLog(userPhone, 'in', userText);
        crm.addLog(userPhone, 'out', reply);
        if (status) crm.setStatus(userPhone, status);
        if (name) crm.setName(userPhone, name);
    }

    await message.reply(reply);
});

client.initialize();
