"use strict";
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(process.env.DB_PATH || path.join(__dirname, "finanzas.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    name       TEXT,
    ms_token   TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    credit_limit      REAL DEFAULT 0,
    savings_balance   REAL DEFAULT 0,
    monthly_income    REAL DEFAULT 0,
    savings_goal      REAL DEFAULT 0,
    savings_goal_name TEXT DEFAULT 'Meta de ahorro',
    budgets           TEXT DEFAULT '{}',
    email_filter      TEXT DEFAULT 'banco,transaccion,compra,pago,debito,abono,nequi,bancolombia,davivienda,bbva',
    cut_day           INTEGER DEFAULT 25,
    pay_day           INTEGER DEFAULT 10,
    last_email_sync   TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    amount           REAL NOT NULL,
    category         TEXT DEFAULT 'other',
    account          TEXT DEFAULT 'credit',
    type             TEXT DEFAULT 'expense',
    date             TEXT NOT NULL,
    is_recurring     INTEGER DEFAULT 0,
    recurring_name   TEXT,
    from_email       INTEGER DEFAULT 0,
    email_message_id TEXT,
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS installments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    total_amount  REAL NOT NULL,
    months        INTEGER NOT NULL,
    interest_rate REAL DEFAULT 0,
    category      TEXT DEFAULT 'shopping',
    account       TEXT DEFAULT 'credit',
    start_month   TEXT NOT NULL,
    from_email    INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_questions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    email_id    TEXT NOT NULL,
    parsed_data TEXT NOT NULL,
    question    TEXT NOT NULL,
    answered    INTEGER DEFAULT 0,
    answer      TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT UNIQUE NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS processed_emails (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    message_id   TEXT NOT NULL,
    processed_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, message_id)
  );
`);

const q = {
  getUserByEmail:      db.prepare("SELECT * FROM users WHERE email=?"),
  getUserById:         db.prepare("SELECT * FROM users WHERE id=?"),
  getAllConnected:      db.prepare("SELECT u.* FROM users u INNER JOIN settings s ON s.user_id=u.id WHERE u.ms_token IS NOT NULL"),
  upsertUser:          db.prepare("INSERT INTO users(email,name,ms_token) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,ms_token=excluded.ms_token RETURNING *"),
  getSettings:         db.prepare("SELECT * FROM settings WHERE user_id=?"),
  upsertSettings:      db.prepare(`INSERT INTO settings(user_id,credit_limit,savings_balance,monthly_income,savings_goal,savings_goal_name,budgets,email_filter,cut_day,pay_day)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    credit_limit=excluded.credit_limit,savings_balance=excluded.savings_balance,
    monthly_income=excluded.monthly_income,savings_goal=excluded.savings_goal,
    savings_goal_name=excluded.savings_goal_name,budgets=excluded.budgets,
    email_filter=excluded.email_filter,cut_day=excluded.cut_day,pay_day=excluded.pay_day`),
  updateLastSync:      db.prepare("UPDATE settings SET last_email_sync=? WHERE user_id=?"),
  getTx:               db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY date DESC,id DESC LIMIT 500"),
  insertTx:            db.prepare("INSERT INTO transactions(user_id,name,amount,category,account,type,date,is_recurring,recurring_name,from_email,email_message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)"),
  deleteTx:            db.prepare("DELETE FROM transactions WHERE id=? AND user_id=?"),
  getInstallments:     db.prepare("SELECT * FROM installments WHERE user_id=? ORDER BY id DESC"),
  insertInstallment:   db.prepare("INSERT INTO installments(user_id,name,total_amount,months,interest_rate,category,account,start_month,from_email) VALUES(?,?,?,?,?,?,?,?,?)"),
  deleteInstallment:   db.prepare("DELETE FROM installments WHERE id=? AND user_id=?"),
  getPending:          db.prepare("SELECT * FROM pending_questions WHERE user_id=? AND answered=0 ORDER BY created_at DESC"),
  insertPending:       db.prepare("INSERT INTO pending_questions(user_id,email_id,parsed_data,question) VALUES(?,?,?,?)"),
  answerPending:       db.prepare("UPDATE pending_questions SET answered=1,answer=? WHERE id=? AND user_id=?"),
  getPushSubs:         db.prepare("SELECT * FROM push_subscriptions WHERE user_id=?"),
  upsertPushSub:       db.prepare("INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth"),
  deletePushSub:       db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?"),
  isEmailProcessed:    db.prepare("SELECT id FROM processed_emails WHERE user_id=? AND message_id=?"),
  markEmailProcessed:  db.prepare("INSERT OR IGNORE INTO processed_emails(user_id,message_id) VALUES(?,?)"),
  lastInsertId:        db.prepare("SELECT last_insert_rowid() as id"),
};

module.exports = { db, q };
