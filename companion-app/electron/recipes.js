// Portable recipe store — chain-only, identity-free by construction.
//
// A recipe carries the deliberate processing choices: filter order, params,
// bypass (enabled) states, color management and mix. It NEVER carries
// source paths, clip bindings, node GUIDs, chat history, credentials or
// render identities — the save path strips and refuses those keys so a
// recipe can never leak node identity or private data. Applying a recipe
// binds to the destination node's OWN source/identity (detected afresh);
// recipes are independent by default (no linking — editing one node never
// touches another).
//
// Schema: { schemaVersion: 1, name, chain: Step[], colorManagement, mix,
//           manualOrder }. Versioned; unknown fields are rejected, not ignored.

const fs = require('fs');
const os = require('os');
const path = require('path');

const RECIPES_DIR = () => path.join(os.homedir(),
    'Library/Application Support/VapourSynth-OFX', 'recipes');
const CURRENT_SCHEMA = 1;
const FORBIDDEN_KEYS = ['nodeGuid', 'nodeId', 'clipMetadata', 'archivist',
    'apiKey', 'credential', 'token'];

function recipePath(name, dir) {
    // Slug: readable, filesystem-safe, no traversal.
    const slug = String(name).trim().toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    if (!slug || slug === '.' || slug.includes('..')) return null;
    return path.join(dir ?? RECIPES_DIR(), `${slug}.json`);
}

// Validate + sanitize a recipe payload. Returns { ok, recipe } or { ok:false, error }.
//
// SECURITY (2026-11-05 security review #2 + correctness review C13; extended 2026-11-11):
// recipes are the UNTRUSTED intake boundary. Fail-closed rules:
//   1. NOTHING ARRIVES APPROVED. Every admissible step type is executable
//      (script code or QTGMC-generated Python), and the approval-content
//      BINDING is never portable — both the flag and any `approvedContent`
//      in the file are stripped here. Approving content is a per-step,
//      per-node user action in the destination editor (one explicit click
//      stores the binding; see shared/draft-composer isStepApproved).
//   2. THE EXECUTABLE TYPE CONTRACT. Only chain types BOTH composers can
//      actually execute are admissible: 'script' and 'qtgmc' (the native
//      filter registry registers exactly these; schema-backed filters
//      travel as 'script' steps with a schemaType tag and generated code).
//      The first fix batch wrongly admitted the 24 filter-SCHEMA names as
//      step types — native silently dropped them and the draft crashed
//      (correctness review C13 residual). They are now rejected with an explicit error.
//   3. COLOR MANAGEMENT SHAPE. A partial colorManagement object is rejected
//      at intake (it previously replaced the destination's whole CM and
//      crashed the draft composer — correctness review C14).
// Enabled/approved are ALWAYS emitted explicitly so the native parser and
// the draft composer agree.
const KNOWN_STEP_TYPES = ['script', 'qtgmc'];
const KNOWN_STEP_VERSION = 1;
const CM_REQUIRED_FIELDS = ['inputColorSpace', 'inputGamma', 'outputColorSpace', 'outputGamma', 'ocioConfig'];

function normalizeRecipe(payload, fallbackName) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, error: 'recipe is not an object' };
    }
    for (const key of FORBIDDEN_KEYS) {
        if (key in payload) {
            return { ok: false, error: `recipe must not contain "${key}" — recipes are chain-only and portable` };
        }
    }
    if (payload.schemaVersion !== CURRENT_SCHEMA) {
        return { ok: false, error: `unsupported recipe schemaVersion ${JSON.stringify(payload.schemaVersion)} (expected ${CURRENT_SCHEMA})` };
    }
    const name = typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim() : (typeof fallbackName === 'string' && fallbackName.trim() ? fallbackName.trim() : null);
    if (!name) return { ok: false, error: 'recipe needs a name' };
    if (!Array.isArray(payload.chain)) return { ok: false, error: 'recipe chain is not an array' };
    for (const step of payload.chain) {
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
            return { ok: false, error: 'recipe chain step is not an object' };
        }
        if (typeof step.type !== 'string' || !step.type) return { ok: false, error: 'recipe chain step missing type' };
        if (!KNOWN_STEP_TYPES.includes(step.type)) {
            return { ok: false, error: `recipe chain step has unknown type "${step.type}" (not in the filter catalog)` };
        }
        if (step.version !== undefined && step.version !== KNOWN_STEP_VERSION) {
            return { ok: false, error: `recipe chain step has unsupported version ${JSON.stringify(step.version)}` };
        }
        if (typeof step.id !== 'string' || !step.id) return { ok: false, error: 'recipe chain step missing id' };
        if (!Number.isInteger(step.stage)) return { ok: false, error: 'recipe chain step stage is not an integer' };
        if (step.enabled !== undefined && typeof step.enabled !== 'boolean') {
            return { ok: false, error: 'recipe chain step enabled is not a boolean' };
        }
        if (step.approved !== undefined && typeof step.approved !== 'boolean') {
            return { ok: false, error: 'recipe chain step approved is not a boolean' };
        }
        if (step.approvedContent !== undefined && step.approvedContent !== null
            && typeof step.approvedContent !== 'string') {
            return { ok: false, error: 'recipe chain step approvedContent is not text' };
        }
        if (step.params !== undefined && (typeof step.params !== 'object' || Array.isArray(step.params))) {
            return { ok: false, error: 'recipe chain step params is not an object' };
        }
    }
    const chain = payload.chain.map(step => {
        return {
            id: step.id,
            type: step.type,
            stage: step.stage,
            enabled: step.enabled !== undefined ? step.enabled : true,
            // Fail-closed (security re-review, 2026-11-05, extended
            // 2026-11-11): EVERY admissible step type is executable — script
            // code or QTGMC-generated Python — so nothing survives intake
            // approved. An imported recipe must be re-approved in the
            // destination editor. The approval-content BINDING is never
            // portable either: it is stripped here no matter what the file
            // carries; only an explicit Approve click sets it.
            approved: false,
            approvedContent: null,
            version: step.version !== undefined ? step.version : KNOWN_STEP_VERSION,
            params: step.params !== undefined ? step.params : {},
        };
    });
    // CM shape: reject partial objects at intake (correctness review C14) — an accepted
    // CM replaces the destination's whole color management, so it must be
    // complete or absent.
    // C15 (2026-11-11): an EXPLICIT null is treated as ABSENT. `typeof null
    // === 'object'` previously passed the shape check, and the required-field
    // loop then threw a TypeError that escaped the save handler (normalize
    // runs before saveRecipe's try block). Null and omitted both mean
    // "no color management" — same as the pre-C14 normalize behavior.
    let colorManagement;
    if (payload.colorManagement !== undefined && payload.colorManagement !== null) {
        if (typeof payload.colorManagement !== 'object' || Array.isArray(payload.colorManagement)) {
            return { ok: false, error: 'recipe colorManagement is not an object' };
        }
        for (const field of CM_REQUIRED_FIELDS) {
            if (typeof payload.colorManagement[field] !== 'string') {
                return { ok: false, error: `recipe colorManagement is partial — "${field}" is missing (a partial object would replace the destination's whole color setup)` };
            }
        }
        colorManagement = payload.colorManagement;
    }
    const recipe = {
        schemaVersion: CURRENT_SCHEMA,
        name,
        chain,
        colorManagement,
        mix: typeof payload.mix === 'number' && Number.isFinite(payload.mix) ? payload.mix : 1.0,
        manualOrder: typeof payload.manualOrder === 'boolean' ? payload.manualOrder : false,
    };
    return { ok: true, recipe };
}

