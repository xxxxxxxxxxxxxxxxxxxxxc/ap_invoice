sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/routing/History",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/model/json/JSONModel"
], function (Controller, History, MessageToast, MessageBox, JSONModel) {
    "use strict";

    return Controller.extend("configcountry.controller.Detail", {
        onInit: function () {
            var oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("Detail").attachPatternMatched(this._onObjectMatched, this);

            // Model for local view state and mapping data
            var oViewModel = new JSONModel({
                busy: false,
                currentScenario: "MM",
                configs: {
                    MM: { items: [], fieldMappings: {} },
                    FI: { items: [], fieldMappings: {} }
                },
                fieldMappings: {} // Current active mappings
            });
            oViewModel.setSizeLimit(5000);
            this.getView().setModel(oViewModel, "viewModel");
            
            this._sActiveScenario = "MM"; // Track active scenario manually to handle switch logic

            this._attachFioriSessionTimeout();
        },

        _attachFioriSessionTimeout: function () {
            var that = this;
            
            // 1. Hook into Launchpad Logout event
            if (sap.ushell && sap.ushell.Container) {
                if (typeof sap.ushell.Container.attachLogoutEvent === "function") {
                    sap.ushell.Container.attachLogoutEvent(function () {
                        that._releaseLock();
                    });
                }
                
                // 2. Hook into Session Timeout service if active
                sap.ushell.Container.getServiceAsync("SessionTimeout").then(function (oSessionTimeoutService) {
                     if (oSessionTimeoutService && typeof oSessionTimeoutService.attachSessionTimeout === "function") {
                         oSessionTimeoutService.attachSessionTimeout(function() {
                             that._releaseLock();
                             // Fiori typically handles redirect, but we force exit just in case
                             that.getOwnerComponent().getRouter().navTo("RouteMain", {}, true);
                         });
                     }
                }).catch(function(e) {
                     // Silently ignore if service is not available in local test environments
                });
            }
        },

        _onObjectMatched: async function (oEvent) {
            var sCountryCode = oEvent.getParameter("arguments").countryCode;
            this._sCountryCode = sCountryCode;

            // Bind the view to the country
            this.getView().bindElement({
                path: "/Countries('" + sCountryCode + "')"
            });
            
            // Check Lock
            const hasLock = await this._acquireLockAndProceed(sCountryCode);
            if (!hasLock) return; // Exit early if locked by someone else.

            // Reset active scenario
            this._sActiveScenario = "MM";
            this.getView().getModel("viewModel").setProperty("/currentScenario", "MM");

            // Load mapping data manually to avoid OData binding issues
            this._loadMappingData(sCountryCode);
            this._loadExistingMappings(sCountryCode);
        },

        _acquireLockAndProceed: async function (sCountryCode) {
            const oModel = this.getView().getModel();
            const oAction = oModel.bindContext("/acquireLock(...)");
            oAction.setParameter("countryCode", sCountryCode);
            try {
                this.getView().setBusy(true);
                await oAction.execute();
                const result = oAction.getBoundContext().getObject().value;
                this.getView().setBusy(false);
                if (result !== "OK" && result.startsWith("LOCKED_BY:")) {
                     const user = result.split(":")[1];
                     MessageBox.error(`L'utente ${user} sta attualmente modificando questa Country.`, {
                         onClose: () => {
                             this.getOwnerComponent().getRouter().navTo("RouteMain", {}, true);
                         }
                     });
                     return false;
                }
                return true;
            } catch (err) {
                 this.getView().setBusy(false);
                 MessageBox.error("Errore nell'acquisizione del lock di modifica: " + err.message);
                 return false;
            }
        },

        _releaseLock: async function () {
            if (!this._sCountryCode) return;
            const oModel = this.getView().getModel();
            const oAction = oModel.bindContext("/releaseLock(...)");
            oAction.setParameter("countryCode", this._sCountryCode);
            try {
                await oAction.execute();
            } catch (e) {
                console.error("Failed to release lock", e);
            }
        },

        onNavBack: function () {
            this._releaseLock().finally(() => {
                const sPreviousHash = History.getInstance().getPreviousHash();
                if (sPreviousHash !== undefined) {
                    window.history.go(-1);
                } else {
                    this.getOwnerComponent().getRouter().navTo("RouteMain", {}, true);
                }
            });
        },

        _loadMappingData: async function (sCountryCode) {
            const oView = this.getView();
            oView.setBusy(true);

            const oModel = oView.getModel();

            // 1. Create a list binding with filters + sorters
            const oListBinding = oModel.bindList("/CountryFieldConfig", undefined,
                [new sap.ui.model.Sorter("displayOrder", false)], // sorters
                [new sap.ui.model.Filter("country_code", "EQ", sCountryCode)], // filters
                { 
                    "$expand": "documentAIField,searchHelpFunction"
                } 
            );

            // 2. Request data (returns an array of Contexts)
            try {
                const aContexts = await oListBinding.requestContexts(0, 5000);
                
                const itemsMM = [];
                const itemsFI = [];

                aContexts.forEach(ctx => {
                    const obj = ctx.getObject();
                    if (obj.documentAIField) {
                         obj.documentAIField_sourceType = obj.documentAIField.sourceType || "DOX"; 
                         obj.documentAIField_fieldType = obj.documentAIField.fieldType;
                         obj.documentAIField_fieldName = obj.documentAIField.fieldName || obj.documentAIField_fieldName;
                    } 
                    
                    const scenario = obj.scenario || "MM";
                    if (scenario === "MM") itemsMM.push(obj);
                    else if (scenario === "FI") itemsFI.push(obj);
                });

                if (itemsFI.length === 0 && itemsMM.length > 0) {
                     console.log("[DEBUG] No FI items found on load - initializing FI from MM in memory");
                     const copiedFI = JSON.parse(JSON.stringify(itemsMM));
                     copiedFI.forEach(i => {
                         i.scenario = "FI";
                     });
                     itemsFI.push(...copiedFI);
                }

                const oVM = oView.getModel("viewModel");
                const oConfigs = oVM.getProperty("/configs");
                oConfigs.MM.items = itemsMM;
                oConfigs.FI.items = itemsFI;
                oVM.setProperty("/configs", oConfigs);

                // Load initial
                this._switchScenario(this._sActiveScenario);
                oVM.setProperty("/currentScenario", this._sActiveScenario);

            } catch (e) {
                console.error("Error loading mapping data", e);
                MessageBox.error("Error loading mapping data: " + e.message);
            } finally {
                oView.setBusy(false);
            }
        },
        
        _loadExistingMappings: async function (sCountryCode) {
            const oModel = this.getView().getModel();

            const oListBinding = oModel.bindList("/FieldMappings", undefined, [],
                [new sap.ui.model.Filter("country_code", "EQ", sCountryCode)],
                { 
                    "$expand": "steps($expand=conversionFunction),documentAIField,odataField",
                    "$select": "id,country_code,documentAIField_fieldName,documentAIField_fieldType,documentAIField_sourceType,odataField_id,active,scenario,groupId,aggregationGroupBy,aggregationSum"
                }
            );

            try {
                const aCtx = await oListBinding.requestContexts(0, 5000);
                const aData = aCtx.map(c => c.getObject());
                console.log("[DEBUG] Loaded FieldMappings:", aData.length, aData);

                const mapMM = {};
                const mapFI = {};

                aData.forEach(m => {
                    // Use FKs if available (more robust), fallback to expansion
                    const sFieldName = m.documentAIField_fieldName || (m.documentAIField ? m.documentAIField.fieldName : null);
                    const sFieldType = m.documentAIField_fieldType || (m.documentAIField ? m.documentAIField.fieldType : null);
                    
                    // Ensure the property is set on the object itself for consistency
                    if (!m.documentAIField_fieldName && sFieldName) m.documentAIField_fieldName = sFieldName;
                    if (!m.documentAIField_fieldType && sFieldType) m.documentAIField_fieldType = sFieldType;

                    if (sFieldName && sFieldType) {
                        const sSourceType = m.documentAIField_sourceType || (m.documentAIField ? m.documentAIField.sourceType : "DOX");
                        const scenario = m.scenario || "MM";
                        const key = sFieldName + "_" + sFieldType + "_" + sSourceType + "_" + scenario;
                        
                        const targetMap = (scenario === "FI") ? mapFI : mapMM;

                        if (!targetMap[key]) {
                            targetMap[key] = [];
                        }
                        
                        const steps = (m.steps && m.steps.results) ? m.steps.results : (m.steps || []);
                        
                        // Sort steps by stepOrder ASC to maintain correct execution flow
                        if (Array.isArray(steps)) {
                            steps.sort((a, b) => (a.stepOrder || 0) - (b.stepOrder || 0));
                        }

                        targetMap[key].push({
                            odataField_id: m.odataField_id || (m.odataField ? m.odataField.id : null),
                            odataField: m.odataField,
                            steps: steps,
                            active: m.active,
                            groupId: m.groupId,
                            aggregationGroupBy: m.aggregationGroupBy || false,
                            aggregationSum: m.aggregationSum || false
                        });
                    }
                });

                // Sort multiple mappings for same field by groupId for deterministic order
                Object.keys(mapMM).forEach(k => {
                    mapMM[k].sort((a, b) => (a.groupId || 999) - (b.groupId || 999));
                });
                Object.keys(mapFI).forEach(k => {
                    mapFI[k].sort((a, b) => (a.groupId || 999) - (b.groupId || 999));
                });
                
                console.log(`[DEBUG] Loaded Existing: MM=${Object.keys(mapMM).length}, FI=${Object.keys(mapFI).length}`);

                if (Object.keys(mapFI).length === 0 && Object.keys(mapMM).length > 0) {
                     console.log("[DEBUG] No FI mappings found on load - initializing FI mappings from MM in memory");
                     Object.keys(mapMM).forEach(mmKey => {
                         const fiKey = mmKey.substring(0, mmKey.lastIndexOf("_")) + "_FI";
                         mapFI[fiKey] = JSON.parse(JSON.stringify(mapMM[mmKey]));
                     });
                }

                const oVM = this.getView().getModel("viewModel");
                const oConfigs = oVM.getProperty("/configs");
                
                // Initialize if missing
                if (!oConfigs.MM) oConfigs.MM = { items: [], fieldMappings: {} };
                if (!oConfigs.FI) oConfigs.FI = { items: [], fieldMappings: {} };

                oConfigs.MM.fieldMappings = mapMM;
                oConfigs.FI.fieldMappings = mapFI;
                oVM.setProperty("/configs", oConfigs);
                
                // Force update of current mappings binding
                const sCurrent = oVM.getProperty("/currentScenario") || "MM";
                oVM.setProperty("/fieldMappings", oConfigs[sCurrent].fieldMappings || {});
                
                // Refresh current view (Validation Status)
                this._refreshValidationStatus();

            } catch (e) {
                console.error("Error loading existing mappings", e);
            }
        },

        _switchScenario: function(sScenario) {
            console.log(`[DEBUG] Switching to scenario: ${sScenario}`);
            const oVM = this.getView().getModel("viewModel");
            const oConfigs = oVM.getProperty("/configs");
            const oView = this.getView();
            
            // Ensure config exists for this scenario
            if (!oConfigs[sScenario]) {
                console.warn(`[DEBUG] Config for scenario '${sScenario}' is undefined. Initializing...`);
                oConfigs[sScenario] = { items: [], fieldMappings: {} };
            }

            // Set Mapping Model Items
            let items = oConfigs[sScenario].items || [];
            
            // No automatic copying here anymore. It's handled in _loadMappingData or onImport.

            let oMappingModel = oView.getModel("mappingModel");
            if (!oMappingModel) {
                oMappingModel = new sap.ui.model.json.JSONModel({ items: items });
                oMappingModel.setSizeLimit(5000);
                oView.setModel(oMappingModel, "mappingModel");
            } else {
                oMappingModel.setProperty("/items", items);
            }

            // Set Mappings
            // Ensure we pull the specific object for this scenario
            const newMappings = oConfigs[sScenario].fieldMappings || {};
            console.log(`[DEBUG] Loaded ${Object.keys(newMappings).length} mapped fields for ${sScenario}`);

            oVM.setProperty("/fieldMappings", newMappings);
            
            this._sActiveScenario = sScenario;
            this._refreshValidationStatus();
        },

        onScenarioChange: function(oEvent) {
            let sNewKey = oEvent.getParameter("key");
            if (!sNewKey) {
                const oItem = oEvent.getParameter("item");
                if (oItem) {
                    sNewKey = oItem.getKey();
                }
            }
            if (!sNewKey) {
                sNewKey = oEvent.getSource().getSelectedKey();
            }
            
            console.log(`[DEBUG] onScenarioChange: sNewKey resolved to '${sNewKey}'`);

            if (!sNewKey) {
                console.error("[ERROR] Could not resolve new scenario key!");
                return;
            }
            
            // 1. Save PREVIOUS state to cache (using _sActiveScenario)
            // Ensure we don't save "undefined" if _sActiveScenario was somehow lost
            const sPrev = this._sActiveScenario || "MM";
            this._saveCurrentToCache(sPrev);
            
            // 2. Switch
            this.getView().getModel("viewModel").setProperty("/currentScenario", sNewKey);
            this._switchScenario(sNewKey);
        },

        _saveCurrentToCache: function(sScenarioToSave) {
            const oVM = this.getView().getModel("viewModel");
            // If no scenario provided, default to current (but careful with binding timing)
            // Ideally should always be passed explicitly
            const sCurrent = sScenarioToSave || oVM.getProperty("/currentScenario");
            
            console.log(`[DEBUG] Saving cache for scenario: ${sCurrent}`);

            const oMappingModel = this.getView().getModel("mappingModel");
            
            if (oMappingModel) {
                 const items = oMappingModel.getData().items;
                 const mappings = oVM.getProperty("/fieldMappings");
                 
                 const oConfigs = oVM.getProperty("/configs");
                 
                 // Deep copy mappings to avoid reference issues
                 const mappingsClone = JSON.parse(JSON.stringify(mappings));
                 // Deep copy items? Items are usually replaced 
                 
                 // Ensure we are saving to the correct branch
                 if (!oConfigs[sCurrent]) oConfigs[sCurrent] = { items: [], fieldMappings: {} };

                 oConfigs[sCurrent] = {
                     items: items,
                     fieldMappings: mappingsClone
                 };
                 oVM.setProperty("/configs", oConfigs);
                 console.log(`[DEBUG] Saved ${items.length} items and mappings for ${sCurrent}`);
            }
        },

        _refreshValidationStatus: function() {
                const oVM = this.getView().getModel("viewModel");
                const fieldMappings = oVM.getProperty("/fieldMappings");
                const oMappingModel = this.getView().getModel("mappingModel");

                if (oMappingModel) {
                    const aItems = oMappingModel.getData().items;
                    aItems.forEach(item => {
                        const sScenario = oVM.getProperty("/currentScenario") || "MM";
                        const key = item.documentAIField_fieldName + "_" + item.documentAIField_fieldType + "_" + (item.documentAIField_sourceType || "DOX") + "_" + sScenario;
                        const fieldMappings = oVM.getProperty("/fieldMappings");
                        const mappings = fieldMappings[key] || [];
                        
                        let hasError = false;
                        if (mappings.length > 0) {
                            const broken = mappings.some(m => m.active && !m.odataField_id);
                            if (broken) hasError = true;
                        }
                        
                        item.validationState = hasError ? "Reject" : "Default";
                        item.validationText = hasError ? "Missing OData Field" : "Configure Mappings";
                        item.btnIcon = hasError ? "sap-icon://alert" : "sap-icon://action-settings";
                    });
                    oMappingModel.refresh();
                }
        },

        onExportMappings: async function () {
            const oVM = this.getView().getModel("viewModel");
            // We want to export the entire configuration for all scenarios
            const oConfigs = oVM.getProperty("/configs");
            
            // Ensure we have all conversion functions for resolution
            await this._loadAllConversionFunctions();
            const allConvFuncs = this._allConversionFunctions || [];

            // Helper to enrich mapping lists
            const enrichMappings = (mappings) => {
                const enriched = JSON.parse(JSON.stringify(mappings));
                Object.keys(enriched).forEach(key => {
                    const list = enriched[key];
                    list.forEach(m => {
                        if (m.steps) {
                            m.steps.forEach(step => {
                                // 1. Resolve missing conversionFunction object
                                if (!step.conversionFunction && step.conversionFunction_id) {
                                    const found = allConvFuncs.find(cf => cf.id === step.conversionFunction_id);
                                    if (found) {
                                        step.conversionFunction = found;
                                    }
                                }

                                // 2. Parse functionParameters if string
                                if (step.functionParameters && typeof step.functionParameters === 'string') {
                                    try {
                                        step.functionParameters = JSON.parse(step.functionParameters);
                                    } catch (e) { /* ignore */ }
                                }

                                // 3. Parse inputParams inside conversionFunction if string
                                if (step.conversionFunction && step.conversionFunction.inputParams && typeof step.conversionFunction.inputParams === 'string') {
                                    try {
                                        step.conversionFunction.inputParams = JSON.parse(step.conversionFunction.inputParams);
                                    } catch (e) { /* ignore */ }
                                }
                            });
                        }
                    });
                });
                return enriched;
            };

            const exportConfigs = {};
            
            // Process known scenarios
            ["MM", "FI"].forEach(sType => {
                if (oConfigs[sType]) {
                    exportConfigs[sType] = {
                        items: oConfigs[sType].items || [],
                        fieldMappings: enrichMappings(oConfigs[sType].fieldMappings || {})
                    };
                }
            });

            const exportData = {
                countryCode: this._sCountryCode,
                configs: exportConfigs,       // New Structure
                // Legacy fields for backward compatibility (optional, or just omit)
                // fieldConfig: ...
                // mappings: ...
                version: "2.0" // Marker for new format
            };

            const sJson = JSON.stringify(exportData, null, 2);
            this._downloadFile(sJson, `config_${this._sCountryCode}_FULL.json`);
        },

        _downloadFile: function (content, fileName) {
            const blob = new Blob([content], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },

        onImportMappings: function () {
             const input = document.createElement("input");
             input.type = "file";
             input.accept = ".json";
             input.onchange = (e) => {
                 const file = e.target.files[0];
                 if (!file) return;
                 
                 const reader = new FileReader();
                 reader.onload = (e) => {
                     try {
                         const data = JSON.parse(e.target.result);
                         this._applyImportedData(data);
                     } catch (err) {
                         console.error("Import Error:", err);
                         MessageBox.error("Invalid JSON file or Error during import: " + err.message);
                     }
                 };
                 reader.readAsText(file);
             };
             input.click();
        },

        _applyImportedData: async function (data) {
             const oView = this.getView();
             oView.setBusy(true);
             try {
                if (data.countryCode && data.countryCode !== this._sCountryCode) {
                    MessageBox.warning("Warning: Imported configuration is for country " + data.countryCode);
                }

                // Load Metadata for resolution
                await Promise.all([
                    this._loadAllODataFields(),
                    this._loadAllConversionFunctions()
                ]);

                if (data.configs) {
                    // New Format: contains MM and FI
                    console.log("[DEBUG] Importing full configuration (MM & FI)");
                    const oVM = this.getView().getModel("viewModel");
                    const oConfigs = oVM.getProperty("/configs");

                    // Helper to resolve mappings
                    const resolveMappingsList = (mappingsObj) => {
                         const resolved = {};
                         const oDataFields = this._allODataFields || [];
                         const convFuncs = this._allConversionFunctions || [];

                         Object.keys(mappingsObj).forEach(key => {
                             const mappingList = mappingsObj[key];
                             resolved[key] = mappingList.map(m => {
                                 // 1. Resolve OData Field
                                 let odataId = m.odataField_id;
                                 if (m.odataField) {
                                     const found = oDataFields.find(f => 
                                         f.entityName === m.odataField.entityName && 
                                         f.fieldName === m.odataField.fieldName
                                     );
                                     if (found) {
                                         odataId = found.id;
                                         m.odataField = found;
                                     }
                                 }

                                 // 2. Resolve Conversion Functions
                                 if (m.steps) {
                                     m.steps.forEach(step => {
                                         let funcId = step.conversionFunction_id;
                                         if (step.conversionFunction) {
                                             const foundFunc = convFuncs.find(cf => cf.name === step.conversionFunction.name);
                                             if (foundFunc) {
                                                 funcId = foundFunc.id;
                                                 step.conversionFunction = foundFunc;
                                             }
                                         }
                                         step.conversionFunction_id = funcId;
                                         
                                         if (step.functionParameters && typeof step.functionParameters === 'object') {
                                             step.functionParameters = JSON.stringify(step.functionParameters);
                                         }
                                     });
                                 }
                                 return { ...m, odataField_id: odataId };
                             });
                         });
                         return resolved;
                    };

                    ["MM", "FI"].forEach(sType => {
                        if (data.configs[sType]) {
                            // Merge or overwrite items
                            const importedItems = data.configs[sType].items || [];
                            // We might want to preserve some local state, but usually import overwrites
                            // Ensure scenario is set correctly
                            importedItems.forEach(i => i.scenario = sType);
                            
                            // Resolve Mappings
                            const importedMappings = resolveMappingsList(data.configs[sType].fieldMappings || {});

                            if (!oConfigs[sType]) oConfigs[sType] = {};
                            oConfigs[sType].items = importedItems;
                            oConfigs[sType].fieldMappings = importedMappings;
                        }
                    });

                    oVM.setProperty("/configs", oConfigs);
                    
                    // Force refresh of current view
                    this._switchScenario(this._sActiveScenario || "MM");
                    MessageBox.success("Configuration imported successfully (MM & FI).");
                    
                } else if (data.mappings) {
                    // Legacy Format (Single Scenario)
                    const resolvedMappings = {};
                    const oDataFields = this._allODataFields || [];
                    const convFuncs = this._allConversionFunctions || [];

                    // Iterate over imported mappings to resolve IDs
                    Object.keys(data.mappings).forEach(key => {
                        const mappingList = data.mappings[key];
                        resolvedMappings[key] = mappingList.map(m => {
                            // 1. Resolve OData Field
                            let odataId = m.odataField_id;
                            if (m.odataField) {
                                // Try to find by Entity + Field Name
                                const found = oDataFields.find(f => 
                                    f.entityName === m.odataField.entityName && 
                                    f.fieldName === m.odataField.fieldName
                                );
                                if (found) {
                                    odataId = found.id;
                                    m.odataField = found; // Update with local object
                                }
                            }

                            // 2. Resolve Conversion Functions in Steps
                            if (m.steps && m.steps.length > 0) {
                                m.steps.forEach(step => {
                                    let funcId = step.conversionFunction_id;
                                    if (step.conversionFunction) {
                                        const foundFunc = convFuncs.find(cf => cf.name === step.conversionFunction.name);
                                        if (foundFunc) {
                                            funcId = foundFunc.id;
                                            step.conversionFunction = foundFunc;
                                        }
                                    }
                                    step.conversionFunction_id = funcId;

                                    // Handle stringify of functionParameters if object (from new export format)
                                    if (step.functionParameters && typeof step.functionParameters === 'object') {
                                        step.functionParameters = JSON.stringify(step.functionParameters);
                                    }
                                });
                            }

                            return {
                                ...m,
                                odataField_id: odataId
                            };
                        });
                    });

                    this.getView().getModel("viewModel").setProperty("/fieldMappings", resolvedMappings);

                }
                
                if (data.fieldConfig) {
                    const oMappingModel = this.getView().getModel("mappingModel");
                    if (oMappingModel) {
                       oMappingModel.setProperty("/items", data.fieldConfig);
                    }
                }
                
                MessageToast.show("Configuration imported. Don't forget to Save.");
             } catch (e) {
                 console.error("Apply Import Error", e);
                 MessageBox.error("Error applying imported data: " + e.message);
             } finally {
                 oView.setBusy(false);
             }
        },

        _loadAllODataFields: async function() {
            if (this._allODataFields) return;
            const oModel = this.getView().getModel();
            const oListBinding = oModel.bindList("/ODataFields");
            const aCtx = await oListBinding.requestContexts(0, 5000);
            this._allODataFields = aCtx.map(c => c.getObject());
        },

        _loadAllConversionFunctions: async function() {
            if (this._allConversionFunctions) return;
            const oModel = this.getView().getModel();
            const oListBinding = oModel.bindList("/ConversionFunctions");
            const aCtx = await oListBinding.requestContexts(0, 5000);
            this._allConversionFunctions = aCtx.map(c => c.getObject());
        },

        onEditMapping: function (oEvent) {
            // Supports both tables as they share the same model/items via View model
            var oItem = oEvent.getSource().getBindingContext("mappingModel").getObject();
            var sDocField = oItem.documentAIField_fieldName;
            var sFieldType = oItem.documentAIField_fieldType;
            var sSourceType = oItem.documentAIField_sourceType || "DOX";
            var oVM = this.getView().getModel("viewModel");
            var sScenario = oVM.getProperty("/currentScenario") || "MM";
            var key = sDocField + "_" + sFieldType + "_" + sSourceType + "_" + sScenario;

            var oMappings = oVM.getProperty("/fieldMappings") || {};
            var currentMappings = oMappings[key];

            var aMappingsClone = currentMappings ? JSON.parse(JSON.stringify(currentMappings)) : [];
            
            var oCurrentFieldModel = new JSONModel({
                fieldName: sDocField,
                fieldType: sFieldType,
                sourceType: oItem.documentAIField_sourceType || "DOX",
                mappings: aMappingsClone
            });

            if (!this._oMappingDialog) {
                this._oMappingDialog = sap.ui.xmlfragment("configcountry.view.MappingDialog", this);
                this.getView().addDependent(this._oMappingDialog);
            }

            this._oMappingDialog.setModel(oCurrentFieldModel, "currentFieldModel");
            this._oMappingDialog.open();
        },

        onDeleteField: function(oEvent) {
            const oButton = oEvent.getSource();
            const oContext = oButton.getBindingContext("mappingModel");
            
            if (!oContext) {
                MessageBox.error("Unable to determine field context");
                return;
            }

            const oData = oContext.getObject();
            const sFieldName = oData.documentAIField_fieldName;
            const sFieldType = oData.documentAIField_fieldType;
            const sSourceType = oData.documentAIField_sourceType || "DOX";
            
            // Check for associated mappings
            const oVM = this.getView().getModel("viewModel");
            const sScenario = oVM.getProperty("/currentScenario") || "MM";
            const sKey = sFieldName + "_" + sFieldType + "_" + sSourceType + "_" + sScenario;
            const aMappings = oVM.getProperty("/fieldMappings/" + sKey) || [];
            
            let sMessage = "Are you sure you want to delete the field '" + sFieldName + "'?";
            if (aMappings.length > 0) {
                 sMessage += "\n\nThis will also delete " + aMappings.length + " associated mapping(s).";
            }
            
            MessageBox.confirm(
                sMessage,
                {
                    title: "Confirm Deletion",
                    onClose: function(sAction) {
                        if (sAction === MessageBox.Action.OK) {
                            const sPath = oContext.getPath();
                            const oModel = this.getView().getModel("mappingModel");
                            const aItems = oModel.getProperty("/items");
                            const iIndex = parseInt(sPath.split("/").pop());
                            
                            aItems.splice(iIndex, 1);
                            oModel.setProperty("/items", aItems);
                            
                            MessageToast.show("Field deleted. Remember to save changes.");
                        }
                    }.bind(this)
                }
            );
        },


        onAddMappingRow: function () {
            var oModel = this._oMappingDialog.getModel("currentFieldModel");
            var aMappings = oModel.getProperty("/mappings");
            aMappings.push({ active: true, aggregationGroupBy: false, aggregationSum: false });
            oModel.setProperty("/mappings", aMappings);
        },

        onDeleteMappingRow: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var sPath = oItem.getBindingContext("currentFieldModel").getPath();
            var iIndex = parseInt(sPath.split("/").pop());
            
            var oModel = this._oMappingDialog.getModel("currentFieldModel");
            var aMappings = oModel.getProperty("/mappings");
            aMappings.splice(iIndex, 1);
            oModel.setProperty("/mappings", aMappings);
        },

        onApplyMappingChanges: function () {
            var oModel = this._oMappingDialog.getModel("currentFieldModel");
            var oData = oModel.getData();
            var oVM = this.getView().getModel("viewModel");
            var sScenario = oVM.getProperty("/currentScenario") || "MM";
            var key = oData.fieldName + "_" + oData.fieldType + "_" + (oData.sourceType || "DOX") + "_" + sScenario;
            
            var oMappings = oVM.getProperty("/fieldMappings") || {};
            oMappings[key] = oData.mappings;
            oVM.setProperty("/fieldMappings", oMappings);
            
            this._oMappingDialog.close();
        },

        onCancelMappingDialog: function () {
            this._oMappingDialog.close();
        },

        // --- Company Codes Logic ---

        onAddCompanyCode: function() {
            var oTable = this.byId("companyCodesTable");
            var oBinding = oTable.getBinding("items");
            var oContext = oBinding.create({
                code: "",
                description: ""
            });
            // Focus new row if needed
            oTable.getItems().some(function (oItem) {
                if (oItem.getBindingContext() === oContext) {
                    oItem.focus();
                    return true;
                }
                return false;
            });
        },

        onDeleteCompanyCode: function(oEvent) {
            var oContext = oEvent.getParameter("listItem").getBindingContext();
            oContext.delete("companyCodesGroup").then(function() {
                sap.m.MessageToast.show("Company Code deleted");
            }).catch(function(oError) {
                sap.m.MessageBox.error("Error deleting Company Code: " + oError.message);
            });
        },

        onSaveCompanyCodes: function() {
            var oModel = this.getView().getModel();
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            this.getView().setBusy(true);
            oModel.submitBatch("companyCodesGroup").then(function() {
                sap.m.MessageToast.show(oBundle.getText("msgSaved"));
            }).catch(function(oError) {
                sap.m.MessageBox.error(oBundle.getText("msgError") + ": " + oError.message);
            }).finally(function() {
                this.getView().setBusy(false);
            }.bind(this));
        },

        // --- Steps & Chaining Logic ---

        onConfigureSteps: async function (oEvent) {
            const oButton = oEvent.getSource();
            const oCtx = oButton.getBindingContext("currentFieldModel");
            const sPath = oCtx.getPath();
            const oMappingItem = oCtx.getObject();

            let aSteps = [];
            if (oMappingItem.steps) {
                aSteps = JSON.parse(JSON.stringify(oMappingItem.steps));
            }

            const oStepsModel = new JSONModel({
                steps: aSteps,
                parentPath: sPath
            });

            if (!this._oStepsDialog) {
                this._oStepsDialog = await this.loadFragment({
                    name: "configcountry.view.StepsDialog"
                });
                this.getView().addDependent(this._oStepsDialog);
            }

            this._oStepsDialog.setModel(oStepsModel, "stepsModel");
            this._oStepsDialog.open();
        },

        onAddStep: function () {
            const oModel = this._oStepsDialog.getModel("stepsModel");
            const aSteps = oModel.getProperty("/steps");
            aSteps.push({
                stepOrder: aSteps.length + 1,
                conversionFunction_id: null,
                functionParameters: null
            });
            oModel.setProperty("/steps", aSteps);
        },

        onDeleteStep: function (oEvent) {
             const oItem = oEvent.getParameter("listItem");
             const sPath = oItem.getBindingContext("stepsModel").getPath();
             const iIndex = parseInt(sPath.split("/").pop());
             const oModel = this._oStepsDialog.getModel("stepsModel");
             const aSteps = oModel.getProperty("/steps");
             
             aSteps.splice(iIndex, 1);
             aSteps.forEach((s, i) => s.stepOrder = i + 1);
             oModel.setProperty("/steps", aSteps);
        },

        onMoveStepUp: function(oEvent) {
            this._moveStep(oEvent, -1);
        },
        
        onMoveStepDown: function(oEvent) {
            this._moveStep(oEvent, 1);
        },

        _moveStep: function(oEvent, delta) {
             const oItem = oEvent.getSource().getParent().getParent(); 
             const sPath = oItem.getBindingContext("stepsModel").getPath();
             const iIndex = parseInt(sPath.split("/").pop());
             const oModel = this._oStepsDialog.getModel("stepsModel");
             const aSteps = oModel.getProperty("/steps");

             const newIndex = iIndex + delta;
             if (newIndex < 0 || newIndex >= aSteps.length) return;

             const temp = aSteps[iIndex];
             aSteps[iIndex] = aSteps[newIndex];
             aSteps[newIndex] = temp;

             aSteps.forEach((s, i) => s.stepOrder = i + 1);
             oModel.setProperty("/steps", aSteps);
        },

        onApplySteps: function() {
            const oModel = this._oStepsDialog.getModel("stepsModel");
            const oData = oModel.getData();
            const sParentPath = oData.parentPath;
            
            this._oMappingDialog.getModel("currentFieldModel").setProperty(sParentPath + "/steps", oData.steps);
            this._oStepsDialog.close();
        },

        onCancelSteps: function() {
            this._oStepsDialog.close();
        },

        onConfigureStepParams: async function (oEvent) {
            const oButton = oEvent.getSource();
            const oCtx = oButton.getBindingContext("stepsModel");
            const oStepItem = oCtx.getObject();
            const sFnId = oStepItem.conversionFunction_id;

            if (!sFnId) {
                const oBundle = this.getView().getModel("i18n").getResourceBundle();
                MessageToast.show(oBundle.getText("msgSelectFunction"));
                return;
            }

            let oFnData;
            try {
                const oFnContext = this.getView().getModel().bindContext("/ConversionFunctions(id=" + sFnId + ")");
                oFnData = await oFnContext.requestObject();
            } catch (e) {
                console.error("Error fetching function details", e);
            }

            let aParamDefs = [];
            try {
                if (oFnData && oFnData.inputParams) {
                    const parsed = JSON.parse(oFnData.inputParams);
                    aParamDefs = Array.isArray(parsed) ? parsed : Object.keys(parsed);
                }
            } catch (e) {
                console.error("Invalid inputParams JSON", e);
            }

            let oCurrentParams = {};
            try {
                if (oStepItem.functionParameters) oCurrentParams = JSON.parse(oStepItem.functionParameters);
            } catch (e) { /* ignore */ }

            const oCurrentFieldModel = this._oMappingDialog.getModel("currentFieldModel");
            const sCurrentSourceType = oCurrentFieldModel.getProperty("/sourceType");

            const oMappingModel = this.getView().getModel("mappingModel");
            const aAllFields = oMappingModel ? oMappingModel.getData().items : [];

            const aFilteredFields = aAllFields.filter(f => {
                const fSource = f.documentAIField_sourceType || "DOX";
                return fSource === sCurrentSourceType;
            });

            const oStepsModel = this._oStepsDialog.getModel("stepsModel");
            const aAllSteps = oStepsModel.getProperty("/steps");
            const iCurrentStepIndex = parseInt(oCtx.getPath().split("/").pop());
            
            const aPreviousSteps = [];
            await this._loadAllConversionFunctions();
            const allConvFuncs = this._allConversionFunctions || [];
            
            for (let i = 0; i < iCurrentStepIndex; i++) {
                const step = aAllSteps[i];
                if (step.conversionFunction_id) {
                    const func = allConvFuncs.find(cf => cf.id === step.conversionFunction_id);
                    if (func) {
                        aPreviousSteps.push({
                            stepIndex: i,
                            stepOrder: step.stepOrder,
                            functionName: func.name,
                            outputField: func.outputField || "result"
                        });
                    }
                }
            }

            const oParamModel = new JSONModel({
                paramDefs: aParamDefs,
                values: oCurrentParams,
                mappingPath: oCtx.getPath(),
                modelName: "stepsModel",
                fields: aFilteredFields,
                previousSteps: aPreviousSteps,
                currentStepIndex: iCurrentStepIndex,
                sourceType: sCurrentSourceType
            });
            oParamModel.setSizeLimit(5000);

            if (!this._oParamDialog) {
                this._oParamDialog = await this.loadFragment({
                    name: "configcountry.view.ParameterDialog"
                });
                this.getView().addDependent(this._oParamDialog);
            }

            this._oParamDialog.setModel(oParamModel, "paramModel");
            this._buildDynamicParamUI(aParamDefs, oCurrentParams, this._oParamDialog);
            this._oParamDialog.open();
        },
        
        onSaveParams: function() {
            const oModel = this._oParamDialog.getModel("paramModel");
            const oData = oModel.getData();
            const sPath = oData.mappingPath;
            const sModelName = oData.modelName; 

            const aUiParams = oModel.getProperty("/uiParams") || [];
            const oValues = {};
            aUiParams.forEach(p => {
                oValues[p.name] = {
                    type: p.type,
                    value: p.value
                };
            });

            const sJson = JSON.stringify(oValues);
            
            if (sModelName === "stepsModel") {
                this._oStepsDialog.getModel("stepsModel").setProperty(sPath + "/functionParameters", sJson);
            }
            
            this._oParamDialog.close();
        },

        onAddParameter: function() {
            const oModel = this._oParamDialog.getModel("paramModel");
            const aUiParams = oModel.getProperty("/uiParams") || [];
            
            let iCounter = 1;
            let sNewName = "Param" + iCounter;
            while (aUiParams.some(p => p.name === sNewName)) {
                iCounter++;
                sNewName = "Param" + iCounter;
            }
            
            aUiParams.push({
                name: sNewName,
                type: "STATIC",
                value: "",
                isFixed: false
            });
            oModel.setProperty("/uiParams", aUiParams);
        },

        onCancelParams: function() {
            this._oParamDialog.close();
        },

        _buildDynamicParamUI: function(aDefs, oValues, oDialog) {
            const oVBox = sap.ui.getCore().byId("vboxParams") || oDialog.getContent()[0]; 
            oVBox.destroyItems();

            const oParamModel = oDialog.getModel("paramModel");
            let aCurrentParams = oParamModel.getProperty("/uiParams");
            
            if (!aCurrentParams) {
                aCurrentParams = [];
                const paramNames = Array.isArray(aDefs) ? aDefs : Object.keys(aDefs);
                paramNames.forEach(pName => {
                     const sVal = oValues[pName];
                     let sType = "STATIC";
                     let sValue = "";
                     
                     if (sVal && typeof sVal === 'object') {
                         sType = sVal.type;
                         sValue = sVal.value;
                     } 
                     
                     aCurrentParams.push({
                         name: pName,
                         type: sType,
                         value: sValue,
                         isFixed: true
                     });
                });
                
                Object.keys(oValues).forEach(key => {
                    if (!aDefs.includes(key)) {
                         const sVal = oValues[key];
                         let sType = "STATIC";
                         let sValue = "";
                         if (sVal && typeof sVal === 'object') {
                             sType = sVal.type;
                             sValue = sVal.value;
                         } 
                         aCurrentParams.push({
                            name: key,
                            type: sType,
                            value: sValue,
                            isFixed: false
                        });
                    }
                });
                oParamModel.setProperty("/uiParams", aCurrentParams);
            }

            // Access field list for ComboBox using View model
            // REFACTOR: Use fields passed in paramModel
            // const oMappingModel = this.getView().getModel("mappingModel");
            // const aFields = oMappingModel ? oMappingModel.getData().items : [];
            // oParamModel.setProperty("/fields", aFields);

            oVBox.bindAggregation("items", {
                path: "paramModel>/uiParams",
                factory: function(sId, oContext) {
                    const sBasePath = oContext.getPath();
                    const sName = oContext.getProperty("name");
                    const bFixed = oContext.getProperty("isFixed");

                    const oItemVBox = new sap.m.VBox({ class: "sapUiTinyMarginBottom" });
                    
                    const oHeaderBox = new sap.m.HBox({ justifyContent: "SpaceBetween", alignItems: "Center" });
                    oHeaderBox.addItem(new sap.m.Label({ text: "{paramModel>name}", design: "Bold" }));
                    
                    if (!bFixed) {
                        oHeaderBox.addItem(new sap.m.Button({
                            icon: "sap-icon://delete",
                            type: "Transparent",
                            press: function() {
                                const aUiParams = oParamModel.getProperty("/uiParams");
                                const iIdx = parseInt(sBasePath.split("/").pop());
                                aUiParams.splice(iIdx, 1);
                                oParamModel.setProperty("/uiParams", aUiParams);
                            }
                        }));
                    }
                    oItemVBox.addItem(oHeaderBox);

                    const oResourceBundle = oDialog.getModel("i18n").getResourceBundle();

                    const oControlsBox = new sap.m.HBox({ width: "100%", alignItems: "Center" });

                    if (sName === "Operator") {
                         // SPECIAL HANDLING FOR OPERATOR
                         const oSelectOp = new sap.m.Select({
                             width: "100%",
                             selectedKey: "{paramModel>value}",
                             items: [
                                 { key: "EQ", text: "=" },
                                 { key: "NE", text: "!=" },
                                 { key: "GT", text: ">" },
                                 { key: "GE", text: ">=" },
                                 { key: "LT", text: "<" },
                                 { key: "LE", text: "<=" },
                                 { key: "CONTAINS", text: "Contains" },
                                 { key: "NOT_CONTAINS", text: "Not Contains" },
                                 { key: "STARTS_WITH", text: "Starts With" },
                                 { key: "ENDS_WITH", text: "Ends With" },
                                 { key: "ISEMPTY", text: "Is Empty" }
                             ],
                             change: function(oEvent) {
                                 // Force update to model? Binding should handle it.
                                 // paramModel>type is irrelevant for Operator, assume Static/Const
                             }
                         });
                         oControlsBox.addItem(oSelectOp);
                         
                         // Force type to STATIC invisible
                         // Maybe we can just ignore the type selector for Operator
                    } else {
                        const oSelect = new sap.m.Select({
                            width: "140px",
                            selectedKey: "{paramModel>type}",
                            items: [
                                { key: "STATIC", text: oResourceBundle.getText("lblStaticValue") },
                                { key: "FIELD", text: oResourceBundle.getText("lblSchemaField") },
                                { key: "STEP_OUTPUT", text: oResourceBundle.getText("lblStepOutput") }
                            ]
                        });
                        if (oParamModel.getProperty("/sourceType") === "XML") {
                            oSelect.addItem(new sap.ui.core.Item({ key: "TAG_PROPERTY", text: oResourceBundle.getText("lblTagProperty") || "Tag Property" }));
                        }
                        oControlsBox.addItem(oSelect);
                    }

                    const oInputStatic = new sap.m.Input({
                        width: "100%",
                        value: "{paramModel>value}",
                        visible: "{= ${paramModel>name} !== 'Operator' && (${paramModel>type} === 'STATIC' || ${paramModel>type} === 'TAG_PROPERTY') }",
                        placeholder: oResourceBundle.getText("lblValue") + "..."
                    }).addStyleClass("sapUiTinyMarginBegin");
                    oControlsBox.addItem(oInputStatic);

                    const oComboField = new sap.m.ComboBox({
                        width: "70%",
                        selectedKey: "{paramModel>value}",
                        visible: "{= ${paramModel>name} !== 'Operator' && ${paramModel>type} === 'FIELD' }",
                        items: {
                            path: "paramModel>/fields",
                            template: new sap.ui.core.Item({
                                key: "{paramModel>documentAIField_fieldName}",
                                text: "{paramModel>documentAIField_fieldName} ({paramModel>documentAIField_fieldType})"
                            }),
                            templateShareable: false
                        },
                        placeholder: "Select a field..."
                    }).addStyleClass("sapUiTinyMarginBegin");
                    oControlsBox.addItem(oComboField);

                    const oComboStepOutput = new sap.m.ComboBox({
                        width: "70%",
                        selectedKey: "{paramModel>value}",
                        visible: "{= ${paramModel>name} !== 'Operator' && ${paramModel>type} === 'STEP_OUTPUT' }",
                        items: {
                            path: "paramModel>/previousSteps",
                            template: new sap.ui.core.Item({
                                key: "{paramModel>stepIndex}",
                                text: "Step {paramModel>stepOrder}: {paramModel>functionName} → {paramModel>outputField}"
                            }),
                            templateShareable: false
                        },
                        placeholder: "Select previous step output..."
                    }).addStyleClass("sapUiTinyMarginBegin");
                    oControlsBox.addItem(oComboStepOutput);

                    oItemVBox.addItem(oControlsBox);
                    return oItemVBox;
                }
            });
        },

        onUploadSchema: function () {
            const oFileUploader = this.byId("fileUploaderSchema");
            const oFile = oFileUploader.oFileUpload.files[0];

            if (!oFile) {
                MessageToast.show("Please select a JSON schema file first.");
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const oSchema = JSON.parse(e.target.result);
                    


                    let iCount = 0;
                    // Assuming schema structure: { properties: { ... } } or similar
                    // Adapting generic parsing
                    // Parse Document AI Schema Structure
                    const processDoxFields = (aFields, sType) => {
                        if (aFields && Array.isArray(aFields)) {
                            aFields.forEach(field => {
                                const sName = field.name || field.fieldName;
                                if (sName) {
                                    this._addNewField(sName, sType, "DOX", field.description);
                                    iCount++;
                                }
                            });
                        }
                    };

                    if (oSchema.headerFields || oSchema.lineItemFields) {
                        // Standard Document AI Schema
                        processDoxFields(oSchema.headerFields, "header");
                        processDoxFields(oSchema.lineItemFields, "lineItem");
                    } else {
                        // Fallback to legacy generic parsing
                        const processFields = (obj, prefix = "") => {
                            for (const key in obj) {
                                if (obj.hasOwnProperty(key)) {
                                    const sName = prefix ? prefix + "." + key : key;
                                    this._addNewField(sName, "header", "DOX");
                                    iCount++;
                                }
                            }
                        };

                        if (oSchema.properties) {
                            processFields(oSchema.properties);
                        } else if (Array.isArray(oSchema)) {
                            oSchema.forEach(f => {
                                const sName = typeof f === 'string' ? f : (f.name || f.fieldName);
                                const sType = (typeof f === 'object' && f.fieldType) ? f.fieldType : "header";
                                const sDesc = (typeof f === 'object' && f.description) ? f.description : "";
                                if (sName) {
                                    this._addNewField(sName, sType, "DOX", sDesc);
                                    iCount++;
                                }
                            });
                        } else {
                            processFields(oSchema);
                        }
                    }
                    MessageToast.show(`Loaded ${iCount} fields from Schema and Schema ID updated.`);

                } catch (err) {
                    MessageBox.error("Error parsing JSON Schema: " + err.message);
                }
            };
            reader.readAsText(oFile);
        },

        onUploadEdmx: function () {
             const oFileUploader = this.byId("fileUploaderEdmx");
             const oFile = oFileUploader.oFileUpload.files[0];
 
             if (!oFile) {
                 MessageToast.show("Please select an EDMX file first.");
                 return;
             }
 
             const reader = new FileReader();
             reader.onload = async (e) => {
                 const sContent = e.target.result;
                 // Call backend action
                 this.getView().setBusy(true);
                 try {
                     const oModel = this.getView().getModel();
                     const oAction = oModel.bindContext("/loadODataEDMX(...)");
                     oAction.setParameter("countryCode", this._sCountryCode);
                     oAction.setParameter("edmxContent", sContent);
                     
                     await oAction.execute();
                     const result = oAction.getBoundContext().getObject();
                     
                     MessageToast.show(result.message || "Metadata loaded successfully.");
                 } catch (err) {
                     MessageBox.error("Error loading metadata: " + err.message);
                 } finally {
                     this.getView().setBusy(false);
                 }
             };
             reader.readAsText(oFile);
        },

        onXmlFieldTypeChange: function (oEvent) {
            this._handleFieldTypeChange(oEvent);
        },

        onDoxFieldTypeChange: function (oEvent) {
            this._handleFieldTypeChange(oEvent);
        },

        _handleFieldTypeChange: function (oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            if (!oItem) return;

            const sNewType = oItem.getKey();
            const oContext = oEvent.getSource().getBindingContext("mappingModel");
            const sFieldName = oContext.getProperty("documentAIField_fieldName");
            const sSourceType = oContext.getProperty("documentAIField_sourceType") || "DOX";

            const oVM = this.getView().getModel("viewModel");
            const oMappings = oVM.getProperty("/fieldMappings") || {};
            const sScenario = oVM.getProperty("/currentScenario") || "MM";
            const newKey = sFieldName + "_" + sNewType + "_" + sSourceType + "_" + sScenario;

            Object.keys(oMappings).forEach(key => {
                if (key.startsWith(sFieldName + "_") && key.includes("_" + sSourceType + "_")) {
                    const currentMappings = oMappings[key];
                    if (key !== newKey) {
                        oVM.setProperty("/fieldMappings/" + newKey, currentMappings);
                        delete oMappings[key];
                    }
                }
            });
        },

        onUploadXmlSample: function () {
            const oFileUploader = this.byId("fileUploaderXml");
            const oFile = oFileUploader.oFileUpload.files[0];
            const sRefTag = this.byId("inputXmlRefTag").getValue().trim();

            if (!oFile) {
                MessageToast.show("Please select an XML file first.");
                return;
            }

            const reader = new FileReader();
            reader.onload = async (e) => {
                const sXml = e.target.result;
                this.getView().setBusy(true);
                try {
                    const oModel = this.getView().getModel();
                    const oAction = oModel.bindContext("/detectFieldsFromXml(...)");
                    oAction.setParameter("xmlContent", sXml);
                    oAction.setParameter("referenceTag", sRefTag); // New Parameter

                    await oAction.execute();
                    const resultData = oAction.getBoundContext().getObject().value || "[]";
                    let aFields = [];
                    
                    try {
                        aFields = (typeof resultData === 'string') ? JSON.parse(resultData) : resultData;
                    } catch (e) {
                        console.error("Failed to parse detected fields:", e);
                    }
                    
                    if (aFields.length === 0) {
                        MessageToast.show("No fields detected in the XML sample.");
                    } else {
                        let iCount = 0;
                        aFields.forEach(f => {
                            this._addNewField(f.fieldName, f.fieldType, "XML");
                            iCount++;
                        });
                        MessageToast.show(`Added ${iCount} fields from XML (with auto-detection).`);
                    }
                } catch (err) {
                    MessageBox.error("Error detecting XML fields: " + err.message);
                } finally {
                    this.getView().setBusy(false);
                }
            };
            reader.readAsText(oFile);
        },

        _addNewField: function (sName, sType, sSourceType, sDescription) {
            var oView = this.getView();
            var oModel = oView.getModel("mappingModel");
            if (!oModel) {
                oModel = new sap.ui.model.json.JSONModel({ items: [] });
                oModel.setSizeLimit(5000);
                oView.setModel(oModel, "mappingModel");
            }
            var aData = oModel.getData().items || [];
            
            // Check if exists
            var iIndex = aData.findIndex(function (item) {
                return item.documentAIField_fieldName === sName && item.documentAIField_fieldType === sType;
            });

            var newItem = {
                documentAIField_fieldName: sName,
                documentAIField_fieldType: sType,
                documentAIField_sourceType: sSourceType || (sType.includes("DOX") ? "DOX" : "XML"),
                documentAIField_description: sDescription || "",
                visible: true,
                active: true,
                mandatory: false,
                editable: true
            };

            if (iIndex >= 0) {
                // UPDATE existing
                // We keep 'visible' and 'mandatory' from existing, but update source/type if needed
                var existing = aData[iIndex];
                newItem.visible = existing.visible;
                newItem.active = existing.active;
                newItem.mandatory = existing.mandatory;
                newItem.scenario = existing.scenario; 
                
                // PROTECTION: If existing field is DOX, keep it DOX. 
                // This prevents "converting" a standard field to XML-only when mapping it for XML.
                if (existing.documentAIField_sourceType === "DOX") {
                    newItem.documentAIField_sourceType = "DOX";
                }
                
                aData[iIndex] = newItem;
            } else {
                // INSERT new
                aData.push(newItem);
            }
            
            oModel.setProperty("/items", aData);
        },

        onSave: async function () {
            try {
                // 1. Sync current view to cache
                this._saveCurrentToCache();
                
                const oViewModel = this.getView().getModel("viewModel");
                const oConfigs = oViewModel.getProperty("/configs");
                const sCountryCode = this._sCountryCode;
                const sXmlRefTag = this.byId("inputXmlRefTag").getValue().trim(); // Get reference tag
                const sXmlPoRefTag = this.byId("selectXmlPoRefTag").getSelectedKey() || ""; // Get PO reference tag from select
                const sXmlVendorTag = this.byId("selectXmlVendorTag").getSelectedKey() || "";
                const sXmlInvoiceNumberTag = this.byId("selectXmlInvoiceNumberTag").getSelectedKey() || "";
                const sXmlCompanyCodeTag = this.byId("selectXmlCompanyCodeTag").getSelectedKey() || "";
                const sAiModel = this.byId("inputAiModel").getValue().trim();
                const fAiTemperature = parseFloat(this.byId("inputAiTemperature").getValue()) || 0.0;

                let aAllConfigurations = [];

                // Sync XML fields has been removed to allow independent management of MM and FI scenarios.

                // Process both scenarios
                ["MM", "FI"].forEach(sType => {
                    const items = oConfigs[sType].items || [];
                    const mappings = oConfigs[sType].fieldMappings || {};
                    
                    const aConfigData = items.map(item => {
                        const sSource = item.documentAIField_sourceType || "DOX";
                        const key = item.documentAIField_fieldName + "_" + item.documentAIField_fieldType + "_" + sSource + "_" + sType;
                        const mappingsForItem = mappings[key] || [];

                        return {
                            fieldName: item.documentAIField_fieldName,
                            fieldType: item.documentAIField_fieldType,
                            sourceType: item.documentAIField_sourceType || "DOX",
                            description: item.documentAIField_description,
                            visible: item.visible,
                            active: item.active,
                            mandatory: item.mandatory,
                            toBeControlled: item.toBeControlled,
                            editable: item.editable !== false,
                            customLabel: item.customLabel,
                            scenario: sType,
                            searchHelpFunction_id: item.searchHelpFunction_id,
                            searchHelpInputMapping: item.searchHelpInputMapping,
                            mappings: mappingsForItem.map(m => ({
                                odataField_id: m.odataField_id,
                                steps: (m.steps || []).map(s => ({
                                    stepOrder: s.stepOrder,
                                    conversionFunction_id: s.conversionFunction_id,
                                    functionParameters: s.functionParameters
                                })),
                                active: m.active,
                                groupId: m.groupId,
                                aggregationGroupBy: m.aggregationGroupBy || false,
                                aggregationSum: m.aggregationSum || false
                            }))
                        };
                    });
                     
                    aAllConfigurations = aAllConfigurations.concat(aConfigData);
                });

                const sConfigurationData = JSON.stringify(aAllConfigurations);
                const oModel = this.getView().getModel();
                this.getView().setBusy(true);

                const oAction = oModel.bindContext("/saveConfiguration(...)");
                oAction.setParameter("countryCode", sCountryCode);
                oAction.setParameter("configuration", sConfigurationData);
                oAction.setParameter("xmlReferenceTag", sXmlRefTag); // pass reference tag
                oAction.setParameter("xmlPoReferenceTag", sXmlPoRefTag); // pass PO reference tag
                oAction.setParameter("xmlVendorTag", sXmlVendorTag);
                oAction.setParameter("xmlInvoiceNumberTag", sXmlInvoiceNumberTag);
                oAction.setParameter("xmlCompanyCodeTag", sXmlCompanyCodeTag);
                oAction.setParameter("aiModel", sAiModel);
                oAction.setParameter("aiTemperature", fAiTemperature);

                try {
                    await oAction.execute();
                    const result = oAction.getBoundContext().getObject();
                    this.getView().setBusy(false);
                    MessageBox.success(result.value || "Configuration saved successfully");
                    oModel.refresh();
                } catch (err) {
                    this.getView().setBusy(false);
                    MessageBox.error("Error saving configuration: " + err.message);
                }

            } catch (e) {
                MessageBox.error("Error in onSave: " + e.message);
                console.error(e);
            }
        },

        onOpenSearchHelpMapping: function (oEvent) {
            var oButton = oEvent.getSource();
            var oContext = oButton.getBindingContext("mappingModel");
            var oRowData = oContext.getObject();
            var that = this;

            if (!oRowData.searchHelpFunction_id) {
                sap.m.MessageToast.show("Please select a Search Help function first.");
                return;
            }

            // Find the selected Conversion Function to read its inputParams
            var oConfigModel = this.getOwnerComponent().getModel();
            var oBinding = oConfigModel.bindContext("/ConversionFunctions(" + oRowData.searchHelpFunction_id + ")");
            oBinding.requestObject().then(function (oFunction) {
                if (!oFunction || !oFunction.inputParams) {
                    sap.m.MessageToast.show("This Search Help function does not have input parameters defined.");
                    return;
                }

                // Parse input params
                var oInputParams = {};
                try {
                    oInputParams = JSON.parse(oFunction.inputParams);
                } catch (e) {
                    console.error("Error parsing inputParams", e);
                    sap.m.MessageToast.show("Invalid JSON in inputParams for this Search Help.");
                    return;
                }

                // Parse existing mappings on the row
                var oExistingMap = {};
                if (oRowData.searchHelpInputMapping) {
                    try {
                        oExistingMap = JSON.parse(oRowData.searchHelpInputMapping);
                    } catch (e) {
                        console.error("Error parsing existing searchHelpInputMapping", e);
                    }
                }

                // Build local model data
                var aParams = [];
                var aParamKeys = [];
                var fGetLabel = function(k) { return k; };

                if (Array.isArray(oInputParams)) {
                    aParamKeys = oInputParams;
                } else if (typeof oInputParams === "object" && oInputParams !== null) {
                    aParamKeys = Object.keys(oInputParams);
                    fGetLabel = function(k) { return oInputParams[k] || k; };
                }

                aParamKeys.forEach(function (key) {
                    var sLabel = fGetLabel(key);
                    var oMap = oExistingMap[key] || { type: "schema", value: "" };
                    aParams.push({
                        key: key,
                        label: sLabel,
                        type: oMap.type,
                        value: oMap.value
                    });
                });

                // Get available schema fields for the current scenario
                var oViewModel = that.getView().getModel("viewModel");
                var sScenario = oRowData.scenario || "MM";
                var sSourceType = oRowData.documentAIField_sourceType || "DOX";
                var oConfigs = oViewModel.getProperty("/configs/" + sScenario + "/items") || [];
                
                var aAvailableFields = [];
                oConfigs.forEach(function(item) {
                    if (item.documentAIField_sourceType === sSourceType) {
                        aAvailableFields.push({
                            key: item.documentAIField_fieldName,
                            text: item.customLabel || item.documentAIField_description || item.documentAIField_fieldName
                        });
                    }
                });

                var oDialogModel = new sap.ui.model.json.JSONModel({
                    parameters: aParams,
                    availableFields: aAvailableFields,
                    currentRowBinding: oContext.getPath()
                });
                oDialogModel.setSizeLimit(5000);

                if (!that._oSearchHelpDialog) {
                    sap.ui.core.Fragment.load({
                        id: that.getView().getId(),
                        name: "configcountry.view.SearchHelpMappingDialog",
                        controller: that
                    }).then(function (oDialog) {
                        that._oSearchHelpDialog = oDialog;
                        that.getView().addDependent(oDialog);
                        that._oSearchHelpDialog.setModel(oDialogModel, "searchHelpMapModel");
                        that._oSearchHelpDialog.open();
                    });
                } else {
                    that._oSearchHelpDialog.setModel(oDialogModel, "searchHelpMapModel");
                    that._oSearchHelpDialog.open();
                }

            }).catch(function (err) {
                console.error("Error fetching conversion function details", err);
                sap.m.MessageToast.show("Error loading Search Help details.");
            });
        },

        onCloseSearchHelpMapping: function () {
            if (this._oSearchHelpDialog) {
                this._oSearchHelpDialog.close();
            }
        },

        onSaveSearchHelpMapping: function () {
            var oDialogModel = this._oSearchHelpDialog.getModel("searchHelpMapModel");
            var aParams = oDialogModel.getProperty("/parameters");
            var sBindingPath = oDialogModel.getProperty("/currentRowBinding");

            var oMappingJson = {};
            aParams.forEach(function (param) {
                if (param.value && param.value.trim() !== "") {
                    oMappingJson[param.key] = {
                        type: param.type,
                        value: param.value.trim()
                    };
                }
            });

            // Save JSON string back to row
            var sJsonString = Object.keys(oMappingJson).length > 0 ? JSON.stringify(oMappingJson) : null;
            this.getView().getModel("mappingModel").setProperty(sBindingPath + "/searchHelpInputMapping", sJsonString);
            
            this._saveCurrentToCache();
            this.onCloseSearchHelpMapping();
            sap.m.MessageToast.show("Search Help Mappings applied successfully (Save Configuration to persist).");
        },

        onAddCustomField: function () {
            var that = this;
            if (!this._oNewFieldDialog) {
                this._oNewFieldDialog = new sap.m.Dialog({
                    title: "Add Custom Field",
                    content: [
                        new sap.m.VBox({
                            class: "sapUiSmallMargin",
                            items: [
                                new sap.m.Label({ text: "Field Name", labelFor: "newFieldName" }),
                                new sap.m.Input("newFieldName", { placeholder: "e.g. invoiceNumber or /Invoice/ID" }),
                                new sap.m.Label({ text: "Field Type", labelFor: "newFieldType", class: "sapUiSmallMarginTop" }),
                                new sap.m.Select("newFieldType", {
                                    width: "100%",
                                    items: [
                                        new sap.ui.core.Item({ key: "header", text: "Header" }),
                                        new sap.ui.core.Item({ key: "lineItem", text: "Line Item" })
                                    ]
                                }),
                                new sap.m.Label({ text: "Source Type", labelFor: "newSourceType", class: "sapUiSmallMarginTop" }),
                                new sap.m.Select("newSourceType", {
                                    width: "100%",
                                    items: [
                                        new sap.ui.core.Item({ key: "DOX", text: "Document AI (DOX)" }),
                                        new sap.ui.core.Item({ key: "XML", text: "XML Attribute/XPath" })
                                    ]
                                })
                            ]
                        })
                    ],
                    beginButton: new sap.m.Button({
                        text: "Add",
                        type: "Emphasized",
                        press: function () {
                            var sName = sap.ui.getCore().byId("newFieldName").getValue();
                            var sType = sap.ui.getCore().byId("newFieldType").getSelectedKey();
                            var sSourceType = sap.ui.getCore().byId("newSourceType").getSelectedKey() || "DOX";
                            if (sName && sType) {
                                that._addNewField(sName, sType, sSourceType); 
                                that._oNewFieldDialog.close();
                            } else {
                                sap.m.MessageToast.show("Please fill all fields");
                            }
                        }
                    }),
                    endButton: new sap.m.Button({
                        text: "Cancel",
                        press: function () {
                            that._oNewFieldDialog.close();
                        }
                    })
                });
                this.getView().addDependent(this._oNewFieldDialog);
            }
            this._oNewFieldDialog.open();
        },

        onAddCompanyCode: function () {
            const oTable = this.byId("companyCodesTable");
            const oListBinding = oTable.getBinding("items");
            
            oListBinding.create({
                code: "",
                description: ""
            }, false, false, false);
        },

        onDeleteCompanyCode: function (oEvent) {
            const oItem = oEvent.getParameter("listItem");
            const oContext = oItem.getBindingContext();
            
            oContext.delete().catch(function (error) {
                MessageBox.error("Error deleting company code: " + error.message);
            });
        },

        onDelete: function () {
            var that = this;
            sap.m.MessageBox.confirm("Are you sure you want to delete this Country configuration? This action cannot be undone and will delete all associated mappings.", {
                title: "Confirm Deletion",
                onClose: function (oAction) {
                    if (oAction === sap.m.MessageBox.Action.OK) {
                        that._deleteCountry();
                    }
                }
            });
        },

        _deleteCountry: function () {
            var oContext = this.getView().getBindingContext();
            var that = this;
            
            this.getView().setBusy(true);
            oContext.delete().then(function () {
                that.getView().setBusy(false);
                sap.m.MessageToast.show("Country deleted successfully.");
                
                // Navigate back
                that.getOwnerComponent().getRouter().navTo("RouteMain");
            }).catch(function (error) {
                that.getView().setBusy(false);
                sap.m.MessageBox.error("Error deleting country: " + error.message);
            });
        },

        onSaveCompanyCodes: async function () {
            const oModel = this.getView().getModel();
            
            if (oModel.hasPendingChanges("companyCodesGroup")) {
                try {
                    this.getView().setBusy(true);
                    await oModel.submitBatch("companyCodesGroup");
                    this.getView().setBusy(false);
                    MessageToast.show("Company Codes saved.");
                } catch (e) {
                    this.getView().setBusy(false);
                    MessageBox.error("Error saving company codes: " + e.message);
                }
            } else {
                MessageToast.show("No changes to save.");
            }
        }
    });
});
