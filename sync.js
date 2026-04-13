// sync.js
const { db, q } = require("./db");
const { refreshAccessToken, fetchBankEmails, extractEmailText } = require("./outlook");
const { parseEmail } = require("./ai");
const { notify } = require("./notifications");

const fmtCOP = v => Number(Math.round(v)).toLocaleString("es-CO");

function instMonthlyPayment(inst) {
  const r = inst.interest_rate / 100;
  return r > 0
    ? inst.total_amount * r * Math.pow(1+r, inst.months) / (Math.pow(1+r, inst.months)-1)
    : inst.total_amount / inst.months;
}

function mDiff(a, b) {
  const [ay,am] = a.split("-").map(Number), [by,bm] = b.split("-").map(Number);
  return (by-ay)*12+(bm-am);
}

function calcCreditUsage(userId, settings) {
  const cm   = new Date().toISOString().slice(0,7);
  const txs  = q.getTx.all(userId).filter(t => t.date.startsWith(cm));
  const txExp= txs.filter(t=>t.type==="expense"&&(t.account==="credit"||t.account==="both")).reduce((s,t)=>s+t.amount,0);
  const insts= q.getInstallments.all(userId);
  const instCharge = insts.reduce((sum,inst)=>{
    const el = mDiff(inst.start_month, cm);
    if(el>=0&&el<inst.months) return sum+instMonthlyPayment(inst);
    return sum;
  },0);
  const total = txExp + instCharge;
  const pct   = settings.credit_limit>0 ? (total/settings.credit_limit)*100 : 0;
  return { total, pct, available: settings.credit_limit-total };
}

async function processParsed(userId, parsed, messageId, emailDate) {
  const settings = q.getSettings.get(userId);
  const today    = emailDate || new Date().toISOString().split("T")[0];

  // Needs installment count from user
  if (parsed.isInstallment && parsed.needsInstallmentInfo) {
    q.insertPending.run(userId, messageId, JSON.stringify({...parsed, date:today}),
      `Detecté una compra a cuotas: "${parsed.name}" por $${fmtCOP(parsed.amount)}. ¿A cuántas cuotas la hiciste? ¿Tiene interés mensual?`);
    const pid = q.getLastInsertId.get().id;
    await notify.needsInfo(userId, { name:parsed.name, amount:parsed.amount, pendingId:pid });
    return "pending";
  }

  // Known installment
  if (parsed.isInstallment && parsed.installmentMonths > 1) {
    const sm = today.slice(0,7);
    q.insertInstallment.run(userId, parsed.name, parsed.amount, parsed.installmentMonths, parsed.interestRate||0, parsed.category, parsed.account||"credit", sm, 1);
    const monthly = parsed.interestRate > 0
      ? parsed.amount*(parsed.interestRate/100)*Math.pow(1+parsed.interestRate/100,parsed.installmentMonths)/(Math.pow(1+parsed.interestRate/100,parsed.installmentMonths)-1)
      : parsed.amount/parsed.installmentMonths;
    await notify.installment(userId, { name:parsed.name, amount:parsed.amount, monthly, months:parsed.installmentMonths });
    return "installment";
  }

  // Regular transaction
  const isRec = parsed.isRecurring ? 1 : 0;
  q.insertTx.run(userId, parsed.name, parsed.amount, parsed.category, parsed.account||"credit", parsed.type||"expense", today, isRec, parsed.recurringName||null, 1, messageId);

  if (parsed.type==="income") {
    await notify.income(userId, { name:parsed.name, amount:parsed.amount });
  } else {
    await notify.expense(userId, { name:parsed.name, amount:parsed.amount, account:parsed.account||"credit" });
    if (parsed.isRecurring) {
      await notify.recurring(userId, { name:parsed.recurringName||parsed.name, amount:parsed.amount });
    }
    // Credit alert
    if (settings && settings.credit_limit > 0) {
      const usage = calcCreditUsage(userId, settings);
      if (usage.pct >= 85) await notify.creditAlert(userId, { pct:usage.pct, available:usage.available });
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
    db.prepare("UPDATE users SET ms_token=? WHERE id=?").run(JSON.stringify({...tokenData,...refreshed}), user.id);
  } catch(e) { console.error(`Token refresh failed user ${user.id}:`, e.message); return; }

  const since = settings.last_email_sync
    ? new Date(settings.last_email_sync).toISOString()
    : new Date(Date.now()-24*60*60*1000).toISOString();

  let emails = [];
  try { emails = await fetchBankEmails(accessToken, settings.email_filter, since); }
  catch(e) { console.error(`Fetch failed user ${user.id}:`, e.message); return; }

  let count = 0;
  for (const email of emails) {
    if (q.isEmailProcessed.get(user.id, email.id)) continue;
    const text = extractEmailText(email);
    const date = email.receivedDateTime ? new Date(email.receivedDateTime).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];
    try {
      const parsed = await parseEmail(text, date);
      if (parsed.isBankEmail && parsed.found) { await processParsed(user.id, parsed, email.id, date); count++; }
      q.markEmailProcessed.run(user.id, email.id);
    } catch(e) { console.error(`Parse error:`, e.message); }
    await new Promise(r=>setTimeout(r,600));
  }
  q.updateLastSync.run(new Date().toISOString(), user.id);
  if (count > 0) console.log(`User ${user.id}: ${count} new transactions`);
}

async function syncAll() {
  const users = q.getAllConnected.all();
  for (const u of users) { try { await syncUser(u); } catch(e) { console.error(e.message); } }
}

// Cut day and pay day reminders
async function checkDateAlerts() {
  const users = db.prepare("SELECT u.*,s.* FROM users u JOIN settings s ON s.user_id=u.id WHERE u.ms_token IS NOT NULL").all();
  const today = new Date();
  const dom   = today.getDate();

  for (const u of users) {
    const cm    = today.toISOString().slice(0,7);
    const txs   = q.getTx.all(u.id);
    const insts = q.getInstallments.all(u.id);

    // Credit balance this month
    const mExp = txs.filter(t=>t.date.startsWith(cm)&&t.type==="expense"&&(t.account==="credit"||t.account==="both")).reduce((s,t)=>s+t.amount,0);
    const iChg = insts.reduce((sum,inst)=>{ const el=mDiff(inst.start_month,cm); return (el>=0&&el<inst.months)?sum+instMonthlyPayment(inst):sum; },0);
    const total = mExp + iChg;

    // Cut day alert (day before)
    if (dom === (u.cut_day||25) - 1) {
      await notify.cutDayAlert(u.id, { tomorrow:true, balance:total });
    }
    // Pay day reminder (3 days before)
    const payDay = u.pay_day || 10;
    const daysToPayDay = payDay >= dom ? payDay-dom : (payDay+30)-dom;
    if (daysToPayDay === 3) {
      const minPayment = total * 0.05; // approx 5% minimum
      await notify.payDayReminder(u.id, { daysLeft:3, minPayment, fullPayment:total });
    }
  }
}

module.exports = { syncAll, syncUser, processParsed, calcCreditUsage, instMonthlyPayment, mDiff };
