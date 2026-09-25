const cds = require("@sap/cds");
const axios = require("axios"); // Still needed? Maybe for legacy or direct calls if any left. Keeping for safety.

// Handlers
const PDFHandler = require('./handlers/PDFHandler');
const DbHandler = require('./handlers/DbHandler');
const ConfigHandler = require('./handlers/ConfigHandler');
const PayloadHandler = require('./handlers/PayloadHandler');
const SearchHelpHandler = require('./handlers/SearchHelpHandler');
const XmlHandler = require('./handlers/XmlHandler');
const ZipHandler = require('./handlers/ZipHandler');
const ChatbotHandler = require('./handlers/ChatbotHandler');
const KnowledgeBaseHandler = require('./handlers/KnowledgeBaseHandler');

module.exports = cds.service.impl(async function (srv) {
  let gtwService, mailService;

  // --- CONNECT TO EXTERNAL SERVICES ---
  try {
    gtwService = await cds.connect.to("Z_CREAZ_EM_ODATA_SRV");
  } catch (e) {
    console.warn("⚠️  Mocking Z_CREAZ_EM_ODATA_SRV (missing credentials)");
    gtwService = {
      tx: () => ({ run: async () => [] }),
      send: async () => ({}),
    };
  }

  try {
    mailService = await cds.connect.to("ZPFN_ODATA_SRV");
  } catch (e) {
    console.warn("⚠️  Mocking ZPFN_ODATA_SRV (missing credentials)");
    mailService = { send: async () => ({}) };
  }

  // --- VALUE HELP & ENTITY HANDLERS ---

  this.on("READ", "TipiCaricamento", async (request) => {
    return [
        { TIPO: "A", DESC_TIPO: "Automatico" },
        { TIPO: "M", DESC_TIPO: "Manuale" }
    ];
  });

  this.on("READ", "StatiElaborazione", async (request) => {
    return [
        { stato: null, desc_stato: "Da elaborare" },
        { stato: "InvioOK", desc_stato: "Elaborato" },
        { stato: "KO", desc_stato: "In Errore" }
    ];
  });

  this.before("DELETE", "Countries", async (req) => {
      await DbHandler.onCascadeDeleteCountries(req, this.entities);
  });

  // --- GATEWAY & MAIL PROXIES ---

  this.on("READ", "ZET_FOR_VALIDATIONSet", async (request) => {
    console.log("Sono nel handler - entity: ZET_FOR_VALIDATIONSet");
    const result = await gtwService.tx(request).run(request.query);
    return result;
  });

  this.on("CREATE", "ZET_NUM_ORD_Set", async (request) => {
    console.log("Sono nel handler POST - entity: ZET_NUM_ORD_Set");
    let entity = request.req.path;
    return gtwService.send({
      method: "POST",
      path: entity,
      data: request.data,
    });
  });

  this.on("CREATE", "MAILSet", async (request) => {
    console.log("Sono nel handler POST - entity: MAILSet");
    let entity = request.req.path;
    return mailService.send({
      method: "POST",
      path: entity,
      data: request.data,
    });
  });

  // --- AI AGENT / JOB HANDLERS ---

  this.on("getJobs", async (request) => {
      // Legacy compatibility: Return empty or implement DB query if needed
      console.log("getJobs - Redirecting to DB query (Not Implemented, returning empty)");
      return []; 
  });

  this.on("getJobById", async (req) => {
      return await DbHandler.getJobStatus(req, this.entities);
  });

  this.on("getJobByIdV2", async (req) => {
      const status = await DbHandler.getJobStatus(req, this.entities);
      return {
          status: status.status,
          extraction: status.extraction
      };
  });

  this.on("getFileByJobId", async (req) => {
      return await DbHandler.getFileByJobId(req, this.entities);
  });

  this.on("syncDataFromAI", async (req) => {
      return await DbHandler.syncDataFromAI(req, this.entities);
  });

  this.on("UploadFile", async (req) => {
    console.log("Start upload file");
    console.log("File name",req.data.fileName);
      const fileName = (req.data.fileName || "").toLowerCase();
      if (fileName.endsWith('.zip')) {
          console.log("UploadFile Dispatch: Routing to ZipHandler");
          return await ZipHandler(req, this.entities);
      } else if (fileName.endsWith('.xml')) {
          console.log("UploadFile Dispatch: Routing to XmlHandler");
          return await XmlHandler(req, this.entities);
      } else {
          console.log("UploadFile Dispatch: Routing to PDFHandler 2.0");
          return await PDFHandler(req, this.entities);
      }
  });

  // --- CONFIGURATION HANDLERS ---
  
  this.on("getCountryFieldConfig", async (req) => {
      return await ConfigHandler.getCountryFieldConfig(req, this.entities);
  });

  this.on("loadDocumentAISchema", async (req) => {
      return await ConfigHandler.loadDocumentAISchema(req, this.entities);
  });

  this.on("loadODataEDMX", async (req) => {
      return await ConfigHandler.loadODataEDMX(req, this.entities);
  });

  this.on("saveConfiguration", async (req) => {
      return await ConfigHandler.saveConfiguration(req, this.entities);
  });

  this.on("detectFieldsFromXml", async (req) => {
      return await ConfigHandler.detectFieldsFromXml(req);
  });

  this.before("CREATE", "CountryFieldConfig", async (req) => {
      return await ConfigHandler.beforeCreateCountryFieldConfig(req, this.entities);
  });

  this.on("acquireLock", async (req) => {
      return await ConfigHandler.acquireLock(req, this.entities);
  });

  this.on("releaseLock", async (req) => {
      return await ConfigHandler.releaseLock(req, this.entities);
  });



  // --- PAYLOAD & REGISTRATION HANDLERS ---

  this.on("simulateMapping", async (req) => {
       return await PayloadHandler.simulateMapping(req, this.entities);
  });

  this.on("registerInvoice", async (req) => {
       return await PayloadHandler.registerInvoice(req, this.entities);
  });

  this.on("executeSearchHelp", async (req) => {
       return await SearchHelpHandler.executeSearchHelp(req, this.entities);
  });

  // --- CHATBOT HANDLER ---

  this.on("chatbotMessage", async (req) => {
       return await ChatbotHandler.chatbotMessage(req, this.entities);
  });

  // --- KNOWLEDGE BASE HANDLERS ---

  this.on("uploadKnowledgeDocument", async (req) => {
       return await KnowledgeBaseHandler.uploadKnowledgeDocument(req);
  });

  this.on("reprocessKnowledgeDocument", async (req) => {
       return await KnowledgeBaseHandler.reprocessKnowledgeDocument(req);
  });

  this.before("DELETE", "KnowledgeDocuments", async (req) => {
       await KnowledgeBaseHandler.beforeDeleteKnowledgeDocument(req);
  });

  this.on("getUserAllowedCountries", async (req) => {
    const email = req.user.email || req.user.id;
    if (!email || email === "anonymous") {
      const dbAllowed = await SELECT.from(this.entities.UserCountries, (uc) => {
        uc.country((c) => {
          c.code, c.name, c.description, c.active;
        });
      }).where({ email: "anonymous" });
      if (dbAllowed.length > 0) {
        return dbAllowed.map((x) => x.country);
      }
      return SELECT.from(this.entities.Countries).where({ active: true });
    }
    const allowed = await SELECT.from(this.entities.UserCountries, (uc) => {
      uc.country((c) => {
        c.code, c.name, c.description, c.active;
      });
    }).where({ email: email });
    return allowed.map((x) => x.country);
  });

});
