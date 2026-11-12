# Node chain continuity — saved records, verification, restore

**What it is.** Every node you accept a configuration on has its chain
persisted by the OFX plugin to a per-node record under
`~/Library/Application Support/VapourSynth-OFX/nodes/<node-guid>.json`
(the live copy lives in the Resolve project's OFX parameters; the record is
the durable copy, written on every accept). The companion reads these records
so a node's chain survives the loss of its live copy.

## When the companion restores a saved chain

**Automatic (editor boot, host-manual sessions).** When Configure opens a node
whose incoming chain is **empty**, the companion checks the node's record:

- record's clip binding **matches** (content hash, or the file path) → the
  chain is restored, verified bindings included (it is the node's own prior
  accepted state — the same trust class as the host's config input),
- clip binding **unknown** on either side (legacy records) → restored, but
  every approval is stripped — nothing arrives pre-approved through intake,
- clip binding **differs** → NOT restored; the editor shows a note instead
  (a copied or mis-filed record must not shadow the real node),
- the incoming chain is **non-empty** → the live configuration wins; records
  are only a fallback.

**Explicit.** `node-records:load` (the "restore saved chain" path) can fetch a
record deliberately — including across clips — but cross-clip loads always
strip approvals.

## Verification (fail-closed)

Every record read is validated before use: GUID filename rule
(`[A-Za-z0-9-]{1,64}` — the same rule the native side writes under), record
size cap (8 MiB — the host's own exchange limit), JSON parse, the full
configuration schema, **record identity must match its filename** (a misfiled
record is refused), and approval consistency: a step claiming `approved` must
carry its content binding, and orphaned bindings are cleared. Inconsistent
steps are stripped with a note — never repaired into "approved".

## Guarantees

- The companion module is **read-only**; the native plugin is the single
  writer of records.
- Restore never executes anything: restored steps still need approval where
  stripping applied, and composition/approval rules are unchanged.
- Nothing here weakens the approval model: approval remains content-bound and
  per-node; the record path only decides which chain TEXT reappears, not what
  is allowed to run.
