// Complete bypass for Local/Staging expired SSL certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const mime = require('mime-types');
const { marked } = require('marked');
const { getSites, uploadMedia, createPost, updatePost, deletePost, saveConfig, verifyConnection } = require('./wp-client');
require('dotenv').config();

// ------------------------------------------------------------------
// Express API Server for WordPress Plugin Configuration
// ------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/configure', async (req, res) => {
    const { wpUrl, username, password, clientIdentifier } = req.body;
    
    if (!wpUrl || !username || !password || !clientIdentifier) {
        return res.status(400).json({ success: false, message: 'Missing configuration fields from WordPress (Make sure to provide your Telegram Identifier).' });
    }

    try {
        await verifyConnection(wpUrl, username, password);
        saveConfig(wpUrl, username, password, clientIdentifier);
        
        let botInfo = { username: 'UnknownBot' };
        try {
            botInfo = await bot.getMe();
        } catch (e) {}
        
        console.log(`✅ Received & Verified WordPress context from: ${wpUrl} mapped to Telegram User: ${clientIdentifier}`);
        return res.json({ 
            success: true, 
            message: 'Successfully connected and saved WordPress credentials in the Node.js context.',
            botUsername: botInfo.username
        });
    } catch (error) {
        console.error(`❌ WordPress connection test failed (${wpUrl}):`, error.message);
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

const allowedNumbers = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(",") : [];

const userStateList = {}; // userSessions[chatId] = { action, step, ... }
const activeSiteMap = {}; // activeSiteMap[chatId] = wpUrl

function getMenuOptions() {
    return {
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [
          [{ text: 'Create Post' }, { text: 'Update Post' }],
          [{ text: 'Archive Post' }, { text: 'Delete Post' }],
          [{ text: 'Switch Site' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    };
}

function getMenuText() {
    return `<b>🤖 WordPress Bot Menu</b>\n\nChoose an action from the keyboard below:`;
}

function resetMenu(chatId, siteUrl) {
    userStateList[chatId] = null;
    return bot.sendMessage(chatId, `🔗 <b>Target Site:</b> ${siteUrl}\n\n` + getMenuText(), getMenuOptions());
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  const senderId = msg.from.id.toString();
  const senderUsername = msg.from.username ? msg.from.username : '';
  const senderUsernameWithAt = msg.from.username ? `@${msg.from.username}` : '';
  const phone1 = msg.contact ? msg.contact.phone_number : '';
  const phone2 = msg.contact && msg.contact.phone_number ? '+' + msg.contact.phone_number.replace('+', '') : '';

  const isFromAllowedUser = allowedNumbers.length === 0 || 
                            allowedNumbers.includes(senderId) || 
                            allowedNumbers.includes(senderUsername) || 
                            allowedNumbers.includes(senderUsernameWithAt);

  if (!isFromAllowedUser) return;

  let text = msg.text || msg.caption || '';
  if (!text && !msg.document && !msg.photo && !userStateList[chatId]) return;

  const allSites = getSites();

  // Filter sites explicitly to only the ones belonging to the sender identifier
  let sites = allSites.filter(s => {
      if (!s.clientIdentifier) return false;
      const ci = s.clientIdentifier.trim();
      return ci === senderId || ci === senderUsername || ci === senderUsernameWithAt || ci === phone1 || ci === phone2;
  });

  if (sites.length === 0) {
      if ((text && text.startsWith('/start')) || text === '/sites' || (text && text.toLowerCase() === 'hi')) {
           return bot.sendMessage(chatId, `❌ Unauthorized.\n\nYour Telegram account (<b>${senderUsernameWithAt || senderId}</b>) is not linked to any active WordPress sites.\n\nPlease install the WP Plugin and enter your exact Telegram Username in the Settings tab to securely map your account!`, { parse_mode: 'HTML' });
      }
      return; 
  }

  if (text.trim().toLowerCase() === '/sites' || text.trim().toLowerCase() === 'sites' || text === 'Switch Site') {
      userStateList[chatId] = null;
      if (sites.length === 1) {
          activeSiteMap[chatId] = sites[0].wpUrl;
          return bot.sendMessage(chatId, `You only have 1 site connected to your identity: ${sites[0].wpUrl}`, getMenuOptions());
      }
      userStateList[chatId] = "AWAITING_SITE_CHOICE";
      let sMsg = "You currently have multiple sites mapped! Please reply with the <b>number</b> of the site you want to manage right now:\n\n";
      sites.forEach((s, idx) => { sMsg += `${idx + 1}. ${s.wpUrl}\n`; });
      return bot.sendMessage(chatId, sMsg, { parse_mode: 'HTML' });
  }

  if (userStateList[chatId] === "AWAITING_SITE_CHOICE") {
      const choice = parseInt(text.trim(), 10);
      if (isNaN(choice) || choice < 1 || choice > sites.length) {
          return bot.sendMessage(chatId, "Invalid choice. Please send a valid site number block: (e.g. 1)");
      }
      activeSiteMap[chatId] = sites[choice - 1].wpUrl;
      userStateList[chatId] = null;
      return bot.sendMessage(chatId, `✅ <b>Active site set to:</b> ${sites[choice - 1].wpUrl}\n\n` + getMenuText(), getMenuOptions());
  }

  let activeSite = sites[0];
  if (sites.length > 1) {
      if (!activeSiteMap[chatId]) {
          userStateList[chatId] = "AWAITING_SITE_CHOICE";
          let sMsg = "You have multiple sites connected to your identity! Please select which site to manage first:\n\n";
          sites.forEach((s, idx) => { sMsg += `${idx + 1}. ${s.wpUrl}\n`; });
          return bot.sendMessage(chatId, sMsg, { parse_mode: 'HTML' });
      }
      activeSite = sites.find(s => s.wpUrl === activeSiteMap[chatId]) || sites[0];
  }

  try {
    let mediaBuffer = null;
    let mimeType = '';
    let fileExt = '';
    let uploadedText = '';

    // Handle incoming images
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      const fileLink = await bot.getFileLink(photo.file_id);
      const axios = require('axios');
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      mediaBuffer = Buffer.from(response.data, 'binary');
      mimeType = response.headers['content-type'] || 'image/jpeg';
      fileExt = mime.extension(mimeType) || 'jpg';
    } 
    // Handle incoming Markdown or text files
    else if (msg.document) {
      const fileName = msg.document.file_name || '';
      if (fileName.endsWith('.md') || fileName.endsWith('.txt')) {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const axios = require('axios');
        const response = await axios.get(fileLink, { responseType: 'text' });
        uploadedText = response.data;
      }
    }

    if (text === "Create Post") {
        userStateList[chatId] = { action: 'post', step: 'title' };
        return bot.sendMessage(chatId, `📝 <b>Create a New Post</b>\n\nPlease enter the <b>Title</b> for your new post:`, { parse_mode: 'HTML' });
    } else if (text === "Update Post") {
        userStateList[chatId] = { action: 'update', step: 'id' };
        return bot.sendMessage(chatId, `🔄 <b>Update a Post</b>\n\nPlease enter the numeric <b>ID</b> of the post you want to update:`, { parse_mode: 'HTML' });
    } else if (text === "Archive Post") {
        userStateList[chatId] = { action: 'archive', step: 'id' };
        return bot.sendMessage(chatId, `📦 <b>Archive a Post</b>\n\nPlease enter the numeric <b>ID</b> of the post you want to archive (sets to draft):`, { parse_mode: 'HTML' });
    } else if (text === "Delete Post") {
        userStateList[chatId] = { action: 'delete', step: 'id' };
        return bot.sendMessage(chatId, `🗑 <b>Delete a Post</b>\n\nPlease enter the numeric <b>ID</b> of the post you want to permanently delete:`, { parse_mode: 'HTML' });
    }

    // -------------------------------------------------------------
    // INTERACTIVE STATE MACHINE FLOW
    // -------------------------------------------------------------
    let uState = userStateList[chatId];
    if (uState && typeof uState === 'object') {
        
        // --- POST FLOW ---
        if (uState.action === 'post') {
            if (uState.step === 'title') {
                if (!text) return bot.sendMessage(chatId, "Title cannot be empty. Please enter a valid title:");
                uState.title = text;
                uState.step = 'content';
                return bot.sendMessage(chatId, `Great! Now send the <b>Content</b> for the post.\n\n<i>(Tip: You can type text directly, upload a .md file, or send a Photo with an optional caption!)</i>`, { parse_mode: 'HTML' });
            } 
            else if (uState.step === 'content') {
                let finalContent = uploadedText || text || '';
                if (!finalContent && !mediaBuffer) {
                    return bot.sendMessage(chatId, "Content cannot be completely empty. Please send some text, a file, or an image.");
                }
                
                await bot.sendMessage(chatId, `⏳ Creating post on <b>${activeSite.wpUrl}</b>...`, { parse_mode: 'HTML' });
                
                let featuredMediaId = null;
                if (mediaBuffer) {
                    await bot.sendMessage(chatId, `📸 Uploading requested media attachment...`);
                    featuredMediaId = await uploadMedia(activeSite, mediaBuffer, `image-${Date.now()}.${fileExt}`, mimeType);
                }
                
                try {
                    const htmlContent = finalContent ? marked.parse(finalContent) : " ";
                    const post = await createPost(activeSite, uState.title, htmlContent, "publish", featuredMediaId);
                    await bot.sendMessage(chatId, `✅ <b>Post created successfully!</b>\n<b>ID:</b> ${post.id}\n\n${post.link}`, { parse_mode: 'HTML' });
                } catch(e) {
                    await bot.sendMessage(chatId, `❌ Error creating post: ${e.message}`);
                }
                return resetMenu(chatId, activeSite.wpUrl);
            }
        }
        
        // --- UPDATE FLOW ---
        if (uState.action === 'update') {
            if (uState.step === 'id') {
                const id = parseInt(text.trim(), 10);
                if (isNaN(id)) return bot.sendMessage(chatId, "Invalid ID. Please send a valid numeric Post ID:");
                uState.postId = id;
                uState.step = 'title';
                return bot.sendMessage(chatId, `Got it. Enter the <b>NEW Title</b> (or type "skip" to keep the existing title):`, { parse_mode: 'HTML' });
            } 
            else if (uState.step === 'title') {
                uState.title = text.toLowerCase() === 'skip' ? null : text;
                uState.step = 'content';
                return bot.sendMessage(chatId, `Enter the <b>NEW Content</b> (or type "skip" to keep the existing content). You can also upload a .md file!`, { parse_mode: 'HTML' });
            } 
            else if (uState.step === 'content') {
                let finalContent = uploadedText || text || '';
                finalContent = finalContent.toLowerCase() === 'skip' ? null : finalContent;
                
                await bot.sendMessage(chatId, `⏳ Updating post ID ${uState.postId} on <b>${activeSite.wpUrl}</b>...`, { parse_mode: 'HTML' });
                try {
                    const htmlContent = finalContent ? marked.parse(finalContent) : null;
                    const post = await updatePost(activeSite, uState.postId, uState.title, htmlContent, null);
                    await bot.sendMessage(chatId, `✅ <b>Post updated successfully!</b>\n\n${post.link}`, { parse_mode: 'HTML' });
                } catch(e) {
                    await bot.sendMessage(chatId, `❌ Error updating post: ${e.message}`);
                }
                return resetMenu(chatId, activeSite.wpUrl);
            }
        }
        
        // --- ARCHIVE FLOW ---
        if (uState.action === 'archive') {
            if (uState.step === 'id') {
                const id = parseInt(text.trim(), 10);
                if (isNaN(id)) return bot.sendMessage(chatId, "Invalid ID. Please send a valid numeric Post ID:");
                await bot.sendMessage(chatId, `⏳ Archiving post ID ${id} on <b>${activeSite.wpUrl}</b>...`, { parse_mode: 'HTML' });
                try {
                    await updatePost(activeSite, id, null, null, "draft");
                    await bot.sendMessage(chatId, `✅ Post archived successfully.`);
                } catch(e) { await bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
                return resetMenu(chatId, activeSite.wpUrl);
            }
        }
        
        // --- DELETE FLOW ---
        if (uState.action === 'delete') {
            if (uState.step === 'id') {
                const id = parseInt(text.trim(), 10);
                if (isNaN(id)) return bot.sendMessage(chatId, "Invalid ID. Please send a valid numeric Post ID:");
                await bot.sendMessage(chatId, `⏳ Deleting post ID ${id} from <b>${activeSite.wpUrl}</b>...`, { parse_mode: 'HTML' });
                try {
                    await deletePost(activeSite, id);
                    await bot.sendMessage(chatId, `✅ Post permanently deleted.`);
                } catch(e) { await bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
                return resetMenu(chatId, activeSite.wpUrl);
            }
        }
    }

    // Unrecognized or random command resets the viewer context back to standard mode
    if (!userStateList[chatId] && text !== '/start') {
        return resetMenu(chatId, activeSite.wpUrl);
    }

  } catch (error) {
    console.error("Error processing message:", error);
    await bot.sendMessage(chatId, `Error processing command against ${activeSite.wpUrl}: ${error.message}`);
    userStateList[chatId] = null;
  }
});

console.log("✅ Telegram bot message handler is loaded.");
