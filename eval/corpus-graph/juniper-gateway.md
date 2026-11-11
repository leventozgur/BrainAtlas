# Juniper gateway
The juniper gateway forwards requests to the upstream pool and reports a timeout to the caller when the pool stalls. Retry behaviour is governed by [[upstream-retry-budget]].
