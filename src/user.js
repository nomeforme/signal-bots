import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as config from './config.js';

export class User {
    constructor(phoneNumber, defaultSystemInstruction, defaultModel, groupId = null, botPhone = null) {
        this.phoneNumber = phoneNumber;
        this.groupId = groupId; // null for individual chats, group ID for group chats
        this.botPhone = botPhone || config.SIGNAL_PHONE_NUMBER; // Bot's phone number
        this.currentSystemInstruction = defaultSystemInstruction;
        this.currentModel = defaultModel;
        this.trusted = config.TRUSTED_PHONE_NUMBERS.includes(phoneNumber);
        this.lastActivity = null;
        this.chatSession = null;
        this.claudeHistory = []; // Store Claude conversation history
        this.imageSize = config.DEFAULT_IMAGE_SIZE;
        // Privacy mode: defaults to config value, but can be overridden per user/group
        this.privacyMode = config.GROUP_PRIVACY_MODE;
        // Bot interaction counter to prevent infinite loops (tracks mentions and random replies to bot messages)
        this.botInteractionCount = 0;
    }

    isSessionInactive(timeout = config.SESSION_TIMEOUT) {
        if (!this.lastActivity) {
            return true;
        }
        const now = new Date();
        const diff = (now - this.lastActivity) / 1000 / 60; // minutes
        return diff > timeout;
    }

    resetSession() {
        this.chatSession = null;
        this.claudeHistory = [];
    }

    getOrCreateChatSession() {
        if (!this.chatSession || this.isSessionInactive()) {
            const modelName = this.currentModel.split(' ')[1];
            // Check if it's a Claude model
            if (modelName.startsWith('claude-')) {
                // For Claude, we don't create a session object, just reset history
                this.claudeHistory = [];
                this.chatSession = 'claude'; // Marker to indicate Claude is active
            } else {
                // Gemini models
                const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API);
                const modelConfig = this.currentSystemInstruction
                    ? { model: modelName, systemInstruction: this.currentSystemInstruction }
                    : { model: modelName };
                const model = genAI.getGenerativeModel(modelConfig);
                this.chatSession = model.startChat({ history: [] });
            }
            this.lastActivity = new Date();
        }
        return this.chatSession;
    }

    setModel(modelName) {
        this.currentModel = modelName;
        this.resetSession();
    }

    setSystemInstruction(systemInstruction) {
        this.currentSystemInstruction = systemInstruction;
        this.resetSession();
    }

    setImageSize(size) {
        this.imageSize = size;
    }

    setPrivacyMode(mode) {
        if (['opt-in', 'opt-out'].includes(mode)) {
            this.privacyMode = mode;
            return true;
        }
        return false;
    }

    incrementBotInteractionCounter() {
        this.botInteractionCount++;
    }

    resetBotInteractionCounter() {
        this.botInteractionCount = 0;
    }

    isBotLoopLimitReached() {
        return this.botInteractionCount >= config.MAX_BOT_MENTIONS_PER_CONVERSATION;
    }

    _splitMessage(content, maxLength = 400) {
        if (!content || content.length <= maxLength) {
            return content ? [content] : [];
        }

        const chunks = [];
        const lines = content.split('\n');
        let currentChunk = [];
        let currentLength = 0;

        for (const line of lines) {
            const lineLength = line.length + 1; // +1 for newline

            // If a single line is longer than maxLength, split it by sentences/words
            if (lineLength > maxLength) {
                // First, flush current chunk if any
                if (currentChunk.length > 0) {
                    chunks.push(currentChunk.join('\n'));
                    currentChunk = [];
                    currentLength = 0;
                }

                // Split long line by sentences
                const sentences = line.replace(/\. /g, '.\n').split('\n');
                for (const sentence of sentences) {
                    if (sentence.length > maxLength) {
                        // If sentence is still too long, split by words
                        const words = sentence.split(' ');
                        let tempChunk = [];
                        let tempLength = 0;
                        for (const word of words) {
                            const wordLength = word.length + 1;
                            if (tempLength + wordLength > maxLength) {
                                chunks.push(tempChunk.join(' '));
                                tempChunk = [word];
                                tempLength = wordLength;
                            } else {
                                tempChunk.push(word);
                                tempLength += wordLength;
                            }
                        }
                        if (tempChunk.length > 0) {
                            chunks.push(tempChunk.join(' '));
                        }
                    } else if (currentLength + sentence.length + 1 > maxLength) {
                        chunks.push(currentChunk.join('\n'));
                        currentChunk = [sentence];
                        currentLength = sentence.length;
                    } else {
                        currentChunk.push(sentence);
                        currentLength += sentence.length + 1;
                    }
                }
            } else if (currentLength + lineLength > maxLength) {
                // This line would exceed limit, start new chunk
                chunks.push(currentChunk.join('\n'));
                currentChunk = [line];
                currentLength = lineLength;
            } else {
                currentChunk.push(line);
                currentLength += lineLength;
            }
        }

        // Add remaining chunk
        if (currentChunk.length > 0) {
            chunks.push(currentChunk.join('\n'));
        }

        return chunks;
    }

    async sendMessage(content, attachment = null, mentions = null) {
        const url = `${config.HTTP_BASE_URL}/v2/send`;

        // If this is a group chat, send to the group; otherwise send to individual
        let recipients, recipientDisplay;
        if (this.groupId) {
            recipients = [this.groupId];
            recipientDisplay = `group ${this.groupId.substring(0, 20)}...`;
        } else {
            recipients = [this.phoneNumber];
            recipientDisplay = this.phoneNumber;
        }

        // Split long messages into multiple chunks
        const messageChunks = typeof content === 'string' ? this._splitMessage(content) : (content ? [content] : []);

        // Send each chunk as a separate message
        for (let i = 0; i < messageChunks.length; i++) {
            const chunk = messageChunks[i];
            const payload = {
                number: this.botPhone, // Use the bot's phone number
                recipients: recipients,
                text_mode: 'styled' // Enable text formatting (bold, italic, monospace, strikethrough)
            };

            if (chunk) {
                payload.message = chunk;
            }

            // Only attach file and mentions to the first message
            if (i === 0) {
                if (attachment) {
                    const encoded = attachment.toString('base64');
                    payload.base64_attachments = [encoded];
                }
                if (mentions) {
                    payload.mentions = mentions;
                }
            }

            try {
                await axios.post(url, payload);
                if (messageChunks.length > 1) {
                    console.log(`Message chunk ${i + 1}/${messageChunks.length} sent successfully to ${recipientDisplay}`);
                } else {
                    console.log(`Message sent successfully to ${recipientDisplay}`);
                }
                if (i === 0 && mentions) {
                    console.log(`DEBUG - Mentions sent: ${JSON.stringify(mentions)}`);
                }
            } catch (error) {
                console.error(`Error sending message chunk ${i + 1}:`, error.message);
                if (error.response) {
                    console.error(`Response status: ${error.response.status}`);
                    console.error(`Response content: ${error.response.data}`);
                }
                console.error(`Payload sent: ${JSON.stringify(payload)}`);
            }
        }
    }
}
