import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import WebSocket from 'ws';

const SERVER_URL = 'ws://localhost:8345/v1/realtime';
const SESSION_DIR = './whatsapp_sessions';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
        auth: state,
        browser: Browsers.ubuntu('Chrome'), // Fix for 405 Method Not Allowed
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
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting in 5s...');
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 5000); // 5s delay to avoid hammering
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection opened successfully!');
        }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderJid = msg.key.remoteJid;
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text;
        
        if (!body) return;

        console.log(`[WhatsApp Inbound] From: ${senderJid} Content: "${body}"`);

        // Connect to Sentience WebSocket per session
        handleAIGeneratedResponse(sock, senderJid, body);
    });
}

/**
 * Handle communication with the Sentience Agent
 */
function handleAIGeneratedResponse(sock, jid, text) {
    const ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
        // Initialize session with the sender's JID as ID
        ws.send(JSON.stringify({
            type: 'session.update',
            session: {
                session_id: jid,
                client_type: 'text'
            }
        }));

        // Send the user message
        ws.send(JSON.stringify({
            type: 'input_text',
            text: text
        }));
    });

    ws.on('message', async (data) => {
        const message = JSON.parse(data);
        if (message.type === 'response.ai_text.done') {
            const aiText = message.text;
            console.log(`[WhatsApp Outbound] To: ${jid} Content: "${aiText}"`);
            
            // Send back to WhatsApp
            await sock.sendMessage(jid, { text: aiText });
            
            // Close WS after responding (since WA is stateless/message-based)
            ws.close();
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket Error:', err.message);
    });
}

connectToWhatsApp();
