const TelegramBotPackage = require('node-telegram-bot-api');
const TelegramBot = typeof TelegramBotPackage === 'function'
  ? TelegramBotPackage
  : (TelegramBotPackage.default || TelegramBotPackage.TelegramBot || TelegramBotPackage);
const { registerUser, findUser } = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || '@sparky_channel';
const TELEGRAM_CHANNEL_URL = process.env.TELEGRAM_CHANNEL_URL || 'https://t.me/sparky_channel';
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || 'https://www.instagram.com/sparky.drip';
const WEB_URL = process.env.WEB_URL || 'http://localhost:3000';

let botInstance = null;

// User conversation state: Map<userId, { step: 'awaiting_username' | 'awaiting_password', username?: string }>
const userStates = new Map();

function isValidTelegramUrl(u) {
  if (!u || typeof u !== 'string') return false;
  // Telegram rejects localhost and 127.0.0.1 in inline keyboard URLs
  if (u.includes('localhost') || u.includes('127.0.0.1')) return false;
  return u.startsWith('https://') || u.startsWith('http://');
}

function startTelegramBot() {
  if (!BOT_TOKEN) {
    console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN not provided in .env. Bot is in standby mode.');
    return null;
  }

  if (botInstance) return botInstance;

  try {
    botInstance = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('[Telegram Bot] Telegram Access Bot initialized and polling...');

    // /start command
    botInstance.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      userStates.delete(chatId);

      const welcomeText =
        `👋 *Welcome to V SPARKY Access Portal Bot!*\n\n` +
        `Get your *3-Day VIP Access Key* for Grand Theft Auto V Web (Story & Sandbox modes).\n\n` +
        `📋 *Complete the two steps below to unlock your credentials:*\n\n` +
        `1️⃣ *Follow Developer on Instagram:* [Follow @sparky.drip](${INSTAGRAM_URL})\n` +
        `2️⃣ *Join our Telegram Channel:* [Click to Join Channel](${TELEGRAM_CHANNEL_URL})\n\n` +
        `👇 *After completing both steps, click 'Verify Follow' below:*`;

      const inlineButtons = [];

      if (isValidTelegramUrl(INSTAGRAM_URL)) {
        inlineButtons.push([{ text: '📸 1. Follow Developer on Instagram', url: INSTAGRAM_URL }]);
      }
      if (isValidTelegramUrl(TELEGRAM_CHANNEL_URL)) {
        inlineButtons.push([{ text: '📢 2. Join Telegram Channel', url: TELEGRAM_CHANNEL_URL }]);
      }

      inlineButtons.push([{ text: '✅ Verify Follow & Get Key', callback_data: 'verify_follow' }]);

      botInstance.sendMessage(chatId, welcomeText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineButtons },
        disable_web_page_preview: true
      }).catch(err => console.error('[Telegram Bot] Welcome message error:', err.message));
    });

    // Handle Callback Queries (Verify Follow)
    botInstance.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const userId = query.from.id;

      if (query.data === 'verify_follow') {
        let isFollowingChannel = true;

        // Verify Telegram channel membership if channel is configured with username or ID
        if (TELEGRAM_CHANNEL && !TELEGRAM_CHANNEL.includes('sparky_channel_placeholder')) {
          try {
            const member = await botInstance.getChatMember(TELEGRAM_CHANNEL, userId);
            const validStatuses = ['creator', 'administrator', 'member', 'restricted'];
            if (!validStatuses.includes(member.status)) {
              isFollowingChannel = false;
            }
          } catch (err) {
            // Note: If bot is not admin in the channel, member lookup is not permitted by Telegram API.
            // In that case, log note and allow user to proceed without blocking them.
            console.warn('[Telegram Bot] Channel check note:', err.message);
          }
        }

        if (!isFollowingChannel) {
          botInstance.answerCallbackQuery(query.id, {
            text: '⚠️ You must join the Telegram channel first!',
            show_alert: true
          }).catch(() => {});
          return;
        }

        botInstance.answerCallbackQuery(query.id, { text: 'Verification successful! ✅' }).catch(() => {});

        // Set state to await username
        userStates.set(chatId, { step: 'awaiting_username' });

        botInstance.sendMessage(
          chatId,
          `✅ *Verification Confirmed!*\n\n` +
          `👤 *Enter a username you want to set:*`,
          { parse_mode: 'Markdown' }
        ).catch(err => console.error('[Telegram Bot] Send error:', err.message));
      }
    });

    // Handle text messages for username and password entry
    botInstance.on('message', async (msg) => {
      if (!msg.text || msg.text.startsWith('/')) return;

      const chatId = msg.chat.id;
      const state = userStates.get(chatId);
      if (!state) return;

      const text = msg.text.trim();

      // Step 1: Awaiting Username
      if (state.step === 'awaiting_username') {
        if (text.length < 3 || text.length > 20) {
          botInstance.sendMessage(chatId, '⚠️ Username must be between 3 and 20 characters. Please try another:').catch(() => {});
          return;
        }

        if (!/^[a-zA-Z0-9_]+$/.test(text)) {
          botInstance.sendMessage(chatId, '⚠️ Username can only contain letters, numbers, and underscores (_). Try another:').catch(() => {});
          return;
        }

        // Check if username is already taken by someone else
        const existing = await findUser(text);
        if (existing && existing.telegramId && existing.telegramId !== String(msg.from.id)) {
          botInstance.sendMessage(chatId, `⚠️ Username *${text}* is already taken. Please choose another username:`, { parse_mode: 'Markdown' }).catch(() => {});
          return;
        }

        // Save username in state and prompt for password
        state.username = text;
        state.step = 'awaiting_password';
        userStates.set(chatId, state);

        botInstance.sendMessage(
          chatId,
          `👍 Username set to *${text}*.\n\n` +
          `🔑 *Now enter a Password for your account (minimum 6 characters):*`,
          { parse_mode: 'Markdown' }
        ).catch(err => console.error('[Telegram Bot] Send error:', err.message));
        return;
      }

      // Step 2: Awaiting Password
      if (state.step === 'awaiting_password') {
        if (text.length < 6) {
          botInstance.sendMessage(chatId, '⚠️ Password must be at least 6 characters long. Please enter a valid password:').catch(() => {});
          return;
        }

        const username = state.username;
        const password = text;

        try {
          const result = await registerUser({
            username: username,
            password: password,
            telegramId: msg.from.id,
            telegramUsername: msg.from.username,
            daysValid: 3
          });

          userStates.delete(chatId);

          const expiryDateStr = new Date(result.user.expiresAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          });

          const successMessage =
            `🎉 *ACCESS GRANTED! Account Created Successfully!*\n\n` +
            `👤 *Username:* \`${username}\`\n` +
            `🔑 *Password:* \`${password}\`\n` +
            `⏳ *Validity:* *3 Days* (Valid until: *${expiryDateStr}*)\n\n` +
            `⚠️ *Key Notice: This key is valid for 3 days. Once expired, you can generate a new one right here.*\n\n` +
            `🌐 *Login Portal:* ${WEB_URL}\n\n` +
            `👉 *You can now log in on the web portal to play GTA V Web!*`;

          const sendOptions = { parse_mode: 'Markdown' };

          // Only add inline keyboard button if WEB_URL is a valid public URL
          if (isValidTelegramUrl(WEB_URL)) {
            sendOptions.reply_markup = {
              inline_keyboard: [
                [{ text: '🚀 Open GTA V Web Portal', url: WEB_URL }]
              ]
            };
          }

          botInstance.sendMessage(chatId, successMessage, sendOptions).catch(err => {
            console.error('[Telegram Bot] Send confirmation error:', err.message);
          });

          console.log(`[Telegram Bot] User ${username} registered with 3-day key in MongoDB.`);
        } catch (err) {
          console.error('[Telegram Bot] Registration error:', err);
          botInstance.sendMessage(chatId, '❌ An error occurred while creating your account. Please try again with /start').catch(() => {});
          userStates.delete(chatId);
        }
      }
    });

    botInstance.on('polling_error', (err) => {
      // Suppress spammy polling errors on invalid token
      if (err.code === 'EFATAL' || err.message.includes('401')) {
        console.warn('[Telegram Bot] Polling warning: Please check your TELEGRAM_BOT_TOKEN.');
      }
    });

    return botInstance;
  } catch (e) {
    console.error('[Telegram Bot] Failed to initialize bot:', e.message);
    return null;
  }
}

module.exports = {
  startTelegramBot
};
