const { v4: uuidv4 } = require('uuid');
const { parseStringPromise } = require('xml2js');

/**
 * Robustly get values from a nested object using a path string (e.g., "Invoice.Header.ID")
 * Supports xml2js array wrapping.
 */
const getValueByPath = (obj, path, verbose = false) => {
    if (!obj || !path) return undefined;
    const parts = path.split(/\/|\./);
    let current = obj;

    for (let i = 0; i < parts.length; i++) {
        let part = parts[i].toLowerCase().trim();

        // Strip namespace from the path part (e.g. 'cac:Party' -> 'Party')
        if (part.includes(':')) {
            part = part.split(':').pop();
        }

        if (!current || typeof current !== 'object') {
            if (verbose) console.log(`[getValueByPath] Path '${path}' failed at part '${parts[i]}': current node is undefined or not an object.`);
            return undefined;
        }

        // xml2js usually wraps everything in an array
        if (Array.isArray(current)) {
            current = current[0];
        }

        if (current && typeof current === 'object') {
            // Case-insensitive and namespace-agnostic search
            const keys = Object.keys(current);
            const foundKey = keys.find(k => {
                const cleanKey = k.includes(':') ? k.split(':').pop() : k;
                return cleanKey.toLowerCase() === part;
            });

            if (foundKey) {
                current = current[foundKey];
            } else {
                // Special check for root node issue (explicitRoot: false)
                if ((i === 0 || (i === 1 && parts[0].toLowerCase().trim() === parts[1].toLowerCase().trim())) && i < parts.length - 1) {
                    if (verbose) console.log(`[getValueByPath] Path '${path}' - skipping missing root array part '${parts[i]}'`);
                    continue;
                } else {
                    if (verbose) console.log(`[getValueByPath] Path '${path}' failed at part '${parts[i]}'. Available keys in current node: ${keys.join(', ')}`);
                    return undefined;
                }
            }
        } else {
            if (verbose) console.log(`[getValueByPath] Path '${path}' failed at part '${parts[i]}': current node is no longer an object.`);
            return undefined;
        }
    }

    if (verbose) console.log(`[getValueByPath] Successfully resolved path '${path}'`);
    return current;
};

/**
 * Standardizes values extracted from xml2js objects.
 */
const flattenXmlValue = (val) => {
    if (val === null || val === undefined) return null;
    if (Array.isArray(val)) {
        if (val.length === 0) return null;
        const first = val[0];
        if (typeof first === 'object' && first !== null) {
            return first._ !== undefined ? first._ : (Object.keys(first).length === 0 ? "" : JSON.stringify(first));
        }
        return String(first ?? '');
    }
    if (typeof val === 'object') {
        return val._ !== undefined ? val._ : JSON.stringify(val);
    }
    return String(val);
};

/**
 * Main handler for XML Invoice Extraction
 */
