---
title: Widget errors
status: active
generated: "2026-08-14"
aliases: [widget failures, widget error codes]
---
# Widget errors

## E_WIDGET_TIMEOUT
The widget sync call returns E_WIDGET_TIMEOUT when the upstream service does not answer inside the configured window. The client retries twice with jittered backoff before it surfaces the error to the caller. Raising the window requires a configuration change in the widget section of the service file. Retries are not affected by that change, so a longer window also means a longer total wait for the caller.

## Handling
Record the request identifier from the caller log and check the upstream status page first. If the same error repeats for more than ten minutes, page the owner listed in [[ops/oncall]]. Widget batches that failed with this error are re-queued by the delivery worker described in [[architecture/larkspur-queue]].

## Known causes
Most timeouts in the last quarter came from a single large batch that exceeded the upstream limit. Splitting batches below the documented size removed the pattern. Network resets are a separate case and do not carry this code.
