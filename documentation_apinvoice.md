# Documentazione Progetto AP Invoice

## 1. Panoramica del Progetto
**Nome Progetto:** AP Invoice (AP_Invoice)

**Descrizione Breve:** Soluzione end-to-end basata su SAP BTP per l'automazione del ciclo passivo. Il sistema permette l'acquisizione di fatture in formato PDF, immagine o XML, l'estrazione intelligente dei metadati tramite modelli generativi (LLM) e la successiva registrazione automatizzata o semi-automatizzata nei sistemi ERP SAP tramite servizi OData.

**Caso d'uso AI:** Estrazione strutturata di dati da documenti non strutturati (OCR intelligente e Parsing LLM). Utilizza agenti AI orchestrati tramite **LangGraph** per gestire flussi complessi di estrazione, validazione incrociata tra campi e applicazione di logiche di business (es. ricalcolo tasse, normalizzazione formati).

**Livello di Criticità Stimato:** **Alto**. Il sistema tratta documenti contabili e finanziari sensibili, interagisce direttamente con i processi di pagamento aziendali e gestisce dati relativi a fornitori e transazioni economiche.

---

## 2. Architettura del Sistema
**Diagramma di Flusso / Struttura:** Il sistema segue l'architettura **SAP Cloud Application Programming Model (CAP)**. Il flusso prevede: 
1. Caricamento documento (Frontend/API).
2. Processing AI tramite SAP AI Core.
3. Mapping dinamico dei dati estratti.
4. Registrazione in SAP ERP.

**Componenti Frontend / Client:** Web Application basata su **SAPUI5 / Fiori Elements**, ottimizzata per la revisione dei dati estratti, la configurazione delle regole di mapping per paese e il monitoraggio degli stati di elaborazione.

**Componenti Backend:** Servizi Node.js sviluppati con il framework **SAP CAP**. Orchestrazione AI implementata tramite **LangChain** e **@sap-ai-sdk**. Logica di integrazione SAP gestita via Cloud SDK.

**Hosting e Infrastruttura:** Interamente ospitato su **SAP Business Technology Platform (BTP)**, utilizzando servizi Cloud Foundry/Kyma e integrazioni native con l'ecosistema SAP.

---

## 3. Gestione dei Dati e Database (Data Security)
**Struttura del Database (DB):** 
- **SAP HANA Cloud** (ambiente di produzione) per la persistenza dei dati transazionali, configurazioni di mapping e log di sistema.
- **SQLite** utilizzato esclusivamente per lo sviluppo locale e test.

**Classificazione dei Dati:** 
- **Dati personali (PII):** Nomi di persone fisiche (fornitori), indirizzi mail.
- **Dati finanziari:** Importi, IBAN, numeri di fattura, dettagli IVA.
- **Documenti aziendali:** File PDF/Immagini delle fatture originali.

**Crittografia (At Rest & In Transit):** 
- **In Transit:** Tutte le comunicazioni sono protette da protocolli **TLS 1.2/1.3**.
- **At Rest:** SAP HANA Cloud utilizza la crittografia nativa dei volumi di storage (**AES-256**) gestita dalla piattaforma.

**Retention Policy:** I dati sono conservati nel database HANA fino alla cancellazione esplicita o secondo le policy di archiviazione definite nel tenant BTP del cliente. I log dell'agente AI sono memorizzati nel campo `agentLog` dell'entità `DocumentStatusBtp`.

---

## 4. Modelli AI e Gestione dei Prompt (AI Security)
**Modelli Utilizzati e Provider:** Utilizzo di modelli tramite **SAP AI Core (Generative AI Hub)**:
- **Gemini 1.5 Pro / Flash** (Google) testati per l'orchestrazione via LangGraph.

**Gestione dei Prompt di Sistema (System Prompts):** I System Prompt sono gestiti in modo dinamico e persistente. Sono salvati nel database HANA (tabella `db.Countries`, campo `systemPrompt`), permettendo configurazioni specifiche per nazione/scenario senza modifiche al codice sorgente.

