const cds = require('@sap/cds');
// const proxy = require('@sap/cds-odata-v2-adapter-proxy'); // Unused and missing
// We will use a custom middleware
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");
const bodyParser = require('body-parser');

cds.on('bootstrap', app => {
    
    // Custom Proxy for ZFIN_APINVOICE_SRV (Local Testing)
    // Routes matching our xs-app.json definition
    const sapApiContext = "/sap/opu/odata/sap/ZFIN_APINVOICE_SRV";

    app.use(sapApiContext, async (req, res) => {
        console.log(`[Proxy] Forwarding ${req.method} ${req.originalUrl} to SAP-1C`);
        
        try {
            // Forward headers (excluding host/connection stuff)
            const headers = { ...req.headers };
            delete headers.host;
            delete headers.connection;
            delete headers['content-length']; // let SDK/axios handle re-calc

            // Use executeHttpRequest to handle destination connectivity
            // We need to pass the method, url (relative to destination), body
            
            // req.url contains the path *relative* to the mount point? 
            // Express 'app.use' strips the mount point from req.url, but req.originalUrl keeps it.
            // destination URL is the base. We want to append everything after the mount point?
            // Actually, usually the destination URL points to the host.
            // The path in the destination system is /sap/opu/odata/sap/ZFIN_APINVOICE_SRV...
            // So we probably want to pass the FULL path (req.originalUrl) or relative?
            // It depends on how the destination is configured.
            // Assuming destination URL = "https://my-sap-system.com"
            // We need to request "/sap/opu/odata/sap/ZFIN_APINVOICE_SRV/..."
            
            // Note: req.body might be parsed already if body-parser ran? 
            // CDS adds body parsers. If req.body is object, we validly pass it.
            
            const response = await executeHttpRequest(
                { destinationName: "SAP-1C" },
                {
                    method: req.method,
                    url: req.originalUrl, // Pass full path
                    data: req.body,
                    headers: headers
                    // responseType: 'arraybuffer' // crucial for binary/stream?, but for JSON likely fine.
                    // Actually, for OData $metadata/etc, we want text/xml/json.
                },
                {
                    fetchCsrfToken: false // We are proxying, so we pass X-CSRF-Token from client or let client handle handshake?
                    // The client (UI5) sends Fetch. We forward it. Backend returns it. We return it.
                }
            );

            // Forward response status and headers
            res.status(response.status);
            Object.entries(response.headers).forEach(([k, v]) => {
                res.setHeader(k, v);
            });
            
            // Send Data
            res.send(response.data);

        } catch (error) {
            console.error("[Proxy] Error:", error.message);
            if (error.response) {
                res.status(error.response.status).send(error.response.data);
            } else {
                res.status(500).send(error.message);
            }
        }
    });
});

module.exports = cds.server;
