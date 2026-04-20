"use strict";
const webpush = require("web-push");
const { q }   = require("./db");

function initVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL || "mailto:admin@finanzas.app",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  }
}
initVapid();

const fmtCOP = v => "$" + Number(Math.round(v || 0)).toLocaleString("es-CO");

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

const notify = {
  expense:      (uid, d) => sendPush(uid, { title: "💸 Gasto registrado",        body: `${d.name}: ${fmtCOP(d.amount)} (${d.account === "credit" ? "Tarjeta" : "Ahorros"})`, tag: "expense",    data: { type: "expense" } }),
  income:       (uid, d) => sendPush(uid, { title: "📈 Ingreso registrado",       body: `${d.name}: ${fmtCOP(d.amount)}`,                                                        tag: "income",     data: { type: "income" } }),
  installment:  (uid, d) => sendPush(uid, { title: "📋 Cuota registrada",         body: `${d.name}: ${fmtCOP(d.monthly)}/mes × ${d.months}`,                                     tag: "install",    data: { type: "installment" } }),
  creditAlert:  (uid, d) => sendPush(uid, { title: `🚨 Cupo al ${d.pct.toFixed(0)}%`, body: `Solo ${fmtCOP(d.available)} disponibles`, tag: "credit-alert", requireInteraction: true, data: { type: "credit_alert" } }),
  needsInfo:    (uid, d) => sendPush(uid, { title: "❓ ¿A cuántas cuotas?",       body: `"${d.name}" por ${fmtCOP(d.amount)} — toca para completar`, tag: "needs-info", requireInteraction: true, data: { type: "needs_info", pendingId: d.pendingId } }),
  payReminder:  (uid, d) => sendPush(uid, { title: `⏰ Pago tarjeta en ${d.days} días`, body: `Total a pagar: ${fmtCOP(d.total)}`, tag: "pay-reminder", requireInteraction: true, data: { type: "pay_reminder" } }),
  cutAlert:     (uid, d) => sendPush(uid, { title: "✂️ Mañana es tu fecha de corte", body: `Saldo acumulado: ${fmtCOP(d.balance)}`, tag: "cut-alert", data: { type: "cut_alert" } }),
  weeklyReport: (uid, d) => sendPush(uid, { title: "📊 Resumen semanal",           body: `Gastado: ${fmtCOP(d.spent)} · ${d.pct.toFixed(0)}% del cupo · Libre: ${fmtCOP(d.free)}`, tag: "weekly", data: { type: "weekly" } }),
};

module.exports = { sendPush, notify };
