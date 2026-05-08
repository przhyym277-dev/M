'use strict';

const PDFDocument = require('pdfkit');

// Brand colors
const COLOR_GREEN  = '#25d366';
const COLOR_DARK   = '#1a1a2e';
const COLOR_GRAY   = '#4a4a6a';
const COLOR_LIGHT  = '#f0faf4';
const COLOR_WHITE  = '#ffffff';
const COLOR_BORDER = '#d0ead8';

/**
 * Draw a filled rectangle helper.
 */
function fillRect(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color).restore();
}

/**
 * Generate a professional PDF price quote for מאסטר קוד.
 *
 * @param {object} opts
 * @param {string} opts.customerName   - Client name (Hebrew OK)
 * @param {string} opts.packageName    - Package name, e.g. "כניסה"
 * @param {string} opts.packageDetails - One-line description of what is included
 * @param {number} opts.price          - Price in ILS (number)
 * @param {string} [opts.date]         - ISO date string; defaults to today
 * @returns {Promise<Buffer>}
 */
async function generateQuote({ customerName, packageName, packageDetails, price, date }) {
  return new Promise((resolve, reject) => {
    try {
      // ── Document setup ────────────────────────────────────────────────────
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: {
          Title:    'הצעת מחיר - מאסטר קוד',
          Author:   'מאסטר קוד',
          Subject:  'הצעת מחיר',
          Creator:  'מאסטר קוד - WhatsApp Bot',
        },
      });

      const chunks = [];
      doc.on('data',  chunk => chunks.push(chunk));
      doc.on('end',   ()    => resolve(Buffer.concat(chunks)));
      doc.on('error', err   => reject(err));

      const PAGE_W = doc.page.width;   // 595.28
      const PAGE_H = doc.page.height;  // 841.89
      const MARGIN = 48;
      const CONTENT_W = PAGE_W - MARGIN * 2;

      // ── Helpers ───────────────────────────────────────────────────────────
      const quoteDate = date
        ? new Date(date).toLocaleDateString('he-IL')
        : new Date().toLocaleDateString('he-IL');

      const priceFormatted = Number(price).toLocaleString('he-IL') + ' ₪'; // ₪

      // ── HEADER band ───────────────────────────────────────────────────────
      fillRect(doc, 0, 0, PAGE_W, 110, COLOR_GREEN);

      // Company name
      doc
        .font('Helvetica-Bold')
        .fontSize(32)
        .fillColor(COLOR_WHITE)
        .text('מאסטר קוד', MARGIN, 28, {
          width: CONTENT_W,
          align: 'center',
        });

      // Subtitle
      doc
        .font('Helvetica')
        .fontSize(14)
        .fillColor(COLOR_WHITE)
        .text('הצעת מחיר', MARGIN, 68, {
          width: CONTENT_W,
          align: 'center',
        });

      // ── Thin accent line ──────────────────────────────────────────────────
      fillRect(doc, 0, 110, PAGE_W, 4, COLOR_DARK);

      // ── Meta row (customer + date) ────────────────────────────────────────
      const META_Y = 134;
      fillRect(doc, MARGIN, META_Y, CONTENT_W, 54, COLOR_LIGHT);

      // Border
      doc
        .save()
        .rect(MARGIN, META_Y, CONTENT_W, 54)
        .lineWidth(1)
        .strokeColor(COLOR_BORDER)
        .stroke()
        .restore();

      // Customer label + value
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(COLOR_GRAY)
        .text('Customer:', MARGIN + 12, META_Y + 10);

      doc
        .font('Helvetica')
        .fontSize(13)
        .fillColor(COLOR_DARK)
        .text(customerName, MARGIN + 12, META_Y + 26);

      // Date label + value (right side)
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(COLOR_GRAY)
        .text('Date:', MARGIN + CONTENT_W - 130, META_Y + 10);

      doc
        .font('Helvetica')
        .fontSize(13)
        .fillColor(COLOR_DARK)
        .text(quoteDate, MARGIN + CONTENT_W - 130, META_Y + 26);

      // ── Section: Package Details ──────────────────────────────────────────
      const SEC1_Y = 218;

      // Section header
      fillRect(doc, MARGIN, SEC1_Y, CONTENT_W, 30, COLOR_DARK);
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor(COLOR_WHITE)
        .text('Package Details', MARGIN + 12, SEC1_Y + 9);

      // Package table rows
      const ROWS = [
        { label: 'Package', value: packageName },
        { label: 'Includes', value: packageDetails },
      ];

      let rowY = SEC1_Y + 30;
      ROWS.forEach((row, i) => {
        const bg = i % 2 === 0 ? COLOR_WHITE : COLOR_LIGHT;
        fillRect(doc, MARGIN, rowY, CONTENT_W, 36, bg);

        doc
          .save()
          .rect(MARGIN, rowY, CONTENT_W, 36)
          .lineWidth(0.5)
          .strokeColor(COLOR_BORDER)
          .stroke()
          .restore();

        // Label column (left ~35% width)
        const LABEL_W = Math.round(CONTENT_W * 0.35);
        fillRect(doc, MARGIN, rowY, LABEL_W, 36, i % 2 === 0 ? '#e8f5ed' : '#ddf0e5');

        doc
          .font('Helvetica-Bold')
          .fontSize(11)
          .fillColor(COLOR_DARK)
          .text(row.label, MARGIN + 10, rowY + 12, { width: LABEL_W - 20 });

        doc
          .font('Helvetica')
          .fontSize(11)
          .fillColor(COLOR_DARK)
          .text(row.value, MARGIN + LABEL_W + 10, rowY + 12, {
            width: CONTENT_W - LABEL_W - 20,
          });

        rowY += 36;
      });

      // ── Section: Pricing ──────────────────────────────────────────────────
      const SEC2_Y = rowY + 24;

      fillRect(doc, MARGIN, SEC2_Y, CONTENT_W, 30, COLOR_DARK);
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor(COLOR_WHITE)
        .text('Pricing', MARGIN + 12, SEC2_Y + 9);

      // Price row - big highlight
      const PRICE_ROW_Y = SEC2_Y + 30;
      fillRect(doc, MARGIN, PRICE_ROW_Y, CONTENT_W, 52, COLOR_LIGHT);
      doc
        .save()
        .rect(MARGIN, PRICE_ROW_Y, CONTENT_W, 52)
        .lineWidth(1)
        .strokeColor(COLOR_BORDER)
        .stroke()
        .restore();

      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor(COLOR_GRAY)
        .text('Total Price:', MARGIN + 12, PRICE_ROW_Y + 10);

      doc
        .font('Helvetica-Bold')
        .fontSize(22)
        .fillColor(COLOR_GREEN)
        .text(priceFormatted, MARGIN + 12, PRICE_ROW_Y + 24);

      // ── Section: Payment Terms ────────────────────────────────────────────
      const SEC3_Y = PRICE_ROW_Y + 52 + 24;

      fillRect(doc, MARGIN, SEC3_Y, CONTENT_W, 30, COLOR_DARK);
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor(COLOR_WHITE)
        .text('Payment Terms', MARGIN + 12, SEC3_Y + 9);

      const PAYMENT_ROWS = [
        { label: 'Deposit (1/3)', value: 'שליש מראש בהזמנת העבודה' },
        { label: 'Balance (2/3)', value: 'יתרה במסירת האתר' },
      ];

      let payY = SEC3_Y + 30;
      PAYMENT_ROWS.forEach((row, i) => {
        const bg = i % 2 === 0 ? COLOR_WHITE : COLOR_LIGHT;
        fillRect(doc, MARGIN, payY, CONTENT_W, 36, bg);
        doc
          .save()
          .rect(MARGIN, payY, CONTENT_W, 36)
          .lineWidth(0.5)
          .strokeColor(COLOR_BORDER)
          .stroke()
          .restore();

        const LABEL_W = Math.round(CONTENT_W * 0.35);
        fillRect(doc, MARGIN, payY, LABEL_W, 36, i % 2 === 0 ? '#e8f5ed' : '#ddf0e5');

        doc
          .font('Helvetica-Bold')
          .fontSize(11)
          .fillColor(COLOR_DARK)
          .text(row.label, MARGIN + 10, payY + 12, { width: LABEL_W - 20 });

        doc
          .font('Helvetica')
          .fontSize(11)
          .fillColor(COLOR_DARK)
          .text(row.value, MARGIN + LABEL_W + 10, payY + 12, {
            width: CONTENT_W - LABEL_W - 20,
          });

        payY += 36;
      });

      // ── Validity notice ───────────────────────────────────────────────────
      const VALID_Y = payY + 24;
      fillRect(doc, MARGIN, VALID_Y, CONTENT_W, 40, '#fff8e1');
      doc
        .save()
        .rect(MARGIN, VALID_Y, CONTENT_W, 40)
        .lineWidth(1)
        .strokeColor('#ffe082')
        .stroke()
        .restore();

      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor('#b8860b')
        .text(
          'הצעה תקפיתה 7 ימים מתאריך הנפקת המסמך',
          MARGIN + 12,
          VALID_Y + 14,
          { width: CONTENT_W - 24 }
        );

      // ── Footer ────────────────────────────────────────────────────────────
      fillRect(doc, 0, PAGE_H - 60, PAGE_W, 60, COLOR_DARK);

      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor(COLOR_GREEN)
        .text('מאסטר קוד', MARGIN, PAGE_H - 44, {
          width: CONTENT_W,
          align: 'center',
        });

      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(COLOR_WHITE)
        .text(
          'יאיר | 0522091733',
          MARGIN,
          PAGE_H - 26,
          { width: CONTENT_W, align: 'center' }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateQuote };
