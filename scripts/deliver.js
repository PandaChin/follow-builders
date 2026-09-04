#!/usr/bin/env node

// ============================================================================
// Follow Builders — Delivery Script
// ============================================================================
// Sends a digest to the user via their chosen delivery method.
// Supports: Telegram bot, Email (via Resend), Feishu (Lark) bot, or stdout.
//
// Usage:
//   echo "digest text" | node deliver.js
//   node deliver.js --message "digest text"
//   node deliver.js --file /path/to/digest.txt
//
// The script reads delivery config from ~/.follow-builders/config.json
// and API keys from ~/.follow-builders/.env
//
// Delivery methods:
//   - "telegram": sends via Telegram Bot API (needs TELEGRAM_BOT_TOKEN + chat ID)
//   - "email": sends via Resend API (needs RESEND_API_KEY + email address)
//   - "feishu": sends via Feishu/Lark Open API (needs FEISHU_APP_ID + FEISHU_APP_SECRET + chat ID)
//   - "stdout" (default): just prints to terminal
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

// -- Read input --------------------------------------------------------------

// The digest text can come from stdin, --message flag, or --file flag
async function getDigestText() {
  const args = process.argv.slice(2);

  // Check --message flag
  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return args[msgIdx + 1];
  }

  // Check --file flag
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return await readFile(args[fileIdx + 1], 'utf-8');
  }

  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Telegram Delivery -------------------------------------------------------

// Sends the digest via Telegram Bot API.
// The user creates a bot via @BotFather and provides the token.
// The chat ID is obtained when the user sends their first message to the bot.
async function sendTelegram(text, botToken, chatId) {
  // Telegram has a 4096 character limit per message.
  // If the digest is longer, we split it into chunks.
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      // If Markdown parsing fails, retry without parse_mode
      if (err.description && err.description.includes("can't parse")) {
        await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
      } else {
        throw new Error(`Telegram API error: ${err.description}`);
      }
    }

    // Small delay between chunks to avoid rate limiting
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Email Delivery (Resend) -------------------------------------------------

// Sends the digest via Resend's email API.
// The user provides their own Resend API key and email address.
async function sendEmail(text, apiKey, toEmail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [toEmail],
      subject: `AI Builders Digest — ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })}`,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

// -- Feishu/Lark Delivery ---------------------------------------------------

// Gets a tenant_access_token from Feishu Open Platform.
// The app must have the im:message:send_as_bot permission enabled.
async function getFeishuToken(appId, appSecret) {
  const res = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    }
  );

  if (!res.ok) {
    throw new Error(`Feishu auth failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Feishu auth error: ${data.msg || JSON.stringify(data)}`);
  }

  return data.tenant_access_token;
}

// Helper: send a single Feishu interactive card message to a group.
async function feishuSendCard(token, chatId, cardObj) {
  const res = await fetch(
    'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(cardObj)
      })
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Feishu API error: ${err.msg || JSON.stringify(err)}`);
  }

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Feishu send error: ${data.msg || JSON.stringify(data)}`);
  }
}

