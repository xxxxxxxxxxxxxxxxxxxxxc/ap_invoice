const { z } = require("zod");
const { DynamicStructuredTool } = require("@langchain/core/tools");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");
const axios = require("axios");
const PayloadHandler = require("../handlers/PayloadHandler");

// Helper for External Service Call
const executeServiceCall = async (args, jwt) => {
    let url = args.path;
    const finalParams = args.params || {};
    const outputField = args.outputField;

    Object.keys(finalParams).forEach(key => {
        let val = finalParams[key];
        if (val && typeof val === 'object') val = val.value || JSON.stringify(val);
        const placeholder = `{${key}}`;
        if (url.includes(placeholder)) {
            url = url.split(placeholder).join(encodeURIComponent(String(val)));
        }
    });

    const method = args.method || "GET";
    let data = null;
    if (method === "POST" || method === "PUT") {
        data = finalParams;
    }

    const headers = { "Accept": "application/json", "Content-Type": "application/json" };

    try {
        let response;
        if (args.destination) {
            response = await executeHttpRequest(
                { destinationName: args.destination, jwt },
                { method: method, url: url, data: data, headers: headers }
            );
        } else {
            response = await axios({ method: method, url: url, data: data, headers: headers });
        }

        const resData = response.data || response;
        const payloadData = resData.d || resData.value || resData;

        if (Array.isArray(payloadData?.results) || Array.isArray(payloadData)) {
            const list = payloadData.results || payloadData;
            if (list.length > 0) {
                if (outputField) {
                    const mappedList = list.map(item => item[outputField]).filter(val => val !== undefined && val !== null);
                    if (mappedList.length === 1) return String(mappedList[0]);
                    const stringified = JSON.stringify(mappedList);
                    return stringified.length > 8000 ? stringified.substring(0, 8000) + '...]' : stringified;
                }
                const stringified = JSON.stringify(list);
                return stringified.length > 8000 ? stringified.substring(0, 8000) + '...]' : stringified;
            }
            return "No results";
        }
        if (outputField && payloadData?.hasOwnProperty(outputField)) {
            return String(payloadData[outputField]);
        }
        const stringifiedObj = JSON.stringify(payloadData);
        return stringifiedObj.length > 8000 ? stringifiedObj.substring(0, 8000) + '...}' : stringifiedObj;

    } catch (e) {
        console.error("External Service Call Failed:", e.message);
        return `Error: ${e.message}`;
    }
};

