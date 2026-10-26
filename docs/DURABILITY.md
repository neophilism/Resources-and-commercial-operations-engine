# Durable budget adapter — implementation checkpoint

The store reuses a pinned Evidence persistence SDK in a separate dedicated resource database. It does not share Evidence or intake operational databases. Scope-bound manager policy creates budgets; only registered budget operators can load or mutate them. Commands compare the actual storage revision and bind replay keys to authenticated actor, purpose-bearing payload and expected revision.

Balances, hash-chained domain entries, immutable storage revisions, audit and change-outbox records commit together. Attempted effects require a deployment-configured receipt verifier before settlement or release. A reference alone does not establish a charge/no-charge outcome. No default verifier is provided.

`consumeEffect` changes a committed reservation to uncertain in one transaction before returning a one-shot description. It has no idempotent replay path that can issue a second description. A lost response requires reconciliation. Actual external transports remain a separate trusted gateway; this store cannot stop code that independently possesses a provider credential from calling it directly.

Pending at this checkpoint: actual-migration integration tests, exact dependency/package verification, CI and live adapter acceptance. No live payment, provider call or credential provisioning occurs.
