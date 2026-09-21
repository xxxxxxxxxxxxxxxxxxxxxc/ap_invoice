const AICoreService = require('../srv/lib/AICoreService');
const AgentTools = require('../srv/lib/AgentTools');

// Load env vars if dotenv is available, otherwise assume environment is set
try {
    require('dotenv').config();
} catch (e) {
    console.log("Note: 'dotenv' not found. Ensure environment variables (AI_CORE_DESTINATION, etc.) are set.");
}

async function runTest() {
    console.log("=== Starting Agent Verification Test ===");

    // 1. Mock Context
    const context = {
        companyCode: "TEST_CO",
        countryCode: "IT"
    };

    // 2. Initialize Tools
    console.log("[Test] Initializing Tools...");
    const tools = AgentTools.getToolsInAISchema(context);
    console.log(`[Test] Loaded ${tools.length} tools.`);

    // 3. Mock Input (1x1 Pixel PNG)
    const mockImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgDNjd8qAAAAAElFTkSuQmCC";
    
    // 4. Define Schema
    const schemaDescription = `
    {
        "invoiceNumber": "string (extract or default to 'UNKNOWN')",
        "totalAmount": "number"
    }
    `;

    // 5. Run Agent
    console.log("[Test] Invoking AICoreService...");
    try {
        const result = await AICoreService.extractDataLikeAgent(
            [mockImageBase64],
            tools,
            schemaDescription,
            context
        );

        console.log("=== Test Success ===");
        console.log("Agent Output:", JSON.stringify(result, null, 2));

    } catch (error) {
        console.error("=== Test Failed ===");
        console.error(error);
    }
}

runTest();
