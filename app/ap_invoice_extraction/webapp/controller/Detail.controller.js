sap.ui.define([
    "apinvoiceextraction/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/Label",
    "sap/m/Input",
    "sap/m/Column",
    "sap/m/ColumnListItem",
    "sap/m/Text",
    "sap/ui/core/HTML",
    "sap/m/HBox",
    "sap/ui/core/Fragment"
], function (BaseController, JSONModel, MessageToast, MessageBox, Filter, FilterOperator, Label, Input, Column, ColumnListItem, Text, HTML, HBox, Fragment) {
    "use strict";
    return BaseController.extend("apinvoiceextraction.controller.Detail", {
        onInit: function () {
            var oViewModel = new JSONModel({
                busy: false,
                delay: 0,
                headerFields: [],
                itemFields: [],
                hasPdf: false
            });
            this.setModel(oViewModel, "detailView");
            // Model to hold the editable data
            var oDataModel = new JSONModel({
                header: {},
                items: {} // Now an object grouping lists by type: { lineItem: [], withholdingTax: [] }
            });
            this.setModel(oDataModel, "editableData");
            this.getRouter().getRoute("Detail").attachPatternMatched(this._onObjectMatched, this);
        },
        _onObjectMatched: function (oEvent) {
            var sId = oEvent.getParameter("arguments").id;
            this._sId = sId;
            this._initEmptyData();
            this.getModel("detailView").setProperty("/hasPdf", false);

            this.getView().bindElement({
                path: "/DocumentStatusBtp('" + sId + "')",
                parameters: {
                    "$select": "id,fileName,status,statusBtp,registrationStatus,sapErrorLog,createdAt,invoiceNumber,fornitore,extractedData,companyCode,countryCode,documentType"
                }
            });
            var sCountryCode = this.getOwnerComponent().getModel("appView").getProperty("/selectedCountryCode");

            if (sCountryCode) {
                this.getView().setBusy(true);

                // 1. Load Raw Data AND Status first to detect scenario and draft
                this._loadRawDataAndStatus(sId).then(oData => {
                    const sRawData = oData.extractedData;
                    const sRegStatus = oData.registrationStatus;
                    const sStatus = oData.status;
                    this.getModel("detailView").setProperty("/isEditable", sRegStatus !== 'Registered' && sStatus !== 'Posted');
                    const sDocType = oData.documentType;
                    this._loadPdfContent(sId);
                    // 1.5 Fetch configcountry PO Reference Tag to better detect scenario
                    var oConfigModel = this.getOwnerComponent().getModel("config");
                    var oCountryBinding = oConfigModel.bindContext("/Countries('" + sCountryCode + "')");

                    return oCountryBinding.requestObject().then(oCountry => {
                        this._sXmlPoRefTag = oCountry ? oCountry.xmlPoReferenceTag : null;
                        this._sXmlVendorTag = oCountry ? oCountry.xmlVendorTag : null;
                        this._sXmlInvoiceNumberTag = oCountry ? oCountry.xmlInvoiceNumberTag : null;
                        this._sXmlCompanyCodeTag = oCountry ? oCountry.xmlCompanyCodeTag : null;
                        const sXmlPoRefTag = this._sXmlPoRefTag;
                        // 2. Detect Scenario
                        const sScenario = this._detectScenario(sRawData, (sDocType === 'XML'), sXmlPoRefTag);
                        this.getModel("detailView").setProperty("/currentScenario", sScenario);
                        this._updateAggregateEnabled();

                        // 3. Load Country Config (All)
                        return this._loadCountryConfig(sCountryCode).then(oAllConfig => {
                            // 4. Retrieve DocumentType/FileName for filtering
                            var oBinding = this.getView().getElementBinding();
                            var oCtx = oBinding ? oBinding.getBoundContext() : null;

                            let pDocInfo = Promise.resolve({});
                            if (oCtx) {
                                pDocInfo = oCtx.requestProperty(["documentType", "fileName"]).then(res => {
                                    return {
                                        documentType: res[0],
                                        fileName: res[1]
                                    };
                                });
                            }
                            return pDocInfo.then(oDocInfo => {
                                this.getModel("detailView").setProperty("/currentDocumentType", oDocInfo.documentType);
                                this.getModel("detailView").setProperty("/currentFileName", oDocInfo.fileName);
                                const bIsXml = (oDocInfo.documentType && oDocInfo.documentType.toUpperCase().includes("XML")) ||
                                    (oDocInfo.fileName && oDocInfo.fileName.toLowerCase().endsWith(".xml"));
                                this.getModel("detailView").setProperty("/isXml", bIsXml);

                                // 5. Apply Scenario to Config UI
                                const oScenarioConfig = this._applyScenarioConfig(sScenario);

                                // CHECK DRAFT/SAVED DATA STATUS
                                // User Requirement: If status is 'Draft', strictly load saved values and DO NOT re-execute extraction/conversion.
                                if (sRegStatus === 'Draft') {
                                    console.log("Document is in Draft status. Attempting to restore saved values...");
                                    if (this._restoreDraftData(sRawData)) {
                                        console.log("Draft data restored successfully. Skipping extraction.");
                                        this.getView().setBusy(false);
                                        return;
                                    } else {
                                        console.warn("Draft status set but failed to restore data. Falling back to extraction.");
                                    }
                                } else {
                                    // Try restore anyway (e.g. if we just saved but didn't leave page? or arbitrary save)
                                    // But usually, if not Draft, we might want fresh extraction if it's 'New'.
                                    // Let's keep it but prioritize the strict Draft check above.
                                    if (this._restoreDraftData(sRawData)) {
                                        console.log("Restored saved data (Status: " + sRegStatus + ")");
                                        this.getView().setBusy(false);
                                        return;
                                    }
                                }
                                // 6. Skip Simulation on Open (User Requirement: disable formatters/conversions for PDF ONLY)
                                // For XML, execute conversions ONLY if it's the first time (status 'New')
                                const bSkipConversions = bIsXml ? (sRegStatus !== 'New' && sRegStatus !== '' && sRegStatus !== undefined) : true;
                                return this._loadExtractionData(sId, sScenario, bSkipConversions).then(oPayload => {
                                    if (oPayload) {
                                        // Now we have a structured payload, even if raw values are used inside it.
                                        this._mapPayloadToUI(oPayload, oScenarioConfig.mappings, sRawData);
                                    } else {
                                        // Fallback if backend fails entirely?
                                        // Try direct map, but we know it has issues with Header fields if not normalized.
                                        this._mapPayloadToUI({}, oScenarioConfig.mappings, sRawData);
                                    }
                                    this.getView().setBusy(false);
                                }).catch(err => {
                                    console.error("Extraction failed", err);
                                    this.getView().setBusy(false);
                                });
                            });
                        });
                    });
                }).catch(err => {
                    console.error("Error loading data", err);
                    this.getView().setBusy(false);
                });
            } else {
                this.getRouter().navTo("RouteHome");
            }
        },
        _detectScenario: function (sRawData, bIsXml, sXmlPoRefTag) {
            try {
                if (!sRawData) return "MM";
                const oData = (typeof sRawData === 'string') ? JSON.parse(sRawData) : sRawData;
                console.log("[DEBUG_SCENARIO] Data Keys:", Object.keys(oData), "Header Keys:", oData.header ? Object.keys(oData.header) : "N/A");
                // 1. Explicit Scenario (Saved Draft manually switched by user)
                if (oData.scenario) {
                    console.log("[DEBUG_SCENARIO] Restoring explicit scenario from draft:", oData.scenario);
                    return oData.scenario;
                }

                /*
                // OLD LOGIC: Check standard PO fields to auto-switch scenario
                let hasPO = false;
                
                // Determine which tags to search for
                let searchTags = ['purchaseOrderNumber', 'purchaseOrder', 'poNumber'];
                if (bIsXml && sXmlPoRefTag && sXmlPoRefTag.trim() !== '') {
                    searchTags = [sXmlPoRefTag.trim()];
                    console.log("[DEBUG_SCENARIO] Using custom XML PO Reference Tag:", searchTags[0]);
                }
                
                // Check flat format (and Draft format nested in header)
                if (searchTags.some(tag => !!oData[tag])) hasPO = true;
                if (!hasPO && oData.header && searchTags.some(tag => !!oData.header[tag])) hasPO = true;
                // Check headerFields array
                if (!hasPO && Array.isArray(oData.headerFields)) {
                    hasPO = oData.headerFields.some(f => 
                        searchTags.includes(f.name) && 
                        f.value && f.value.trim().length > 0
                    );
                }
                // Check lineItems / items for PO
                if (!hasPO) {
                    const items = oData.items || oData.lineItems;
                    if (Array.isArray(items)) {
                         hasPO = items.some(item => {
                             // Check if item is object (Flat)
                             if (searchTags.some(tag => !!item[tag])) return true;
                             
                             // Check if item is array (DOX field list)
                             if (Array.isArray(item)) {
                                 return item.some(f => 
                                     searchTags.includes(f.name) && 
                                     f.value && f.value.trim().length > 0
                                 );
                             }
                             return false;
                         });
                         if (hasPO) console.log("[DEBUG_SCENARIO] Found PO in Line Items -> MM");
                    }
                }
                return hasPO ? "MM" : "FI";
                */

                // User requested: Switch must be manual, default to MM.
                return "MM";
            } catch (e) {
                return "MM";
            }
        },
        formatEnabled: function (sStatus) {
            // Robust formatter to avoid FormatException in property 'enabled' with Expression Bindings in OData V4
            if (!sStatus) return true;
            return sStatus !== 'Registered';
        },
        _updateAggregateEnabled: function () {
            var oModel = this.getModel("detailView");
            var bEditable = oModel.getProperty("/isEditable") !== false;
            var bIsMM = oModel.getProperty("/currentScenario") === "MM";
            oModel.setProperty("/isAggregateEnabled", bEditable && bIsMM);
        },
        formatErrorEnabled: function (sStatus) {
            return sStatus === 'Error';
        },
        formatDate: function (oDate) {
            if (!oDate) return "";
            if (!(oDate instanceof Date)) {
                // Try convert if string
                oDate = new Date(oDate);
            }
            if (isNaN(oDate.getTime())) return ""; // Invalid Date

            var oDateFormat = sap.ui.core.format.DateFormat.getDateTimeInstance({ style: "medium" });
            return oDateFormat.format(oDate);
        },
        _applyScenarioConfig: function (sScenario) {
            var sDocType = this.getModel("detailView").getProperty("/currentDocumentType");
            var sFileName = this.getModel("detailView").getProperty("/currentFileName");
            var bIsXml = (sDocType && sDocType.toUpperCase().includes("XML")) || (sFileName && sFileName.toLowerCase().endsWith(".xml"));
            if (!bIsXml) {
                // --- LOGICA use_pdf-parse (PDF) ---
                const oDetailModel = this.getModel("detailView");
                const aAllConfigs = oDetailModel.getProperty("/allConfigs") || [];
                const aAllMappings = oDetailModel.getProperty("/allMappings") || [];

                console.log(`[DEBUG_CONFIG] Applying Scenario: '${sScenario}'`);
                console.log(`[DEBUG_CONFIG] CODE_VERSION: Fallback_Fix_v2`);
                console.log(`[DEBUG_CONFIG] Total Configs Available: ${aAllConfigs.length}`);
                if (aAllConfigs.length > 0) {
                    console.log("[DEBUG_CONFIG] Sample Config:", JSON.stringify(aAllConfigs[0]));
                }

                // Filter
                var aScenarioConfigs = aAllConfigs.filter(c => (c.scenario || 'MM') === sScenario);
                console.log(`[DEBUG_CONFIG] Configs for Scenario ${sScenario}: ${aScenarioConfigs.length}`);
                var aScenarioMappings = aAllMappings.filter(m => (m.scenario || 'MM') === sScenario);
                // FALLBACK: If Scenario yields 0 configs (and it's not MM), try MM
                if (aScenarioConfigs.length === 0 && sScenario !== 'MM') {
                    console.warn(`[DEBUG_CONFIG] No field config found for scenario '${sScenario}'. Fallback to 'MM'.`);
                    aScenarioConfigs = aAllConfigs.filter(c => (c.scenario || 'MM') === 'MM');
                    aScenarioMappings = aAllMappings.filter(m => (m.scenario || 'MM') === 'MM');
                    console.log(`[DEBUG_CONFIG] Fallback Configs (MM): ${aScenarioConfigs.length}`);
                }

                var aHeaderFields = [];
                var mItemGroups = {};

                var oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
                var sDocType = this.getModel("detailView").getProperty("/currentDocumentType");
                var sFileName = this.getModel("detailView").getProperty("/currentFileName");

                var bIsXml = (sDocType && sDocType.toUpperCase().includes("XML")) ||
                    (sFileName && sFileName.toLowerCase().endsWith(".xml"));
                aScenarioConfigs.forEach(function (oData) {
                    var oField = oData.documentAIField;
                    if (oField && oField.fieldName) {
                        if (bIsXml) {
                            if (oField.sourceType !== "XML") {
                                return;
                            }
                        } else {
                            if (oField.sourceType === "XML") {
                                return;
                            }
                        }
                        var sI18nKey = "lbl_" + oField.fieldName;
                        var sLabel = oData.customLabel || oField.fieldLabel;
                        if (!oData.customLabel && oResourceBundle.hasText(sI18nKey)) {
                            sLabel = oResourceBundle.getText(sI18nKey);
                        }
                        var oFieldConfig = {
                            fieldName: oField.fieldName,
                            label: sLabel,
                            type: oField.fieldType,
                            mandatory: oData.mandatory,
                            editable: oData.editable !== false,
                            displayOrder: oData.displayOrder,
                            visible: oData.visible,
                            searchHelpFunction: oData.searchHelpFunction,
                            searchHelpInputMapping: oData.searchHelpInputMapping,
                            toBeControlled: oData.toBeControlled
                        };
                        if (oField.fieldType === "header") {
                            aHeaderFields.push(oFieldConfig);
                        } else {
                            if (!mItemGroups[oField.fieldType]) mItemGroups[oField.fieldType] = [];
                            mItemGroups[oField.fieldType].push(oFieldConfig);
                        }
                    }
                });
                aHeaderFields.sort((a, b) => a.displayOrder - b.displayOrder);
                Object.keys(mItemGroups).forEach(k => mItemGroups[k].sort((a, b) => a.displayOrder - b.displayOrder));
                oDetailModel.setProperty("/headerFields", aHeaderFields);
                oDetailModel.setProperty("/itemGroups", mItemGroups);
                oDetailModel.setProperty("/itemFields", mItemGroups['lineItem'] || []);

                this._buildDynamicUI(aHeaderFields, mItemGroups);
                return {
                    mappings: aScenarioMappings
                };
            } else {
                // --- LOGICA xml_logic (XML) ---
                const oDetailModel = this.getModel("detailView");
                const aAllConfigs = oDetailModel.getProperty("/allConfigs") || [];
                const aAllMappings = oDetailModel.getProperty("/allMappings") || [];
                console.log(`[DEBUG_CONFIG] Applying Scenario: '${sScenario}'`);
                console.log(`[DEBUG_CONFIG] CODE_VERSION: Fallback_Fix_v3`);
                console.log(`[DEBUG_CONFIG] Total Configs Available: ${aAllConfigs.length}`);
                if (aAllConfigs.length > 0) {
                    console.log("[DEBUG_CONFIG] Sample Config DocumentAIField:", JSON.stringify(aAllConfigs[0].documentAIField));
                }

                // Filter
                var aScenarioConfigs = aAllConfigs.filter(c => (c.scenario || 'MM') === sScenario);
                console.log(`[DEBUG_CONFIG] Configs for Scenario ${sScenario}: ${aScenarioConfigs.length}`);

                var aScenarioMappings = aAllMappings.filter(m => (m.scenario || 'MM') === sScenario);

                var sDocType = this.getModel("detailView").getProperty("/currentDocumentType");
                var sFileName = this.getModel("detailView").getProperty("/currentFileName");

                // Determine if XML Mode
                var bIsXml = (sDocType && sDocType.toUpperCase().includes("XML")) ||
                    (sFileName && sFileName.toLowerCase().endsWith(".xml"));
                console.log(`[DEBUG_CONFIG] DocumentType: '${sDocType}', FileName: '${sFileName}', IsXml: ${bIsXml}`);

                // FALLBACK: If Scenario yields 0 relevant configs (and it's not MM), try MM
                var aRelevantConfigsFiltered = aScenarioConfigs.filter(c => {
                    if (!c.documentAIField) return false;
                    return bIsXml ? c.documentAIField.sourceType === "XML" : c.documentAIField.sourceType !== "XML";
                });
                if (aRelevantConfigsFiltered.length === 0 && aScenarioConfigs.length > 0) {
                    console.warn(`[DEBUG_CONFIG] No fields with sourceType '${bIsXml ? "XML" : "DOX"}' found. Falling back to all configs.`);
                    aRelevantConfigsFiltered = aScenarioConfigs.filter(c => !!c.documentAIField && !!c.documentAIField.fieldName);
                }
                var iRelevantConfigs = aRelevantConfigsFiltered.length;

                if (iRelevantConfigs === 0 && sScenario !== 'MM') {
                    console.warn(`[DEBUG_CONFIG] No relevant field config found for scenario '${sScenario}' (XML Mode: ${!!bIsXml}). Fallback to 'MM'.`);
                    aScenarioConfigs = aAllConfigs.filter(c => (c.scenario || 'MM') === 'MM');
                    aScenarioMappings = aAllMappings.filter(m => (m.scenario || 'MM') === 'MM');
                    console.log(`[DEBUG_CONFIG] Fallback Configs (MM): ${aScenarioConfigs.length}`);
                } else {
                    aScenarioConfigs = aRelevantConfigsFiltered;
                }

                // Re-check resulting configs
                console.log(`[DEBUG_CONFIG] Final Relevant Configs: ${aScenarioConfigs.length}`);

                var aHeaderFields = [];
                var mItemGroups = {};

                var oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
                aScenarioConfigs.forEach(function (oData) {
                    var oField = oData.documentAIField;
                    if (oField) {
                        // Bidirectional Filter (User Requirement)
                        // If XML file -> Show ONLY XML fields
                        // If NOT XML file -> Show ONLY DOX/Standard fields

                        // Config mapping continues
                        var sI18nKey = "lbl_" + oField.fieldName;
                        var sLabel = oData.customLabel || oField.fieldLabel;
                        if (!oData.customLabel && oResourceBundle.hasText(sI18nKey)) {
                            sLabel = oResourceBundle.getText(sI18nKey);
                        }
                        var oFieldConfig = {
                            fieldName: oField.fieldName,
                            label: sLabel,
                            type: oField.fieldType,
                            mandatory: oData.mandatory,
                            editable: oData.editable !== false,
                            displayOrder: oData.displayOrder,
                            visible: oData.visible,
                            searchHelpFunction: oData.searchHelpFunction,
                            searchHelpInputMapping: oData.searchHelpInputMapping,
                            toBeControlled: oData.toBeControlled
                        };
                        if (oField.fieldType === "header") {
                            aHeaderFields.push(oFieldConfig);
                        } else {
                            if (!mItemGroups[oField.fieldType]) mItemGroups[oField.fieldType] = [];
                            mItemGroups[oField.fieldType].push(oFieldConfig);
                        }
                    } else {
                        console.warn("[DEBUG_CONFIG] Missing documentAIField for config:", oData);
                    }
                }.bind(this));
                console.log(`[DEBUG_CONFIG] Resulting Header Fields: ${aHeaderFields.length}, Item Groups: ${Object.keys(mItemGroups).length}`);
                aHeaderFields.sort((a, b) => a.displayOrder - b.displayOrder);
                Object.keys(mItemGroups).forEach(k => mItemGroups[k].sort((a, b) => a.displayOrder - b.displayOrder));
                oDetailModel.setProperty("/headerFields", aHeaderFields);
                oDetailModel.setProperty("/itemGroups", mItemGroups);
                // Compatibility for single item list (usually lineItem)
                oDetailModel.setProperty("/itemFields", mItemGroups['lineItem'] || mItemGroups['LineItem'] || []);

                // Rebuild Dynamic UI
                this._buildDynamicUI(aHeaderFields, mItemGroups);
                return {
                    mappings: aScenarioMappings
                };
            }
        },
        onScenarioChange: function (oEvent) {
            const sKey = oEvent.getParameter("key");
            this.getView().setBusy(true);

            // Apply Config
            const oScenarioConfig = this._applyScenarioConfig(sKey);

            // Reload Simulation
            this._loadRawDataAndStatus(this._sId).then(oData => {
                const sRawData = oData.extractedData;
                this._loadExtractionData(this._sId, sKey, false).then(oPayload => {
                    this._mapPayloadToUI(oPayload, oScenarioConfig.mappings, sRawData);
                    this.getView().setBusy(false);
                });
            });
        },
        onManualScenarioChange: function (oEvent) {
            const sKey = oEvent.getParameter("selectedItem").getKey();
            this.getModel("detailView").setProperty("/currentScenario", sKey);
            this._updateAggregateEnabled();
            this.getView().setBusy(true);

            var oDataModel = this.getModel("editableData");
            var oPreviousHeader = JSON.parse(JSON.stringify(oDataModel.getProperty("/header") || {}));

            var oScenarioConfig = this._applyScenarioConfig(sKey);

            var oOperation = this.getView().getModel().bindContext("/simulateMapping(...)");
            oOperation.setParameter("id", this._sId);
            oOperation.setParameter("scenario", sKey);
            oOperation.setParameter("skipConversions", true);

            var that = this;
            this._loadRawDataAndStatus(this._sId).then(function (oDocData) {
                var sRawData = oDocData.extractedData;
                return oOperation.execute().then(function () {
                    var oResult = oOperation.getBoundContext().getObject();
                    var sPayload = oResult.value || oResult;
                    if (typeof sPayload === "string") {
                        sPayload = JSON.parse(sPayload);
                    }
                    var aMappings = that.getModel("detailView").getProperty("/allMappings").filter(function (m) { return (m.scenario || 'MM') === sKey; });

                    that._mapPayloadToUI(sPayload, aMappings, sRawData, false);

                    var aNewHeaderFields = that.getModel("detailView").getProperty("/headerFields") || [];
                    var oNewHeader = oDataModel.getProperty("/header") || {};
                    var aNewFieldNames = aNewHeaderFields.map(function (f) { return f.fieldName; });

                    aNewFieldNames.forEach(function (sField) {
                        var bIsEmpty = oNewHeader[sField] === undefined || oNewHeader[sField] === null || oNewHeader[sField] === "";
                        var bHasPrevious = oPreviousHeader[sField] !== undefined && oPreviousHeader[sField] !== null && oPreviousHeader[sField] !== "";
                        if (bIsEmpty && bHasPrevious) {
                            oNewHeader[sField] = oPreviousHeader[sField];
                        }
                    });
                    oDataModel.setProperty("/header", oNewHeader);

                    that.getView().setBusy(false);
                });
            }).catch(function (err) {
                console.error("Scenario switch failed", err);
                sap.m.MessageBox.error(that.getResourceBundle().getText("errorScenarioSwitch") + err.message);
                that.getView().setBusy(false);
            });
        },
        _initEmptyData: function () {
            this.getModel("editableData").setProperty("/header", {});
            this.getModel("editableData").setProperty("/items", {});
            this.getModel("editableData").setProperty("/states", { header: {}, items: {} });
            this.getModel("editableData").setProperty("/confidences", { header: {}, items: {} });
            this.getModel("editableData").setProperty("/headerChecked", {});

            var oContainer = this.byId("iframeContainer2");
            if (oContainer) {
                oContainer.removeAllItems();
            }
        },
        _loadRawDataAndStatus: function (sId) {
            var oBinding = this.getView().getElementBinding();
            var oCtx = oBinding ? oBinding.getBoundContext() : null;
            if (oCtx) {
                return oCtx.requestProperty(["extractedData", "registrationStatus", "documentType", "status"]).then(res => {
                    return { extractedData: res[0], registrationStatus: res[1], documentType: res[2], status: res[3] };
                });
            } else {
                var oModel = this.getView().getModel();
                var oDedicatedCtx = oModel.bindContext("/DocumentStatusBtp('" + sId + "')");
                return oDedicatedCtx.requestProperty(["extractedData", "registrationStatus", "documentType", "status"]).then(res => {
                    return { extractedData: res[0], registrationStatus: res[1], documentType: res[2], status: res[3] };
                });
            }
        },
        _restoreDraftData: function (sRawData) {
            console.log("_restoreDraftData called with:", sRawData ? sRawData.substring(0, 100) + "..." : "null/undefined");
            if (!sRawData) return false;

            try {
                const oData = (typeof sRawData === 'string') ? JSON.parse(sRawData) : sRawData;
                console.log("Parsed Data Keys:", Object.keys(oData));
                if (oData.items) console.log("Items isArray:", Array.isArray(oData.items));
                // Basic validation that it is indeed a Draft structure
                let bIsDraft = false;
                if (oData.header && oData.items &&
                    (Array.isArray(oData.items) ||(typeof oData.items === "object" && Array.isArray(oData.items.lineItem)))
                ) {
                    bIsDraft = true;
                } else if (oData.headerFields && !Array.isArray(oData.items)) {
                    // Fallback: This looks like DOX data, not Draft data.
                    console.warn("Restoring data: Detected DOX structure, not Draft JSON.");
                }
                if (bIsDraft) {
                    var oDataModel = this.getModel("editableData");
                    oDataModel.setProperty("/header", oData.header);

                    var oItems = oData.items || {};
                    if (Array.isArray(oItems)) {
                        oItems = { 'lineItem': oItems };
                    }
                    // Initialize _checked checkboxes state
                    Object.keys(oItems).forEach(sType => {
                        if (Array.isArray(oItems[sType])) {
                            oItems[sType].forEach(item => {
                                item._checked = item._checked || {};
                            });
                        }
                    });
                    oDataModel.setProperty("/items", oItems);
                    oDataModel.setProperty("/headerChecked", oData.headerChecked || {});
                    oDataModel.setProperty("/confidences", oData.confidences || { header: {}, items: { lineItem: [] } });

                    // Restore Conversions Metadata
                    var oDetailModel = this.getModel("detailView");
                    if (oData.conversions) {
                        oDetailModel.setProperty("/conversions", oData.conversions);
                    } else {
                        oDetailModel.setProperty("/conversions", { header: {}, items: [] });
                    }

                    // Restore States (Recalculate colors)
                    var oStates = { header: {}, items: {} };
                    var oConfidences = oData.confidences || { header: {}, items: {} };
                    // Header States
                    const aHeaderFields = this.getModel("detailView").getProperty("/headerFields");
                    if (aHeaderFields) {
                        aHeaderFields.forEach(field => {
                            const safeName = this._encodeKeys(field.fieldName);
                            var fConfidence = null;
                            if (oConfidences.header && oConfidences.header[field.fieldName] !== undefined) {
                                fConfidence = oConfidences.header[field.fieldName];
                            } else if (oConfidences.header && oConfidences.header[safeName] !== undefined) {
                                fConfidence = oConfidences.header[safeName];
                            }
                            oStates.header[safeName] = this._getConfidenceState(fConfidence);
                        });
                    }

                    // Item States
                    const mItemGroups = this.getModel("detailView").getProperty("/itemGroups") || {};
                    Object.keys(mItemGroups).forEach(sType => {
                        const aItemFields = mItemGroups[sType];
                        const aItems = oItems[sType] || [];
                        oStates.items[sType] = [];
                        aItems.forEach((item, i) => {
                            var oStateItem = {};
                            aItemFields.forEach(field => {
                                const safeName = this._encodeKeys(field.fieldName);
                                var fConfidence = null;
                                if (oConfidences.items && oConfidences.items[sType] && oConfidences.items[sType][i] && oConfidences.items[sType][i][field.fieldName] !== undefined) {
                                    fConfidence = oConfidences.items[sType][i][field.fieldName];
                                } else if (oConfidences.items && oConfidences.items[sType] && oConfidences.items[sType][i] && oConfidences.items[sType][i][safeName] !== undefined) {
                                    fConfidence = oConfidences.items[sType][i][safeName];
                                }
                                oStateItem[safeName] = this._getConfidenceState(fConfidence);
                            });
                            oStates.items[sType].push(oStateItem);
                        });
                    });

                    oDataModel.setProperty("/states", oStates);
                    console.log("Restored Draft Data", oData);
                    return true;
                } else {
                    console.warn("Raw Data does not look like a saved Draft. Fallback to normal loading?");
                    return false;
                }
            } catch (e) {
                console.error("Error parsing Draft Data", e);
                return false;
            }
        },
        _loadExtractionData: async function (sId, sScenario, bSkipConversions) {
            var oModel = this.getView().getModel();
            try {
                const oOperation = oModel.bindContext("/simulateMapping(...)");
                oOperation.setParameter("id", sId);
                if (sScenario) oOperation.setParameter("scenario", sScenario);
                if (bSkipConversions) oOperation.setParameter("skipConversions", true);

                await oOperation.execute();
                const oResult = oOperation.getBoundContext().getObject();

                let sPayload = oResult.value || oResult;

                if (typeof sPayload === "string") {
                    return JSON.parse(sPayload);
                }
                return sPayload;
            } catch (err) {
                console.error("Error simulating mapping", err);
                return null;
            }
        },
        _mapPayloadToUI: function (oPayload, aMappings, sRawData, bMerge) {
            var sDocType = this.getModel("detailView").getProperty("/currentDocumentType");
            var sFileName = this.getModel("detailView").getProperty("/currentFileName");
            var bIsXml = (sDocType && sDocType.toUpperCase().includes("XML")) || (sFileName && sFileName.toLowerCase().endsWith(".xml"));
            if (!bIsXml) {
                // --- LOGICA use_pdf-parse (PDF) ---
                console.log("_mapPayloadToUI called. Payload:", oPayload);

                // Extract Metadata
                var oMeta = oPayload.__metadata || {};
                var oConversions = oMeta.conversions || { header: {}, items: [] };
                this.getModel("detailView").setProperty("/conversions", oConversions);
                var oDataModel = this.getModel("editableData");
                var oHeader = {};
                if (bMerge) {
                    oHeader = JSON.parse(JSON.stringify(oDataModel.getProperty("/header") || {}));
                }
                var oRawData = {};
                try {
                    if (sRawData) {
                        if (typeof sRawData === 'string') {
                            oRawData = JSON.parse(sRawData);
                        } else {
                            oRawData = sRawData;
                        }
                    }
                    console.log("Parsed Raw Data:", oRawData);
                } catch (e) { console.error("Error parsing raw data", e); }
                // Iterate Configured Header Fields (DocAI)
                const aHeaderFields = this.getModel("detailView").getProperty("/headerFields");

                if (aHeaderFields) {
                    aHeaderFields.forEach(field => {
                        // Find ALL mappings for the current field
                        const aFieldMappings = aMappings.filter(m => m.documentAIField && m.documentAIField.fieldName === field.fieldName && m.documentAIField.sourceType !== 'XML');

                        aFieldMappings.forEach(oMapping => {
                            if (oMapping.odataField) {
                                const sPath = oMapping.odataField.fieldName;
                                let val = oPayload[sPath];
                                console.log(`[DEBUG_TRACE] Mapping Field: ${field.fieldName} -> Path: ${sPath}, Payload Value:`, val);

                                if (val !== undefined && val !== null) {
                                    oHeader[field.fieldName] = val;
                                }
                            }
                        });

                        if (aFieldMappings.length === 0) {
                            console.warn(`[DEBUG_TRACE] No mapping found for header field: ${field.fieldName}`);
                        }
                        // Fallback: If no value found in OData Payload, try Mapped Values (Metadata Cheat Sheet)
                        if (oMeta.mappedValues && oMeta.mappedValues.header && oMeta.mappedValues.header[field.fieldName] !== undefined) {
                            oHeader[field.fieldName] = oMeta.mappedValues.header[field.fieldName];
                            console.log(`[DEBUG_TRACE] Found in MappedValues Metadata: ${field.fieldName} -> ${oHeader[field.fieldName]}`);
                        }
                        // Fallback: If no value found in OData Payload, try Raw Data
                        if (oHeader[field.fieldName] === undefined || oHeader[field.fieldName] === null || oHeader[field.fieldName] === "") {
                            // 1. Direct property
                            if (oRawData[field.fieldName] !== undefined) {
                                if (typeof oRawData[field.fieldName] === 'object' && oRawData[field.fieldName] !== null && oRawData[field.fieldName].value !== undefined) {
                                    oHeader[field.fieldName] = oRawData[field.fieldName].value;
                                    console.log(`[DEBUG_TRACE] Found in Raw Data (direct object.value): ${field.fieldName} -> ${oHeader[field.fieldName]}`);
                                } else if (typeof oRawData[field.fieldName] !== 'object' || oRawData[field.fieldName] === null) {
                                    oHeader[field.fieldName] = oRawData[field.fieldName];
                                    console.log(`[DEBUG_TRACE] Found in Raw Data (direct primitive): ${field.fieldName} -> ${oHeader[field.fieldName]}`);
                                }
                            }
                            // 2. Nested property in header object
                            if ((oHeader[field.fieldName] === undefined || oHeader[field.fieldName] === null || oHeader[field.fieldName] === "") && oRawData.header && oRawData.header[field.fieldName] !== undefined) {
                                if (typeof oRawData.header[field.fieldName] === 'object' && oRawData.header[field.fieldName] !== null && oRawData.header[field.fieldName].value !== undefined) {
                                    oHeader[field.fieldName] = oRawData.header[field.fieldName].value;
                                    console.log(`[DEBUG_TRACE] Found in Raw Data (header.object.value): ${field.fieldName} -> ${oHeader[field.fieldName]}`);
                                } else if (typeof oRawData.header[field.fieldName] !== 'object' || oRawData.header[field.fieldName] === null) {
                                    oHeader[field.fieldName] = oRawData.header[field.fieldName];
                                    console.log(`[DEBUG_TRACE] Found in Raw Data (header.primitive): ${field.fieldName} -> ${oHeader[field.fieldName]}`);
                                }
                            }
                            // 3. HeaderFields Array (DOX standard)
                            if ((oHeader[field.fieldName] === undefined || oHeader[field.fieldName] === null || oHeader[field.fieldName] === "") && Array.isArray(oRawData.headerFields)) {
                                const rawField = oRawData.headerFields.find(f => f.name === field.fieldName);
                                if (rawField && rawField.value !== undefined) {
                                    oHeader[field.fieldName] = rawField.value;
                                    console.log(`[DEBUG_TRACE] Found in Raw headerFields Array: ${field.fieldName} -> ${oHeader[field.fieldName]}`);
                                }
                            }
                        }
                    });
                }

                oDataModel.setProperty("/header", oHeader);
                // Handle Item Mapping (Robust Grouped Support)
                const mItemGroups = this.getModel("detailView").getProperty("/itemGroups") || {};
                var oUIItemGroups = {};

                Object.keys(mItemGroups).forEach(sType => {
                    const aItemFields = mItemGroups[sType];
                    let rawItems = [];

                    // Support flat array (DOX) or grouped object (UI Model)
                    if (oRawData.items && Array.isArray(oRawData.items[sType])) {
                        rawItems = oRawData.items[sType];
                    } else if (Array.isArray(oRawData[sType])) {
                        rawItems = oRawData[sType];
                    } else if (sType === 'lineItem') {
                        if (Array.isArray(oRawData.items)) rawItems = oRawData.items;
                        else if (Array.isArray(oRawData.lineItems)) rawItems = oRawData.lineItems;
                    }

                    if (!Array.isArray(rawItems)) return;

                    oUIItemGroups[sType] = [];
                    for (let i = 0; i < rawItems.length; i++) {
                        let oUIItem = {};
                        oUIItem._checked = {}; // Initialize state tooltip anchor

                        aItemFields.forEach(field => {
                            let bMapped = false;
                            // Find ALL mappings for this field
                            const aFieldMappings = aMappings.filter(m => m.documentAIField && m.documentAIField.fieldName === field.fieldName);

                            aFieldMappings.forEach(oMapping => {
                                if (oMapping && oMapping.odataField) {
                                    const sEntity = oMapping.odataField.entityName;
                                    const sTargetField = oMapping.odataField.fieldName;

                                    let sNavProp = "";
                                    if (sEntity.endsWith("A_SuplrInvcItemPurOrdRef") || sEntity.endsWith("A_SuplrInvcItemPurOrdRefType")) sNavProp = "to_SuplrInvcItemPurOrdRef";
                                    else if (sEntity.endsWith("A_SupplierInvoiceItemGLAcct") || sEntity.endsWith("A_SupplierInvoiceItemGLAcctType")) sNavProp = "to_SupplierInvoiceItemGLAcct";
                                    else if (sEntity.endsWith("A_SupplierInvoiceTax") || sEntity.endsWith("A_SupplierInvoiceTaxType")) sNavProp = "to_SupplierInvoiceTax";
                                    else if (sEntity.endsWith("A_SuplrInvcHeaderWhldgTax") || sEntity.endsWith("A_SuplrInvcHeaderWhldgTaxType")) sNavProp = "to_SupplierInvoiceWhldgTax";
                                    else if (sEntity.endsWith("A_SuplrInvcItemAcctAssgmt") || sEntity.endsWith("A_SuplrInvcItemAcctAssgmtType")) sNavProp = "to_SuplrInvcItemAcctAssgmt";
                                    else if (sEntity === "ItemDataSet" || sEntity === "SelectPOSet" || sEntity === "TMItemDataSet" || sEntity === "AssetDataSet" || sEntity === "ServiceLeanSet" || sEntity === "to_SupplierInvoiceItem" ||
                                        sEntity === "TaxDataSet" || sEntity === "GlAccountDataSet" || sEntity === "MaterialDataSet" || sEntity === "AccountingDataSet" ||
                                        sEntity === "WithTaxDataSet" || sEntity === "VendorDataSet" || sEntity === "AddressDataSet" || sEntity === "AdditionalDataSet") {
                                        sNavProp = sEntity;
                                    }

                                    if (sNavProp && oPayload && oPayload[sNavProp] && Array.isArray(oPayload[sNavProp])) {
                                        const sItemNum = (i + 1).toString().padStart(4, "0");
                                        let oPayloadItem = oPayload[sNavProp].find(obj => obj.SupplierInvoiceItem === sItemNum);

                                        if (!oPayloadItem && oPayload[sNavProp].length > i) {
                                            oPayloadItem = oPayload[sNavProp][i];
                                        }

                                        if (oPayloadItem) {
                                            let val = oPayloadItem[sTargetField];
                                            if (val !== undefined && val !== null) {
                                                oUIItem[field.fieldName] = val;
                                                bMapped = true;
                                            }
                                        }
                                    }
                                }
                            });

                            // Fallback Logic for Items
                            if (!bMapped) {
                                const oRawItem = rawItems[i];
                                if (oRawItem) {
                                    const cleanFieldName = field.fieldName.replace(/[\s\(\)_\-]/g, '').toLowerCase();
                                    const foundKey = Object.keys(oRawItem).find(k => {
                                        const cleanK = k.replace(/[\s\(\)_\-]/g, '').toLowerCase();
                                        return cleanFieldName.includes(cleanK) || cleanK.includes(cleanFieldName);
                                    });
                                    if (foundKey && oRawItem[foundKey] !== undefined) {
                                        if (typeof oRawItem[foundKey] === 'object' && oRawItem[foundKey] !== null && oRawItem[foundKey].value !== undefined) {
                                            oUIItem[field.fieldName] = oRawItem[foundKey].value;
                                        } else if (typeof oRawItem[foundKey] !== 'object' || oRawItem[foundKey] === null) {
                                            oUIItem[field.fieldName] = oRawItem[foundKey];
                                        }
                                    } else if (Array.isArray(oRawItem)) {
                                        const fObj = oRawItem.find(f => f.name === field.fieldName);
                                        if (fObj && fObj.value) {
                                            oUIItem[field.fieldName] = fObj.value;
                                        }
                                    }
                                }
                            }
                        });
                        oUIItemGroups[sType].push(oUIItem);
                    }
                });

                oDataModel.setProperty("/items", oUIItemGroups);

                // Ensure states and confidences are correctly initialized for all groups
                var oStates = oDataModel.getProperty("/states") || { header: {}, items: {} };
                var oConfidences = oDataModel.getProperty("/confidences") || { header: {}, items: {} };

                Object.keys(oUIItemGroups).forEach(sType => {
                    if (!oStates.items[sType] || oStates.items[sType].length !== oUIItemGroups[sType].length) {
                        oStates.items[sType] = oUIItemGroups[sType].map(() => ({}));
                    }
                    if (!oConfidences.items[sType] || oConfidences.items[sType].length !== oUIItemGroups[sType].length) {
                        oConfidences.items[sType] = oUIItemGroups[sType].map(() => ({}));
                    }
                });

                if (!oStates.header) oStates.header = {};
                if (!oConfidences.header) oConfidences.header = {};

                oDataModel.setProperty("/states", oStates);
                oDataModel.setProperty("/confidences", oConfidences);

                oDataModel.updateBindings(true);
            } else {
                // --- LOGICA xml_logic (XML) ---
                console.log("_mapPayloadToUI called. Payload:", oPayload);

                // Extract Metadata
                var oMeta = oPayload.__metadata || {};
                var oConversions = oMeta.conversions || { header: {}, items: [] };
                this.getModel("detailView").setProperty("/conversions", oConversions);
                var oDataModel = this.getModel("editableData");
                var oHeaderRaw = {};
                if (bMerge) {
                    const oCurrentHeaderSafe = oDataModel.getProperty("/header") || {};
                    oHeaderRaw = this._decodeKeys(oCurrentHeaderSafe);
                }
                var oStatesRaw = { header: {}, items: [] };
                var oConfidencesRaw = { header: {}, items: [] };
                var oRawData = {};
                try {
                    if (sRawData) {
                        oRawData = (typeof sRawData === 'string') ? JSON.parse(sRawData) : sRawData;
                    }
                    console.log("Parsed Raw Data:", oRawData);
                } catch (e) { console.error("Error parsing raw data", e); }
                const aHeaderFields = this.getModel("detailView").getProperty("/headerFields");

                if (aHeaderFields) {
                    aHeaderFields.forEach(field => {
                        const aFieldMappings = aMappings.filter(m => m.documentAIField && m.documentAIField.fieldName === field.fieldName && m.documentAIField.sourceType === 'XML');

                        const safeName = this._encodeKeys ? this._encodeKeys(field.fieldName) : field.fieldName;

                        // Priority 1: Mapped Values (Converted results from Backend)
                        if (oMeta.mappedValues && oMeta.mappedValues.header) {
                            const convertedVal = oMeta.mappedValues.header[field.fieldName] !== undefined ? oMeta.mappedValues.header[field.fieldName] : oMeta.mappedValues.header[safeName];
                            if (convertedVal !== undefined && convertedVal !== null && convertedVal !== "") {
                                oHeaderRaw[field.fieldName] = convertedVal;
                            }
                        }

                        // Priority 2: OData Payload
                        if (oHeaderRaw[field.fieldName] === undefined || oHeaderRaw[field.fieldName] === null || oHeaderRaw[field.fieldName] === "") {
                            aFieldMappings.forEach(oMapping => {
                                if (oMapping.odataField) {
                                    const sPath = oMapping.odataField.fieldName;
                                    let val = oPayload[sPath];
                                    // Check nav props for header fields
                                    if (val === undefined || val === null) {
                                        const aNavs = ["VendorDataSet", "AddressDataSet", "AdditionalDataSet"];
                                        for (let sNav of aNavs) {
                                            if (oPayload[sNav] && Array.isArray(oPayload[sNav]) && oPayload[sNav].length > 0) {
                                                if (oPayload[sNav][0][sPath] !== undefined) {
                                                    val = oPayload[sNav][0][sPath];
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    if (val !== undefined && val !== null) oHeaderRaw[field.fieldName] = val;
                                }
                            });
                        }
                        if (oHeaderRaw[field.fieldName] === undefined || oHeaderRaw[field.fieldName] === null || oHeaderRaw[field.fieldName] === "") {
                            let rawValueObj = oRawData[field.fieldName] !== undefined ? oRawData[field.fieldName] : oRawData[safeName];
                            if (rawValueObj !== undefined && rawValueObj !== null) {
                                oHeaderRaw[field.fieldName] = (typeof rawValueObj === 'object' && rawValueObj.value !== undefined) ?
                                    rawValueObj.value : rawValueObj;
                            }

                            if ((oHeaderRaw[field.fieldName] === undefined || oHeaderRaw[field.fieldName] === null || oHeaderRaw[field.fieldName] === "") && oRawData.header) {
                                let headerValObj = oRawData.header[field.fieldName] !== undefined ? oRawData.header[field.fieldName] : oRawData.header[safeName];
                                if (headerValObj !== undefined && headerValObj !== null) {
                                    oHeaderRaw[field.fieldName] = (typeof headerValObj === 'object' && headerValObj.value !== undefined) ?
                                        headerValObj.value : headerValObj;
                                }
                            }

                            if ((oHeaderRaw[field.fieldName] === undefined || oHeaderRaw[field.fieldName] === null || oHeaderRaw[field.fieldName] === "") && Array.isArray(oRawData.headerFields)) {
                                const rawField = oRawData.headerFields.find(f => f.name === field.fieldName || f.name === safeName);
                                if (rawField && rawField.value !== undefined) oHeaderRaw[field.fieldName] = rawField.value;
                            }
                        }
                        // Confidence
                        var fConfidence = this._getConfidence(oRawData, field.fieldName);
                        var bConverted = false;
                        // Check if any mapping for this field resulted in a conversion
                        const bAnyMappingConverted = aFieldMappings.some(oMapping => {
                            if (oMapping && oMapping.odataField) {
                                const sODataKey = oMapping.odataField.fieldName;
                                return oConversions.header && oConversions.header[sODataKey];
                            }
                            return false;
                        });
                        if (bAnyMappingConverted) fConfidence = null;
                        oStatesRaw.header[field.fieldName] = this._getConfidenceState(fConfidence);
                        oConfidencesRaw.header[field.fieldName] = fConfidence;
                    });
                }
                // Handle Multiple Repeating Sections Mapping
                const mItemGroups = this.getModel("detailView").getProperty("/itemGroups") || {};
                var oUIItemGroups = {};
                var oStatesGroups = {};
                var oConfidencesGroups = {};
                Object.keys(mItemGroups).forEach(sType => {
                    const aItemFields = mItemGroups[sType];
                    let rawItems = [];
                    if (Array.isArray(oRawData[sType])) {
                        rawItems = oRawData[sType];
                    } else if (oRawData.items && Array.isArray(oRawData.items[sType])) {
                        rawItems = oRawData.items[sType];
                    } else if (sType === 'lineItem') {
                        if (Array.isArray(oRawData.items)) rawItems = oRawData.items;
                        else if (Array.isArray(oRawData.lineItems)) rawItems = oRawData.lineItems;
                    }
                    if (!Array.isArray(rawItems)) return;
                    oUIItemGroups[sType] = [];
                    oStatesGroups[sType] = [];
                    oConfidencesGroups[sType] = [];
                    for (let i = 0; i < rawItems.length; i++) {
                        let oUIItemRaw = {};
                        oUIItemRaw._checked = {}; // Initialize state tooltip anchor
                        let oStateItemRaw = {};
                        let oConfidenceItemRaw = {};
                        aItemFields.forEach(field => {
                            let bMapped = false;
                            const aFieldMappings = aMappings.filter(m => m.documentAIField && m.documentAIField.fieldName === field.fieldName && m.documentAIField.sourceType === 'XML');

                            aFieldMappings.forEach(oMapping => {
                                if (oMapping && oMapping.odataField) {
                                    const sEntity = oMapping.odataField.entityName;
                                    const sTargetField = oMapping.odataField.fieldName;

                                    let sNavProp = "";
                                    if (sEntity.endsWith("A_SuplrInvcItemPurOrdRef") || sEntity.endsWith("A_SuplrInvcItemPurOrdRefType")) sNavProp = "to_SuplrInvcItemPurOrdRef";
                                    else if (sEntity.endsWith("A_SupplierInvoiceItemGLAcct") || sEntity.endsWith("A_SupplierInvoiceItemGLAcctType")) sNavProp = "to_SupplierInvoiceItemGLAcct";
                                    else if (sEntity.endsWith("A_SupplierInvoiceTax") || sEntity.endsWith("A_SupplierInvoiceTaxType")) sNavProp = "to_SupplierInvoiceTax";
                                    else if (sEntity.endsWith("A_SuplrInvcHeaderWhldgTax") || sEntity.endsWith("A_SuplrInvcHeaderWhldgTaxType")) sNavProp = "to_SupplierInvoiceWhldgTax";
                                    else if (sEntity.endsWith("A_SuplrInvcItemAcctAssgmt") || sEntity.endsWith("A_SuplrInvcItemAcctAssgmtType")) sNavProp = "to_SuplrInvcItemAcctAssgmt";
                                    else if (sEntity === "ItemDataSet" || sEntity === "SelectPOSet" || sEntity === "TMItemDataSet" || sEntity === "AssetDataSet" || sEntity === "ServiceLeanSet" || sEntity === "to_SupplierInvoiceItem" ||
                                        sEntity === "TaxDataSet" || sEntity === "GlAccountDataSet" || sEntity === "MaterialDataSet" || sEntity === "AccountingDataSet" ||
                                        sEntity === "WithTaxDataSet" || sEntity === "VendorDataSet" || sEntity === "AddressDataSet" || sEntity === "AdditionalDataSet") {
                                        sNavProp = sEntity;
                                    }
                                    if (sNavProp && oPayload && oPayload[sNavProp] && Array.isArray(oPayload[sNavProp])) {
                                        // For now, assume sequential matching for generic repeating blocks if SupplierInvoiceItem not found
                                        const sItemNum = (i + 1).toString().padStart(4, "0");
                                        let oPayloadItem = oPayload[sNavProp].find(obj => obj.SupplierInvoiceItem === sItemNum);
                                        if (!oPayloadItem && oPayload[sNavProp].length > i) {
                                            oPayloadItem = oPayload[sNavProp][i];
                                        }

                                        if (oPayloadItem) {
                                            let val = oPayloadItem[sTargetField];
                                            if (val !== undefined && val !== null) {
                                                oUIItemRaw[field.fieldName] = val;
                                                bMapped = true;
                                            }
                                        }
                                    }
                                }
                            });
                            // Fallback Logic for Items
                            if (!bMapped) {
                                const oRawItem = rawItems[i];
                                if (oRawItem) {
                                    const safeName = this._encodeKeys ? this._encodeKeys(field.fieldName) : field.fieldName;
                                    const rawValueObj = oRawItem[field.fieldName] !== undefined ? oRawItem[field.fieldName] : oRawItem[safeName];
                                    if (rawValueObj !== undefined && rawValueObj !== null) {
                                        oUIItemRaw[field.fieldName] = (typeof rawValueObj === 'object' && rawValueObj.value !== undefined) ?
                                            rawValueObj.value : rawValueObj;
                                    } else if (Array.isArray(oRawItem)) {
                                        const fObj = oRawItem.find(f => f.name === field.fieldName);
                                        if (fObj && fObj.value !== undefined) oUIItemRaw[field.fieldName] = fObj.value;
                                    }
                                }
                            }

                            // Confidence Logic (Item Level)
                            const fConf = this._getConfidence(oRawData, field.fieldName, i, sType);
                            oStateItemRaw[field.fieldName] = this._getConfidenceState(fConf);
                            oConfidenceItemRaw[field.fieldName] = fConf;
                        });

                        // Encode Item Keys
                        let oUIItemSafe = {};
                        let oStateItemSafe = {};
                        let oConfidenceItemSafe = {};
                        Object.keys(oUIItemRaw).forEach(k => oUIItemSafe[this._encodeKeys(k)] = oUIItemRaw[k]);
                        Object.keys(oStateItemRaw).forEach(k => oStateItemSafe[this._encodeKeys(k)] = oStateItemRaw[k]);
                        Object.keys(oConfidenceItemRaw).forEach(k => oConfidenceItemSafe[this._encodeKeys(k)] = oConfidenceItemRaw[k]);
                        oUIItemGroups[sType].push(oUIItemSafe);
                        oStatesGroups[sType].push(oStateItemSafe);
                        oConfidencesGroups[sType].push(oConfidenceItemSafe);
                    }
                });
                // Safe paths for UI
                var oHeaderSafe = {};
                var oStatesSafe = { header: {}, items: oStatesGroups };
                var oConfidencesSafe = { header: {}, items: oConfidencesGroups };
                aHeaderFields.forEach(field => {
                    const safeName = this._encodeKeys(field.fieldName);
                    oHeaderSafe[safeName] = oHeaderRaw[field.fieldName];
                    oStatesSafe.header[safeName] = oStatesRaw.header[field.fieldName];
                    oConfidencesSafe.header[safeName] = oConfidencesRaw.header[field.fieldName];
                });
                oDataModel.setProperty("/header", oHeaderSafe);
                oDataModel.setProperty("/states", oStatesSafe);
                oDataModel.setProperty("/confidences", oConfidencesSafe);
                oDataModel.setProperty("/items", oUIItemGroups);
                oDataModel.updateBindings(true);
                console.log("Final UI Mapping Complete.");
            }
        },
        _getConfidence: function (oData, sFieldName, iItemIndex, sGroupType) {
            if (!oData) return null;
            // 1. Saved Draft Confidences
            if (iItemIndex !== undefined && sGroupType) {
                if (oData.confidences && oData.confidences.items && oData.confidences.items[sGroupType] && oData.confidences.items[sGroupType][iItemIndex]) {
                    return oData.confidences.items[sGroupType][iItemIndex][sFieldName];
                }
            } else {
                if (oData.confidences && oData.confidences.header && oData.confidences.header[sFieldName] !== undefined) {
                    return oData.confidences.header[sFieldName];
                }
            }
            // 2. Direct property (Flat structure)
            const oTarget = (iItemIndex !== undefined && sGroupType) ? (oData[sGroupType] || [])[iItemIndex] : oData;
            if (oTarget && oTarget[sFieldName] && typeof oTarget[sFieldName].confidence !== 'undefined') {
                return oTarget[sFieldName].confidence;
            }

            return null;
        },
        _getConfidenceState: function (fValue) {
            if (fValue === null || fValue === undefined) return "None";
            if (fValue <= 0.5) return "Error";
            if (fValue < 0.8) return "Warning";
            return "Success";
        },
        _loadPdfContent: async function (sId) {
            var oModel = this.getView().getModel();
            var oDetailModel = this.getView().getModel("detailView");

            oDetailModel.setProperty("/pdfSource", null); // Reset
            try {
                // Determine context path for function call on specific entity if bound, or root.
                // bindContext("/getFileByJobId(...)")
                const oOperation = oModel.bindContext("/getFileByJobId(...)");
                oOperation.setParameter("id", sId);
                await oOperation.execute();
                const oResult = oOperation.getBoundContext().getObject();
                if (oResult && oResult.base64) {
                    oDetailModel.setProperty("/hasPdf", true);
                    // Custom PDF.js rendering
                    this.openPdfViewer(null, oResult.base64, "application/pdf", "invoice.pdf");
                } else {
                    oDetailModel.setProperty("/hasPdf", false);
                    // Handle missing content explicitly
                    throw new Error("No PDF content returned from server");
                }
            } catch (err) {
                oDetailModel.setProperty("/hasPdf", false);
                console.error("Error loading PDF", err);
                // MessageToast.show(this.getResourceBundle().getText("errorLoadPdf"));

                // Show error in the container instead of toast
                var oContainer = this.byId("iframeContainer2");
                if (oContainer) {
                    oContainer.removeAllItems();
                    // Center the error message
                    oContainer.setAlignItems("Center");
                    oContainer.setJustifyContent("Center");

                    oContainer.addItem(new sap.m.Text({
                        text: this.getResourceBundle().getText("pdfNotFound"),
                        textAlign: "Center"
                    }).addStyleClass("sapUiSmallMargin"));
                }
            }
        },
        openPdfViewer: function (pdfViewer, sBase64, mimeType, fileName) {
            // 1. Convertiamo il base64 in un ArrayBuffer/Uint8Array
            const byteCharacters = atob(sBase64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);

            // 2. Creiamo un Blob dal PDF
            const blob = new Blob([byteArray], { type: 'application/pdf' });
            const blobUrl = URL.createObjectURL(blob);

            // 3. Inseriamo il file in un Iframe
            var container = this.byId("iframeContainer2");
            container.removeAllItems();

            var oHtml = new sap.ui.core.HTML({
                content: `<iframe src="${blobUrl}" style="width:100%; height:800px; border:none;"></iframe>`
            });

            container.addItem(oHtml);
        },
        openPdfViewer1: function (pdfViewer, sBase64, mimeType, fileName) {
            if (!sBase64) return;
            var that = this;
            // Cleanup pure base64 if it has data URI prefix
            var sCleanBase64 = sBase64;
            if (sCleanBase64.startsWith("data:application/pdf;base64,")) {
                sCleanBase64 = sCleanBase64.replace("data:application/pdf;base64,", "");
            }
            // Decodifica base64 in Uint8Array
            const byteCharacters = atob(sCleanBase64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            // Container cleaning
            const container = this.byId("iframeContainer2");
            if (!container) return;
            container.removeAllItems();

            // Reset alignment
            container.setAlignItems("Stretch");
            container.setJustifyContent("Start");
            // Ensure unique DOM ID to avoid collisions on re-navigation
            var sUniqueId = this.getView().createId("pdfContainer") + "_" + new Date().getTime();
            // Aggiunge un div che conterr├â┬á tutti i canvas
            var oHtml = new HTML({
                content: `<div id="${sUniqueId}" style="width:100%;"></div>`
            });
            var renderFn = function () {
                // Ensure DOM element exists
                var oDiv = document.getElementById(sUniqueId);
                if (!oDiv) {
                    console.warn("PDF Container DIV not found during render (" + sUniqueId + ")");
                    return;
                }

                // Clear previous content
                oDiv.innerHTML = "";
                if (typeof pdfjsLib === "undefined") {
                    console.error("PDF.js library still not loaded");
                    return;
                }
                // Set worker if not already set
                if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                }
                // Carica il PDF con PDF.js
                const loadingTask = pdfjsLib.getDocument({
                    data: byteArray,
                    // Aggiungi queste due righe cruciali per i font asiatici:
                    cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/cmaps/',
                    cMapPacked: true
                });
                loadingTask.promise.then(pdf => {
                    console.log("PDF caricato, numero pagine: " + pdf.numPages);

                    // Ciclo su tutte le pagine
                    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                        pdf.getPage(pageNum).then(page => {
                            const scale = 1.2; // Zoom
                            const viewport = page.getViewport({ scale });

                            // Crea canvas per ogni pagina
                            const canvas = document.createElement("canvas");
                            canvas.style.display = "block";
                            canvas.style.margin = "0 auto 10px auto"; // un po' di spazio tra le pagine
                            canvas.style.maxWidth = "100%";
                            const context = canvas.getContext("2d");
                            canvas.height = viewport.height;
                            canvas.width = viewport.width;

                            // Aggiungi canvas al container
                            oDiv.appendChild(canvas);
                            // Renderizza la pagina
                            page.render({ canvasContext: context, viewport });

                        }).catch(err => {
                            console.error("Error rendering page " + pageNum, err);
                        });
                    }
                }).catch(err => {
                    console.error("PDF load error", err);
                    // Fallback error
                    container.removeAllItems();
                    // wait(0); // removed invalid call
                    container.setAlignItems("Center");
                    container.addItem(new sap.m.Text({ text: that.getResourceBundle().getText("errorRenderPdf") }));
                });
            };
            var ensureLibAndRender = function () {
                if (typeof pdfjsLib === "undefined") {
                    jQuery.getScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js")
                        .done(function () {
                            console.log("PDF.js loaded dynamically");
                            renderFn();
                        })
                        .fail(function (jqxhr, settings, exception) {
                            console.error("Failed to load PDF.js", exception);
                            container.removeAllItems();
                            container.addItem(new sap.m.Text({ text: that.getResourceBundle().getText("errorLoadPdfLib") }));
                        });
                } else {
                    renderFn();
                }
            };
            // Hook render execution to afterRendering to ensure DOM is present
            oHtml.addEventDelegate({
                onAfterRendering: function () {
                    // Small delay to ensure DOM paint is stable
                    setTimeout(ensureLibAndRender, 50);
                }
            });
            container.addItem(oHtml);
        },
        _loadCountryConfig: function (sCountryCode) {
            var oConfigModel = this.getOwnerComponent().getModel("config");
            var that = this;
            return new Promise((resolve, reject) => {
                // 1. Fetch CountryFieldConfig expanded with DocumentAIFields - Fetch ALL (visible or not, MM or FI)
                var oListBinding = oConfigModel.bindList("/CountryFieldConfig", undefined, undefined, [
                    new Filter("country_code", FilterOperator.EQ, sCountryCode)
                ], {
                    "$expand": "documentAIField($select=fieldName,fieldType,fieldLabel,sourceType),searchHelpFunction"
                });

                // 2. Fetch FieldMappings
                var oMappingBinding = oConfigModel.bindList("/FieldMappings", undefined, undefined, [
                    new Filter("country_code", FilterOperator.EQ, sCountryCode),
                    new Filter("active", FilterOperator.EQ, true)
                ], {
                    "$expand": "documentAIField,odataField"
                });
                Promise.all([oListBinding.requestContexts(0, 5000), oMappingBinding.requestContexts(0, 5000)])
                    .then(function (results) {
                        var aConfigs = results[0].map(c => c.getObject());
                        var aMappings = results[1].map(c => c.getObject());

                        // Store ALL for scenario switching
                        that.getModel("detailView").setProperty("/allConfigs", aConfigs);
                        that.getModel("detailView").setProperty("/allMappings", aMappings);

                        resolve({
                            configs: aConfigs,
                            mappings: aMappings
                        });
                    }).catch(function (err) {
                        reject(err);
                    });
            });
        },
        _buildDynamicUI: function (aHeaderFields, mItemGroups) {
            var oHeaderForm = this.byId("headerForm");
            oHeaderForm.removeAllContent();
            // 1. Populate Header Form
            aHeaderFields.forEach(function (oField) {
                if (!oField.visible || !oField.fieldName) return;
                oHeaderForm.addContent(new Label({
                    text: oField.label,
                    required: oField.mandatory
                }));
                const safeFieldName = this._encodeKeys(oField.fieldName);
                console.log(`[DEBUG_DYNAMIC_UI] Building Header Field: ${oField.fieldName} (Encoded: ${safeFieldName})`);
                var oInput = new Input({
                    value: "{editableData>/header/" + safeFieldName + "}",
                    required: oField.mandatory,
                    editable: oField.editable === false ? false : "{detailView>/isEditable}",
                    valueState: {
                        path: "editableData>/states/header/" + safeFieldName,
                        formatter: function (v) {
                            if (v && typeof v === "object") {
                                console.error(`[DEBUG_DYNAMIC_UI] INVALID OBJECT for valueState in field ${oField.fieldName}:`, v);
                                return "None";
                            }
                            return v || "None";
                        }
                    },
                    showValueHelp: !!oField.searchHelpFunction,
                    showSuggestion: false
                });

                if (oField.searchHelpFunction) {
                    oInput.attachValueHelpRequest(this.onValueHelpRequest.bind(this));
                    oInput.data("searchHelpFunction", oField.searchHelpFunction);
                    oInput.data("fieldName", oField.fieldName);
                    oInput.data("fieldType", "header");

                    var vItemMapping = oField.searchHelpInputMapping;
                    if (typeof vItemMapping === "string" && vItemMapping.indexOf("{") !== -1) {
                        try { vItemMapping = JSON.parse(vItemMapping); } catch (e) { }
                    }
                    oInput.data("searchHelpInputMapping", vItemMapping);
                }
                this._addConfidenceStyle(oInput, "header", oField.fieldName);

                if (oField.toBeControlled) {
                    oInput.addStyleClass("toBeControlledField");
                }
                var aHBoxItems = [oInput];
                if (oField.toBeControlled) {
                    var oCheckBoxXML = new sap.m.CheckBox({
                        tooltip: "{i18n>checkedTooltip}",
                        enabled: "{detailView>/isEditable}",
                        select: function (oEvent) {
                            const bSelected = oEvent.getParameter("selected");
                            oEvent.getSource().setSelected(bSelected);
                            this.getModel("editableData").setProperty("/headerChecked/" + this._encodeKeys(oField.fieldName), bSelected);
                        }.bind(this)
                    });
                    oCheckBoxXML.bindProperty("selected", { model: "editableData", path: "/headerChecked/" + this._encodeKeys(oField.fieldName) });
                    aHBoxItems.push(oCheckBoxXML.addStyleClass("sapUiTinyMarginBegin"));
                }
                aHBoxItems.push(new sap.m.Button({
                    icon: "sap-icon://information",
                    type: "Transparent",
                    tooltip: "{i18n>conversionInfoTitle}",
                    press: this.onShowConversionInfo.bind(this),
                    visible: {
                        parts: [{ path: "detailView>/conversions" }],
                        formatter: function (oConversions) {
                            return this._hasConversionInfo(oField.fieldName, oConversions, null);
                        }.bind(this)
                    }
                }).data("fieldName", oField.fieldName));
                var oHBox = new HBox({
                    alignItems: "Center",
                    items: aHBoxItems
                });

                oInput.setLayoutData(new sap.m.FlexItemData({ growFactor: 1 }));
                oHeaderForm.addContent(oHBox);
            }.bind(this));
            // 2. Populate Repeating Sections as Tabs
            var oIconTabBar = this.byId("iconTabBar");
            // Keep only the 'general' tab
            var aItems = oIconTabBar.getItems();
            for (var i = aItems.length - 1; i >= 0; i--) {
                if (aItems[i].getKey() !== "general") {
                    var oItem = oIconTabBar.removeItem(aItems[i]);
                    if (oItem) {
                        oItem.destroy();
                    }
                }
            }

            if (Array.isArray(mItemGroups)) {
                mItemGroups = { 'lineItem': mItemGroups };
            }
            Object.keys(mItemGroups).sort().forEach(function (sType) {
                try {
                    var aFields = mItemGroups[sType];
                    if (!aFields || aFields.length === 0) {
                        console.log(`[DEBUG_DYNAMIC_UI] Skipping Item Group '${sType}': No visible fields.`);
                        return;
                    }
                    console.log(`[DEBUG_DYNAMIC_UI] Building Tab for Group '${sType}' with ${aFields.length} fields.`);
                    var sTabTitle = sType === 'lineItem' ? this.getResourceBundle().getText("lineItems") : sType.charAt(0).toUpperCase() + sType.slice(1).replace(/([A-Z])/g, ' $1');

                    var oTab = new sap.m.IconTabFilter({
                        key: sType,
                        text: sTabTitle
                    });
                    var oTabVBox = new sap.m.VBox({ class: "sapUiSmallMargin" });

                    var oToolbar = new sap.m.Toolbar({
                        content: [
                            new sap.m.Title({ text: sTabTitle }),
                            new sap.m.ToolbarSpacer(),
                            new sap.m.Button({
                                icon: "sap-icon://add",
                                press: this.onAddLineItem.bind(this),
                                enabled: "{detailView>/isEditable}"
                            }).data("groupType", sType),
                            new sap.m.Button({
                                text: this.getResourceBundle().getText("aggregateLineItems"),
                                icon: "sap-icon://combine",
                                press: this.onAggregateLineItems.bind(this),
                                visible: sType === 'lineItem',
                                enabled: "{detailView>/isAggregateEnabled}"
                            }).data("groupType", sType)
                        ]
                    });
                    oTabVBox.addItem(oToolbar);
                    var oItemsVBox = new sap.m.VBox({ width: "100%" });
                    oItemsVBox.bindAggregation("items", {
                        path: "editableData>/items/" + sType,
                        factory: function (sId, oContext) {
                            var sPath = oContext.getPath();
                            var iIndex = parseInt(sPath.split("/").pop()) + 1;

                            var oPanel = new sap.m.Panel({
                                expandable: true,
                                expanded: true,
                                headerToolbar: new sap.m.Toolbar({
                                    content: [
                                        new sap.m.Title({ text: (sType === 'lineItem' ? 'Item ' : sTabTitle + ' ') + iIndex }),
                                        new sap.m.ToolbarSpacer(),
                                        new sap.m.Button({
                                            icon: "sap-icon://delete",
                                            type: "Reject",
                                            tooltip: "Delete Item",
                                            press: this.onDeleteLineItem.bind(this),
                                            enabled: "{detailView>/isEditable}"
                                        }).data("groupType", sType)
                                    ]
                                })
                            });
                            var oForm = new sap.ui.layout.form.SimpleForm({
                                editable: true,
                                layout: "ResponsiveGridLayout",
                                labelSpanXL: 3, labelSpanL: 3, labelSpanM: 3, labelSpanS: 12,
                                adjustLabelSpan: false,
                                emptySpanXL: 4, emptySpanL: 4, emptySpanM: 4, emptySpanS: 0,
                                columnsXL: 1, columnsL: 1, columnsM: 1,
                                singleContainerFullSize: false
                            });
                            aFields.forEach(function (oField) {
                                if (!oField.visible || !oField.fieldName) return;
                                oForm.addContent(new Label({ text: oField.label, required: oField.mandatory }));
                                const safeFieldName = this._encodeKeys(oField.fieldName);
                                var iItemIdx = parseInt(sPath.split("/").pop());
                                var oInput = new Input({
                                    value: "{editableData>" + safeFieldName + "}",
                                    required: oField.mandatory,
                                    editable: oField.editable === false ? false : "{detailView>/isEditable}",
                                    valueState: {
                                        path: "editableData>/states/items/" + sType + "/" + iItemIdx + "/" + safeFieldName,
                                        formatter: function (v) {
                                            if (v && typeof v === "object") {
                                                console.error(`[DEBUG_DYNAMIC_UI] INVALID OBJECT for valueState in item field ${oField.fieldName}:`, v);
                                                return "None";
                                            }
                                            return v || "None";
                                        }
                                    },
                                    showValueHelp: !!oField.searchHelpFunction,
                                    showSuggestion: false
                                });
                                if (oField.searchHelpFunction) {
                                    oInput.attachValueHelpRequest(this.onValueHelpRequest.bind(this));
                                    oInput.data("searchHelpFunction", oField.searchHelpFunction);
                                    oInput.data("fieldName", oField.fieldName);
                                    oInput.data("fieldType", "item");
                                    oInput.data("itemIndex", iItemIdx);
                                    oInput.data("groupType", sType);

                                    var vItemMapping = oField.searchHelpInputMapping;
                                    if (typeof vItemMapping === "string" && vItemMapping.indexOf("{") !== -1) {
                                        try { vItemMapping = JSON.parse(vItemMapping); } catch (e) { }
                                    }
                                    oInput.data("searchHelpInputMapping", vItemMapping);
                                }

                                this._addConfidenceStyle(oInput, "item", oField.fieldName, iItemIdx, sType);
                                if (oField.toBeControlled) {
                                    oInput.addStyleClass("toBeControlledField");
                                }
                                var aHBoxItems = [oInput];
                                if (oField.toBeControlled) {
                                    var oCheckBoxXML = new sap.m.CheckBox({
                                        tooltip: "{i18n>checkedTooltip}",
                                        enabled: "{detailView>/isEditable}",
                                        select: function (oEvent) {
                                            const bSelected = oEvent.getParameter("selected");
                                            oEvent.getSource().setSelected(bSelected);
                                            const oCtx = oEvent.getSource().getBindingContext("editableData");
                                            if (oCtx) {
                                                oCtx.getModel().setProperty(oCtx.getPath() + "/_checked/" + this._encodeKeys(oField.fieldName), bSelected);
                                                oCtx.getModel().updateBindings(true);
                                            }
                                        }.bind(this)
                                    });
                                    oCheckBoxXML.bindProperty("selected", { model: "editableData", path: "_checked/" + this._encodeKeys(oField.fieldName) });
                                    aHBoxItems.push(oCheckBoxXML.addStyleClass("sapUiTinyMarginBegin"));
                                }
                                aHBoxItems.push(new sap.m.Button({
                                    icon: "sap-icon://information",
                                    type: "Transparent",
                                    tooltip: "{i18n>conversionInfoTitle}",
                                    press: this.onShowConversionInfo.bind(this),
                                    visible: {
                                        parts: [{ path: "detailView>/conversions" }],
                                        formatter: function (oConversions) {
                                            return this._hasConversionInfo(oField.fieldName, oConversions, iItemIdx, sType);
                                        }.bind(this)
                                    }
                                }).data("fieldName", oField.fieldName).data("itemIndex", iItemIdx).data("groupType", sType));
                                var oHBoxItem = new HBox({
                                    alignItems: "Center",
                                    items: aHBoxItems
                                });
                                oInput.setLayoutData(new sap.m.FlexItemData({ growFactor: 1 }));
                                oForm.addContent(oHBoxItem);
                            }.bind(this));
                            oPanel.addContent(oForm);
                            return oPanel;
                        }.bind(this)
                    });
                    oTabVBox.addItem(oItemsVBox);
                    oTab.addContent(oTabVBox);
                    oIconTabBar.addItem(oTab);
                    console.log(`[DEBUG_DYNAMIC_UI] Successfully Added Tab for '${sType}'.`);
                } catch (e) {
                    console.error(`[DEBUG_DYNAMIC_UI] CRASH building tab for '${sType}':`, e);
                }
            }.bind(this));

            console.log(`[DEBUG_DYNAMIC_UI] --- _buildDynamicUI End ---`);
            // Initialize with one empty line item if EVERYTHING is empty
            var oItems = this.getModel("editableData").getProperty("/items") || {};
            if (Object.keys(oItems).length === 0 || (oItems.lineItem && oItems.lineItem.length === 0)) {
                if (mItemGroups.lineItem) this.onAddLineItem();
            }
        },
        _addConfidenceStyle: function (oControl, sType, sFieldName, iItemIndex, sGroupType) {
            var sStatePath = "";
            const safeFieldName = this._encodeKeys(sFieldName);

            if (sType === "header") {
                sStatePath = "editableData>/states/header/" + safeFieldName;
            } else {
                sStatePath = "editableData>/states/items/" + sGroupType + "/" + iItemIndex + "/" + safeFieldName;
            }

            oControl.bindProperty("valueState", sStatePath);
        },

        onValueHelpRequest: function (oEvent) {
            var oInput = oEvent.getSource();
            var oConfig = oInput.data("searchHelpFunction");
            var sFieldName = oInput.data("fieldName");
            var sFieldType = oInput.data("fieldType");
            var iItemIndex = oInput.data("itemIndex");
            var sGroupType = oInput.data("groupType");
            var oMapping = oInput.data("searchHelpInputMapping");
            var that = this;
            console.log("[DEBUG_VH] Value Help Requested for", sFieldName, "config:", oConfig);
            sap.ui.require([
                "sap/ui/comp/valuehelpdialog/ValueHelpDialog",
                "sap/ui/comp/filterbar/FilterBar",
                "sap/ui/comp/filterbar/FilterGroupItem",
                "sap/ui/table/Table",
                "sap/ui/table/Column"
            ], function (ValueHelpDialog, FilterBar, FilterGroupItem, Table, UIColumn) {
                // Parse configurations
                var oInputParams = {};
                var oOutputFields = {};
                try {
                    if (oConfig.inputParams) oInputParams = JSON.parse(oConfig.inputParams);
                    if (oConfig.outputField) oOutputFields = JSON.parse(oConfig.outputField);
                } catch (e) {
                    console.error("[DEBUG_VH] Error parsing search help config", e);
                    sap.m.MessageBox.error(that.getResourceBundle().getText("errorInvalidSearchHelp"));
                    return;
                }
                // Identify return field (first key in outputField)
                var aOutputKeys = Object.keys(oOutputFields);
                if (aOutputKeys.length === 0) {
                    sap.m.MessageBox.error(that.getResourceBundle().getText("errorNoOutputSearchHelp"));
                    return;
                }
                var sReturnField = aOutputKeys[0];
                var oColModel = new sap.ui.model.json.JSONModel({
                    cols: aOutputKeys.map(key => {
                        return { label: oOutputFields[key], template: key };
                    })
                });
                var oTable = new Table();
                oTable.setModel(oColModel, "columns");
                oTable.setModel(new sap.ui.model.json.JSONModel());
                oTable.bindRows("/");
                oColModel.getData().cols.forEach(function (col) {
                    oTable.addColumn(new UIColumn({
                        label: new sap.m.Label({ text: col.label }),
                        template: new sap.m.Text({ text: "{" + col.template + "}" })
                    }));
                });
                var oValueHelpDialog;

                var oFilterBar = new FilterBar({
                    advancedMode: false,
                    filterBarExpanded: true,
                    showGoOnFB: true,
                    search: function (oSearchEvent) {
                        var aFilterItems = oFilterBar.getFilterGroupItems();
                        var oPayload = {};
                        aFilterItems.forEach(function (oItem) {
                            var oControl = oFilterBar.determineControlByFilterItem(oItem);
                            var sVal = oControl.getValue();
                            if (sVal) {
                                oPayload[oItem.getName()] = sVal;
                            }
                        });
                        if (oValueHelpDialog && oValueHelpDialog.getTable) oValueHelpDialog.getTable().setBusy(true);
                        var oModel = that.getView().getModel();
                        var oOperation = oModel.bindContext("/executeSearchHelp(...)");
                        oOperation.setParameter("functionId", oConfig.id);
                        oOperation.setParameter("filters", JSON.stringify(oPayload));
                        oOperation.execute().then(function () {
                            var oCtx = oOperation.getBoundContext();
                            var sResult = oCtx.getProperty("value") || oCtx.getObject();
                            var aData = [];
                            try {
                                if (typeof sResult === "string" && sResult !== "") {
                                    aData = JSON.parse(sResult);
                                } else if (typeof sResult === "object" && sResult !== null) {
                                    aData = sResult.value ? sResult.value : sResult;
                                }
                            } catch (e) {
                                console.error("[DEBUG_VH] Parse error", e);
                            }
                            oTable.getModel().setData(aData);
                            if (oValueHelpDialog && oValueHelpDialog.getTable) oValueHelpDialog.getTable().setBusy(false);
                            if (oValueHelpDialog) oValueHelpDialog.update();
                        }).catch(function (err) {
                            console.error("[DEBUG_VH] Search error", err);
                            sap.m.MessageBox.error(that.getResourceBundle().getText("errorSearchFailed") + err.message);
                            if (oValueHelpDialog && oValueHelpDialog.getTable) oValueHelpDialog.getTable().setBusy(false);
                        });
                    }
                });
                // Add filter inputs
                Object.keys(oInputParams).forEach(function (key) {
                    var sLabel = oInputParams[key];
                    var sDefaultValue = "";
                    var bIsMapped = false;

                    if (oMapping && oMapping[key]) {
                        bIsMapped = true;
                        var oCurMap = oMapping[key];
                        if (oCurMap.type === "fixed") {
                            sDefaultValue = oCurMap.value;
                        } else if (oCurMap.type === "schema") {
                            var sMappedField = oCurMap.value;
                            var sSafeMappedField = that._encodeKeys ? that._encodeKeys(sMappedField) : sMappedField;
                            var oData = that.getModel("editableData").getData();

                            if (sFieldType === "header") {
                                // Header context: only look in header
                                if (oData.header) {
                                    sDefaultValue = oData.header[sSafeMappedField] !== undefined ? oData.header[sSafeMappedField] : oData.header[sMappedField];
                                }
                            } else {
                                // Item context: check item, then header fallback
                                var oItem = null;
                                if (sGroupType && oData.items && oData.items[sGroupType]) {
                                    oItem = oData.items[sGroupType][iItemIndex];
                                } else if (oData.items && Array.isArray(oData.items)) {
                                    // PDF flat items
                                    oItem = oData.items[iItemIndex];
                                }

                                if (oItem) {
                                    sDefaultValue = oItem[sSafeMappedField] !== undefined ? oItem[sSafeMappedField] : oItem[sMappedField];
                                }

                                if ((sDefaultValue === undefined || sDefaultValue === "" || sDefaultValue === null) && oData.header) {
                                    sDefaultValue = oData.header[sSafeMappedField] !== undefined ? oData.header[sSafeMappedField] : oData.header[sMappedField];
                                }
                            }
                        }
                    }

                    var oFilterItem = new FilterGroupItem({
                        groupName: "GROUP1",
                        name: key,
                        label: sLabel,
                        visibleInFilterBar: true,
                        control: new sap.m.Input({
                            name: key,
                            value: sDefaultValue,
                            editable: !bIsMapped
                        })
                    });
                    oFilterBar.addFilterGroupItem(oFilterItem);
                });
                oValueHelpDialog = new ValueHelpDialog({
                    title: oConfig.name || "Search Help",
                    supportMultiselect: false,
                    key: sReturnField,
                    descriptionKey: Object.keys(oOutputFields).length > 1 ? Object.keys(oOutputFields)[1] : sReturnField,
                    filterBar: oFilterBar,
                    ok: function (oControlEvent) {
                        var aTokens = oControlEvent.getParameter("tokens");
                        if (aTokens && aTokens.length > 0) {
                            var sSelectedKey = aTokens[0].getKey();
                            var sEncodedFieldName = that._encodeKeys ? that._encodeKeys(sFieldName) : sFieldName;

                            var sPath = (sFieldType === "header")
                                ? "/header/" + sEncodedFieldName
                                : (sGroupType ? "/items/" + sGroupType + "/" + iItemIndex + "/" + sEncodedFieldName : "/items/" + iItemIndex + "/" + sEncodedFieldName);

                            that.getModel("editableData").setProperty(sPath, sSelectedKey);

                            // Mark conversion data if needed, or clear confidence
                            var sStatePath = (sFieldType === "header")
                                ? "/states/header/" + sEncodedFieldName
                                : "/states/items/" + sGroupType + "/" + iItemIndex + "/" + sEncodedFieldName;
                            that.getModel("editableData").setProperty(sStatePath, "Success"); // Force success on manual input
                        }
                        this.close();
                        this.destroy();
                    },
                    cancel: function () {
                        this.close();
                        this.destroy();
                    },
                    afterClose: function () {
                        this.destroy();
                    }
                });
                oValueHelpDialog.setTable(oTable);
                oValueHelpDialog.open();
            });
        },
        onAddLineItem: function (oEvent) {
            var oModel = this.getModel("editableData");
            var sGroupType = (oEvent && oEvent.getSource && oEvent.getSource().data("groupType")) ? oEvent.getSource().data("groupType") : "lineItem";
            var aItems = oModel.getProperty("/items/" + sGroupType);
            if (!Array.isArray(aItems)) {
                aItems = [];
            }
            aItems.push({});
            oModel.setProperty("/items/" + sGroupType, aItems);
        },
        onDeleteLineItem: function (oEvent) {
            var oButton = oEvent.getSource();
            var oModel = this.getModel("editableData");

            var oPanel = oButton.getParent().getParent();
            var oContext = oPanel.getBindingContext("editableData");
            var sPath = oContext.getPath();
            var iIndex = parseInt(sPath.split("/").pop());

            var sGroupType = oButton.data("groupType") || "lineItem";
            var aItems = oModel.getProperty("/items/" + sGroupType);
            if (!Array.isArray(aItems)) aItems = [];
            aItems.splice(iIndex, 1);
            oModel.setProperty("/items/" + sGroupType, aItems);
        },
        onAggregateLineItems: function (oEvent) {
            var oBundle = this.getResourceBundle();
            var oDataModel = this.getModel("editableData");

            var sGroupType = (oEvent && oEvent.getSource && oEvent.getSource().data("groupType")) ? oEvent.getSource().data("groupType") : "lineItem";
            var sPath = "/items/" + sGroupType;

            var aItems = oDataModel.getProperty(sPath);
            if (!aItems || aItems.length === 0) {
                MessageToast.show(oBundle.getText("aggregateNotApplicable"));
                return;
            }
            var sCurrentScenario = this.getModel("detailView").getProperty("/currentScenario") || "MM";
            var aAllMappings = this.getModel("detailView").getProperty("/allMappings") || [];

            var aScenarioMappings = aAllMappings.filter(function (m) {
                return (m.scenario || "MM") === sCurrentScenario && m.documentAIField && m.documentAIField.fieldType === sGroupType;
            });

            var aGroupByFields = aScenarioMappings
                .filter(function (m) { return m.documentAIField && m.aggregationGroupBy === true; })
                .map(function (m) { return m.documentAIField.fieldName; });
            var aSumFields = aScenarioMappings
                .filter(function (m) { return m.documentAIField && m.aggregationSum === true; })
                .map(function (m) { return m.documentAIField.fieldName; });

            if (aGroupByFields.length === 0 || aSumFields.length === 0) {
                MessageToast.show(oBundle.getText("aggregateNoRules"));
                return;
            }
            var fnEncode = this._encodeKeys.bind(this);
            var toNumber = function (raw) {
                var str = (raw !== null && raw !== undefined) ? String(raw) : "0";
                var clean = str.replace(/[^0-9,.\-]/g, "");
                if (clean.indexOf(",") !== -1 && clean.indexOf(".") === -1) {
                    clean = clean.replace(",", ".");
                }
                return parseFloat(clean) || 0;
            };
            var mGroupMap = {};
            var aAggregated = [];
            aItems.forEach(function (oItem) {
                var sKey = aGroupByFields.map(function (sField) {
                    return String(oItem[fnEncode(sField)] || "").trim();
                }).join("|");
                if (mGroupMap.hasOwnProperty(sKey)) {
                    var oExisting = mGroupMap[sKey];
                    aSumFields.forEach(function (sField) {
                        var sSafe = fnEncode(sField);
                        oExisting[sSafe] = Number((toNumber(oExisting[sSafe]) + toNumber(oItem[sSafe])).toFixed(3));
                    });
                } else {
                    var oNewItem = JSON.parse(JSON.stringify(oItem));
                    aSumFields.forEach(function (sField) {
                        var sSafe = fnEncode(sField);
                        oNewItem[sSafe] = toNumber(oNewItem[sSafe]);
                    });
                    mGroupMap[sKey] = oNewItem;
                    aAggregated.push(oNewItem);
                }
            });
            oDataModel.setProperty(sPath, aAggregated);
            MessageToast.show(oBundle.getText("aggregateSuccess"));
        },
        onNavBack: function () {
            this.getRouter().navTo("RouteHome");
        },
        onRegister: function () {
            var oCtx = this.getView().getBindingContext();
            if (oCtx && oCtx.getProperty("registrationStatus") === "Registered") {
                return; // Guard to prevent execution
            }
            // Validation
            var oVal = this._validate();
            if (!oVal.mandatory) {
                MessageBox.error(this.getResourceBundle().getText("validationErrorMandatory"));
                return;
            }
            if (!oVal.controlled) {
                MessageBox.error(this.getResourceBundle().getText("checkAllFields") || "Controllata tutti i campi");
                return;
            }
            MessageBox.confirm(this.getResourceBundle().getText("confirmPost"), {
                onClose: function (oAction) {
                    if (oAction === MessageBox.Action.OK) {
                        this._postInvoice(false, true);
                    }
                }.bind(this)
            });
        },
        onSaveDraft: function () {
            var oDataModel = this.getModel("editableData");
            var oData = oDataModel.getData();
            var oCtx = this.getView().getBindingContext();
            // Auto switch to FI disabled (manual switch only)
            /*
            // Auto switch to FI if PO is cleared from all items
            var sCurrentScenario = this.getModel("detailView").getProperty("/currentScenario");
            var bHasPo = this._hasPO(oData);

            if (sCurrentScenario === "MM" && !bHasPo) {
                this.getModel("detailView").setProperty("/currentScenario", "FI");
                sCurrentScenario = "FI";
                this._applyScenarioConfig("FI");
                sap.m.MessageToast.show(this.getResourceBundle().getText("autoSwitchedToFI") || "PO removed. Switched to Scenario FI.");
            }
            */
            var sCurrentScenario = this.getModel("detailView").getProperty("/currentScenario");

            const sDocType = this.getModel("detailView").getProperty("/currentDocumentType");
            const bIsXml = (sDocType && (sDocType.toUpperCase().includes("XML") || (this.getModel("detailView").getProperty("/currentFileName") && this.getModel("detailView").getProperty("/currentFileName").toLowerCase().endsWith(".xml"))));

            if (bIsXml) {
                const sVendorTag = this._sXmlVendorTag ? this._encodeKeys(this._sXmlVendorTag) : null;
                const sPoTag = this._sXmlPoRefTag ? this._encodeKeys(this._sXmlPoRefTag) : null;
                const sInvoiceTag = this._sXmlInvoiceNumberTag ? this._encodeKeys(this._sXmlInvoiceNumberTag) : null;
                const sCompanyTag = this._sXmlCompanyCodeTag ? this._encodeKeys(this._sXmlCompanyCodeTag) : null;

                if (sVendorTag && oData.header[sVendorTag] !== undefined) oCtx.setProperty("fornitore", String(oData.header[sVendorTag]));
                if (sPoTag && oData.header[sPoTag] !== undefined) oCtx.setProperty("ordine", String(oData.header[sPoTag]));
                if (sInvoiceTag && oData.header[sInvoiceTag] !== undefined) oCtx.setProperty("invoiceNumber", String(oData.header[sInvoiceTag]));
                if (sCompanyTag && oData.header[sCompanyTag] !== undefined) oCtx.setProperty("companyCode", String(oData.header[sCompanyTag]));

                if (!oCtx.getProperty("fornitore") && oData.header.senderName !== undefined) oCtx.setProperty("fornitore", String(oData.header.senderName));
                if (!oCtx.getProperty("ordine") && oData.header.purchaseOrderNumber !== undefined) oCtx.setProperty("ordine", String(oData.header.purchaseOrderNumber));
                if (!oCtx.getProperty("invoiceNumber") && oData.header.invoiceNumber !== undefined) oCtx.setProperty("invoiceNumber", String(oData.header.invoiceNumber));
            } else {
                const aKeys = Object.keys(oData.header || {});
                const sSenderKey = aKeys.find(k => ["sendername", "fornitore", "vendorname"].includes(k.toLowerCase()));
                const sPoKey = aKeys.find(k => ["purchaseordernumber", "ordine", "ponumber"].includes(k.toLowerCase()));
                const sInvoiceKey = aKeys.find(k => ["invoicenumber", "documentnumber"].includes(k.toLowerCase()));

                if (sSenderKey && oData.header[sSenderKey] !== undefined) oCtx.setProperty("fornitore", String(oData.header[sSenderKey]));
                if (sPoKey && oData.header[sPoKey] !== undefined) oCtx.setProperty("ordine", String(oData.header[sPoKey]));
                if (sInvoiceKey && oData.header[sInvoiceKey] !== undefined) oCtx.setProperty("invoiceNumber", String(oData.header[sInvoiceKey]));
            }
            const aAllKeys = Object.keys(oData.header || {});
            const sCompKey = aAllKeys.find(k => ["companycode", "bukrs"].includes(k.toLowerCase()));
            if (sCompKey && oData.header[sCompKey] !== undefined) oCtx.setProperty("companyCode", String(oData.header[sCompKey]));
            oCtx.setProperty("scenario", sCurrentScenario);
            // Capture current scenario to restore later
            var sCurrentScenario = this.getModel("detailView").getProperty("/currentScenario");
            var oConversions = this.getModel("detailView").getProperty("/conversions") || { header: {}, items: [] };
            // Save the entire state for reloading
            const sJson = JSON.stringify({
                scenario: sCurrentScenario,
                conversions: oConversions,
                header: oData.header,
                headerChecked: oData.headerChecked || {},
                items: oData.items,
                confidences: oData.confidences || {}
            });

            console.log("Saving Draft Data (length=" + sJson.length + "):", sJson);
            oCtx.setProperty("extractedData", sJson);
            oCtx.setProperty("registrationStatus", "Draft");

            // Submit
            // Use $auto to ensure default group changes are also sent, or generic submit.
            // If "updateGroup" is not explicitly defined in manifest as Deferred, it might not work.
            // Using $auto is safer for V4 if we just want to flush.
            if (this.getModel().hasPendingChanges()) {
                this.getModel().submitBatch("$auto").then(() => {
                    MessageToast.show(this.getResourceBundle().getText("saveSuccess"));
                }).catch(err => {
                    MessageBox.error(this.getResourceBundle().getText("errorSaveDraft") + ": " + err.message);
                });
            } else {
                MessageToast.show(this.getResourceBundle().getText("noChanges"));
            }
        },
        _validate: function () {
            var oViewProp = this.getModel("detailView").getData();
            var oData = this.getModel("editableData").getData();
            const sDocType = this.getModel("detailView").getProperty("/currentDocumentType");
            const bIsXml = sDocType === "XML" || (sDocType && sDocType.toUpperCase().includes("XML"));

            var bValid = true;
            var bControlledValid = true;
            if (oViewProp.headerFields) {
                oViewProp.headerFields.forEach(function (oField) {
                    if (oField.visible === false) return;
                    const safeName = bIsXml ? this._encodeKeys(oField.fieldName) : oField.fieldName;
                    if (oField.mandatory && (!oData.header || !oData.header[safeName])) bValid = false;
                    if (oField.toBeControlled && !(oData.headerChecked && oData.headerChecked[this._encodeKeys(oField.fieldName)])) bControlledValid = false;
                }.bind(this));
            }
            // Unified Validation: Always iterate through groups
            if (oData.items && typeof oData.items === 'object' && oViewProp.itemGroups) {
                Object.keys(oData.items).forEach(sType => {
                    const aFields = oViewProp.itemGroups[sType];
                    if (aFields && Array.isArray(oData.items[sType])) {
                        oData.items[sType].forEach(oItem => {
                            aFields.forEach(oField => {
                                if (oField.visible === false) return;
                                const safeName = this._encodeKeys(oField.fieldName);
                                if (oField.mandatory && !oItem[safeName]) bValid = false;
                                if (oField.toBeControlled && !(oItem._checked && oItem._checked[safeName])) bControlledValid = false;
                            });
                        });
                    }
                });
            }
            return { mandatory: bValid, controlled: bControlledValid };
        },
        onSimulate: function () {
            var oCtx = this.getView().getBindingContext();
            if (oCtx && oCtx.getProperty("registrationStatus") === "Registered") {
                return; // Guard to prevent execution
            }
            // Validation
            if (!this._validate()) {
                MessageBox.error(this.getResourceBundle().getText("validationErrorMandatory"));
                return;
            }
            // Skip Conversions on Simulate (Requirement: "Anche al simulate non devono partire")
            this._postInvoice(true, true);
        },
        onRerunConversions: function () {
            var oModel = this.getView().getModel("editableData");
            var oData = oModel.getData();
            const sScenario = this.getModel("detailView").getProperty("/currentScenario") || "MM";

            // Prepare Overrides
            var oHeaderData = oData.header;
            var oItemsData = oData.items;

            // Decode XML field names with slashes
            if (sScenario === "FI" || sScenario === "MM") {
                var bIsXml = this.getModel("detailView").getProperty("/currentDocumentType") === "XML";
                if (bIsXml) {
                    oHeaderData = this._decodePayload(oHeaderData);
                    oItemsData = this._decodePayload(oItemsData);
                }
            }

            var sHeaderData = JSON.stringify(oHeaderData);
            var sItemsData = JSON.stringify(oItemsData);

            var oCtx = this.getView().getBindingContext();
            var sId = oCtx.getProperty("id");

            this.getView().setBusy(true);

            // Call simulateMapping with explicit data
            var oOperation = this.getView().getModel().bindContext("/simulateMapping(...)");
            oOperation.setParameter("id", sId);
            oOperation.setParameter("scenario", sScenario);
            oOperation.setParameter("headerData", sHeaderData);
            oOperation.setParameter("itemsData", sItemsData);

            var that = this;
            oOperation.execute().then(function () {
                var oResult = oOperation.getBoundContext().getObject();
                var sPayload = oResult.value || oResult;
                if (typeof sPayload === "string") {
                    sPayload = JSON.parse(sPayload);
                }

                // Retrieve Mappings
                const aMappings = that.getModel("detailView").getProperty("/allMappings").filter(m => (m.scenario || 'MM') === sScenario);

                // Map w/ Merge and Existing Data (for confidence preservation)
                that._mapPayloadToUI(sPayload, aMappings, oData, true);

                sap.m.MessageToast.show(that.getResourceBundle().getText("rerunSuccess") || "Conversions Updated");
                that.getView().setBusy(false);
            }).catch(function (err) {
                console.error("Rerun failed", err);
                MessageBox.error(that.getResourceBundle().getText("errorRerunFailed") + err.message);
                that.getView().setBusy(false);
            });
        },
        _postInvoice: function (bIsSimulation, bSkipConversions) {
            var that = this;
            var sCountryCode = this.getOwnerComponent().getModel("appView").getProperty("/selectedCountryCode");

            // Get ID from binding context
            var oCtx = this.getView().getBindingContext();
            var sId = oCtx.getProperty("id");
            if (!sId) {
                MessageBox.error(this.getResourceBundle().getText("missingId"));
                return;
            }
            // SAVE STATE (PERSISTENCE FIX) - Only on real registration (not simulation)
            if (!bIsSimulation) {
                var oDataModel = this.getModel("editableData");
                var oData = oDataModel.getData();

                // Auto switch to FI disabled (manual switch only)
                /*
                // Auto switch to FI if PO is cleared before saving state
                var sCurrentScenario = this.getModel("detailView").getProperty("/currentScenario");
                var bHasPo = this._hasPO(oData);
                
                if (sCurrentScenario === "MM" && !bHasPo) {
                    this.getModel("detailView").setProperty("/currentScenario", "FI");
                    sCurrentScenario = "FI";
                    this._applyScenarioConfig("FI");
                    sap.m.MessageToast.show(this.getResourceBundle().getText("autoSwitchedToFI") || "PO removed. Switched to Scenario FI.");
                }
                */
                var sCurrentScenario = this.getModel("detailView").getProperty("/currentScenario");
                // Capture current scenario and conversions
                var oConversions = this.getModel("detailView").getProperty("/conversions") || { header: {}, items: [] };
                // Update Local Properties first
                const aKeys = Object.keys(oData.header || {});
                const sSenderKey = aKeys.find(k => ["sendername", "fornitore", "vendorname"].includes(k.toLowerCase()));
                const sPoKey = aKeys.find(k => ["purchaseordernumber", "ordine", "ponumber"].includes(k.toLowerCase()));
                const sInvoiceKey = aKeys.find(k => ["invoicenumber", "documentnumber"].includes(k.toLowerCase()));
                const sCompKey = aKeys.find(k => ["companycode", "bukrs"].includes(k.toLowerCase()));

                if (sSenderKey && oData.header[sSenderKey] !== undefined) oCtx.setProperty("fornitore", oData.header[sSenderKey]);
                if (sPoKey && oData.header[sPoKey] !== undefined) oCtx.setProperty("ordine", oData.header[sPoKey]);
                if (sInvoiceKey && oData.header[sInvoiceKey] !== undefined) oCtx.setProperty("invoiceNumber", oData.header[sInvoiceKey]);
                if (sCompKey && oData.header[sCompKey] !== undefined) oCtx.setProperty("companyCode", oData.header[sCompKey]);
                const sJson = JSON.stringify({
                    scenario: sCurrentScenario,
                    conversions: oConversions,
                    header: oData.header,
                    items: oData.items,
                    confidences: oData.confidences || {}
                });
                // We update the 'extractedData' property to persist the FINAL state 
                // so re-opening works without re-triggering AI logic.
                oCtx.setProperty("extractedData", sJson);

                // Submit changes to ensure persistence even if registerInvoice only handles the action
                if (this.getModel().hasPendingChanges()) {
                    this.getModel().submitBatch("updateGroup").catch(e => console.warn("Failed to submit extractedData update", e));
                }
            }
            this.getView().setBusy(true);
            // 1. Call ID Service to Register/Simulate (The backend now handles the SAP Call)
            var oModel = this.getView().getModel();
            var oOperation = oModel.bindContext("/registerInvoice(...)");

            var oEditModel = this.getView().getModel("editableData");
            var oHeaderData = oEditModel.getProperty("/header") || {};
            var aItemsData = oEditModel.getProperty("/items") || [];

            var bIsXml = this.getModel("detailView").getProperty("/currentDocumentType") === "XML";

            if (bIsXml || (aItemsData && typeof aItemsData === 'object')) {
                // Decode XML fields (or unified objects) from '___' back to '/' structure
                oHeaderData = this._decodePayload(oHeaderData);
                aItemsData = this._decodePayload(aItemsData);

                // Propagate Header Purchase Order to Items
                var sPoVal = oHeaderData.purchaseOrderNumber || (this._sXmlPoRefTag ? oHeaderData[this._sXmlPoRefTag] : null);
                if (!sPoVal) {
                    const sPoKey = Object.keys(oHeaderData).find(k => k.endsWith(".purchaseOrderNumber") || k.endsWith(".purchaseOrder") || k.endsWith(".poNumber"));
                    if (sPoKey) sPoVal = oHeaderData[sPoKey];
                }

                if (sPoVal) {
                    if (aItemsData && typeof aItemsData === 'object') {
                        Object.keys(aItemsData).forEach(function (group) {
                            if (Array.isArray(aItemsData[group])) {
                                aItemsData[group].forEach(function (item) {
                                    const sItemPoKey = Object.keys(item).find(k => k === "purchaseOrderNumber" || k.endsWith(".purchaseOrderNumber") || k.endsWith(".purchaseOrder") || k.endsWith(".poNumber")) || "purchaseOrderNumber";
                                    if (item[sItemPoKey] === "" || item[sItemPoKey] === undefined) {
                                        item[sItemPoKey] = sPoVal;
                                    }
                                });
                            }
                        });
                    }
                }
            }

            console.log("DEBUG FRONTEND DATA - Header:", JSON.stringify(oHeaderData));
            console.log("DEBUG FRONTEND DATA - Items:", JSON.stringify(aItemsData));
            oOperation.setParameter("id", sId);
            oOperation.setParameter("countryCode", sCountryCode);
            oOperation.setParameter("headerData", JSON.stringify(oHeaderData));
            oOperation.setParameter("itemsData", JSON.stringify(aItemsData));
            oOperation.setParameter("Simulation", !!bIsSimulation);
            oOperation.setParameter("skipConversions", !!bSkipConversions);
            oOperation.execute().then(function () {
                // Submit property updates (extractedData) if any (non-simulation)
                if (!bIsSimulation && oModel.hasPendingChanges()) {
                    oModel.submitBatch("updateGroup").catch(e => console.warn("Failed to submit property updates", e));
                }
                var oResult = oOperation.getBoundContext().getObject();
                var sSapResponse = oResult.value || oResult;

                console.log("SAP Response received from backend:", sSapResponse);

                var oSapData = {};
                if (typeof sSapResponse === 'string') {
                    try {
                        oSapData = JSON.parse(sSapResponse);
                        // Handle OData V2 wrapper if present (d.results or d)
                        if (oSapData.d) oSapData = oSapData.d;
                    } catch (e) {
                        console.warn("Could not parse SAP response JSON", e);
                        oSapData = { SupplierInvoice: "Registered (Unknown ID)" };
                    }
                } else {
                    oSapData = sSapResponse;
                }
                // Extract Document Number
                var sDocNo = oSapData.SupplierInvoice || oSapData.InternalID || "Registered";
                if (bIsSimulation) {
                    // MessageBox.success(that.getResourceBundle().getText("simulationSuccess") || "Simulazione completata con successo: " + sDocNo);
                    that._showSimulationResult(oSapData);

                    // Clear error status if previously set
                    var oCtx = that.getView().getBindingContext();
                    if (oCtx && oCtx.getProperty("registrationStatus") === "Error") {
                        that._updateStatus("Extracted", null, "");
                    }
                } else {
                    // User Requirement: Show RefDocNo (Invoice No) and InvYear
                    let sRefDocNo = oSapData.RefDocNo || oSapData.SupplierInvoice; // Fallback
                    let sInvYear = oSapData.InvYear || oSapData.FiscalYear;
                    let sSuccessMsg = that.getResourceBundle().getText("registerSuccess") + ": " + sDocNo;
                    if (sRefDocNo) {
                        sSuccessMsg = that.getResourceBundle().getText("msgInvoiceRegistered") + ": " + sRefDocNo;
                        if (sInvYear) {
                            sSuccessMsg += " / " + sInvYear;
                        }
                    }
                    MessageBox.success(sSuccessMsg);
                    that._updateStatus("Registered", sDocNo);
                }
                that.getView().setBusy(false);
            }).catch(function (oError) {
                console.error("Registration Error", oError);

                var sMsg = that.getResourceBundle().getText("unknownError");
                var sDetailedLog = "";
                // Error Handling (CAP V4 Error Structure)
                if (oError.error && oError.error.message) {
                    sMsg = oError.error.message;
                    // Check for nested SAP details if passed by backend
                    // Backend returns: req.error(502, `SAP Error: ${JSON.stringify(error.response.data)}`);
                    // So the message might contain JSON.
                } else if (oError.message) {
                    sMsg = oError.message;
                }

                if (sMsg && sMsg.includes("COMPANY_CODE_NOT_ALLOWED")) {
                    sMsg = that.getResourceBundle().getText("companyCodeNotAllowed");
                }

                // Try to parse detailed SAP error from message if it looks like JSON
                if (sMsg.includes("SAP_ERROR_JSON:")) {
                    try {
                        const jsonStr = sMsg.split("SAP_ERROR_JSON:")[1];
                        const errObj = JSON.parse(jsonStr);
                        sMsg = errObj.message || sMsg;
                        if (errObj.details) {
                            sDetailedLog = JSON.stringify(errObj.details);
                        }
                    } catch (e) { console.warn("Failed to parse SAP_ERROR_JSON", e); }
                } else if (sMsg.includes("{")) {
                    try {
                        const match = sMsg.match(/SAP Error: (.*)/);
                        if (match && match[1]) {
                            const sapErrJson = JSON.parse(match[1]);
                            // Standard OData Error Parsing
                            if (sapErrJson.error && sapErrJson.error.message && sapErrJson.error.message.value) {
                                sMsg = sapErrJson.error.message.value;
                            }
                            if (sapErrJson.error && sapErrJson.error.innererror && sapErrJson.error.innererror.errordetails) {
                                sDetailedLog = JSON.stringify(sapErrJson.error.innererror.errordetails);
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
                MessageBox.error(that.getResourceBundle().getText("errorRegistrationFailed") + sMsg);

                // Update Status to Error
                if (sDetailedLog) {
                    that._updateStatus("Error", null, sDetailedLog);
                } else {
                    // If no detailed log, just put the main message? Or leave empty?
                    // Usually better to have something.
                    that._updateStatus("Error", null, JSON.stringify([{ message: sMsg, severity: 'error' }]));
                }
                that.getView().setBusy(false);
            });
        },
        _showSimulationResult: function (oSapData) {
            console.log("Showing Simulation Result", oSapData);

            // 1. Prepare Data
            var oHeader = oSapData || {};

            // Extract Sub-tables
            var aItems = [];
            if (oSapData.ItemDataSet) {
                if (Array.isArray(oSapData.ItemDataSet)) aItems = oSapData.ItemDataSet; // Flat V2?
                else if (oSapData.ItemDataSet.results) aItems = oSapData.ItemDataSet.results; // V2
                else if (Array.isArray(oSapData.ItemDataSet.results)) aItems = oSapData.ItemDataSet.results; // Nested
            }

            var aTaxes = [];
            if (oSapData.TaxDataSet) {
                if (Array.isArray(oSapData.TaxDataSet)) aTaxes = oSapData.TaxDataSet;
                else if (oSapData.TaxDataSet.results) aTaxes = oSapData.TaxDataSet.results;
            }
            var aGlAccounts = [];
            if (oSapData.GlAccountDataSet) {
                if (Array.isArray(oSapData.GlAccountDataSet)) aGlAccounts = oSapData.GlAccountDataSet;
                else if (oSapData.GlAccountDataSet.results) aGlAccounts = oSapData.GlAccountDataSet.results;
            }
            var aWithTax = [];
            if (oSapData.WithTaxDataSet) {
                if (Array.isArray(oSapData.WithTaxDataSet)) aWithTax = oSapData.WithTaxDataSet;
                else if (oSapData.WithTaxDataSet.results) aWithTax = oSapData.WithTaxDataSet.results;
            }


            const dateFormat = sap.ui.core.format.DateFormat.getDateInstance({
                pattern: "yyyy-MM-dd"
            });
            Object.keys(oHeader).forEach(key => {
                if (oHeader[key] && typeof oHeader[key] === 'string' && oHeader[key].includes("/Date(")) {
                    // Basic parsing for /Date(timestamp)/
                    const match = oHeader[key].match(/\/Date\((\d+)\)\//);
                    if (match) {
                        oHeader[key] = dateFormat.format(new Date(Number(match[1])), true);
                    }
                }
            });
            var oModel = new JSONModel({
                header: oHeader,
                items: aItems,
                glAccounts: aGlAccounts,
                taxes: aTaxes,
                withholdingTaxes: aWithTax
            });
            var oView = this.getView();
            this._oSimulationDialog = this.byId("simulationResultDialog");

            if (!this._oSimulationDialog) {
                Fragment.load({
                    id: oView.getId(),
                    name: "apinvoiceextraction.view.SimulationResult",
                    controller: this
                }).then(function (oDialog) {
                    this._oSimulationDialog = oDialog;
                    oView.addDependent(this._oSimulationDialog);
                    this._oSimulationDialog.setModel(oModel, "simulationModel");
                    this._oSimulationDialog.open();
                }.bind(this));
            } else {
                this._oSimulationDialog.setModel(oModel, "simulationModel");
                this._oSimulationDialog.open();
            }
        },
        onCloseSimulationResult: function () {
            if (this._oSimulationDialog) {
                this._oSimulationDialog.close();
            }
        },

        // ... _uploadAttachment unchanged ...
        // Show SAP Error Log
        onShowErrors: function () {
            var oCtx = this.getView().getBindingContext();
            if (!oCtx) return;
            // sSapErrorLog should now be available from the view binding
            var sSapErrorLog = oCtx.getProperty("sapErrorLog");

            if (!sSapErrorLog) {
                // Determine if it's because it's truly empty or technically missing (though binding should fix this)
                // If it's missing from cache despite binding, we might still need to fetch it, 
                // but usually binding is enough. 
                // As a fallback, if we are in Error status but have no log, show a generic message in the popup
                sSapErrorLog = JSON.stringify([{ message: this.getResourceBundle().getText("noErrorLog"), severity: 'warning' }]);
            }
            var aErrors = [];
            try {
                aErrors = JSON.parse(sSapErrorLog);
            } catch (e) {
                aErrors = [{ message: sSapErrorLog, severity: 'error' }];
            }

            // If parsing resulted in empty array (e.g. backend saved "[]"), fall back to raw string
            if (Array.isArray(aErrors) && aErrors.length === 0) {
                aErrors = [{ message: sSapErrorLog, severity: 'error' }];
            }
            var oList = new sap.m.List();
            aErrors.forEach(function (err) {
                var sMsg = "";
                if (err.message) {
                    if (typeof err.message === "object" && err.message.value) {
                        sMsg = err.message.value;
                    } else if (typeof err.message === "string") {
                        sMsg = err.message;
                    } else {
                        sMsg = JSON.stringify(err.message);
                    }
                } else if (err.value) {
                    sMsg = err.value;
                } else {
                    sMsg = JSON.stringify(err);
                }
                var sCode = err.code || "";
                var aContent = [
                    new sap.m.ExpandableText({
                        text: sMsg,
                        maxCharacters: 200,
                        renderWhitespace: false
                    })
                ];
                if (sCode) {
                    aContent.unshift(new sap.m.ObjectStatus({
                        text: sCode,
                        state: "Error"
                    }));
                }
                oList.addItem(new sap.m.CustomListItem({
                    content: [new sap.m.VBox({ items: aContent })]
                }));
            });
            var oDialog = new sap.m.Dialog({
                title: this.getResourceBundle().getText("showErrors"),
                contentWidth: "500px",
                content: [oList],
                beginButton: new sap.m.Button({
                    text: this.getResourceBundle().getText("close"),
                    press: function () {
                        oDialog.close();
                    }
                }),
                afterClose: function () {
                    oDialog.destroy();
                }
            });
            this.getView().addDependent(oDialog);
            oDialog.open();
        },
        // --- Conversion Info Popover Logic ---
        onShowConversionInfo: function (oEvent) {
            var oButton = oEvent.getSource();
            var sFieldName = oButton.data("fieldName");
            var iItemIndex = oButton.data("itemIndex");
            var sGroupType = oButton.data("groupType");
            var oView = this.getView();
            var oDetailModel = oView.getModel("detailView");

            var oConversions = oDetailModel.getProperty("/conversions");

            var oConversionInfo = this._getConversionInfoData(sFieldName, oConversions, iItemIndex, sGroupType);

            if (!oConversionInfo) return;
            var oModel = new JSONModel(oConversionInfo);

            var oView = this.getView();
            this._oConversionPopover = this.byId("conversionPopover");

            if (!this._oConversionPopover) {
                Fragment.load({
                    id: oView.getId(),
                    name: "apinvoiceextraction.view.ConversionInfoPopover",
                    controller: this
                }).then(function (oPopover) {
                    this._oConversionPopover = oPopover;
                    oView.addDependent(this._oConversionPopover);
                    this._oConversionPopover.setModel(oModel, "conversionModel");
                    this._oConversionPopover.openBy(oButton);
                }.bind(this));
            } else {
                this._oConversionPopover.setModel(oModel, "conversionModel");
                this._oConversionPopover.openBy(oButton);
            }
        },
        onCloseConversionInfo: function () {
            if (this._oConversionPopover) {
                this._oConversionPopover.close();
            }
        },
        _hasConversionInfo: function (sFieldName, oConversions, iItemIndex, sGroupType) {
            if (!oConversions) return false;

            if (iItemIndex !== undefined && iItemIndex !== null) {
                if (!oConversions.items) return false;

                var oItemConv = null;
                // If it's a grouped object (XML), look inside the group
                if (sGroupType && oConversions.items[sGroupType]) {
                    oItemConv = oConversions.items[sGroupType][iItemIndex];
                } else if (Array.isArray(oConversions.items)) {
                    // Fallback to flat array (PDF)
                    oItemConv = oConversions.items[iItemIndex];
                }

                if (!oItemConv) return false;
                return !!oItemConv[sFieldName];
            } else {
                if (!oConversions.header) return false;
                return !!oConversions.header[sFieldName];
            }
        },
        _getConversionInfoData: function (sFieldName, oConversions, iItemIndex, sGroupType) {
            if (!oConversions) return null;

            var oInfo = null;
            if (iItemIndex !== undefined && iItemIndex !== null) {
                if (oConversions.items) {
                    var oItemConv = null;
                    if (sGroupType && oConversions.items[sGroupType]) {
                        oItemConv = oConversions.items[sGroupType][iItemIndex];
                    } else if (Array.isArray(oConversions.items)) {
                        oItemConv = oConversions.items[iItemIndex];
                    }

                    if (oItemConv) {
                        oInfo = oItemConv[sFieldName];
                    }
                }
            } else {
                if (oConversions.header) {
                    oInfo = oConversions.header[sFieldName];
                }
            }
            if (oInfo) {
                return {
                    original: oInfo.original,
                    converted: oInfo.converted,
                    function: oInfo.functionName,
                    error: oInfo.error
                };
            }
            return null;
        },
        _updateStatus: function (sStatus, sEbeln, sSapErrorLog) {
            var oCtx = this.getView().getBindingContext();
            oCtx.setProperty("registrationStatus", sStatus);
            this.getModel("detailView").setProperty("/isEditable", sStatus !== 'Registered');

            if (sEbeln) {
                oCtx.setProperty("EbelnGen", sEbeln);
            }

            if (sSapErrorLog) {
                oCtx.setProperty("sapErrorLog", sSapErrorLog);
            }

            // Submit changes
            this.getModel().submitBatch("updateGroup");
        },
        // --- Agent Execution History ---
        onShowExecutionHistory: function () {
            var oCtx = this.getView().getBindingContext();
            if (!oCtx) return;
            // Request agentLog property explicitly ensuring it's loaded
            oCtx.requestProperty("agentLog").then(sAgentLog => {
                if (!sAgentLog) {
                    sap.m.MessageToast.show(this.getResourceBundle().getText("noAgentLog") || "No execution history available.");
                    return;
                }
                let aLogs = [];
                try {
                    aLogs = JSON.parse(sAgentLog);
                } catch (e) {
                    console.error("Failed to parse agent log", e);
                    aLogs = [{ type: "Error", message: "Failed to parse log", timestamp: new Date() }];
                }

                // Map logs to timeline items
                const aTimelineData = aLogs.map(log => this._mapLogToTimelineItem(log));
                var oModel = new sap.ui.model.json.JSONModel({ logs: aTimelineData });

                var oView = this.getView();
                this._oAgentHistoryDialog = this.byId("agentHistoryDialog");

                if (!this._oAgentHistoryDialog) {
                    Fragment.load({
                        id: oView.getId(),
                        name: "apinvoiceextraction.view.AgentHistory",
                        controller: this
                    }).then(function (oDialog) {
                        this._oAgentHistoryDialog = oDialog;
                        oView.addDependent(this._oAgentHistoryDialog);
                        this._oAgentHistoryDialog.setModel(oModel, "agentLog");
                        this._oAgentHistoryDialog.open();
                    }.bind(this));
                } else {
                    this._oAgentHistoryDialog.setModel(oModel, "agentLog");
                    this._oAgentHistoryDialog.open();
                }
            }).catch(err => {
                console.error("Error fetching agent log", err);
                sap.m.MessageToast.show(this.getResourceBundle().getText("errorFetchingLog"));
            });
        },
        onCloseExecutionHistory: function () {
            if (this._oAgentHistoryDialog) {
                this._oAgentHistoryDialog.close();
            }
        },
        _mapLogToTimelineItem: function (log) {
            let item = {
                timestamp: new Date(log.timestamp), // FeedListItem handles Date object or string
                title: log.type,
                icon: "sap-icon://circle-task-2",
                status: "None", // FeedListItem info
                text: log.message || "" // FeedListItem text
            };
            switch (log.type) {
                case "ProcessingMode":
                    item.title = this.getResourceBundle().getText("processModeTitle") || "Processing Mode";
                    item.icon = log.message === "image" ? "sap-icon://picture" : "sap-icon://document-text";
                    item.status = "Information";
                    item.text = log.message === "image" ? this.getResourceBundle().getText("processModeImage") : this.getResourceBundle().getText("processModeText");
                    break;
                case "ChainStart":
                    item.title = "Start";
                    item.icon = "sap-icon://begin";
                    item.status = "Success";
                    item.text = "Agent Execution Started";
                    break;
                case "SystemPrompt":
                    item.title = "System Instructions";
                    item.icon = "sap-icon://script";
                    item.status = "Information";
                    item.text = (log.data && log.data.text) ? log.data.text : "No prompt data";
                    break;
                case "LLMStart":
                    item.title = "Thinking";
                    item.icon = "sap-icon://ai";
                    item.status = "Information";
                    item.text = `Analysis started (${log.data ? log.data.promptCount : '?'} prompts)`;
                    break;
                case "LLMEnd":
                    item.title = "Thought Generated";
                    item.icon = "sap-icon://ai";
                    item.status = "Warning";
                    item.text = (log.data && log.data.text) ? log.data.text : "Reasoning complete";
                    break;
                case "ToolStart":
                    item.title = "Action: " + (log.toolName || "Unknown Tool");
                    item.icon = "sap-icon://machine-learning";
                    item.status = "None";
                    if (log.input) {
                        let sInput = typeof log.input === 'object' ? JSON.stringify(log.input, null, 2) : String(log.input);
                        item.text = "Input: " + sInput;
                    } else {
                        item.text = "Executing tool...";
                    }
                    break;
                case "ToolEnd":
                    item.title = "Action Completed";
                    item.icon = "sap-icon://machine-learning";
                    item.status = "Success";
                    if (log.output) {
                        let sOutput = typeof log.output === 'object' ? JSON.stringify(log.output, null, 2) : String(log.output);
                        item.text = "Output: " + sOutput;
                    } else {
                        item.text = "Tool execution finished";
                    }
                    break;
                case "ToolError":
                    item.title = "Action Failed";
                    item.icon = "sap-icon://error";
                    item.status = "Error";
                    item.text = log.error || "Unknown error";
                    break;
                case "ChainEnd":
                    item.title = "Finished";
                    item.icon = "sap-icon://flag";
                    item.status = "Success";
                    item.text = "Execution Completed. Output: " + (log.finalOutput || "");
                    break;
                default:
                    item.text = log.message || JSON.stringify(log);
            }

            return item;
        },
        _encodeKeys: function (sKey) {
            if (!sKey) return sKey;
            return sKey.replace(/\//g, "___").replace(/\./g, "___dot___");
        },
        _decodeKeys: function (oData) {
            if (!oData) return oData;
            const oDecoded = {};
            Object.keys(oData).forEach(key => {
                const sOriginalKey = key.replace(/___dot___/g, ".").replace(/___/g, "/");
                oDecoded[sOriginalKey] = oData[key];
            });
            return oDecoded;
        },
        _encodeItems: function (aItems) {
            if (!aItems || !Array.isArray(aItems)) return aItems;
            return aItems.map(item => {
                const oEncoded = {};
                Object.keys(item).forEach(key => {
                    oEncoded[this._encodeKeys(key)] = item[key];
                });
                return oEncoded;
            });
        },
        _decodeItems: function (aItems) {
            if (!aItems || !Array.isArray(aItems)) return aItems;
            return aItems.map(item => this._decodeKeys(item));
        },
        _decodePayload: function (oData) {
            if (!oData) return oData;
            if (Array.isArray(oData)) {
                return oData.map(item => this._decodePayload(item));
            } else if (typeof oData === 'object') {
                const oDecoded = {};
                Object.keys(oData).forEach(k => {
                    const sOriginalKey = k.replace(/___dot___/g, ".").replace(/___/g, "/");
                    oDecoded[sOriginalKey] = this._decodePayload(oData[k]);
                });
                return oDecoded;
            }
            return oData;
        },
        _hasPO: function (oData) {
            if (!oData) return false;

            let bHasPo = false;
            let searchTags = ['purchaseOrderNumber', 'purchaseOrder', 'poNumber'];
            const sDocType = this.getModel("detailView").getProperty("/currentDocumentType");
            const bIsXml = (sDocType && (sDocType.toUpperCase().includes("XML") || (this.getModel("detailView").getProperty("/currentFileName") && this.getModel("detailView").getProperty("/currentFileName").toLowerCase().endsWith(".xml"))));
            const sXmlPoRefTag = this._sXmlPoRefTag;

            if (bIsXml && sXmlPoRefTag && sXmlPoRefTag.trim() !== '') {
                searchTags = [sXmlPoRefTag.trim()];
            }

            if (bIsXml) {
                let aExpandedTags = [...searchTags];
                // Expand search tags to include encoded versions and check all header/item keys for prefixed matches
                searchTags.forEach(tag => {
                    const encoded = this._encodeKeys(tag);
                    if (encoded !== tag && !aExpandedTags.includes(encoded)) {
                        aExpandedTags.push(encoded);
                    }
                    // Find any key in header that ends with this tag (e.g. Header.purchaseOrderNumber)
                    Object.keys(oData.header || {}).forEach(k => {
                        if (k.endsWith("." + tag) || k.endsWith("___dot___" + tag)) {
                            if (!aExpandedTags.includes(k)) aExpandedTags.push(k);
                        }
                    });
                });
                searchTags = aExpandedTags;
            }

            if (oData.header) {
                if (searchTags.some(tag => !!oData.header[tag])) {
                    bHasPo = true;
                }
            }

            if (!bHasPo && oData.items) {
                let items = oData.items;
                let aItemsList = [];
                if (Array.isArray(items)) {
                    aItemsList = items;
                } else if (typeof items === 'object') {
                    Object.keys(items).forEach(k => {
                        if (Array.isArray(items[k])) {
                            aItemsList = aItemsList.concat(items[k]);
                        }
                    });
                }
                bHasPo = aItemsList.some(item => {
                    return searchTags.some(tag => {
                        // For items we also check prefixed keys if it's XML
                        if (!!item[tag]) return true;
                        if (bIsXml) {
                            return Object.keys(item).some(k => (k.endsWith("." + tag) || k.endsWith("___dot___" + tag)) && !!item[k]);
                        }
                        return false;
                    });
                });
            }
            return bHasPo;
        },
    });
});
