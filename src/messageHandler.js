import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import AWS from 'aws-sdk';
import sharp from 'sharp';
import * as config from './config.js';
import { User } from './user.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize AI clients
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API);
const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Initialize Bedrock client (will only be used if AWS credentials are present)
let bedrockClient = null;
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    bedrockClient = new AWS.BedrockRuntime({
        region: process.env.AWS_REGION || 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });
}

// Global state
export const users = {};
export const botUuidCache = {}; // Cache for bot phone -> UUID mapping
export const groupHistories = {}; // Shared conversation history for group chats
export const userNameToPhone = {}; // Cache for mapping display names to phone numbers

export function getBotUuid(botPhone) {
    if (botUuidCache[botPhone]) {
        return botUuidCache[botPhone];
    }

    // Try to get UUID from accounts endpoint
    try {
        const accountsPaths = [
            '/home/.local/share/signal-api/data/accounts.json',  // Docker volume mount
            path.join(process.env.HOME, '.local/share/signal-api/data/accounts.json')  // Non-container
        ];

        console.log('[DEBUG] Looking for accounts.json in paths:');
        for (const accountsPath of accountsPaths) {
            console.log(`[DEBUG]   - ${accountsPath}: ${fs.existsSync(accountsPath) ? 'EXISTS' : 'NOT FOUND'}`);
        }

        let accountsFile = null;
        for (const accountsPath of accountsPaths) {
            if (fs.existsSync(accountsPath)) {
                accountsFile = accountsPath;
                break;
            }
        }

        if (accountsFile) {
            console.log(`[DEBUG] Reading accounts from: ${accountsFile}`);
            const data = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
            console.log(`[DEBUG] Accounts file contents: ${JSON.stringify(data, null, 2)}`);

            for (const account of (data.accounts || [])) {
                if (account.number === botPhone) {
                    const uuid = account.uuid;
                    if (uuid) {
                        botUuidCache[botPhone] = uuid;
                        console.log(`[DEBUG] Found UUID for ${botPhone}: ${uuid}`);
                        return uuid;
                    }
                }
            }
        } else {
            console.error('[DEBUG] No accounts.json file found in any of the searched paths!');
        }
    } catch (error) {
        console.warn(`Warning: Could not fetch UUID for ${botPhone}:`, error.message);
    }

    return null;
}

export function detectMentionsInText(text, groupId = null) {
    if (!text || !groupId) {
        return [text, []];
    }

    const mentions = [];
    let modifiedText = text;

    // Build a list of names to search for
    const botNameToPhone = {};
    for (const bot of config.BOT_INSTANCES) {
        botNameToPhone[bot.name] = bot.phone;
    }

    // Combine bot names and user names
    const nameToPhone = { ...botNameToPhone, ...userNameToPhone };

    // Sort names by length (longest first) to avoid partial matches
    const sortedNames = Object.keys(nameToPhone).sort((a, b) => b.length - a.length);

    for (const name of sortedNames) {
        const phone = nameToPhone[name];
        let searchPos = 0;

        while (true) {
            const pos = modifiedText.indexOf(name, searchPos);
            if (pos === -1) break;

            // Check word boundaries
            const beforeOk = pos === 0 || ' \n\t,.:;!?@'.includes(modifiedText[pos - 1]);
            const afterOk = pos + name.length >= modifiedText.length || ' \n\t,.:;!?@'.includes(modifiedText[pos + name.length]);

            if (beforeOk && afterOk) {
                // Calculate UTF-16 position
                const utf16Start = Buffer.from(modifiedText.substring(0, pos), 'utf16le').length / 2;

                // Replace the name with Signal's object replacement character
                const replacement = '\uFFFC';
                modifiedText = modifiedText.substring(0, pos) + replacement + modifiedText.substring(pos + name.length);

                console.log(`DEBUG - Creating mention for '${name}' -> phone: ${phone}`);
                mentions.push({
                    start: utf16Start,
                    length: 1,
                    author: phone
                });

                searchPos = pos + 1;
            } else {
                searchPos = pos + 1;
            }
        }
    }

    return [modifiedText, mentions];
}

