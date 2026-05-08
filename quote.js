'use strict';

const PDFDocument = require('pdfkit');
const path = require('path');

const FONT_REGULAR = path.join(__dirname, 'node_modules/@fontsource/heebo/files/heebo-hebrew-400-normal.woff');
const FONT_BOLD    = path.join(__dirname, 'node_modules/@fontsource/heebo/files/heebo-hebrew-700-normal.woff');

const GREEN  = '#25d366';
const DARK   = '#1a1a2e';
const LIGHT  = '#f0faf4';
const WHITE  = '#ffffff';
const GRAY   = '#666666';
const BORDER = '#d0ead8';

function fill(doc, x, y, w, h, color) {
    doc.save().rect(x, y, w, h).fill(color).restore();
}

// Right-aligned text helper for Hebrew RTL
function rtlText(doc, text, x, y, width, opts = {}) {
    doc.text(text, x, y, { width, align: 'right', features: ['rtla'], ...opts });
}

async function generateQuote({ customerName, packageName, packageDetails, price, date }) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                info: { Title: 'הצעת מחיר - מאסטר קוד', Author: 'מאסטר קוד' },
            });

            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end',  () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            doc.registerFont('Regular', FONT_REGULAR);
            doc.registerFont('Bold',    FONT_BOLD);

            const W  = doc.page.width;
            const H  = doc.page.height;
            const M  = 50;
            const CW = W - M * 2;
            const quoteDate = date
                ? new Date(date).toLocaleDateString('he-IL')
                : new Date().toLocaleDateString('he-IL');
            const priceStr = '₪' + Number(price).toLocaleString('he-IL');

            // ── Header ────────────────────────────────────────────────────────
            fill(doc, 0, 0, W, 120, GREEN);

            doc.font('Bold').fontSize(34).fillColor(WHITE);
            rtlText(doc, 'מאסטר קוד', M, 28, CW);

            doc.font('Regular').fontSize(15).fillColor(WHITE);
            rtlText(doc, 'הצעת מחיר', M, 72, CW);

            fill(doc, 0, 120, W, 5, DARK);

            // ── Customer + Date ───────────────────────────────────────────────
            let y = 145;
            fill(doc, M, y, CW, 60, LIGHT);
            doc.save().rect(M, y, CW, 60).lineWidth(1).strokeColor(BORDER).stroke().restore();

            doc.font('Bold').fontSize(11).fillColor(GRAY);
            rtlText(doc, 'לקוח', M + 10, y + 8, CW - 20);

            doc.font('Regular').fontSize(14).fillColor(DARK);
            rtlText(doc, customerName, M + 10, y + 26, CW - 20);

            // Date on left side
            doc.font('Regular').fontSize(11).fillColor(GRAY)
               .text(quoteDate, M + 10, y + 20, { width: 120, align: 'left' });

            // ── Package section ───────────────────────────────────────────────
            y += 80;
            fill(doc, M, y, CW, 34, DARK);
            doc.font('Bold').fontSize(13).fillColor(WHITE);
            rtlText(doc, 'פרטי החבילה', M + 10, y + 10, CW - 20);

            const packageRows = [
                { label: 'חבילה',   value: packageName },
                { label: 'כולל',    value: packageDetails },
            ];

            packageRows.forEach((row, i) => {
                y += 34;
                const bg = i % 2 === 0 ? WHITE : LIGHT;
                fill(doc, M, y, CW, 40, bg);
                doc.save().rect(M, y, CW, 40).lineWidth(0.5).strokeColor(BORDER).stroke().restore();

                const LW = Math.round(CW * 0.28);
                fill(doc, M, y, LW, 40, i % 2 === 0 ? '#e2f5ea' : '#d4efe0');

                doc.font('Bold').fontSize(11).fillColor(DARK);
                rtlText(doc, row.label, M + 6, y + 13, LW - 12);

                doc.font('Regular').fontSize(11).fillColor(DARK);
                rtlText(doc, row.value, M + LW + 6, y + 13, CW - LW - 12);
            });

            // ── Price section ─────────────────────────────────────────────────
            y += 74;
            fill(doc, M, y, CW, 34, DARK);
            doc.font('Bold').fontSize(13).fillColor(WHITE);
            rtlText(doc, 'מחיר', M + 10, y + 10, CW - 20);

            y += 34;
            fill(doc, M, y, CW, 60, LIGHT);
            doc.save().rect(M, y, CW, 60).lineWidth(1).strokeColor(BORDER).stroke().restore();

            doc.font('Regular').fontSize(12).fillColor(GRAY);
            rtlText(doc, 'סה"כ לתשלום', M + 10, y + 8, CW - 20);

            doc.font('Bold').fontSize(26).fillColor(GREEN);
            rtlText(doc, priceStr, M + 10, y + 24, CW - 20);

            // ── Payment Terms ─────────────────────────────────────────────────
            y += 80;
            fill(doc, M, y, CW, 34, DARK);
            doc.font('Bold').fontSize(13).fillColor(WHITE);
            rtlText(doc, 'תנאי תשלום', M + 10, y + 10, CW - 20);

            const payRows = [
                { label: 'מקדמה',   value: 'שליש מראש בהזמנת העבודה' },
                { label: 'יתרה',    value: 'שני שליש במסירת האתר' },
            ];

            payRows.forEach((row, i) => {
                y += 34;
                const bg = i % 2 === 0 ? WHITE : LIGHT;
                fill(doc, M, y, CW, 40, bg);
                doc.save().rect(M, y, CW, 40).lineWidth(0.5).strokeColor(BORDER).stroke().restore();

                const LW = Math.round(CW * 0.28);
                fill(doc, M, y, LW, 40, i % 2 === 0 ? '#e2f5ea' : '#d4efe0');

                doc.font('Bold').fontSize(11).fillColor(DARK);
                rtlText(doc, row.label, M + 6, y + 13, LW - 12);

                doc.font('Regular').fontSize(11).fillColor(DARK);
                rtlText(doc, row.value, M + LW + 6, y + 13, CW - LW - 12);
            });

            // ── Validity notice ───────────────────────────────────────────────
            y += 54;
            fill(doc, M, y, CW, 44, '#fff8e1');
            doc.save().rect(M, y, CW, 44).lineWidth(1).strokeColor('#ffe082').stroke().restore();

            doc.font('Bold').fontSize(12).fillColor('#b8860b');
            rtlText(doc, '⚠ הצעה תקפה ל-7 ימים מתאריך הנפקת המסמך', M + 10, y + 14, CW - 20);

            // ── Footer ────────────────────────────────────────────────────────
            fill(doc, 0, H - 65, W, 65, DARK);

            doc.font('Bold').fontSize(14).fillColor(GREEN);
            rtlText(doc, 'מאסטר קוד', M, H - 50, CW);

            doc.font('Regular').fontSize(11).fillColor(WHITE);
            rtlText(doc, 'יאיר | 0522091733', M, H - 30, CW);

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generateQuote };
