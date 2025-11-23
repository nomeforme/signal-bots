import WebSocket from 'ws';
import * as config from './config.js';
import { processMessage, getBotUuid } from './messageHandler.js';

// Global state for tracking WebSocket health
const websocketState = {}; // {bot_phone: {"ws": ws, "lastMessage": timestamp, "connected": bool, "retryCount": int}}
const lastUserMessage = {}; // Track last user message
const pendingMessages = {}; // Messages to re-process after reconnection
const MAX_RECONNECT_RETRIES = 3;

function createMessageHandler(botPhone) {
    return async (data) => {
        try {
            // Update last message time
            if (websocketState[botPhone]) {
                websocketState[botPhone].lastMessage = Date.now();
            }

            const message = JSON.parse(data);
            const envelope = message.envelope || {};
            const source = envelope.source || envelope.sourceNumber || 'unknown';
            const timestamp = envelope.timestamp || 'unknown';
            const dataMessage = envelope.dataMessage || {};

            // Track user messages for consistency checking
            let isFirstReceiverForMessage = false;
            if (dataMessage && timestamp !== 'unknown') {
                // Check if this is a user message (not from a bot)
                let isBotMessage = false;
                for (const state of Object.values(websocketState)) {
                    if (source === state.botName || source === botPhone) {
                        isBotMessage = true;
                        break;
                    }
                }

                if (!isBotMessage) {
                    // This is a user message, track it
                    const messageId = `${source}:${timestamp}`;

                    // Extract mentioned bot UUIDs
                    const mentionedBotUuids = new Set();

                    // Check for @mentions
                    const mentions = dataMessage.mentions || [];
                    for (const mention of mentions) {
                        if (mention.uuid) {
                            mentionedBotUuids.add(mention.uuid);
                        }
                    }

                    // Check for quote/reply
                    const quote = dataMessage.quote;
                    if (quote && quote.authorUuid) {
                        mentionedBotUuids.add(quote.authorUuid);
                    }

                    if (!lastUserMessage[messageId]) {
                        lastUserMessage[messageId] = {
                            timestamp: Date.now(),
                            receivedBy: new Set(),
                            checkScheduled: false,
                            data: message,
                            mentionedBotUuids: mentionedBotUuids
                        };
                        isFirstReceiverForMessage = true;
                    }

                    lastUserMessage[messageId].receivedBy.add(botPhone);

                    // If this is the first bot to receive this message, schedule a check
                    if (isFirstReceiverForMessage && !lastUserMessage[messageId].checkScheduled) {
                        lastUserMessage[messageId].checkScheduled = true;
                        setTimeout(() => checkMessageConsistency(messageId), 3000);
                    }
                }
            }

            await processMessage(message, botPhone, isFirstReceiverForMessage);
        } catch (error) {
            if (error instanceof SyntaxError) {
                console.error(`[${botPhone}] Failed to decode JSON:`, data);
            } else {
                console.error(`[${botPhone}] Error processing message:`, error.message);
                console.error(error.stack);
            }
        }
    };
}