const getToolsInAISchema = (context = {}) => {

    const sumTool = new DynamicStructuredTool({
        name: "Sum",
        description: "Sum 2 or more values",
        schema: z.object({
            values: z.array(z.number()).describe("Array of numbers to sum")
        }),
        func: async ({ values }) => values.reduce((a, b) => a + Number(b), 0).toString()
    });

    const concatenateTool = new DynamicStructuredTool({
        name: "Concatenate",
        description: "Concatenate 2 or more strings",
        schema: z.object({
            strings: z.array(z.string()).describe("Array of strings to concatenate")
        }),
        func: async ({ strings }) => strings.join("")
    });

    const uppercaseTool = new DynamicStructuredTool({
        name: "Uppercase",
        description: "Convert a string to uppercase",
        schema: z.object({
            input: z.string().describe("Input string")
        }),
        func: async ({ input }) => input.toUpperCase()
    });

    const lowercaseTool = new DynamicStructuredTool({
        name: "Lowercase",
        description: "Convert a string to lowercase",
        schema: z.object({
            input: z.string().describe("Input string")
        }),
        func: async ({ input }) => input.toLowerCase()
    });

    const multiplyTool = new DynamicStructuredTool({
        name: "Multiply",
        description: "Multiply 2 or more values",
        schema: z.object({
            values: z.array(z.number()).describe("Array of numbers to multiply")
        }),
        func: async ({ values }) => values.reduce((a, b) => a * Number(b), 1).toString()
    });

    const divideTool = new DynamicStructuredTool({
        name: "Divide",
        description: "Divide Numerator by Denominator",
        schema: z.object({
            numerator: z.number(),
            denominator: z.number()
        }),
        func: async ({ numerator, denominator }) => {
            if (denominator === 0) return "Error: Division by zero";
            return (numerator / denominator).toString();
        }
    });

    const subtractTool = new DynamicStructuredTool({
        name: "Subtract",
        description: "Subtract Subtrahend from Minuend",
        schema: z.object({
            minuend: z.number(),
            subtrahend: z.number()
        }),
        func: async ({ minuend, subtrahend }) => (minuend - subtrahend).toString()
    });

    const getCompanyCodeTool = new DynamicStructuredTool({
        name: "GetCompanyCode",
        description: "Get the Company Code from the current context",
        schema: z.object({}),
        func: async () => context.companyCode || "Unknown"
    });

    const getCreationDateTool = new DynamicStructuredTool({
        name: "GetCreationDate",
        description: "Get the Creation Date (Today) in YYYY-MM-DD format",
        schema: z.object({}),
        func: async () => new Date().toISOString().split('T')[0]
    });

    const constantTool = new DynamicStructuredTool({
        name: "Constant",
        description: "Return a constant value provided",
        schema: z.object({
            value: z.string()
        }),
        func: async ({ value }) => value
    });

    const ifThenElseTool = new DynamicStructuredTool({
        name: "IfThenElse",
        description: "Conditional logic: If (Left op Right) Then Return 'thenValue' Else Return 'elseValue'",
        schema: z.object({
            conditionLeft: z.string(),
            operator: z.enum(["EQ", "NE", "GT", "LT", "GE", "LE", "CONTAINS", "NOT_CONTAINS", "STARTS_WITH", "ENDS_WITH", "ISEMPTY"]),
            conditionRight: z.string().optional(),
            thenValue: z.string(),
            elseValue: z.string()
        }),
        func: async ({ conditionLeft, operator, conditionRight, thenValue, elseValue }) => {
            const left = (conditionLeft || "").toLowerCase();
            const right = (conditionRight || "").toLowerCase();
            const op = operator.toUpperCase();
            let res = false;
            switch (op) {
                case "EQ": res = (left === right); break;
                case "NE": res = (left !== right); break;
                case "GT": res = (parseFloat(left) > parseFloat(right)); break;
                case "LT": res = (parseFloat(left) < parseFloat(right)); break;
                case "GE": res = (parseFloat(left) >= parseFloat(right)); break;
                case "LE": res = (parseFloat(left) <= parseFloat(right)); break;
                case "CONTAINS": res = left.includes(right); break;
                case "NOT_CONTAINS": res = !left.includes(right); break;
                case "STARTS_WITH": res = left.startsWith(right); break;
                case "ENDS_WITH": res = left.endsWith(right); break;
                case "ISEMPTY": res = (left === ""); break;
            }
            return res ? thenValue : elseValue;
        }
    });

    const getGLAccountTool = new DynamicStructuredTool({
        name: "getGLAccount",
        description: "Get G/L Account based on the input string ('Propina' or 'Tasa de Turismo')",
        schema: z.object({
            input: z.string().describe("Input string to evaluate")
        }),
        func: async ({ input }) => {
            const normalizedInput = String(input || '').toLowerCase();
            if (normalizedInput.includes('Propina'.toLowerCase())) {
                return 'N105160001';
            } else if (normalizedInput.includes('Tasa de Turismo'.toLowerCase())) {
                return '';
            } else if (normalizedInput.includes('SeguroCampesino'.toLowerCase())) {
                return '';
            }
            else {
                return '';
            }
        }
    });
    const conditionsTool = new DynamicStructuredTool({
        name: "Conditions",
        description: "Evaluates an input value against an array of conditional rules (JSON string) and returns the corresponding Then value for the first matching condition, or DefaultValue if none match.",
        schema: z.object({
            Input: z.string().describe("The input value or field to evaluate (e.g. the description text)"),
            Conditions: z.string().describe("JSON string of an array of condition objects (e.g., '[{\"operator\": \"CONTAINS\", \"conditionRight\": \"Tasa\", \"thenValue\": \"N112010009\"}]')"),
            DefaultValue: z.string().describe("Value to return if no condition matches")
        }),
        func: async ({ Input, Conditions, DefaultValue }) => {
            console.log("[Tool Conditions DEBUG] Input Value:", Input);
            console.log("[Tool Conditions DEBUG] Conditions JSON:", Conditions);
            console.log("[Tool Conditions DEBUG] Default Value:", DefaultValue);

            try {
                const condsArray = JSON.parse(Conditions);
                if (!Array.isArray(condsArray)) {
                    return DefaultValue;
                }

                const sLeft = String(Input !== undefined ? Input : "").trim();

                for (let i = 0; i < condsArray.length; i++) {
                    const rule = condsArray[i];
                    const operator = rule.operator !== undefined ? rule.operator : rule.Operator;
                    const rawRight = rule.conditionRight !== undefined ? rule.conditionRight : rule.ConditionRight;
                    const thenVal = rule.thenValue !== undefined ? rule.thenValue : rule.ThenValue;

                    const sRight = String(rawRight !== undefined ? rawRight : "").trim();

                    let bResult = false;
                    const nLeft = parseFloat(sLeft);
                    const nRight = parseFloat(sRight);
                    const isNumeric = !isNaN(nLeft) && !isNaN(nRight);

                    const op = (operator || "").toUpperCase().trim().replace(/\s+/g, "_");

                    if (isNumeric) {
                        switch (op) {
                            case "EQ": case "=": case "==": case "===": bResult = (nLeft === nRight); break;
                            case "NE": case "!=": case "<>": case "!==": bResult = (nLeft !== nRight); break;
                            case "GT": case ">": bResult = (nLeft > nRight); break;
                            case "GE": case ">=": bResult = (nLeft >= nRight); break;
                            case "LT": case "<": bResult = (nLeft < nRight); break;
                            case "LE": case "<=": bResult = (nLeft <= nRight); break;
                            case "ISEMPTY": case "IS_EMPTY": bResult = (sLeft === ""); break;
                            default: bResult = false;
                        }
                    } else {
                        const sLeftLower = sLeft.toLowerCase();
                        const sRightLower = sRight.toLowerCase();
                        switch (op) {
                            case "EQ": case "=": case "==": case "===": bResult = (sLeftLower === sRightLower); break;
                            case "NE": case "!=": case "<>": case "!==": bResult = (sLeftLower !== sRightLower); break;
                            case "CONTAINS": bResult = sLeftLower.includes(sRightLower); break;
                            case "NOT_CONTAINS": bResult = !sLeftLower.includes(sRightLower); break;
                            case "STARTS_WITH": bResult = sLeftLower.startsWith(sRightLower); break;
                            case "ENDS_WITH": bResult = sLeftLower.endsWith(sRightLower); break;
                            case "ISEMPTY": case "IS_EMPTY": bResult = (sLeft === ""); break;
                            default: bResult = false;
                        }
                    }

                    if (bResult) {
                        return thenVal !== undefined ? String(thenVal) : "";
                    }
                }

                return DefaultValue;
            } catch (e) {
                return `Error: Invalid JSON for conditions. ${e.message}`;
            }
        }
    });

    const generateProgressiveTool = new DynamicStructuredTool({
        name: "GenerateProgressive",
        description: "Generate a progressive number string based on the current item index (e.g. 00010, 00020)",
        schema: z.object({
            length: z.number().default(5),
            index: z.number().describe("Current item index (0-based)")
        }),
        func: async ({ length, index }) => String((index + 1) * 10).padStart(length, '0')
    });

    const substringTool = new DynamicStructuredTool({
        name: "Substring",
        description: "Extract a substring from the input",
        schema: z.object({
            input: z.string(),
            length: z.number()
        }),
        func: async ({ input, length }) => input.substring(0, length)
    });

    const formatDateTool = new DynamicStructuredTool({
        name: "FormatDate",
        description: "Format a date string to YYYY-MM-DD",
        schema: z.object({
            dateString: z.string(),
            inputFormat: z.string().optional()
        }),
        func: async ({ dateString }) => dateString // Placeholder
    });

    /*   const callExternalServiceTool = new DynamicStructuredTool({
           name: "CallExternalService",
           description: "Call an external OData or REST service to retrieve data.",
           schema: z.object({
               destination: z.string().describe("BTP Destination Name").optional(),
               path: z.string().describe("Service configuration path or URL"),
               method: z.enum(["GET", "POST"]).default("GET"),
               params: z.record(z.any()).describe("Key-value pairs for replacement in URL or body").optional()
           }),
           func: async (args) => executeServiceCall(args)
       });*/

    const conversionFunctions = context.conversionFunctions || [];

    // Hardcoded tools list
    const switchCaseTool = new DynamicStructuredTool({
        name: "SwitchCase",
        description: "Compares an input value against a list of cases (JSON string) and returns the corresponding result, or a default value if no match is found.",
        schema: z.object({
            Input: z.string().describe("Input value to check"),
            Cases: z.string().describe("JSON string of key-value pairs representing cases (e.g., '{\"A\": \"ResultA\", \"B\": \"ResultB\"}')"),
            DefaultValue: z.string().describe("Value to return if no match is found")
        }),
        func: async ({ Input, Cases, DefaultValue }) => {
            try {
                const casesObj = JSON.parse(Cases);
                const result = casesObj[Input];
                return result !== undefined ? String(result) : DefaultValue;
            } catch (e) {
                return `Error: Invalid JSON for cases. ${e.message}`;
            }
        }
    });

    const existsGroupTool = new DynamicStructuredTool({
        name: "ExistsGroup",
        description: "Check if at least one row exists in a grouping (FieldType). Returns 'X' if exists, blank otherwise.",
        schema: z.object({
            groupName: z.string().describe("The name of the grouping (e.g. lineItem, withholdingTax, glAccountDataSet)")
        }),
        func: async ({ groupName }) => {
            // This is a placeholder for the agent to know the tool exists
            // The actual execution logic is in PayloadHandler.js
            return "X";
        }
    });

    const staticTools = [
        sumTool, concatenateTool, uppercaseTool, lowercaseTool, multiplyTool, divideTool, subtractTool,
        getCompanyCodeTool, constantTool, ifThenElseTool, generateProgressiveTool,
        substringTool, formatDateTool, switchCaseTool, existsGroupTool, getGLAccountTool, conditionsTool,
        new DynamicStructuredTool({
            name: "SimulateInvoice",
            description: "Validate the invoice data against the system configuration. Returns errors if any.",
            schema: z.object({
                headerData: z.string().describe("JSON string of header data"),
                itemsData: z.string().describe("JSON string of items data")
            }),
            func: async ({ headerData, itemsData }) => {
                if (!context.entities) return "Error: Internal System Error (Entities not available)";
                if (!context.jobId) return "Error: Internal System Error (Job ID not available)";

                try {
                    const req = {
                        data: {
                            id: context.jobId,
                            countryCode: context.countryCode,
                            headerData: headerData,
                            itemsData: itemsData,
                            Simulation: true
                        },
                        error: (code, msg) => { return { error: { code, message: msg } } }
                    };

                    const result = await PayloadHandler.simulateMapping(req, context.entities);

                    let resultObj;
                    try {
                        resultObj = JSON.parse(result);
                    } catch (e) {
                        // Check if result is error object from req.error
                        if (typeof result === 'object' && result.error) return `Simulation Error: ${result.error.message}`;
                        return `Simulation Failed to Parse Response: ${result}`;
                    }

                    if (resultObj.error) return `Simulation Error: ${resultObj.error.message}`;

                    const meta = resultObj.__metadata;
                    if (!meta) return "Simulation Success (No Metadata returned)";

                    const errors = [];
                    if (meta.conversions) {
                        if (meta.conversions.header) {
                            Object.keys(meta.conversions.header).forEach(k => {
                                const info = meta.conversions.header[k];
                                if (info.error) errors.push(`Header Field '${k}': ${info.error}`);
                            });
                        }
                        if (meta.conversions.items && Array.isArray(meta.conversions.items)) {
                            meta.conversions.items.forEach((item, idx) => {
                                Object.keys(item).forEach(k => {
                                    const info = item[k];
                                    if (info.error) errors.push(`Item ${idx + 1} Field '${k}': ${info.error}`);
                                });
                            });
                        }
                    }

                    if (errors.length > 0) {
                        return "Simulation Validation Errors:\n" + errors.join("\n");
                    }

                    return "Success: Simulation Validated. Payload is compliant.";

                } catch (e) {
                    return `Simulation Exception: ${e.message}`;
                }
            }
        })
    ];

    const toolsMap = new Map();

    // Add static tools first
    staticTools.forEach(t => toolsMap.set(t.name, t));

    // Add dynamic tools only if name is not already taken
    conversionFunctions.forEach(cf => {
        if (toolsMap.has(cf.name)) return;

        let paramsSchema = {};
        try {
            const rawParams = cf.inputParams ? JSON.parse(cf.inputParams) : {};
            if (Array.isArray(rawParams)) {
                for (const paramName of rawParams) {
                    paramsSchema[paramName] = z.string().describe(paramName);
                }
            } else {
                for (const [key, desc] of Object.entries(rawParams)) {
                    paramsSchema[key] = z.string().describe(typeof desc === 'string' ? desc : key);
                }
            }
        } catch (e) {
            console.warn(`[AgentTools] Failed to parse params for ${cf.name}:`, e.message);
        }

        const dynamicTool = new DynamicStructuredTool({
            name: cf.name,
            description: cf.description || "Custom Function",
            schema: z.object(paramsSchema),
            func: async (args) => {
                return executeServiceCall({
                    path: cf.serviceUrl,
                    method: cf.method || 'GET',
                    destination: cf.destination,
                    outputField: cf.outputField,
                    params: args
                }, context.jwt);
            }
        });

        toolsMap.set(cf.name, dynamicTool);
    });

    return Array.from(toolsMap.values());
};

module.exports = {
    getToolsInAISchema: getToolsInAISchema
};
