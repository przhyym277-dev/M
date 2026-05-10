'use strict';

const GREEN  = '#25d366';
const DARK   = '#1a1a2e';
const LIGHT  = '#f0faf4';
const BORDER = '#d0ead8';

async function generateContract({ customerName, serviceName, serviceDetails, price, deliveryDays = 14 }) {
    const today = new Date().toLocaleDateString('he-IL');
    const deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + deliveryDays);
    const deliveryStr = deliveryDate.toLocaleDateString('he-IL');
    const priceStr = '₪' + Number(price).toLocaleString('he-IL');
    const deposit = Math.round(price / 3);
    const balance = price - deposit;

    function esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const html = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>חוזה עבודה — מאסטר קוד</title>
  <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&display=swap" rel="stylesheet"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Heebo', sans-serif; background: #f4f7f5; color: ${DARK}; padding: 32px 16px 48px; display: flex; justify-content: center; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.13); width: 100%; max-width: 720px; overflow: hidden; }
    .header { background: ${GREEN}; padding: 36px 36px 28px; }
    .header-brand { font-size: 36px; font-weight: 900; color: #fff; line-height: 1; }
    .header-sub { font-size: 16px; color: rgba(255,255,255,0.85); margin-top: 8px; }
    .header-bar { height: 5px; background: ${DARK}; }
    .section { margin: 24px 28px 0; }
    .section-title { background: ${DARK}; color: #fff; font-size: 13px; font-weight: 700; padding: 10px 16px; border-radius: 8px 8px 0 0; }
    table { width: 100%; border-collapse: collapse; border: 1px solid ${BORDER}; border-top: none; border-radius: 0 0 8px 8px; overflow: hidden; }
    tr:nth-child(odd) td { background: #fff; }
    tr:nth-child(even) td { background: ${LIGHT}; }
    td { padding: 13px 16px; font-size: 13px; border-bottom: 1px solid ${BORDER}; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .col-label { font-weight: 700; color: ${DARK}; width: 35%; background: #e2f5ea !important; }
    tr:nth-child(even) .col-label { background: #d4efe0 !important; }
    .col-value { color: #333; line-height: 1.55; }
    .clause { margin: 24px 28px 0; padding: 16px 20px; border: 1px solid ${BORDER}; border-radius: 10px; font-size: 13px; line-height: 1.7; color: #444; }
    .clause-title { font-weight: 700; color: ${DARK}; margin-bottom: 6px; font-size: 13px; }
    .price-box { background: ${LIGHT}; border: 1px solid ${BORDER}; border-top: none; border-radius: 0 0 8px 8px; padding: 18px 20px; display: flex; justify-content: space-between; align-items: center; }
    .price-value { font-size: 34px; font-weight: 900; color: ${GREEN}; letter-spacing: -1px; }
    .price-label { font-size: 13px; color: #888; }
    .sig-row { display: flex; gap: 24px; margin: 24px 28px 0; }
    .sig-box { flex: 1; border: 1px solid ${BORDER}; border-radius: 10px; padding: 20px; text-align: center; }
    .sig-box .sig-name { font-weight: 700; font-size: 14px; margin-bottom: 40px; }
    .sig-line { border-top: 1.5px solid #bbb; margin-top: 8px; padding-top: 6px; font-size: 12px; color: #888; }
    .notice { margin: 24px 28px 0; background: #fffde7; border: 1px solid #ffe082; border-radius: 10px; padding: 14px 18px; font-size: 12px; color: #b8860b; display: flex; gap: 10px; }
    .footer { background: ${DARK}; margin-top: 32px; padding: 22px 36px; display: flex; justify-content: space-between; align-items: center; }
    .footer-brand { font-size: 17px; font-weight: 900; color: ${GREEN}; }
    .footer-contact { font-size: 13px; color: rgba(255,255,255,0.8); direction: ltr; }
    @media print { body { background: none; padding: 0; } .card { box-shadow: none; border-radius: 0; max-width: none; } }
    @media (max-width: 520px) { .sig-row { flex-direction: column; } .header { padding: 24px 20px 20px; } .header-brand { font-size: 28px; } }
  </style>
</head>
<body>
<div class="card">

  <div class="header">
    <div class="header-brand">מאסטר קוד</div>
    <div class="header-sub">חוזה עבודה</div>
  </div>
  <div class="header-bar"></div>

  <div class="section">
    <div class="section-title">פרטי הצדדים</div>
    <table>
      <tr><td class="col-label">ספק שירות</td><td class="col-value">מאסטר קוד | יאיר | 0522091733</td></tr>
      <tr><td class="col-label">לקוח</td><td class="col-value">${esc(customerName)}</td></tr>
      <tr><td class="col-label">תאריך חתימה</td><td class="col-value">${esc(today)}</td></tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">פרטי השירות</div>
    <table>
      <tr><td class="col-label">שירות</td><td class="col-value">${esc(serviceName)}</td></tr>
      <tr><td class="col-label">תיאור</td><td class="col-value">${esc(serviceDetails || '—')}</td></tr>
      <tr><td class="col-label">מועד מסירה</td><td class="col-value">עד ${esc(deliveryStr)} (${esc(String(deliveryDays))} ימי עסקים)</td></tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">תמחור ותשלום</div>
    <table>
      <tr><td class="col-label">מקדמה (33%)</td><td class="col-value">₪${Number(deposit).toLocaleString('he-IL')} — בחתימת החוזה</td></tr>
      <tr><td class="col-label">יתרה (67%)</td><td class="col-value">₪${Number(balance).toLocaleString('he-IL')} — במסירת העבודה</td></tr>
    </table>
    <div class="price-box">
      <div class="price-label">סה"כ לתשלום</div>
      <div class="price-value">${esc(priceStr)}</div>
    </div>
  </div>

  <div class="clause">
    <div class="clause-title">📋 תנאים כלליים</div>
    1. הספק יבצע את העבודה לפי המפרט שסוכם בין הצדדים.<br/>
    2. שינויים מעבר לסקופ המוסכם יחויבו בנפרד בהסכמה מראש.<br/>
    3. הלקוח מתחייב לספק חומרים (לוגו, תמונות, טקסטים) תוך 3 ימים מחתימה.<br/>
    4. הספק מספק 2 סבבי תיקונים ללא עלות נוספת לאחר מסירה ראשונה.<br/>
    5. הבעלות על הקוד ועל העיצוב עוברת ללקוח לאחר תשלום מלא.<br/>
    6. איחור בתשלום של מעל 14 יום מהווה הפרת חוזה.
  </div>

  <div class="notice">
    <span>⚠️</span>
    <span>חוזה זה מחייב את שני הצדדים עם חתימתם. הועבר ב-WhatsApp ותקף כחוזה דיגיטלי.</span>
  </div>

  <div class="sig-row">
    <div class="sig-box">
      <div class="sig-name">מאסטר קוד — יאיר</div>
      <div class="sig-line">חתימה ותאריך</div>
    </div>
    <div class="sig-box">
      <div class="sig-name">${esc(customerName)}</div>
      <div class="sig-line">חתימה ותאריך</div>
    </div>
  </div>

  <div class="footer">
    <div class="footer-brand">מאסטר קוד</div>
    <div class="footer-contact">יאיר | 0522091733</div>
  </div>

</div>
</body>
</html>`;

    return Buffer.from(html, 'utf8');
}

module.exports = { generateContract };
