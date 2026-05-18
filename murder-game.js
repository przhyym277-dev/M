'use strict';

const games = new Map(); // groupJid → game

function normJ(jid) { return (jid || '').replace(/:.*@/, '@'); }

function getByGroup(jid) { return games.get(jid); }

function getByMurderer(jid) {
    const n = normJ(jid);
    for (const g of games.values()) {
        if (g.phase === 'night' && g.murdererJid === n) return g;
    }
    return null;
}

function getByPlayer(jid) {
    const n = normJ(jid);
    for (const g of games.values()) {
        if (g.players.some(p => p.jid === n)) return g;
    }
    return null;
}

function endGame(groupJid) {
    const g = games.get(groupJid);
    if (g?.phaseTimer) clearTimeout(g.phaseTimer);
    games.delete(groupJid);
}

async function startNight(sock, groupJid) {
    const game = games.get(groupJid);
    if (!game) return;
    game.phase = 'night';

    const idx = Math.floor(Math.random() * game.players.length);
    game.murdererJid = game.players[idx].jid;
    game.players.forEach(p => { p.role = p.jid === game.murdererJid ? 'murderer' : 'citizen'; });

    for (const p of game.players) {
        try {
            if (p.role === 'murderer') {
                await sock.sendMessage(p.jid, { text: `🔪 *אתה הרוצח!*\n\nהשחקנים:\n${game.players.map((pl, i) => `${i + 1}. ${pl.name}`).join('\n')}\n\nשלח לי בפרטי:\n*הרג [שם]*\n\nיש לך 2 דקות!` });
            } else {
                await sock.sendMessage(p.jid, { text: `👮 *אתה אזרח!*\n\nמצא את הרוצח בין:\n${game.players.map(pl => `• ${pl.name}`).join('\n')}\n\nצבע בקבוצה: *הצבע [שם]*` });
            }
        } catch (e) {
            console.error(`murder DM failed ${p.jid}:`, e.message?.slice(0, 60));
        }
    }

    const names = game.players.map(p => `• ${p.name}`).join('\n');
    await sock.sendMessage(groupJid, { text: `🌙 *הלילה ירד על הכפר...*\n\nהשחקנים:\n${names}\n\n😴 הרוצח מתכנן...\n_(לא קיבלת הודעה? שלח לבוט בפרטי: *תפקיד*)_` });

    game.phaseTimer = setTimeout(() => processNightEnd(sock, groupJid), 2 * 60 * 1000);
}

async function processNightEnd(sock, groupJid) {
    const game = games.get(groupJid);
    if (!game || game.phase !== 'night') return;
    if (!game.victimJid) {
        const alive = game.players.filter(p => p.alive && p.jid !== game.murdererJid);
        if (!alive.length) { endGame(groupJid); return; }
        game.victimJid = alive[Math.floor(Math.random() * alive.length)].jid;
    }
    await morning(sock, groupJid);
}

async function morning(sock, groupJid) {
    const game = games.get(groupJid);
    if (!game) return;
    game.phase = 'day';

    const victim = game.players.find(p => p.jid === game.victimJid);
    if (!victim) { endGame(groupJid); return; }
    victim.alive = false;

    const murderer = game.players.find(p => p.jid === game.murdererJid);
    const aliveCount = game.players.filter(p => p.alive).length;

    await sock.sendMessage(groupJid, { text: `🌅 *בוקר בכפר*\n\n💀 *${victim.name} נמצא מת הלילה!*` });

    if (aliveCount <= 1) {
        await sock.sendMessage(groupJid, { text: `😈 *הרוצח ניצח!*\nנשאר רק ${aliveCount} — הכפר לא שרד.\nהרוצח היה: *${murderer?.name}*` });
        endGame(groupJid); return;
    }

    await sock.sendMessage(groupJid, { text: `🗣️ *יש לכם 90 שניות לדון!*\nמי לדעתכם הרוצח? אחכ: *הצבע [שם]*` });
    game.phaseTimer = setTimeout(() => startVote(sock, groupJid), 90 * 1000);
}

async function startVote(sock, groupJid) {
    const game = games.get(groupJid);
    if (!game || game.phase !== 'day') return;
    game.phase = 'vote';
    game.votes.clear();

    const alive = game.players.filter(p => p.alive);
    const list = alive.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    await sock.sendMessage(groupJid, { text: `🗳️ *זמן הצבעה!* (60 שניות)\n\nחשודים:\n${list}\n\nכתבו: *הצבע [שם]*` });

    game.phaseTimer = setTimeout(() => tally(sock, groupJid), 60 * 1000);
}

async function tally(sock, groupJid) {
    const game = games.get(groupJid);
    if (!game || game.phase !== 'vote') return;

    const counts = {};
    for (const s of game.votes.values()) {
        const k = s.trim().toLowerCase();
        counts[k] = (counts[k] || 0) + 1;
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const murderer = game.players.find(p => p.jid === game.murdererJid);
    const mName = (murderer?.name || '').toLowerCase();

    let result = `📊 *תוצאות ההצבעה:*\n`;
    if (!sorted.length) {
        result += `_(אף אחד לא הצביע)_\n`;
    } else {
        for (const [name, count] of sorted) result += `• ${name}: ${count} קולות\n`;
    }

    const top = sorted[0]?.[0] || '';
    const caught = top && (mName.includes(top) || top.includes(mName));
    result += caught
        ? `\n🎉 *האזרחים ניצחו!* הרוצח היה: *${murderer?.name}* 🏆`
        : `\n😈 *הרוצח ניצח!* הרוצח האמיתי היה: *${murderer?.name}* 💀`;

    await sock.sendMessage(groupJid, { text: result });
    endGame(groupJid);
}

module.exports = { games, normJ, getByGroup, getByMurderer, getByPlayer, endGame, startNight, processNightEnd, morning };