**Input dell'Utente e Protezione da Prompt Injection:** Il sistema utilizza l'**Orchestration Client di SAP AI SDK**, che funge da proxy sicuro aggregando filtri di moderazione (Content Filtering) e tecniche di sanitizzazione degli input per prevenire attacchi di tipo Jailbreak o Injection.

**Architettura RAG (Retrieval-Augmented Generation):** Applicabile tramite **Function Calling**. L'AI non accede a un Vector DB esterno ma interroga dinamicamente il sistema tramite "Tools" definiti nel backend per recuperare master data SAP (es. Vendor lookup) rispettando il contesto dell'utente.

**Addestramento / Fine-Tuning:** Nessun dato utente viene utilizzato per il fine-tuning dei modelli base (GPT/Gemini). I modelli sono utilizzati "as-a-service" in modalità inference-only, garantendo che i dati non escano dal perimetro di sicurezza di SAP AI Core per scopi di training.

---

## 5. Autenticazione, Autorizzazione e Segreti (IAM & Secrets)
**Autenticazione Utenti:** Basata su **SAP XSUAA** (implementazione OAuth 2.0). Supporta Single Sign-On (SSO) tramite SAP ID Service o Identity Provider aziendali.

**Gestione dei Permessi (RBAC/ABAC):** Implementazione di **Role-Based Access Control** tramite scopes definiti nel file `xs-security.json`. L'accesso alle entità è limitato tramite annotazioni `@requires: 'authenticated-user'` o ruoli specifici (es. Admin per le configurazioni).

**Gestione delle API Key e dei Segreti:** Le chiavi dei provider AI e le credenziali SAP non sono mai esportate nel codice o nel client. Sono gestite tramite **SAP BTP Destinations** (es. `AI_Core`) e **Service Bindings**, garantendo l'isolamento completo dei segreti.

---

## 6. Integrazioni e Superficie di Attacco Esterna
**API ed Endpoint Esposti:** Endpoint OData V4 (es. `/service/CatalogService`) protetti da XSUAA. Include meccanismi nativi di SAP BTP per il **Rate Limiting** e protezione tramite SAP AppRouter.

**Servizi di Terze Parti:** 
- **SAP AI Core:** Per l'accesso agli LLM.

**Esecuzione di Codice / Plugin:** L'AI può richiamare esclusivamente le funzioni definite come "Tools" nel backend (Function Calling). Tali funzioni sono eseguite nell'ambiente Node.js del server CAP, senza possibilità di esecuzione di codice arbitrario da parte del modello.

---

## 7. Logging, Monitoraggio e Audit
**Sistema di Logging:** Integrazione con **SAP Application Logging Service** (Kibana/ELK stack) per i log di applicazione. I log di business dell'AI sono salvati direttamente nel DB HANA.

**Eventi Registrati:** 
- Tentativi di login e accessi API.
- Errori di estrazione e log di risposta degli agenti AI (`agentLog`).
- Tracking del consumo di token (`inputTokens`, `outputTokens`) per audit di costo e performance.

**Sanitizzazione dei Log:** I log salvati nel DB contengono i metadati dell'estrazione. I prompt possono contenere dati del documento; l'accesso a tali log è limitato agli utenti con privilegi amministrativi.

**Monitoraggio Abusi AI:** Monitoraggio tramite SAP AI Core delle quote di utilizzo e alert su consumi anomali. Implementazione di recursion limit (es. limit 200 in LangGraph) per prevenire loop infiniti o attacchi di denial-of-service computazionale.

---

## 8. Compliance e Normative
**Conformità:** Progettato per essere conforme al **GDPR** (grazie all'hosting su SAP BTP che fornisce i necessari accordi DPA) e predisposto per i requisiti dell'**EU AI Act** (trasparenza e monitoraggio dei sistemi AI ad alto rischio).

**Privacy degli Utenti:** Supporto per la cancellazione dei dati (Right to be Forgotten) attraverso la gestione dei record di estrazione e dei file associati nel database HANA
