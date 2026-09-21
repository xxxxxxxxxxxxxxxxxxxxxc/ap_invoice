const DbHandler = {
    // Cascade delete for Countries (Cleanup Mappings)
    async onCascadeDeleteCountries(req, entities) {
        const { code } = req.data;
        if (code) {
            console.log(`Cascading delete: Removing FieldMappings for Country ${code}`);
            const { FieldMappings } = entities;
            const DELETE = cds.ql.DELETE; // Ensure DELETE is available
            await DELETE.from(FieldMappings).where({ country_code: code });
        }
    },

    // Handler to get Job Status (replaces getJobById from DOX)
    async getJobStatus(req, entities) {
        const { DocumentStatusBtp } = entities;
        const { id } = req.data;
        
        if (!id) return req.reject(400, "Missing ID");

        const job = await SELECT.one.from(DocumentStatusBtp).where({ id: id });
        
        if (!job) return req.reject(404, "Job not found");

        // Map to structure expected by frontend (mimicking DOX somewhat or new format)
        return {
            id: job.id,
            status: job.status,
            extraction: job.extractedData ? JSON.parse(job.extractedData) : null
        };
    },

    async syncDataFromAI(req, entities) {
        const { DocumentStatusBtp } = entities;
        const { id } = req.data;

        if (!id) return { status: "FAILED", message: "Missing ID" };

        const job = await SELECT.one.from(DocumentStatusBtp).where({ id: id });
        
        if (!job) return { status: "FAILED", message: "Job not found" };

        return {
            id: job.id,
            status: job.status, // "RUNNING" or "DONE" or "FAILED"
            fileName: job.fileName,
            documentType: job.documentType,
            created: job.createdAt ? (typeof job.createdAt.toISOString === 'function' ? job.createdAt.toISOString() : new Date(job.createdAt).toISOString()) : null,
            finished: job.modifiedAt ? (typeof job.modifiedAt.toISOString === 'function' ? job.modifiedAt.toISOString() : new Date(job.modifiedAt).toISOString()) : null
        };
    },

    // Implement getFileByJobId
    async getFileByJobId(req, entities) {
        const { DocumentStatusBtp } = entities;
        const { id } = req.data;

        if (!id) return { error: "Missing ID" };

        const job = await SELECT.one.from(DocumentStatusBtp)
            .columns('id', 'fileName', 'documentType', 'pdfContent', 'content')
            .where({ id: id });
        if (!job) return { error: "Job not found" };

        if (job.pdfContent) {
            return {
                fileName: job.fileName,
                base64: job.pdfContent
            };
        }

        const bIsXml = job.documentType === 'XML';
        if (!bIsXml && job.content) {
            return {
                fileName: job.fileName,
                base64: job.content
            };
        }

        return { error: "No PDF content available" };
    }
};

module.exports = DbHandler;
