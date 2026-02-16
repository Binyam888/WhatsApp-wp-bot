const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const mime = require('mime-types');
const { uploadMedia, createPost } = require('./wp-client');
require('dotenv').config();

const allowedNumbers = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(',') : [];

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: state,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('Scan the QR code above to login without phone number.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Opened connection');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.message) continue;
                
                // Check if message is from allowed number
                const remoteJid = msg.key.remoteJid;
                const senderNumber = remoteJid.replace('@s.whatsapp.net', '');
                
                // Normalization helper
                const jidNormalizedUser = (jid) => {
                    const decoded = jid.split(':')[0];
                    return decoded.split('@')[0] + '@s.whatsapp.net'; // standard format
                }

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

                console.log('Processing potential command from:', senderNumber);

                try {
                    // Handle text and image
                    const messageType = Object.keys(msg.message)[0];
                    let text = '';
                    let mediaBuffer = null;
                    let mimeType = '';
                    let fileExt = '';

                    // Extract text and media
                    if (messageType === 'conversation') {
                        text = msg.message.conversation;
                    } else if (messageType === 'extendedTextMessage') {
                        text = msg.message.extendedTextMessage.text;
                    } else if (messageType === 'imageMessage') {
                        text = msg.message.imageMessage.caption || '';
                         const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                         mediaBuffer = await downloadMediaMessage(
                            msg,
                            'buffer',
                            { },
                            { 
                                logger: console,
                                reuploadRequest: sock.updateMediaMessage
                            }
                        );
                        mimeType = msg.message.imageMessage.mimetype;
                        fileExt = mime.extension(mimeType) || 'jpg';
                    }

                    if (!text) {
                        // If no text, we can't find the keyword
                        continue;
                    }

                    // Rule 3: Must start with "post:" (case insensitive)
                    if (!text.toLowerCase().startsWith('post:')) {
                        console.log('Message does not start with "post:". Ignoring.');
                        continue;
                    }

                    // Remove "post:" prefix
                    let cleanText = text.substring(5).trim();

                    // Parse Title, Content, and Status
                    // Expected format: "title: ... content: ... status: ..." in any order
                    // We use regex to find each part, stopping at the start of another tag or end of string.
                    
                    const titleMatch = cleanText.match(/title:\s*([\s\S]*?)(?=(content:|status:|$))/i);
                    const contentMatch = cleanText.match(/content:\s*([\s\S]*?)(?=(title:|status:|$))/i);
                    const statusMatch = cleanText.match(/status:\s*([\s\S]*?)(?=(title:|content:|$))/i);

                    let title = titleMatch ? titleMatch[1].trim() : '';
                    let content = contentMatch ? contentMatch[1].trim() : '';
                    let statusRaw = statusMatch ? statusMatch[1].trim().toLowerCase() : 'publish';

                    // Validate status
                    let status = (statusRaw === 'draft' || statusRaw === 'publish') ? statusRaw : 'publish';
                    
                    if (!title) {
                        console.log('No "title:" found.');
                         await sock.sendMessage(remoteJid, { text: `Error: Could not find 'title:' in your post command.` });
                        continue;
                    }
                     if (!content) {
                        console.log('No "content:" found.');
                         await sock.sendMessage(remoteJid, { text: `Error: Could not find 'content:' in your post command.` });
                        continue;
                    }


                    let featuredMediaId = null;
                    if (mediaBuffer) {
                        console.log('Uploading image...');
                        const filename = `whatsapp-image-${Date.now()}.${fileExt}`;
                        featuredMediaId = await uploadMedia(mediaBuffer, filename, mimeType);
                    }

                    console.log(`Creating post: Title="${title}", Status="${status}"`);
                    const post = await createPost(title, content, status, featuredMediaId);
                    
                    await sock.sendMessage(remoteJid, { text: `Post created successfully (${status})! Link: ${post.link}` });

                } catch (error) {
                    console.error('Error processing message:', error);
                    await sock.sendMessage(remoteJid, { text: `Error creating post: ${error.message}` });
                }
            }
        }
    });
}

connectToWhatsApp();
