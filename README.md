# Getting Started

Welcome to your new project.

It contains these folders and files, following our recommended project layout:

File or Folder | Purpose
---------|----------
`app/` | content for UI frontends goes here
`db/` | your domain models and data go here
`srv/` | your service models and code go here
`package.json` | project metadata and configuration
`readme.md` | this getting started guide


## Next Steps

- Open a new terminal and run `cds watch`
- (in VS Code simply choose _**Terminal** > Run Task > cds watch_)
- Start adding content, for example, a [db/schema.cds](db/schema.cds).


## Learn More

Learn more at https://cap.cloud.sap/docs/get-started/.

## Configurazione SAP AI Core (Generative AI Hub)

L'applicazione accede agli LLM tramite una **destination del subaccount BTP** (nessun
binding diretto al servizio `aicore`). Servono quindi due informazioni:

| Parametro | Valore attuale | Significato |
|---|---|---|
| Destination | `AI_Core` | destination BTP che punta all'AI API (connessione `myaicoreconnection`) |
| Resource group | `default` | workspace all'interno della connessione, come mostrato in SAP AI Launchpad |

I valori sono definiti in tre livelli, dal piu' specifico al piu' generico:

1. variabili d'ambiente `AI_CORE_DESTINATION` / `AI_CORE_RESOURCE_GROUP` /
   `AI_CORE_MODEL` / `AI_CORE_TEMPERATURE` (impostate per il modulo `AP_Invoice-srv`
   in [mta.yaml](mta.yaml), quindi modificabili per singolo space senza toccare il codice);
2. il blocco `cds.aicore` in [package.json](package.json);
3. i default in [srv/lib/AICoreConfig.js](srv/lib/AICoreConfig.js).

Il modello e la temperature possono inoltre essere sovrascritti per singolo paese
dalla configurazione (`aiModel` / `aiTemperature` nell'app *Config Country*), che ha
precedenza su tutto quanto sopra.

### Prerequisito: deployment dell'orchestration

L'SDK non usa un deployment ID fisso: ad ogni chiamata interroga l'AI API cercando un
deployment dello scenario `orchestration` **in stato `RUNNING`** dentro il resource
group configurato (header `AI-Resource-Group`). Non esiste modo di forzare un
deployment ID con l'`OrchestrationClient`.

Di conseguenza la sola *Configuration* (es. `defaultOrchestrationConfig`) **non basta**:
in SAP AI Launchpad, da quella configuration va creato un **Deployment**
(*ML Operations > Deployments*) e va atteso che passi in stato `RUNNING`.
Il modello scelto (`aiModel`, default `gemini-2.5-pro`) deve inoltre essere abilitato
nel Generative AI Hub del tenant.

Se il deployment manca, l'applicazione ora fallisce con un messaggio esplicito che
riporta destination e resource group usati, invece dell'errore generico dell'SDK.

## Deploy
modificare le destination :
AI_Core --> AI_Core
SAP-1C --> SAP-TEP

per deploy in test utilizzare mta_test.yaml e package.json
per deploy in prod utilizzare mta_prod.yaml e package.json
per lancio tool di sicurezza wizcli utilizzare package_for_scan_security.json
 
 