function createWebSocket(botPhone, botName) {
    const ws = new WebSocket(`${config.WS_BASE_URL}/v1/receive/${botPhone}`);
    const messageHandler = createMessageHandler(botPhone);

    ws.on('open', () => {
        console.log(`[${botPhone}] WebSocket connection opened`);

        if (websocketState[botPhone]) {
            websocketState[botPhone].connected = true;
            websocketState[botPhone].lastMessage = Date.now();
            websocketState[botPhone].retryCount = 0;
        }

        // Process any pending messages
        if (pendingMessages[botPhone] && pendingMessages[botPhone].length > 0) {
            const messagesToProcess = [...pendingMessages[botPhone]];
            pendingMessages[botPhone] = [];

            console.log(`[${botPhone}] Re-processing ${messagesToProcess.length} pending message(s)...`);
            for (const msgData of messagesToProcess) {
                processMessage(msgData, botPhone, false)
                    .then(() => console.log(`[${botPhone}] ✓ Successfully re-processed pending message`))
                    .catch(err => console.error(`[${botPhone}] ⚠ Error re-processing message:`, err.message));
            }
        }
    });

    ws.on('message', messageHandler);

    ws.on('error', (error) => {
        console.error(`[${botPhone}] WebSocket Error:`, error.message);
        if (websocketState[botPhone]) {
            websocketState[botPhone].connected = false;
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[${botPhone}] WebSocket connection closed: ${code} - ${reason}`);
        if (websocketState[botPhone]) {
            websocketState[botPhone].connected = false;
        }

        // Attempt reconnection
        console.log(`[${botPhone}] Attempting to reconnect...`);
        setTimeout(() => reconnectWebSocket(botPhone, botName), 1000);
    });

    return ws;
}

function reconnectWebSocket(botPhone, botName) {
    if (!websocketState[botPhone]) {
        console.error(`[${botPhone}] Cannot reconnect - not in websocketState`);
        return;
    }

    if (websocketState[botPhone].connected) {
        console.log(`[${botPhone}] Already connected, skipping reconnect`);
        return;
    }

    const retryCount = websocketState[botPhone].retryCount || 0;

    if (retryCount >= MAX_RECONNECT_RETRIES) {
        console.error(`[${botPhone}] Max reconnection attempts (${MAX_RECONNECT_RETRIES}) reached. Giving up.`);
        websocketState[botPhone].retryCount = 0;
        return;
    }

    websocketState[botPhone].retryCount = retryCount + 1;
    console.log(`[${botPhone}] Reconnecting WebSocket (attempt ${websocketState[botPhone].retryCount}/${MAX_RECONNECT_RETRIES})...`);

    // Close old WebSocket if it exists
    const oldWs = websocketState[botPhone].ws;
    if (oldWs) {
        try {
            oldWs.close();
        } catch (error) {
            console.error(`[${botPhone}] Error closing old WebSocket:`, error.message);
        }
    }

    // Create new WebSocket
    const newWs = createWebSocket(botPhone, botName);
    websocketState[botPhone].ws = newWs;
}

async function checkMessageConsistency(messageId) {
    if (!lastUserMessage[messageId]) return;

    const msgData = lastUserMessage[messageId];
    const receivedBy = msgData.receivedBy;
    const mentionedBotUuids = msgData.mentionedBotUuids;
    const messageData = msgData.data;

    // Get all bot phones and UUIDs
    const allBots = {};
    const botUuidToPhone = {};

    for (const phone of Object.keys(websocketState)) {
        const state = websocketState[phone];
        allBots[phone] = state.botName || 'unknown';

        const botUuid = getBotUuid(phone);
        if (botUuid) {
            botUuidToPhone[botUuid] = phone;
        }
    }

    const missingBots = new Set(Object.keys(allBots));
    for (const phone of receivedBy) {
        missingBots.delete(phone);
    }

    // Determine which missing bots were mentioned
    const mentionedMissingBots = new Set();
    for (const botUuid of mentionedBotUuids) {
        const botPhone = botUuidToPhone[botUuid];
        if (botPhone && missingBots.has(botPhone)) {
            mentionedMissingBots.add(botPhone);
        }
    }

    if (missingBots.size > 0) {
        console.log('\n============================================================');
        console.log('MESSAGE CONSISTENCY CHECK');
        console.log('============================================================');
        console.log(`Message ID: ${messageId}`);
        console.log(`Received by: ${receivedBy.size}/${Object.keys(allBots).length} bots`);

        if (mentionedMissingBots.size > 0) {
            console.log('\n⚠ MENTIONED bots that MISSED the message:');
            for (const phone of mentionedMissingBots) {
                const botName = allBots[phone] || 'unknown';
                console.log(`  ✗ [${phone}] (${botName}) - WILL RECONNECT AND RE-TRIGGER`);
            }
        }

        const otherMissing = new Set([...missingBots].filter(p => !mentionedMissingBots.has(p)));
        if (otherMissing.size > 0) {
            console.log('\nOther bots that missed (not mentioned, ignoring):');
            for (const phone of otherMissing) {
                const botName = allBots[phone] || 'unknown';
                console.log(`  • [${phone}] (${botName})`);
            }
        }

        // Only reconnect mentioned bots
        if (mentionedMissingBots.size > 0) {
            console.log(`\nReconnecting ${mentionedMissingBots.size} mentioned bot(s)...`);

            for (const botPhone of mentionedMissingBots) {
                // Queue the message for re-processing
                if (!pendingMessages[botPhone]) {
                    pendingMessages[botPhone] = [];
                }
                pendingMessages[botPhone].push(messageData);

                if (websocketState[botPhone]) {
                    const botName = websocketState[botPhone].botName || 'unknown';
                    console.log(`  → Reconnecting [${botPhone}] (${botName}) and will re-trigger response`);

                    const ws = websocketState[botPhone].ws;
                    if (ws) {
                        try {
                            websocketState[botPhone].connected = false;
                            ws.close();
                        } catch (error) {
                            console.error(`    ⚠ Error closing connection:`, error.message);
                        }
                    }
                }
            }
        } else {
            console.log('\nℹ No mentioned bots missed the message, no reconnection needed');
        }

        console.log('============================================================\n');
    } else {
        console.log(`✓ Message consistency OK: ${messageId.substring(0, 40)}... (${receivedBy.size}/${Object.keys(allBots).length} bots)`);
    }
}

function checkWebSocketHealth() {
    // Monitor WebSocket health and clean up old message tracking
    setInterval(() => {
        const now = Date.now();

        // Clean up old message tracking (older than 5 minutes)
        for (const messageId of Object.keys(lastUserMessage)) {
            if (now - lastUserMessage[messageId].timestamp > 5 * 60 * 1000) {
                delete lastUserMessage[messageId];
            }
        }

        // Check WebSocket connections
        for (const [botPhone, state] of Object.entries(websocketState)) {
            const botName = state.botName || 'unknown';

            // Check if connection is stale (no messages for 5 minutes)
            if (state.connected && state.lastMessage && now - state.lastMessage > 5 * 60 * 1000) {
                console.warn(`\nWARNING - [${botPhone}] (${botName}) WebSocket appears stale (no messages for 5 min). Reconnecting...`);
                reconnectWebSocket(botPhone, botName);
            }
        }
    }, 30000); // Check every 30 seconds
}

// Main startup
async function main() {
    console.log('Starting Signal AI Chat Bot (Node.js)...\n');

    // Start WebSocket connections for each bot
    for (const bot of config.BOT_INSTANCES) {
        const botPhone = bot.phone;
        const botName = bot.name;

        console.log(`Starting WebSocket for bot: ${botName} (${botPhone})`);

        websocketState[botPhone] = {
            ws: null,
            botName: botName,
            connected: false,
            lastMessage: Date.now(),
            retryCount: 0
        };

        const ws = createWebSocket(botPhone, botName);
        websocketState[botPhone].ws = ws;
    }

    // Start health monitoring
    checkWebSocketHealth();

    console.log(`\n✓ All ${config.BOT_INSTANCES.length} bot(s) started`);
    console.log('Listening for messages...\n');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    for (const [botPhone, state] of Object.entries(websocketState)) {
        if (state.ws) {
            state.ws.close();
        }
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...');
    for (const [botPhone, state] of Object.entries(websocketState)) {
        if (state.ws) {
            state.ws.close();
        }
    }
    process.exit(0);
});

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
