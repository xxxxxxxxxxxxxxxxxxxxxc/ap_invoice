const cds = require('@sap/cds');
const { z } = require('zod');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { getChatbotConfig } = require('./ChatbotConfig');
const KnowledgeBaseService = require('../lib/KnowledgeBaseService');

/**
 * Tool registry of the conversational chatbot.
 *
 * It is intentionally separate from `srv/lib/AgentTools.js`: those tools belong to the
 * extraction agent (arithmetic, string manipulation, mapping helpers) and must keep
 * working exactly as they do today. The chat needs read-only tools that answer
 * questions about the application, so it owns its own registry.
 *
 * A tool is a plain descriptor:
 *   {
 *     name:        unique name, the model calls the tool by this name
 *     description: when the model should call it (the model reads only this)
 *     schema:      zod schema of the arguments
 *     handler:     async (args, context) => string   // ALWAYS return a string
 *   }
 *
 * `context` carries the request scoped data (`userId`, `locale`, `entities`, `req`, ...)
 * so handlers never reach for globals.
 *
 * Adding a tool = adding a descriptor to DEFINITIONS (or calling registerChatbotTool
 * from another module). Tools are handed to the model only when
 * `cds.chatbot.tools.enabled` / CHATBOT_TOOLS_ENABLED is true, so new tools can be
 * merged and reviewed before the model is allowed to use them.
 */

const MAX_TOOL_OUTPUT = 6000;

/** Keeps a tool result small enough to stay in the conversation window. */
function truncate(text) {
    const value = typeof text === 'string' ? text : JSON.stringify(text ?? null);
    if (value.length <= MAX_TOOL_OUTPUT) return value;
    return `${value.substring(0, MAX_TOOL_OUTPUT)}... [output truncated]`;
}

/** Lazily resolves a db entity, for tools that are called outside a service context. */
function dbEntity(name) {
    try {
        return cds.model?.definitions?.[`db.${name}`]
            || cds.db?.model?.definitions?.[`db.${name}`]
            || null;
    } catch (e) {
        return null;
    }
}

const DEFINITIONS = [
    {
        name: 'getCurrentDateTime',
        description:
            'Returns the current server date and time in ISO 8601 format. Call it before answering '
            + 'questions about relative dates such as "today", "yesterday" or "this month".',
        schema: z.object({}),
        handler: async () => new Date().toISOString()
    },
    {
        name: 'searchInvoiceDocuments',
        description:
            'Searches the invoice documents uploaded into the application and returns their processing '
            + 'status. Use it to answer questions about a specific file, invoice number, supplier or '
            + 'about documents that failed. All filters are optional and combined with AND. '
            + 'Read-only: it never changes any data.',
        schema: z.object({
            fileName: z.string().optional().describe('Full or partial file name of the uploaded document'),
            invoiceNumber: z.string().optional().describe('Invoice number printed on the document'),
            companyCode: z.string().optional().describe('SAP company code, 4 characters'),
            supplier: z.string().optional().describe('Full or partial supplier name'),
            status: z
                .enum(['ToBeProcessed', 'SentToSap', 'Error'])
                .optional()
                .describe('Processing status: ToBeProcessed (not sent yet), SentToSap (InvioOK), Error (KO)'),
            limit: z.number().int().min(1).max(20).optional().describe('Maximum number of documents to return, default 10')
        }),
        handler: async (args, context) => {
            const entity = context?.entities?.DocumentStatusBtp || dbEntity('DocumentStatusBtp');
            if (!entity) {
                return 'The document table is not reachable right now.';
            }

            const where = {};
            if (args.invoiceNumber) where.invoiceNumber = args.invoiceNumber;
            if (args.companyCode) where.companyCode = args.companyCode;
            if (args.status === 'SentToSap') where.statusBtp = 'InvioOK';
            if (args.status === 'Error') where.statusBtp = 'KO';
            if (args.status === 'ToBeProcessed') where.statusBtp = null;

            // free text filters are matched case insensitively: LIKE is case sensitive
            // on HANA, and users type supplier and file names as they remember them
            if (args.fileName) {
                where['upper(fileName)'] = { like: `%${args.fileName.toUpperCase()}%` };
            }
            if (args.supplier) {
                where['upper(fornitore)'] = { like: `%${args.supplier.toUpperCase()}%` };
            }

            const rows = await SELECT.from(entity)
                .columns(
                    'fileName',
                    'invoiceNumber',
                    'fornitore',
                    'ordine',
                    'companyCode',
                    'countryCode',
                    'scenario',
                    'statusBtp',
                    'registrationStatus',
                    'EbelnGen',
                    'createdAt',
                    'modifiedAt'
                )
                .where(where)
                .orderBy({ modifiedAt: 'desc' })
                .limit(args.limit || 10);

            if (!rows.length) {
                return 'No document matches these filters.';
            }
            return truncate(JSON.stringify(rows));
        }
    },
    {
        name: 'searchKnowledgeBase',
        description:
            'Semantic search in the knowledge base: the manuals, procedures, policies and other '
            + 'DOCX/PDF/Markdown documents uploaded by the users. Use it for any question about how things '
            + 'work, rules, procedures or content that may be written in those documents. Returns '
            + 'the most relevant text passages with the source file name and a similarity score '
            + '(0-1, higher is more relevant). Rephrase the user question as a short, self-contained '
            + 'query. Read-only.',
        schema: z.object({
            query: z.string().min(2).describe('Self-contained search query in natural language'),
            topK: z.number().int().min(1).max(10).optional().describe('Number of passages to return, default 5')
        }),
        handler: async (args) => {
            const results = await KnowledgeBaseService.search(args.query, args.topK);
            if (!results.length) {
                return 'The knowledge base contains no document related to this question.';
            }
            return truncate(JSON.stringify(results));
        }
    }
];

