#!/usr/bin/env node
/**
 * notify.js — tiny brief sender (ES module).
 *
 * Reads .env and delivers a message over the first configured channel:
 *   1. Telegram  (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
 *   2. Gmail     (GMAIL_USER + GMAIL_APP_PASSWORD, needs `npm install nodemailer`)
 *   3. Terminal  (fallback — just prints)
 *
 * Usage:
 *   node scripts/notify.js "your text here"
 *   node scripts/notify.js --photo path/to.png "optional caption (<=1024 chars)"
 *   echo "piped text" | node scripts/notify.js
 *
 * Advisory tool only — this sends text/images. It never trades.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ---- arg parsing: pull out --photo <path>, rest is the message ----
const argv = process.argv.slice(2);
let photoPath = null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--photo') { photoPath = argv[++i]; }
  else rest.push(argv[i]);
}

function readMessage() {
  const arg = rest.join(' ').trim();
  if (arg) return Promise.resolve(arg);
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function tgCall(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, body);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`Telegram ${method} error: ${JSON.stringify(json)}`);
  return json.result;
}

async function sendTelegramText(token, chatId, text) {
  const r = await tgCall(token, 'sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
  return r.message_id;
}

async function sendTelegramPhoto(token, chatId, file, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) { form.append('caption', caption.slice(0, 1024)); form.append('parse_mode', 'Markdown'); }
  const buf = fs.readFileSync(file);
  form.append('photo', new Blob([buf]), path.basename(file));
  const r = await tgCall(token, 'sendPhoto', { method: 'POST', body: form });
  return r.message_id;
}

async function sendGmail(user, pass, text) {
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; }
  catch { throw new Error('Gmail configured but nodemailer is not installed. Run: npm install nodemailer'); }
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  const info = await transporter.sendMail({ from: user, to: user, subject: 'TradingView Brief', text });
  return info.messageId;
}

async function main() {
  const text = await readMessage();
  if (!text && !photoPath) {
    console.error('No message provided. Usage: node scripts/notify.js "your text"');
    process.exit(1);
  }
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;

  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      if (photoPath) {
        const id = await sendTelegramPhoto(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, photoPath, text);
        console.log(`✓ Sent photo via Telegram (message_id ${id})`);
      } else {
        const id = await sendTelegramText(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, text);
        console.log(`✓ Sent via Telegram (message_id ${id})`);
      }
      return;
    }
    if (GMAIL_USER && GMAIL_APP_PASSWORD) {
      const id = await sendGmail(GMAIL_USER, GMAIL_APP_PASSWORD, text);
      console.log(`✓ Sent via Gmail (${id})`);
      return;
    }
    console.log('— No delivery channel configured; printing below —\n');
    console.log(text || `[photo: ${photoPath}]`);
  } catch (err) {
    console.error(`✗ Delivery failed: ${err.message}`);
    process.exit(1);
  }
}

main();
