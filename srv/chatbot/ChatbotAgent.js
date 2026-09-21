const { OrchestrationClient } = require('@sap-ai-sdk/langchain');
const { StateGraph, START, END } = require('@langchain/langgraph');
const { ToolNode } = require('@langchain/langgraph/prebuilt');
const {
    SystemMessage,
    HumanMessage,
    AIMessage
} = require('@langchain/core/messages');
const { getChatbotConfig } = require('./ChatbotConfig');

/**
 * LLM runtime of the chatbot.
 *
 * It intentionally does NOT reuse `AICoreService.extractDataLikeAgent()`: that method is
 * tuned for a single-shot, schema-driven extraction (document images, JSON parsing of the
 * answer, extraction logs) and is on the critical path of the invoice pipeline. The chat
 * needs multi-turn free text, so it owns its own graph. Both talk to the same SAP AI Core
 * destination and can therefore be operated as one connection.
 */

/**
 * True when the error (or any error in its `cause` chain) is the SAP AI SDK failing to
 * resolve a RUNNING deployment. LangChain wraps errors, so the original message is
 * often not the top-level one.
 */
function isDeploymentResolutionError(err) {
    const pattern = /No deployment matched|Failed to fetch the list of deployments/i;
    let current = err;
    const seen = new Set();
    while (current && !seen.has(current)) {
        seen.add(current);
        if (pattern.test(current.message || '')) return true;
        current = current.cause;
    }
    return false;
}

/** State channel of the graph: messages are appended, never replaced. */
const agentState = {
    messages: {
        value: (x, y) => x.concat(y),
        default: () => []
    }
};

/** Turns the stored history into LangChain messages. */
function toLangChainHistory(history = []) {
    return history
        .filter((entry) => entry && entry.content)
        .map((entry) =>
            entry.role === 'assistant'
                ? new AIMessage({ content: entry.content })
                : new HumanMessage({ content: entry.content })
        );
}

/** The model may answer with a plain string or with an array of content blocks. */
function contentToText(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'string' ? part : part?.text || ''))
            .join('')
            .trim();
    }
    if (content && typeof content === 'object' && content.text) return String(content.text).trim();
    return '';
}

function createModel(config) {
    return new OrchestrationClient(
        {
            promptTemplating: {},
            llm: {
                model_name: config.model,
                model_params: {
                    temperature: config.temperature,
                    max_tokens: config.maxOutputTokens
                }
            }
        },
        undefined,
        { resourceGroup: config.resourceGroup },
        { destinationName: config.destination }
    );
}

/** Single call, used when no tool is handed to the model. */
async function runWithoutTools(model, messages) {
    const response = await model.invoke(messages);
    return { message: response, toolCalls: [] };
}

/** Agent loop: the model may call tools until it produces a final answer. */
async function runWithTools(model, messages, tools, config) {
    const modelWithTools = model.bindTools(tools);
    const toolCalls = [];

    const callModel = async (state) => {
        const response = await modelWithTools.invoke(state.messages);
        (response.tool_calls || []).forEach((call) => toolCalls.push({ name: call.name, args: call.args }));
        return { messages: [response] };
    };

    const shouldContinue = (state) => {
        const lastMessage = state.messages[state.messages.length - 1];
        return lastMessage.tool_calls?.length ? 'tools' : END;
    };

    const app = new StateGraph({ channels: agentState })
        .addNode('agent', callModel)
        .addNode('tools', new ToolNode(tools))
        .addEdge(START, 'agent')
        .addConditionalEdges('agent', shouldContinue)
        .addEdge('tools', 'agent')
        .compile();

    const finalState = await app.invoke(
        { messages },
        // one iteration = model call + tool execution
        { recursionLimit: Math.max(2, config.tools.maxIterations * 2) }
    );

    return {
        message: finalState.messages[finalState.messages.length - 1],
        toolCalls
    };
}

/**
 * Runs one conversation turn against the LLM.
 * @param {object} params turn parameters
 * @param {string} params.systemPrompt system prompt built by ChatbotPrompts
 * @param {{role: string, content: string}[]} [params.history] previous turns, oldest first
 * @param {string} params.message the message just typed by the user
 * @param {object[]} [params.tools] LangChain tools, empty to skip the tool loop
 * @param {object} [params.client] pre-built chat client; only used to run the graph in tests
 * @returns {Promise<{reply: string, toolCalls: object[], model: string, usage: object}>} the answer
 */
async function runTurn({ systemPrompt, history = [], message, tools = [], client }) {
    const config = getChatbotConfig();
    const model = client || createModel(config);

    const messages = [
        new SystemMessage(systemPrompt),
        ...toLangChainHistory(history),
        new HumanMessage({ content: message })
    ];

    console.log(
        `[Chatbot] Destination: '${config.destination}' | Resource Group: '${config.resourceGroup}' `
        + `| Model: '${config.model}' | History: ${history.length} msg | Tools: ${tools.length}`
    );

    let result;
    try {
        result = tools.length
            ? await runWithTools(model, messages, tools, config)
            : await runWithoutTools(model, messages);
    } catch (err) {
        if (isDeploymentResolutionError(err)) {
            const hint = `[Chatbot] No RUNNING 'orchestration' deployment reachable via destination `
                + `'${config.destination}' in resource group '${config.resourceGroup}'. In SAP AI Launchpad `
                + `check ML Operations > Deployments: a deployment of the 'orchestration' scenario must exist `
                + `and be in status RUNNING (creating the configuration alone is not sufficient).`;
            console.error(hint, err);
            const wrapped = new Error(`${hint} Original error: ${err.message}`);
            wrapped.cause = err;
            throw wrapped;
        }
        throw err;
    }

    const usageMetadata = result.message?.usage_metadata || {};

    return {
        reply: contentToText(result.message?.content),
        toolCalls: result.toolCalls,
        model: config.model,
        usage: {
            inputTokens: usageMetadata.input_tokens || 0,
            outputTokens: usageMetadata.output_tokens || 0
        }
    };
}

module.exports = { runTurn, createModel };
