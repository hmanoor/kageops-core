/**
 * P1-10 — KageOps Project-Type Bundles
 *
 * On-disk, declarative packages that describe how KageOps builds a
 * particular kind of thing (vanilla-html, nextjs-saas, fastapi, …).
 *
 * IMPORTANT: this is NOT the same concept as `src/skills/`. That
 * directory is the OpenSpace agent-learning DB (markdown + embeddings,
 * runtime-captured patterns). Bundles live on disk, get loaded at
 * process boot, and shape project scaffolding. The two systems share
 * nothing.
 */

// ── Discriminator for top-level bundle category ──

export type BundleKind = 'stack' | 'capability' | 'deployer';

// ── Sub-shapes referenced by BundleManifest ──

/**
 * Match rules used by Scout (P1-12) to pick a bundle from operator
 * intent. All fields optional; bundles with no match block can be
 * selected manually but never auto-picked.
 */
export interface BundleMatch {
    /** Substrings that, if present in the project description, vote for this bundle. */
    readonly phrases?: readonly string[];
    /** Coarse tags (e.g. ['html','static','single-page']). */
    readonly tags?: readonly string[];
    /** Substrings that disqualify this bundle if present (e.g. 'react' rejects vanilla-html). */
    readonly rejectPhrases?: readonly string[];
}

/**
 * Scaffold files copied verbatim into a new project workspace.
 * Paths are relative to the bundle directory.
 */
export interface BundleScaffold {
    readonly files: readonly string[];
}

/**
 * Named prompt fragments injected into specialist prompts.
 * Keys are conventional (forge_create_ui, forge_revision,
 * blueprint_system_design, …). Values are paths relative to the
 * bundle directory.
 */
export type BundlePrompts = Readonly<Record<string, string>>;

/**
 * Build/acceptance behaviour overrides. Read by the build-verification
 * gate + build summary + acceptance gate when this bundle is active.
 */
export interface BundleBuild {
    /** Skip `npm install` / `npm run build` (true for static-HTML stacks). */
    readonly skip_npm?: boolean;
    /** How to derive required HTML IDs for the acceptance gate. */
    readonly acceptance_required_ids?: 'extract_from_description' | 'none';
    /** Label shown on the build-summary report (e.g. "Static HTML"). */
    readonly framework_label?: string;
}

/**
 * Pointer to a bundle-specific Vigil module. Path is relative to the
 * bundle directory. Loader does NOT resolve/require this — it just
 * captures the string so a later PR can wire dispatch.
 */
export interface BundleChecks {
    readonly vigil_module?: string;
}

/**
 * Bundle-specific AcceptanceGate dispatch (P2-05 / D-14..D-16).
 *
 * `kind` picks which acceptance flavour runs for this bundle:
 *   - 'html-ids' — the original HTML-ID-extraction gate. Used by
 *     vanilla-html and any other static-page bundle.
 *   - 'build-tests-preview' — the Pillar 2.1 three-signal gate:
 *     build verifier passed + test suite passed + preview URL responds
 *     200 on `/` plus every URL extracted from project.description.
 *
 * Optional fields:
 *   - `preview_routes` — additional paths beyond `/` that must respond
 *     200 (e.g. `["/api/health", "/sign-in"]`). Bundle-author opts in.
 *   - `required_test_pass_rate` — fraction in [0..1]. Defaults to 1.0
 *     (every test must pass). Lower values let a bundle tolerate
 *     known-flaky suites; should be rare.
 *
 * Bundles that omit the block fall back to 'html-ids' for backwards
 * compatibility with vanilla-html + anything that pre-dates the v2 gate.
 */
export type BundleAcceptanceKind = 'html-ids' | 'build-tests-preview';

export interface BundleAcceptance {
    readonly kind: BundleAcceptanceKind;
    readonly preview_routes?: readonly string[];
    readonly required_test_pass_rate?: number;
}

/**
 * P2.2-01 — Bundle deployment declaration (D-C).
 *
 * Lets a bundle author declare what env vars an operator must provide
 * (per project) and which vendor signup/dashboard/docs URLs the modal
 * should surface as `[Get →]` / `[Docs ↗]` deep links (D-L).
 *
 * Provider is a literal `'vercel'` in PR-A — widens to a union once a
 * second deployer bundle lands (per Pillar 2.2 D-H scope decision).
 *
 * Field names use snake_case to match the rest of bundle.yaml.
 */
export type BundleDeploymentProvider = 'vercel';

/**
 * Bundle-level vendor links (D-M setup checklist sources its
 * "Create an account" step deep links from here).
 *
 * All URL fields validated as `https://…` at load time.
 */
export interface BundleDeploymentProviderHelp {
    readonly signup_url?: string;
    readonly token_url?: string;
    readonly docs_url?: string;
    /** Free-text scope hint, e.g. "Full Account (read+write)". Surfaced inline. */
    readonly token_scope?: string;
}

