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

// Renders the digest text as a styled PNG image using puppeteer-core.
// Requires Chromium installed on the system (yum install chromium).
async function generateDigestImage(text) {
  const puppeteer = await import('puppeteer-core');
  const { existsSync } = await import('fs');

  // Find Chromium binary
  const chromiumPaths = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium'
  ];
  const execPath = chromiumPaths.find(p => existsSync(p));
  if (!execPath) {
    throw new Error('Chromium not found. Install with: yum install -y chromium');
  }

  const html = buildDigestHtml(text);

  const browser = await puppeteer.default.launch({
    executablePath: execPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const bodyHandle = await page.$('body');
    const { width, height } = await bodyHandle.boundingBox();
    await page.setViewport({
      width: Math.ceil(width),
      height: Math.ceil(height),
      deviceScaleFactor: 2
    });

    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height) }
    });

    return buffer;
  } finally {
    await browser.close();
  }
}

// Converts digest plain text to a styled HTML page for screenshot.
function buildDigestHtml(text) {
  // Escape HTML entities then apply lightweight formatting
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Section headers (all-caps lines) → styled headings
  const formatted = escaped.replace(
    /^(PODCASTS|X\s*\/\s*TWITTER|OFFICIAL\s*BLOGS|BLOGS)$/gm,
    '<h2>$1</h2>'
  );

  // Title line → styled header
  const withTitle = formatted.replace(
    /^(AI Builders Digest\s*—.+)$/m,
    '<h1>$1</h1>'
  );

  // URLs → clickable links
  const withLinks = withTitle.replace(
    /(https:\/\/[^\s<]+)/g,
    '<a href="$1">$1</a>'
  );

  // Convert double newlines to paragraph breaks, single to <br>
  const paragraphs = withLinks
    .split(/\n\n+/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Noto Sans CJK SC", "WenQuanYi Micro Hei", "Microsoft YaHei",
                 "PingFang SC", "Hiragino Sans GB", sans-serif;
    background: #fff;
    padding: 40px 48px;
    width: 800px;
    color: #1a1a1a;
    -webkit-font-smoothing: antialiased;
  }
  h1 {
    font-size: 22px;
    font-weight: 700;
    color: #1677ff;
    border-bottom: 2px solid #1677ff;
    padding-bottom: 12px;
    margin-bottom: 28px;
  }
  h2 {
    font-size: 15px;
    font-weight: 700;
    color: #fff;
    background: #1677ff;
    display: inline-block;
    padding: 4px 14px;
    border-radius: 3px;
    margin: 28px 0 14px 0;
    letter-spacing: 1px;
  }
  p {
    font-size: 14px;
    line-height: 1.7;
    margin-bottom: 12px;
    color: #333;
  }
  a {
    color: #1677ff;
    text-decoration: none;
    word-break: break-all;
  }
  /* Footer line */
  p:last-child {
    color: #999;
    font-size: 12px;
    border-top: 1px solid #eee;
    padding-top: 16px;
    margin-top: 24px;
  }
</style>
</head>
<body>
${paragraphs}
</body>
</html>`;
}

// Uploads an image to Feishu and returns the image_key.
// Requires the im:resource permission on the Feishu app.
async function feishuUploadImage(token, imageBuffer) {
  const boundary = '----FeishuBoundary' + Date.now();
  const headerStr = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="image_type"',
    '',
    'message',
    `--${boundary}`,
    'Content-Disposition: form-data; name="image"; filename="digest.png"',
    'Content-Type: image/png',
    '',
    ''
  ].join('\r\n');
  const footerStr = `\r\n--${boundary}--`;

  const headerBytes = new TextEncoder().encode(headerStr);
  const footerBytes = new TextEncoder().encode(footerStr);
  const body = new Uint8Array(headerBytes.length + imageBuffer.length + footerBytes.length);
  body.set(headerBytes, 0);
  body.set(imageBuffer, headerBytes.length);
  body.set(footerBytes, headerBytes.length + imageBuffer.length);

  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Feishu image upload failed: ${err.msg || JSON.stringify(err)}`);
  }

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Feishu image upload error: ${data.msg || JSON.stringify(data)}`);
  }

  return data.data.image_key;
}

// Sends an image message to a Feishu group.
async function feishuSendImage(token, chatId, imageKey) {
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
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey })
      })
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Feishu send image failed: ${err.msg || JSON.stringify(err)}`);
  }

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Feishu send image error: ${data.msg || JSON.stringify(data)}`);
  }
}

// Sends the digest to Feishu as a rendered long-image.
// Falls back to a compact text card if image generation fails (e.g. no Chromium).
async function sendFeishu(text, token, chatId) {
  try {
    const imageBuffer = await generateDigestImage(text);
    const imageKey = await feishuUploadImage(token, imageBuffer);
    await feishuSendImage(token, chatId, imageKey);
  } catch (imgErr) {
    console.error(`[feishu] Image delivery failed, falling back to text card: ${imgErr.message}`);
    // Fallback: compact card with the first portion of the digest
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '📰 AI Builders Digest' },
        template: 'blue'
      },
      elements: [{ tag: 'markdown', content: text.slice(0, 25000) }]
    };
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
          content: JSON.stringify(card)
        })
      }
    );
    if (!res.ok) throw new Error('Feishu fallback send failed');
  }
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