export function getHelpMessage(privacyMode) {
    const modelsList = config.VALID_MODELS.join('\n  ');

    let privacyHelp;
    if (privacyMode === 'opt-in') {
        privacyHelp = `💬 Group Chat Usage (Opt-In Mode):
- @mention the bot to use commands or get responses
- Prefix messages with . (dot) to include in conversation history without response
- Messages without mention or . prefix are ignored (privacy-first)`;
    } else {
        privacyHelp = `💬 Group Chat Usage (Opt-Out Mode):
- @mention the bot to use commands or get responses
- Bot sees and learns from all group messages
- Prefix messages with . (dot) to exclude from conversation history`;
    }

    return `
📋 Available Commands:
- !help: Show this help message
- !cm <number>: Change AI model
- !cup <text>: Set a custom system prompt
- !privacy <opt-in|opt-out>: Change privacy mode for this chat
- @mention + !rr <number>: Set random reply chance (0=off, 1=100%, 10=10%, etc.)

${privacyHelp}

🤖 Available Models:
  ${modelsList}
`;
}

export async function downloadAttachment(attachmentId) {
    const url = `${config.HTTP_BASE_URL}/v1/attachments/${attachmentId}`;
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (error) {
        console.error(`Error downloading attachment ${attachmentId}:`, error.message);
        return null;
    }
}

export async function getGroupIdFromInternal(internalId, botPhone) {
    const url = `${config.HTTP_BASE_URL}/v1/groups/${botPhone}`;
    try {
        const response = await axios.get(url);
        const groups = response.data;
        for (const group of groups) {
            if (group.internal_id === internalId) {
                return group.id;
            }
        }
    } catch (error) {
        console.error(`Error fetching groups for ${botPhone}:`, error.message);
    }
    return null;
}

export async function getGroupMembers(groupId, botPhone) {
    const url = `${config.HTTP_BASE_URL}/v1/groups/${botPhone}/${groupId}`;
    try {
        const response = await axios.get(url);
        const groupInfo = response.data;

        // Build UUID to bot name mapping
        const botNamesByUuid = {};
        for (const bot of config.BOT_INSTANCES) {
            const botUuid = getBotUuid(bot.phone);
            if (botUuid) {
                botNamesByUuid[botUuid] = bot.name;
            }
        }

        const participants = [];
        for (const member of (groupInfo.members || [])) {
            if (typeof member === 'string') {
                // Member is a UUID or phone number string
                if (member.startsWith('+')) {
                    // Phone number - use last 4 digits
                    participants.push(`${member.slice(-4)}`);
                } else {
                    // UUID - check if it's a bot
                    if (botNamesByUuid[member]) {
                        participants.push(botNamesByUuid[member]);
                    } else {
                        // Unknown UUID - show shortened version
                        participants.push(`${member.substring(0, 8)}...`);
                    }
                }
            } else if (typeof member === 'object') {
                // Member is an object with profile info
                const name = member.profile_name || member.number || member.uuid || 'Unknown';
                participants.push(name);
            }
        }

        return participants;
    } catch (error) {
        console.error(`Error fetching group members for ${groupId}:`, error.message);
        return [];
    }
}

export function getOrCreateUser(sender, groupId = null, botPhone = null) {
    const key = groupId ? `${sender}:${groupId}:${botPhone}` : `${sender}:${botPhone}`;

    if (!users[key]) {
        const botConfig = config.BOT_CONFIGS[botPhone] || {};
        const defaultModel = botConfig.model || config.DEFAULT_MODEL;
        const defaultPrompt = botConfig.prompt || config.DEFAULT_SYSTEM_INSTRUCTION;

        const systemInstruction = config.SYSTEM_INSTRUCTIONS[defaultPrompt] !== undefined
            ? config.SYSTEM_INSTRUCTIONS[defaultPrompt]
            : defaultPrompt;

        users[key] = new User(sender, systemInstruction, defaultModel, groupId, botPhone);
    }

    return users[key];
}

function handleChangePromptCmd(user, systemInstructionNumber) {
    const trimmed = systemInstructionNumber.trim();
    if (Object.keys(config.SYSTEM_INSTRUCTIONS).includes(trimmed)) {
        const instruction = config.SYSTEM_INSTRUCTIONS[trimmed];
        user.setSystemInstruction(instruction);
        user.sendMessage(`System instruction changed to: "${trimmed}"`);
    } else {
        const promptsList = Object.keys(config.SYSTEM_INSTRUCTIONS).join('\n');
        user.sendMessage(`Invalid system instruction. Available instructions:\n${promptsList}`);
    }
}

