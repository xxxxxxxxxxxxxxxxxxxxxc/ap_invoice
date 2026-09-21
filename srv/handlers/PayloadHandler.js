const axios = require("axios");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");
const { setTimeout: delay } = require("node:timers/promises");

const isEmptyObject = (obj) => {
    if (!obj || typeof obj !== 'object') return true;
    return Object.keys(obj).every(k => {
        const v = obj[k];
        if (Array.isArray(v)) return v.length === 0;
        return v === null || v === undefined || v === "" || (typeof v === 'object' && isEmptyObject(v));
    });
};

const getValueByPath = (obj, path) => {
    if (!obj || !path) return undefined;
    const parts = path.split(/\/|\./);
    let current = obj;
    for (let i = 0; i < parts.length; i++) {
        let part = parts[i].toLowerCase().trim();
        if (part.includes(':')) part = part.split(':').pop();

        if (!current || typeof current !== 'object') return undefined;
        if (Array.isArray(current)) current = current[0];
        if (current && typeof current === 'object') {
            const keys = Object.keys(current);
            const foundKey = keys.find(k => {
                const cleanKey = k.includes(':') ? k.split(':').pop() : k;
                return cleanKey.toLowerCase() === part;
            });
            if (foundKey) {
                current = current[foundKey];
            } else {
                if ((i === 0 || (i === 1 && parts[0].toLowerCase().trim() === parts[1].toLowerCase().trim())) && i < parts.length - 1) {
                    continue;
                } else {
                    return undefined;
                }
            }
        } else {
            return undefined;
        }
    }
    return current;
};

const getValueByPathAll = (obj, path) => {
    if (!obj || !path) return [];

    // Normalize path: split by / or .
    const parts = path.split(/\/|\./);

    let results = [];

    function searchDeep(current, pathParts, depth) {
        if (!current || depth >= pathParts.length) return;

        let part = pathParts[depth].toLowerCase().trim();
        if (part.includes(':')) part = part.split(':').pop();

        const node = Array.isArray(current) ? current : [current];

        node.forEach(n => {
            if (!n || typeof n !== 'object') return;

            const nKeys = Object.keys(n);
            const foundKey = nKeys.find(k => (k.includes(':') ? k.split(':').pop() : k).toLowerCase() === part);

            if (foundKey) {
                const val = n[foundKey];
                if (depth === pathParts.length - 1) {
                    if (Array.isArray(val)) results.push(...val);
                    else results.push(val);
                } else {
                    searchDeep(val, pathParts, depth + 1);
                }
            }
        });
    }

    // Try normal path traversal. If it fails, try skipping parts of the prefix.
    // This handles cases where the AI path is absolute (including roots) but 
    // the object structure is relative (roots stripped by explicitRoot: false).
    for (let i = 0; i < parts.length; i++) {
        searchDeep(obj, parts, i);
        if (results.length > 0) break;
    }

    return results;
};

