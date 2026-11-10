---
title: Queue lock errors
status: active
generated: "2026-07-02"
---
# Queue lock errors

## E_QUEUE_LOCKED
E_QUEUE_LOCKED is returned when a Larkspur queue partition is currently held by another consumer. The lock is advisory and expires after the heartbeat interval that each consumer publishes. A consumer that receives this error should back off with a small random delay and try again. It must not delete the lock record by hand, because doing so can cause two consumers to process the same message.

## Diagnosis
Check the heartbeat timestamps of the partition. A lock whose heartbeat is older than the interval is stale, and the broker removes it on the next scan. If the lock stays in place for several scans, the consumer process is probably stuck and should be restarted through the normal drain procedure.

## Related pages
The ordering rules that make the lock necessary are described in [[decisions/adr-009-queue-ordering]]. Retry budgets for messages that were not delivered are listed in [[architecture/larkspur-queue]].

## Client usage
Producers and consumers that use the client should read [[api/larkspur-client]] for the flush and acknowledgement rules before changing their retry logic.
