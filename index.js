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

// ------------------------------------------------------------------
// Telegram Bot Server
// ------------------------------------------------------------------
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

    if (!text && !userSessions[chatId]) {
      return;
    }

    if (userSessions[chatId] === "AWAITING_MENU_CHOICE") {
      const choice = text.trim();
      let instructionText = "";
      let templateText = "";

      if (choice === "1") {
        instructionText = `*Create a New Post:*\nCopy the text in the next message, fill in your details, and send it back to me!`;
        templateText = `post\ntitle: \ncontent: `;
      } else if (choice === "2") {
        instructionText = `*Update a Post:*\nCopy the text in the next message, fill in your details, and send it back to me!`;
        templateText = `update\nid: \ntitle: \ncontent: `;
      } else if (choice === "3") {
        instructionText = `*Archive a Post:*\nCopy the text in the next message, fill in your details, and send it back to me!`;
        templateText = `archive\nid: `;
      } else if (choice === "4") {
        instructionText = `*Delete a Post:*\nCopy the text in the next message, fill in your details, and send it back to me!`;
        templateText = `delete\nid: `;
      } else {
        await bot.sendMessage(chatId, `Invalid choice. Please reply with 1, 2, 3, or 4.`);
        return; 
      }

      userSessions[chatId] = null; 
      await bot.sendMessage(chatId, instructionText, { parse_mode: 'Markdown' });
      await bot.sendMessage(chatId, templateText);
      return;
    }

    const commandMatch = text.match(/(?:^|\n)\s*(post|update|delete|archive)\s*:?/i);
    
    if (!commandMatch) {
      console.log('Message does not start with a valid command. Sending interactive menu.');
      
      userSessions[chatId] = "AWAITING_MENU_CHOICE";

      const menu = `*🤖 WordPress Bot Menu*\n\n` +
        `Welcome! Please reply with a number to choose an action:\n\n` +
        `1️⃣ *Create a new Post*\n` +
        `2️⃣ *Update a Post*\n` +
        `3️⃣ *Archive a Post*\n` +
        `4️⃣ *Delete a Post*\n`;
      
      await bot.sendMessage(chatId, menu, { parse_mode: 'Markdown' });
      return;
    }

    const action = commandMatch[1].toLowerCase();
    
    let cleanText = text.substring(commandMatch.index + commandMatch[0].length).trim();

    const titleMatch = cleanText.match(/title\s*:\s*([\s\S]*?)(?=(content\s*:|status\s*:|id\s*:|$))/i);
    const contentMatch = cleanText.match(/content\s*:\s*([\s\S]*?)(?=(title\s*:|status\s*:|id\s*:|$))/i);
    const statusMatch = cleanText.match(/status\s*:\s*([\s\S]*?)(?=(title\s*:|content\s*:|id\s*:|$))/i);
    const idMatch = cleanText.match(/id\s*:\s*(\d+)/i);

    let title = titleMatch ? titleMatch[1].trim() : "";
    let content = contentMatch ? contentMatch[1].trim() : "";
    let statusRaw = statusMatch ? statusMatch[1].trim().toLowerCase() : "publish";
    let postId = idMatch ? parseInt(idMatch[1], 10) : null;

    let status = (statusRaw === "draft" || statusRaw === "publish" || statusRaw === "trash") ? statusRaw : "publish";

    if (action === "post") {
        if (!title || !content) {
          await bot.sendMessage(chatId, `Error: Could not find 'title:' or 'content:' in your post command.`);
          return;
        }

        let featuredMediaId = null;
        if (mediaBuffer) {
          console.log("Uploading image...");
          const filename = `telegram-image-${Date.now()}.${fileExt}`;
          featuredMediaId = await uploadMedia(mediaBuffer, filename, mimeType);
        }

        console.log(`Creating post: Title="${title}", Status="${status}"`);
        const post = await createPost(title, content, status, featuredMediaId);

        await bot.sendMessage(chatId, `Post created successfully (${status})!\n*ID: ${post.id}*\nLink: ${post.link}`, { parse_mode: 'Markdown' });
        
    } else if (action === "update") {
        if (!postId) {
            await bot.sendMessage(chatId, `Error: 'id:' is required for updating.`);
            return;
        }

        console.log(`Updating post API call for ID ${postId}`);
        const post = await updatePost(postId, title, content, statusRaw ? status : null);

        await bot.sendMessage(chatId, `Post ID ${postId} updated successfully!\nLink: ${post.link}`);

    } else if (action === "archive") {
        if (!postId) {
            await bot.sendMessage(chatId, `Error: 'id:' is required for archiving.`);
            return;
        }

        console.log(`Archiving post API call for ID ${postId}`);
        const post = await updatePost(postId, null, null, "draft");

        await bot.sendMessage(chatId, `Post ID ${postId} has been archived (set to draft) successfully!`);

    } else if (action === "delete") {
        if (!postId) {
            await bot.sendMessage(chatId, `Error: 'id:' is required for deleting.`);
            return;
        }

        console.log(`Deleting post API call for ID ${postId}`);
        await deletePost(postId);

        await bot.sendMessage(chatId, `Post ID ${postId} deleted successfully!`);
    }

  } catch (error) {
    if (error.message.includes("WordPress credentials not configured")) {
        await bot.sendMessage(chatId, `❌ WordPress credentials are not configured natively! Please install the new WP Plugin and enter my API Endpoint via WP Settings.`);
        return;
    }
    console.error("Error processing message:", error);
    await bot.sendMessage(chatId, `Error processing command: ${error.message}`);
  }
});

console.log("✅ Telegram bot message handler is loaded.");
