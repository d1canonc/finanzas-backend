// server.js
require("dotenv").config();
require("isomorphic-fetch");

const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const cron      = require("node-cron");
const jwt       = require("jsonwebtoken");
const { db, q } = require("./db");
const outlook   = require("./outlook");
const { getAdvisorResponse, simulatePurchase, detectRecurring } = require("./ai");
const { syncAll, syncUser, processParsed, calcCreditUsage, instMonthlyPayment, mDiff } = require("./sync");
const { notify } = require("./notifications");
const webpush   = require("web-push");

const app  = express();
const PORT = process.env.PORT || 3000;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(process.env.VAPID_EMAIL||"mailto:admin@finanzas.app", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

// ── Middleware ────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || "*", credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", rateLimit({ windowMs:15*60*1000, max:150, standardHeaders:true }));
app.use("/auth", rateLimit({ windowMs:15*60*1000, max:15 }));

function auth(req,res,next) {
  const token = req.headers.authorization?.replace("Bearer ","");
  if(!token) return res.status(401).json({error:"No token"});
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({error:"Invalid token"}); }
}

// ── Auth ──────────────────────────────────────────────────────────────────
app.get("/auth/login", (_,res) => res.redirect(outlook.getAuthUrl()));

app.get("/auth/callback", async (req,res) => {
  const { code, error } = req.query;
  const FE = process.env.FRONTEND_URL;
  if (error||!code) return res.redirect(`${FE}?error=${error||"no_code"}`);
  try {
    const tokens  = await outlook.getTokenFromCode(code);
    const profile = await outlook.getUserProfile(tokens.access_token);
    const email   = profile.mail || profile.userPrincipalName;
    const user    = q.upsertUser.get(email, profile.displayName, JSON.stringify(tokens));
    if (!q.getSettings.get(user.id)) {
      q.upsertSettings.run(user.id,0,0,0,0,"Meta de ahorro","{}","banco,transaccion,compra,pago,debito,abono,nequi,bancolombia,davivienda,bbva",25,10);
    }
    const appToken = jwt.sign({id:user.id,email:user.email,name:user.name}, process.env.JWT_SECRET, {expiresIn:"30d"});
    res.redirect(`${FE}/app?token=${appToken}&name=${encodeURIComponent(profile.displayName||email)}`);
  } catch(e) { console.error("Auth error:",e); res.redirect(`${FE}?error=auth_failed`); }
});

// ── User ──────────────────────────────────────────────────────────────────
app.get("/api/me", auth, (req,res) => {
  const user = q.getUserById.get(req.user.id);
  const s    = q.getSettings.get(req.user.id) || {};
  res.json({ id:user.id, email:user.email, name:user.name, settings:s, connected:!!user.ms_token });
});

// ── Settings ──────────────────────────────────────────────────────────────
app.put("/api/settings", auth, (req,res) => {
  const s = req.body;
  q.upsertSettings.run(req.user.id, s.credit_limit||0, s.savings_balance||0, s.monthly_income||0,
    s.savings_goal||0, s.savings_goal_name||"Meta", JSON.stringify(s.budgets||{}),
    s.email_filter||"banco,transaccion", s.cut_day||25, s.pay_day||10);
  res.json({ok:true});
});

// ── Transactions ──────────────────────────────────────────────────────────
app.get("/api/transactions", auth, (req,res) => res.json(q.getTx.all(req.user.id)));

app.post("/api/transactions", auth, (req,res) => {
  const {name,amount,category,account,type,date,is_recurring,recurring_name} = req.body;
  if(!name||!amount) return res.status(400).json({error:"Missing fields"});
  q.insertTx.run(req.user.id,name,amount,category||"other",account||"credit",type||"expense",date||new Date().toISOString().split("T")[0],is_recurring?1:0,recurring_name||null,0,null);
  res.json({id:q.getLastInsertId.get().id,ok:true});
});

app.delete("/api/transactions/:id", auth, (req,res) => { q.deleteTx.run(req.params.id,req.user.id); res.json({ok:true}); });

// ── Installments ──────────────────────────────────────────────────────────
app.get("/api/installments", auth, (req,res) => res.json(q.getInstallments.all(req.user.id)));

