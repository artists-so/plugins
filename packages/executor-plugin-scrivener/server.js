// The executor binary resolves "<package>/server" with a createRequire whose
// resolver does not read `exports` maps — verified against executor 1.5.40
// (2026-08-08): both the conditional and the plain-string "./server" entries
// fail with MODULE_NOT_FOUND, and this literal file is what resolves. The
// package's `exports` still points tooling at the same code; only this shim is
// for the executor's loader. Everything real lives in dist/.
export { default, scrivenerPlugin } from './dist/server.js';