function listRecipes(dir) {
    const recipesDir = dir ?? RECIPES_DIR();
    try {
        const names = fs.readdirSync(recipesDir)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
        const recipes = [];
        for (const n of names) {
            try {
                const raw = JSON.parse(fs.readFileSync(path.join(recipesDir, `${n}.json`), 'utf8'));
                recipes.push({ name: raw.name ?? n, slug: n, stepCount: Array.isArray(raw.chain) ? raw.chain.length : 0 });
            } catch { /* unreadable entry: listed as-is is worse than skipping */ }
        }
        return { ok: true, recipes };
    } catch {
        return { ok: true, recipes: [] };   // no dir yet = empty list
    }
}

function saveRecipe(payload, fallbackName, dir) {
    // C15 defense in depth (2026-11-11): normalization is pure validation
    // and must never let an exception escape this handler — anything thrown
    // becomes a normal {ok:false} rejection.
    let normalized;
    try {
        normalized = normalizeRecipe(payload, fallbackName);
    } catch (e) {
        return { ok: false, error: `recipe validation failed: ${e.message}` };
    }
    if (!normalized.ok) return normalized;
    const recipesDir = dir ?? RECIPES_DIR();
    const file = recipePath(normalized.recipe.name, dir);
    if (!file) return { ok: false, error: 'recipe name is not usable as a filename' };
    try {
        fs.mkdirSync(recipesDir, { recursive: true });
        const serialized = JSON.stringify(normalized.recipe, null, 2);
        fs.writeFileSync(file, serialized, 'utf8');
        return { ok: true, path: file, recipe: normalized.recipe };
    } catch (e) {
        return { ok: false, error: `recipe save failed: ${e.message}` };
    }
}

function loadRecipe(slug, dir) {
    try {
        const file = recipePath(slug, dir) ?? path.join(dir ?? RECIPES_DIR(), `${path.basename(String(slug))}.json`);
        if (!fs.existsSync(file)) return { ok: false, error: 'recipe not found' };
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const normalized = normalizeRecipe(raw, slug);
        if (!normalized.ok) return normalized;
        return { ok: true, recipe: normalized.recipe };
    } catch (e) {
        return { ok: false, error: `recipe load failed: ${e.message}` };
    }
}

function deleteRecipe(slug, dir) {
    try {
        const file = recipePath(slug, dir);
        if (!file || !fs.existsSync(file)) return { ok: false, error: 'recipe not found' };
        fs.unlinkSync(file);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: `recipe delete failed: ${e.message}` };
    }
}

function registerRecipeHandlers(ipcMain, options) {
    // Optional explicit recipes dir (tests use isolated fixtures so the
    // user's real library is NEVER touched). Captured at registration time —
    // handlers stay permanently bound to it. Production passes no option.
    const dir = options?.recipesDir ?? null;
    ipcMain.handle('recipes:list', () => listRecipes(dir));
    ipcMain.handle('recipes:save', (_e, request) => saveRecipe(request?.payload, request?.fallbackName, dir));
    ipcMain.handle('recipes:load', (_e, request) => loadRecipe(request?.slug, dir));
    ipcMain.handle('recipes:delete', (_e, request) => deleteRecipe(request?.slug, dir));
    // Import reads a file the user chose (via dialog on the renderer side).
    ipcMain.handle('app:open-text-file', async (_event, request) => {
        try {
            const { dialog, BrowserWindow } = require('electron');
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) return { ok: false, error: 'no window' };
            const result = await dialog.showOpenDialog(win, {
                filters: [{ name: 'Recipe JSON', extensions: ['json'] }],
                properties: ['openFile'],
            });
            if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
            const contents = fs.readFileSync(result.filePaths[0], 'utf8');
            return { ok: true, contents, path: result.filePaths[0] };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });
}

module.exports = { registerRecipeHandlers, normalizeRecipe };