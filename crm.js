const fs = require('fs');
const path = require('path');

const CRM_FILE = path.join(__dirname, 'crm.json');

function load() {
    if (!fs.existsSync(CRM_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(CRM_FILE, 'utf8')); } catch { return {}; }
}

function save(data) {
    fs.writeFileSync(CRM_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getOrCreate(phone) {
    const db = load();
    if (!db[phone]) {
        db[phone] = {
            phone,
            name: null,
            email: null,
            status: 'new',
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            log: []
        };
        save(db);
    }
    return db[phone];
}

function addLog(phone, direction, text) {
    const db = load();
    if (!db[phone]) {
        db[phone] = {
            phone,
            name: null,
            status: 'new',
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            log: []
        };
    }
    db[phone].lastSeen = new Date().toISOString();
    db[phone].log.push({
        time: new Date().toLocaleString('he-IL'),
        direction,
        text
    });
    if (db[phone].log.length > 50) db[phone].log = db[phone].log.slice(-50);
    save(db);
}

function setStatus(phone, status) {
    const db = load();
    if (!db[phone]) getOrCreate(phone);
    db[phone].status = status;
    save(db);
}

function setName(phone, name) {
    const db = load();
    if (!db[phone]) getOrCreate(phone);
    db[phone].name = name;
    save(db);
}

function setEmail(phone, email) {
    const db = load();
    if (!db[phone]) getOrCreate(phone);
    db[phone].email = email;
    save(db);
}

function getAll() {
    return load();
}

function getCustomer(phone) {
    const db = load();
    return db[phone] || null;
}

const STATUS_EMOJI = {
    new: '🆕',
    interested: '🔥',
    meeting_scheduled: '📅',
    closed: '✅',
    cold: '❄️'
};

function formatList() {
    const db = load();
    const customers = Object.values(db);
    if (customers.length === 0) return 'אין לקוחות עדיין.';

    return customers.map(c => {
        const emoji = STATUS_EMOJI[c.status] || '•';
        const name = c.name || c.phone;
        const last = c.log.length ? c.log[c.log.length - 1].text.substring(0, 40) : '—';
        const emailLine = c.email ? `\n📧 ${c.email}` : '';
        return `${emoji} *${name}*\nסטטוס: ${c.status} | ${c.phone}${emailLine}\nאחרון: ${last}`;
    }).join('\n\n');
}

function formatHistory(phone) {
    const c = getCustomer(phone);
    if (!c) return `לא נמצא לקוח עם המספר ${phone}`;
    const name = c.name || phone;
    const lines = c.log.slice(-15).map(l =>
        `[${l.time}] ${l.direction === 'in' ? '👤' : '🤖'} ${l.text}`
    );
    const emailHeader = c.email ? `\n📧 ${c.email}` : '';
    return `📋 *היסטוריה — ${name}*\nסטטוס: ${c.status}${emailHeader}\n\n${lines.join('\n') || 'אין הודעות'}`;
}

module.exports = { getOrCreate, addLog, setStatus, setName, setEmail, getAll, getCustomer, formatList, formatHistory };
