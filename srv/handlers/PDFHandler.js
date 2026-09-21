const PDFService = require('../lib/PDFService');
const AICoreService = require('../lib/AICoreService');
const AgentTools = require('../lib/AgentTools');
const { v4: uuidv4 } = require('uuid');

const PDFHandler = async (req, entities) => {
    console.log("[PDFHandler] Starting processing:");
    const { DocumentStatusBtp, DocumentAIFields } = entities;
    const { file, fileName, companyCode, countryCode } = req.data;

    // 1. Prepare Content for DB (Base64)
    let fileContent = file;
    if (Buffer.isBuffer(file)) {
        fileContent = file.toString('base64');
    }

    // 2. Create a Job Record in DB
    const jobId = uuidv4();
    await INSERT.into(DocumentStatusBtp).entries({
        id: jobId,
        fileName: fileName,
        status: "RUNNING",
        statusBtp: "Elaborazione in corso",
        createdAt: new Date(),
        content: fileContent,
        companyCode: companyCode,
        countryCode: countryCode,
        tipoCaricamento: req.data.tipoCaricamento || "Manual"
    });

    // 3. Process Asynchronously (fire and forget from client perspective)
    (async () => {
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 5000;
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        let success = false;
        let lastErrWrapper = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`[PDFHandler] Starting async processing (Attempt ${attempt}/${MAX_RETRIES}) for Job ${jobId}`);
                // Fetch System Prompt from Country Config (Custom Directives)
                const countryConfig = await SELECT.one.from('db.Countries').where({ code: countryCode });
                const customSystemPrompt = countryConfig ? countryConfig.systemPrompt : null;

                // --- HYBRID PROMPT GENERATION ---
                // 1. Fetch Field Mappings for this Country (Default to MM scenario for now, or dynamic if available)
                // Expand related entities to get names and descriptions
                const fieldMappings = await SELECT.from('db.FieldMappings')
                    .where({ country_code: countryCode, active: true })
                    .columns(m => {
                        m.documentAIField(d => { d.fieldName, d.description }),
                            m.odataField(o => { o.fieldName, o.description, o.dataType }),
                            m.steps(s => {
                                s.stepOrder,
                                    s.conversionFunction(c => { c.name, c.description })
                            })
                    });

                let generatedPrompt = "";

                if (fieldMappings && fieldMappings.length > 0) {
                    // Filter out invalid mappings
                    const validMappings = fieldMappings.filter(m => m.odataField && m.documentAIField);

                    // 1. TARGET SCHEMA (OData Fields) - PRIMARY OUTPUT
                    // The frontend expects the Agent to return data using OData Field Names (e.g. "Vendor"), 
                    // which it then maps to UI fields (e.g. "vendorName") using the loaded configuration.
                    const targetFields = validMappings.map(m => {
                        const f = m.odataField;
                        return `- ${f.fieldName} (${f.dataType}): ${f.description || ''}`;
                    }).join('\n');

                    // 2. MAPPING CONTEXT (Source -> Target)
                    // Helps the agent understand what to extract from the document (which might match the DocAI name).
                    const mappingContext = validMappings.map(m => {
                        const desc = m.documentAIField.description ? ` (${m.documentAIField.description})` : "";
                        return `Source Field '${m.documentAIField.fieldName}'${desc} corresponds to Target Field '${m.odataField.fieldName}'`;
                    }).join('\n');

                    // 3. SEQUENTIAL TOOL HINTS (Processing Pipeline)
                    const toolHints = validMappings
                        .filter(m => m.steps && m.steps.length > 0)
                        .map(m => {
                            // Sort steps by order
                            const steps = m.steps.sort((a, b) => a.stepOrder - b.stepOrder);
                            const pipeline = steps.map((step, idx) => {
                                const fnName = step.conversionFunction ? step.conversionFunction.name : "Unknown";
                                const fnDesc = step.conversionFunction && step.conversionFunction.description ? step.conversionFunction.description : "";
                                return `${idx + 1}. Apply '${fnName}' (${fnDesc})`;
                            }).join(' -> ');
                            return `Target Field '${m.odataField.fieldName}' processing pipeline: ${pipeline}`;
                        })
                        .filter(hint => hint !== '').join('\n');

                    generatedPrompt = `
*** TARGET OUTPUT SCHEMA (OData Structure) ***
The final JSON must be a flat object using these OData field names:
${targetFields}

Additionally, you MUST always include a boolean field "fattura" in the final JSON indicating if the loaded document is an invoice (true) or not (false).

*** MAPPING CONTEXT (Document -> Output) ***
${mappingContext}

*** PROCESSING PIPELINES (Sequential Tool Usage) ***
${toolHints}

`;
                } else {
                    // Fallback if no mappings found (Legacy behavior)
                    console.warn("[PDFHandler] No Field Mappings found. Using default schema generation.");
                    const fields = await SELECT.from(DocumentAIFields);
                    const headerFields = fields.filter(f => f.fieldType === 'header').map(f => `- ${f.fieldName}: ${f.fieldLabel || ''}`);
                    const itemFields = fields.filter(f => f.fieldType === 'lineItem').map(f => `- ${f.fieldName}: ${f.fieldLabel || ''}`);

                    generatedPrompt = `
TARGET SCHEMA:
HEADER FIELDS:
${headerFields.join('\n')}

Additionally, you MUST always include a boolean field "fattura" in the final JSON indicating if the loaded document is an invoice (true) or not (false).

LINE ITEMS (Array of Objects):
${itemFields.join('\n')}
`;
                }


                // Extract Content (Text or Images) from PDF
                let fileBuffer = file;
                if (typeof file === "string") {
                    fileBuffer = Buffer.from(file, "base64");
                }


                const extractedContent = await PDFService.extractTextOrImages(fileBuffer);


                console.log("[PDFHandler] Tipo estratto:");

                if (extractedContent) {
                    //console.log("PDFHandler: testo estratto", extractedContent.data ? extractedContent.data.substring(0, 100) : "Vuoto");
                    console.log("Tipo ricevuto:", extractedContent.type);
                    if (extractedContent.type === 'text') {
                        console.log("Lunghezza testo:", extractedContent.data ? extractedContent.data.length : "N/A");
                        console.log("Anteprima testo (primi 100 char):", extractedContent.data ? extractedContent.data.substring(0, 100) : "Vuoto");
                    } else {
                        console.log("Tipo è 'images'. Numero immagini:", Array.isArray(extractedContent.data) ? extractedContent.data.length : "Non è un array");
                    }
                }

                // Fetch Conversion Functions (Dynamic Tools)
                const conversionFunctions = await SELECT.from('db.ConversionFunctions');

                // Call AI Agent
                const jwt = req.headers?.authorization?.split(' ')[1];
                const context = { companyCode, countryCode, systemPrompt: customSystemPrompt, conversionFunctions, entities, jobId, jwt, aiModel: countryConfig?.aiModel, aiTemperature: countryConfig?.aiTemperature };
                const tools = AgentTools.getToolsInAISchema(context);

                // Result is { data: ..., log: ... }
                const agentResult = await AICoreService.extractDataLikeAgent(extractedContent, tools, generatedPrompt, context);


                let extractedData = agentResult.data;
                const agentLog = agentResult.log;
                const inputTokens = agentResult.usage?.inputTokens || 0;
                const outputTokens = agentResult.usage?.outputTokens || 0;

                // Fallback if raw
                if (extractedData.raw) {
                    try {
                        const jsonMatch = extractedData.raw.match(/```json\n([\s\S]*)\n```/) || extractedData.raw.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            extractedData = JSON.parse(jsonMatch[1] || jsonMatch[0]);
                        } else {
                            throw new Error("Could not parse JSON from raw output");
                        }
                    } catch (e) {
                        console.warn("Final JSON parse failed", e);
                    }
                }

                // Check for empty JSON as per user requirements
                if (!extractedData || Object.keys(extractedData).length === 0) {
                    throw new Error("Invalid or empty JSON returned from AI Agent");
                }

                console.log("[PDFHandler1] Tipo:", extractedContent.type);
                console.log("[PDFHandler1] Raw Extracted Data Preview2:", JSON.stringify(extractedData));
                console.log(`[PDFHandler] Token Usage -> Input2: ${inputTokens}, Output: ${outputTokens}`);
                console.log("[PDFHandler] Estrazione testo:", extractedContent.data);

                // SAFETY REMAP: Ensure we have Document AI fields
                if (fieldMappings && fieldMappings.length > 0) {
                    const validMappings = fieldMappings.filter(m => m.odataField && m.documentAIField);

                    // Remap Header
                    validMappings.forEach(m => {
                        const docField = m.documentAIField.fieldName;
                        const odataField = m.odataField.fieldName;
                        const fieldType = m.documentAIField.fieldType;

                        if (fieldType === 'header' || fieldType === 'Header') {
                            if (extractedData[docField] === undefined && extractedData[odataField] !== undefined) {
                                console.log(`[PDFHandler] Remapping Header '${odataField}' -> '${docField}'`);
                                extractedData[docField] = extractedData[odataField];
                            }
                        }
                    });

                    // Remap Line Items
                    let itemsArrayRef = extractedData.lineItems || extractedData.items || [];
                    if (Array.isArray(itemsArrayRef) && itemsArrayRef.length > 0) {
                        itemsArrayRef.forEach(item => {
                            validMappings.forEach(m => {
                                const docField = m.documentAIField.fieldName;
                                const odataField = m.odataField.fieldName;
                                const fieldType = m.documentAIField.fieldType;

                                if (fieldType !== 'header' && fieldType !== 'Header') {
                                    if (item[docField] === undefined && item[odataField] !== undefined) {
                                        console.log(`[PDFHandler] Remapping Item Field '${odataField}' -> '${docField}'`);
                                        item[docField] = item[odataField];
                                    }
                                }
                            });
                        });
                    }
                }

                // --- DYNAMIC AGGREGATION LOGIC (code-side, driven by FieldMappings flags) ---
                const groupByFields = fieldMappings
                    .filter(m => m.documentAIField && m.aggregationGroupBy === true)
                    .map(m => m.documentAIField.fieldName);

                const sumFields = fieldMappings
                    .filter(m => m.documentAIField && m.aggregationSum === true)
                    .map(m => m.documentAIField.fieldName);

                if (groupByFields.length > 0 && sumFields.length > 0) {
                    let itemsArrayRef = null;
                    let arrayKey = null;

                    if (Array.isArray(extractedData.lineItems)) {
                        itemsArrayRef = extractedData.lineItems;
                        arrayKey = 'lineItems';
                    } else if (Array.isArray(extractedData.items)) {
                        itemsArrayRef = extractedData.items;
                        arrayKey = 'items';
                    }

                    if (itemsArrayRef && itemsArrayRef.length > 0) {
                        const toNumber = (raw) => {
                            const str = typeof raw === 'object' && raw !== null
                                ? String(raw.value || '0')
                                : String(raw || '0');
                            let clean = str.replace(/[^0-9,.\-]/g, '');
                            if (clean.includes(',') && !clean.includes('.')) clean = clean.replace(',', '.');
                            return parseFloat(clean) || 0;
                        };

                        const groupMap = new Map();
                        const aggregatedItems = [];

                        for (const item of itemsArrayRef) {
                            const groupKey = groupByFields.map(k => {
                                const v = item[k] && typeof item[k] === 'object' ? item[k].value : item[k];
                                return String(v || '').trim();
                            }).join('|');

                            if (groupMap.has(groupKey)) {
                                const existing = groupMap.get(groupKey);
                                sumFields.forEach(field => {
                                    const existingNum = toNumber(existing[field]);
                                    const addNum = toNumber(item[field]);
                                    const total = Number((existingNum + addNum).toFixed(3));
                                    if (typeof existing[field] === 'object' && existing[field] !== null) {
                                        existing[field].value = total;
                                    } else {
                                        existing[field] = total;
                                    }
                                });
                            } else {
                                const newItem = JSON.parse(JSON.stringify(item));
                                sumFields.forEach(field => {
                                    const parsed = toNumber(newItem[field]);
                                    if (typeof newItem[field] === 'object' && newItem[field] !== null) {
                                        newItem[field].value = parsed;
                                    } else {
                                        newItem[field] = parsed;
                                    }
                                });
                                groupMap.set(groupKey, newItem);
                                aggregatedItems.push(newItem);
                            }
                        }

                        if (arrayKey === 'lineItems') {
                            extractedData.lineItems = aggregatedItems;
                        } else {
                            extractedData.items = aggregatedItems;
                        }
                        console.log(`[PDFHandler] Aggregation applied: ${itemsArrayRef.length} items -> ${aggregatedItems.length} groups`);
                    }
                }


                const getExtractedFallback = (fieldName) => {
                    if (extractedData[fieldName] !== undefined) {
                        const val = extractedData[fieldName];
                        if (val === null) return null;
                        return typeof val === 'object' ? val.value : val;
                    }
                    if (extractedData.header && extractedData.header[fieldName] !== undefined) {
                        const val = extractedData.header[fieldName];
                        if (val === null) return null;
                        return typeof val === 'object' ? val.value : val;
                    }
                    if (Array.isArray(extractedData.headerFields)) {
                        const f = extractedData.headerFields.find(f => f.name === fieldName);
                        if (f && f.value !== undefined) return f.value;
                    }
                    return null;
                };

                // Update DB with Success
                await UPDATE(DocumentStatusBtp).set({
                    status: "DONE",
                    statusBtp: "InvioOK",
                    extractedData: JSON.stringify(extractedData),
                    agentLog: JSON.stringify(agentLog),
                    inputTokens: inputTokens,
                    outputTokens: outputTokens,
                    // Map specific fields if needed
                    fornitore: getExtractedFallback('vendorName') || getExtractedFallback('senderName'),
                    ordine: getExtractedFallback('purchaseOrderNumber'),
                    invoiceNumber: getExtractedFallback('invoiceNumber') || getExtractedFallback('documentNumber') || getExtractedFallback('DocumentNumber'),
                    companyCode: getExtractedFallback('companyCode') || getExtractedFallback('CompanyCode') || companyCode,
                    fattura: typeof getExtractedFallback('fattura') === 'boolean' ? (getExtractedFallback('fattura') ? 'SI' : 'NO') : (getExtractedFallback('fattura') ? String(getExtractedFallback('fattura')).toUpperCase() : null),
                    // User requested: manual switch only, default to MM
                    // scenario: (getExtractedFallback('purchaseOrderNumber') || getExtractedFallback('poNumber') || getExtractedFallback('ordine')) ? "MM" : "FI"
                    scenario: "MM"
                }).where({ id: jobId });

                success = true;
                break; // Job is successfully done, escape the retry loop
            } catch (error) {
                console.error(`Async Processing Failed (Attempt ${attempt}/${MAX_RETRIES}):`, error);
                lastErrWrapper = error;
                if (attempt < MAX_RETRIES) {
                    await sleep(RETRY_DELAY_MS);
                }
            }
        } // End of retry loop

        if (!success) {
            console.error("All async attempts failed. Updating DB with final error.");
            await UPDATE(DocumentStatusBtp).set({
                status: "FAILED",
                statusBtp: "KO",
                sapErrorLog: lastErrWrapper ? lastErrWrapper.message : "Unknown error"
            }).where({ id: jobId });
        }
    })();

    // 3. Return Job ID immediately
    return jobId;
};

module.exports = PDFHandler;
