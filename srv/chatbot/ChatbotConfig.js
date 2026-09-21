const cds = require('@sap/cds');
const { getAICoreConfig } = require('../lib/AICoreConfig');

/**
 * Configuration of the conversational chatbot.
 *
 * The chatbot deliberately keeps its own configuration block, separate from the
 * extraction agent: changing the chat model (or switching the chat off) must never
 * influence the invoice extraction pipeline, which keeps reading `cds.aicore`
 * through AICoreConfig.
 *
 * Only the connection coordinates (destination + resource group) are shared, because
 * they identify the AI Core tenant of the whole subaccount.
 *
 * Precedence (most specific wins):
 *   1. environment variables (per space / per deployment, see mta.yaml)
 *   2. the `cds.chatbot` block in package.json
 *   3. the defaults below
 */
const DEFAULTS = {
    // false -> chatbotMessage() answers with the static fallback text, no LLM call
    enabled: true,
    // a chat turn must feel instant: 'flash' answers in a couple of seconds, while the
    // reasoning models ('pro') spend several seconds - and a large share of
    // maxOutputTokens - on internal thinking before writing a single word
    model: 'gemini-2.5-flash',
    temperature: 0.3,
    // the answers are deliberately short (see ChatbotPrompts), this is only the ceiling
    // that keeps a runaway answer from being cut in the middle of a sentence
    maxOutputTokens: 512,
    // hard limit of one chat turn: after that the user gets the fallback answer
    // instead of a request hanging until the AI Core timeout (300s)
    timeoutMs: 30000,
    // how many previous messages (user + assistant) are replayed to the model:
    // a shorter window means a smaller prompt and therefore a faster answer
    historyLength: 8,
    // 'db' survives restarts and multiple app instances, 'memory' is process local
    historyStore: 'db',
    // minutes of inactivity after which a conversation is considered closed
    historyTtlMinutes: 720,
    tools: {
        // Tools are implemented and registered but NOT handed to the model yet:
        // flip this flag (or CHATBOT_TOOLS_ENABLED=true) to activate the tool loop.
        enabled: false,
        // names from ChatbotTools that must stay out, even when tools are enabled
        disabled: [],
        // safety net for the agent loop when tools are enabled
        maxIterations: 6
    }
};

function fromCdsEnv() {
    // `cds.env` is resolved lazily; guard so this module stays usable in plain
    // node scripts where cds may not be bootstrapped.
    try {
        return cds.env?.chatbot || {};
    } catch (e) {
        return {};
    }
}

function asBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
}

function asNumber(value, fallback) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function asList(value, fallback) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        return value.split(',').map((x) => x.trim()).filter(Boolean);
    }
    return fallback;
}

function getChatbotConfig() {
    const configured = fromCdsEnv();
    const configuredTools = configured.tools || {};
    const aiCore = getAICoreConfig();

    return {
        // shared with the extraction agent: same AI Core tenant / workspace
        destination: process.env.CHATBOT_AI_DESTINATION || configured.destination || aiCore.destination,
        resourceGroup: process.env.CHATBOT_AI_RESOURCE_GROUP || configured.resourceGroup || aiCore.resourceGroup,

        // chat specific
        enabled: asBoolean(process.env.CHATBOT_ENABLED ?? configured.enabled, DEFAULTS.enabled),
        model: process.env.CHATBOT_AI_MODEL || configured.model || DEFAULTS.model,
        temperature: asNumber(process.env.CHATBOT_AI_TEMPERATURE ?? configured.temperature, DEFAULTS.temperature),
        maxOutputTokens: asNumber(
            process.env.CHATBOT_MAX_OUTPUT_TOKENS ?? configured.maxOutputTokens,
            DEFAULTS.maxOutputTokens
        ),
        timeoutMs: asNumber(process.env.CHATBOT_TIMEOUT_MS ?? configured.timeoutMs, DEFAULTS.timeoutMs),
        historyLength: asNumber(process.env.CHATBOT_HISTORY_LENGTH ?? configured.historyLength, DEFAULTS.historyLength),
        historyStore: process.env.CHATBOT_HISTORY_STORE || configured.historyStore || DEFAULTS.historyStore,
        historyTtlMinutes: asNumber(
            process.env.CHATBOT_HISTORY_TTL_MINUTES ?? configured.historyTtlMinutes,
            DEFAULTS.historyTtlMinutes
        ),
        systemPrompt: process.env.CHATBOT_SYSTEM_PROMPT || configured.systemPrompt || null,
        tools: {
            enabled: asBoolean(process.env.CHATBOT_TOOLS_ENABLED ?? configuredTools.enabled, DEFAULTS.tools.enabled),
            disabled: asList(process.env.CHATBOT_TOOLS_DISABLED ?? configuredTools.disabled, DEFAULTS.tools.disabled),
            maxIterations: asNumber(
                process.env.CHATBOT_TOOLS_MAX_ITERATIONS ?? configuredTools.maxIterations,
                DEFAULTS.tools.maxIterations
            )
        }
    };
}

module.exports = { getChatbotConfig, DEFAULTS };