const XmlHandler = async (req, entities) => {
    console.log("[XmlHandler] Starting processing:");
    const { DocumentStatusBtp, FieldMappings, Countries, CountryFieldConfig, DocumentAIFields } = entities;
    let graftedDoc = null;
    const { file, fileName, companyCode, countryCode } = req.data;

    let xmlContent = file;
    if (Buffer.isBuffer(file)) {
        xmlContent = file.toString('utf8');
    } else if (typeof file === 'string') {
        try {
            // Try base64 decode if it looks like it
            if (!file.trim().startsWith('<')) {
                xmlContent = Buffer.from(file, 'base64').toString('utf8');
            }
        } catch {
            xmlContent = file;
        }
    }

    const jobId = uuidv4();
    const sCountryCodeUpper = (countryCode || "").toUpperCase();

    // Initial Record Creation
    await INSERT.into(DocumentStatusBtp).entries({
        id: jobId,
        fileName,
        documentType: 'XML',
        status: 'RUNNING',
        statusBtp: 'Elaborazione in corso',
        content: typeof file === 'string' ? file : file.toString('base64'),
        companyCode,
        countryCode: sCountryCodeUpper,
        tipoCaricamento: req.data.tipoCaricamento || 'Manual'
    });

    try {
        // --- HELPERS ---
        const getValueByPathAll = (obj, path) => {
            if (!obj || !path) return [];
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

            // Try different entry points (deep search the first part)
            for (let i = 0; i < parts.length; i++) {
                searchDeep(obj, parts, i);
                if (results.length > 0) break;
            }

            return results;
        };

        let xmlDoc = await parseStringPromise(xmlContent, { explicitArray: true, trim: true, explicitRoot: false });

        // --- NEW: Embedded XML Support (Grafting Strategy) ---
        // Fetch country config to check for xmlReferenceTag
        const countryConfig = await SELECT.one.from(Countries).where({ code: sCountryCodeUpper });
        const xmlRefTag = countryConfig ? countryConfig.xmlReferenceTag : null;
        console.log(`[XmlHandler] Country: ${sCountryCodeUpper}, xmlReferenceTag: ${xmlRefTag}`);

        if (xmlRefTag) {
            console.log(`[XmlHandler] Searching for embedded XML in tag: ${xmlRefTag}`);

            // Enhanced helper for deep searching a tag that actually contains XML
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
                        const content = flattenXmlValue(res.node);
                        if (content && typeof content === 'string') {
                            const trimmed = content.trim();
                            if (trimmed.startsWith('<')) return res;
                            if (trimmed.startsWith('PD94bWwg') || trimmed.length > 100) return res;
                        }
                    }
                }

                return results[0] || null;
            };

            let embeddedInfo = findDeepNodeByPath(xmlDoc, xmlRefTag);

            if (embeddedInfo && embeddedInfo.node) {
                const embeddedRaw = embeddedInfo.node;
                let embeddedContent = flattenXmlValue(embeddedRaw);
                console.log(`[XmlHandler] Raw embedded content (first 50 chars): ${String(embeddedContent).substring(0, 50)}...`);

                if (embeddedContent && typeof embeddedContent === 'string') {
                    embeddedContent = embeddedContent.trim();
                    // Try to decode base64 if it doesn't look like XML
                    if (!embeddedContent.startsWith('<')) {
                        console.log("[XmlHandler] Content does not start with '<', attempting Base64 decode...");
                        try {
                            const decoded = Buffer.from(embeddedContent, 'base64').toString('utf8');
                            console.log(`[XmlHandler] Decoded content (first 50 chars): ${decoded.substring(0, 50).replace(/\r?\n|\r/g, " ")}...`);
                            if (decoded.trim().startsWith('<')) {
                                console.log("[XmlHandler] Successfully decoded Base64 embedded XML string.");
                                embeddedContent = decoded.trim();
                            }
                        } catch (e) {
                            console.warn("[XmlHandler] Base64 decode attempt failed.", e.message);
                        }
                    }

                    if (embeddedContent.startsWith('<')) {
                        console.log("[XmlHandler] Found parseable XML string. Parsing and grafting...");
                        try {
                            // Use explicitRoot: false to match detection logic in ConfigHandler and enable paths without root prefix
                            graftedDoc = await parseStringPromise(embeddedContent, { explicitArray: true, trim: true, explicitRoot: false });

                            // GRAFTING: Inject the parsed object back into the parent
                            embeddedInfo.parent[embeddedInfo.key] = [graftedDoc];
                            console.log(`[XmlHandler] Successfully grafted embedded XML into '${embeddedInfo.key}'`);
                        } catch (e) {
                            console.warn("[XmlHandler] Failed to parse embedded XML content string.", e);
                        }
                    } else {
                        console.log("[XmlHandler] Embedded content is not a parseable XML string after decode attempt (still doesn't start with '<').");
                    }
                } else {
                    console.log("[XmlHandler] Embedded content is not a string.");
                }
            } else {
                console.log("[XmlHandler] Reference tag not found in XML.");
            }
        }

        // Retrieve all available XML fields for this country
        // We select the FKs explicitly to avoid association projection issues with composite keys
        const xmlConfigs = await SELECT.from(CountryFieldConfig)
            .where({ country_code: sCountryCodeUpper })
            .columns(
                'id',
                'visible',
                'active',
                'documentAIField_fieldName',
                'documentAIField_fieldType'
            );

        // Fetch all DocumentAIFields once to join in memory (safer for composite keys in some CDS versions)
        const aiFields = await SELECT.from(DocumentAIFields);
        const aiFieldsMap = new Map(aiFields.map(f => [`${f.fieldName}|${f.fieldType}`, f]));

        // Normalize results to ensure documentAIField structure exists
        const normalizedConfigs = xmlConfigs.map(c => {
            const fieldKey = `${c.documentAIField_fieldName}|${c.documentAIField_fieldType}`;
            const field = aiFieldsMap.get(fieldKey);
            return {
                ...c,
                documentAIField: field || {
                    fieldName: c.documentAIField_fieldName,
                    fieldType: c.documentAIField_fieldType,
                    sourceType: 'UNKNOWN'
                }
            };
        });

        console.log(`[XmlHandler] Query for Country: '${sCountryCodeUpper}' returned ${normalizedConfigs.length} results.`);
        if (normalizedConfigs.length > 0) {
            console.log(`[XmlHandler] Debug first config fieldName: ${normalizedConfigs[0].documentAIField.fieldName}`);
        }

        let relevantMappings = normalizedConfigs.filter(c => c.documentAIField && c.documentAIField.sourceType === 'XML');
        console.log(`[XmlHandler] Found ${relevantMappings.length} XML-specific field configs.`);

        if (relevantMappings.length === 0 && normalizedConfigs.length > 0) {
            console.warn("[XmlHandler] No 'XML' sourceType fields found. Falling back to ALL associated fields.");
            relevantMappings = normalizedConfigs.filter(c => !!c.documentAIField && !!c.documentAIField.fieldName);
        }

        const headerFields = [];
        const lineItems = [];

        // 1. Process Header Fields
        const headerMappings = relevantMappings.filter(m => m.documentAIField && (m.documentAIField.fieldType === 'header' || m.documentAIField.fieldType === 'Header'));
        console.log(`[XmlHandler] Filtered ${headerMappings.length} header fields to extract.`);

        headerMappings.forEach(m => {
            const fieldName = m.documentAIField.fieldName;

            // Search first in the grafted (inner) document if available
            let xmlTags = [];
            if (graftedDoc) {
                xmlTags = getValueByPathAll(graftedDoc, fieldName);
            }

            // Fallback to full document
            if (xmlTags.length === 0) {
                xmlTags = getValueByPathAll(xmlDoc, fieldName);
            }

            // Second fallback: try with xmlRefTag prefix
            if (xmlTags.length === 0 && xmlRefTag) {
                const fallbackPath = `${xmlRefTag}.${fieldName}`;
                xmlTags = getValueByPathAll(xmlDoc, fallbackPath);
            }

            const val = xmlTags.length > 0 ? flattenXmlValue(xmlTags[0]) : null;
            if (val !== null && val !== undefined) {
                console.log(`[XmlHandler] Extracted Header: ${fieldName} = ${val}`);
                const tagNode = xmlTags[0];
                const attributes = tagNode && tagNode.$ ? tagNode.$ : null;
                headerFields.push({
                    name: fieldName,
                    value: val,
                    attributes: attributes,
                    type: 'string',
                    confidence: 1.0
                });
            }
        });

        // 2. Process Repeating Sections (Line Items, Taxes, etc.)
        // Any fieldType that is NOT 'header' will be treated as a repeating section.
        const repeatingMappings = relevantMappings.filter(m => m.documentAIField && !['header', 'Header'].includes(m.documentAIField.fieldType));
        console.log(`[XmlHandler] Filtered ${repeatingMappings.length} repeating field mappings.`);

        const dynamicRepeatingGroups = {};

        if (repeatingMappings.length > 0) {
            // Helper to find the first array in a path using getValueByPath-style iterative search
            const findFirstArrayAnchor = (doc, fullPath) => {
                if (!doc || !fullPath) return null;
                const parts = fullPath.split(/\/|\./);
                for (let i = 1; i <= parts.length; i++) {
                    const prefixPath = parts.slice(0, i).join('.');
                    const val = getValueByPath(doc, prefixPath);
                    if (Array.isArray(val)) {
                        return { anchorPath: prefixPath, array: val };
                    }
                }
                return null;
            };



            const anchorGroups = new Map();
            repeatingMappings.forEach(m => {
                const fullPath = m.documentAIField.fieldName;
                const fieldType = m.documentAIField.fieldType;

                let anchorInfo = findFirstArrayAnchor(xmlDoc, fullPath);
                let sourceKey = "MAIN";

                if (!anchorInfo && graftedDoc) {
                    anchorInfo = findFirstArrayAnchor(graftedDoc, fullPath);
                    if (anchorInfo) sourceKey = "GRAFTED";
                }

                if (anchorInfo) {
                    // Group by Source + AnchorPath + FieldType to keep different tables separate
                    const groupKey = `${sourceKey}:${anchorInfo.anchorPath}:${fieldType}`;
                    if (!anchorGroups.has(groupKey)) {
                        anchorGroups.set(groupKey, {
                            source: sourceKey === "MAIN" ? xmlDoc : graftedDoc,
                            anchorPath: anchorInfo.anchorPath,
                            fieldType: fieldType,
                            mappings: []
                        });
                    }
                    anchorGroups.get(groupKey).mappings.push(m);
                } else {
                    console.log(`[XmlHandler] No repeating anchor found for path: ${fullPath} (Type: ${fieldType})`);
                }
            });

            // Process each group
            for (const [groupKey, group] of anchorGroups.entries()) {
                console.log(`[XmlHandler] Extracting from Anchor Group: ${groupKey}`);
                const itemsArray = getValueByPath(group.source, group.anchorPath);
                const anchorPartsCount = group.anchorPath.split(/\/|\./).length;

                if (!dynamicRepeatingGroups[group.fieldType]) dynamicRepeatingGroups[group.fieldType] = [];

                itemsArray.forEach((rawItem) => {
                    const fieldResults = {};
                    let maxNestedLen = 1;

                    group.mappings.forEach(m => {
                        const fullPath = m.documentAIField.fieldName;
                        const fullParts = fullPath.split(/\/|\./);
                        const relativePath = fullParts.slice(anchorPartsCount).join('.');

                        let vals = [];
                        if (relativePath === "") {
                            vals = [rawItem];
                        } else {
                            vals = getValueByPathAll(rawItem, relativePath);
                        }

                        // --- FIX SDOPPIAMENTO RIGHE (Limitato a cbc:Description) ---
                        // Utilizziamo fullPath invece di key, che è disponibile in questo scope
                        const isDescriptionField = fullPath.toLowerCase().endsWith('description');

                        if (vals.length > 1 && isDescriptionField) {
                            console.log(`[XmlHandlerTest] Consolidamento forzato per ${fullPath}: estratti ${vals.length} elementi.`);

                            const flattenedVals = vals.map(v => flattenXmlValue(v)).filter(v => v !== null && v !== "");

                            if (flattenedVals.length > 0) {
                                const firstVal = vals[0];
                                const mergedText = flattenedVals.join(" ");

                                if (firstVal && typeof firstVal === 'object') {
                                    // Preserva la struttura xml2js originale (inclusi attributi in $)
                                    vals = [{
                                        ...firstVal,
                                        _: mergedText
                                    }];
                                } else {
                                    vals = [mergedText];
                                }
                            }
                        }
                        // ----------------------------------------------------------

                        fieldResults[fullPath] = vals;
                        if (vals.length > maxNestedLen) maxNestedLen = vals.length;
                    });

                    for (let i = 0; i < maxNestedLen; i++) {
                        const itemFields = [];
                        let hasValues = false;

                        group.mappings.forEach(m => {
                            const fullPath = m.documentAIField.fieldName;
                            const vals = fieldResults[fullPath];
                            const valRaw = i < vals.length ? vals[i] : undefined;

                            const val = flattenXmlValue(valRaw);
                            if (val !== null && val !== undefined) {
                                const attributes = valRaw && valRaw[0] && valRaw[0].$ ? valRaw[0].$ : (valRaw && valRaw.$ ? valRaw.$ : null);
                                itemFields.push({
                                    name: fullPath,
                                    value: val,
                                    attributes: attributes,
                                    type: 'string',
                                    confidence: 1.0
                                });
                                hasValues = true;
                            }
                        });
                        if (hasValues) {
                            dynamicRepeatingGroups[group.fieldType].push(itemFields);
                        }
                    }
                });
                console.log(`[XmlHandler] Extracted ${itemsArray.length} items for ${group.fieldType} from ${group.anchorPath}`);
            }
        }

        // 3. Final Data Structure (DOX compatible)
        const extractedData = {
            headerFields,
            ...dynamicRepeatingGroups // This adds lineItem: [], withholdingTax: [], etc.
        };

        // Legacy compatibility: Ensure 'lineItems' exists if at least one repeating section present
        if (!extractedData.lineItems && dynamicRepeatingGroups.lineItem) {
            extractedData.lineItems = dynamicRepeatingGroups.lineItem;
        }


        //Inizio Modifica PROPINA e TASA DEL TURISMO
        const getValp = (name) => headerFields.find(f => f.name === name)?.value || null;
        const poNumberP = (countryConfig && countryConfig.xmlPoReferenceTag ? getValp(countryConfig.xmlPoReferenceTag) : null) || getValp('purchaseOrderNumber') || getValp('purchaseOrder') || null;
        const scenariop = poNumberP ? 'MM' : 'FI';
        if (sCountryCodeUpper === 'EC' && scenariop === 'FI') {
            console.log("[XmlHandler] Country EC detected: lineitems len", extractedData.lineItems.length);


            // Funzione helper aggiornata per seguire la struttura XML delle altre line items
            const addLine = (value, itemText, codigoPrincipal, glaccount) => {
                if (!value || parseFloat(value) === 0) return;

                const newLine = [
                    { name: 'comprobante.infoFactura.totalConImpuestos.totalImpuesto.codigo', value: '2', attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.infoFactura.totalConImpuestos.totalImpuesto.codigo', value: '2', attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.detalles.detalle.cantidad', value: '1', attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.detalles.detalle.precioUnitario', value: value, attributes: null, type: 'string', confidence: 1.0 },
                    {
                        name: 'comprobante.detalles.detalle.impuestos',
                        value: JSON.stringify({
                            impuesto: [{
                                codigo: ["2"],
                                codigoPorcentaje: ["4"],
                                tarifa: ["15"],
                                baseImponible: [value],
                                valor: ["0.23"]
                            }]
                        }),
                        attributes: null,
                        type: 'string',
                        confidence: 1.0
                    },
                    { name: 'comprobante.detalles.detalle.precioUnitario', value: value, attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.detalles.detalle.precioTotalSinImpuesto', value: value, attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.detalles.detalle.descripcion', value: itemText, attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.detalles.detalle.codigoPrincipal', value: codigoPrincipal, attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.detalles.detalle.cantidad', value: '1', attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.detalles.detalle.descripcion', value: itemText, attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.detalles.detalle.precioTotalSinImpuesto', value: value, attributes: null, type: 'string', confidence: 1.0 },
                    { name: 'comprobante.detalles.detalle.codigoPrincipal', value: codigoPrincipal, attributes: null, type: 'string', confidence: 1.0 },
                    {
                        name: 'comprobante.detalles.detalle.impuestos',
                        value: JSON.stringify({
                            impuesto: [{
                                codigo: ["2"],
                                codigoPorcentaje: ["4"],
                                tarifa: ["15"],
                                baseImponible: [value],
                                valor: ["0.23"]
                            }]
                        }),
                        attributes: null,
                        type: 'string',
                        confidence: 1.0
                    }
                ];


                if (!extractedData.lineItems) extractedData.lineItems = [];
                extractedData.lineItems.push(newLine);

                // Evitiamo i doppioni verificando che dynamicRepeatingGroups.lineItem non sia lo stesso array
                if (dynamicRepeatingGroups.lineItem && dynamicRepeatingGroups.lineItem !== extractedData.lineItems) {
                    dynamicRepeatingGroups.lineItem.push(newLine);
                }
            };

            // 1. Estrazione Propina
            const propinaTags = getValueByPathAll(xmlDoc, 'comprobante.infoFactura.propina');
            const propinaVal = propinaTags.length > 0 ? flattenXmlValue(propinaTags[0]) : null;
            console.log("[XmlHandler] Propina check", propinaVal);
            if (propinaVal) {
                addLine(propinaVal, 'Propina', 'PROPINA', 'N105160001');
            }

            // 2. Estrazione Tasa Turismo: usa il totale solo se appartiene a un rubro turistico.
            // Il controllo viene fatto sullo stesso nodo "rubro", per non associare il total
            // di un rubro diverso a un concepto turistico.
            const tasaRubros = getValueByPathAll(xmlDoc, 'comprobante.otrosRubrosTerceros.rubro');
            const tasaVal = tasaRubros
                .filter(rubro => {
                    const concepto = flattenXmlValue(getValueByPathAll(rubro, 'concepto')[0]);
                    const conceptoLower = concepto?.toLowerCase() || '';
                    return conceptoLower.includes('tasa de turismo') || conceptoLower.includes('tasa turistica') || conceptoLower.includes('tasa turismo') ||  conceptoLower.includes('turismo');
                })
                .map(rubro => flattenXmlValue(getValueByPathAll(rubro, 'total')[0]))
                .find(total => total);

            console.log("[XmlHandler] Tasa check", tasaVal);
            if (tasaVal) {
                addLine(tasaVal, 'Tasa de Turismo', 'TASA_TURISMO', ''); // tasa gl conto N112010009 da verificare
            }

            // 3. Estrazione SeguroCampesino
            const seguroCampesinoVal = tasaRubros
                .filter(rubro => {
                    const concepto = flattenXmlValue(getValueByPathAll(rubro, 'concepto')[0]);
                    return concepto?.trim().toLowerCase() === 'segurocampesino' || concepto?.trim().toLowerCase() === 'campesino';
                })
                .map(rubro => flattenXmlValue(getValueByPathAll(rubro, 'total')[0]))
                .find(total => total);

            console.log("[XmlHandler] SeguroCampesino check", seguroCampesinoVal);
            if (seguroCampesinoVal) {
                addLine(seguroCampesinoVal, 'SeguroCampesino', 'SEGUROCAMPESINO', '');
            }
            console.log("[XmlHandler] lineitems len after check", extractedData.lineItems.length);

            // --- STAMPA DI ISPEZIONE SU UN'UNICA RIGA ---
            console.log("[XmlHandler] --- Inspecting all lineItems ---");
            extractedData.lineItems.forEach((row, index) => {
                console.log(`[XmlHandler] Row [${index}] -> ${JSON.stringify(row)}`);
            });
        }


        //FINE Modifica PROPINA E TASA DEL TURISMO

        // Identifiers for DB record (Standard fields)
        const getVal = (name) => headerFields.find(f => f.name === name)?.value || null;

        const invoiceNumber = (countryConfig && countryConfig.xmlInvoiceNumberTag ? getVal(countryConfig.xmlInvoiceNumberTag) : null) || getVal('invoiceNumber') || getVal('InvoiceNumber') || getVal('documentNumber') || null;
        const vendorName = (countryConfig && countryConfig.xmlVendorTag ? getVal(countryConfig.xmlVendorTag) : null) || getVal('vendorName') || getVal('VendorName') || getVal('senderName') || null;
        const poNumber = (countryConfig && countryConfig.xmlPoReferenceTag ? getVal(countryConfig.xmlPoReferenceTag) : null) || getVal('purchaseOrderNumber') || getVal('purchaseOrder') || null;
        const companyCode = (countryConfig && countryConfig.xmlCompanyCodeTag ? getVal(countryConfig.xmlCompanyCodeTag) : null) || getVal('companyCode') || null;

        // User requested: manual switch only, default to MM
        // const scenario = poNumber ? 'MM' : 'FI';
        const scenario = 'MM';

        await UPDATE(DocumentStatusBtp).set({
            status: 'DONE',
            statusBtp: 'InvioOK',
            registrationStatus: 'New',
            extractedData: JSON.stringify(extractedData),
            invoiceNumber,
            fornitore: vendorName,
            ordine: poNumber,
            companyCode,
            scenario
        }).where({ id: jobId });

        return { jobId: jobId, status: 'COMPLETED' };

    } catch (error) {
        console.error('[XmlHandler] Error:', error);
        await UPDATE(DocumentStatusBtp).set({
            status: 'FAILED',
            statusBtp: 'Errore estrazione',
            sapErrorLog: error.message
        }).where({ id: jobId });
    }

    return jobId;
};

module.exports = XmlHandler;
