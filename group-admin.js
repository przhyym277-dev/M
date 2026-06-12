'use strict';

const fs = require('fs');
const path = require('path');

// Persistent storage — /data on Render (persistent disk), ./data locally
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'group-settings.json');

const groupSettings = new Map();
const warnings = new Map();
const lockedCommands = new Map();
const groupWelcomeTemplates = new Map();
const premiumSettings = new Map(); // gid → { __all__: bool, שיר: bool, סרט: bool, ... } — per-command overrides + group default
const dailyLimits    = new Map(); // gid → { limit: N, count: N, date: 'YYYY-MM-DD' }
const matchmakingBlocked = new Map(); // gid → Set<jid>
const commandCooldowns = new Map(); // gid → { cmdName: minutes } — admin-set cooldown per command (persisted)
const cooldownLastUsed = new Map(); // gid → { cmdName: timestamp } — runtime only, resets on restart

const PREMIUM_COMMANDS = ['שיר', 'סרט', 'סדרה', 'תמונה', 'ניתוח קבוצה', 'ראפ בטל'];

function loadSettings() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        if (raw.groupSettings) {
            for (const [gid, s] of Object.entries(raw.groupSettings))
                groupSettings.set(gid, s);
        }
        if (raw.lockedCommands) {
            for (const [gid, cmds] of Object.entries(raw.lockedCommands))
                lockedCommands.set(gid, new Set(cmds));
        }
        if (raw.warnings) {
            for (const [gid, w] of Object.entries(raw.warnings)) {
                const m = new Map();
                for (const [uid, n] of Object.entries(w)) m.set(uid, n);
                warnings.set(gid, m);
            }
        }
        if (raw.welcomeTemplates) {
            for (const [gid, t] of Object.entries(raw.welcomeTemplates))
                groupWelcomeTemplates.set(gid, t);
        }
        if (raw.premiumSettings) {
            for (const [gid, p] of Object.entries(raw.premiumSettings))
                premiumSettings.set(gid, p);
        }
        if (raw.dailyLimits) {
            for (const [gid, d] of Object.entries(raw.dailyLimits))
                dailyLimits.set(gid, d);
        }
        if (raw.matchmakingBlocked) {
            for (const [gid, jids] of Object.entries(raw.matchmakingBlocked))
                matchmakingBlocked.set(gid, new Set(jids));
        }
        if (raw.commandCooldowns) {
            for (const [gid, c] of Object.entries(raw.commandCooldowns))
                commandCooldowns.set(gid, c);
        }
        console.log(`✅ Group settings loaded (${groupSettings.size} groups)`);
    } catch (e) {
        console.error('Failed to load group settings:', e.message);
    }
}

function saveSettings() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const data = {
            groupSettings: Object.fromEntries(groupSettings),
            lockedCommands: Object.fromEntries([...lockedCommands].map(([k, v]) => [k, [...v]])),
            warnings: Object.fromEntries([...warnings].map(([gid, m]) => [gid, Object.fromEntries(m)])),
            welcomeTemplates: Object.fromEntries(groupWelcomeTemplates),
            premiumSettings: Object.fromEntries(premiumSettings),
            dailyLimits: Object.fromEntries(dailyLimits),
            matchmakingBlocked: Object.fromEntries([...matchmakingBlocked].map(([k, v]) => [k, [...v]])),
            commandCooldowns: Object.fromEntries(commandCooldowns),
        };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save group settings:', e.message);
    }
}

loadSettings();

const GLOBAL_SUPER_ADMINS = new Set(['972522091733', '972508181322', '98668719951947', '188150102098030']);

const LOCKABLE_COMMANDS = ['בדיחות','טיפ','עובדה','ציטוט','טריוויה','חידה','נכון או אמת','מזל','שידוך','רולטה','ראפ','תרגם','מחמאה','עלבון','מתכון','תרגיל','מילה','שיר','סרט','סקר','הצבעה','אנונימי','תזכורת','ספירה','סיכום','מי אמר','גימטריה','הגרלה','חשב','חזור','qr','תמלל','פרופיל','תמונה','סטיקר','משחקים'];

