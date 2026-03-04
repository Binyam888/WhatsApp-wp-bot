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
const { uploadMedia, createPost } = require("./wp-client");
require("dotenv").config();

const allowedNumbers = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(",")
  : [];

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
    if (type === "notify") {
      for (const msg of messages) {
        if (!msg.message) continue;

        // Check if message is from allowed number
        const remoteJid = msg.key.remoteJid;
        const senderNumber = remoteJid.replace("@s.whatsapp.net", "");

        // Normalization helper
        const jidNormalizedUser = (jid) => {
          const decoded = jid.split(":")[0];
          return decoded.split("@")[0] + "@s.whatsapp.net"; // standard format
        };

        const myJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
        const msgRemoteJid = jidNormalizedUser(remoteJid);

        // Rule 1: Allow if from allowed number (someone sending TO bot)
        // Rule 2: Allow if from ME (fromMe=true) sending TO MYSELF (remoteJid=myJid)
        // The user specifically asked: "if i send message to myself"
        const isFromAllowedNumber = allowedNumbers.includes(senderNumber);
        const isSelfDm = msg.key.fromMe && msgRemoteJid === myJid;

        if (!isFromAllowedNumber && !isSelfDm) {
          // console.log(`Ignoring message from ${senderNumber} (not allowed and not Self-DM)`);
          continue;
        }

        console.log("Processing potential command from:", senderNumber);

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

          // Rule 3: Must start with "post" followed by optional space and colon (case insensitive)
          const postPrefixMatch = text.match(/^post\s*:/i);
          if (!postPrefixMatch) {
            console.log('Message does not start with "post:". Ignoring.');
            continue;
          }

          // Remove "post:" prefix (and any following whitespace)
          let cleanText = text.substring(postPrefixMatch[0].length).trim();

          // Parse Title, Content, and Status
          // Expected format: "title: ... content: ... status: ..." in any order
          // We use regex to find each part, stopping at the start of another tag or end of string.
          // Updated to allow spaces before colon: "title :", "content :"

          const titleMatch = cleanText.match(
            /title\s*:\s*([\s\S]*?)(?=(content\s*:|status\s*:|$))/i,
          );
          const contentMatch = cleanText.match(
            /content\s*:\s*([\s\S]*?)(?=(title\s*:|status\s*:|$))/i,
          );
          const statusMatch = cleanText.match(
            /status\s*:\s*([\s\S]*?)(?=(title\s*:|content\s*:|$))/i,
          );

          let title = titleMatch ? titleMatch[1].trim() : "";
          let content = contentMatch ? contentMatch[1].trim() : "";
          let statusRaw = statusMatch
            ? statusMatch[1].trim().toLowerCase()
            : "publish";

          // Validate status
          let status =
            statusRaw === "draft" || statusRaw === "publish"
              ? statusRaw
              : "publish";

          if (!title) {
            console.log('No "title:" found.');
            await sock.sendMessage(remoteJid, {
              text: `Error: Could not find 'title:' in your post command.`,
            });
            continue;
          }
          if (!content) {
            console.log('No "content:" found.');
            await sock.sendMessage(remoteJid, {
              text: `Error: Could not find 'content:' in your post command.`,
            });
            continue;
          }

          let featuredMediaId = null;
          if (mediaBuffer) {
            console.log("Uploading image...");
            const filename = `whatsapp-image-${Date.now()}.${fileExt}`;
            featuredMediaId = await uploadMedia(
              mediaBuffer,
              filename,
              mimeType,
            );
          }

          console.log(`Creating post: Title="${title}", Status="${status}"`);
          const post = await createPost(
            title,
            content,
            status,
            featuredMediaId,
          );

          await sock.sendMessage(remoteJid, {
            text: `Post created successfully (${status})! Link: ${post.link}`,
          });
        } catch (error) {
          console.error("Error processing message:", error);
          await sock.sendMessage(remoteJid, {
            text: `Error creating post: ${error.message}`,
          });
        }
      }
    }
  });
}

connectToWhatsApp();
