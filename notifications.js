// notifications.js
const webpush = require("web-push");
const { q } = require("./db");

webpush.setVapidDetails(
  process.env.VAPID_EMAIL || "mailto:admin@finanzas.app",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function sendPush(userId, payload) {
  const subs = q.getPushSubs.all(userId);
  if (!subs.length) return;
  await Promise.allSettled(subs.map(sub =>
    webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    ).catch(err => {
      if (err.statusCode === 410 || err.statusCode === 404) q.deletePushSub.run(sub.endpoint);
    })
  ));
}

const fmtCOP = v => "$" + Number(Math.round(v)).toLocaleString("es-CO");

const notify = {
  expense:     (uid, {name,amount,account}) => sendPush(uid, { title:"💸 Gasto registrado", body:`${name}: ${fmtCOP(amount)} (${account==="credit"?"Tarjeta":"Ahorros"})`, tag:"expense", data:{type:"expense"} }),
  income:      (uid, {name,amount})         => sendPush(uid, { title:"📈 Ingreso registrado", body:`${name}: ${fmtCOP(amount)}`, tag:"income", data:{type:"income"} }),
  installment: (uid, {name,amount,monthly,months}) => sendPush(uid, { title:"📋 Cuota registrada", body:`${name}: ${fmtCOP(monthly)}/mes × ${months} (total ${fmtCOP(amount)})`, tag:"installment", data:{type:"installment"} }),
  creditAlert: (uid, {pct,available})       => sendPush(uid, { title:`🚨 Cupo al ${pct.toFixed(0)}%`, body:`Solo te quedan ${fmtCOP(available)} disponibles`, tag:"credit-alert", requireInteraction:true, data:{type:"credit_alert"} }),
  payDayReminder: (uid, {daysLeft,minPayment,fullPayment}) => sendPush(uid, { title:`⏰ Pago tarjeta en ${daysLeft} días`, body:`Mínimo: ${fmtCOP(minPayment)} | Sin interés: ${fmtCOP(fullPayment)}`, tag:"pay-reminder", requireInteraction:true, data:{type:"pay_reminder"} }),
  cutDayAlert: (uid, {tomorrow,balance})    => sendPush(uid, { title:"✂️ Mañana es tu fecha de corte", body:`Saldo a cortar: ${fmtCOP(balance)}`, tag:"cut-alert", data:{type:"cut_alert"} }),
  needsInfo:   (uid, {name,amount,pendingId}) => sendPush(uid, { title:"❓ ¿A cuántas cuotas?", body:`"${name}" por ${fmtCOP(amount)} — toca para completar`, tag:"needs-info", requireInteraction:true, data:{type:"needs_info",pendingId} }),
  recurring:   (uid, {name,amount})         => sendPush(uid, { title:"🔄 Cobro recurrente detectado", body:`${name}: ${fmtCOP(amount)}`, tag:"recurring", data:{type:"recurring"} }),
  weeklyReport:(uid, {spent,pct,free})      => sendPush(uid, { title:"📊 Resumen semanal", body:`Gastado: ${fmtCOP(spent)} (${pct.toFixed(0)}% cupo) · Libre: ${fmtCOP(free)}`, tag:"weekly", data:{type:"weekly"} }),
};

module.exports = { sendPush, notify };
