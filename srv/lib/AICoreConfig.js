const cds = require('@sap/cds');

/**
 * Central configuration for the SAP AI Core (Generative AI Hub) connection.
 *
 * The connection is resolved through a BTP subaccount destination (no direct
 * `aicore` service binding), therefore every client created in this project must
 * be given both:
 *   - the destination name  -> which AI Core tenant to talk to
 *   - the resource group    -> which workspace inside that tenant to use
 *
 * Precedence (most specific wins):
 *   1. environment variables (per space / per deployment, see mta.yaml)
 *   2. the `cds.aicore` block in package.json
 *   3. the defaults below, which mirror the current SAP AI Launchpad setup
 *      (AI API connection "myaicoreconnection", resource group "default").
 */
const DEFAULTS = {
    destination: 'AI_Core',
    resourceGroup: 'default',
    model: 'gemini-2.5-pro',
    temperature: 0.0
};

function fromCdsEnv() {
    // `cds.env` is resolved lazily; guard so this module stays usable in plain
    // node scripts (e.g. test/agent-test.js) where cds may not be bootstrapped.
    try {
        return cds.env?.aicore || {};
    } catch (e) {
        return {};
    }
}

function getAICoreConfig() {
    const configured = fromCdsEnv();

    return {
        destination: process.env.AI_CORE_DESTINATION || configured.destination || DEFAULTS.destination,
        resourceGroup: process.env.AI_CORE_RESOURCE_GROUP || configured.resourceGroup || DEFAULTS.resourceGroup,
        model: process.env.AI_CORE_MODEL || configured.model || DEFAULTS.model,
        temperature: parseFloat(
            process.env.AI_CORE_TEMPERATURE ?? configured.temperature ?? DEFAULTS.temperature
        )
    };
}

module.exports = { getAICoreConfig, DEFAULTS };
