const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");

async function executeSearchHelp(req, entities) {
    const { functionId, filters } = req.data;

    try {
        console.log(`[SearchHelpHandler] Executing Search Help function ID: ${functionId}`);

        // Fetch ConversionFunctions configuration
        const { ConversionFunctions } = entities;
        const config = await SELECT.one.from(ConversionFunctions).where({ id: functionId });

        if (!config) {
            req.error(404, `Search Help function configuration not found for ID: ${functionId}`);
            return;
        }

        const destinationName = config.destination;
        const serviceUrl = config.serviceUrl;

        if (!destinationName || !serviceUrl) {
            req.error(400, "Search Help function must have a configured destination and serviceUrl");
            return;
        }

        const url = `${serviceUrl}`;
        console.log(`[SearchHelpHandler] Base serviceUrl: ${url}`);

        // Prepare filters and handle placeholders
        let parsedFilters = {};
        if (filters && filters.trim() !== "") {
             try {
                 parsedFilters = JSON.parse(filters);
             } catch (e) {
                 console.warn("[SearchHelpHandler] Could not parse filters JSON.", e);
             }
         }

        // Strip all non-printable characters and control characters (like \r, \n, \t)
        let finalUrl = url.replace(/[^\x20-\x7E]/g, '').trim();
        
        console.log("[SearchHelpHandler] Cleaned serviceUrl: " + finalUrl);

        let replacedPlaceholders = new Set();
        for (const key in parsedFilters) { // Changed oFilters to parsedFilters
            const placeholder = "{" + key + "}";
            if (finalUrl.includes(placeholder)) {
                const value = parsedFilters[key]; // Changed oFilters to parsedFilters
                // Replace placeholder and also check for common patterns like ' {placeholder}' or '{placeholder} '
                // to avoid issues with whitespaces left after replacement
                finalUrl = finalUrl.split(placeholder).join(encodeURIComponent(value || ''));
                replacedPlaceholders.add(key);
            }
        }

        // Construct remainingFilters by excluding those that were replaced in the URL
        let remainingFilters = {};
        for (const key in parsedFilters) {
            if (!replacedPlaceholders.has(key)) {
                remainingFilters[key] = parsedFilters[key];
            }
        }

        // 2. Construct appended $filter string for remaining fields
        const filterParts = [];
        for (const [key, value] of Object.entries(remainingFilters)) {
            if (value && String(value).trim() !== "") {
                const sVal = String(value).trim();
                if (sVal.includes("*")) {
                    let cleanVal = sVal.replace(/\*/g, '');
                    if (sVal.startsWith("*") && sVal.endsWith("*")) {
                        filterParts.push(`substringof('${cleanVal}', ${key})`);
                    } else if (sVal.endsWith("*")) {
                        filterParts.push(`startswith(${key}, '${cleanVal}')`);
                    } else if (sVal.startsWith("*")) {
                        filterParts.push(`endswith(${key}, '${cleanVal}')`);
                    } else {
                        filterParts.push(`${key} eq '${cleanVal}'`);
                    }
                } else {
                    filterParts.push(`${key} eq '${sVal}'`);
                }
            }
        }

        if (filterParts.length > 0) {
            const filterClause = "$filter=" + filterParts.join(" and ");
            if (finalUrl.includes("?")) {
                // If it already has other parameters, check if it already has $filter
                if (finalUrl.includes("$filter=")) {
                     finalUrl += " and " + filterParts.join(" and ");
                } else {
                     finalUrl += "&" + filterClause;
                }
            } else {
                finalUrl += "?" + filterClause;
            }
        }

        console.log(`[SearchHelpHandler] Executing call to destination ${destinationName} URL: ${finalUrl}`);

        // JWT token extraction for Cloud SDK
        const jwt = req.headers && req.headers.authorization 
            ? req.headers.authorization.split(' ')[1] 
            : undefined;

        // Execute HTTP request using Cloud SDK (passing JWT explicitly)
        const oResponse = await executeHttpRequest(
            { destinationName: destinationName, jwt: jwt },
            {
                method: "GET",
                url: finalUrl,
                headers: {
                    "Accept": "application/json"
                }
            }
        );

        if (oResponse && oResponse.data) {
           let results = [];
           const resData = oResponse.data;
           console.log("[SearchHelpHandler] Raw Response Data:", JSON.stringify(resData));
           
           if (resData.d && resData.d.results) {
               results = resData.d.results;
           } else if (resData.value) {
               results = resData.value; // OData V4 format
           } else if (Array.isArray(resData)) {
               results = resData;
           } else {
               results = [resData]; // Wrap single object
           }

           console.log("[SearchHelpHandler] Fetched " + (Array.isArray(results) ? results.length : 0) + " records.");
           return JSON.stringify(results);
        }

        return "[]";

    } catch (error) {
        console.error("[SearchHelpHandler] Error executing Search Help:", error);
        
        // Return 500 with detailed message
        let errorMsg = error.message;
        if (error.response && error.response.data) {
            errorMsg += " - Details: " + JSON.stringify(error.response.data);
        }
        
        req.error(500, `Error executing search help: ${errorMsg}`);
        return "[]";
    }
}

module.exports = {
    executeSearchHelp
};
