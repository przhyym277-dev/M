'use strict';

const groupSettings = new Map();
const warnings = new Map();

function getSettings(gid) {
    if (!groupSettings.has(gid)) groupSettings.set(gid, { removeLinks: false, removeStickerMode: false, stopStickerMode: false, welcomeEnabled: false, warningThreshold: 3, linkStats: 0 });
    return groupSettings.get(gid);
}

function getWarnings(gid) {
    if (!warnings.has(gid)) warnings.set(gid, new Map());
    return warnings.get(gid);
}

async function handleAdminCommand(sock, msg, jid, text, senderJid, isSenderAdmin, isBotAdmin) {
    const settings = getSettings(jid);
    const cmd = text.trim().split(' ')[0];

    if (cmd === '!הסרתקישורים') {
        try {
            settings.removeLinks = true;
            const threshold = settings.warningThreshold;
            await sock.sendMessage(jid, { text: `🔗 *הסרת קישורים פעילה!*\nקישורים יוסרו אוטומטית. אזהרה ${threshold} → הסרה מהקבוצה.` });
        } catch (e) {}
        return true;
    }

    if (cmd === '!בטלהסרתקישורים') {
        try {
            settings.removeLinks = false;
            await sock.sendMessage(jid, { text: `✅ הסרת קישורים בוטלה.` });
        } catch (e) {}
        return true;
    }

    if (cmd === '!קישורים') {
        try {
            await sock.sendMessage(jid, { text: `📊 *סטטיסטיקת קישורים:*\nקישורים שהוסרו: ${settings.linkStats}\nמצב: ${settings.removeLinks ? '🔴 פעיל' : '🟢 כבוי'}` });
        } catch (e) {}
        return true;
    }

    if (cmd === '!אזהרות') {
        try {
            const parts = text.trim().split(' ');
            const n = parseInt(parts[1], 10);
            if (!isNaN(n) && n > 0) {
                settings.warningThreshold = n;
                await sock.sendMessage(jid, { text: `📍 סף האזהרות עודכן ל-*${n}*` });
            }
        } catch (e) {}
        return true;
    }

    if (cmd === '!הסרתסטיקרים') {
        try {
            settings.removeStickerMode = true;
            await sock.sendMessage(jid, { text: `🚫 *הסרת סטיקרים פעילה!*` });
        } catch (e) {}
        return true;
    }

    if (cmd === '!בטלהסרתסטיקרים') {
        try {
            settings.removeStickerMode = false;
            await sock.sendMessage(jid, { text: `✅ הסרת סטיקרים בוטלה.` });
        } catch (e) {}
        return true;
    }

    if (cmd === '!סטופסטיקר') {
        try {
            settings.stopStickerMode = true;
            await sock.sendMessage(jid, { text: `🛑 מצב עצירת סטיקרים פעיל.` });
        } catch (e) {}
        return true;
    }

    if (cmd === '!פלייסטיקר') {
        try {
            settings.stopStickerMode = false;
            await sock.sendMessage(jid, { text: `✅ סטיקרים מותרים שוב.` });
        } catch (e) {}
        return true;
    }

    if (text.trim() === '!מנהלי קבוצה') {
        try {
            const meta = await sock.groupMetadata(jid);
            const admins = meta.participants.filter(p => p.admin);
            const msgText = `👑 *מנהלי הקבוצה (${admins.length}):*\n` + admins.map(a => `@${a.id.split('@')[0]}`).join('\n');
            await sock.sendMessage(jid, { text: msgText, mentions: admins.map(a => a.id) });
        } catch (e) {}
        return true;
    }

    if (text.trim() === '!נעל קבוצה') {
        try {
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
            await sock.groupSettingUpdate(jid, 'announcement');
            await sock.sendMessage(jid, { text: `🔐 הקבוצה נעולה — רק מנהלים יכולים לשלוח.` });
        } catch (e) {}
        return true;
    }

    if (text.trim() === '!פתח קבוצה') {
        try {
            if (!isSenderAdmin) {
                await sock.sendMessage(jid, { text: `🚫 רק מנהלים יכולים להשתמש בפקודה זו.` });
                return true;
            }
            await sock.groupSettingUpdate(jid, 'not_announcement');
            await sock.sendMessage(jid, { text: `🔓 הקבוצה פתוחה לכולם.` });
        } catch (e) {}
        return true;
    }

    if (text.trim() === '!ברוך הבא') {
        try {
            settings.welcomeEnabled = !settings.welcomeEnabled;
            const enabled = settings.welcomeEnabled;
            await sock.sendMessage(jid, { text: `👋 הודעת ברוך הבא ${enabled ? 'הופעלה ✅' : 'כובתה ❌'}` });
        } catch (e) {}
        return true;
    }

    if (text.trim() === '!קישור') {
        try {
            const inv = await sock.groupInviteCode(jid);
            await sock.sendMessage(jid, { text: `🔗 *קישור לקבוצה:*\nhttps://chat.whatsapp.com/${inv}` });
        } catch (e) {}
        return true;
    }

    if (text.trim() === '!ניהול') {
        try {
            if (!isSenderAdmin) {
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

    if (text.trim() === '!קידומת חסומים') {
        try {
            const { removeLinks, removeStickerMode, warningThreshold: threshold } = settings;
            await sock.sendMessage(jid, {
                text: `🛡️ *הגנת קידומת:*\nמצב הסרת קישורים: ${removeLinks ? '🔴 פעיל' : '⚪ כבוי'}\nמצב הסרת סטיקרים: ${removeStickerMode ? '🔴 פעיל' : '⚪ כבוי'}\nסף אזהרות: ${threshold}\n\nפקודות:\n• !הסרתקישורים\n• !בטלהסרתקישורים\n• !הסרתסטיקרים\n• !אזהרות [מספר]`
            });
        } catch (e) {}
        return true;
    }

    return false;
}

async function handleAutoModeration(sock, msg, jid, senderJid, isBotAdmin) {
    if (!isBotAdmin) return false;
    const settings = getSettings(jid);
    const msgContent = msg.message;

    if (settings.removeLinks) {
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
        return true;
    }

    if (settings.stopStickerMode && msgContent?.stickerMessage) {
        await sock.sendMessage(jid, { delete: msg.key });
        return true;
    }

    return false;
}

async function handleWelcome(sock, jid, participants) {
    const settings = getSettings(jid);
    if (!settings.welcomeEnabled) return;
    for (const p of participants) {
        await sock.sendMessage(jid, {
            text: `👋 *ברוך הבא לקבוצה!* 🎉\n@${p.split('@')[0]}\nשמחים שהצטרפת! 😊`,
            mentions: [p]
        });
    }
}

module.exports = { handleAdminCommand, handleAutoModeration, handleWelcome };