/** Descriptors registered at runtime by other modules. */
const EXTERNAL_DEFINITIONS = [];

/**
 * Registers an additional tool descriptor.
 * @param {object} definition see the module documentation for the expected shape
 */
function registerChatbotTool(definition) {
    if (!definition?.name || typeof definition.handler !== 'function') {
        throw new Error('A chatbot tool needs at least a name and a handler function');
    }
    const index = EXTERNAL_DEFINITIONS.findIndex((d) => d.name === definition.name);
    if (index >= 0) {
        EXTERNAL_DEFINITIONS[index] = definition;
    } else {
        EXTERNAL_DEFINITIONS.push(definition);
    }
}

function allDefinitions() {
    return [...DEFINITIONS, ...EXTERNAL_DEFINITIONS];
}

/**
 * Wraps a descriptor into a LangChain tool, isolating the conversation from handler
 * failures: a throwing tool returns an error string to the model instead of killing
 * the whole chat turn.
 */
function toLangChainTool(definition, context) {
    return new DynamicStructuredTool({
        name: definition.name,
        description: definition.description || '',
        schema: definition.schema || z.object({}),
        func: async (args) => {
            try {
                const result = await definition.handler(args || {}, context);
                return truncate(result);
            } catch (err) {
                console.error(`[Chatbot] Tool '${definition.name}' failed:`, err);
                return `Error while executing ${definition.name}: ${err.message}`;
            }
        }
    });
}

/**
 * Builds the tools handed to the model for this conversation turn.
 * Returns an empty array when tools are switched off, which makes the agent skip the
 * tool loop entirely.
 * @param {object} context request scoped context passed to every handler
 * @returns {object[]} LangChain tools
 */
function getChatbotTools(context = {}) {
    const config = getChatbotConfig();
    if (!config.tools.enabled) {
        return [];
    }

    const disabled = new Set(config.tools.disabled || []);
    return allDefinitions()
        .filter((definition) => !disabled.has(definition.name))
        .map((definition) => toLangChainTool(definition, context));
}

/** Names of every registered tool, regardless of the enabled flag (diagnostics). */
function listChatbotToolNames() {
    return allDefinitions().map((definition) => definition.name);
}

module.exports = {
    getChatbotTools,
    registerChatbotTool,
    listChatbotToolNames,
    MAX_TOOL_OUTPUT
};
