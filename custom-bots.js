'use strict';

require('dotenv').config();
const https = require('https');

const RENDER_SERVICE_ID = 'srv-d7usaljtqb8s73csmle0';

function loadJSON(key, fallback) {
    try { return JSON.parse(process.env[key] || 'null') || fallback; } catch { return fallback; }
}

const customBots = loadJSON('CUSTOM_BOTS_DATA', {});

function renderApiRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = https.request({
            hostname: 'api.render.com',
            path,
            method,
            headers: {
                'Authorization': `Bearer ${process.env.RENDER_API_KEY}`,
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
            }
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function save() {
    const value = JSON.stringify(customBots);
    try {
        const arr = await renderApiRequest('GET', `/v1/services/${RENDER_SERVICE_ID}/env-vars`);
        const merged = (Array.isArray(arr) ? arr : [])
            .map(e => ({ key: e.envVar.key, value: e.envVar.value }))
            .filter(e => e.key !== 'CUSTOM_BOTS_DATA');
        merged.push({ key: 'CUSTOM_BOTS_DATA', value });
        await renderApiRequest('PUT', `/v1/services/${RENDER_SERVICE_ID}/env-vars`, merged);
        process.env.CUSTOM_BOTS_DATA = value;
    } catch (e) {
        console.error('custom-bots save error:', e.message);
    }
}

function normalizePhone(phone) {
    if (phone.startsWith('0')) return '972' + phone.slice(1);
    return phone;
}

function findByJid(jid) {
    if (customBots[jid]) return customBots[jid];
    const num = jid.split('@')[0].replace(/\D/g, '');
    const entry = Object.entries(customBots).find(([k, v]) => {
        const stored = normalizePhone(v.phone || k.split('@')[0]).replace(/\D/g, '');
        return num.endsWith(stored) || stored.endsWith(num);
    });
    return entry ? entry[1] : null;
}

function set(phone, prompt) {
    const jid = normalizePhone(phone) + '@s.whatsapp.net';
    customBots[jid] = { prompt, phone };
    return jid;
}

function remove(phone) {
    const jid = normalizePhone(phone) + '@s.whatsapp.net';
    if (customBots[jid]) { delete customBots[jid]; return true; }
    // fallback by phone digits
    const num = normalizePhone(phone).replace(/\D/g, '');
    const key = Object.keys(customBots).find(k => k.split('@')[0].replace(/\D/g,'') === num);
    if (key) { delete customBots[key]; return true; }
    return false;
}

function list() {
    return Object.entries(customBots).map(([jid, b]) => ({ jid, phone: b.phone || jid.split('@')[0], prompt: b.prompt }));
}

module.exports = { findByJid, set, remove, list, save, normalizePhone };
