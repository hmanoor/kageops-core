/**
 * Document Upload Panel (E1)
 *
 * Plain TypeScript DOM panel — no framework.
 * Allows users to upload and delete project documents.
 */

interface ProjectDocument {
    readonly id: string;
    readonly file_name: string;
    readonly file_path: string;
    readonly file_size: number;
    readonly mime_type: string;
    readonly created_at: string;
}

interface UploadResult {
    readonly success: boolean;
    readonly error?: string;
    readonly id?: string;
}

interface DeleteResult {
    readonly success: boolean;
    readonly error?: string;
}

export interface DocumentUploadCallbacks {
    getProjectDocuments(projectId: string): Promise<readonly ProjectDocument[]>;
    uploadDocument(
        projectId: string,
        fileName: string,
        fileData: string,
        mimeType: string
    ): Promise<UploadResult>;
    deleteDocument(id: string, projectId: string): Promise<DeleteResult>;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(isoString: string): string {
    try {
        return new Date(isoString).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        });
    } catch {
        return '—';
    }
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function renderDocumentUploadPanel(
    container: HTMLElement,
    projectId: string,
    projectName: string,
    callbacks: DocumentUploadCallbacks
): void {
    // Clear and render skeleton
    container.innerHTML = `
        <div class="doc-upload-panel">
            <div class="doc-upload-header">
                <span class="doc-upload-title">&#128206; Documents &mdash; ${escapeHtml(projectName)}</span>
                <button class="doc-upload-close" id="doc-panel-close" title="Close">&#215;</button>
            </div>
            <div class="doc-list" id="doc-list-body">
                <div class="empty-state">Loading documents&hellip;</div>
            </div>
            <div class="doc-upload-zone">
                <input type="file" id="doc-file-input" accept=".pdf,.md,.txt,.docx,.csv,.json">
                <button class="doc-upload-btn" id="doc-upload-btn">Upload</button>
                <span id="doc-upload-msg" class="doc-upload-error" style="display:none"></span>
            </div>
        </div>
    `;

    const listBody = container.querySelector<HTMLElement>('#doc-list-body');
    const fileInput = container.querySelector<HTMLInputElement>('#doc-file-input');
    const uploadBtn = container.querySelector<HTMLButtonElement>('#doc-upload-btn');
    const msgEl = container.querySelector<HTMLElement>('#doc-upload-msg');
    const closeBtn = container.querySelector<HTMLButtonElement>('#doc-panel-close');

    if (listBody === null || fileInput === null || uploadBtn === null || msgEl === null || closeBtn === null) return;

    // Close button hides the section
    closeBtn.addEventListener('click', () => {
        const section = document.getElementById('document-upload-section');
        if (section !== null) section.style.display = 'none';
    });

    function showMsg(text: string, isError: boolean): void {
        if (msgEl === null) return;
        msgEl.textContent = text;
        msgEl.className = isError ? 'doc-upload-error' : 'doc-upload-success';
        msgEl.style.display = 'block';
    }

    function hideMsg(): void {
        if (msgEl === null) return;
        msgEl.style.display = 'none';
    }

    function renderList(docs: readonly ProjectDocument[]): void {
        if (listBody === null) return;

        if (docs.length === 0) {
            listBody.innerHTML = '<div class="empty-state">No documents uploaded yet</div>';
            return;
        }

        listBody.innerHTML = docs.map((doc) => `
            <div class="doc-row" data-doc-id="${escapeHtml(doc.id)}">
                <span class="doc-icon">&#128196;</span>
                <div class="doc-info">
                    <div class="doc-name" title="${escapeHtml(doc.file_path)}">${escapeHtml(doc.file_name)}</div>
                    <div class="doc-meta">${formatBytes(doc.file_size)} &middot; ${formatDate(doc.created_at)}</div>
                </div>
                <button class="doc-delete" data-doc-id="${escapeHtml(doc.id)}" title="Delete document">&#215;</button>
            </div>
        `).join('');

        listBody.querySelectorAll<HTMLButtonElement>('.doc-delete').forEach((btn) => {
            btn.addEventListener('click', () => {
                const docId = btn.dataset['docId'];
                if (docId === undefined || docId === '') return;
                void handleDelete(docId);
            });
        });
    }

    async function loadDocs(): Promise<void> {
        try {
            const docs = await callbacks.getProjectDocuments(projectId);
            renderList(docs);
        } catch {
            if (listBody !== null) {
                listBody.innerHTML = '<div class="empty-state">Failed to load documents</div>';
            }
        }
    }

    async function handleDelete(docId: string): Promise<void> {
        hideMsg();
        const result = await callbacks.deleteDocument(docId, projectId);
        if (result.success) {
            await loadDocs();
        } else {
            showMsg(result.error ?? 'Delete failed', true);
        }
    }

    uploadBtn.addEventListener('click', () => {
        const file = fileInput.files?.[0];
        if (file === undefined) {
            showMsg('Select a file first', true);
            return;
        }

        hideMsg();
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading…';

        const reader = new FileReader();

        reader.onload = (): void => {
            const dataUrl = reader.result;
            if (typeof dataUrl !== 'string') {
                showMsg('Failed to read file', true);
                uploadBtn.disabled = false;
                uploadBtn.textContent = 'Upload';
                return;
            }

            // Strip data URL prefix to get raw base64
            const base64 = dataUrl.split(',')[1] ?? '';

            void (async (): Promise<void> => {
                try {
                    const result = await callbacks.uploadDocument(
                        projectId,
                        file.name,
                        base64,
                        file.type !== '' ? file.type : 'application/octet-stream'
                    );

                    if (result.success) {
                        showMsg('Uploaded successfully', false);
                        fileInput.value = '';
                        await loadDocs();
                    } else {
                        showMsg(result.error ?? 'Upload failed', true);
                    }
                } catch (err) {
                    showMsg(err instanceof Error ? err.message : 'Upload failed', true);
                } finally {
                    uploadBtn.disabled = false;
                    uploadBtn.textContent = 'Upload';
                }
            })();
        };

        reader.onerror = (): void => {
            showMsg('Failed to read file', true);
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Upload';
        };

        reader.readAsDataURL(file);
    });

    void loadDocs();
}