// Builds a card with a compact summary on top and the full digest inside
// a collapsible (collapsed) block. Users see the summary and can click to
// expand the full content — all within a single card message.
function buildFeishuDigestCard(text) {
  const lines = text.split('\n');
  const titleLine = lines.find(l => l.trim().length > 0) || 'AI Builders Digest';
  const dateMatch = titleLine.match(/—\s*(.+)$/);
  const date = dateMatch ? dateMatch[1].trim() : '';

  // Collect first few meaningful lines as preview
  const previewLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === titleLine.trim()) continue;
    if (trimmed.startsWith('http')) continue;
    if (trimmed.startsWith('Generated through')) break;
    previewLines.push(trimmed);
    if (previewLines.join('\n').length > 300) break;
  }

  // Stats
  const podcastCount = (text.match(/PODCASTS|PODCAST/gi) || []).length > 0 ? 1 : 0;
  const tweetSection = text.match(/X\s*\/\s*TWITTER/i) ? 1 : 0;
  const blogSection = text.match(/OFFICIAL\s*BLOGS|BLOGS/i) ? 1 : 0;
  const urlCount = (text.match(/https:\/\/(x\.com|youtube\.com|anthropic\.com|claude\.com)/g) || []).length;

  const stats = [];
  if (urlCount > 0) stats.push(`**${urlCount}** 条内容来源`);
  if (podcastCount) stats.push('播客更新');
  if (tweetSection) stats.push('X/Twitter 动态');
  if (blogSection) stats.push('官方博客');

  const preview = previewLines.slice(0, 5).map(l =>
    l.length > 60 ? l.slice(0, 57) + '...' : l
  ).join('\n');

  const summaryMd = [
    stats.length > 0 ? stats.join(' · ') : '',
    '',
    preview ? '**本期亮点：**' : '',
    preview
  ].filter(l => l !== null).join('\n');

  // Full digest goes inside the collapsible block.
  // Feishu collapsed body limit is ~50KB; truncate if needed.
  const fullContent = text.length > 48000 ? text.slice(0, 48000) + '\n\n...(内容过长已截断)' : text;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📰 AI Builders Digest — ${date}` },
      template: 'blue'
    },
    elements: [
      { tag: 'markdown', content: summaryMd },
      {
        tag: 'collapsed',
        header: {
          title: { tag: 'plain_text', content: '📖 展开查看完整内容' },
          template: 'grey'
        },
        border: { color: 'grey' },
        body: {
          elements: [
            { tag: 'markdown', content: fullContent }
          ]
        }
      }
    ]
  };
}

// Sends the digest to Feishu as a single card with collapsible full content.
// The card shows a compact summary; users click to expand the full digest.
async function sendFeishu(text, token, chatId) {
  const card = buildFeishuDigestCard(text);
  await feishuSendCard(token, chatId, card);
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Load env and config
  loadEnv({ path: ENV_PATH });

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const delivery = config.delivery || { method: 'stdout' };
  const digestText = await getDigestText();

  if (!digestText || digestText.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest text' }));
    return;
  }

  try {
    switch (delivery.method) {
      case 'telegram': {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = delivery.chatId;
        if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
        if (!chatId) throw new Error('delivery.chatId not found in config.json');
        await sendTelegram(digestText, botToken, chatId);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'telegram',
          message: 'Digest sent to Telegram'
        }));
        break;
      }

      case 'email': {
        const apiKey = process.env.RESEND_API_KEY;
        const toEmail = delivery.email;
        if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
        if (!toEmail) throw new Error('delivery.email not found in config.json');
        await sendEmail(digestText, apiKey, toEmail);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'email',
          message: `Digest sent to ${toEmail}`
        }));
        break;
      }

      case 'feishu': {
        const appId = process.env.FEISHU_APP_ID;
        const appSecret = process.env.FEISHU_APP_SECRET;
        if (!appId) throw new Error('FEISHU_APP_ID not found in .env');
        if (!appSecret) throw new Error('FEISHU_APP_SECRET not found in .env');
        if (!delivery.chatId) throw new Error('delivery.chatId not found in config.json');
        // chatId can be a single string or an array of strings
        const chatIds = Array.isArray(delivery.chatId) ? delivery.chatId : [delivery.chatId];
        const feishuToken = await getFeishuToken(appId, appSecret);
        for (const id of chatIds) {
          await sendFeishu(digestText, feishuToken, id);
        }
        console.log(JSON.stringify({
          status: 'ok',
          method: 'feishu',
          message: `Digest sent to ${chatIds.length} Feishu chat(s)`
        }));
        break;
      }

      case 'stdout':
      default:
        // Just print to terminal — the agent or OpenClaw handles delivery
        console.log(digestText);
        break;
    }
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      method: delivery.method,
      message: err.message
    }));
    process.exit(1);
  }
}

main();