app.post("/api/installments", auth, (req,res) => {
  const {name,total_amount,months,interest_rate,category,account,start_month} = req.body;
  if(!name||!total_amount||!months) return res.status(400).json({error:"Missing fields"});
  q.insertInstallment.run(req.user.id,name,total_amount,months,interest_rate||0,category||"shopping",account||"credit",start_month||new Date().toISOString().slice(0,7),0);
  res.json({id:q.getLastInsertId.get().id,ok:true});
});

app.delete("/api/installments/:id", auth, (req,res) => { q.deleteInstallment.run(req.params.id,req.user.id); res.json({ok:true}); });

// ── Pending questions ─────────────────────────────────────────────────────
app.get("/api/pending", auth, (req,res) => res.json(q.getPending.all(req.user.id)));

app.post("/api/pending/:id/answer", auth, async (req,res) => {
  const pend = db.prepare("SELECT * FROM pending_questions WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if(!pend) return res.status(404).json({error:"Not found"});
  const data = JSON.parse(pend.parsed_data);
  data.installmentMonths   = parseInt(req.body.months)||1;
  data.interestRate        = parseFloat(req.body.interest_rate)||0;
  data.isInstallment       = data.installmentMonths>1;
  data.needsInstallmentInfo = false;
  await processParsed(req.user.id, data, pend.email_id, data.date);
  q.answerPending.run(JSON.stringify(req.body), pend.id, req.user.id);
  res.json({ok:true});
});

// ── Push notifications ────────────────────────────────────────────────────
app.get("/api/push/vapid-key", (_,res) => res.json({key:process.env.VAPID_PUBLIC_KEY}));

app.post("/api/push/subscribe", auth, (req,res) => {
  const {endpoint,keys} = req.body;
  if(!endpoint||!keys?.p256dh||!keys?.auth) return res.status(400).json({error:"Invalid"});
  q.upsertPushSub.run(req.user.id,endpoint,keys.p256dh,keys.auth);
  res.json({ok:true});
});

app.delete("/api/push/subscribe", auth, (req,res) => { q.deletePushSub.run(req.body.endpoint); res.json({ok:true}); });

// ── Advisor ───────────────────────────────────────────────────────────────
app.post("/api/advisor", auth, async (req,res) => {
  const s    = q.getSettings.get(req.user.id)||{};
  const txs  = q.getTx.all(req.user.id);
  const insts= q.getInstallments.all(req.user.id);
  const cm   = new Date().toISOString().slice(0,7);
  const mTxs = txs.filter(t=>t.date.startsWith(cm));
  const cExp = mTxs.filter(t=>t.type==="expense"&&(t.account==="credit"||t.account==="both")).reduce((s,t)=>s+t.amount,0);
  const iChg = insts.reduce((sum,inst)=>{ const el=mDiff(inst.start_month,cm); return (el>=0&&el<inst.months)?sum+instMonthlyPayment(inst):sum; },0);
  const sInc = txs.filter(t=>t.type==="income"&&(t.account==="savings"||t.account==="both")).reduce((s,t)=>s+t.amount,0);
  const sExp = txs.filter(t=>t.type==="expense"&&(t.account==="savings"||t.account==="both")).reduce((s,t)=>s+t.amount,0);
  const totalInt = insts.reduce((sum,i)=>{ if(i.interest_rate<=0)return sum; const r=i.interest_rate/100; const m=i.total_amount*r*Math.pow(1+r,i.months)/(Math.pow(1+r,i.months)-1); return sum+(m*i.months-i.total_amount); },0);
  const free = (s.monthly_income||0)-(cExp+iChg)-(mTxs.filter(t=>t.type==="expense"&&(t.account==="savings"||t.account==="both")).reduce((x,t)=>x+t.amount,0));
  const fmt  = v=>"$"+Math.round(v).toLocaleString("es-CO");

  const ctx = `Ingreso mensual: ${fmt(s.monthly_income)} | Cupo crédito: ${fmt(s.credit_limit)} | Usado este mes: ${fmt(cExp+iChg)} (${s.credit_limit>0?(((cExp+iChg)/s.credit_limit)*100).toFixed(0):0}%) | Cuotas activas: ${insts.length} — ${fmt(iChg)}/mes | Interés total cuotas: ${fmt(totalInt)} | Saldo ahorros: ${fmt((s.savings_balance||0)+sInc-sExp)} | Meta: ${fmt(s.savings_goal)} — ${s.savings_goal_name} | Dinero libre estimado: ${fmt(free)} | Fecha corte: día ${s.cut_day||25} | Fecha pago: día ${s.pay_day||10}`;

  try { res.json({advice: await getAdvisorResponse(req.body.question, ctx)}); }
  catch { res.status(500).json({error:"Advisor error"}); }
});

// ── Purchase simulator ────────────────────────────────────────────────────
app.post("/api/simulate", auth, async (req,res) => {
  const s    = q.getSettings.get(req.user.id)||{};
  const usage= calcCreditUsage(req.user.id, s);
  const fmt  = v=>"$"+Math.round(v).toLocaleString("es-CO");
  const {name,amount,months,interestRate} = req.body;
  const r    = (interestRate||0)/100;
  const n    = months||1;
  const monthly = r>0?amount*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1):amount/n;

  const ctx  = `Cupo disponible: ${fmt(usage.available)} | Uso actual: ${usage.pct.toFixed(0)}% | Ingreso mensual: ${fmt(s.monthly_income)} | Cuota resultante: ${fmt(monthly)}/mes por ${n} meses`;

  try { res.json({
    analysis: await simulatePurchase({name,amount,months:n,interestRate:interestRate||0}, ctx),
    monthly: Math.round(monthly),
    totalPay: Math.round(monthly*n),
    totalInterest: Math.round(monthly*n-amount),
    newCreditPct: s.credit_limit>0?Math.min(((usage.total+monthly)/s.credit_limit)*100,100):0,
    canAfford: usage.available >= monthly,
  }); } catch { res.status(500).json({error:"Simulator error"}); }
});

