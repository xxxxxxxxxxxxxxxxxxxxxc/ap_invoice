sap.ui.define([
    "sap/ui/core/library"
], function (coreLibrary) {
    "use strict";

    var ValueState = coreLibrary.ValueState;

    var STATES = {
        Uploaded: { state: ValueState.Information, icon: "sap-icon://pending" },
        Processing: { state: ValueState.Warning, icon: "sap-icon://synchronize" },
        Ready: { state: ValueState.Success, icon: "sap-icon://sys-enter-2" },
        Error: { state: ValueState.Error, icon: "sap-icon://error" }
    };

    var FILE_TYPES = {
        "application/pdf": "PDF",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
        "text/markdown": "MD"
    };

    return {
        statusText: function (sStatus) {
            if (!sStatus) {
                return "";
            }
            var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
            return oBundle.getText("status" + sStatus);
        },

        statusState: function (sStatus) {
            return (STATES[sStatus] || {}).state || ValueState.None;
        },

        statusIcon: function (sStatus) {
            return (STATES[sStatus] || {}).icon || "";
        },

        fileType: function (sMimeType) {
            return FILE_TYPES[sMimeType] || "";
        },

        fileSize: function (iBytes) {
            if (iBytes === null || iBytes === undefined) {
                return "";
            }
            if (iBytes < 1024) {
                return iBytes + " B";
            }
            if (iBytes < 1024 * 1024) {
                return (iBytes / 1024).toFixed(1) + " KB";
            }
            return (iBytes / (1024 * 1024)).toFixed(1) + " MB";
        }
    };
});