function handleChangeModelCmd(user, aiModelNumber) {
    const trimmed = aiModelNumber.trim();
    if (config.VALID_MODELS.includes(trimmed)) {
        user.setModel(trimmed);
        user.sendMessage(`Model changed to: "${trimmed}"`);
    } else {
        const modelsList = config.VALID_MODELS.join('\n');
        user.sendMessage(`Invalid model. Available models:\n${modelsList}`);
    }
}

function handleCustomPromptCmd(user, customPrompt) {
    user.setSystemInstruction(customPrompt.trim());
    user.sendMessage('Custom system prompt set successfully');
}

function handleImageSizeCmd(user, sizeNumber) {
    if (/^\d+$/.test(sizeNumber) && parseInt(sizeNumber) >= 1 && parseInt(sizeNumber) <= Object.keys(config.IMAGE_SIZES).length) {
        const imageSizeName = Object.keys(config.IMAGE_SIZES)[parseInt(sizeNumber) - 1];
        user.setImageSize(config.IMAGE_SIZES[imageSizeName]);
        user.sendMessage(`Image size changed to: "${imageSizeName}" with ${JSON.stringify(user.imageSize)}`);
    } else {
        const sizesList = Object.keys(config.IMAGE_SIZES).join('\n');
        user.sendMessage(`Invalid image size. Available sizes:\n${sizesList}`);
    }
}

function handlePrivacyCmd(user, mode) {
    const trimmedMode = mode.toLowerCase().trim();
    if (user.setPrivacyMode(trimmedMode)) {
        user.sendMessage(`Privacy mode changed to: "${trimmedMode}"`);
    } else {
        user.sendMessage("Invalid privacy mode. Use 'opt-in' or 'opt-out'.");
    }
}

function handleRandomReplyCmd(user, chance) {
    const trimmed = chance.trim();

    if (!trimmed) {
        // Show current setting
        if (config.RANDOM_REPLY_CHANCE === 0) {
            user.sendMessage('Random reply is currently disabled (0)');
        } else {
            const percentage = (1 / config.RANDOM_REPLY_CHANCE) * 100;
            user.sendMessage(`Random reply chance: 1/${config.RANDOM_REPLY_CHANCE} (${percentage.toFixed(1)}%)`);
        }
        return;
    }

    if (/^\d+$/.test(trimmed)) {
        const newChance = parseInt(trimmed);
        if (newChance >= 0) {
            config.setRandomReplyChance(newChance);
            if (newChance === 0) {
                user.sendMessage('Random reply disabled');
            } else if (newChance === 1) {
                user.sendMessage('Random reply set to 1/1 (100%) - bots will reply to every message');
            } else {
                const percentage = (1 / newChance) * 100;
                user.sendMessage(`Random reply chance set to 1/${newChance} (${percentage.toFixed(1)}%)`);
            }
        } else {
            user.sendMessage('Invalid value. Use a number >= 0 (0 = disabled, 1 = 100%, 10 = 10%, etc.)');
        }
    } else {
        user.sendMessage('Invalid value. Use a number >= 0 (0 = disabled, 1 = 100%, 10 = 10%, etc.)');
    }
}

async function handleGenerateImageCmd(user, prompt) {
    // Image generation not fully ported - placeholder
    user.sendMessage('Image generation not yet implemented in Node.js version');
}

