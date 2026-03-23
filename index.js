const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const mime = require('mime-types');
const { uploadMedia, createPost, updatePost, deletePost, saveConfig, verifyConnection } = require('./wp-client');
require('dotenv').config();

// ------------------------------------------------------------------
// Express API Server for WordPress Plugin Configuration
// ------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/configure', async (req, res) => {
    const { wpUrl, username, password } = req.body;
    
    if (!wpUrl || !username || !password) {
        return res.status(400).json({ success: false, message: 'Missing configuration fields from WordPress.' });
    }

    try {
        // Test WP Connection
        await verifyConnection(wpUrl, username, password);
        // Save credentials mapping inside the Node runtime context
        saveConfig(wpUrl, username, password);
        
        console.log(`✅ Received & Verified WordPress context from: ${wpUrl}`);
        return res.json({ success: true, message: 'Successfully connected and saved WordPress credentials in the Node.js context.' });
    } catch (error) {
        console.error('❌ WordPress connection test failed:', error.message);
        return res.status(401).json({ success: false, message: 'Node.js failed to verify the provided WordPress URL or credentials.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Internal configuration API is running on port ${PORT}`);
});

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is missing in .env file.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const allowedNumbers = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(",")
  : [];

// Map to track user conversation state
const userSessions = {};

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  const senderId = msg.from.id.toString();
  const senderUsername = msg.from.username ? msg.from.username : '';
  const senderUsernameWithAt = msg.from.username ? `@${msg.from.username}` : '';
  
  const isFromAllowedUser = allowedNumbers.length === 0 || 
                            allowedNumbers.includes(senderId) || 
                            allowedNumbers.includes(senderUsername) || 
                            allowedNumbers.includes(senderUsernameWithAt);

  if (!isFromAllowedUser) {
    console.log(`[DEBUG] Ignoring message from ${senderId} ${senderUsernameWithAt} (not in allowed list)`);
    return;
  }

  let text = msg.text || msg.caption || '';
  let mediaBuffer = null;
  let mimeType = '';
  let fileExt = '';

  try {
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      const fileLink = await bot.getFileLink(photo.file_id);
      
      const axios = require('axios');
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      mediaBuffer = Buffer.from(response.data, 'binary');
      mimeType = response.headers['content-type'] || 'image/jpeg';
      fileExt = mime.extension(mimeType) || 'jpg';
    }

    if (!text && !mediaBuffer) {
      return;
    }

    if (text.toLowerCase() === 'cancel' || text === '/cancel') {
        if (userSessions[chatId]) {
            delete userSessions[chatId];
            await bot.sendMessage(chatId, `Action cancelled.`);
        } else {
            await bot.sendMessage(chatId, `No active action to cancel.`);
        }
        return;
    }

    if (userSessions[chatId]) {
      const session = userSessions[chatId];

      if (session.action === "post") {
        if (session.step === "title") {
          session.title = text;
          session.step = "content";
          await bot.sendMessage(chatId, `Great! Now send me the *Content* of the post:`, { parse_mode: 'Markdown', reply_markup: { force_reply: true } });
          return;
        } else if (session.step === "content") {
          session.content = text;
          await bot.sendMessage(chatId, `⏳ Creating post: "${session.title}"...`);
          try {
            let featuredMediaId = null;
            if (mediaBuffer) {
              const filename = `telegram-image-${Date.now()}.${fileExt}`;
              featuredMediaId = await uploadMedia(mediaBuffer, filename, mimeType);
            }
            const post = await createPost(session.title, session.content, "publish", featuredMediaId);
            await bot.sendMessage(chatId, `✅ Post created successfully!\n*ID: ${post.id}*\nLink: ${post.link}`, { parse_mode: 'Markdown' });
          } catch (e) {
            await bot.sendMessage(chatId, `❌ Error creating post: ${e.message}`);
          }
          delete userSessions[chatId];
          return;
        }
      } else if (session.action === "update") {
        if (session.step === "id") {
          session.postId = parseInt(text.trim(), 10);
          if (isNaN(session.postId)) {
            await bot.sendMessage(chatId, `Invalid ID. Please send a valid number.`);
            return;
          }
          session.step = "title_optional";
          await bot.sendMessage(chatId, `Send the *new Title* (or type "skip" to keep the old title):`, { parse_mode: 'Markdown', reply_markup: { force_reply: true } });
          return;
        } else if (session.step === "title_optional") {
          session.title = text.trim().toLowerCase() === 'skip' ? null : text;
          session.step = "content_optional";
          await bot.sendMessage(chatId, `Send the *new Content* (or type "skip" to keep the old content):`, { parse_mode: 'Markdown', reply_markup: { force_reply: true } });
          return;
        } else if (session.step === "content_optional") {
          session.content = text.trim().toLowerCase() === 'skip' ? null : text;
          
          if (!session.title && !session.content) {
            await bot.sendMessage(chatId, `No changes made. Update cancelled.`);
            delete userSessions[chatId];
            return;
          }

          await bot.sendMessage(chatId, `⏳ Updating post ID ${session.postId}...`);
          try {
            const post = await updatePost(session.postId, session.title, session.content, null);
            await bot.sendMessage(chatId, `✅ Post updated successfully!\nLink: ${post.link}`);
          } catch (e) {
            await bot.sendMessage(chatId, `❌ Error updating post: ${e.message}`);
          }
          delete userSessions[chatId];
          return;
        }
      } else if (session.action === "archive") {
        if (session.step === "id") {
          const postId = parseInt(text.trim(), 10);
          if (isNaN(postId)) {
            await bot.sendMessage(chatId, `Invalid ID. Please send a valid number.`);
            return;
          }
          try {
            await updatePost(postId, null, null, "draft");
            await bot.sendMessage(chatId, `✅ Post ID ${postId} has been archived (set to draft) successfully!`);
          } catch (e) {
            await bot.sendMessage(chatId, `❌ Error archiving post: ${e.message}`);
          }
          delete userSessions[chatId];
          return;
        }
      } else if (session.action === "delete") {
        if (session.step === "id") {
          const postId = parseInt(text.trim(), 10);
          if (isNaN(postId)) {
            await bot.sendMessage(chatId, `Invalid ID. Please send a valid number.`);
            return;
          }
          try {
            await deletePost(postId);
            await bot.sendMessage(chatId, `✅ Post ID ${postId} deleted successfully!`);
          } catch (e) {
            await bot.sendMessage(chatId, `❌ Error deleting post: ${e.message}`);
          }
          delete userSessions[chatId];
          return;
        }
      }
    }

    // Default: Send Menu
    const menuOpts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "📝 Create a new Post", callback_data: "menu_post" }],
          [{ text: "✏️ Update a Post", callback_data: "menu_update" }],
          [{ text: "📦 Archive a Post", callback_data: "menu_archive" }],
          [{ text: "🗑️ Delete a Post", callback_data: "menu_delete" }]
        ]
      }
    };
    
    await bot.sendMessage(chatId, `*🤖 WordPress Bot Menu*\n\nWelcome! Please click an action below:`, menuOpts);
    
  } catch (error) {
    if (error.message.includes("WordPress credentials not configured")) {
        await bot.sendMessage(chatId, `❌ WordPress credentials are not configured natively! Please set WP_URL, WP_USERNAME, and WP_PASSWORD in the Node server's .env file.`);
        return;
    }
    console.error("Error processing message:", error);
    await bot.sendMessage(chatId, `Error processing command: ${error.message}`);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  
  const senderId = query.from.id.toString();
  const senderUsername = query.from.username ? query.from.username : '';
  const senderUsernameWithAt = query.from.username ? `@${query.from.username}` : '';
  
  const isFromAllowedUser = allowedNumbers.length === 0 || 
                            allowedNumbers.includes(senderId) || 
                            allowedNumbers.includes(senderUsername) || 
                            allowedNumbers.includes(senderUsernameWithAt);

  if (!isFromAllowedUser) {
    console.log(`[DEBUG] Ignoring callback from ${senderId} (not in allowed list)`);
    await bot.answerCallbackQuery(query.id, { text: 'Unauthorized', show_alert: true });
    return;
  }

  const data = query.data;
  let instructionText = "";

  if (data === "menu_post") {
    userSessions[chatId] = { action: 'post', step: 'title' };
    instructionText = `*Create a New Post:*\nPlease send the *Title* for the new post:\n_(Type 'cancel' to abort)_`;
  } else if (data === "menu_update") {
    userSessions[chatId] = { action: 'update', step: 'id' };
    instructionText = `*Update a Post:*\nPlease send the *Post ID* you want to update:\n_(Type 'cancel' to abort)_`;
  } else if (data === "menu_archive") {
    userSessions[chatId] = { action: 'archive', step: 'id' };
    instructionText = `*Archive a Post:*\nPlease send the *Post ID* to archive (set to draft):\n_(Type 'cancel' to abort)_`;
  } else if (data === "menu_delete") {
    userSessions[chatId] = { action: 'delete', step: 'id' };
    instructionText = `*Delete a Post:*\nPlease send the *Post ID* to delete:\n_(Type 'cancel' to abort)_`;
  }

  if (instructionText) {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, instructionText, { parse_mode: 'Markdown', reply_markup: { force_reply: true } });
  } else {
    await bot.answerCallbackQuery(query.id);
  }
});

console.log("✅ Telegram bot message handler is loaded.");
