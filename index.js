const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const mime = require("mime-types");
const { uploadMedia, createPost, updatePost, deletePost } = require("./wp-client");
require("dotenv").config();

const allowedNumbers = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(",")
  : [];

// Map to track user conversation state.
const userSessions = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectToWhatsApp(retryCount = 0) {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Scan the QR code below to connect:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`Connection closed. Reason: ${reason}`);

      // These codes all mean the session is invalid/rejected — clear and start fresh
      const shouldClearSession =
        reason === DisconnectReason.loggedOut ||   // 401
        reason === DisconnectReason.badSession ||  // 500
        reason === DisconnectReason.forbidden ||   // 403
        reason === 405;                            // WS rejection of stale creds

      if (shouldClearSession) {
        console.log("�️  Invalid/stale session detected. Clearing auth and generating new QR...");
        fs.rmSync("auth_info", { recursive: true, force: true });
        await sleep(5000);
        connectToWhatsApp(0);
      } else if (reason === DisconnectReason.restartRequired) { // 515
        console.log("🔄 Restart required. Reconnecting...");
        await sleep(3000);
        connectToWhatsApp(0);
      } else if (reason === DisconnectReason.connectionReplaced) { // 440
        console.log("⚠️  Connection replaced by another session. Stopping.");
        // Don't reconnect — another instance is running
      } else {
        const delay = Math.min(5000 * (retryCount + 1), 30000);
        console.log(`🔄 Reconnecting in ${delay / 1000}s... (attempt ${retryCount + 1})`);
        await sleep(delay);
        connectToWhatsApp(retryCount + 1);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log(`\n[DEBUG] Received messages.upsert event. Type: ${type}, Count: ${messages.length}`);
    if (type === "notify") {
      for (const msg of messages) {
        console.log(`[DEBUG] Raw Message Key:`, JSON.stringify(msg.key));
        if (!msg.message) {
          console.log("[DEBUG] No message content found.");
          continue;
        }

        // Check if message is from allowed number
        // Messages from self or linked devices sometimes use @lid in remoteJid and the actual number in remoteJidAlt
        const remoteJid = msg.key.remoteJid;
        const remoteJidAlt = msg.key.remoteJidAlt;
        
        let senderNumber = "";
        if (remoteJid && remoteJid.includes("@s.whatsapp.net")) {
            senderNumber = remoteJid.replace("@s.whatsapp.net", "");
        } else if (remoteJidAlt && remoteJidAlt.includes("@s.whatsapp.net")) {
            senderNumber = remoteJidAlt.replace("@s.whatsapp.net", "");
        } else if (remoteJid && !remoteJid.includes("@g.us")) {
            // fallback if it's just a number without domain
            senderNumber = remoteJid.split("@")[0];
        }

        // Normalization helper
        const jidNormalizedUser = (jid) => {
          if (!jid) return null;
          const decoded = jid.split(":")[0];
          return decoded.split("@")[0] + "@s.whatsapp.net"; // standard format
        };

        const myJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
        const msgRemoteJid = jidNormalizedUser(remoteJid);
        const msgRemoteJidAlt = jidNormalizedUser(remoteJidAlt);

        // Rule 1: Allow if from allowed number
        // Rule 2: Allow if from ME (fromMe=true) sending TO MYSELF
        const isFromAllowedNumber = allowedNumbers.includes(senderNumber);
        const isSelfDm = msg.key.fromMe && (msgRemoteJid === myJid || msgRemoteJidAlt === myJid);

        console.log(`[DEBUG] remoteJid: ${remoteJid}, remoteJidAlt: ${remoteJidAlt}, senderNumber: ${senderNumber}`);
        console.log(`[DEBUG] myJid: ${myJid}, isFromAllowedNumber: ${isFromAllowedNumber}, isSelfDm: ${isSelfDm}`);
        console.log(`[DEBUG] allowedNumbers array:`, allowedNumbers);

        if (!isFromAllowedNumber && !isSelfDm) {
          console.log(`[DEBUG] Ignoring message from ${senderNumber} (not allowed and not Self-DM)`);
          continue;
        }

        console.log("[DEBUG] Passed filter! Processing potential command from:", senderNumber);

        try {
          // Handle text and image
          const messageType = Object.keys(msg.message)[0];
          let text = "";
          let mediaBuffer = null;
          let mimeType = "";
          let fileExt = "";

          // Extract text and media
          if (messageType === "conversation") {
            text = msg.message.conversation;
          } else if (messageType === "extendedTextMessage") {
            text = msg.message.extendedTextMessage.text;
          } else if (messageType === "imageMessage") {
            text = msg.message.imageMessage.caption || "";
            const { downloadMediaMessage } = require("@whiskeysockets/baileys");
            mediaBuffer = await downloadMediaMessage(
              msg,
              "buffer",
              {},
              {
                logger: console,
                reuploadRequest: sock.updateMediaMessage,
              },
            );
            mimeType = msg.message.imageMessage.mimetype;
            fileExt = mime.extension(mimeType) || "jpg";
          }

          if (!text) {
            // If no text, we can't find the keyword
            continue;
          }

          // ------------------------------------------------------------------
          // Handle active interactive session
          // ------------------------------------------------------------------
          if (userSessions[senderNumber] === "AWAITING_MENU_CHOICE") {
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
              await sock.sendMessage(remoteJid, { text: `Invalid choice. Please reply with 1, 2, 3, or 4.` });
              return; // Exit here, don't clear session yet so they can try again
            }

            userSessions[senderNumber] = null; // Clear session
            await sock.sendMessage(remoteJid, { text: instructionText });
            await sleep(500); // Small delay to guarantee message order
            await sock.sendMessage(remoteJid, { text: templateText });
            continue;
          }

          // ------------------------------------------------------------------
          // Handle standard commands and fallback menu
          // ------------------------------------------------------------------
          // Action prefix matching: "post", "update", "delete", "archive" (case insensitive)
          // Look for the command at the start of the string OR at the start of any new line 
          // This makes it forgiving if the user pastes extra text above it.
          const commandMatch = text.match(/(?:^|\n)\s*(post|update|delete|archive)\s*:?/i);
          
          if (!commandMatch) {
            console.log('Message does not start with a valid command. Sending interactive menu.');
            
            userSessions[senderNumber] = "AWAITING_MENU_CHOICE";

            const menu = `*🤖 WordPress Bot Menu*\n\n` +
              `Welcome! Please reply with a number to choose an action:\n\n` +
              `1️⃣ *Create a new Post*\n` +
              `2️⃣ *Update a Post*\n` +
              `3️⃣ *Archive a Post*\n` +
              `4️⃣ *Delete a Post*\n`;
            
            await sock.sendMessage(remoteJid, { text: menu });
            continue;
          }

          const action = commandMatch[1].toLowerCase();
          
          // Extract text appearing AFTER the matched command by using its index + length
          let cleanText = text.substring(commandMatch.index + commandMatch[0].length).trim();

          // Regex to safely parse tags even if they don't have colons but followed by another tag or eof
          const titleMatch = cleanText.match(/title\s*:\s*([\s\S]*?)(?=(content\s*:|status\s*:|id\s*:|$))/i);
          const contentMatch = cleanText.match(/content\s*:\s*([\s\S]*?)(?=(title\s*:|status\s*:|id\s*:|$))/i);
          const statusMatch = cleanText.match(/status\s*:\s*([\s\S]*?)(?=(title\s*:|content\s*:|id\s*:|$))/i);
          const idMatch = cleanText.match(/id\s*:\s*(\d+)/i);

          let title = titleMatch ? titleMatch[1].trim() : "";
          let content = contentMatch ? contentMatch[1].trim() : "";
          let statusRaw = statusMatch ? statusMatch[1].trim().toLowerCase() : "publish";
          let postId = idMatch ? parseInt(idMatch[1], 10) : null;

          // Validate status
          let status = (statusRaw === "draft" || statusRaw === "publish" || statusRaw === "trash") ? statusRaw : "publish";

          if (action === "post") {
              if (!title || !content) {
                await sock.sendMessage(remoteJid, { text: `Error: Could not find 'title:' or 'content:' in your post command.` });
                continue;
              }

              let featuredMediaId = null;
              if (mediaBuffer) {
                console.log("Uploading image...");
                const filename = `whatsapp-image-${Date.now()}.${fileExt}`;
                featuredMediaId = await uploadMedia(mediaBuffer, filename, mimeType);
              }

              console.log(`Creating post: Title="${title}", Status="${status}"`);
              const post = await createPost(title, content, status, featuredMediaId);

              // **Modified response to include Post ID**
              await sock.sendMessage(remoteJid, {
                text: `Post created successfully (${status})!\n*ID: ${post.id}*\nLink: ${post.link}`,
              });
              
          } else if (action === "update") {
              if (!postId) {
                  await sock.sendMessage(remoteJid, { text: `Error: 'id:' is required for updating.` });
                  continue;
              }

              console.log(`Updating post API call for ID ${postId}`);
              const post = await updatePost(postId, title, content, statusRaw ? status : null);

              await sock.sendMessage(remoteJid, {
                text: `Post ID ${postId} updated successfully!\nLink: ${post.link}`,
              });

          } else if (action === "archive") {
              if (!postId) {
                  await sock.sendMessage(remoteJid, { text: `Error: 'id:' is required for archiving.` });
                  continue;
              }

              console.log(`Archiving post API call for ID ${postId}`);
              // WordPress archives posts by setting status to draft or trash. Let's use 'draft'
              const post = await updatePost(postId, null, null, "draft");

              await sock.sendMessage(remoteJid, {
                text: `Post ID ${postId} has been archived (set to draft) successfully!`,
              });

          } else if (action === "delete") {
              if (!postId) {
                  await sock.sendMessage(remoteJid, { text: `Error: 'id:' is required for deleting.` });
                  continue;
              }

              console.log(`Deleting post API call for ID ${postId}`);
              await deletePost(postId);

              await sock.sendMessage(remoteJid, {
                text: `Post ID ${postId} deleted successfully!`,
              });
          }

        } catch (error) {
          console.error("Error processing message:", error);
          await sock.sendMessage(remoteJid, {
            text: `Error processing command: ${error.message}`,
          });
        }
      }
    }
  });
}

connectToWhatsApp();