/**
 * Per-env-var declaration (D-C Option A). Modal renders one input
 * row per entry, with the vendor `[Get →]`/`[Docs ↗]` deep links per D-L.
 *
 * - `secret: true` → reveal toggle + hidden by default.
 * - `format_regex` → live regex validation on the input (compile-checked at load).
 * - `signup_url`/`dashboard_url` → `[Get →]` opens dashboard if operator has account, else signup.
 */
export interface BundleDeploymentEnvVar {
    readonly key: string;
    readonly label: string;
    readonly help?: string;
    readonly secret?: boolean;
    readonly signup_url?: string;
    readonly dashboard_url?: string;
    readonly docs_url?: string;
    readonly format_hint?: string;
    readonly format_regex?: string;
}

export interface BundleDeployment {
    readonly provider: BundleDeploymentProvider;
    readonly provider_help?: BundleDeploymentProviderHelp;
    readonly required_env?: readonly BundleDeploymentEnvVar[];
    readonly optional_env?: readonly BundleDeploymentEnvVar[];
}

// ── Canonical manifest as it lives in bundle.yaml ──

/**
 * The shape parsed out of `bundle.yaml` and validated by the loader.
 * Field names use snake_case to match YAML conventions used elsewhere
 * in the codebase (electron-builder.yml, app-update.yml, …).
 */
export interface BundleManifest {
    /** Always 1 in this iteration. Reserved for schema migration. */
    readonly schemaVersion: 1;
    /** Bundle's machine-name. Must be unique within its kind. */
    readonly name: string;
    /** Top-level category — controls which directory it lives in. */
    readonly kind: BundleKind;
    /** Bundle's own semver. */
    readonly version: string;
    /**
     * Semver range the bundle is compatible with (e.g. ">=0.2.0 <0.3.0").
     * Validated at load time in P1-13. Optional here; bundles without
     * a constraint are treated as permissive.
     */
    readonly kageops_version?: string;
    readonly description: string;
    readonly match?: BundleMatch;
    readonly scaffold?: BundleScaffold;
    readonly prompts?: BundlePrompts;
    readonly build?: BundleBuild;
    readonly checks?: BundleChecks;
    readonly acceptance?: BundleAcceptance;
    /**
     * P2.2-01 — Optional deployment declaration (D-C). When present,
     * the New-Project modal renders a Deployment Configuration section
     * shaped by this block. Static-only bundles (e.g. vanilla-html)
     * omit it; the modal hides the section entirely.
     */
    readonly deployment?: BundleDeployment;
    /**
     * BPF-30 — features this scaffold already ships fully wired. The task
     * decomposer drops development tasks that merely RE-IMPLEMENT these (a weak
     * model rebuilds them as broken duplicates — redundant checkout routes,
     * clobbered webhooks, broken auth pages). Customisation tasks (landing copy,
     * domain tables, net-new pages) are kept. snake_case to match YAML.
     */
    readonly shipped_features?: readonly BundleShippedFeature[];
    /**
     * BPF-31 — well-formed PLACEHOLDER values used ONLY to let credential-free
     * build verification (`next build`) complete. Some frameworks need a
     * syntactically-valid public key even to PRERENDER static pages (e.g. Clerk's
     * `<ClerkProvider>` throws "Missing publishableKey" during static export).
     * These fill ONLY keys the operator hasn't supplied via deployment_config —
     * real values always win — so a run-locally build proves the app compiles +
     * prerenders without requiring the operator's secrets. NEVER used for a real
     * deploy. snake_case to match YAML.
     */
    readonly build_env_placeholders?: Readonly<Record<string, string>>;
}

/**
 * A capability the scaffold ships ready-to-use. `phrases` are lower-cased
 * substrings matched against a task's title+description; a match means the task
 * is re-building shipped infra and is dropped before dispatch.
 */
export interface BundleShippedFeature {
    readonly label: string;
    readonly phrases: readonly string[];
}

// ── Loaded bundle (manifest + provenance) ──

/**
 * What the loader returns. Carries the parsed manifest plus the
 * absolute directory it was loaded from, so downstream consumers
 * (Forge dispatch in P1-11, Vigil in P1-13) can resolve relative
 * paths inside the bundle.
 */
export interface LoadedBundle {
    readonly manifest: BundleManifest;
    /** Absolute path to the bundle's root directory. */
    readonly directory: string;
}

// ── Errors surfaced by the loader ──

/**
 * Structured error captured per-bundle when validation fails. The
 * loader returns these alongside the successfully-loaded bundles so
 * callers can decide whether to fail-fast or log-and-continue.
 */
export interface BundleLoadError {
    readonly directory: string;
    readonly reason: string;
}

/**
 * Aggregate result returned by `loadBundles()`.
 */
export interface BundleLoadResult {
    readonly bundles: readonly LoadedBundle[];
    readonly errors: readonly BundleLoadError[];
}
