"use strict";
const { db, q }    = require("./db");
const { refreshAccessToken, fetchBankEmails, extractEmailText } = require("./outlook");
const { parseEmail }  = require("./ai");
const { notify }      = require("./notifications");

function mDiff(a, b) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

function instMonthly(inst) {
  const r = inst.interest_rate / 100;
  return r > 0
    ? inst.total_amount * r * Math.pow(1 + r, inst.months) / (Math.pow(1 + r, inst.months) - 1)
    : inst.total_amount / inst.months;
}

function calcCreditUsage(userId, settings) {
  const cm    = new Date().toISOString().slice(0, 7);
  const txs   = q.getTx.all(userId).filter(t => t.date.startsWith(cm));
  const txExp = txs.filter(t => t.type === "expense" && (t.account === "credit" || t.account === "both")).reduce((s, t) => s + t.amount, 0);
  const insts = q.getInstallments.all(userId);
  const iExp  = insts.reduce((sum, inst) => {
    const el = mDiff(inst.start_month, cm);
    return (el >= 0 && el < inst.months) ? sum + instMonthly(inst) : sum;
  }, 0);
  const total = txExp + iExp;
  const pct   = settings.credit_limit > 0 ? (total / settings.credit_limit) * 100 : 0;
  return { total, pct, available: settings.credit_limit - total };
}

async function processParsed(userId, parsed, messageId, emailDate) {
  const settings = q.getSettings.get(userId);
  const date     = emailDate || new Date().toISOString().split("T")[0];

  // Needs cuota count from user
  if (parsed.isInstallment && parsed.needsInstallmentInfo) {
    q.insertPending.run(userId, messageId, JSON.stringify({ ...parsed, date }), `Detecté una compra a cuotas: "${parsed.name}" por $${Math.round(parsed.amount).toLocaleString("es-CO")}. ¿A cuántas cuotas la hiciste? ¿Tiene interés mensual?`);
    const pid = q.lastInsertId.get().id;
    await notify.needsInfo(userId, { name: parsed.name, amount: parsed.amount, pendingId: pid });
    return "pending";
  }

  // Known installment
  if (parsed.isInstallment && parsed.installmentMonths > 1) {
    q.insertInstallment.run(userId, parsed.name, parsed.amount, parsed.installmentMonths, parsed.interestRate || 0, parsed.category, parsed.account || "credit", date.slice(0, 7), 1);
    const monthly = instMonthly({ total_amount: parsed.amount, months: parsed.installmentMonths, interest_rate: parsed.interestRate || 0 });
    await notify.installment(userId, { name: parsed.name, amount: parsed.amount, monthly, months: parsed.installmentMonths });
    return "installment";
  }

  // Regular transaction
  q.insertTx.run(userId, parsed.name, parsed.amount, parsed.category, parsed.account || "credit", parsed.type || "expense", date, parsed.isRecurring ? 1 : 0, parsed.recurringName || null, 1, messageId);

  if (parsed.type === "income") {
    await notify.income(userId, { name: parsed.name, amount: parsed.amount });
  } else {
    await notify.expense(userId, { name: parsed.name, amount: parsed.amount, account: parsed.account || "credit" });
    if (settings && settings.credit_limit > 0) {
      const usage = calcCreditUsage(userId, settings);
      if (usage.pct >= 85) await notify.creditAlert(userId, { pct: usage.pct, available: usage.available });
    }
  }
  return "transaction";
}

async function syncUser(user) {
  const settings = q.getSettings.get(user.id);
  if (!settings) return;

  let tokenData;
  try { tokenData = JSON.parse(user.ms_token); } catch { return; }

  let accessToken;
  try {
    const refreshed = await refreshAccessToken(tokenData.refresh_token);
    accessToken = refreshed.access_token;
    db.prepare("UPDATE users SET ms_token=? WHERE id=?").run(JSON.stringify({ ...tokenData, ...refreshed }), user.id);
  } catch (e) {
    console.error(`Token refresh failed user ${user.id}:`, e.message);
    return;
  }

  const since = settings.last_email_sync
    ? new Date(settings.last_email_sync).toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let emails = [];
  try { emails = await fetchBankEmails(accessToken, settings.email_filter, since); }
  catch (e) { console.error(`Fetch failed user ${user.id}:`, e.message); return; }

  let count = 0;
  for (const email of emails) {
    if (q.isEmailProcessed.get(user.id, email.id)) continue;
    const text = extractEmailText(email);
    const date = email.receivedDateTime ? new Date(email.receivedDateTime).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];
    try {
      const parsed = await parseEmail(text, date);
      if (parsed.isBankEmail && parsed.found) { await processParsed(user.id, parsed, email.id, date); count++; }
      q.markEmailProcessed.run(user.id, email.id);
    } catch (e) { console.error(`Parse error email ${email.id}:`, e.message); }
    await new Promise(r => setTimeout(r, 800));
  }

  q.updateLastSync.run(new Date().toISOString(), user.id);
  if (count > 0) console.log(`User ${user.id}: ${count} new transactions from email`);
}

async function syncAll() {
  const users = q.getAllConnected.all();
  for (const u of users) {
    try { await syncUser(u); } catch (e) { console.error(`Sync error user ${u.id}:`, e.message); }
  }
}

async function checkDateAlerts() {
  const users = db.prepare("SELECT u.*,s.* FROM users u JOIN settings s ON s.user_id=u.id WHERE u.ms_token IS NOT NULL").all();
  const today = new Date();
  const dom   = today.getDate();
  const cm    = today.toISOString().slice(0, 7);

  for (const u of users) {
    const txs   = q.getTx.all(u.id);
    const insts = q.getInstallments.all(u.id);
    const mExp  = txs.filter(t => t.date.startsWith(cm) && t.type === "expense" && (t.account === "credit" || t.account === "both")).reduce((s, t) => s + t.amount, 0);
    const iChg  = insts.reduce((sum, inst) => { const el = mDiff(inst.start_month, cm); return (el >= 0 && el < inst.months) ? sum + instMonthly(inst) : sum; }, 0);
    const total = mExp + iChg;

    if (dom === (u.cut_day || 25) - 1) await notify.cutAlert(u.id, { balance: total });
    const payDay = u.pay_day || 10;
    const daysTo = payDay >= dom ? payDay - dom : payDay + 30 - dom;
    if (daysTo === 3) await notify.payReminder(u.id, { days: 3, total });
  }
}

module.exports = { syncAll, syncUser, processParsed, calcCreditUsage, instMonthly, mDiff, checkDateAlerts };
