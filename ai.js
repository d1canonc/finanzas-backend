// ai.js — Claude AI for email parsing, advisor, simulator, recurring detection
const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function ask(system, user, maxTokens = 600) {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514", max_tokens: maxTokens,
    system, messages: [{ role: "user", content: user }]
  });
  return msg.content[0].text.trim();
}

// ── Email parser ──────────────────────────────────────────────────────────
async function parseEmail(text, date) {
  const raw = await ask(
    "Analizas correos bancarios latinoamericanos. Respondes SOLO JSON válido sin markdown.",
    `Fecha del correo: ${date || new Date().toISOString().split("T")[0]}
Texto:
"""${text}"""

JSON exacto (sin texto extra):
{
  "isBankEmail": bool,
  "found": bool,
  "name": "comercio o descripción",
  "amount": numero_entero_pesos,
  "category": "food|transport|entertainment|health|shopping|services|education|other",
  "account": "credit|savings",
  "type": "expense|income",
  "date": "YYYY-MM-DD",
  "isInstallment": bool,
  "installmentMonths": numero_o_null,
  "hasInterest": bool,
  "interestRate": porcentaje_mensual_o_0,
  "needsInstallmentInfo": bool,
  "isRecurring": bool,
  "recurringName": "nombre_servicio_o_null"
}
Reglas: "1.250.000"→1250000 | compra/pago/débito→expense | abono/nómina→income | tarjeta→credit | ahorros/débito→savings | cuotas sin número→needsInstallmentInfo:true | Netflix/Spotify/gym/suscripción→isRecurring:true`,
    400
  );
  try {
    return JSON.parse(raw.replace(/```json|```/g,"").trim());
  } catch { return { isBankEmail: false, found: false }; }
}

// ── Financial advisor ─────────────────────────────────────────────────────
async function getAdvisorResponse(question, ctx) {
  return ask(
    "Eres asesor financiero personal experto en Colombia. Consejos concretos, empáticos, accionables. Máximo 4 párrafos cortos. Sin listas largas.",
    `Situación financiera:\n${ctx}\n\nPregunta: ${question || "Dame un análisis completo y recomendaciones."}`
  , 700);
}

// ── Purchase simulator ────────────────────────────────────────────────────
async function simulatePurchase(params, ctx) {
  const { name, amount, months, interestRate } = params;
  const r = (interestRate || 0) / 100;
  const n = months || 1;
  const monthly = r > 0
    ? amount * r * Math.pow(1+r,n) / (Math.pow(1+r,n)-1)
    : amount / n;
  const totalPay   = monthly * n;
  const totalInt   = totalPay - amount;

  return ask(
    "Eres asesor financiero colombiano. Analiza si esta compra es viable. Sé directo y honesto. Máximo 3 párrafos.",
    `Situación actual:\n${ctx}

Compra que quiere hacer:
- Producto: ${name}
- Valor: $${Math.round(amount).toLocaleString("es-CO")}
- Cuotas: ${n} meses
- Interés mensual: ${interestRate || 0}%
- Cuota mensual resultante: $${Math.round(monthly).toLocaleString("es-CO")}
- Total a pagar: $${Math.round(totalPay).toLocaleString("es-CO")}
- Interés total: $${Math.round(totalInt).toLocaleString("es-CO")}

¿Puede permitírselo? ¿Cómo afecta su cupo? ¿Recomendarías hacerlo? ¿Sería mejor de contado o a cuotas?`
  , 500);
}

// ── Detect recurring charges ──────────────────────────────────────────────
async function detectRecurring(transactions) {
  if (transactions.length < 10) return [];
  const sample = transactions.slice(0,50).map(t=>`${t.date}: ${t.name} $${t.amount}`).join("\n");
  const raw = await ask(
    "Analizas patrones de gastos. Respondes SOLO JSON array.",
    `Transacciones:\n${sample}\n\nIdentifica gastos recurrentes mensuales (suscripciones, servicios, membresías). JSON array:\n[{"name":"nombre","amount":monto_promedio,"frequency":"monthly"}]`,
    300
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return []; }
}

module.exports = { parseEmail, getAdvisorResponse, simulatePurchase, detectRecurring };