export async function handleAiMessage(user, content, attachments, senderName = null, shouldRespond = true, isFirstReceiver = false) {
    // Prepend sender name to content for group chats
    if (user.groupId && senderName) {
        if (content) {
            content = `[${senderName}]: ${content}`;
        } else {
            content = `[${senderName}] sent an image`;
        }
    }

    const messageComponents = content ? [content] : [];
    const modelName = user.currentModel.split(' ')[1];
    const isBedrock = modelName.startsWith('bedrock-');
    const isClaude = modelName.startsWith('claude-') || isBedrock;

    // Process attachments for image understanding
    const imageContents = [];
    for (const attachment of attachments) {
        const attachmentId = attachment.id;
        if (attachmentId) {
            const attachmentData = await downloadAttachment(attachmentId);
            if (attachmentData) {
                if (isClaude) {
                    // Claude expects base64-encoded images
                    const base64Data = attachmentData.toString('base64');
                    imageContents.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: base64Data
                        }
                    });
                } else {
                    // Gemini uses different format - simplified for now
                    console.warn('Gemini image handling not fully implemented yet');
                }
            }
        }
    }

    if (messageComponents.length > 0 || imageContents.length > 0) {
        try {
            if (isClaude) {
                // Handle Claude/Bedrock API
                user.getOrCreateChatSession();

                // Build the message content
                const claudeMessageContent = [];
                if (imageContents.length > 0) {
                    claudeMessageContent.push(...imageContents);
                }
                if (content) {
                    claudeMessageContent.push({ type: 'text', text: content });
                }

                // For group chats, use shared history; for DMs, use user-specific history
                let conversationHistory;
                if (user.groupId) {
                    // Initialize shared group history if needed
                    if (!groupHistories[user.groupId]) {
                        groupHistories[user.groupId] = [];
                    }

                    // Add user message to shared group history
                    // Only the first bot to receive a message should add it to shared history
                    if (isFirstReceiver) {
                        groupHistories[user.groupId].push({
                            role: 'user',
                            content: claudeMessageContent
                        });
                    }

                    // Trim shared history
                    if (groupHistories[user.groupId].length > config.MAX_HISTORY_MESSAGES) {
                        groupHistories[user.groupId] = groupHistories[user.groupId].slice(-config.MAX_HISTORY_MESSAGES);
                        console.log(`DEBUG - Trimmed shared group history to last ${config.MAX_HISTORY_MESSAGES} messages`);
                    }

                    // Use shared history for this conversation
                    conversationHistory = groupHistories[user.groupId];
                } else {
                    // For DMs, use individual history
                    user.claudeHistory.push({
                        role: 'user',
                        content: claudeMessageContent
                    });

                    // Trim individual history
                    if (user.claudeHistory.length > config.MAX_HISTORY_MESSAGES) {
                        user.claudeHistory = user.claudeHistory.slice(-config.MAX_HISTORY_MESSAGES);
                        console.log(`DEBUG - Trimmed history to last ${config.MAX_HISTORY_MESSAGES} messages`);
                    }

                    conversationHistory = user.claudeHistory;
                }

                // If we shouldn't respond, just add to history and return
                if (!shouldRespond) {
                    console.log('DEBUG - Message added to history but not responding (not mentioned)');
                    return;
                }

                // Build system prompt
                const cleanModelName = modelName.split('-').slice(0, -1).join('-') || modelName;
                const identityContext = `Your model identifier is [${cleanModelName}].
Always use this when asked about your identity.`;

                let systemPrompt;
                const signalFormatting = `Signal supports these text formatting options:
- *bold* for bold
- _italic_ for italic
- ~monospace~ for monospace
- ~strikethrough~ for strikethrough`;

                if (user.groupId) {
                    const participants = await getGroupMembers(user.groupId, user.botPhone);
                    const participantsList = participants.length > 0 ? participants.join(', ') : 'unable to retrieve participant list';

                    const groupContext = `You are in a group chat with users and other AI bots.
Participants in this group: ${participantsList}
Messages are prefixed with [participant] to indicate the participant.
Be parsimonious, if you wish to directly address another participant (which will notify them),
mention their name in your response (with @participant).`;

                    if (user.currentSystemInstruction) {
                        systemPrompt = `${user.currentSystemInstruction}\n\n${identityContext}\n\n${groupContext}\n\n${signalFormatting}`;
                    } else {
                        systemPrompt = `${identityContext}\n\n${groupContext}\n\n${signalFormatting}`;
                    }
                } else {
                    // Individual chat
                    if (user.currentSystemInstruction) {
                        systemPrompt = `${user.currentSystemInstruction}\n\n${identityContext}\n\n${signalFormatting}`;
                    } else {
                        systemPrompt = `${identityContext}\n\n${signalFormatting}`;
                    }
                }

                // Make API call
                let aiResponse;
                if (isBedrock) {
                    // Use AWS Bedrock
                    if (!bedrockClient) {
                        throw new Error('AWS Bedrock credentials not configured');
                    }

                    const baseModel = modelName.replace('bedrock-', '');
                    let bedrockModelId;
                    if (modelName.includes('claude-3-5-sonnet-20241022')) {
                        bedrockModelId = `us.anthropic.${baseModel}-v2:0`;
                    } else {
                        bedrockModelId = `anthropic.${baseModel}-v1:0`;
                    }

                    // Merge consecutive user messages for Bedrock
                    function mergeConsecutiveUserMessages(messages, insertSeparatorsFor3Sonnet = false) {
                        if (!messages || messages.length === 0) return messages;

                        const merged = [];
                        let i = 0;

                        while (i < messages.length) {
                            const current = messages[i];

                            if (current.role === 'user') {
                                const userContents = [];

                                while (i < messages.length && messages[i].role === 'user') {
                                    const content = messages[i].content;
                                    if (typeof content === 'string') {
                                        userContents.push({ type: 'text', text: content });
                                    } else if (Array.isArray(content)) {
                                        userContents.push(...content);
                                    }
                                    i++;
                                }

                                // Merge all user contents
                                const mergedContent = [];
                                const textParts = [];
                                for (const item of userContents) {
                                    if (item.type === 'text') {
                                        textParts.push(item.text);
                                    } else {
                                        if (textParts.length > 0) {
                                            mergedContent.push({ type: 'text', text: textParts.join('\n') });
                                            textParts.length = 0;
                                        }
                                        mergedContent.push(item);
                                    }
                                }
                                if (textParts.length > 0) {
                                    mergedContent.push({ type: 'text', text: textParts.join('\n') });
                                }

                                merged.push({ role: 'user', content: mergedContent });
                            } else {
                                // Assistant message
                                if (insertSeparatorsFor3Sonnet && merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
                                    merged.push({ role: 'user', content: [{ type: 'text', text: '[continue]' }] });
                                }
                                merged.push(current);
                                i++;
                            }
                        }

                        return merged;
                    }

                    const is3Sonnet = modelName.includes('bedrock-claude-3-sonnet-20240229');
                    const bedrockConversation = mergeConsecutiveUserMessages(conversationHistory, is3Sonnet);

                    const bedrockBody = {
                        anthropic_version: 'bedrock-2023-05-31',
                        max_tokens: 4096,
                        messages: bedrockConversation,
                        system: systemPrompt
                    };

                    const params = {
                        modelId: bedrockModelId,
                        body: JSON.stringify(bedrockBody),
                        contentType: 'application/json',
                        accept: 'application/json'
                    };

                    const response = await bedrockClient.invokeModel(params).promise();
                    const responseBody = JSON.parse(response.body.toString());

                    const textContent = responseBody.content.find(c => c.type === 'text');
                    aiResponse = textContent ? textContent.text : '';
                } else {
                    // Use Anthropic API
                    const response = await anthropicClient.messages.create({
                        model: modelName,
                        max_tokens: 4096,
                        system: systemPrompt,
                        messages: conversationHistory
                    });

                    const textContent = response.content.find(c => c.type === 'text');
                    aiResponse = textContent ? textContent.text : '';
                }

                // Detect and convert mentions in the response
                const [modifiedResponse, mentions] = detectMentionsInText(aiResponse, user.groupId);

                // Send the response
                await user.sendMessage(modifiedResponse, null, mentions.length > 0 ? mentions : null);

                // Add assistant response to history
                let historyResponse;
                if (user.groupId && cleanModelName) {
                    historyResponse = `[${cleanModelName}]: ${aiResponse}`;
                } else {
                    historyResponse = aiResponse;
                }

                if (user.groupId) {
                    // Add to shared group history (only if not a duplicate of last message)
                    let responseAlreadyExists = false;
                    if (groupHistories[user.groupId].length > 0) {
                        const lastMsg = groupHistories[user.groupId][groupHistories[user.groupId].length - 1];
                        if (lastMsg.role === 'assistant' && lastMsg.content === historyResponse) {
                            responseAlreadyExists = true;
                        }
                    }

                    if (!responseAlreadyExists) {
                        groupHistories[user.groupId].push({
                            role: 'assistant',
                            content: historyResponse
                        });
                    }
                } else {
                    // Add to individual history
                    user.claudeHistory.push({
                        role: 'assistant',
                        content: historyResponse
                    });
                }
            } else {
                // Handle Gemini API - simplified placeholder
                user.sendMessage('Gemini support not fully implemented in Node.js version yet');
            }
        } catch (error) {
            console.error('Error generating AI response:', error.message);
            await user.sendMessage(`Sorry, I encountered an error: ${error.message}`);
        }
    } else {
        await user.sendMessage('I received your message, but it seems to be empty.');
    }
}

