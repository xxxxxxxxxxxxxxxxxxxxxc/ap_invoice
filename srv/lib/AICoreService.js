const { AzureOpenAiChatClient, OrchestrationClient } = require("@sap-ai-sdk/langchain");
const { StateGraph, START, END, MemorySaver } = require("@langchain/langgraph");
const { ToolNode } = require("@langchain/langgraph/prebuilt");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");


// Define state channels
const agentState = {
    messages: {
        value: (x, y) => x.concat(y),
        default: () => [],
    },
};

class AICoreService {
    constructor() { }

    /**
     * Orchestrates the extraction process using LangChain StateGraph Agent.
     * Uses SAP Cloud SDK for AI (@sap-ai-sdk/langchain) and LangGraph.
     * @param {object|string[]} documentContent - Target document content ({type: 'text', data: '...'} or {type: 'images', data: [...]})
     * @param {object[]} tools - Defined tools (DynamicStructuredTools)
     * @param {string} schemaDescription - Target JSON schema description
     * @param {object} context - Execution context (e.g. companyCode)
     * @returns {Promise<object>} Extracted JSON data
     */
    async extractDataLikeAgent(documentContent, tools, schemaDescription, context = {}) {
        const destinationName = "AI_Core";
        const deploymentId = process.env.AI_CORE_DEPLOYMENT_ID; // Optional if using generic client or handled by SDK
        const resourceGroup = "ap-invoice";


        // Create a model
        const model = new OrchestrationClient({
            promptTemplating: {},
            llm: {
                model_name: context.aiModel || 'gemini-2.5-pro',
                model_params: {
                    temperature: context.aiTemperature !== undefined ? parseFloat(context.aiTemperature) : 0.0
                }
            }
        }, 
        undefined, 
        { resourceGroup: resourceGroup }, 
        { destinationName: destinationName }
        );


        // 1. Initialize SAP AI Core Client
        /*      const model = new AzureOpenAiChatClient({
                  modelName: "gpt-4o",
                  modelParams: { temperature: 0.1, max_tokens: 4096 }
              }, {
                  destinationName: destinationName,
                  resourceGroup: resourceGroup
              });*/

        // 2. Bind Tools to Model
        const modelWithTools = model.bindTools(tools);

        // 3. Define Graph Nodes and Edges

        // Node: Call Model
        const callModel = async (state) => {
            const messages = state.messages;
            const response = await modelWithTools.invoke(messages);
            return { messages: [response] };
        };

        // Node: Execute Tools
        const toolNode = new ToolNode(tools);

        // Conditional Edge: Route based on tool calls
        const shouldContinue = (state) => {
            const messages = state.messages;
            const lastMessage = messages[messages.length - 1];

            if (lastMessage.tool_calls?.length) {
                return "tools";
            }
            return END;
        };

        // Build Graph
        const workflow = new StateGraph({ channels: agentState })
            .addNode("agent", callModel)
            .addNode("tools", toolNode)
            .addEdge(START, "agent")
            .addConditionalEdges("agent", shouldContinue)
            .addEdge("tools", "agent");

        const memory = new MemorySaver();

        const app = workflow.compile({ checkpointer: memory });

        // 4. Construct System Prompt
        let finalSystemPrompt;

        // Base instructions are now expected to be in context.systemPrompt
        const baseAgentInstructions = "";

        // Log available tools for debugging
        console.log("Lettura dei tools")
        console.log(tools)
        if (tools && Array.isArray(tools)) {
            console.log("[AICore] Available Tools for Agent:");
            tools.forEach(t => {
                console.log(`- Name: ${t.name}, Description: ${t.description}`);
            });
        }

        // HYBRID PROMPT LOGIC
        finalSystemPrompt = baseAgentInstructions;

        if (schemaDescription) {
            // finalSystemPrompt += `\n\n${schemaDescription}`; //commentato 
        }

        if (context.systemPrompt) {
            //finalSystemPrompt +=  `\n\n========================\nADDITIONAL USER DIRECTIVES (CONTEXT & RULES)\n========================\n${context.systemPrompt}`;
            finalSystemPrompt += context.systemPrompt;
            console.log("[AICore] Appended Configured System Prompt");
        } else {
            console.warn("[AICore] NO CUSTOM SYSTEM PROMPT PROVIDED! Agent behavior might be unpredictable.");
            finalSystemPrompt += "\n\nIMPORTANT: No system prompt provided. Please extract data according to the schema.";
        }

        let humanMessageContent = [];

        // Handle legacy array format or object format
        if (Array.isArray(documentContent)) {
            humanMessageContent = documentContent.map(img => ({ type: "image_url", image_url: { url: `data:image/png;base64,${img}` } }));
        } else if (documentContent?.type === 'text') {
            humanMessageContent = [
                { type: "text", text: `Here is the document text to extract data from:\n\n${documentContent.data}` }
            ];
        } else if (documentContent?.type === 'images') {
            humanMessageContent = documentContent.data.map(img => ({ type: "image_url", image_url: { url: `data:image/png;base64,${img}` } }));
        }

        const inputMessages = [
            new SystemMessage(finalSystemPrompt),
            new HumanMessage({
               content: humanMessageContent
            })
        ];

        console.log("[AICore] Starting StateGraph Agent...");

        const logCollector = [];
        const startTime = new Date();
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        // Log the Full System Prompt for debugging
        logCollector.push({
            type: "SystemPrompt",
            timestamp: startTime,
            message: "System Prompt Constructed",
            data: { text: finalSystemPrompt }
        });

        logCollector.push({
            type: "ProcessingMode",
            timestamp: startTime,
            message: documentContent?.type === 'images' ? "image" : "text"
        });

        logCollector.push({
            type: "ChainStart",
            timestamp: startTime,
            message: "Agent Execution Started (StateGraph)",
            input: "Invoice Images"
        });

        // 5. Invoke Graph
        const finalState = await app.invoke({ messages: inputMessages }, {
            recursionLimit: 200, // Increased from default 25 to 100
            configurable: { thread_id: "invoice_extraction_" + Date.now() },
            callbacks: [{
                handleLLMStart: async (llm, prompts) => {
                    logCollector.push({
                        type: "LLMStart",
                        timestamp: new Date(),
                        message: "Thinking...",
                        data: { promptCount: prompts.length }
                    });
                    console.log(`[AICore] LLM Started. Prompts: ${prompts.length}. (Step count internal limit: 100)`);
                },
                handleLLMEnd: async (output) => {
                    const text = output.generations[0][0].text;
                    const messageUsage = output.generations[0][0].message?.usage_metadata;
                    if (messageUsage) {
                        totalInputTokens += (messageUsage.input_tokens || 0);
                        totalOutputTokens += (messageUsage.output_tokens || 0);
                    } else if (output.llmOutput?.tokenUsage) {
                        totalInputTokens += (output.llmOutput.tokenUsage.promptTokens || 0);
                        totalOutputTokens += (output.llmOutput.tokenUsage.completionTokens || 0);
                    }
                    logCollector.push({
                        type: "LLMEnd",
                        timestamp: new Date(),
                        message: "Thought generated",
                        data: { text: text }
                    });
                    console.log("[AICore] LLM Response:", text.substring(0, 200) + (text.length > 200 ? "..." : ""));
                },
                handleToolStart: async (tool, input, runId, parentRunId, tags, metadata, runName) => {
                    const toolName = runName
                        || (Array.isArray(tool?.id) ? tool.id[tool.id.length - 1] : null)
                        || tool?.name
                        || "Unknown Tool";

                    logCollector.push({
                        type: "ToolStart",
                        timestamp: new Date(),
                        toolName: toolName,
                        input: input
                    });
                    console.log(`[AICore] Tool '${toolName}' started. Input:`, input);
                },
                handleToolEnd: async (output) => {
                    logCollector.push({
                        type: "ToolEnd",
                        timestamp: new Date(),
                        output: output
                    });
                    console.log(`[AICore] Tool ended. Output:`, String(output).substring(0, 200) + "...");
                },
                handleToolError: async (err) => {
                    logCollector.push({
                        type: "ToolError",
                        timestamp: new Date(),
                        error: err.message
                    });
                    console.error(`[AICore] Tool Error:`, err);
                },
                handleChainError: async (err) => {
                    logCollector.push({
                        type: "ChainError",
                        timestamp: new Date(),
                        error: err.message
                    });
                    console.error(`[AICore] Chain Error:`, err);
                }
            }]
        });

        // 6. Extract Final Output
        const finalMessage = finalState.messages[finalState.messages.length - 1];
        let content = finalMessage.content;

        logCollector.push({
            type: "ChainEnd",
            timestamp: new Date(),
            message: "Execution Completed",
            finalOutput: typeof content === 'string' ? content.substring(0, 100) + "..." : "Object"
        });

        let resultData = content;

        // Cleanup markdown if present
        if (typeof content === 'string') {
            // Attempt to extract JSON from code blocks first
            const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                content = jsonMatch[1].trim();
            } else {
                // Fallback: try to find the first '{' and last '}'
                const firstOpen = content.indexOf('{');
                const lastClose = content.lastIndexOf('}');
                if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
                    content = content.substring(firstOpen, lastClose + 1);
                }
            }

            try {
                resultData = JSON.parse(content);
            } catch (e) {
                console.warn("[AICore] Failed to parse JSON, returning raw string. Error:", e.message);
                console.warn("[AICore] Raw Content:", content);
                resultData = { raw: content };
            }
        } else if (typeof content === 'object') {
            // In case content is tool calls or other object (unlikely for final message if using StateGraph correctly but possible)
            resultData = content;
        }

        return {
            data: resultData,
            log: logCollector,
            usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens
            }
        };
    }
}

module.exports = new AICoreService();
