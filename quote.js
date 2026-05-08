'use strict';

const GREEN  = '#25d366';
const DARK   = '#1a1a2e';
const LIGHT  = '#f0faf4';
const BORDER = '#d0ead8';

async function generateQuote({ customerName, packageName, packageDetails, price, date }) {
    const quoteDate = date
        ? new Date(date).toLocaleDateString('he-IL')
        : new Date().toLocaleDateString('he-IL');

    const priceStr = '₪' + Number(price).toLocaleString('he-IL');

    // Escape HTML entities to avoid injection
    function esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    const html = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>הצעת מחיר - מאסטר קוד</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&display=swap" rel="stylesheet" />
  <style>
    /* ── Reset & base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Heebo', sans-serif;
      background: #f4f7f5;
      color: ${DARK};
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 32px 16px 48px;
    }

    /* ── Card ── */
    .card {
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.13);
      width: 100%;
      max-width: 680px;
      overflow: hidden;
    }

    /* ── Header ── */
    .header {
      background: ${GREEN};
      padding: 36px 36px 28px;
      position: relative;
    }
    .header-brand {
      font-size: 36px;
      font-weight: 900;
      color: #ffffff;
      letter-spacing: -0.5px;
      line-height: 1;
    }
    .header-sub {
      font-size: 16px;
      font-weight: 400;
      color: rgba(255,255,255,0.85);
      margin-top: 8px;
    }
    .header-bar {
      height: 5px;
      background: ${DARK};
    }

    /* ── Meta row (customer / date) ── */
    .meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: ${LIGHT};
      border: 1px solid ${BORDER};
      border-radius: 10px;
      margin: 24px 28px 0;
      padding: 14px 20px;
      gap: 12px;
    }
    .meta-label {
      font-size: 11px;
      font-weight: 700;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 3px;
    }
    .meta-value {
      font-size: 15px;
      font-weight: 700;
      color: ${DARK};
    }
    .meta-date {
      text-align: left;
      flex-shrink: 0;
    }

    /* ── Section ── */
    .section { margin: 24px 28px 0; }

    .section-title {
      background: ${DARK};
      color: #ffffff;
      font-size: 13px;
      font-weight: 700;
      padding: 10px 16px;
      border-radius: 8px 8px 0 0;
      letter-spacing: 0.3px;
    }

    /* ── Table ── */
    .info-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid ${BORDER};
      border-top: none;
      border-radius: 0 0 8px 8px;
      overflow: hidden;
    }
    .info-table tr:nth-child(odd)  td { background: #ffffff; }
    .info-table tr:nth-child(even) td { background: ${LIGHT}; }
    .info-table td {
      padding: 13px 16px;
      font-size: 13px;
      border-bottom: 1px solid ${BORDER};
      vertical-align: top;
    }
    .info-table tr:last-child td { border-bottom: none; }
    .info-table .col-label {
      font-weight: 700;
      color: ${DARK};
      width: 30%;
      background: #e2f5ea !important;
    }
    .info-table tr:nth-child(even) .col-label { background: #d4efe0 !important; }
    .info-table .col-value {
      color: #333;
      font-weight: 400;
      line-height: 1.55;
    }

    /* ── Price box ── */
    .price-box {
      background: ${LIGHT};
      border: 1px solid ${BORDER};
      border-top: none;
      border-radius: 0 0 8px 8px;
      padding: 18px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .price-label {
      font-size: 13px;
      color: #888;
      font-weight: 400;
    }
    .price-value {
      font-size: 34px;
      font-weight: 900;
      color: ${GREEN};
      letter-spacing: -1px;
    }

    /* ── Notice ── */
    .notice {
      margin: 24px 28px 0;
      background: #fffde7;
      border: 1px solid #ffe082;
      border-radius: 10px;
      padding: 14px 18px;
      font-size: 13px;
      font-weight: 700;
      color: #b8860b;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .notice-icon { font-size: 18px; flex-shrink: 0; }

    /* ── Footer ── */
    .footer {
      background: ${DARK};
      margin-top: 32px;
      padding: 22px 36px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .footer-brand {
      font-size: 17px;
      font-weight: 900;
      color: ${GREEN};
    }
    .footer-contact {
      font-size: 13px;
      color: rgba(255,255,255,0.8);
      font-weight: 400;
      direction: ltr;
    }

    /* ── Print ── */
    @media print {
      body { background: none; padding: 0; }
      .card {
        box-shadow: none;
        border-radius: 0;
        max-width: none;
        width: 100%;
      }
    }

    /* ── Mobile ── */
    @media (max-width: 520px) {
      .header { padding: 24px 20px 20px; }
      .header-brand { font-size: 28px; }
      .meta, .section, .notice { margin-left: 16px; margin-right: 16px; }
      .price-value { font-size: 26px; }
      .footer { padding: 18px 20px; flex-direction: column; gap: 6px; text-align: center; }
    }
  </style>
</head>
<body>
<div class="card">

  <!-- Header -->
  <div class="header">
    <div class="header-brand">מאסטר קוד</div>
    <div class="header-sub">הצעת מחיר</div>
  </div>
  <div class="header-bar"></div>

  <!-- Customer / Date -->
  <div class="meta">
    <div>
      <div class="meta-label">לקוח</div>
      <div class="meta-value">${esc(customerName)}</div>
    </div>
    <div class="meta-date">
      <div class="meta-label">תאריך</div>
      <div class="meta-value">${esc(quoteDate)}</div>
    </div>
  </div>

  <!-- Package details -->
  <div class="section">
    <div class="section-title">פרטי החבילה</div>
    <table class="info-table">
      <tr>
        <td class="col-label">חבילה</td>
        <td class="col-value">${esc(packageName)}</td>
      </tr>
      <tr>
        <td class="col-label">כולל</td>
        <td class="col-value">${esc(packageDetails)}</td>
      </tr>
    </table>
  </div>

  <!-- Price -->
  <div class="section">
    <div class="section-title">מחיר</div>
    <div class="price-box">
      <div class="price-label">סה"כ לתשלום</div>
      <div class="price-value">${esc(priceStr)}</div>
    </div>
  </div>

  <!-- Payment terms -->
  <div class="section">
    <div class="section-title">תנאי תשלום</div>
    <table class="info-table">
      <tr>
        <td class="col-label">מקדמה</td>
        <td class="col-value">שליש מראש בהזמנת העבודה</td>
      </tr>
      <tr>
        <td class="col-label">יתרה</td>
        <td class="col-value">שני שליש במסירת האתר</td>
      </tr>
    </table>
  </div>

  <!-- Validity notice -->
  <div class="notice">
    <span class="notice-icon">⚠️</span>
    <span>הצעה תקפה ל-7 ימים מתאריך הנפקת המסמך</span>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-brand">מאסטר קוד</div>
    <div class="footer-contact">יאיר | 0522091733</div>
  </div>

</div>
</body>
</html>`;

    return Buffer.from(html, 'utf8');
}

module.exports = { generateQuote };
