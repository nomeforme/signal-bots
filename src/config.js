import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import * as prompts from './prompts.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use environment variables with localhost as fallback
export const WS_BASE_URL = process.env.WS_BASE_URL || 'ws://localhost:8080';
export const HTTP_BASE_URL = process.env.HTTP_BASE_URL || 'http://localhost:8080';

// Load configuration from config.json
const configPath = path.join(__dirname, '..', 'config.json');
let CONFIG;

try {
    const configData = fs.readFileSync(configPath, 'utf8');
    CONFIG = JSON.parse(configData);
} catch (err) {
    if (err.code === 'ENOENT') {
        console.log(`Warning: config.json not found at ${configPath}, using defaults`);
        CONFIG = {
            bots: [],
            max_history_messages: 200,
            group_privacy_mode: 'opt-in',
            trusted_phone_numbers: [],
            session_timeout: 30,
            default_model: '(6) claude-haiku-4-5-20251001',
            default_system_instruction: '(1) Standard',
            default_image_size: '(5) portrait_3_4',
            lora_path_to_url: {},
            prompt_replace_dict: {}
        };
    } else {
        console.error(`Error: Failed to parse config.json: ${err.message}`);
        process.exit(1);
    }
}

// Extract bot instances from config.json
export let BOT_INSTANCES = CONFIG.bots || [];

// Load phone numbers from .env
const botPhoneNumbersEnv = process.env.BOT_PHONE_NUMBERS || '';
const botPhones = botPhoneNumbersEnv.split(',').map(p => p.trim()).filter(p => p);

// Merge phone numbers with bot configs
if (botPhones.length > 0) {
    if (botPhones.length !== BOT_INSTANCES.length) {
        console.log(`Warning: Number of phone numbers (${botPhones.length}) doesn't match number of bots (${BOT_INSTANCES.length})`);
        console.log(`Using first ${Math.min(botPhones.length, BOT_INSTANCES.length)} entries`);
    }

    // Add phone numbers to bot configs by index
    botPhones.forEach((phone, i) => {
        if (i < BOT_INSTANCES.length) {
            BOT_INSTANCES[i].phone = phone;
        }
    });
} else {
    // Legacy fallback: check for SIGNAL_PHONE_NUMBER in environment
    const SIGNAL_PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER;
    const BOT_NAME = process.env.BOT_NAME || 'AI Bot';
    if (SIGNAL_PHONE_NUMBER) {
        console.log('Warning: Using legacy SIGNAL_PHONE_NUMBER from .env. Consider using BOT_PHONE_NUMBERS instead');
        BOT_INSTANCES = [{
            phone: SIGNAL_PHONE_NUMBER,
            name: BOT_NAME,
            model: null,
            prompt: null
        }];
    }
}

if (BOT_INSTANCES.length === 0) {
    console.error('Error: No bot instances configured. Please configure bots in config.json and BOT_PHONE_NUMBERS in .env');
    process.exit(1);
}

// Verify all bots have phone numbers
BOT_INSTANCES.forEach((bot, i) => {
    if (!bot.phone) {
        console.error(`Error: Bot at index ${i} ('${bot.name || 'unnamed'}') is missing a phone number`);
        console.error('Please add phone number to BOT_PHONE_NUMBERS in .env');
        process.exit(1);
    }
});

// Create a mapping of phone number to bot config
export const BOT_CONFIGS = {};
BOT_INSTANCES.forEach(bot => {
    BOT_CONFIGS[bot.phone] = bot;
});

// For legacy compatibility, set SIGNAL_PHONE_NUMBER to first bot's phone
export const SIGNAL_PHONE_NUMBER = BOT_INSTANCES[0].phone;

// Load configuration values
export const SESSION_TIMEOUT = CONFIG.session_timeout || 30;
export const MAX_HISTORY_MESSAGES = CONFIG.max_history_messages || 200;
export const GROUP_PRIVACY_MODE = (CONFIG.group_privacy_mode || 'opt-in').toLowerCase();
export const TRUSTED_PHONE_NUMBERS = CONFIG.trusted_phone_numbers || [];

export const VALID_MODELS = [
    '(1) gemini-1.5-flash-8b',
    '(2) gemini-1.5-flash-002',
    '(3) gemini-1.5-pro-002',
    '(4) claude-3-haiku-20240307',
    '(5) claude-3-5-haiku-20241022',
    '(6) claude-haiku-4-5-20251001',
    '(7) claude-3-opus-20240229',
    '(8) claude-3-7-sonnet-20250219',
    '(9) claude-sonnet-4-20250514',
    '(10) claude-sonnet-4-5-20250929',
    '(11) claude-opus-4-20250514',
    '(12) claude-opus-4-1-20250805',
    '(13) bedrock-claude-3-haiku-20240307',
    '(14) bedrock-claude-3-sonnet-20240229',
    '(15) bedrock-claude-3-5-haiku-20241022',
    '(16) bedrock-claude-3-5-sonnet-20240620',
    '(17) bedrock-claude-3-5-sonnet-20241022',
    '(18) bedrock-claude-3-7-sonnet-20250219',
];

export const DEFAULT_MODEL = CONFIG.default_model || '(6) claude-haiku-4-5-20251001';
export const LORA_PATH_TO_URL = CONFIG.lora_path_to_url || {};
export const PROMPT_REPLACE_DICT = CONFIG.prompt_replace_dict || {};
export let RANDOM_REPLY_CHANCE = CONFIG.random_reply_chance || 0;
export const MAX_BOT_MENTIONS_PER_CONVERSATION = CONFIG.max_bot_mentions_per_conversation || 10;

export const IMAGE_SIZES = {
    '(1) square': { width: 512, height: 512 },
    '(2) square_hd': { width: 1024, height: 1024 },
    '(3) landscape_4_3': { width: 1024, height: 768 },
    '(4) landscape_16_9': { width: 1024, height: 576 },
    '(5) portrait_3_4': { width: 768, height: 1024 },
    '(6) portrait_9_16': { width: 576, height: 1024 },
};

const defaultImageSizeKey = CONFIG.default_image_size || '(5) portrait_3_4';
export const DEFAULT_IMAGE_SIZE = IMAGE_SIZES[defaultImageSizeKey] || IMAGE_SIZES['(5) portrait_3_4'];

export const OUTPUT_DIR = 'generated_images';
export const DEFAULT_LORA_SCALE = 1;
export const DEFAULT_IMG_API_ENDPOINT = 'fal-ai/flux-pro/v1.1';

export const SYSTEM_INSTRUCTIONS = {
    '(1) Standard': null,
    '(2) Smileys': prompts.smileys,
    '(3) Close Friend': prompts.closeFriend,
    '(4) Plant': prompts.plant,
    '(5) Spiritual Guide': prompts.spiritualGuide,
    '(6) Wittgenstein': prompts.wittgenstein,
};

export const DEFAULT_SYSTEM_INSTRUCTION = SYSTEM_INSTRUCTIONS['(1) Standard'];

// Function to update RANDOM_REPLY_CHANCE at runtime
export function setRandomReplyChance(value) {
    RANDOM_REPLY_CHANCE = value;
}
