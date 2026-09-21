const cds = require("@sap/cds");
const xml2js = require("xml2js");

// --- Helper Functions ---

function formatFieldLabel(fieldName) {
    if (!fieldName) return "";
    return fieldName
      .replace(/_/g, " ")
      .replace(/([A-Z])/g, " $1")
      .trim()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
}

function mapODataType(odataType) {
    if (!odataType) return "String";
    if (odataType.includes("String") || odataType.includes("Edm.String"))
      return "String";
    if (odataType.includes("Decimal") || odataType.includes("Edm.Decimal"))
      return "Decimal";
    if (odataType.includes("Date") || odataType.includes("Edm.Date"))
      return "Date";
    if (odataType.includes("Time") || odataType.includes("Edm.Time"))
      return "DateTime";
    if (odataType.includes("Boolean") || odataType.includes("Edm.Boolean"))
      return "Boolean";
    if (odataType.includes("Int") || odataType.includes("Edm.Int"))
      return "Integer";
    return "String"; // Default
}

module.exports = {

    async getCountryFieldConfig(req, entities) {
        console.log("getCountryFieldConfig - handler start");
        const { countryCode } = req.data;
    
        if (!countryCode) {
          req.error(400, "Country code is required");
        }
    
        try {
          // Query field configuration for the country
          const fieldConfigs = await SELECT.from("DB_CountryFieldConfig")
            .where({ country_code: countryCode })
            .columns([
              "documentAIField_fieldName",
              "documentAIField_fieldType",
              "documentAIField_sourceType",
              "mandatory",
              "visible",
              "displayOrder",
              "scenario",
              "searchHelpFunction_id",
            ]);
    
          // Query field mappings for the country
          const fieldMappings = await SELECT.from("DB_FieldMappings")
            .where({ country_code: countryCode, active: true })
            .columns([
              "documentAIField_fieldName",
              "documentAIField_fieldType",
              "documentAIField_sourceType",
              "odataField_fieldName",
              "transformationRule",
              "scenario",
              "groupId",
            ]);
    
          // Get Document AI field details
          const documentAIFields = await SELECT.from("DB_DocumentAIFields");
    
          // Get OData field details
          const odataFields = await SELECT.from("DB_ODataFields");
    
          // Build enriched configuration
          const enrichedConfig = fieldConfigs.map((config) => {
            const aiField = documentAIFields.find(
              (f) => f.fieldName === config.documentAIField_fieldName &&
                     f.fieldType === config.documentAIField_fieldType &&
                     f.sourceType === config.documentAIField_sourceType
            );
            const mapping = fieldMappings.find(
              (m) =>
                m.documentAIField_fieldName === config.documentAIField_fieldName &&
                m.documentAIField_fieldType === config.documentAIField_fieldType &&
                m.documentAIField_sourceType === config.documentAIField_sourceType &&
                m.scenario === config.scenario
            );
    
            let odataFieldInfo = null;
            if (mapping) {
              odataFieldInfo = odataFields.find(
                (f) => f.fieldName === mapping.odataField_fieldName
              );
            }
    
            return {
              documentAIFieldName: config.documentAIField_fieldName,
              documentAIFieldLabel:
                aiField?.fieldLabel || config.documentAIField_fieldName,
              fieldType: aiField?.fieldType || config.documentAIField_fieldType || "header",
              documentAIField_sourceType: aiField?.sourceType || config.documentAIField_sourceType || "DOX",
              mandatory: config.mandatory,
              visible: config.visible,
              active: config.active,
              displayOrder: config.displayOrder,
              scenario: config.scenario || 'MM',
              searchHelpFunction_id: config.searchHelpFunction_id,
              odataFieldName: mapping?.odataField_fieldName || null,
              odataFieldLabel: odataFieldInfo?.fieldLabel || null,
              odataDataType: odataFieldInfo?.dataType || null,
              transformationRule: mapping?.transformationRule || null,
              groupId: mapping?.groupId || null,
            };
          });
    
          // Sort by display order
          enrichedConfig.sort(
            (a, b) => (a.displayOrder || 999) - (b.displayOrder || 999),
          );
    
          return {
            countryCode: countryCode,
            fieldCount: enrichedConfig.length,
            fields: enrichedConfig,
            mappings: fieldMappings,
          };
        } catch (error) {
          console.error("Error retrieving country field config:", error);
          req.error(500, `Error retrieving configuration: ${error.message}`);
        }
    },

    async loadDocumentAISchema(req, entities) {
        const { countryCode, schemaJson } = req.data;
        const { DocumentAIFields, CountryFieldConfig } = entities;
    
        if (!schemaJson) {
          req.error(400, "Schema JSON is required");
        }
        if (!countryCode) {
          req.error(400, "Country Code is required");
        }
    
        try {
          const schema =
            typeof schemaJson === "string" ? JSON.parse(schemaJson) : schemaJson;
          console.log(
            "Schema parsed. Header fields:",
            schema.headerFields?.length,
            "Item fields:",
            schema.lineItemFields?.length,
          );
          const fields = [];
    
          // Parse flat array fields from schema
          if (Array.isArray(schema)) {
               schema.forEach((field) => {
                  fields.push({
                    fieldName: field.name || field.fieldName,
                    fieldLabel: field.label || field.fieldLabel || field.name || field.fieldName,
                    fieldType: field.fieldType || "header",
                    description: field.description || `Document AI field: ${field.name || field.fieldName}`,
                  });
               });
          } else {
              // Legacy Object format (headerFields, lineItemFields)
              if (schema.headerFields && Array.isArray(schema.headerFields)) {
                schema.headerFields.forEach((field) => {
                  fields.push({
                    fieldName: field.name || field.fieldName,
                    fieldLabel: field.label || field.name || field.fieldName,
                    fieldType: "header",
                    description:
                      field.description ||
                      `Document AI field: ${field.name || field.fieldName}`,
                  });
                });
              }
        
              if (schema.lineItemFields && Array.isArray(schema.lineItemFields)) {
                schema.lineItemFields.forEach((field) => {
                  fields.push({
                    fieldName: field.name || field.fieldName,
                    fieldLabel: field.label || field.name || field.fieldName,
                    fieldType: "lineItem",
                    description:
                      field.description ||
                      `Document AI field: ${field.name || field.fieldName}`,
                  });
                });
              }
          }
    
          console.log("Total fields extracted:", fields.length);
    
          // Insert fields into database (Upsert) and create Country Config
          if (fields.length > 0) {
            
            const docAIFiEntries = [];
            const configEntries = [];

            // 1. Unified Master Dictionary Entries
            fields.forEach((field) => {
                 docAIFiEntries.push({
                     fieldName: field.fieldName,
                     fieldLabel: field.fieldLabel,
                     fieldType: field.fieldType,
                     sourceType: 'DOX',
                     description: field.description
                 });
            });

            // 2. Scenario specific Configurations
            // MM Scenario
            fields.forEach((field, index) => {
                 configEntries.push({
                    country_code: countryCode,
                    documentAIField_fieldName: field.fieldName,
                    documentAIField_fieldType: field.fieldType,
                    documentAIField_sourceType: 'DOX',
                    scenario: 'MM',
                    visible: true,
                    mandatory: false,
                    toBeControlled: false,
                    displayOrder: index + 1
                 });
            });
    
            // FI Scenario
            fields.forEach((field, index) => {
                 configEntries.push({
                    country_code: countryCode,
                    documentAIField_fieldName: field.fieldName,
                    documentAIField_fieldType: field.fieldType,
                    documentAIField_sourceType: 'DOX',
                    scenario: 'FI',
                    visible: true,
                    mandatory: false,
                    toBeControlled: false,
                    displayOrder: index + 1
                 });
            });

            // Upsert DocumentAIFields
            console.log("Upserting DocumentAIFields with multi-scenario keys...");
            await UPSERT.into(DocumentAIFields).entries(docAIFiEntries);
    
            // Delete existing config for this country
            console.log(`Deleting existing config for country: ${countryCode}`);
            await DELETE.from(CountryFieldConfig).where({
              country_code: countryCode,
            });
    
            console.log(
              `Inserting ${configEntries.length} config entries for country: ${countryCode}`,
            );
            try {
              await INSERT.into(CountryFieldConfig).entries(configEntries);
              console.log("Insert successful");
            } catch (err) {
              console.error("Error inserting config:", err);
              throw err;
            }
    
            return {
              message: `Successfully loaded ${fields.length} fields for country ${countryCode}`,
              count: fields.length,
            };
          } else {
            req.error(400, "No fields found in schema");
          }
        } catch (error) {
          req.error(500, `Error parsing schema: ${error.message}`);
        }
    },

    async loadODataEDMX(req, entities) {
        const { countryCode, edmxContent } = req.data;
        if (!edmxContent) return req.reject(400, "No content provided");
    
        const parser = new xml2js.Parser({
          explicitArray: false,
          ignoreAttrs: false,
          mergeAttrs: true,
        });
        
        // Ensure entities are available
        const { DocumentAIFields, CountryFieldConfig, ODataFields } = entities;
        try {
          const result = await parser.parseStringPromise(edmxContent);
    
          // Helper to find Schema
          const findSchema = (obj) => {
            if (obj["edmx:DataServices"] && obj["edmx:DataServices"]["Schema"])
              return obj["edmx:DataServices"]["Schema"];
            if (obj["edmx:DataServices"] && obj["edmx:DataServices"]["edm:Schema"])
              return obj["edmx:DataServices"]["edm:Schema"];
            for (let key in obj) {
              if (typeof obj[key] === "object") {
                const res = findSchema(obj[key]);
                if (res) return res;
              }
            }
            return null;
          };
    
          const schema = findSchema(result);
          if (!schema) return req.error(400, "No Schema found in EDMX.");
    
          // Helper to find EntityContainer
          const findEntityContainer = (obj) => {
             if (obj.EntityContainer) return obj.EntityContainer;
             if (obj["edm:EntityContainer"]) return obj["edm:EntityContainer"];
             
             for (let key in obj) {
                 if (obj[key] && typeof obj[key] === "object") {
                     const res = findEntityContainer(obj[key]);
                     if (res) return res;
                 }
             }
             return null;
          };
    
          const entityContainer = findEntityContainer(result);
          const entityTypeToSetMap = new Map();
    
          if (entityContainer) {
              console.log("Found EntityContainer:", JSON.stringify(entityContainer, null, 2));
              const containers = Array.isArray(entityContainer) ? entityContainer : [entityContainer];
              for (const ec of containers) {
                  const entitySets = ec.EntitySet ? (Array.isArray(ec.EntitySet) ? ec.EntitySet : [ec.EntitySet]) : [];
                  for (const es of entitySets) {
                      // es.EntityType has format "Namespace.EntityTypeName"
                      if (es.EntityType && es.Name) {
                          const typeParts = es.EntityType.split('.');
                          const typeName = typeParts[typeParts.length - 1]; // Simple Name
                          entityTypeToSetMap.set(typeName, es.Name);
                          entityTypeToSetMap.set(es.EntityType, es.Name); // Full Name
                          console.log(`Mapped Type '${typeName}' (Full: ${es.EntityType}) -> Set '${es.Name}'`);
                      } else {
                          console.warn("Skipping EntitySet missing EntityType or Name:", es);
                      }
                  }
              }
          } else {
              console.warn("No EntityContainer found in EDMX result!");
          }
    
          const schemas = Array.isArray(schema) ? schema : [schema];
          let fieldCount = 0;
          const entries = [];
    
          for (const s of schemas) {
            const entityTypes = s.EntityType
              ? Array.isArray(s.EntityType)
                ? s.EntityType
                : [s.EntityType]
              : [];
            const namespace = s.Namespace || "";
    
            for (const et of entityTypes) {
              const entityTypeName = et.Name;
              const fullEntityTypeName = namespace
                ? namespace + "." + entityTypeName
                : entityTypeName;
              
              // Determine Entity Set Name
              let entitySetName = entityTypeToSetMap.get(fullEntityTypeName) || entityTypeToSetMap.get(entityTypeName);
              
              if (!entitySetName) {
                  console.warn(`No EntitySet found for EntityType ${entityTypeName}. Using Type Name as fallback.`);
                  entitySetName = entityTypeName;
              }
    
              // Heuristic for fieldType
              let fieldType = "header";
              if (
                entityTypeName.toLowerCase().includes("item") ||
                entityTypeName.toLowerCase().includes("product")
              ) {
                fieldType = "lineItem";
              }
    
              if (et.Property) {
                const props = Array.isArray(et.Property)
                  ? et.Property
                  : [et.Property];
                for (const p of props) {
                  if (!p.Name) continue;
    
                  entries.push({
                    fieldName: p.Name,
                    entityName: entitySetName,
                    fieldLabel: p["sap:label"] || p.Name,
                    fieldType: fieldType,
                    dataType: mapODataType(p.Type), // Use helper
                    description: p["sap:quickinfo"] || "",
                  });
                  fieldCount++;
                }
              }
            }
          }
    
          if (entries.length > 0) {
            const tx = cds.tx(req);
            
            // 1. Fetch all existing fields to track orphans
            const allExisting = await tx.run(SELECT.from(ODataFields));
            const existingMap = new Map();
            allExisting.forEach(f => existingMap.set(`${f.entityName}::${f.fieldName}`, f.id));
            
            const touchedIds = new Set();
            const newEntries = [];
    
            // 2. Process EDMX entries (Upsert)
            for (const entry of entries) {
                const key = `${entry.entityName}::${entry.fieldName}`;
                if (existingMap.has(key)) {
                    // Update existing
                    const id = existingMap.get(key);
                    touchedIds.add(id);
                    await tx.run(
                        UPDATE(ODataFields)
                        .set({
                            fieldLabel: entry.fieldLabel,
                            dataType: entry.dataType,
                            fieldType: entry.fieldType,
                            description: entry.description
                        })
                        .where({ id: id })
                    );
                } else {
                    // Insert new
                    newEntries.push(entry);
                }
            }
    
            // 3. Batch Insert New
            if (newEntries.length > 0) {
                const chunkSize = 500;
                for (let i = 0; i < newEntries.length; i += chunkSize) {
                    await tx.run(INSERT.into(ODataFields).entries(newEntries.slice(i, i + chunkSize)));
                }
            }
    
            // 4. Delete Orphans (Fields not in EDMX)
            const orphanIds = allExisting.filter(f => !touchedIds.has(f.id)).map(f => f.id);
            if (orphanIds.length > 0) {
                console.log(`Deleting ${orphanIds.length} obsolete OData fields.`);
                // Delete in chunks to be safe with limits
                const deleteChunkSize = 500;
                for (let i = 0; i < orphanIds.length; i += deleteChunkSize) {
                    const chunk = orphanIds.slice(i, i + deleteChunkSize);
                    await tx.run(DELETE.from(ODataFields).where({ id: { in: chunk } }));
                }
            }
            
            const insertedCount = newEntries.length;
            const updatedCount = touchedIds.size;
            const deletedCount = orphanIds.length;
    
            return {
              message: `Imported fields from EDMX: ${insertedCount} new, ${updatedCount} updated. Removed ${deletedCount} obsolete fields.`,
              count: entries.length,
            };
          }
        } catch (e) {
          console.error("EDMX Parsing Error", e);
          return req.reject(500, "EDMX Parsing Error: " + e.message);
        }
    },

    async saveConfiguration(req, entities) {
        let { countryCode, configuration, xmlReferenceTag, xmlPoReferenceTag, xmlVendorTag, xmlInvoiceNumberTag, xmlCompanyCodeTag, aiModel, aiTemperature } = req.data;
        const { DocumentAIFields, CountryFieldConfig, FieldMappings } = entities;
    
        if (!configuration) {
          req.error(400, "Configuration data is required");
        }
        
        const sCountryCodeUpper = (countryCode || "").toUpperCase();
        console.log(`[ConfigHandler] saveConfiguration started for ${sCountryCodeUpper}`);
        console.log(`[ConfigHandler] xmlReferenceTag: '${xmlReferenceTag}', aiModel: '${aiModel}', aiTemperature: '${aiTemperature}', xmlPoReferenceTag: '${xmlPoReferenceTag}', xmlVendorTag: '${xmlVendorTag}', xmlInvoiceNumberTag: '${xmlInvoiceNumberTag}', xmlCompanyCodeTag: '${xmlCompanyCodeTag}'`);

        try {
          const configData = JSON.parse(configuration);
          console.log(
            `Saving configuration for ${sCountryCodeUpper}, items: ${configData.length}`,
          );
    
          const tx = cds.tx(req);
          
          // --- Lock Validation ---
          const userId = req.user.id || "Unknown";
          const existingLock = await tx.run(SELECT.one.from(entities.ConfigLocks).where({ countryCode: countryCode }));
          if (!existingLock || existingLock.lockedBy !== userId) {
              return req.error(403, "Impossibile salvare: la configurazione è attualmente bloccata da un altro utente o la sessione è scaduta.");
          }
          // Renew the lock
          await tx.run(UPDATE(entities.ConfigLocks).set({ lockedAt: new Date() }).where({ countryCode: countryCode }));
          // --- End Lock Validation ---

          if (xmlReferenceTag !== undefined || aiModel !== undefined || aiTemperature !== undefined || xmlPoReferenceTag !== undefined || xmlVendorTag !== undefined || xmlInvoiceNumberTag !== undefined || xmlCompanyCodeTag !== undefined) {
              const updateData = {};
              if (xmlReferenceTag !== undefined) updateData.xmlReferenceTag = xmlReferenceTag || null;
              if (aiModel !== undefined) updateData.aiModel = aiModel || null;
              if (aiTemperature !== undefined) updateData.aiTemperature = aiTemperature || 0.0;
              if (xmlPoReferenceTag !== undefined) updateData.xmlPoReferenceTag = xmlPoReferenceTag || null;
              if (xmlVendorTag !== undefined) updateData.xmlVendorTag = xmlVendorTag || null;
              if (xmlInvoiceNumberTag !== undefined) updateData.xmlInvoiceNumberTag = xmlInvoiceNumberTag || null;
              if (xmlCompanyCodeTag !== undefined) updateData.xmlCompanyCodeTag = xmlCompanyCodeTag || null;
              
              console.log(`[ConfigHandler] Updating Countries table: ${JSON.stringify(updateData)} for ${sCountryCodeUpper}`);
              
              if (Object.keys(updateData).length > 0) {
                  const updated = await tx.run(
                      UPDATE(entities.Countries)
                      .set(updateData)
                      .where({ code: sCountryCodeUpper })
                  );
                  console.log(`[ConfigHandler] Countries updated: ${updated} row(s)`);
              }
          }

          const fieldsByScenario = { MM: new Set(), FI: new Set() };
          configData.forEach(item => {
            const scenario = item.scenario || 'MM';
            const sourceType = item.sourceType || 'DOX';
            const key = `${item.fieldName}_${item.fieldType}_${sourceType}`;
            fieldsByScenario[scenario].add(key);
          });
    
          for (const scenario of ['MM', 'FI']) {
            const existingFields = await tx.run(
              SELECT.from(CountryFieldConfig).where({
                country_code: sCountryCodeUpper,
                scenario: scenario
              })
            );
    
            const seenKeys = new Set();
            const fieldsToDelete = existingFields.filter(field => {
              const sSource = field.documentAIField_sourceType || 'DOX';
              const key = `${field.documentAIField_fieldName}_${field.documentAIField_fieldType}_${sSource}`;
              
              // Delete if not in current payload OR if it's a duplicate of something already processed
              if (!fieldsByScenario[scenario].has(key) || seenKeys.has(key)) {
                  return true;
              }
              seenKeys.add(key);
              return false;
            });
            
            if (fieldsToDelete.length > 0) {
               console.log(`[ConfigHandler] Deleting ${fieldsToDelete.length} missing or duplicate fields for scenario '${scenario}':`, fieldsToDelete.map(f => f.documentAIField_fieldName));
            }
    
            for (const field of fieldsToDelete) {
              await tx.run(
                DELETE.from(FieldMappings).where({
                  country_code: sCountryCodeUpper,
                  documentAIField_fieldName: field.documentAIField_fieldName,
                  documentAIField_fieldType: field.documentAIField_fieldType,
                  documentAIField_sourceType: field.documentAIField_sourceType,
                  scenario: scenario
                })
              );
    
              await tx.run(
                DELETE.from(CountryFieldConfig).where({
                  country_code: sCountryCodeUpper,
                  id: field.id // DELETE BY ID to ensure we only remove the intended duplicate/orphan
                })
              );
            }
          }
    
          for (const item of configData) {
            console.log(`[ConfigHandler] Saving field: ${item.fieldName}, SearchHelpMapping: ${item.searchHelpInputMapping}`);
            const scenario = item.scenario || 'MM';
            const sourceType = item.sourceType || 'DOX';

            const existingDocField = await tx.run(
              SELECT.one.from(DocumentAIFields).where({
                fieldName: item.fieldName,
                fieldType: item.fieldType,
                sourceType: sourceType
              }),
            );
    
            if (!existingDocField) {
              await tx.run(
                INSERT.into(DocumentAIFields).entries({
                  fieldName: item.fieldName,
                  fieldLabel: formatFieldLabel(item.fieldName),
                  fieldType: item.fieldType,
                  sourceType: sourceType,
                  description: item.description || "Custom Field",
                }),
              );
            }
                const existingConfig = await tx.run(
                 SELECT.one.from(CountryFieldConfig).where({
                     country_code: sCountryCodeUpper,
                     documentAIField_fieldName: item.fieldName,
                     documentAIField_fieldType: item.fieldType,
                     documentAIField_sourceType: sourceType,
                     scenario: scenario
                 })
            );
    
            if (existingConfig) {
                 await tx.run(
                    UPDATE(CountryFieldConfig)
                        .set({
                        visible: item.visible,
                        active: item.active,
                        mandatory: item.mandatory,
                        toBeControlled: item.toBeControlled || false,
                        editable: item.editable !== false,
                        customLabel: item.customLabel,
                        searchHelpFunction_id: item.searchHelpFunction_id,
                        searchHelpInputMapping: item.searchHelpInputMapping,
                        displayOrder: existingConfig.displayOrder
                        })
                        .where({
                        country_code: sCountryCodeUpper,
                        documentAIField_fieldName: item.fieldName,
                        documentAIField_fieldType: item.fieldType,
                        documentAIField_sourceType: sourceType,
                        scenario: scenario
                        })
                 );
            } else {
                 await tx.run(
                     INSERT.into(CountryFieldConfig).entries({
                         country_code: sCountryCodeUpper,
                         documentAIField_fieldName: item.fieldName,
                         documentAIField_fieldType: item.fieldType,
                         documentAIField_sourceType: sourceType,
                         scenario: scenario,
                         visible: item.visible,
                         active: item.active,
                         mandatory: item.mandatory,
                         toBeControlled: item.toBeControlled || false,
                         editable: item.editable !== false,
                         customLabel: item.customLabel,
                         searchHelpFunction_id: item.searchHelpFunction_id,
                         searchHelpInputMapping: item.searchHelpInputMapping,
                         displayOrder: 999
                     })
                  );
            }
    
            await tx.run(
                DELETE.from(FieldMappings).where({
                    country_code: sCountryCodeUpper,
                    documentAIField_fieldName: item.fieldName,
                    documentAIField_fieldType: item.fieldType,
                    documentAIField_sourceType: sourceType,
                    scenario: scenario
                })
            );
    
            if (item.mappings && Array.isArray(item.mappings) && item.mappings.length > 0) {
                const newMappings = item.mappings.map(mapItem => ({
                    country_code: sCountryCodeUpper,
                    documentAIField_fieldName: item.fieldName,
                    documentAIField_fieldType: item.fieldType,
                    documentAIField_sourceType: sourceType,
                    scenario: scenario,
                    odataField_id: mapItem.odataField_id,
                    active: mapItem.active !== false,
                    groupId: mapItem.groupId || null,
                    aggregationGroupBy: mapItem.aggregationGroupBy || false,
                    aggregationSum: mapItem.aggregationSum || false,
                    steps: (mapItem.steps || []).map(s => ({
                        stepOrder: s.stepOrder,
                        conversionFunction_id: s.conversionFunction_id,
                        functionParameters: s.functionParameters
                    }))
                }));
    
                if (newMappings.length > 0) {
                    for (const mapping of newMappings) {
                        try {
                            await tx.run(INSERT.into(FieldMappings).entries(mapping));
                        } catch (err) {
                            console.error(`[ConfigHandler] Failed to insert mapping for ${mapping.documentAIField_fieldName}`, err);
                            throw err;
                        }
                    }
                }
            }
          }
    
          return "Configuration saved successfully";
        } catch (error) {
          console.error("Error saving configuration:", error);
          req.error(500, `Error saving configuration: ${error.message}`);
        }
    },
    
    // Validations
    async beforeCreateCountryFieldConfig(req, entities) {
        const { country_code, documentAIField_fieldName, documentAIField_fieldType, scenario, documentAIField_sourceType } = req.data;
        const { CountryFieldConfig } = entities;
    
        const existing = await SELECT.from(CountryFieldConfig).where({
          country_code: country_code,
          documentAIField_fieldName: documentAIField_fieldName,
          documentAIField_fieldType: documentAIField_fieldType,
          scenario: scenario || 'MM',
          documentAIField_sourceType: documentAIField_sourceType || 'DOX'
        });
    
        if (existing.length > 0) {
          req.error(
            400,
            `Field configuration already exists for this country, field type, and scenario`,
          );
        }
    },

    // --- Locking Logic ---
    async acquireLock(req, entities) {
        const { countryCode } = req.data;
        const { ConfigLocks } = entities;
        if (!countryCode) return req.reject(400, "Country Code required");

        const userId = req.user.id || "Unknown";
        
        // 30 minutes expiration
        const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);

        const tx = cds.tx(req);
        const existingLock = await tx.run(SELECT.one.from(ConfigLocks).where({ countryCode }));

        if (existingLock) {
            const lockDate = new Date(existingLock.lockedAt);
            if (lockDate < thirtyMinsAgo) {
                // Lock expired, we can steal it
                await tx.run(UPDATE(ConfigLocks).set({ lockedBy: userId, lockedAt: new Date() }).where({ countryCode }));
                return "OK";
            } else if (existingLock.lockedBy === userId) {
                // User already has the lock, renew it
                await tx.run(UPDATE(ConfigLocks).set({ lockedAt: new Date() }).where({ countryCode }));
                return "OK";
            } else {
                return `LOCKED_BY:${existingLock.lockedBy}`;
            }
        } else {
            await tx.run(INSERT.into(ConfigLocks).entries({ countryCode, lockedBy: userId, lockedAt: new Date() }));
            return "OK";
        }
    },

    async releaseLock(req, entities) {
        const { countryCode } = req.data;
        const { ConfigLocks } = entities;
        if (!countryCode) return req.reject(400, "Country Code required");

        const userId = req.user.id || "Unknown";
        const tx = cds.tx(req);
        
        await tx.run(DELETE.from(ConfigLocks).where({ countryCode, lockedBy: userId }));
        return "OK";
    },


    /**
     * Analyzes an XML sample to detect potential fields and repeating items (line items).
     */
    async detectFieldsFromXml(req) {
        const { xmlContent, referenceTag } = req.data;
        if (!xmlContent) return req.error(400, "XML content is required");

        let content = xmlContent;
        try {
            if (!content.trim().startsWith('<')) {
                content = Buffer.from(content, 'base64').toString('utf8');
            }
        } catch (e) {
            // Keep as is
        }

        try {
            // Main document parsing (always needed for the full tree structure)
            const result = await xml2js.parseStringPromise(content, { explicitArray: true, trim: true, explicitRoot: false });
            
            // --- NEW: Grafting Support in Detection ---
            if (referenceTag) {
                console.log(`[ConfigHandler] Detection: Grafting embedded XML from tag: ${referenceTag}`);
                // Helper for deep searching a tag
                const findDeepNode = (obj, targetName) => {
                    const searchName = targetName.toLowerCase();
                    let found = null;

                    const traverse = (current, parent, key) => {
                        if (found) return;
                        if (!current || typeof current !== 'object') return;

                        if (Array.isArray(current)) {
                            for (let i = 0; i < current.length; i++) {
                                traverse(current[i], current, i);
                            }
                            return;
                        }

                        const keys = Object.keys(current);
                        for (const k of keys) {
                            const cleanKey = k.includes(':') ? k.split(':').pop() : k;
                            if (cleanKey.toLowerCase() === searchName) {
                                found = { node: current[k], parent: current, key: k };
                                return;
                            }
                        }

                        for (const k of keys) {
                            traverse(current[k], current, k);
                        }
                    };

                    traverse(obj, null, null);
                    return found;
                };

                let embeddedInfo = null;
                if (referenceTag.includes('.') || referenceTag.includes('/')) {
                     const leafPart = referenceTag.split(/\/|\./).pop();
                     embeddedInfo = findDeepNode(result, leafPart);
                } else {
                     embeddedInfo = findDeepNode(result, referenceTag);
                }

                if (embeddedInfo && embeddedInfo.node) {
                    const embeddedRaw = embeddedInfo.node;
                    
                    // Extract content if it's a string (flatten logic similar to XmlHandler)
                    let embeddedContent = null;
                    if (Array.isArray(embeddedRaw) && embeddedRaw.length > 0) {
                        const first = embeddedRaw[0];
                        embeddedContent = typeof first === 'object' ? (first._ || null) : String(first);
                    } else if (typeof embeddedRaw === 'string') {
                        embeddedContent = embeddedRaw;
                    }

                    if (embeddedContent && typeof embeddedContent === 'string') {
                        embeddedContent = embeddedContent.trim();
                        // Try to decode base64 if it doesn't look like XML
                        if (!embeddedContent.startsWith('<')) {
                            try {
                                const decoded = Buffer.from(embeddedContent, 'base64').toString('utf8');
                                if (decoded.trim().startsWith('<')) {
                                    console.log("[ConfigHandler] Successfully decoded Base64 embedded XML string.");
                                    embeddedContent = decoded.trim();
                                }
                            } catch (e) {
                                // ignore
                            }
                        }

                        if (embeddedContent.startsWith('<')) {
                            console.log("[ConfigHandler] Found parseable embedded XML string during detection. Grafting...");
                            try {
                                const parsedEmbedded = await xml2js.parseStringPromise(embeddedContent, { explicitArray: true, trim: true, explicitRoot: false });
                                // Inject back into the main tree so traverse gets the full path
                                embeddedInfo.parent[embeddedInfo.key] = [parsedEmbedded];
                            } catch (e) {
                                console.warn("[ConfigHandler] Failed to parse embedded content during detection.", e);
                            }
                        }
                    }
                }
            }
            
            const discoveredFields = [];
            
            const formatFieldLabel = (name) => {
                if (!name) return "";
                // Strip namespace prefix
                const cleanName = name.includes(':') ? name.split(':').pop() : name;
                // CamelCase to Space Case
                return cleanName.replace(/([A-Z])/g, ' $1')
                           .replace(/^./, (str) => str.toUpperCase())
                           .trim();
            };

            const traverse = (obj, path = "") => {
                if (!obj || typeof obj !== 'object') return;

                const keys = Object.keys(obj);
                keys.forEach(key => {
                    if (key === '$' || key === '_') return; // Skip metadata
                    
                    const currentPath = path ? `${path}.${key}` : key;
                    const val = obj[key];

                    if (Array.isArray(val)) {
                        if (val.length > 1) {
                            // Potentially a line item container
                            const firstItem = val[0];
                            if (typeof firstItem === 'object') {
                                Object.keys(firstItem).forEach(childKey => {
                                    if (childKey === '$' || childKey === '_') return;
                                    discoveredFields.push({
                                        fieldName: `${currentPath}.${childKey}`,
                                        fieldLabel: formatFieldLabel(childKey),
                                        fieldType: 'lineItem',
                                        sourceType: 'XML'
                                    });
                                });
                            }
                        } else if (val.length === 1) {
                            if (typeof val[0] === 'object') {
                                traverse(val[0], currentPath);
                            } else {
                                discoveredFields.push({
                                    fieldName: currentPath,
                                    fieldLabel: formatFieldLabel(key),
                                    fieldType: 'header',
                                    sourceType: 'XML'
                                });
                            }
                        }
                    } else if (typeof val === 'object') {
                        traverse(val, currentPath);
                    } else {
                        discoveredFields.push({
                            fieldName: currentPath,
                            fieldLabel: formatFieldLabel(key),
                            fieldType: 'header',
                            sourceType: 'XML'
                        });
                    }
                });
            };

            traverse(result);

            // Deduplicate
            const uniqueFields = [];
            const seen = new Set();
            discoveredFields.forEach(f => {
                const compositeKey = `${f.fieldName}_${f.fieldType}`;
                if (!seen.has(compositeKey)) {
                    uniqueFields.push(f);
                    seen.add(compositeKey);
                }
            });

            return JSON.stringify(uniqueFields);

        } catch (error) {
            console.error("[ConfigHandler] XML Analysis failed:", error);
            return req.error(500, "Failed to analyze XML structure: " + error.message);
        }
    }
};