// ── Recurring detection ───────────────────────────────────────────────────
app.get("/api/recurring", auth, async (req,res) => {
  const txs = q.getTx.all(req.user.id);
  try { res.json(await detectRecurring(txs)); }
  catch { res.json([]); }
});

// ── Month comparison ──────────────────────────────────────────────────────
app.get("/api/comparison", auth, (req,res) => {
  const txs = q.getTx.all(req.user.id);
  const months = [...new Set(txs.map(t=>t.date.slice(0,7)))].sort().reverse().slice(0,3);
  const result = months.map(mo => {
    const mTxs = txs.filter(t=>t.date.startsWith(mo));
    const byCategory = {};
    mTxs.filter(t=>t.type==="expense").forEach(t=>{ byCategory[t.category]=(byCategory[t.category]||0)+t.amount; });
    return { month:mo, total: mTxs.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0), byCategory };
  });
  res.json(result);
});

// ── Manual sync ───────────────────────────────────────────────────────────
app.post("/api/sync", auth, (req,res) => {
  res.json({ok:true});
  const user = q.getUserById.get(req.user.id);
  syncUser(user).catch(console.error);
});

// ── Health (UptimeRobot pings this to keep Render awake) ──────────────────
app.get("/health", (_,res) => res.json({status:"ok",ts:new Date().toISOString()}));
app.get("/", (_,res) => res.json({status:"Finanzas API v2.0"}));

// ── Cron jobs ─────────────────────────────────────────────────────────────
cron.schedule("*/5 * * * *",  () => syncAll().catch(console.error));                          // Sync emails every 5min
cron.schedule("0 8 * * *",    () => require("./sync").checkDateAlerts?.().catch(console.error)); // Daily alerts 8am
cron.schedule("0 8 * * 1",    () => {                                                          // Weekly report Mondays
  const users = db.prepare("SELECT u.*,s.* FROM users u JOIN settings s ON s.user_id=u.id WHERE u.ms_token IS NOT NULL").all();
  const cm = new Date().toISOString().slice(0,7);
  users.forEach(u => {
    const txs  = q.getTx.all(u.id).filter(t=>t.date.startsWith(cm));
    const spent= txs.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0);
    const pct  = u.credit_limit>0?(spent/u.credit_limit)*100:0;
    const free = (u.monthly_income||0)-spent;
    notify.weeklyReport(u.id, {spent,pct,free});
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Finanzas backend v2 on port ${PORT}`);
  setTimeout(() => syncAll().catch(console.error), 8000);
});
