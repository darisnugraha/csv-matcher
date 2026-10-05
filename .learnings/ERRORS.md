# Errors

## [ERR-20261005-001] worker-fixture-self-shim

**Logged**: 2026-10-05
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The first Node-based CSV worker fixture failed before running because Papa Parse expects a global `self` when loaded in the Node harness.

### Error
`ReferenceError: self is not defined` while requiring `papaparse`.

### Context
- Loaded the bundled worker in a Node VM to verify the CSV export subset.
- The harness imported Papa Parse before installing the browser-style `self` shim.

### Suggested Fix
Install `global.self` before requiring browser-oriented dependencies in the harness.

### Resolution
- **Resolved**: 2026-10-05
- **Notes**: Added the shim before requiring Papa Parse; CSV subset verification passed.

### Metadata
- Reproducible: yes
- Related Files: `src/engine.ts`

## [ERR-20261005-002] xlsx-worker-vm-realm

**Logged**: 2026-10-05
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The initial XLSX worker fixture ran the bundled worker in an isolated VM realm and caused typed-array/ArrayBuffer realm mismatches.

### Error
The fixture parsed XLSX rows as binary text and reported every row unmatched.

### Context
- Passed a Node `File` into a worker bundle evaluated with `vm.runInNewContext`.
- The XLSX reader received an `ArrayBuffer` from a different JavaScript realm.

### Suggested Fix
Evaluate the worker bundle in the same Node realm as the `File` and `ArrayBuffer` objects.

### Resolution
- **Resolved**: 2026-10-05
- **Notes**: Switched the harness to `vm.runInThisContext`; XLSX subset verification passed.

### Metadata
- Reproducible: yes
- Related Files: `src/engine.ts`
