import fs from 'fs';
import { exec } from 'child_process';
import path from 'path';
import os from 'os';
import './whatsapp_shim.js';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import WebSocket from 'ws';

const SERVER_URL = 'ws://localhost:8345/v1/realtime';
const UPDATE_CONTACTS_URL = 'http://localhost:8345/v1/whatsapp/contacts';
const LOG_MESSAGE_URL = 'http://localhost:8345/v1/whatsapp/log';
const SESSION_DIR = './whatsapp_sessions';
const CONTACT_FILE = './whatsapp_contacts.json';
const BOT_TAG = '\u200b';
const ALLOWED_JIDS = [
    '124545914683502@lid',
    // '96019027099850@lid', 
    '19192749612@s.whatsapp.net'
];

let sock;
let controllerWs;
let contacts = {};

// Load contacts from disk
if (fs.existsSync(CONTACT_FILE)) {
    try {
        contacts = JSON.parse(fs.readFileSync(CONTACT_FILE, 'utf-8'));
    } catch (e) {
        console.error('Failed to load contacts:', e);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n--- SCAN THIS QR CODE WITH WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        } else if (connection === 'open') {
            console.log('WhatsApp connection opened successfully!');
            initController();
            syncContactsWithServer();
        }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' || !sock.user) return;
        const msg = m.messages[0];
        if (!msg.message || !msg.key.remoteJid) return;

        const senderJid = msg.key.remoteJid;
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption;
        const name = msg.pushName || senderJid.split('@')[0];
        const isAudio = !!msg.message.audioMessage;
        const isImage = !!msg.message.imageMessage;

        // Track contact
        if (!contacts[senderJid] || contacts[senderJid].name !== name) {
            contacts[senderJid] = { name, last_seen: new Date().toISOString() };
            saveContacts();
            syncContactsWithServer();
        }

        if (!body && !isAudio && !isImage) return;

        // Passive Awareness: Log to server's memory
        // Only log passively if we aren't about to trigger an interaction (which logs anyway)
        const isSelf = senderJid === sock.user.id.replace(/:.*@/, '@');
        const isWhitelisted = ALLOWED_JIDS.includes(senderJid);

        if (!isSelf && !isWhitelisted) {
            if (body) {
                syncMessageWithServer(senderJid, name, isImage ? `[Image Attached] ${body}` : body);
            } else if (isAudio) {
                syncMessageWithServer(senderJid, name, "[User sent a voice message]");
            } else if (isImage) {
                syncMessageWithServer(senderJid, name, "[User sent an image]");
            }
        }

        if (body && body.includes(BOT_TAG)) return;

        if (!isSelf && !isWhitelisted) {
            console.log(`[Security Check] Suppressing auto-reply to non-authorized sender: ${senderJid}`);
            return;
        }

        if (isAudio) {
            console.log(`[WhatsApp Inbound] From: ${name} (${senderJid}) Content: [Audio Message]`);
            handleAIInteraction(senderJid, { type: 'audio', msg });
        } else if (isImage) {
            console.log(`[WhatsApp Inbound] From: ${name} (${senderJid}) Content: [Image Message] ${body || ''}`);
            handleAIInteraction(senderJid, { type: 'image', msg, text: body || '' });
        } else {
            console.log(`[WhatsApp Inbound] From: ${name} (${senderJid}) Content: "${body}"`);
            handleAIInteraction(senderJid, { type: 'text', text: body });
        }
    });
}

function saveContacts() {
    try {
        fs.writeFileSync(CONTACT_FILE, JSON.stringify(contacts, null, 2));
    } catch (e) {
        console.error('Failed to save contacts:', e);
    }
}

function initController() {
    if (controllerWs) controllerWs.close();
    controllerWs = new WebSocket(SERVER_URL);

    controllerWs.on('open', () => {
        console.log('Connected to Sentience Controller WebSocket');
        controllerWs.send(JSON.stringify({
            type: 'session.update',
            session: { session_id: 'whatsapp_controller', client_type: 'whatsapp' }
        }));
    });

    controllerWs.on('message', async (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'whatsapp.send_message') {
            let jid = msg.jid;

            // 1. Try name match from our contact cache first
            for (const [id, info] of Object.entries(contacts)) {
                if (info.name && info.name.toLowerCase().includes(jid.toLowerCase())) {
                    console.log(`[WhatsApp Name Match] Resolved "${jid}" to "${info.name}" (${id})`);
                    jid = id;
                    break;
                }
            }

            // 2. Format as phone number if it doesn't look like a JID yet
            if (!jid.includes('@')) {
                const digits = jid.replace(/\D/g, '');
                if (digits.length >= 7) {
                    jid = digits + '@s.whatsapp.net';
                } else {
                    console.error(`[WhatsApp Error] Could not resolve contact name or phone number for: ${msg.jid}`);
                    jid = null;
                }
            }

            if (jid) {
                if (msg.image) {
                    console.log(`[WhatsApp Outbound Tool] Sending image message to ${jid} with caption: "${msg.text}"`);
                    const imgBuf = Buffer.from(msg.image, 'base64');
                    await sock.sendMessage(jid, { image: imgBuf, caption: msg.text + BOT_TAG });
                } else if (msg.audio) {
                    console.log(`[WhatsApp Outbound Tool] Sending audio message to ${jid}`);
                    try {
                        const wavBuf = Buffer.from(msg.audio, 'base64');
                        const randomId = Math.floor(Math.random() * 100000);
                        const tempWav = path.join(os.tmpdir(), `tool_${Date.now()}_${randomId}.wav`);
                        const tempOgg = path.join(os.tmpdir(), `tool_${Date.now()}_${randomId}.ogg`);
                        fs.writeFileSync(tempWav, wavBuf);

                        exec(`ffmpeg -i "${tempWav}" -c:a libopus -b:a 64k -vbr on -compression_level 10 "${tempOgg}" -y`, async (err) => {
                            if (err) {
                                console.error('Failed to encode outbound tool audio:', err);
                            } else if (fs.existsSync(tempOgg)) {
                                const oggBuf = fs.readFileSync(tempOgg);
                                await sock.sendMessage(jid, { audio: oggBuf, mimetype: 'audio/ogg; codecs=opus', ptt: true });
                            }
                            try { if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav); } catch (e) { }
                            try { if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg); } catch (e) { }
                        });
                    } catch (err) {
                        console.error('Failed to process tool audio:', err);
                    }
                } else {
                    console.log(`[WhatsApp Outbound Tool] Sending text message to ${jid}: "${msg.text}"`);
                    await sock.sendMessage(jid, { text: msg.text + BOT_TAG });
                }
            }
        }
    });

    controllerWs.on('close', () => setTimeout(initController, 5000));
    controllerWs.on('error', () => { });
}

