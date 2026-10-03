// Executor's compiled binary resolves "<package>/server" as a literal file.
// Keep this root shim even though package exports point at the same bundle.
export { davinciPlugin, default } from './dist/server.js';