export async function processMessage(message, botPhone = null, isFirstReceiver = false) {
    if (!message.envelope) return;
    if (!message.envelope.dataMessage) return;

    const envelope = message.envelope;
    const dataMessage = envelope.dataMessage;

    const sender = envelope.sourceNumber || envelope.source || 'unknown';
    const senderUuid = envelope.sourceUuid;
    const senderName = envelope.sourceName || '';
    const timestamp = new Date(envelope.timestamp);
    let content = dataMessage.message || '';
    const attachments = dataMessage.attachments || [];

    // Handle empty messages (e.g., image-only messages)
    if (!content && !attachments.length) {
        return;
    }

    // Clean content: Remove object replacement character (￼) that Signal adds for @mentions
    // and strip whitespace
    content = content.replace(/\ufffc/g, '').trim();

    if (!content && !attachments.length) {
        return;
    }

    // Cache sender name -> phone mapping
    if (senderName && sender) {
        userNameToPhone[senderName] = sender;
    }

    // Check if this is a group message
    const groupInfo = dataMessage.groupInfo || dataMessage.groupV2;
    const isGroupChat = !!groupInfo;
    let groupId = null;

    if (isGroupChat) {
        // Convert internal group ID to proper Signal API group ID
        const internalGroupId = groupInfo.groupId;
        groupId = await getGroupIdFromInternal(internalGroupId, botPhone);
        if (!groupId) {
            // Fallback if conversion fails
            groupId = internalGroupId;
        }
    }

    // Check if bot is mentioned
    const mentions = dataMessage.mentions || [];
    const botUuid = getBotUuid(botPhone);
    let botMentioned = false;

    for (const mention of mentions) {
        if ((botUuid && mention.uuid === botUuid) || mention.number === botPhone) {
            botMentioned = true;
            break;
        }
    }

    // Also check for quote/reply
    const quote = dataMessage.quote;
    if (quote) {
        const quoteAuthorUuid = quote.authorUuid;
        if ((botUuid && quoteAuthorUuid === botUuid) || quote.author === botPhone) {
            botMentioned = true;
        }
    }

    // Log message
    const displaySender = senderName || sender;
    if (isGroupChat) {
        const shortUuid = senderUuid ? senderUuid.substring(0, 8) : '';
        console.log(`Received GROUP message from ${displaySender} (${shortUuid}...) in ${groupId.substring(0, 30)}... at ${timestamp}: ${content}`);
        console.log(`DEBUG - Mentions: ${JSON.stringify(mentions.map(m => m.uuid || m.number))}`);
    } else {
        console.log(`Received message from ${displaySender} (${sender}) at ${timestamp}: ${content}`);
    }

    // Parse command if there's text content (BEFORE privacy filtering)
    let command = '';
    let args = '';
    if (content) {
        const parts = content.split(/\s+/);
        command = parts[0].toLowerCase();
        args = parts.slice(1).join(' ').trim();
    } else if (!content && attachments.length > 0) {
        // No text, but has attachments - treat as AI message
        command = '';
        args = '';
    }

    // Create or get user object
    const user = getOrCreateUser(sender, groupId, botPhone);

    // Check if sender is a bot
    let senderIsBot = false;
    if (isGroupChat && groupId) {
        for (const bot of config.BOT_INSTANCES) {
            const uuid = getBotUuid(bot.phone);
            if (sender === bot.phone || (uuid && senderUuid === uuid)) {
                senderIsBot = true;
                break;
            }
        }

        // Track bot interactions
        if (senderIsBot) {
            if (botMentioned) {
                if (user.isBotLoopLimitReached()) {
                    console.log(`[BOT LOOP PREVENTION] ⚠ Limit reached (${user.botInteractionCount}/${config.MAX_BOT_MENTIONS_PER_CONVERSATION})! Skipping to prevent infinite loop.`);
                    return;
                }
                user.incrementBotInteractionCounter();
                console.log(`[BOT LOOP PREVENTION] ${botPhone.substring(0, 15)}... mentioned by bot. Count: ${user.botInteractionCount}/${config.MAX_BOT_MENTIONS_PER_CONVERSATION}`);
            }
        } else {
            // Human message - reset all bot counters in this group
            for (const userKey of Object.keys(users)) {
                if (userKey.endsWith(`:${groupId}`)) {
                    users[userKey].resetBotInteractionCounter();
                }
            }
            console.log('[BOT LOOP PREVENTION] Human message detected. Reset all bot counters in group.');
        }
    }

    // Apply privacy filtering for group chats
    let shouldRespond = false;

    if (isGroupChat) {
        const isCommand = content.startsWith('!');

        if (senderIsBot) {
            // Bot messages always get stored and processed, regardless of privacy settings
            shouldRespond = botMentioned;
        } else {
            // Human messages: apply privacy filtering
            if (user.privacyMode === 'opt-in') {
                // Opt-in mode: Only store if prefixed with "." OR bot is mentioned
                const storeInHistory = content.startsWith('.') || botMentioned;
                // Only respond if bot is mentioned (this includes commands)
                shouldRespond = botMentioned;

                if (!storeInHistory) return;

                // If message starts with ".", remove the prefix for processing
                if (content.startsWith('.')) {
                    content = content.substring(1).trim();
                }
            } else {
                // Opt-out mode: Store all messages UNLESS prefixed with "."
                if (content.startsWith('.')) {
                    // User explicitly opted out of this message
                    return;
                }

                // Store all other messages (commands, mentions, and regular messages)
                // Only respond if bot is mentioned (this includes commands)
                shouldRespond = botMentioned;
            }
        }

        // Random reply feature: Give bot a chance to respond even when not mentioned
        if (!shouldRespond && config.RANDOM_REPLY_CHANCE > 0) {
            // If sender is a bot, check if we've already hit the interaction limit
            if (senderIsBot && user.isBotLoopLimitReached()) {
                console.log(`[BOT LOOP PREVENTION] ⚠ Random reply skipped - interaction limit reached (${user.botInteractionCount}/${config.MAX_BOT_MENTIONS_PER_CONVERSATION})`);
            } else if (Math.floor(Math.random() * config.RANDOM_REPLY_CHANCE) + 1 === 1) {
                shouldRespond = true;
                console.log(`DEBUG - Random reply triggered for ${botPhone} (1/${config.RANDOM_REPLY_CHANCE} chance)`);
                // If this is a random reply to a bot message, increment the interaction counter
                if (senderIsBot) {
                    user.incrementBotInteractionCounter();
                    console.log(`[BOT LOOP PREVENTION] Random reply to bot message. Count: ${user.botInteractionCount}/${config.MAX_BOT_MENTIONS_PER_CONVERSATION}`);
                }
            }
        }
    } else {
        // DMs always respond
        shouldRespond = true;
    }

    // Handle commands - in group chats, only execute if bot is mentioned
    // In DMs, always execute commands
    const shouldExecuteCommand = !isGroupChat || shouldRespond;

    if (command === '!help' && shouldExecuteCommand) {
        await user.sendMessage(getHelpMessage(user.privacyMode));
    } else if (command === '!cp' && shouldExecuteCommand) {
        handleChangePromptCmd(user, args);
    } else if (command === '!cm' && shouldExecuteCommand) {
        handleChangeModelCmd(user, args);
    } else if (command === '!cup' && shouldExecuteCommand) {
        handleCustomPromptCmd(user, args);
    } else if (command === '!im' && user.trusted && shouldExecuteCommand) {
        await handleGenerateImageCmd(user, args);
    } else if (command === '!is' && shouldExecuteCommand) {
        handleImageSizeCmd(user, args);
    } else if (command === '!privacy' && shouldExecuteCommand) {
        handlePrivacyCmd(user, args);
    } else if (command === '!rr' && shouldExecuteCommand) {
        handleRandomReplyCmd(user, args);
    } else {
        await handleAiMessage(user, content, attachments, senderName, shouldRespond, isFirstReceiver);
    }
}
