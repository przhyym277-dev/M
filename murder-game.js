'use strict';

// Shared state for murder mystery game across group and private handlers
const games = new Map(); // groupJid → game

// game shape:
// { groupJid, phase: 'joining'|'night'|'day'|'vote'|'ended',
//   players: [{jid, name, alive, role}],
//   murdererJid, victimJid,
//   votes: Map(voterJid → suspectName),
//   initiatorJid, sock, phaseTimer }

function getByGroup(jid) { return games.get(jid); }

function getByMurderer(jid) {
    for (const g of games.values()) {
        if (g.phase === 'night' && g.murdererJid === jid) return g;
    }
    return null;
}

function getByPlayer(jid) {
    for (const g of games.values()) {
        if (g.players.some(p => normJ(p.jid) === normJ(jid))) return g;
    }
    return null;
}

function normJ(jid) { return (jid || '').replace(/:.*@/, '@'); }

function endGame(groupJid) {
    const g = games.get(groupJid);
    if (g?.phaseTimer) clearTimeout(g.phaseTimer);
    games.delete(groupJid);
}

module.exports = { games, getByGroup, getByMurderer, getByPlayer, endGame, normJ };