// פקודות שאפשר להגדיר להן פסק זמן (cooldown) — חייב להתאים לשמות הקנוניים שמזהה getLockedCommandName
const COOLDOWNABLE_COMMANDS = new Set([...LOCKABLE_COMMANDS, ...PREMIUM_COMMANDS, 'ראפ בטל', 'ניתוח קבוצה', 'סדרה']);

function isGlobalAdmin(senderJid) {
    return GLOBAL_SUPER_ADMINS.has(senderJid.split('@')[0]);
}

function isCommandLocked(gid, cmdName) {
    const locked = lockedCommands.get(gid);
    return locked ? locked.has(cmdName) : false;
}

function getSettings(gid) {
    if (!groupSettings.has(gid)) groupSettings.set(gid, { removeLinks: false, removeStickerMode: false, stopStickerMode: false, welcomeEnabled: true, warningThreshold: 3, linkStats: 0, linkCommandPublic: true });
    return groupSettings.get(gid);
}

function getWarnings(gid) {
    if (!warnings.has(gid)) warnings.set(gid, new Map());
    return warnings.get(gid);
}

function getLockedSet(gid) {
    if (!lockedCommands.has(gid)) lockedCommands.set(gid, new Set());
    return lockedCommands.get(gid);
}

function getPremium(gid) {
    if (!premiumSettings.has(gid)) premiumSettings.set(gid, {});
    return premiumSettings.get(gid);
}

// הרשאות פרימיום כבויות כברירת מחדל בקבוצות.
// p[cmd] === true/false  → override ספציפי לפקודה
// p.__all__ === true     → הופעל גורף לקבוצה ("פרימיום הכל פעיל")
// אחרת                   → כבוי
function isPremiumEnabled(gid, cmd) {
    const p = getPremium(gid);
    if (p[cmd] === true) return true;
    if (p[cmd] === false) return false;
    return p.__all__ === true;
}

function getCooldowns(gid) {
    if (!commandCooldowns.has(gid)) commandCooldowns.set(gid, {});
    return commandCooldowns.get(gid);
}

function setCommandCooldown(gid, cmdName, minutes) {
    const c = getCooldowns(gid);
    if (minutes > 0) c[cmdName] = minutes;
    else delete c[cmdName];
    saveSettings();
}

function checkCommandCooldown(gid, cmdName) {
    const minutes = getCooldowns(gid)[cmdName];
    if (!minutes) return { allowed: true };
    const last = cooldownLastUsed.get(gid)?.[cmdName] || 0;
    const windowMs = minutes * 60 * 1000;
    const elapsed = Date.now() - last;
    if (elapsed >= windowMs) return { allowed: true };
    return { allowed: false, waitSeconds: Math.ceil((windowMs - elapsed) / 1000) };
}

function markCommandUsed(gid, cmdName) {
    if (!getCooldowns(gid)[cmdName]) return;
    if (!cooldownLastUsed.has(gid)) cooldownLastUsed.set(gid, {});
    cooldownLastUsed.get(gid)[cmdName] = Date.now();
}

function todayStr() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
}

function checkDailyLimit(gid) {
    const entry = dailyLimits.get(gid);
    if (!entry || !entry.limit) return true; // no limit set
    const today = todayStr();
    if (entry.date !== today) { entry.count = 0; entry.date = today; saveSettings(); }
    return entry.count < entry.limit;
}

function incrementDailyCount(gid) {
    const entry = dailyLimits.get(gid);
    if (!entry || !entry.limit) return;
    const today = todayStr();
    if (entry.date !== today) { entry.count = 0; entry.date = today; }
    entry.count++;
    saveSettings();
}

function getDailyStatus(gid) {
    const entry = dailyLimits.get(gid);
    if (!entry || !entry.limit) return null;
    const today = todayStr();
    const count = (entry.date === today) ? entry.count : 0;
    return { limit: entry.limit, count };
}

