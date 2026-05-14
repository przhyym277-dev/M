'use strict';

const { handleFunCommand } = require('./group-commands');
const { handleAdminCommand, handleAutoModeration, handleWelcome } = require('./group-admin');

function getGroupText(msg) {
    return msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
}

async function handleGroupMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    const text = getGroupText(msg).trim();
    const senderJid = msg.key.participant || msg.participant || '';

    if (!text && !msg.message?.audioMessage && !msg.message?.stickerMessage) return;

    let isSenderAdmin = false;
    let isBotAdmin = false;
    let groupParticipants = [];
    try {
        const meta = await sock.groupMetadata(jid);
        const botJid = sock.user?.id?.replace(/:.*@/, '@') || '';
        isSenderAdmin = meta.participants.some(p => p.id === senderJid && p.admin);
        isBotAdmin    = meta.participants.some(p => p.id === botJid   && p.admin);
        groupParticipants = meta.participants.map(p => p.id);
    } catch {}

    const moderated = await handleAutoModeration(sock, msg, jid, senderJid, isBotAdmin);
    if (moderated) return;

    if (!text) return;

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
