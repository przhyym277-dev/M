'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const binDir = path.join(__dirname, '..', 'node_modules', 'youtube-dl-exec', 'bin');
const binPath = path.join(binDir, 'yt-dlp');

if (fs.existsSync(binPath) && fs.statSync(binPath).size > 1000) {
    console.log('yt-dlp already installed');
    process.exit(0);
}

const isWin = process.platform === 'win32';
const url = isWin
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
const dest = isWin ? binPath + '.exe' : binPath;

console.log(`Downloading yt-dlp from ${url}...`);

if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

function download(url, dest, redirects = 0) {
    if (redirects > 5) { console.error('Too many redirects'); process.exit(1); }
    https.get(url, { headers: { 'User-Agent': 'nodejs' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return download(res.headers.location, dest, redirects + 1);
        }
        if (res.statusCode !== 200) {
            console.error(`Failed: HTTP ${res.statusCode}`);
            process.exit(1);
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
            file.close();
            if (!isWin) fs.chmodSync(dest, 0o755);
            console.log(`yt-dlp installed at ${dest}`);
        });
    }).on('error', e => {
        console.error('Download error:', e.message);
        process.exit(1);
    });
}

download(url, dest);
