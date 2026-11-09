# CodeTogether Implementation Plan

## Phase 0 — Foundation
- [x] Create monorepo structure
- [x] Add frontend and backend package scripts
- [x] Add initial Prisma data model
- [x] Add environment templates and setup documentation

## Phase 1 — Frontend foundation
- [x] Landing page
- [x] Dashboard/workspace starter
- [x] Monaco editor integration
- [x] Responsive dark developer UI
- [ ] Add route-level pages and polished empty/loading/error states
- [ ] Add component and browser tests

## Phase 2 — Backend and database
- [x] Express server and health endpoint
- [x] Prisma schema
- [x] Project list/create/read/update/delete starter endpoints
- [x] Socket.IO room/presence starter
- [x] Run Prisma migration against a configured MySQL instance
- [x] Add request validation, integration tests, and centralized error handling

## Phase 3 — Authentication and authorization
- [x] Registration and login
- [x] Secure server-managed sessions and cookie configuration
- [x] Password hashing
- [x] Project membership and role checks
- [x] Rate limiting and CSRF protection as appropriate
- [x] Owner, Admin, Editor and Viewer role hierarchy enforced by the backend
- [x] Project team roster and member role management
- [x] Email-bound and shareable-link invitations with hashed, expiring, revocable, single-use tokens
- [x] Frontend team and invitation management UI with Viewer read-only editor
- [x] Integration tests for roles, invitations, privilege escalation and non-member privacy

## Phase 4 — Editor and persistence
- [x] Persist files through API
- [x] Store file content in MySQL `LONGTEXT` with a 1,000,000-byte API limit
- [x] Return metadata-only folder listings and load file content on demand
- [x] File/folder tree operations
- [x] Create, rename, move and delete files and folders with server-derived paths
- [x] Folder rename/move path rewrites in a transaction, with cycle and conflict rejection
- [x] Multiple editor tabs with per-file drafts and loading/error states
- [x] Save state (`Saving…`, `All changes saved`, failed/conflict) and autosave with per-file serialisation
- [x] Optimistic concurrency using the loaded revision; conflicts require an explicit reload
- [x] Dirty tracking, close-tab/unload prompts and role-aware read-only editing
- [x] Explorer search and quick-open palette (`Ctrl/Cmd+P`)
- [x] Keyboard shortcuts for save, explorer toggle, search focus and tab close
- [x] Restore open tab IDs and the active tab after reload; content always reloads from MySQL
- [x] Handle missing files, concurrent deletes, invalid paths and network failures with recovery actions
- [x] Integration tests for metadata listings, moves, cycles, conflicts, large files and search
- [ ] Persist unsaved drafts locally across refreshes (currently warned before unload)
- [ ] Drag-and-drop moves (the current UI uses a destination-folder dialog)
- [ ] Real-time collaborative editing (deferred to Phase 5)

## Phase 5 — Real-time collaboration
- [x] Integrate Yjs document provider over authenticated Socket.IO (no y-websocket protocol assumption)
- [x] Persist Yjs snapshots and text content transactionally in MySQL
- [x] Remote cursors, selections and presence
- [x] Reconnect, duplicate-update and concurrent-edit handling
- [x] Authenticate sockets and authorize project/file room joins
- [x] Revalidate membership/role for collaboration writes and saves
- [x] Block conflicting REST content writes while a file room is live
- [x] Explicit leave flushes/releases rooms; dropped sockets use delayed cleanup
- [x] Integration tests for sync, persistence/restart, reconnect, viewer and non-member rejection

## Phase 6 — Team collaboration
- [x] Invitations and revocation
- [x] Persistent room chat
- [x] Owner/admin/editor/viewer permissions
- [ ] Activity feed

## Phase 7 — Secure execution
- [ ] Separate isolated execution service
- [ ] CPU, memory, time, output, and network restrictions
- [ ] Execution status and output UI
- [ ] Security tests

## Phase 8 — Hardening and deployment
- [ ] Unit, API, socket, and browser tests
- [ ] Production configuration and migrations
- [ ] Logging, health/readiness checks, backups
- [ ] Deploy frontend, backend, and database
- [ ] Verify production WebSocket connectivity
