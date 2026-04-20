"use strict";
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = "claude-haiku-4-5-20251001";

// Ask Claude with automatic retry on overload
async function ask(system, user, maxTokens = 600, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const msg = await client.messages.create({
        model: MODEL, max_tokens: maxTokens,
        system, messages: [{ role: "user", content: user }],
      });
      return msg.content[0].text.trim();
    } catch (e) {
      const overloaded = e.status === 529 || (e.message || "").includes("overloaded");
      if (overloaded && i < retries - 1) {
        const wait = (i + 1) * 4000;
        console.log(`Claude overloaded, retry ${i + 1} in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

// Parse bank email
async function parseEmail(text, date) {
  const d = date || new Date().toISOString().split("T")[0];
  const raw = await ask(
    "Analizas correos bancarios latinoamericanos. Respondes SOLO con JSON válido, sin markdown ni texto extra.",
    `Fecha: ${d}
Texto:
"""${text}"""

Responde exactamente con este JSON:
{
  "isBankEmail": true,
  "found": true,
  "name": "nombre del comercio",
  "amount": 0,
  "category": "food",
  "account": "credit",
  "type": "expense",
  "date": "${d}",
  "isInstallment": false,
  "installmentMonths": null,
  "interestRate": 0,
  "needsInstallmentInfo": false,
  "isRecurring": false,
  "recurringName": null
}

Reglas:
- amount: entero sin puntos ni comas ("1.250.000" = 1250000)
- category: food|transport|entertainment|health|shopping|services|education|other
- account: credit (si menciona tarjeta/cupo) | savings (si menciona cuenta/débito/ahorros)
- type: expense (compra/pago/débito) | income (abono/nómina/consignación)
- isInstallment: true si dice "cuotas" o "diferido"
- needsInstallmentInfo: true si es cuotas pero no dice cuántas
- isRecurring: true si es Netflix, Spotify, gym, suscripción mensual
- Si NO es correo bancario: {"isBankEmail":false,"found":false}`,
    450
  );
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    console.error("JSON parse failed:", raw.slice(0, 200));
    return { isBankEmail: false, found: false };
  }
}

// Financial advisor
async function getAdvisorResponse(question, ctx) {
  return ask(
    "Eres asesor financiero personal experto en Colombia. Das consejos concretos, empáticos y accionables. Máximo 4 párrafos. Sin listas largas.",
    `Situación financiera del usuario:\n${ctx}\n\nPregunta: ${question || "Dame un análisis completo y recomendaciones para gestionar mejor mis finanzas."}`,
    700
  );
}

// Purchase simulator
async function simulatePurchase(params, ctx) {
  const { name, amount, months, interestRate } = params;
  const r = (interestRate || 0) / 100;
  const n = months || 1;
  const monthly  = r > 0 ? amount * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1) : amount / n;
  const totalPay = monthly * n;
  const totalInt = totalPay - amount;
  const fmtCO    = v => "$" + Math.round(v).toLocaleString("es-CO");

  return ask(
    "Eres asesor financiero colombiano. Analiza si esta compra es viable. Sé directo y honesto. Máximo 3 párrafos cortos.",
    `Situación actual:\n${ctx}

Compra que quiere hacer:
- Producto: ${name}
- Valor: ${fmtCO(amount)}
- Cuotas: ${n} meses
- Interés mensual: ${interestRate || 0}%
- Cuota mensual: ${fmtCO(monthly)}
- Total a pagar: ${fmtCO(totalPay)}
- Interés total: ${fmtCO(totalInt)}

¿Puede permitírselo? ¿Cómo afecta su cupo los próximos meses? ¿Es mejor de contado o a cuotas?`,
    500
  );
}

// Detect recurring charges
async function detectRecurring(transactions) {
  if (transactions.length < 5) return [];
  const sample = transactions.slice(0, 40).map(t => `${t.date}: ${t.name} $${t.amount}`).join("\n");
  const raw = await ask(
    "Identificas gastos recurrentes. Respondes SOLO con JSON array, sin texto extra.",
    `Transacciones:\n${sample}\n\nIdentifica suscripciones o servicios que se repiten mensualmente. JSON array:\n[{"name":"nombre","amount":monto_promedio,"frequency":"monthly"}]\nSi no hay ninguno, responde: []`,
    300
  );
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return [];
  }
}

module.exports = { parseEmail, getAdvisorResponse, simulatePurchase, detectRecurring };
