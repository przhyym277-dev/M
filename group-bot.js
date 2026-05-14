'use strict';

const { handleFunCommand, addToHistory } = require('./group-commands');
const { handleAdminCommand, handleAutoModeration, handleWelcome } = require('./group-admin');
const customBotsModule = require('./custom-bots');

const OWNER_PHONE = (process.env.OWNER_PHONE || '').replace(/\D/g, '');
const OWNER_LID   = (process.env.OWNER_LID   || '').replace(/\D/g, '');
function isOwnerJid(jid) {
    const num = jid.split('@')[0].replace(/\D/g, '');
    return num === OWNER_PHONE || num === OWNER_LID;
}

function getGroupText(msg) {
    return msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
}

const normJid = (id) => (id || '').replace(/:.*@/, '@');

async function handleGroupMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    const text = getGroupText(msg).trim();
    const senderJid = normJid(msg.key.participant || msg.participant || '');

    console.log(`👥 [קבוצה] ${jid.split('@')[0].slice(-6)} | ${msg.pushName || senderJid.split('@')[0]}: ${text || '[מדיה]'}`);

    if (!text && !msg.message?.audioMessage && !msg.message?.stickerMessage) return;

    let isSenderAdmin = false;
    let isBotAdmin = false;
    let groupParticipants = [];
    try {
        const meta = await sock.groupMetadata(jid);
        const botRawId = sock.user?.id || '';
        const botJid = normJid(botRawId);
        const botPhone = (process.env.OWNER_PHONE || '').replace(/\D/g, '');
        const botLid   = (process.env.OWNER_LID   || '').replace(/\D/g, '');
        isSenderAdmin = meta.participants.some(p => normJid(p.id) === senderJid && p.admin);
        isBotAdmin    = meta.participants.some(p => {
            const pid = normJid(p.id);
            const num = pid.replace(/\D/g, '');
            return p.admin && (pid === botJid || num === botPhone || num === botLid);
        });
        groupParticipants = meta.participants.map(p => normJid(p.id));
        console.log(`🔍 senderJid=${senderJid} isSenderAdmin=${isSenderAdmin} botJid=${botJid} isBotAdmin=${isBotAdmin}`);
    } catch {}

    const moderated = await handleAutoModeration(sock, msg, jid, senderJid, isBotAdmin);
    if (moderated) return;

    if (!text) return;

    if (text) addToHistory(jid, msg.pushName || senderJid.split('@')[0], text);

    // Owner-only commands usable from the group
    if (isOwnerJid(senderJid)) {
        const botSetMatch = text.match(/^בוט\s+([0-9]+)\s+([\s\S]+)/);
        if (botSetMatch) {
            customBotsModule.set(botSetMatch[1], botSetMatch[2].trim());
            await customBotsModule.save();
            await sock.sendMessage(jid, { text: `✅ בוט אישי נוצר עבור ${botSetMatch[1]}` });
            return;
        }
        const botRemoveMatch = text.match(/^בטל בוט\s+([0-9]+)$/);
        if (botRemoveMatch) {
            const removed = customBotsModule.remove(botRemoveMatch[1]);
            await customBotsModule.save();
            await sock.sendMessage(jid, { text: removed ? `✅ בוט של ${botRemoveMatch[1]} בוטל.` : `❌ לא נמצא בוט ל-${botRemoveMatch[1]}` });
            return;
        }
        if (text === 'בוטים') {
            const entries = customBotsModule.list();
            if (entries.length === 0) {
                await sock.sendMessage(jid, { text: '🤖 אין בוטים אישיים פעילים.' });
            } else {
                const lines = entries.map(b => `📱 *${b.phone}*\n_${b.prompt.slice(0, 80)}..._`);
                await sock.sendMessage(jid, { text: `🤖 *בוטים אישיים (${entries.length}):*\n\n${lines.join('\n\n')}` });
            }
            return;
        }
    }

    const funHandled = await handleFunCommand(sock, msg, jid, text, msg.pushName || '', groupParticipants);
    if (funHandled) return;

    await handleAdminCommand(sock, msg, jid, text, senderJid, isSenderAdmin, isBotAdmin);
}

async function handleGroupParticipantUpdate(sock, id, participants, action) {
    if (action === 'add') {
        try { await handleWelcome(sock, id, participants); } catch {}
    }
}

module.exports = { handleGroupMessage, handleGroupParticipantUpdate };
