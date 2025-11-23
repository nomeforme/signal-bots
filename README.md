# Signal AI Chat Bot (Node.js)

AI-powered chatbot for Signal messenger supporting multiple AI models (Claude, Gemini, Bedrock).

This is a Node.js port of the Python version, maintaining full feature parity.

## Features

- **Multiple AI Models**: Claude (Anthropic), Gemini (Google), Bedrock (AWS)
- **Multi-Bot Support**: Run up to 12 bots simultaneously
- **Group Chat Support**: Shared conversation history, mentions, privacy modes
- **Bot Loop Prevention**: Prevents infinite bot-to-bot conversations
- **Random Replies**: Configurable probability for bots to randomly chime in
- **Rich Commands**: Model switching, prompt customization, privacy controls
- **WebSocket Management**: Automatic reconnection and consistency checking

## Setup

1. **Copy environment file**:
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your credentials**:
   - Add your AI API keys (Anthropic, Google, AWS)
   - Set bot phone numbers (must match order in config.json)

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Configure bots** in `config.json`:
   - Set bot names, models, and prompts
   - Adjust settings like `random_reply_chance`, `max_bot_mentions_per_conversation`

## Running

### Local Development
```bash
npm start
```

### With Docker
```bash
docker compose up -d
```

The Signal API will be available on port 8081.

## Configuration

### config.json
- `bots`: Array of bot configurations
- `random_reply_chance`: N for 1-in-N chance (0=disabled, 1=100%, 10=10%)
- `max_bot_mentions_per_conversation`: Limit bot-to-bot interactions
- `group_privacy_mode`: "opt-in" or "opt-out"

### Available Commands (in Signal)
- `!help`: Show help message
- `!cm <number>`: Change AI model
- `!cp <number>`: Change system prompt
- `!cup <text>`: Set custom prompt
- `!privacy <opt-in|opt-out>`: Change privacy mode
- `@bot !rr <number>`: Set random reply chance (requires mention)

## Differences from Python Version

- Uses native Node.js WebSocket (`ws` package)
- Async/await throughout instead of threading
- Image generation not yet fully implemented
- Agent SDK integration pending

## Architecture

- `src/main.js`: WebSocket management and message routing
- `src/messageHandler.js`: Message processing and AI integration
- `src/user.js`: User/conversation state management
- `src/config.js`: Configuration loading
- `src/prompts.js`: System prompt templates

## License

MIT
# signal-bots
# signal-bots
