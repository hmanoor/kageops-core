// Ambient module shim so classic TS moduleResolution can resolve
// the `@electric-sql/pglite/vector` subpath export.
declare module '@electric-sql/pglite/vector' {
    export const vector: {
        readonly name: string;
        readonly setup: (pg: unknown, emscriptenOpts: unknown) => Promise<{
            emscriptenOpts: unknown;
            bundlePath: URL;
        }>;
    };
}