async function syncContactsWithServer() {
    try {
        await fetch(UPDATE_CONTACTS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(contacts)
        });
    } catch (e) { }
}

async function syncMessageWithServer(jid, name, text) {
    try {
        await fetch(LOG_MESSAGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid, name, text })
        });
    } catch (e) { }
}

function handleAIInteraction(jid, input) {
    const ws = new WebSocket(SERVER_URL);
    let inactivityTimer = null;

    const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
            console.log(`[WhatsApp Outbound] Closing WS due to inactivity for ${jid}`);
            ws.close();
        }, 15000);
    };

    ws.on('open', async () => {
        resetInactivityTimer();
        ws.send(JSON.stringify({
            type: 'session.update',
            session: { session_id: jid, client_type: 'whatsapp' }
        }));

        if (input.type === 'text') {
            ws.send(JSON.stringify({ type: 'input_text', text: input.text }));
        } else if (input.type === 'image') {
            try {
                const buffer = await downloadMediaMessage(
                    input.msg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }) }
                );
                ws.send(JSON.stringify({
                    type: 'input_text',
                    text: input.text,
                    images: [buffer.toString('base64')]
                }));
            } catch (err) {
                console.error('Failed to download image message:', err);
                ws.close();
            }
        } else if (input.type === 'audio') {
            try {
                const buffer = await downloadMediaMessage(
                    input.msg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }) }
                );

                const tempOgg = path.join(os.tmpdir(), `in_${Date.now()}.ogg`);
                const tempWav = path.join(os.tmpdir(), `in_${Date.now()}.wav`);
                fs.writeFileSync(tempOgg, buffer);

                exec(`ffmpeg -i "${tempOgg}" -ar 16000 -ac 1 -c:a pcm_s16le -f s16le "${tempWav}" -y`, (err) => {
                    try { if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg); } catch (e) { }
                    if (err) {
                        console.error('Failed to convert audio:', err);
                        ws.close();
                        return;
                    }
                    if (fs.existsSync(tempWav)) {
                        const wavBuf = fs.readFileSync(tempWav);
                        fs.unlinkSync(tempWav);

                        ws.send(JSON.stringify({
                            type: 'input_audio_buffer.append',
                            audio: wavBuf.toString('base64')
                        }));
                        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                    } else {
                        ws.close();
                    }
                });
            } catch (err) {
                console.error('Failed to download audio message:', err);
                ws.close();
            }
        }
    });

    ws.on('message', async (data) => {
        resetInactivityTimer();
        const message = JSON.parse(data);

        if (message.type === 'response.ai_text.done') {
            await sock.sendMessage(jid, { text: message.text + BOT_TAG });
        } else if (message.type === 'response.image.done') {
            console.log(`[WhatsApp Outbound] Sending generated image to ${jid}`);
            try {
                const imgBuf = Buffer.from(message.image, 'base64');
                await sock.sendMessage(jid, { 
                    image: imgBuf, 
                    caption: (message.full_prompt || "Generated Image") + BOT_TAG 
                });
            } catch (err) {
                console.error('Failed to send image to WhatsApp:', err);
            }
        } else if (message.type === 'response.audio.done') {
            // Only send audio back to WhatsApp if the user's original message was audio
            if (input.type !== 'audio') {
                console.log(`[WhatsApp Outbound] Skipping audio relay for ${jid} because input was ${input.type}`);
                return;
            }
            try {
                console.log(`[WhatsApp Outbound] Processing generated audio chunk for ${jid}`);
                const wavBuf = Buffer.from(message.audio, 'base64');
                const randomId = Math.floor(Math.random() * 100000);
                const tempWav = path.join(os.tmpdir(), `out_${Date.now()}_${randomId}.wav`);
                const tempOgg = path.join(os.tmpdir(), `out_${Date.now()}_${randomId}.ogg`);
                fs.writeFileSync(tempWav, wavBuf);

                exec(`ffmpeg -i "${tempWav}" -c:a libopus -b:a 64k -vbr on -compression_level 10 "${tempOgg}" -y`, async (err) => {
                    if (err) {
                        console.error('Failed to encode outbound audio:', err);
                    } else if (fs.existsSync(tempOgg)) {
                        const oggBuf = fs.readFileSync(tempOgg);
                        await sock.sendMessage(jid, { audio: oggBuf, mimetype: 'audio/ogg; codecs=opus', ptt: true });
                    }
                    try { if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav); } catch (e) { }
                    try { if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg); } catch (e) { }
                });
            } catch (err) {
                console.error('Failed to process outbound audio:', err);
            }
        }
    });

    ws.on('close', () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
    });
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        if (inactivityTimer) clearTimeout(inactivityTimer);
    });
}

connectToWhatsApp();