async function handleAdminCommand(sock, msg, jid, text, senderJid, isSenderAdmin, isBotAdmin) {
    const settings = getSettings(jid);
    const trimmed = text.trim();
    const cmd = trimmed.split(' ')[0];
    const isAdmin = isSenderAdmin || isGlobalAdmin(senderJid);

    // ── הרשאות פרימיום (בעלים בלבד) ──────────────────────────────
    if (trimmed === 'הרשאות פרימיום') {
        if (!isGlobalAdmin(senderJid)) { await sock.sendMessage(jid, { text: '🚫 פקודה זו זמינה לבעלי הבוט בלבד.' }); return true; }
        const p = getPremium(jid);
        const allLine = p.__all__ === true ? '🟢 *מצב גורף:* כל הפרימיום פעיל' : '🔴 *מצב גורף:* כבוי (ברירת מחדל)';
        const lines = PREMIUM_COMMANDS.map(c => `${isPremiumEnabled(jid, c) ? '✅' : '❌'} *${c}*`).join('\n');
        const daily = getDailyStatus(jid);
        const dailyLine = daily ? `\n📊 *הגבלת הודעות:* ${daily.count}/${daily.limit} היום` : '\n📊 *הגבלת הודעות:* ללא הגבלה';
        await sock.sendMessage(jid, { text: `👑 *הרשאות פרימיום לקבוצה זו:*\n${allLine}\n\n${lines}${dailyLine}\n\nהפעלה/כיבוי גורף: *פרימיום הכל פעיל* / *פרימיום הכל כבוי*\nשינוי פקודה: *פרימיום [פקודה] [פעיל/כבוי]*\nהגבלת הודעות: *פרימיום הגבלה [מספר]* / *פרימיום הגבלה כבוי*` });
        return true;
    }

    if (trimmed.startsWith('פרימיום ')) {
        if (!isGlobalAdmin(senderJid)) { await sock.sendMessage(jid, { text: '🚫 פקודה זו זמינה לבעלי הבוט בלבד.' }); return true; }
        const parts = trimmed.slice('פרימיום '.length).trim().split(' ');
        const cmdName = parts[0];
        const state = parts[1];

        // הפעלה/כיבוי גורף של כל הרשאות הפרימיום
        if (cmdName === 'הכל') {
            if (!['פעיל','כבוי'].includes(state)) {
                await sock.sendMessage(jid, { text: '⚠️ כתוב: *פרימיום הכל פעיל* / *פרימיום הכל כבוי*' });
                return true;
            }
            const p = getPremium(jid);
            for (const c of PREMIUM_COMMANDS) delete p[c]; // ניקוי override-ים ספציפיים כדי שהמצב הגורף יחול
            p.__all__ = state === 'פעיל';
            saveSettings();
            await sock.sendMessage(jid, { text: state === 'פעיל'
                ? '👑 כל הרשאות הפרימיום *הופעלו* בקבוצה זו ✅'
                : '👑 כל הרשאות הפרימיום *כובו* בקבוצה זו ❌' });
            return true;
        }

        // הגבלת הודעות יומית
        if (cmdName === 'הגבלה') {
            if (state === 'כבוי') {
                dailyLimits.delete(jid);
                saveSettings();
                await sock.sendMessage(jid, { text: '✅ הגבלת ההודעות היומית הוסרה.' });
            } else {
                const n = parseInt(state, 10);
                if (isNaN(n) || n < 1) { await sock.sendMessage(jid, { text: '⚠️ כתוב: פרימיום הגבלה [מספר] / פרימיום הגבלה כבוי' }); return true; }
                dailyLimits.set(jid, { limit: n, count: 0, date: todayStr() });
                saveSettings();
                await sock.sendMessage(jid, { text: `📊 הגבלה נקבעה: עד *${n} הודעות* ביום בקבוצה זו.` });
            }
            return true;
        }

        if (!PREMIUM_COMMANDS.includes(cmdName) || !['פעיל','כבוי'].includes(state)) {
            await sock.sendMessage(jid, { text: `⚠️ כתוב: פרימיום [${PREMIUM_COMMANDS.join('/')}] [פעיל/כבוי]\nאו: פרימיום הגבלה [מספר/כבוי]` });
            return true;
        }
        const p = getPremium(jid);
        p[cmdName] = state === 'פעיל';
        saveSettings();
        await sock.sendMessage(jid, { text: `👑 פקודת *${cmdName}* ${state === 'פעיל' ? '✅ הופעלה' : '❌ כובתה'} בקבוצה זו.` });
        return true;
    }

    if (cmd === 'הסרתקישורים') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            settings.removeLinks = true;
            saveSettings();
            await sock.sendMessage(jid, { text: `🔗 *הסרת קישורים פעילה!*\nקישורים יוסרו אוטומטית. אזהרה ${settings.warningThreshold} → הסרה מהקבוצה.` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'בטלהסרתקישורים') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            settings.removeLinks = false;
            saveSettings();
            await sock.sendMessage(jid, { text: `✅ הסרת קישורים בוטלה.` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'קישורים') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            await sock.sendMessage(jid, { text: `📊 *סטטיסטיקת קישורים:*\nקישורים שהוסרו: ${settings.linkStats}\nמצב: ${settings.removeLinks ? '🔴 פעיל' : '🟢 כבוי'}` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'אזהרות') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            const n = parseInt(trimmed.split(' ')[1], 10);
            if (!isNaN(n) && n > 0) {
                settings.warningThreshold = n;
                saveSettings();
                await sock.sendMessage(jid, { text: `📍 סף האזהרות עודכן ל-*${n}*` });
            }
        } catch (e) {}
        return true;
    }

    if (trimmed === 'אפס אזהרות' || trimmed.startsWith('אפס אזהרות ')) {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            const warns = getWarnings(jid);
            const parts = trimmed.split(' ');
            let targetJid = null;
            if (parts.length > 2 && parts[2].startsWith('@')) {
                const phone = parts[2].replace('@', '').replace(/\D/g, '');
                if (phone) targetJid = `${phone}@s.whatsapp.net`;
            }
            if (!targetJid) targetJid = msg.message?.extendedTextMessage?.contextInfo?.participant || null;
            if (!targetJid) {
                await sock.sendMessage(jid, { text: `⚠️ יש להשיב להודעה של המשתמש או לציין @מספר.` });
                return true;
            }
            warns.set(targetJid, 0);
            saveSettings();
            await sock.sendMessage(jid, { text: `✅ אזהרות של @${targetJid.split('@')[0]} אופסו.`, mentions: [targetJid] });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'הרשאות') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            const locked = getLockedSet(jid);
            const lines = LOCKABLE_COMMANDS.map((c, i) => `${i + 1}. ${locked.has(c) ? '🔒' : '🔓'} ${c}`);
            const linkStatus = settings.linkCommandPublic ? '🔓 זמין לכולם' : '🔒 מנהלים בלבד';
            const cds = Object.entries(getCooldowns(jid));
            const cdLine = cds.length
                ? `\n\n⏲️ *פסקי זמן פעילים:*\n${cds.map(([c, m]) => `• ${c} — כל ${m} דק'`).join('\n')}`
                : '';
            await sock.sendMessage(jid, {
                text: `🛡️ *הרשאות קבוצה*\n\n` +
                    `📋 *פקודות כיף (נעל/פתח):*\n${lines.join('\n')}\n\n` +
                    `⚙️ *פקודות ניהול:*\n• קישור — ${linkStatus}${cdLine}\n\n` +
                    `כתוב *נעל [מספר]* / *פתח [מספר]* לנעילת פקודת כיף\n` +
                    `כתוב *קישור מנהלים* / *קישור הכל* לשינוי הרשאת קישור\n` +
                    `כתוב *פסקזמן [פקודה] [דקות]* להגבלת קצב פקודה`
            });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'פסקזמן' || trimmed.startsWith('פסקזמן ')) {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        const rest = trimmed.slice('פסקזמן'.length).trim();
        if (!rest) {
            const cds = Object.entries(getCooldowns(jid));
            const list = cds.length ? cds.map(([c, m]) => `• *${c}* — כל ${m} דק'`).join('\n') : '_(לא הוגדרו פסקי זמן)_';
            await sock.sendMessage(jid, { text: `⏲️ *פסקי זמן לפקודות:*\n${list}\n\nהגדרה: *פסקזמן [שם פקודה] [דקות]*\nלדוגמה: פסקזמן סרט 5\nביטול: *פסקזמן [שם פקודה] 0*` });
            return true;
        }
        const parts = rest.split(/\s+/);
        const minutes = parseInt(parts[parts.length - 1], 10);
        const cmdName = parts.slice(0, -1).join(' ');
        if (!cmdName || isNaN(minutes) || minutes < 0) {
            await sock.sendMessage(jid, { text: '⚠️ כתוב: *פסקזמן [שם פקודה] [דקות]*\nלדוגמה: פסקזמן סרט 5\nלביטול: פסקזמן סרט 0' });
            return true;
        }
        if (!COOLDOWNABLE_COMMANDS.has(cmdName)) {
            await sock.sendMessage(jid, { text: `⚠️ הפקודה *${cmdName}* לא מזוהה. אפשר להגביל פקודות כמו: סרט, סדרה, שיר, תמונה, בדיחות, ראפ, תרגם וכו'.` });
            return true;
        }
        setCommandCooldown(jid, cmdName, minutes);
        await sock.sendMessage(jid, { text: minutes > 0
            ? `⏲️ הפקודה *${cmdName}* מוגבלת כעת לשימוש אחד כל *${minutes} דקות* בקבוצה זו.`
            : `✅ פסק הזמן לפקודה *${cmdName}* בוטל.` });
        return true;
    }

    if (trimmed.startsWith('נעל ') && !isNaN(parseInt(trimmed.split(' ')[1], 10))) {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            const idx = parseInt(trimmed.split(' ')[1], 10) - 1;
            if (idx < 0 || idx >= LOCKABLE_COMMANDS.length) {
                await sock.sendMessage(jid, { text: `⚠️ מספר לא תקין.` });
                return true;
            }
            const cmdName = LOCKABLE_COMMANDS[idx];
            getLockedSet(jid).add(cmdName);
            saveSettings();
            await sock.sendMessage(jid, { text: `🔒 הפקודה *${cmdName}* נעולה.` });
        } catch (e) {}
        return true;
    }

    if (trimmed.startsWith('פתח ') && !isNaN(parseInt(trimmed.split(' ')[1], 10))) {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            const idx = parseInt(trimmed.split(' ')[1], 10) - 1;
            if (idx < 0 || idx >= LOCKABLE_COMMANDS.length) {
                await sock.sendMessage(jid, { text: `⚠️ מספר לא תקין.` });
                return true;
            }
            const cmdName = LOCKABLE_COMMANDS[idx];
            getLockedSet(jid).delete(cmdName);
            saveSettings();
            await sock.sendMessage(jid, { text: `🔓 הפקודה *${cmdName}* פתוחה.` });
        } catch (e) {}
        return true;
    }

    if (trimmed.startsWith('ברוך הבא הגדר ')) {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            const template = trimmed.slice('ברוך הבא הגדר '.length).trim();
            if (!template) {
                await sock.sendMessage(jid, { text: `⚠️ יש לציין תבנית הודעה. השתמש ב-{שם} כמציין מיקום.` });
                return true;
            }
            groupWelcomeTemplates.set(jid, template);
            saveSettings();
            await sock.sendMessage(jid, { text: `✅ תבנית ברוך הבא עודכנה:\n${template}` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'הסרתסטיקרים') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            settings.removeStickerMode = true;
            saveSettings();
            await sock.sendMessage(jid, { text: `🚫 *הסרת סטיקרים פעילה!*` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'בטלהסרתסטיקרים') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            settings.removeStickerMode = false;
            saveSettings();
            await sock.sendMessage(jid, { text: `✅ הסרת סטיקרים בוטלה.` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'סטופסטיקר') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            settings.stopStickerMode = true;
            saveSettings();
            await sock.sendMessage(jid, { text: `🛑 מצב עצירת סטיקרים פעיל.` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'פלייסטיקר') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            settings.stopStickerMode = false;
            saveSettings();
            await sock.sendMessage(jid, { text: `✅ סטיקרים מותרים שוב.` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'הסר קבוצה') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: `❌ הבוט לא מנהל — לא ניתן להסיר משתתפים.` });
                return true;
            }
            const targetJid = msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (!targetJid) {
                await sock.sendMessage(jid, { text: `⚠️ יש להשתמש בפקודה כתגובה להודעה של המשתמש שרוצים להסיר.` });
                return true;
            }
            await sock.groupParticipantsUpdate(jid, [targetJid], 'remove');
            await sock.sendMessage(jid, { text: `✅ @${targetJid.split('@')[0]} הוסר מהקבוצה.`, mentions: [targetJid] });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'מנהלי קבוצה') {
        try {
            const meta = await sock.groupMetadata(jid);
            const admins = meta.participants.filter(p => p.admin);
            const msgText = `👑 *מנהלי הקבוצה (${admins.length}):*\n` + admins.map(a => `@${a.id.split('@')[0]}`).join('\n');
            await sock.sendMessage(jid, { text: msgText, mentions: admins.map(a => a.id) });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'נעל קבוצה') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            await sock.groupSettingUpdate(jid, 'announcement');
            await sock.sendMessage(jid, { text: `🔐 הקבוצה נעולה — רק מנהלים יכולים לשלוח.` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'פתח קבוצה') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            await sock.groupSettingUpdate(jid, 'not_announcement');
            await sock.sendMessage(jid, { text: `🔓 הקבוצה פתוחה לכולם.` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'ברוך הבא') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            settings.welcomeEnabled = !settings.welcomeEnabled;
            saveSettings();
            await sock.sendMessage(jid, { text: `👋 הודעת ברוך הבא ${settings.welcomeEnabled ? 'הופעלה ✅' : 'כובתה ❌'}` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'קישור מנהלים') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        settings.linkCommandPublic = false;
        saveSettings();
        await sock.sendMessage(jid, { text: `🔒 פקודת *קישור* זמינה למנהלים בלבד.` });
        return true;
    }

    if (trimmed === 'קישור הכל') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        settings.linkCommandPublic = true;
        saveSettings();
        await sock.sendMessage(jid, { text: `🔓 פקודת *קישור* זמינה לכולם.` });
        return true;
    }

    if (trimmed === 'קישור') {
        if (!settings.linkCommandPublic && !isAdmin) {
            await sock.sendMessage(jid, { text: `🔒 פקודת קישור זמינה למנהלים בלבד.` });
            return true;
        }
        try {
            const inv = await sock.groupInviteCode(jid);
            await sock.sendMessage(jid, { text: `🔗 *קישור לקבוצה:*\nhttps://chat.whatsapp.com/${inv}` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'ניהול') {
        if (!isAdmin) { await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` }); return true; }
        try {
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: `❌ הבוט לא מנהל — לא ניתן לבצע פעולה זו.` });
                return true;
            }
            const targetJid = msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (!targetJid) {
                await sock.sendMessage(jid, { text: `⚠️ יש להשתמש בפקודה כתגובה להודעה.` });
                return true;
            }
            await sock.groupParticipantsUpdate(jid, [targetJid], 'promote');
            await sock.sendMessage(jid, { text: `✅ @${targetJid.split('@')[0]} קודם למנהל!`, mentions: [targetJid] });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'קידומת חסומים') {
        try {
            const { removeLinks, removeStickerMode, warningThreshold: threshold } = settings;
            await sock.sendMessage(jid, {
                text: `🛡️ *הגנת קבוצה:*\nמצב הסרת קישורים: ${removeLinks ? '🔴 פעיל' : '⚪ כבוי'}\nמצב הסרת סטיקרים: ${removeStickerMode ? '🔴 פעיל' : '⚪ כבוי'}\nסף אזהרות: ${threshold}\n\nפקודות:\n• הסרתקישורים\n• בטלהסרתקישורים\n• הסרתסטיקרים\n• אזהרות [מספר]`
            });
        } catch (e) {}
        return true;
    }

    return false;
}

async function handleAutoModeration(sock, msg, jid, senderJid, isBotAdmin, isSenderAdmin) {
    if (!isBotAdmin) return false;
    const settings = getSettings(jid);
    const msgContent = msg.message;

    if (settings.removeLinks && !isSenderAdmin && !isGlobalAdmin(senderJid)) {
        const text = msgContent?.conversation || msgContent?.extendedTextMessage?.text || msgContent?.imageMessage?.caption || '';
        const hasLink = /https?:\/\/|wa\.me\/|t\.me\/|bit\.ly/i.test(text);
        if (hasLink) {
            await sock.sendMessage(jid, { delete: msg.key });
            settings.linkStats++;
            const warns = getWarnings(jid);
            const count = (warns.get(senderJid) || 0) + 1;
            warns.set(senderJid, count);
            saveSettings();
            if (count >= settings.warningThreshold) {
                warns.delete(senderJid);
                saveSettings();
                await sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
                await sock.sendMessage(jid, { text: `⛔ @${senderJid.split('@')[0]} הוסר מהקבוצה לאחר ${settings.warningThreshold} אזהרות.`, mentions: [senderJid] });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ @${senderJid.split('@')[0]} אזהרה ${count}/${settings.warningThreshold} — קישורים אסורים בקבוצה!`, mentions: [senderJid] });
            }
            return true;
        }
    }

    if (settings.removeStickerMode && msgContent?.stickerMessage) {
        await sock.sendMessage(jid, { delete: msg.key });
        const warns = getWarnings(jid);
        const count = (warns.get(senderJid) || 0) + 1;
        warns.set(senderJid, count);
        saveSettings();
        if (count >= settings.warningThreshold) {
            warns.delete(senderJid);
            saveSettings();
            await sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
            await sock.sendMessage(jid, { text: `⛔ @${senderJid.split('@')[0]} הוסר מהקבוצה לאחר ${settings.warningThreshold} אזהרות.`, mentions: [senderJid] });
        } else {
            await sock.sendMessage(jid, { text: `⚠️ @${senderJid.split('@')[0]} אזהרה ${count}/${settings.warningThreshold} — סטיקרים אסורים בקבוצה!`, mentions: [senderJid] });
        }
        return true;
    }

    if (settings.stopStickerMode && msgContent?.stickerMessage) {
        await sock.sendMessage(jid, { delete: msg.key });
        const warns = getWarnings(jid);
        const count = (warns.get(senderJid) || 0) + 1;
        warns.set(senderJid, count);
        saveSettings();
        if (count >= settings.warningThreshold) {
            warns.delete(senderJid);
            saveSettings();
            await sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
            await sock.sendMessage(jid, { text: `⛔ @${senderJid.split('@')[0]} הוסר מהקבוצה לאחר ${settings.warningThreshold} אזהרות.`, mentions: [senderJid] });
        } else {
            await sock.sendMessage(jid, { text: `⚠️ @${senderJid.split('@')[0]} אזהרה ${count}/${settings.warningThreshold} — סטיקרים אסורים בקבוצה!`, mentions: [senderJid] });
        }
        return true;
    }

    return false;
}

async function handleWelcome(sock, jid, participants) {
    const settings = getSettings(jid);
    console.log(`👋 handleWelcome: jid=${jid.slice(-10)} participants=${participants.length} enabled=${settings.welcomeEnabled}`);
    if (!settings.welcomeEnabled) return;
    const template = groupWelcomeTemplates.get(jid) || null;
    for (const p of participants) {
        const mention = `@${p.split('@')[0]}`;
        const text = template
            ? template.replace(/\{שם\}/g, mention)
            : `👋 *ברוך הבא לקבוצה!* 🎉\n${mention}\nשמחים שהצטרפת! 😊`;
        await sock.sendMessage(jid, { text, mentions: [p] });
    }
}

function blockMatchmaking(gid, jid) {
    if (!matchmakingBlocked.has(gid)) matchmakingBlocked.set(gid, new Set());
    matchmakingBlocked.get(gid).add(jid);
    saveSettings();
}
function unblockMatchmaking(gid, jid) {
    matchmakingBlocked.get(gid)?.delete(jid);
    saveSettings();
}
function isMatchmakingBlocked(gid, jid) {
    return matchmakingBlocked.get(gid)?.has(jid) || false;
}

module.exports = { handleAdminCommand, handleAutoModeration, handleWelcome, isCommandLocked, isPremiumEnabled, checkDailyLimit, incrementDailyCount, blockMatchmaking, unblockMatchmaking, isMatchmakingBlocked, checkCommandCooldown, markCommandUsed };
