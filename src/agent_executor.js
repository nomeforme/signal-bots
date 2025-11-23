/**
 * Agent execution with tool calling support.
 *
 * Handles the agentic loop:
 * 1. Send message with tools to Claude
 * 2. If Claude uses a tool, execute it
 * 3. Send tool results back to Claude
 * 4. Repeat until Claude responds with text
 */

/**
 * Execute one turn of agent interaction with tool support.
 *
 * @param {Anthropic} client - Anthropic client instance
 * @param {AgentDefinition} agent - AgentDefinition with tools
 * @param {Array} messages - Conversation history (Claude format)
 * @param {number} maxToolRounds - Maximum tool use iterations to prevent loops
 * @returns {Promise<[string, Array]>} Tuple of (final_response_text, updated_messages)
 */
export async function executeAgentTurn(client, agent, messages, maxToolRounds = 5) {
    const workingMessages = [...messages];
    let toolRounds = 0;

    while (toolRounds < maxToolRounds) {
        // Ensure messages don't end with assistant message (which would be pre-filling)
        // Some models don't support pre-filling when tools are enabled
        if (agent.tools && agent.tools.length > 0) {
            if (workingMessages.length > 0 && workingMessages[workingMessages.length - 1].role === 'assistant') {
                // Add an empty user message to avoid pre-filling error
                workingMessages.push({
                    role: 'user',
                    content: [{ type: 'text', text: '[continue]' }]
                });
            }
        }

        // Prepare API call
        const apiParams = {
            model: agent.model,
            max_tokens: 4096,
            messages: workingMessages
        };

        // Add system prompt if present
        if (agent.systemPrompt) {
            apiParams.system = agent.systemPrompt;
        }

        // Add tools if agent has any enabled
        if (agent.tools && agent.tools.length > 0) {
            apiParams.tools = agent.getAnthropicTools();
        }

        // Call Claude
        const response = await client.messages.create(apiParams);

        // Check stop reason
        if (response.stop_reason === 'end_turn') {
            // Claude finished - extract text response
            const textContent = [];
            for (const block of response.content) {
                if (block.type === 'text') {
                    textContent.push(block.text);
                }
            }

            const finalText = textContent.join('\n');

            // Add assistant message to history
            workingMessages.push({
                role: 'assistant',
                content: response.content
            });

            return [finalText, workingMessages];

        } else if (response.stop_reason === 'tool_use') {
            // Claude wants to use tools
            const toolResults = [];

            for (const block of response.content) {
                if (block.type === 'tool_use') {
                    // Execute the tool
                    const toolResult = await agent.executeTool(block.name, block.input);

                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: toolResult
                    });
                }
            }

            // Add assistant's tool use to messages
            workingMessages.push({
                role: 'assistant',
                content: response.content
            });

            // Add tool results as user message
            workingMessages.push({
                role: 'user',
                content: toolResults
            });

            toolRounds++;
            continue; // Loop back to get Claude's response to tool results

        } else {
            // Unexpected stop reason
            console.warn(`Warning: Unexpected stop_reason: ${response.stop_reason}`);
            // Try to extract any text content
            const textContent = [];
            for (const block of response.content) {
                if (block.type === 'text') {
                    textContent.push(block.text);
                }
            }

            const finalText = textContent.length > 0
                ? textContent.join('\n')
                : 'Sorry, I encountered an error.';

            workingMessages.push({
                role: 'assistant',
                content: response.content
            });

            return [finalText, workingMessages];
        }
    }

    // Max tool rounds exceeded
    console.warn(`Warning: Max tool rounds (${maxToolRounds}) exceeded`);
    return [
        'Sorry, I got stuck in a loop trying to use tools. Please try rephrasing your request.',
        workingMessages
    ];
}
