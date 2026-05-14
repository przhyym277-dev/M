'use strict';

const groupSettings = new Map();
const warnings = new Map();
const lockedCommands = new Map();
const groupWelcomeTemplates = new Map();

const GLOBAL_SUPER_ADMINS = new Set(['972522091733', '972508181322']);

const LOCKABLE_COMMANDS = ['בדיחות','טיפ','עובדה','ציטוט','טריוויה','חידה','נכון או אמת','מזל','שידוך','רולטה','ראפ','תרגם','מחמאה','עלבון','מתכון','תרגיל','מילה','שיר','סקר','הצבעה','אנונימי','תזכורת','ספירה','סיכום','מי אמר','גימטריה','הגרלה','חשב','חזור','qr','תמלל','פרופיל'];

function isGlobalAdmin(senderJid) {
    const phone = senderJid.split('@')[0];
    return GLOBAL_SUPER_ADMINS.has(phone);
}

function isCommandLocked(gid, cmdName) {
    const locked = lockedCommands.get(gid);
    if (!locked) return false;
    return locked.has(cmdName);
}

function getSettings(gid) {
    if (!groupSettings.has(gid)) groupSettings.set(gid, { removeLinks: false, removeStickerMode: false, stopStickerMode: false, welcomeEnabled: false, warningThreshold: 3, linkStats: 0 });
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

async function handleAdminCommand(sock, msg, jid, text, senderJid, isSenderAdmin, isBotAdmin) {
    const settings = getSettings(jid);
    const trimmed = text.trim();
    const cmd = trimmed.split(' ')[0];
    const isAdmin = isSenderAdmin || isGlobalAdmin(senderJid);

    if (cmd === 'הסרתקישורים') {
        try {
            settings.removeLinks = true;
            const threshold = settings.warningThreshold;
            await sock.sendMessage(jid, { text: `🔗 *הסרת קישורים פעילה!*\nקישורים יוסרו אוטומטית. אזהרה ${threshold} → הסרה מהקבוצה.` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'בטלהסרתקישורים') {
        try {
            settings.removeLinks = false;
            await sock.sendMessage(jid, { text: `✅ הסרת קישורים בוטלה.` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'קישורים') {
        try {
            await sock.sendMessage(jid, { text: `📊 *סטטיסטיקת קישורים:*\nקישורים שהוסרו: ${settings.linkStats}\nמצב: ${settings.removeLinks ? '🔴 פעיל' : '🟢 כבוי'}` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'אזהרות') {
        try {
            const parts = trimmed.split(' ');
            const n = parseInt(parts[1], 10);
            if (!isNaN(n) && n > 0) {
                settings.warningThreshold = n;
                await sock.sendMessage(jid, { text: `📍 סף האזהרות עודכן ל-*${n}*` });
            }
        } catch (e) {}
        return true;
    }

    if (trimmed === 'אפס אזהרות' || trimmed.startsWith('אפס אזהרות ')) {
        try {
            if (!isAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
            const warns = getWarnings(jid);
            const parts = trimmed.split(' ');
            let targetJid = null;
            if (parts.length > 2 && parts[2].startsWith('@')) {
                const phone = parts[2].replace('@', '').replace(/\D/g, '');
                if (phone) targetJid = `${phone}@s.whatsapp.net`;
            }
            if (!targetJid) {
                targetJid = msg.message?.extendedTextMessage?.contextInfo?.participant || null;
            }
            if (!targetJid) {
                await sock.sendMessage(jid, { text: `⚠️ יש להשיב להודעה של המשתמש או לציין @מספר.` });
                return true;
            }
            warns.set(targetJid, 0);
            await sock.sendMessage(jid, { text: `✅ אזהרות של @${targetJid.split('@')[0]} אופסו.`, mentions: [targetJid] });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'הרשאות') {
        try {
            const locked = getLockedSet(jid);
            const lines = LOCKABLE_COMMANDS.map((c, i) => `${i + 1}. ${locked.has(c) ? '🔒' : '🔓'} ${c}`);
            await sock.sendMessage(jid, { text: `🛡️ *פקודות ניתנות לנעילה:*\n${lines.join('\n')}\n\nכתוב *נעל [מספר]* או *פתח [מספר]* לשינוי.` });
        } catch (e) {}
        return true;
    }

    if (trimmed.startsWith('נעל ') && !isNaN(parseInt(trimmed.split(' ')[1], 10))) {
        try {
            if (!isAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
            const idx = parseInt(trimmed.split(' ')[1], 10) - 1;
            if (idx < 0 || idx >= LOCKABLE_COMMANDS.length) {
                await sock.sendMessage(jid, { text: `⚠️ מספר לא תקין.` });
                return true;
            }
            const cmdName = LOCKABLE_COMMANDS[idx];
            getLockedSet(jid).add(cmdName);
            await sock.sendMessage(jid, { text: `🔒 הפקודה *${cmdName}* נעולה.` });
        } catch (e) {}
        return true;
    }

    if (trimmed.startsWith('פתח ') && !isNaN(parseInt(trimmed.split(' ')[1], 10))) {
        try {
            if (!isAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
            const idx = parseInt(trimmed.split(' ')[1], 10) - 1;
            if (idx < 0 || idx >= LOCKABLE_COMMANDS.length) {
                await sock.sendMessage(jid, { text: `⚠️ מספר לא תקין.` });
                return true;
            }
            const cmdName = LOCKABLE_COMMANDS[idx];
            getLockedSet(jid).delete(cmdName);
            await sock.sendMessage(jid, { text: `🔓 הפקודה *${cmdName}* פתוחה.` });
        } catch (e) {}
        return true;
    }

    if (trimmed.startsWith('ברוך הבא הגדר ')) {
        try {
            if (!isAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
            const template = trimmed.slice('ברוך הבא הגדר '.length).trim();
            if (!template) {
                await sock.sendMessage(jid, { text: `⚠️ יש לציין תבנית הודעה. השתמש ב-{שם} כמציין מיקום.` });
                return true;
            }
            groupWelcomeTemplates.set(jid, template);
            await sock.sendMessage(jid, { text: `✅ תבנית ברוך הבא עודכנה:\n${template}` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'הסרתסטיקרים') {
        try {
            settings.removeStickerMode = true;
            await sock.sendMessage(jid, { text: `🚫 *הסרת סטיקרים פעילה!*` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'בטלהסרתסטיקרים') {
        try {
            settings.removeStickerMode = false;
            await sock.sendMessage(jid, { text: `✅ הסרת סטיקרים בוטלה.` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'סטופסטיקר') {
        try {
            settings.stopStickerMode = true;
            await sock.sendMessage(jid, { text: `🛑 מצב עצירת סטיקרים פעיל.` });
        } catch (e) {}
        return true;
    }

    if (cmd === 'פלייסטיקר') {
        try {
            settings.stopStickerMode = false;
            await sock.sendMessage(jid, { text: `✅ סטיקרים מותרים שוב.` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'הסר קבוצה') {
        try {
            if (!isAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
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
        try {
            if (!isAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
            await sock.groupSettingUpdate(jid, 'announcement');
            await sock.sendMessage(jid, { text: `🔐 הקבוצה נעולה — רק מנהלים יכולים לשלוח.` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'פתח קבוצה') {
        try {
            if (!isAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
            await sock.groupSettingUpdate(jid, 'not_announcement');
            await sock.sendMessage(jid, { text: `🔓 הקבוצה פתוחה לכולם.` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'ברוך הבא') {
        try {
            settings.welcomeEnabled = !settings.welcomeEnabled;
            const enabled = settings.welcomeEnabled;
            await sock.sendMessage(jid, { text: `👋 הודעת ברוך הבא ${enabled ? 'הופעלה ✅' : 'כובתה ❌'}` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'קישור') {
        try {
            const inv = await sock.groupInviteCode(jid);
            await sock.sendMessage(jid, { text: `🔗 *קישור לקבוצה:*\nhttps://chat.whatsapp.com/${inv}` });
        } catch (e) {}
        return true;
    }

    if (trimmed === 'ניהול') {
        try {
            if (!isAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
            if (!isBotAdmin) {
                await sock.sendMessage(jid, { text: `❌ הבוט לא מנהל — לא ניתן לבצע פעולה זו.` });
                return true;
            }
            const targetJid = msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (!targetJid) {
                await sock.sendMessage(jid, { text: `⚠️ יש להשתמש בפקודה כתגובה להודעה.` });
                return true;
            }
            const target = targetJid.split('@')[0];
            await sock.groupParticipantsUpdate(jid, [targetJid], 'promote');
            await sock.sendMessage(jid, { text: `✅ @${target} קודם למנהל!`, mentions: [targetJid] });
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
            if (count >= settings.warningThreshold) {
                warns.delete(senderJid);
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
        if (count >= settings.warningThreshold) {
            warns.delete(senderJid);
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
        if (count >= settings.warningThreshold) {
            warns.delete(senderJid);
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
    if (!settings.welcomeEnabled) return;
    const template = groupWelcomeTemplates.get(jid) || null;
    for (const p of participants) {
        const mention = `@${p.split('@')[0]}`;
        let text;
        if (template) {
            text = template.replace(/\{שם\}/g, mention);
        } else {
            text = `👋 *ברוך הבא לקבוצה!* 🎉\n${mention}\nשמחים שהצטרפת! 😊`;
        }
        await sock.sendMessage(jid, { text, mentions: [p] });
    }
}

module.exports = { handleAdminCommand, handleAutoModeration, handleWelcome, isCommandLocked };
