"use strict";
require("isomorphic-fetch");

const SCOPES       = ["https://graph.microsoft.com/Mail.Read","offline_access","openid","profile","email"];
const TENANT       = () => process.env.AZURE_TENANT_ID || "common";
const TOKEN_URL    = () => `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/token`;
const GRAPH        = "https://graph.microsoft.com/v1.0";

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id:     process.env.AZURE_CLIENT_ID,
    response_type: "code",
    redirect_uri:  process.env.AZURE_REDIRECT_URI,
    scope:         SCOPES.join(" "),
    response_mode: "query",
    prompt:        "consent",
  });
  return `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/authorize?${params}`;
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL(), {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      ...body,
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

const getTokenFromCode   = code         => postToken({ code, redirect_uri: process.env.AZURE_REDIRECT_URI, grant_type: "authorization_code", scope: SCOPES.join(" ") });
const refreshAccessToken = refreshToken => postToken({ refresh_token: refreshToken, grant_type: "refresh_token", scope: SCOPES.join(" ") });

async function graphGet(accessToken, path, params = {}) {
  const url = new URL(`${GRAPH}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  return res.json();
}

const getUserProfile = token => graphGet(token, "/me", { $select: "displayName,mail,userPrincipalName" });

async function fetchBankEmails(accessToken, filterKeywords, sinceDateTime) {
  const kws = (filterKeywords || "banco,transaccion,compra").split(",").map(k => k.trim()).filter(Boolean);
  const subjectFilter = kws.slice(0, 4).map(k => `contains(subject,'${k}')`).join(" or ");
  let filter = `(${subjectFilter})`;
  if (sinceDateTime) filter += ` and receivedDateTime ge ${new Date(sinceDateTime).toISOString()}`;

  try {
    const data = await graphGet(accessToken, "/me/messages", {
      $filter: filter, $select: "id,subject,body,from,receivedDateTime", $top: "25", $orderby: "receivedDateTime desc",
    });
    return data.value || [];
  } catch {
    const data = await graphGet(accessToken, "/me/messages", {
      $select: "id,subject,body,from,receivedDateTime", $top: "30", $orderby: "receivedDateTime desc",
    });
    return data.value || [];
  }
}

function extractEmailText(msg) {
  const subject = msg.subject || "";
  let body = msg.body?.content || "";
  if (msg.body?.contentType !== "text") {
    body = body
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s+/g, " ").trim();
  }
  return `Asunto: ${subject}\nDe: ${msg.from?.emailAddress?.address || ""}\n\n${body.slice(0, 2500)}`;
}

module.exports = { getAuthUrl, getTokenFromCode, refreshAccessToken, getUserProfile, fetchBankEmails, extractEmailText };
