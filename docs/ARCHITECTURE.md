# Resource operations boundary

A budget uses explicit integer units: minor currency units, provider credits, tokens or another deployment-defined measure. Different units are never silently converted. Reserving capacity reduces available funds before an operation is attempted. Effects move through held, committed, uncertain, settled or released states. Idempotent reservation keys reject changed terms and duplicate effect keys.

Unattempted reservations may expire. Committed/uncertain effects keep their reservation until a receipt or proof of no charge resolves them. Unexpected real charges require explicit human-owner reconciliation; over-limit accounting is preserved and prevents new reservations. Each transition returns a new serializable state and a hash-chained cost event. Allocation records must balance exactly.

The library uses an explicit authenticated operator allowlist and scope/purpose checks. A durable adapter must serialize concurrent transitions and store the returned state and effects transactionally. The current package does not create bank transactions, invoices, payment gateways or a commercial product catalogue. The scoped durable budget adapter is documented in [DURABILITY.md](DURABILITY.md); its database and receipt ports require deployment configuration. Permission/license decisions remain a separate engine. Source references do not by themselves authenticate external receipts.

Command replays check current stored budget membership, exact reservation principal/purpose and any required owner role before returning cached historical acknowledgements. The original command fingerprint is retained; cached data is not an execution permit or fresh provider attestation. Trusted host identity context remains required.