const generateInvoicePayload = async (req, entities) => {
    console.log("[DEBUG_VERSION] generating invoice payload (Refactored Handler)");
    const { id } = req.data;
    let { countryCode } = req.data;

    if (!id) {
        return req.error(400, "ID is required");
    }

    try {
        const { DocumentStatusBtp, FieldMappings, CountryFieldConfig } = entities;

        let headerData = {};
        let itemsData = [];
        let headerAttributes = {};
        let itemAttributes = [];

        // Always fetch document data first to get system properties and fallback countryCode
        const docData = await SELECT.one
            .from(DocumentStatusBtp)
            .where({ id: id });
        if (!docData) return req.error(404, "Document not found");

        if (!countryCode) {
            countryCode = docData.countryCode;
        }

        if (!countryCode) {
            return req.error(
                400,
                "Country Code is required (not found in request or document)",
            );
        }

        // 1. Check if Frontend passed data directly (Prioritize Editing)
        if (req.data.headerData && req.data.itemsData) {
            try {
                headerData = JSON.parse(req.data.headerData);
                itemsData = JSON.parse(req.data.itemsData);
                console.log("Using Frontend Data for Payload Generation");
                console.log("[DIAG] Received Header Data keys:", Object.keys(headerData).join(", "));
                console.log("[DIAG] Header TaxCode value:", headerData.taxCode || headerData.tax_code || "MISSING");
                if (itemsData.length > 0) {
                    console.log("[DIAG] First Item TaxCode value:", itemsData[0].taxCode || itemsData[0].tax_code || "MISSING");
                }

                // Extract attributes from DB extractedData for TAG_PROPERTY support
                if (docData.extractedData) {
                    try {
                        const dbData = JSON.parse(docData.extractedData);
                        if (dbData.headerFields && Array.isArray(dbData.headerFields)) {
                            dbData.headerFields.forEach(f => {
                                if (f.attributes) headerAttributes[f.name] = f.attributes;
                            });
                        }
                        const dbLineItems = dbData.lineItems || dbData.lineItem || [];
                        if (Array.isArray(dbLineItems)) {
                            dbLineItems.forEach(line => {
                                const attrObj = {};
                                if (Array.isArray(line)) {
                                    line.forEach(f => { if (f.attributes) attrObj[f.name] = f.attributes; });
                                }
                                itemAttributes.push(attrObj);
                            });
                        }
                    } catch (attrErr) {
                        console.warn("[PayloadHandler] Could not extract attributes from DB extractedData:", attrErr.message);
                    }
                }
            } catch (e) {
                console.error("Failed to parse provided header/items data", e);
                return req.error(400, "Invalid JSON data provided");
            }
        } else {
            // 2. Fallback: Use Extracted Data from DB
            if (docData.extractedData) {
                try {
                    const rawData = JSON.parse(docData.extractedData);

                    // NORMALIZE DATA (DOX vs Simple)
                    if (rawData.headerFields && Array.isArray(rawData.headerFields)) {
                        // DOX Format
                        headerData = {};
                        rawData.headerFields.forEach((f) => {
                            headerData[f.name] = f.value;
                            if (f.attributes) headerAttributes[f.name] = f.attributes;
                        });

                        itemsData = [];
                        if (rawData.lineItems && Array.isArray(rawData.lineItems)) {
                            itemsData = rawData.lineItems.map((line) => {
                                const lineObj = {};
                                const attrObj = {};
                                // DOX lineItems are array of fields
                                if (Array.isArray(line)) {
                                    line.forEach((f) => {
                                        lineObj[f.name] = f.value;
                                        if (f.attributes) attrObj[f.name] = f.attributes;
                                    });
                                }
                                itemAttributes.push(attrObj);
                                return lineObj;
                            });
                        }
                    } else {
                        // Simple/XML Format
                        headerData = rawData.header || rawData.headerFields || {}; // Handle XML flat format too
                        itemsData = rawData.items || rawData.lineItems || [];

                        // If XML Upload used 'headerFields' as Array of objects, we need to flatten it too?
                        if (Array.isArray(headerData)) {
                            const flatHeader = {};
                            headerData.forEach((f) => {
                                flatHeader[f.name] = f.value;
                                if (f.attributes) headerAttributes[f.name] = f.attributes;
                            });
                            headerData = flatHeader;
                        }
                    }
                } catch (e) {
                    console.error("Error parsing extractedData", e);
                    return req.error(500, "Failed to parse saved data from DB");
                }
            }
        }


        // 1.2 Detect XML grouped structure (fieldType-keyed object vs flat array)
        let bIsGrouped = false;
        let groups = {};

        if (itemsData && typeof itemsData === 'object' && !Array.isArray(itemsData)) {
            bIsGrouped = true;
            Object.entries(itemsData).forEach(([fieldType, groupArr]) => {
                if (Array.isArray(groupArr) && groupArr.length > 0) {
                    groups[fieldType] = groupArr;
                }
            });
            itemsData = groups['lineItem'] || groups['item'] || [];
            console.log(`[DEBUG_PAYLOAD] XML grouped structure detected. Groups: ${Object.keys(groups).join(', ')}. lineItem count: ${itemsData.length}`);
        }

        // 1.3 Validate Company Code against Country Configuration
        let currentCompanyCode = headerData.companyCode || headerData.CompanyCode || docData.companyCode;

        // For XML documents, the company code key is the XML tag path (e.g. "Invoice/Buyer/CompanyCode")
        if (!currentCompanyCode) {
            const countryConfig = await SELECT.one.from(entities.Countries).where({ code: (countryCode || '').toUpperCase() });
            if (countryConfig && countryConfig.xmlCompanyCodeTag) {
                currentCompanyCode = headerData[countryConfig.xmlCompanyCodeTag] || null;
            }
        }

        const sCountryCodeUpperValidation = (countryCode || '').toUpperCase();
        console.log(`[VALIDATION] Checking Company Code ${currentCompanyCode} for Country ${sCountryCodeUpperValidation}`);
        const validCompanyCodes = await SELECT.from(entities.CompanyCodes).where({ country_code: sCountryCodeUpperValidation });
        console.log(`[VALIDATION] Found ${validCompanyCodes.length} valid company codes for ${sCountryCodeUpperValidation}`);

        if (validCompanyCodes && validCompanyCodes.length > 0) {
            const isValidCompany = validCompanyCodes.some(c => c.code === currentCompanyCode);
            if (!isValidCompany) {
                if (req.event === 'simulateMapping') {
                    console.warn(`[VALIDATION] Company Code ${currentCompanyCode} not allowed for Country ${sCountryCodeUpperValidation}. Skipping error for simulateMapping.`);
                } else {
                    return req.error(400, "COMPANY_CODE_NOT_ALLOWED");
                }
            }
        }

        // 1.5 Determine Scenario (MM or FI)
        let scenario = req.data.scenario || docData.scenario;
        if (!scenario) {
            /*
            // OLD LOGIC: Auto-detect scenario based on PO presence (disabled: manual switch only)
            let poPresent = headerData.purchaseOrderNumber || headerData.purchaseOrder || headerData.poNumber;
  
            const bitIsXmlDetection = docData.documentType === 'XML' || (docData.documentType === 'custom' && docData.fileName.toLowerCase().endsWith('.xml'));
            
            if (!poPresent && bitIsXmlDetection) {
                const countryConfig = await SELECT.one.from(entities.Countries).where({ code: (countryCode || '').toUpperCase() });
                if (countryConfig && countryConfig.xmlPoReferenceTag) {
                    poPresent = headerData[countryConfig.xmlPoReferenceTag] || null;
                }
            }
  
            if (!poPresent && itemsData && itemsData.length > 0) {
                 const firstItem = itemsData[0];
                 const itemPO = firstItem.purchaseOrderNumber || firstItem.purchaseOrder || firstItem.poNumber;
                 if (itemPO) {
                     poPresent = true;
                 } else if (bitIsXmlDetection) {
                     const countryConfig = await SELECT.one.from(entities.Countries).where({ code: (countryCode || '').toUpperCase() });
                     if (countryConfig && countryConfig.xmlPoReferenceTag) {
                         poPresent = firstItem[countryConfig.xmlPoReferenceTag] || null;
                     }
                 }
            }
  
            if (poPresent) {
                scenario = 'MM';
            } else {
                scenario = 'FI';
            }
            console.log(`Auto-detected Scenario: ${scenario} (PO Present: ${!!poPresent})`);
            */
            scenario = 'MM';
            console.log(`Scenario defaulted to MM (manual switch only)`);
        } else {
            console.log(`Using Scenario from request/document: ${scenario}`);
        }

        // 1.8 Initialize Payload
        let payload = {};
        let groupIndexMap = {}; // Tracks Index for GroupIDs per NavProp: "NavProp_GrpID" -> Index int

        const sCountryCodeUpper = (countryCode || '').toUpperCase();

        let docFieldTypes = {};
        try {
            const docFields = await SELECT.from(entities.DocumentAIFields).columns('fieldName', 'fieldType');
            docFields.forEach(f => {
                if (f.fieldName) docFieldTypes[f.fieldName] = f.fieldType;
            });
        } catch (err) {
            console.warn("[PayloadHandler] Could not load DocumentAIFields for field types", err.message);
        }

        // 2. Fetch Mappings
        let mappings = await SELECT.from(FieldMappings)
            .where({ country_code: sCountryCodeUpper, active: true, scenario: scenario })
            .columns((m) => {
                m.id;
                m.documentAIField_fieldName;
                m.documentAIField_fieldType;
                m.documentAIField_sourceType;
                m.odataField_id;
                m.documentAIField((f) => {
                    f.fieldName; f.fieldType; f.sourceType;
                });
                m.odataField((f) => {
                    f.fieldName; f.dataType; f.fieldType; f.entityName;
                });
                m.steps((s) => {
                    s.stepOrder;
                    s.functionParameters;
                    s.conversionFunction((f) => {
                        f.serviceUrl; f.destination; f.name; f.method; f.outputField; f.inputParams;
                    });
                });
                m.groupId;
            });

        // 2.1 Filter Mappings by CountryFieldConfig.active flag
        try {
            const disabledConfigs = await SELECT.from(CountryFieldConfig).where({
                country_code: sCountryCodeUpper,
                scenario: scenario,
                active: false
            });

            if (disabledConfigs.length > 0) {
                console.log(`[PayloadHandler] Found ${disabledConfigs.length} disabled fields in CountryFieldConfig for ${sCountryCodeUpper} / ${scenario}. Filtering mappings...`);
                mappings = mappings.filter(m => {
                    const isDisabled = disabledConfigs.some(dc =>
                        dc.documentAIField_fieldName === m.documentAIField_fieldName &&
                        dc.documentAIField_fieldType === m.documentAIField_fieldType &&
                        dc.documentAIField_sourceType === m.documentAIField_sourceType
                    );
                    if (isDisabled) {
                        console.log(`[PayloadHandler] Field ${m.documentAIField_fieldName} (${m.documentAIField_fieldType}) is inactive in CountryFieldConfig. Excluding from payload.`);
                    }
                    return !isDisabled;
                });
            }
        } catch (err) {
            console.warn("[PayloadHandler] Error checking CountryFieldConfig active flag", err.message);
        }
        /*
        // OLD LOGIC: Fallback to alternate scenario if no mappings found (disabled: manual switch only)
        if (mappings.length === 0) {
            const alternateScenario = scenario === 'MM' ? 'FI' : 'MM';
            console.warn(`No mappings found for ${countryCode} with Scenario ${scenario}. Trying fallback to ${alternateScenario}.`);
            
            const altMappings = await SELECT.from(FieldMappings)
              .where({ country_code: countryCode, active: true, scenario: alternateScenario })
              .columns((m) => {
                m.id;
                m.documentAIField_fieldName;
                m.odataField_id;
                m.documentAIField((f) => {
                  f.fieldName; f.fieldType; f.sourceType;
                });
                m.odataField((f) => {
                  f.fieldName; f.dataType; f.fieldType; f.entityName;
                });
                m.steps((s) => {
                  s.stepOrder;
                  s.functionParameters;
                  s.conversionFunction((f) => {
                    f.serviceUrl; f.destination; f.name; f.method; f.outputField; f.inputParams;
                  });
                });
                m.groupId;
              });
              
            if (altMappings.length > 0) {
                console.log(`Fallback successful. Using Scenario ${alternateScenario}`);
                scenario = alternateScenario;
                mappings = altMappings;
            }
        }
        */
        if (mappings.length === 0) {
            console.warn(`No mappings found for ${countryCode} with Scenario ${scenario}.`);
        }

        // SAFETY FILTER: Remove broken mappings (orphans)
        const validMappings = mappings.filter((m) => {
            if (!m.documentAIField) {
                console.warn(
                    `Mapping skipped: Missing Document AI Field (ID: ${m.id}, Key: ${m.documentAIField_fieldName})`,
                );
                return false;
            }
            if (!m.odataField) {
                console.warn(
                    `Mapping has no OData Field (ID: ${m.id}). Allowing it for conversion execution only.`,
                );
            }
            return true;
        });

        if (!validMappings || validMappings.length === 0) {
            return req.error(400, `No active mappings found for ${countryCode} (Scenario: ${scenario})`);
        }

        // 1.9 Determine if document is XML
        const isXml = docData.documentType === 'XML' || (docData.documentType === 'custom' && docData.fileName.toLowerCase().endsWith('.xml'));

        let fullXmlDoc = null;
        let graftedXmlDoc = null;

        if (isXml && docData.content) {
            try {
                const { parseStringPromise } = require('xml2js');
                let xmlContent = docData.content;
                if (Buffer.isBuffer(xmlContent)) {
                    xmlContent = xmlContent.toString('utf8');
                } else if (typeof xmlContent === 'string') {
                    if (!xmlContent.trim().startsWith('<')) {
                        try {
                            xmlContent = Buffer.from(xmlContent, 'base64').toString('utf8');
                        } catch (e) { }
                    }
                }

                // Pre-sanitize to remove problematic UBLExtensions with binary signatures
                if (typeof xmlContent === 'string') {
                    xmlContent = xmlContent.replace(/<ext:UBLExtensions[\s\S]*?<\/ext:UBLExtensions>/g, '');
                }

                fullXmlDoc = await parseStringPromise(xmlContent, { explicitArray: true, trim: true, explicitRoot: false });

                const countryConfig = await SELECT.one.from(entities.Countries).where({ code: sCountryCodeUpper });
                const xmlRefTag = countryConfig ? countryConfig.xmlReferenceTag : null;

                if (xmlRefTag) {
                    const findDeepNodeByPath = (obj, path) => {
                        const parts = path.split(/\/|\./).map(p => (p.includes(':') ? p.split(':')[1] : p).toLowerCase());
                        let results = [];

                        const traverse = (current, depth) => {
                            if (!current || typeof current !== 'object') return;
                            if (depth >= parts.length) return;

                            const searchPart = parts[depth];

                            if (Array.isArray(current)) {
                                for (let i = 0; i < current.length; i++) {
                                    traverse(current[i], depth);
                                }
                                return;
                            }

                            const keys = Object.keys(current);
                            let foundMatch = false;

                            for (const k of keys) {
                                const cleanKey = k.includes(':') ? k.split(':').pop() : k;
                                if (cleanKey.toLowerCase() === searchPart) {
                                    if (depth === parts.length - 1) {
                                        results.push({ node: current[k], parent: current, key: k });
                                    } else {
                                        traverse(current[k], depth + 1);
                                    }
                                    foundMatch = true;
                                }
                            }

                            // Se stiamo cercando il primo nodo e non l'abbiamo trovato, continuiamo in profondità
                            if (!foundMatch && depth === 0) {
                                for (const k of keys) {
                                    traverse(current[k], depth);
                                }
                            }
                        };

                        traverse(obj, 0);

                        if (results.length > 1) {
                            for (const res of results) {
                                const first = Array.isArray(res.node) ? res.node[0] : res.node;
                                let content = (typeof first === 'object' && first !== null) ? first._ : String(first ?? '');
                                if (content && typeof content === 'string') {
                                    const trimmed = content.trim();
                                    if (trimmed.startsWith('<') || trimmed.startsWith('PD94bWwg') || trimmed.length > 100) return res;
                                }
                            }
                        }
                        return results[0] || null;
                    };

                    let embeddedInfo = findDeepNodeByPath(fullXmlDoc, xmlRefTag);

                    if (embeddedInfo && embeddedInfo.node) {
                        const first = Array.isArray(embeddedInfo.node) ? embeddedInfo.node[0] : embeddedInfo.node;
                        let embeddedContent = (typeof first === 'object' && first !== null) ? first._ : String(first ?? '');
                        if (embeddedContent && typeof embeddedContent === 'string') {
                            embeddedContent = embeddedContent.trim();
                            if (!embeddedContent.startsWith('<')) {
                                try {
                                    const decoded = Buffer.from(embeddedContent, 'base64').toString('utf8');
                                    if (decoded.trim().startsWith('<')) embeddedContent = decoded.trim();
                                } catch (e) { }
                            }
                            if (embeddedContent.startsWith('<')) {
                                // Pre-sanitize embedded XML as well
                                embeddedContent = embeddedContent.replace(/<ext:UBLExtensions[\s\S]*?<\/ext:UBLExtensions>/g, '');
                                graftedXmlDoc = await parseStringPromise(embeddedContent, { explicitArray: true, trim: true, explicitRoot: false });
                                if (graftedXmlDoc) console.log("[PayloadHandler] Embedded XML successfully parsed and grafted.");
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("[PayloadHandler] Failed to parse raw XML for attribute extraction", err);
            }
        }

        // 2.0 FILTER MAPPINGS BY SOURCE TYPE
        const processMappings = validMappings.filter(m => {
            const fieldSource = m.documentAIField.sourceType || 'DOX';
            if (isXml) {
                // For XML documents, ONLY allow XML-specific mappings.
                return fieldSource === 'XML';
            } else {
                // For PDF documents, ONLY allow standard AI (DOX) mappings.
                return fieldSource === 'DOX';
            }
        });

        if (processMappings.length === 0) {
            console.warn(`[PayloadHandler] No mappings match the document type (XML: ${isXml}) for ${countryCode}`);
        }

        const setDeepValue = (obj, path, value) => {
            if (!path) return;
            const parts = path.split("/");
            let current = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                if (!current[part]) current[part] = {};
                current = current[part];
            }
            current[parts[parts.length - 1]] = value;
        };

        const ENTITY_NAV_MAP = {
            A_SuplrInvcItemPurOrdRef: "to_SuplrInvcItemPurOrdRef",
            A_SuplrInvcItemPurOrdRefType: "to_SuplrInvcItemPurOrdRef",
            A_SupplierInvoiceItemGLAcct: "to_SupplierInvoiceItemGLAcct",
            A_SupplierInvoiceItemGLAcctType: "to_SupplierInvoiceItemGLAcct",
            A_SupplierInvoiceTax: "to_SupplierInvoiceTax",
            A_SupplierInvoiceTaxType: "to_SupplierInvoiceTax",
            A_SuplrInvcHeaderWhldgTax: "to_SupplierInvoiceWhldgTax",
            A_SuplrInvcHeaderWhldgTaxType: "to_SupplierInvoiceWhldgTax",
            A_SuplrInvcItemAcctAssgmt: "to_SuplrInvcItemAcctAssgmt",
            A_SuplrInvcItemAcctAssgmtType: "to_SuplrInvcItemAcctAssgmt",
            A_SupplierInvoiceItem: "to_SupplierInvoiceItem",
            A_SupplierInvoiceItemType: "to_SupplierInvoiceItem",
            // New Metadata Mappings
            ItemDataSet: "ItemDataSet",
            MaterialDataSet: "MaterialDataSet",
            AccountingDataSet: "AccountingDataSet",
            GlAccountDataSet: "GlAccountDataSet",
            TaxDataSet: "TaxDataSet",
            WithTaxDataSet: "WithTaxDataSet",
            VendorDataSet: "VendorDataSet",
            AddressDataSet: "AddressDataSet",
            AdditionalDataSet: "AdditionalDataSet",
            TMItemDataSet: "TMItemDataSet",
            AssetDataSet: "AssetDataSet",
            SelectPOSet: "SelectPOSet",
            SelectDeliverySet: "SelectDeliverySet",
            ServiceLeanSet: "ServiceLeanSet"
        };

        const getNavProp = (entityName) => {
            if (!entityName) return null;
            const parts = entityName.split(".");
            const cleanName = parts[parts.length - 1];

            if (ENTITY_NAV_MAP.hasOwnProperty(cleanName))
                return ENTITY_NAV_MAP[cleanName];

            console.warn(
                `Entity '${entityName}' (${cleanName}) not in explicit map. Trying heuristic...`
            );
            return null;
        };

        const formatValue = (val, type) => {
            if (val === null || val === undefined || val === "") return null;
            const cleanType = type ? type.replace("Edm.", "") : "";
            if (
                cleanType === "Decimal" ||
                cleanType === "Int32" ||
                cleanType === "Int64" ||
                cleanType === "Double"
            )
                return val.toString();
            if (cleanType === "Boolean") return val === "true" || val === true;
            if (typeof val === "string" && val.match(/^\d{4}-\d{2}-\d{2}$/))
                return val + "T00:00:00";
            if (cleanType === "DateTime" || cleanType === "DateTimeOffset") {
                if (val instanceof Date) return val.toISOString().split(".")[0];
            }
            if (cleanType === "String") {
                if (typeof val === 'object') return JSON.stringify(val);
                return String(val);
            }
            return val;
        };

        const getMappingValue = (sourceKey, itemData, headerData, index = null, preferRaw = false) => {
            let val = null;
            let sourceLog = "UNKNOWN";

            const getFromXml = () => {
                if (isXml && sourceKey && (sourceKey.includes('/') || sourceKey.includes(':')) && (graftedXmlDoc || fullXmlDoc)) {
                    const docToSearch = graftedXmlDoc || fullXmlDoc;
                    let xmlTags = getValueByPathAll(docToSearch, sourceKey);
                    if (sourceKey.includes('ID') || sourceKey.includes('id')) {
                        console.log(`[DEBUG_GET_XML] Searching for ${sourceKey}. Using graftedXmlDoc: ${!!graftedXmlDoc}. Found tags: ${xmlTags.length}`);
                        if (xmlTags.length === 0 && graftedXmlDoc) {
                            console.log(`[DEBUG_GET_XML] graftedXmlDoc root keys: ${Object.keys(graftedXmlDoc).slice(0, 10).join(', ')}`);
                        }
                    }
                    if ((!xmlTags || xmlTags.length === 0) && graftedXmlDoc && fullXmlDoc) {
                        xmlTags = getValueByPathAll(fullXmlDoc, sourceKey);
                        if (sourceKey.includes('ID') || sourceKey.includes('id')) {
                            console.log(`[DEBUG_GET_XML] Fallback to fullXmlDoc for ${sourceKey}. Found tags: ${xmlTags.length}`);
                        }
                    }
                    if (xmlTags && xmlTags.length > 0) {
                        let tag = (index !== null && xmlTags.length > index) ? xmlTags[index] : xmlTags[0];
                        if (tag && typeof tag === 'object') tag = (tag._ !== undefined) ? tag._ : tag;
                        if (Array.isArray(tag)) tag = tag[0];
                        return (tag !== null && tag !== undefined && tag !== "") ? tag : null;
                    }
                }
                return null;
            };

            // If preferRaw is true (initial field value), try XML first to avoid cumulative conversions
            if (preferRaw) {
                val = getFromXml();
                if (val !== null) return val;
            }

            const fType = docFieldTypes[sourceKey];

            const getValueFromObj = (obj, key) => {
                if (!obj || !key) return null;
                if (obj.hasOwnProperty(key)) return obj[key];
                // Handle encoded keys (___ for / and ___dot___ for .) used in UI
                const safeKey = key.replace(/\//g, "___").replace(/\./g, "___dot___");
                if (obj.hasOwnProperty(safeKey)) return obj[safeKey];
                return null;
            };

            if (fType === "header") {
                val = getValueFromObj(headerData, sourceKey);
                if (val !== null) sourceLog = "HEADER";
            } else if (fType) {
                let groupItems = itemsData;
                if (typeof bIsGrouped !== 'undefined' && bIsGrouped && typeof groups !== 'undefined' && groups[fType]) {
                    groupItems = groups[fType];
                }

                if (itemData) {
                    val = getValueFromObj(itemData, sourceKey);
                    if (val !== null) sourceLog = `ITEM_GROUP_${fType}`;
                }

                if ((val === null || val === undefined || val === "") && groupItems && groupItems.length > 0) {
                    for (let i = 0; i < groupItems.length; i++) {
                        const itemVal = getValueFromObj(groupItems[i], sourceKey);
                        if (itemVal !== null && itemVal !== undefined && itemVal !== "") {
                            val = itemVal;
                            sourceLog = `ITEM_GROUP_${fType}_COLLECTION_INDEX_${i}`;
                            break;
                        }
                    }
                }
            }

            // Final Fallback: If still empty, try both item and header as a general search
            // This is crucial for header parameters used in item conversion functions
            if (val === null || val === undefined || val === "") {
                const itemVal = getValueFromObj(itemData, sourceKey);
                if (itemVal !== null && itemVal !== undefined && itemVal !== "") {
                    val = itemVal;
                    sourceLog = "FALLBACK_ITEM";
                } else {
                    const headVal = getValueFromObj(headerData, sourceKey);
                    if (headVal !== null && headVal !== undefined && headVal !== "") {
                        val = headVal;
                        sourceLog = "FALLBACK_HEADER";
                    }
                }
            }

            // If still not found and we haven't tried XML yet, try it now as last resort
            if ((val === null || val === undefined || val === "") && !preferRaw) {
                val = getFromXml();
            }

            if (sourceKey && (sourceKey.toLowerCase().includes("tax") || sourceKey.toLowerCase().includes("vat"))) {
                console.log(`[DIAG_MAPPING] key: ${sourceKey}, source: ${sourceLog}, value: ${val}`);
            }
            return val;
        };

        const executeConversion = async (func, rawValue, params, errorLog = [], extraContext = {}) => {
            if (!func) return rawValue;

            try {
                const fName = extraContext.fieldName || "unknown";
                let defaultParams = func.inputParams
                    ? JSON.parse(func.inputParams || "{}")
                    : {};

                if (Array.isArray(defaultParams)) {
                    defaultParams = {};
                }

                const finalParams = { ...defaultParams, ...params };

                Object.keys(finalParams).forEach(key => {
                    if (typeof finalParams[key] === 'string' && finalParams[key].includes('{value}')) {
                        const rVal = (rawValue !== null && rawValue !== undefined) ? String(rawValue) : "";
                        finalParams[key] = finalParams[key].replace(/{value}/g, rVal);
                    }
                });

                // INTERNAL FUNCTIONS
                const cleanFuncName = (func.name || "").toLowerCase().replace(/[\s_]/g, "");

                if (cleanFuncName === "concatenate") {
                    let result = "";
                    Object.keys(finalParams).forEach(key => {
                        result += String(finalParams[key] || "");
                    });
                    return result;
                }

                if (["multiply", "sum", "add", "subtract", "divide"].includes(cleanFuncName)) {
                    const op = cleanFuncName;

                    // Extract keys like Value1, Value2, sorting by the sequence number to keep order
                    const valueKeys = Object.keys(finalParams)
                        .filter(k => k.toLowerCase().startsWith("value"))
                        .sort((a, b) => {
                            const numA = parseInt(a.toLowerCase().replace("value", "")) || 0;
                            const numB = parseInt(b.toLowerCase().replace("value", "")) || 0;
                            return numA - numB;
                        });

                    let values = [];
                    valueKeys.forEach(k => {
                        const parsed = parseFloat(finalParams[k]);
                        if (!isNaN(parsed)) {
                            values.push(parsed);
                        }
                    });

                    if (values.length === 0) {
                        if (op === "divide") {
                            const num = parseFloat(finalParams["Numerator"] || finalParams["numerator"]);
                            const den = parseFloat(finalParams["Denominator"] || finalParams["denominator"]);
                            if (!isNaN(num) && !isNaN(den)) values = [num, den];
                        } else if (op === "subtract") {
                            const min = parseFloat(finalParams["Minuend"] || finalParams["minuend"]);
                            const sub = parseFloat(finalParams["Subtrahend"] || finalParams["subtrahend"]);
                            if (!isNaN(min) && !isNaN(sub)) values = [min, sub];
                        }
                    }

                    if (values.length === 0) return null;
                    if (values.length === 1) return String(values[0]);

                    let result = values[0];
                    for (let i = 1; i < values.length; i++) {
                        if (op === "multiply") result *= values[i];
                        else if (op === "sum" || op === "add") result += values[i];
                        else if (op === "subtract") result -= values[i];
                        else if (op === "divide") {
                            if (values[i] === 0) return "Error: Division by zero";
                            result /= values[i];
                        }
                    }
                    return String(result);
                }

                if (["uppercase", "lowercase"].includes(cleanFuncName)) {
                    let input = finalParams["Input"] || finalParams["input"] || finalParams["Value"] || finalParams["value"];
                    if (input === undefined || input === null) input = rawValue;
                    const s = String(input || "");
                    return cleanFuncName === "uppercase" ? s.toUpperCase() : s.toLowerCase();
                }

                if (cleanFuncName === "constant") {
                    const keys = Object.keys(finalParams);
                    const valKey = keys.find(k => k.toLowerCase() === "value");
                    return valKey ? finalParams[valKey] : "";
                }

                if (cleanFuncName === "conditions") {
                    // 1. Recupera il campo/valore di input da valutare (es. la descrizione)
                    const rawInputParam = finalParams["Input"] || finalParams["input"] || rawValue;
                    const conditionsJson = finalParams["Conditions"] || finalParams["conditions"];
                    const defaultValue = finalParams["DefaultValue"] || finalParams["defaultValue"] || "";

                    // Funzione di supporto per risolvere l'input se è il nome di un campo della riga o del payload
                    const resolveVal = (val) => {
                        const sVal = String(val !== undefined ? val : "").trim();
                        if (extraContext) {
                            if (extraContext.row && typeof extraContext.row === 'object' && sVal in extraContext.row) return extraContext.row[sVal];
                            if (extraContext.lineItem && typeof extraContext.lineItem === 'object' && sVal in extraContext.lineItem) return extraContext.lineItem[sVal];
                            if (extraContext.currentItem && typeof extraContext.currentItem === 'object' && sVal in extraContext.currentItem) return extraContext.currentItem[sVal];
                            if (extraContext.payload && typeof extraContext.payload === 'object' && sVal in extraContext.payload) return extraContext.payload[sVal];
                        }
                        if (typeof payload === 'object' && payload !== null && sVal in payload) return payload[sVal];
                        return sVal;
                    };

                    const sLeft = String(resolveVal(rawInputParam)).trim();

                    try {
                        const condsArray = typeof conditionsJson === 'string' ? JSON.parse(conditionsJson) : conditionsJson;
                        if (!Array.isArray(condsArray)) {
                            return defaultValue;
                        }

                        for (let i = 0; i < condsArray.length; i++) {
                            const rule = condsArray[i];
                            const operator = rule.operator !== undefined ? rule.operator : rule.Operator;
                            const rawRight = rule.conditionRight !== undefined ? rule.conditionRight : rule.ConditionRight;
                            const thenVal = rule.thenValue !== undefined ? rule.thenValue : rule.ThenValue;

                            // Il lato destro può essere un valore letterale o un altro campo di riscontro
                            const sRight = String(resolveVal(rawRight)).trim();

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

                        return defaultValue;
                    } catch (e) {
                        console.error(`[PayloadHandler] Conditions failed to parse JSON:`, e.message);
                        return defaultValue;
                    }
                }

                if (cleanFuncName === "ifthenelse") {
                    const condLeft = finalParams["ConditionLeft"];
                    const operator = finalParams["Operator"];
                    const condRight = finalParams["ConditionRight"];
                    const thenVal = finalParams["ThenValue"];
                    const elseVal = finalParams["ElseValue"];

                    let bResult = false;
                    const sLeft = String(condLeft || "").trim();
                    const sRight = String(condRight || "").trim();

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
                    return bResult ? thenVal : elseVal;
                }

                if (cleanFuncName === "getglaccount") {
                    let input = finalParams["Input"] || finalParams["input"] || finalParams["Value"] || finalParams["value"];
                    if (input === undefined || input === null) input = rawValue;
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

                if (cleanFuncName === "switchcase") {
                    const input = String(finalParams["Input"] || "").trim();
                    const casesJson = finalParams["Cases"];
                    const defaultValue = finalParams["DefaultValue"];

                    try {
                        const casesObj = typeof casesJson === 'string' ? JSON.parse(casesJson) : casesJson;
                        const result = casesObj[input];
                        return result !== undefined ? String(result) : defaultValue;
                    } catch (e) {
                        console.error(`[PayloadHandler] SwitchCase failed to parse Cases JSON for field ${extraContext.fieldName}:`, e.message);
                        return defaultValue;
                    }
                }

                if (cleanFuncName === "generateprogressive") {
                    const len = parseInt(finalParams["Length"] || finalParams["length"] || "5", 10);
                    const idx = extraContext.index !== undefined ? extraContext.index : 0;
                    const counter = idx + 1;
                    return counter.toString().padStart(len, '0');
                }

                if (cleanFuncName === "substring") {
                    const len = parseInt(finalParams["Length"] || finalParams["length"], 10);
                    if (isNaN(len)) return rawValue;

                    let inputStr = finalParams["String"] || finalParams["string"] || finalParams["Value"] || finalParams["value"];
                    if (inputStr === undefined || inputStr === null) inputStr = rawValue;

                    const strVal = String(inputStr || "");
                    return strVal.substring(0, len);
                }

                if (cleanFuncName === "substringregex" || cleanFuncName === "extractbyregex") {
                    const pattern = finalParams["RegexPattern"] || finalParams["regexpattern"] || finalParams["Pattern"] || finalParams["pattern"];
                    if (!pattern) return rawValue;

                    let inputStr = finalParams["String"] || finalParams["string"] || finalParams["Value"] || finalParams["value"];
                    if (inputStr === undefined || inputStr === null) inputStr = rawValue;

                    try {
                        const regex = new RegExp(pattern);
                        const match = String(inputStr || "").match(regex);
                        if (match) {
                            return match.length > 1 ? match[1] : match[0];
                        }
                    } catch (e) {
                        // Invalid regex, silently fallback
                    }
                    return rawValue;
                }

                if (cleanFuncName === "getcreationdate") {
                    let dateVal = docData ? docData.createdAt : null;
                    if (!dateVal) return null;
                    const date = new Date(dateVal);
                    const yyyy = date.getFullYear();
                    const mm = String(date.getMonth() + 1).padStart(2, '0');
                    const dd = String(date.getDate()).padStart(2, '0');
                    return `${yyyy}-${mm}-${dd}`;
                }

                if (cleanFuncName === "getcurrentdate") {
                    const date = new Date();
                    const yyyy = date.getFullYear();
                    const mm = String(date.getMonth() + 1).padStart(2, '0');
                    const dd = String(date.getDate()).padStart(2, '0');
                    return `${yyyy}-${mm}-${dd}`;
                }

                if (cleanFuncName === "rounddecimals") {
                    let input = finalParams["Value"] || finalParams["value"];
                    if (input === undefined || input === null) input = rawValue;
                    const parsed = parseFloat(input);
                    if (isNaN(parsed)) return rawValue;
                    const decimals = parseInt(finalParams["Decimals"] || finalParams["decimals"] || "2", 10);
                    return parsed.toFixed(decimals);
                }

                if (cleanFuncName === "formatdate") {
                    let input = finalParams["Value"] || finalParams["value"];
                    if (input === undefined || input === null) input = rawValue;
                    if (!input) return null;

                    const inputLocale = String(finalParams["InputLocale"] || finalParams["inputLocale"] || "EU").toUpperCase();
                    let date;

                    if (inputLocale === "US") {
                        date = new Date(input);
                    } else {
                        // Fallback per formato Europeo DD/MM/YYYY
                        date = new Date(NaN); // Inizia come invalida
                        const match = String(input).match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
                        if (match) {
                            const d = parseInt(match[1], 10);
                            const m = parseInt(match[2], 10) - 1;
                            const y = parseInt(match[3], 10);
                            date = new Date(y, m, d);
                        }

                        // Se la conversione europea fallisce, usa il fallback americano
                        if (isNaN(date.getTime())) {
                            date = new Date(input);
                        }
                    }

                    if (isNaN(date.getTime())) return rawValue;
                    const format = finalParams["Format"] || finalParams["format"] || "YYYY-MM-DD";
                    const yyyy = date.getFullYear();
                    const MM = String(date.getMonth() + 1).padStart(2, '0');
                    const dd = String(date.getDate()).padStart(2, '0');
                    const HH = String(date.getHours()).padStart(2, '0');
                    const mm = String(date.getMinutes()).padStart(2, '0');
                    const ss = String(date.getSeconds()).padStart(2, '0');
                    return format
                        .replace("YYYY", yyyy)
                        .replace("MM", MM)
                        .replace("DD", dd)
                        .replace("HH", HH)
                        .replace("mm", mm)
                        .replace("ss", ss);
                }

                if (cleanFuncName === "existsgroup") {
                    const groupName = finalParams["GroupName"] || finalParams["groupName"] || finalParams["FieldType"] || finalParams["fieldType"];
                    if (!groupName) return "";

                    const group = (typeof groups !== 'undefined' && groups && groups[groupName]) ? groups[groupName] : [];
                    if (Array.isArray(group) && group.length > 0) return "X";

                    // Fallback for lineItem if groups is empty or if it's a flat structure
                    if ((groupName === 'lineItem' || groupName === 'item') && typeof itemsData !== 'undefined' && Array.isArray(itemsData) && itemsData.length > 0) {
                        return "X";
                    }

                    return "";
                }

                if (!func.serviceUrl) return rawValue;

                let url = func.serviceUrl;
                if (rawValue !== null && rawValue !== undefined) {
                    url = url.replace(/{value}/g, encodeURIComponent(String(rawValue)));
                }
                Object.keys(finalParams).forEach(key => {
                    let val = finalParams[key];
                    if (val && typeof val === 'object') val = val.value || JSON.stringify(val);
                    const placeholder = `{${key}}`;
                    if (url.includes(placeholder)) {
                        url = url.split(placeholder).join(encodeURIComponent(String(val)));
                    }
                });

                const method = func.method || "POST";
                let data = null;
                if (method === "POST" || method === "PUT") {
                    data = { value: rawValue, parameters: finalParams };
                }

                const headers = { "Accept": "application/json", "Content-Type": "application/json" };
                let response;

                if (func.destination) {
                    const jwt = req.headers && req.headers.authorization
                        ? req.headers.authorization.split(' ')[1]
                        : undefined;

                    // Fallback for Automatic Job (no JWT)
                    let currentDest = func.destination;
                    if (!jwt && currentDest === "SAP-1C") {
                        currentDest = "SAP-1C-BasicAuth";
                    }

                    response = await executeHttpRequest(
                        { destinationName: currentDest, jwt: jwt },
                        { method: method, url: url, data: data, headers: headers, timeout: 600000 },
                    );
                } else {
                    response = await axios({ method: method, url: url, data: data, headers: headers, timeout: 600000 });
                }

                const resData = response.data || response;
                const payloadData = resData.d || resData.value || resData;

                if (payloadData && (Array.isArray(payloadData.results) || Array.isArray(payloadData))) {
                    const list = payloadData.results || payloadData;
                    if (list.length > 0) {
                        const item = list[0];
                        if (func.outputField && item.hasOwnProperty(func.outputField)) return item[func.outputField];
                        return item;
                    }
                    return null;
                }

                if (payloadData && typeof payloadData === 'object') {
                    if (func.outputField && payloadData.hasOwnProperty(func.outputField)) return payloadData[func.outputField];
                    if (payloadData.hasOwnProperty('value')) return payloadData.value;
                    return JSON.stringify(payloadData);
                }

                return payloadData;

            } catch (err) {
                console.error(
                    `[DEBUG_CONV] Conversion function ${func.name} failed:`,
                    err.message,
                );
                let msg = err.message;
                if (err.response && err.response.data && err.response.data.error) {
                    msg = JSON.stringify(err.response.data.error);
                }
                if (errorLog && Array.isArray(errorLog)) errorLog.push(msg);
                return null;
            }
        };

        const executeSteps = async (mapping, initialValue, itemContext = null, errorLog = [], extraContext = {}) => {
            const bSkipConversions = req.data.skipConversions === true || req.data.SkipConversions === true || req.data.skipConversions === 'true' || req.data.SkipConversions === 'true';

            let currentValue = initialValue;
            const stepResults = [];

            const fieldName = (mapping.documentAIField && mapping.documentAIField.fieldName) || "unknown";

            if (mapping.steps && mapping.steps.length > 0) {
                const sortedSteps = mapping.steps.sort((a, b) => a.stepOrder - b.stepOrder);
                for (let i = 0; i < sortedSteps.length; i++) {
                    const step = sortedSteps[i];
                    const funcName = step.conversionFunction ? (step.conversionFunction.name || "None") : "None";

                    if (step.conversionFunction) {
                        const cleanFuncName = funcName.toLowerCase().replace(/[\s_]/g, "");

                        if (bSkipConversions) {
                            stepResults[i] = currentValue;
                            continue;
                        }

                        const stepParams = step.functionParameters ? JSON.parse(step.functionParameters) : {};
                        const resolvedParams = {};

                        Object.keys(stepParams).forEach(key => {
                            let paramConfig = stepParams[key];
                            let isDynamic = false;
                            let paramValue = paramConfig;
                            let paramType = "STATIC";

                            if (paramConfig && typeof paramConfig === 'object') {
                                paramType = paramConfig.type || "STATIC";
                                paramValue = paramConfig.value;

                                if (paramType === 'FIELD') {
                                    isDynamic = true;
                                } else if (paramType === 'STEP_OUTPUT') {
                                    const stepIdx = parseInt(paramValue, 10);
                                    if (!isNaN(stepIdx) && stepIdx >= 0 && stepIdx < i) {
                                        resolvedParams[key] = stepResults[stepIdx];
                                        return;
                                    } else {
                                        resolvedParams[key] = "";
                                        return;
                                    }
                                }
                            }

                            if (isDynamic) {
                                const isXmlPath = paramValue && (paramValue.includes('/') || paramValue.includes(':'));
                                const extractedVal = getMappingValue(paramValue, itemContext, headerData, extraContext.index, isXmlPath);
                                if (extractedVal !== null && extractedVal !== undefined) {
                                    resolvedParams[key] = extractedVal;
                                } else {
                                    resolvedParams[key] = "";
                                }
                            } else if (paramType === 'TAG_PROPERTY') {
                                let attrVal = null;
                                const sourceFieldNameRaw = mapping.documentAIField ? mapping.documentAIField.fieldName : null;
                                let sourceFieldName = sourceFieldNameRaw ? sourceFieldNameRaw.trim() : null;
                                let attrKey = paramValue ? paramValue.trim() : "";

                                // Support explicit path in TAG_PROPERTY using @ separator (e.g., path/to/tag@attributeName)
                                if (attrKey.includes('@')) {
                                    const parts = attrKey.split('@');
                                    sourceFieldName = parts[0].trim();
                                    attrKey = parts[1].trim();
                                }

                                console.log(`[DEBUG_ATTR] TYPE: TAG_PROPERTY, Field: ${sourceFieldName}, paramValue: ${attrKey}, index: ${extraContext.index}`);
                                if (sourceFieldName) {
                                    if (isXml && (fullXmlDoc || graftedXmlDoc)) {
                                        let docToSearch = graftedXmlDoc || fullXmlDoc;

                                        // Try direct extraction first
                                        let tags = getValueByPathAll(docToSearch, sourceFieldName);
                                        console.log(`[DEBUG_ATTR] Tags found in docToSearch: ${tags.length}`);

                                        if ((!tags || tags.length === 0) && graftedXmlDoc && fullXmlDoc) {
                                            console.log(`[DEBUG_ATTR] Falling back to fullXmlDoc search...`);
                                            tags = getValueByPathAll(fullXmlDoc, sourceFieldName);
                                            console.log(`[DEBUG_ATTR] Tags found in fullXmlDoc: ${tags ? tags.length : 0}`);
                                        }

                                        if (tags && tags.length > 0) {
                                            let targetTag = tags[0];
                                            if (extraContext.index !== undefined && tags.length > extraContext.index) {
                                                targetTag = tags[extraContext.index];
                                            }

                                            // Extra protection: ensure we have the object and not a wrapper array
                                            if (Array.isArray(targetTag)) targetTag = targetTag[0];

                                            console.log(`[DEBUG_ATTR] Target tag structure: ${JSON.stringify(targetTag)}`);

                                            if (targetTag && targetTag.$ && targetTag.$[attrKey] !== undefined) {
                                                attrVal = targetTag.$[attrKey];
                                                // xml2js with explicitArray: true might wrap attributes in arrays [ "value" ]
                                                if (Array.isArray(attrVal)) attrVal = attrVal[0];
                                                console.log(`[DEBUG_ATTR] Success! Extracted ${attrKey} = ${attrVal}`);
                                            } else if (targetTag && targetTag.$) {
                                                // Fallback: case-insensitive search for the attribute key
                                                const actualKey = Object.keys(targetTag.$).find(k => k.toLowerCase() === attrKey.toLowerCase());
                                                if (actualKey) {
                                                    attrVal = targetTag.$[actualKey];
                                                    if (Array.isArray(attrVal)) attrVal = attrVal[0];
                                                    console.log(`[DEBUG_ATTR] Success (Case-Insensitive)! Extracted ${actualKey} = ${attrVal}`);
                                                } else {
                                                    console.log(`[DEBUG_ATTR] Key '${attrKey}' NOT FOUND in attributes. Available: ${Object.keys(targetTag.$).join(', ')}`);
                                                }
                                            } else {
                                                console.log(`[DEBUG_ATTR] No attributes ($) found in tag. Keys: ${Object.keys(targetTag).join(', ')}`);
                                            }
                                        } else {
                                            console.log(`[DEBUG_ATTR] No tags found for path ${sourceFieldName}`);
                                        }
                                    }

                                    // Fallback to old behavior if xml parsing failed or not found
                                    if (attrVal === null || attrVal === undefined) {
                                        const getAttrNode = (attributesObj) => {
                                            if (!attributesObj) return null;
                                            return attributesObj[sourceFieldName] || null;
                                        };

                                        if (extraContext.index !== undefined && extraContext.itemAttributes && extraContext.itemAttributes[extraContext.index]) {
                                            const itemAttrNode = getAttrNode(extraContext.itemAttributes[extraContext.index]);
                                            if (itemAttrNode) {
                                                attrVal = itemAttrNode[attrKey];
                                            }
                                        }
                                        if (attrVal === null || attrVal === undefined) {
                                            if (extraContext.headerAttributes) {
                                                const headerAttrNode = getAttrNode(extraContext.headerAttributes);
                                                if (headerAttrNode) {
                                                    attrVal = headerAttrNode[attrKey];
                                                }
                                            }
                                        }
                                    }
                                }
                                resolvedParams[key] = (attrVal !== null && attrVal !== undefined) ? attrVal : "";
                            } else {
                                resolvedParams[key] = paramValue;
                            }
                        });


                        const preErrorCount = errorLog.length;
                        const prevValue = currentValue;

                        currentValue = await executeConversion(step.conversionFunction, currentValue, resolvedParams, errorLog, extraContext);

                        if (errorLog.length > preErrorCount) {
                            console.warn(`[DEBUG_STEPS] Step ${funcName} failed. Aborting chain.`);
                            return null;
                        }
                    }
                    // Always save to stepResults to maintain index mapping with configuration positional order
                    stepResults[i] = currentValue;
                }
            }
            return currentValue;
        };

        const conversionMeta = { header: {}, items: [] };
        const mappedValues = { header: {}, items: [] };

        // --- PROCESSING HEADER ---

        const itemLevelMappings = processMappings.filter((m) => {
            if (!m.odataField) return false;
            const t = m.odataField.fieldType || "header";
            const sourceFieldType = (m.documentAIField && m.documentAIField.fieldType) || "header";

            const nav = getNavProp(m.odataField.entityName);

            // Define scenario-specific item structures
            const mmItemNavs = ["ItemDataSet", "SelectPOSet", "TMItemDataSet", "AssetDataSet", "ServiceLeanSet", "to_SupplierInvoiceItem", "MaterialDataSet"];
            const fiItemNavs = ["GlAccountDataSet", "AccountingDataSet"];
            const commonItemNavs = ["TaxDataSet", "WithTaxDataSet", "to_SupplierInvoiceTax", "to_SupplierInvoiceWhldgTax"];

            const isMMNav = mmItemNavs.includes(nav);
            const isFINav = fiItemNavs.includes(nav);
            const isCommonNav = commonItemNavs.includes(nav);

            // STRICT SCENARIO FILTER: If we are in MM, skip FI-only navigations, and vice versa.
            if (scenario === 'MM' && isFINav) return false;
            if (scenario === 'FI' && isMMNav) return false;

            // INCLUDE if:
            // 1. Target is explicitly 'item' or 'lineItem'
            // 2. OR NavProp is a known item/collection set for the CURRENT scenario (or common)
            // 3. OR Source is an 'item' (regardless of target level) - this handles item fields mapped to global structures
            let isItem = t === "item" || t === "lineItem" || sourceFieldType === "item" || sourceFieldType === "lineItem" ||
                isMMNav || isFINav || isCommonNav;

            if (isItem) return true;

            // Dynamic fallback for repeating XML tables mapped to conventional Header Nodes
            if (isCommonNav || nav === "VendorDataSet" || nav === "AddressDataSet" || nav === "AdditionalDataSet") {

                const sourceKey = m.documentAIField.fieldName;
                if (bIsGrouped) {
                    const srcFieldType = (m.documentAIField && m.documentAIField.fieldType) || "";
                    if (srcFieldType && groups[srcFieldType]) return true;
                }
                if (Array.isArray(itemsData) && itemsData.some(item => item && item.hasOwnProperty(sourceKey))) {
                    return true; // XML Repeating Group detected
                }
            }

            return false;
        });

        // Helper: process a batch of items against a set of mappings
        const processItemBatch = async (aItems, aMappings, iIndexOffset, groupName = null) => {
            const batchNavs = new Set();
            aMappings.forEach(m => {
                const nav = getNavProp(m.odataField.entityName);
                if (nav) batchNavs.add(nav);
            });

            for (let idx = 0; idx < aItems.length; idx++) {
                const item = aItems[idx];
                const itemPayloadsByNav = {};
                const itemMeta = {};

                for (const m of aMappings) {
                    const sourceKey = m.documentAIField.fieldName;
                    const targetField = m.odataField ? m.odataField.fieldName : null;
                    const targetType = m.odataField ? m.odataField.dataType : null;
                    const targetEntity = m.odataField ? m.odataField.entityName : null;
                    const navProp = getNavProp(targetEntity);

                    if (navProp) {
                        let rawVal = getMappingValue(sourceKey, item, headerData, idx + iIndexOffset, false);
                        const originalVal = rawVal;
                        const itemErrors = [];
                        rawVal = await executeSteps(m, rawVal, item, itemErrors, { index: idx + iIndexOffset, headerAttributes, itemAttributes, fieldName: sourceKey });

                        const hasConversion = m.steps && m.steps.some(s => s.conversionFunction && s.conversionFunction.name);
                        if (hasConversion) {
                            const funcNames = m.steps.filter(s => s.conversionFunction && s.conversionFunction.name).map(s => s.conversionFunction.name).join(", ");
                            itemMeta[sourceKey] = {
                                original: originalVal, converted: rawVal, functionName: funcNames, error: itemErrors.length > 0 ? itemErrors.join("; ") : null
                            };
                        }

                        if (!targetField) continue;

                        if (rawVal !== null && rawVal !== undefined) {
                            const val = formatValue(rawVal, targetType);
                            if (val !== null) {
                                const isGlobalStructure = [
                                    "VendorDataSet", "AddressDataSet", "AdditionalDataSet"
                                ].includes(navProp);

                                if (isGlobalStructure) {
                                    if (!payload[navProp]) payload[navProp] = [];
                                    if (!Number.isNaN(parseInt(m.groupId)) && m.groupId > 0) {
                                        const groupKey = `${navProp}_${m.groupId}`;
                                        let targetIdx = groupIndexMap[groupKey];
                                        if (targetIdx === undefined) {
                                            payload[navProp].push({});
                                            targetIdx = payload[navProp].length - 1;
                                            groupIndexMap[groupKey] = targetIdx;
                                        }
                                        payload[navProp][targetIdx][targetField] = val;
                                    } else {
                                        let targetObj = null;
                                        for (let i = 0; i < payload[navProp].length; i++) {
                                            if (payload[navProp][i][targetField] === val) { targetObj = payload[navProp][i]; break; }
                                            if (payload[navProp][i][targetField] === undefined) { targetObj = payload[navProp][i]; break; }
                                        }
                                        if (!targetObj) {
                                            targetObj = {};
                                            payload[navProp].push(targetObj);
                                        }
                                        targetObj[targetField] = val;
                                    }
                                } else {
                                    if (!itemPayloadsByNav[navProp]) itemPayloadsByNav[navProp] = [];
                                    let targetIdx = 0;
                                    if (!Number.isNaN(parseInt(m.groupId)) && m.groupId > 0) {
                                        targetIdx = parseInt(m.groupId) - 1;
                                    }
                                    while (itemPayloadsByNav[navProp].length <= targetIdx) {
                                        itemPayloadsByNav[navProp].push({});
                                    }
                                    itemPayloadsByNav[navProp][targetIdx][targetField] = val;
                                }
                            }
                        }
                    }
                }

                if (groupName) {
                    if (!conversionMeta.items[groupName]) conversionMeta.items[groupName] = [];
                    conversionMeta.items[groupName].push(itemMeta);
                } else {
                    if (!Array.isArray(conversionMeta.items)) conversionMeta.items = [];
                    conversionMeta.items.push(itemMeta);
                }

                batchNavs.forEach(nav => {
                    const isGlobalStructure = [
                        "VendorDataSet", "AddressDataSet", "AdditionalDataSet"
                    ].includes(nav);

                    if (isGlobalStructure) return;

                    if (!payload[nav]) payload[nav] = [];
                    const itemsToPush = itemPayloadsByNav[nav];
                    if (itemsToPush && itemsToPush.length > 0) {
                        payload[nav].push(...itemsToPush);
                    } else if (groupName) {
                        // In grouped mode (XML), only push placeholders if this nav belongs to the group
                        const isThisGroupNav = nav.includes(groupName) || (groupName === 'lineItem' && (nav === 'ItemDataSet' || nav === 'to_SupplierInvoiceItem'));
                        if (isThisGroupNav) payload[nav].push({});
                    } else {
                        // In flat mode (PDF), only push for the main item dataset to avoid phantom sibling records
                        if (nav === 'ItemDataSet' || nav === 'to_SupplierInvoiceItem') {
                            payload[nav].push({});
                        }
                    }
                });
            }
        };

        if (bIsGrouped) {
            console.log(`[DEBUG_PAYLOAD] Processing XML groups independently: ${Object.keys(groups).join(', ')}`);
            conversionMeta.items = {}; // Switch to object for grouped XML
            for (const [fieldType, groupItems] of Object.entries(groups)) {
                const groupMappings = processMappings.filter(m => {
                    const srcType = (m.documentAIField && m.documentAIField.fieldType) || "header";
                    const targetEntity = m.odataField ? m.odataField.entityName : null;
                    const nav = getNavProp(targetEntity);

                    // Map UI group types to SAP navigation properties
                    const groupToNav = {
                        "lineItem": ["ItemDataSet", "to_SupplierInvoiceItem"],
                        "withholdingTax": ["WithTaxDataSet", "to_SupplierInvoiceWhldgTax"],
                        "tax": ["TaxDataSet", "to_SupplierInvoiceTax"]
                    };
                    const isTargetingThisGroup = (groupToNav[fieldType] && groupToNav[fieldType].includes(nav)) || (nav === fieldType);

                    return srcType === fieldType || (srcType === "header" && isTargetingThisGroup);
                });
                if (groupMappings.length === 0) {
                    console.log(`[DEBUG_PAYLOAD] No item-level mappings for fieldType '${fieldType}'. Skipping.`);
                    continue;
                }
                console.log(`[DEBUG_PAYLOAD] Processing group '${fieldType}': ${groupItems.length} items, ${groupMappings.length} mappings`);
                await processItemBatch(groupItems, groupMappings, 0, fieldType);
            }
        } else if (itemsData.length > 0) {
            await processItemBatch(itemsData, itemLevelMappings, 0);
        }

        // --- PROCESSING HEADER ---
        for (const m of processMappings) {
            const sourceKey = m.documentAIField.fieldName;
            const targetField = m.odataField ? m.odataField.fieldName : null;
            const targetType = m.odataField ? m.odataField.dataType : null;
            const targetLevel = m.odataField ? m.odataField.fieldType : "header";
            const targetEntity = m.odataField ? m.odataField.entityName : null;

            if (targetLevel === "header") {
                const navProp = getNavProp(targetEntity);
                const isItemNav =
                    navProp === "ItemDataSet" ||
                    navProp === "SelectPOSet" ||
                    navProp === "TMItemDataSet" ||
                    navProp === "AssetDataSet" ||
                    navProp === "ServiceLeanSet" ||
                    navProp === "GlAccountDataSet" ||
                    navProp === "MaterialDataSet" ||
                    navProp === "AccountingDataSet" ||
                    navProp === "TaxDataSet" ||
                    navProp === "WithTaxDataSet" ||
                    navProp === "to_SupplierInvoiceTax" ||
                    navProp === "to_SupplierInvoiceWhldgTax" ||
                    navProp === "to_SupplierInvoiceItem";

                if (true) {
                    let rawVal = getMappingValue(sourceKey, null, headerData, null, false);
                    const originalVal = rawVal;
                    const headerErrors = [];
                    rawVal = await executeSteps(m, rawVal, null, headerErrors, { headerAttributes, itemAttributes });

                    const hasConversion = m.steps && m.steps.some(s => s.conversionFunction && s.conversionFunction.name);
                    if (hasConversion) {
                        const funcNames = m.steps.filter(s => s.conversionFunction && s.conversionFunction.name).map(s => s.conversionFunction.name).join(", ");
                        conversionMeta.header[sourceKey] = {
                            original: originalVal, converted: rawVal, functionName: funcNames, error: headerErrors.length > 0 ? headerErrors.join("; ") : null
                        };
                    }

                    if (rawVal !== null) {
                        const val = formatValue(rawVal, targetType);
                        if (val !== null) {
                            mappedValues.header[sourceKey] = val;
                            let finalPath = targetField;

                            if (targetEntity && targetEntity !== "A_SupplierInvoice") {
                                const nav = getNavProp(targetEntity);
                                if (nav) {
                                    const isItemCollection = [
                                        "ItemDataSet", "to_SupplierInvoiceItem", "TaxDataSet", "WithTaxDataSet",
                                        "to_SupplierInvoiceTax", "to_SupplierInvoiceWhldgTax", "GlAccountDataSet"
                                    ].includes(nav);

                                    if (!payload[nav]) {
                                        if (isItemCollection) continue; // Don't create phantom items from header loop
                                        payload[nav] = [];
                                    }
                                    if (!Array.isArray(payload[nav])) payload[nav] = [payload[nav]];

                                    let targetObj = null;
                                    if (!Number.isNaN(parseInt(m.groupId)) && m.groupId > 0) {
                                        const groupKey = `${nav}_${m.groupId}`;
                                        let targetIdx = groupIndexMap[groupKey];
                                        if (targetIdx === undefined) {
                                            if (isItemCollection) continue;
                                            payload[nav].push({});
                                            targetIdx = payload[nav].length - 1;
                                            groupIndexMap[groupKey] = targetIdx;
                                        }
                                        payload[nav][targetIdx][targetField] = val;
                                    } else {

                                        // Legacy "First Empty Slot" Logic
                                        let targetObj = null;
                                        for (let i = 0; i < payload[nav].length; i++) {
                                            if (payload[nav][i][targetField] === val) { targetObj = payload[nav][i]; break; }
                                            if (payload[nav][i][targetField] === undefined || payload[nav][i][targetField] === "") { targetObj = payload[nav][i]; break; }
                                        }
                                        if (!targetObj) {
                                            if (isItemCollection) continue;
                                            targetObj = {};
                                            payload[nav].push(targetObj);
                                        }
                                        targetObj[targetField] = val;
                                    }

                                    continue;
                                }
                            }
                            setDeepValue(payload, finalPath, val);
                        }
                    }
                }
            }
        }

        // --- TAX DATASET SANITIZATION ---
        const itemNavs = [
            "ItemDataSet", "to_SupplierInvoiceItem", "SelectPOSet", "TMItemDataSet",
            "AssetDataSet", "ServiceLeanSet", "GlAccountDataSet", "MaterialDataSet", "AccountingDataSet"
        ];
        const taxNavs = ["TaxDataSet", "to_SupplierInvoiceTax"];

        const usedTaxCodes = new Set();
        itemNavs.forEach(nav => {
            if (Array.isArray(payload[nav])) {
                payload[nav].forEach(item => {
                    if (item.TaxCode) usedTaxCodes.add(item.TaxCode);
                    if (item.Tax_Code) usedTaxCodes.add(item.Tax_Code);
                });
            }
        });

        taxNavs.forEach(nav => {
            if (Array.isArray(payload[nav])) {
                const originalCount = payload[nav].length;
                payload[nav] = payload[nav].filter(taxEntry => {
                    const tCode = taxEntry.TaxCode;
                    // Only keep the tax record if its TaxCode is referenced in at least one item
                    return !tCode || usedTaxCodes.has(tCode);
                });
                if (payload[nav].length !== originalCount) {
                    console.log(`[DEBUG_PAYLOAD] Sanitized ${nav}: removed ${originalCount - payload[nav].length} unused tax entries.`);
                }
            }
        });

        payload.__metadata = {
            scenario: scenario
        };
        if (req.data.Simulation === true || req.data.Simulation === 'true') {
            payload.Simulation = true;
            payload.__metadata.conversions = conversionMeta;
            payload.__metadata.mappedValues = mappedValues;
        }

        // 2.2 Finalize Payload and Prune Empty Items
        Object.keys(payload).forEach(nav => {
            if (Array.isArray(payload[nav])) {
                payload[nav] = payload[nav].filter(obj => !isEmptyObject(obj));
                if (payload[nav].length === 0) delete payload[nav];
            }
        });

        console.log("Generated SAP Payload:", JSON.stringify(payload, null, 2));
        return JSON.stringify(payload);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("Error generating payload:", errMsg);
        if (error instanceof Error && error.stack) console.error(error.stack);
        return req.error(500, `Payload Generation Failed: ${errMsg}`);
    }
};

const registerInvoice = async (req, entities) => {
    console.log("registerInvoice - executing SAP POST logic");

    const { DocumentStatusBtp } = entities;
    const existingDoc = await SELECT.one.from(DocumentStatusBtp)
        .where({ id: req.data.id })
        .columns('registrationStatus');
    if (existingDoc && existingDoc.registrationStatus === 'Registered') {
        return req.error(400, 'INVOICE_ALREADY_POSTED');
    }

    let payloadJson;
    try {
        payloadJson = await generateInvoicePayload(req, entities);

        // If generateInvoicePayload used req.error, it might return the req object or similar
        if (typeof payloadJson !== 'string') {
            const errorMsg = (payloadJson && payloadJson.message) ? payloadJson.message : "Payload generation failed without specific message";
            console.error("generateInvoicePayload did not return a string:", errorMsg);
            return req.error(500, `Internal Error: ${errorMsg}`);
        }
    } catch (err) {
        console.error("Critical error in generateInvoicePayload:", err.message);
        return req.error(500, `Payload Generation Failed: ${err.message}`);
    }

    let payload;
    try {
        payload = JSON.parse(payloadJson);
    } catch (e) {
        console.error("Payload parse error. Content start:", String(payloadJson).substring(0, 100));
        console.error(e);
        return req.error(500, "Internal Error: Generated payload is invalid JSON");
    }

    const jwt = req.headers && req.headers.authorization
        ? req.headers.authorization.split(' ')[1]
        : undefined;

    let scenario = payload.__metadata ? payload.__metadata.scenario : 'MM';

    // Seleziona la destinazione (Se manca il JWT assumo sia il job automatico)
    const isAutomatic = !jwt;
    const sapDestination = isAutomatic ? "SAP-1C-BasicAuth" : "SAP-1C";

    console.log(`Sending payload to ${sapDestination}... JWT present: ${!!jwt}`);

    if (payload.__metadata) delete payload.__metadata;
    if (payload.Simulation !== true) {
        payload.Simulation = false;
    }

    console.log("Cleaned Payload for SAP HeaderDataSet:", JSON.stringify(payload, null, 2));

    try {
        const serviceUrl = "/sap/opu/odata/sap/ZFIN_APINVOICE_SRV/HeaderDataSet";

        const response = await executeHttpRequest(
            { destinationName: sapDestination, jwt: jwt },
            {
                method: "POST",
                url: serviceUrl,
                data: payload,
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                }
            }
        );

        console.log("SAP POST Success. Status:", response.status);

        // Implementing Attachment Creation
        if (!req.data.Simulation) {
            try {
                const { DocumentStatusBtp } = entities;
                const docData = await SELECT.one.from(DocumentStatusBtp).where({ id: req.data.id });

                if (docData && docData.content) {
                    let linkedSAPObjectKey = "";
                    let businessObjectTypeName = "";
                    const sapData = response.data.d || response.data;

                    //if (scenario === 'MM') {
                    businessObjectTypeName = "BUS2081";
                    const supplierInvoice = sapData.SupplierInvoice || sapData.RefDocNo || "";
                    const invYear = sapData.InvYear || sapData.FiscalYear || new Date().getFullYear().toString();
                    linkedSAPObjectKey = `${supplierInvoice}${invYear}`;
                    //} else {
                    //    businessObjectTypeName = "BKPF";
                    //    const companyCode = docData.companyCode || "";
                    //   const accountingDoc = sapData.AccountingDocument || sapData.InternalID || sapData.SupplierInvoice || sapData.RefDocNo ||"";
                    //    const fiscalYear = sapData.FiscalYear || sapData.InvYear || new Date().getFullYear().toString();
                    //    linkedSAPObjectKey = `${accountingDoc}${fiscalYear}`;
                    //}

                    const fileName = (docData.fileName || "invoice.pdf").substring(0, 255);
                    const slug = fileName;
                    //const semanticObject = scenario === 'MM' ? 'SupplierInvoice' : '';
                    const semanticObject = 'SupplierInvoice';
                    console.log(`[PayloadHandler] Preparing attachment: Slug='${slug}', BusinessObjectTypeName='${businessObjectTypeName}', LinkedSAPObjectKey='${linkedSAPObjectKey}', SemanticObject='${semanticObject}'`);

                    const base64Data = docData.content.includes(',') ? docData.content.split(',').pop() : docData.content;
                    const binaryContent = Buffer.from(base64Data, 'base64');

                    const isXmlDocument = docData.documentType === 'XML' || docData.fileName.toLowerCase().endsWith('.xml');
                    const sContentType = isXmlDocument ? "text/xml" : "application/pdf";

                    const SAP_DOCUMENT_COMMIT_DELAY_MS = 5000;
                    await delay(SAP_DOCUMENT_COMMIT_DELAY_MS);

                    console.log(`[PayloadHandler] Uploading primary attachment... Content-Type: ${sContentType}`);
                    const attachmentResponse = await executeHttpRequest(
                        { destinationName: sapDestination, jwt: jwt },
                        {
                            method: "POST",
                            url: "/sap/opu/odata/sap/API_CV_ATTACHMENT_SRV/AttachmentContentSet",
                            data: binaryContent,
                            headers: {
                                "Slug": slug,
                                "BusinessObjectTypeName": businessObjectTypeName,
                                "LinkedSAPObjectKey": linkedSAPObjectKey,
                                "SemanticObject": semanticObject,
                                "Content-Type": sContentType,
                                "Accept": "application/json"
                            }
                        }
                    );

                    console.log(`[PayloadHandler] Primary Attachment Upload Success. Status:`, attachmentResponse.status);

                    // If a secondary PDF content exists (from ZIP upload), send it too
                    if (docData.pdfContent) {
                        try {
                            const pdfBase64 = docData.pdfContent.includes(',') ? docData.pdfContent.split(',').pop() : docData.pdfContent;
                            const pdfBinary = Buffer.from(pdfBase64, 'base64');

                            let pdfSlug = slug;
                            if (pdfSlug.toLowerCase().endsWith('.xml')) {
                                pdfSlug = pdfSlug.substring(0, pdfSlug.length - 4) + ".pdf";
                            } else if (!pdfSlug.toLowerCase().endsWith('.pdf')) {
                                pdfSlug += ".pdf";
                            }

                            console.log(`[PayloadHandler] Uploading secondary PDF attachment... Slug: ${pdfSlug}`);
                            await delay(SAP_DOCUMENT_COMMIT_DELAY_MS);

                            const pdfResponse = await executeHttpRequest(
                                { destinationName: sapDestination, jwt: jwt },
                                {
                                    method: "POST",
                                    url: "/sap/opu/odata/sap/API_CV_ATTACHMENT_SRV/AttachmentContentSet",
                                    data: pdfBinary,
                                    headers: {
                                        "Slug": pdfSlug,
                                        "BusinessObjectTypeName": businessObjectTypeName,
                                        "LinkedSAPObjectKey": linkedSAPObjectKey,
                                        "SemanticObject": semanticObject,
                                        "Content-Type": "application/pdf",
                                        "Accept": "application/json"
                                    }
                                }
                            );
                            console.log(`[PayloadHandler] Secondary Attachment Upload Success. Status:`, pdfResponse.status);
                        } catch (pdfAttachError) {
                            console.error(`[PayloadHandler] Failed to upload secondary PDF attachment for Job ID: ${req.data.id}`, pdfAttachError.message);
                        }
                    }

                    // Clear content from DB to save space - ONLY if registration & attachment successful
                    await UPDATE(DocumentStatusBtp).set({ content: null, pdfContent: null }).where({ id: req.data.id });
                    console.log(`[PayloadHandler] Cleared content(s) for Job ID: ${req.data.id}`);
                } else {
                    console.warn(`[PayloadHandler] No base64 content found for Job ID: ${req.data.id}. Skipping attachment upload.`);
                }
            } catch (attachError) {
                console.error(`[PayloadHandler] Failed to upload attachment for Job ID: ${req.data.id}`, attachError.message);
                if (attachError.response && attachError.response.data) {
                    console.error("SAP Attachment Error Data:", JSON.stringify(attachError.response.data));
                }
                // Do not throw error here, so the invoice registration itself still succeeds
            }
        }

        return JSON.stringify(response.data);

    } catch (error) {
        console.error("SAP POST Error:", error.message);

        let errorMsg = error.message;
        let sapDetails = null;

        if (error.response && error.response.data) {
            const sapData = error.response.data;
            console.error("SAP Error Data:", JSON.stringify(sapData));

            if (sapData.error && sapData.error.message && sapData.error.message.value) {
                errorMsg = sapData.error.message.value;
            } else if (sapData.error && sapData.error.message) {
                errorMsg = typeof sapData.error.message === 'string' ? sapData.error.message : JSON.stringify(sapData.error.message);
            }

            if (sapData.error && sapData.error.innererror && sapData.error.innererror.errordetails) {
                sapDetails = sapData.error.innererror.errordetails;
            } else if (sapData.error) {
                sapDetails = [sapData.error];
            }
        }

        const errorObj = {
            message: errorMsg,
            details: sapDetails
        };

        return req.error(400, `SAP_ERROR_JSON:${JSON.stringify(errorObj)}`);
    }
};

const simulateMapping = async (req, entities) => {
    console.log("simulateMapping - delegating to generateInvoicePayload");
    req.data.Simulation = true;
    return generateInvoicePayload(req, entities);
};

module.exports = {
    generateInvoicePayload,
    registerInvoice,
    simulateMapping
};
