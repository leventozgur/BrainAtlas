# Sync

Synchronization is optional and belongs to Full/Custom modules. Configure a transport only after reviewing where vault files will be stored and how credentials are handled. No application key is embedded in the repository.

## Available transports

- **Git:** local or remote Git transport, with pull and commit/push operations.
- **Dropbox:** object transport using revision-based conditional updates and an OS-backed credential store.
- **Folder:** experimental transport; do not rely on it for production data.

The transport-independent sync engine tracks file manifests, merges supported Wiki structures, and reports unresolved conflicts. Conflicting edits are retained for review; inspect conflict copies and resolve them deliberately. Deletes require approval: local deletions become pending rather than silently deleting remote content, and remote deletion is applied locally only when its approved tombstone matches the unchanged local base.

Keep credentials out of vault pages and configuration examples. The Dropbox transport uses the host's credential facilities where supported. Sync moves vault content to the configured destination; local secret filtering applies to supported BrainAtlas writes, but should not be treated as a substitute for reviewing what you sync.
