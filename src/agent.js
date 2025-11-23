/**
 * Clean agent abstraction with tool support.
 *
 * This module provides a clean agent definition system that:
 * - Separates agent configuration from execution
 * - Supports Anthropic's native tool calling API
 * - Allows incremental addition of tools
 * - Maintains full control over prompts and behavior
 */

import axios from 'axios';

/**
 * Fetch content from a URL
 */
async function fetchHandler(args) {
    const url = args.url;
    if (!url) {
        return 'Error: No URL provided';
    }

    try {
        const response = await axios.get(url, {
            timeout: 30000,
            maxRedirects: 5,
            maxBodyLength: 50000, // ~50KB limit
            validateStatus: (status) => status < 500 // Accept redirects and client errors
        });

        // Limit response size to avoid overwhelming context
        const content = response.data.toString().substring(0, 50000);
        return `Successfully fetched content from ${url}:\n\n${content}`;
    } catch (error) {
        return `Error fetching ${url}: ${error.message}`;
    }
}

/**
 * Available tools registry
 */
export const AVAILABLE_TOOLS = {
    fetch: {
        name: 'fetch',
        description: 'Fetch content from a URL. Use this to retrieve web pages, APIs, or any HTTP-accessible content.',
        input_schema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'The URL to fetch content from (must be a valid HTTP/HTTPS URL)'
                }
            },
            required: ['url']
        },
        handler: fetchHandler
    }
};

/**
 * Agent Definition
 *
 * Clean agent definition with model, prompt, and tool configuration.
 */
class AgentDefinition {
    constructor(name, model, systemPrompt, tools = []) {
        this.name = name;
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.tools = tools; // Tool names from AVAILABLE_TOOLS
    }

    /**
     * Get Tool instances for this agent's enabled tools
     */
    getTools() {
        return this.tools
            .filter(toolName => AVAILABLE_TOOLS[toolName])
            .map(toolName => AVAILABLE_TOOLS[toolName]);
    }

    /**
     * Get tools in Anthropic API format
     */
    getAnthropicTools() {
        return this.getTools().map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema
        }));
    }

    /**
     * Execute a tool by name with given input
     */
    async executeTool(toolName, toolInput) {
        const tool = AVAILABLE_TOOLS[toolName];
        if (!tool) {
            return `Error: Unknown tool "${toolName}"`;
        }

        try {
            return await tool.handler(toolInput);
        } catch (error) {
            return `Error executing tool "${toolName}": ${error.message}`;
        }
    }
}

/**
 * Create agent definition from bot config
 */
export function createAgentFromConfig(botConfig, systemPrompt) {
    const tools = botConfig.tools || [];
    return new AgentDefinition(
        botConfig.name || 'bot',
        botConfig.model,
        systemPrompt,
        tools
    );
}
