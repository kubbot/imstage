# IMStage Contacts service

Account-scoped, persistent contact library for the studio. It owns the
`contact_libraries` headline row and its `contacts` children and is wired into
`services/api/server.mjs`. The parent/frontend owns incremental client merge and
default application; this service only stores and validates what it is given.

No new dependency: avatars are verified with the `sharp` copy already used by the
Agent service, and persistence uses the existing `node:sqlite` connection.

## Endpoint

Both routes require a valid session and are always filtered by the authenticated
owner. Another account's library is indistinguishable from a missing one.
`PUT` is a full replacement and additionally requires the normal mutation guard
(exact `Origin` + `X-IMStage-Request: 1`) and `Content-Type: application/json`.
`X-IMStage-User`, when present, must match the session (identity pinning).

### `GET /api/contact-library`

`200` with the stored library, or the empty default for an account that has
never saved one:

```json
{
  "revision": 0,
  "contacts": [],
  "selfContactId": null,
  "autoSave": true
}
```

`contacts` items are `{ id, name, subtitle, avatar }` in saved order;
`avatar` is `null` when absent.

### `PUT /api/contact-library`

Request body is the full replacement:

```jsonc
{
  "revision": 0,
  "contacts": [
    {
      "id": "3f0c2b1e-...-uuid",
      "name": "小林",              // trimmed, 1..100 chars
      "subtitle": "同事",          // optional, <= 200 chars
      "avatar": "data:image/png;base64,..."  // optional local image
    }
  ],
  "selfContactId": "3f0c2b1e-...-uuid", // UUID in `contacts`, or null
  "autoSave": true
}
```

Returns the same shape with `revision` incremented (`revision: 0` creates the
library and stores revision `1`). Unknown top-level or per-contact fields are
rejected with `400 unknown_field`.

Revision semantics (optimistic concurrency):

- `PUT` succeeds only when `revision` equals the stored revision, then stores
  `revision + 1`. A stale or future revision returns `409 revision_conflict`
  and never mutates committed state.
- The whole replacement (headline row + contacts) runs in one
  `BEGIN IMMEDIATE` transaction.

Validation:

- `id`: UUID; ids are compared case-insensitively and must be unique
  (`400 duplicate_contact_id`).
- At most `100` contacts (`400 too_many_contacts`).
- `selfContactId`, when non-null, must be one of the submitted contact ids;
  deleting the referenced contact while keeping the reference is
  `400 invalid_self_contact`.
- `autoSave` must be a boolean.
- `avatar`, when present, must be a local
  `data:image/(png|jpeg|webp);base64,...` string. Remote URLs, SVG and other
  MIME types are rejected without any provider/network call. New images are
  actually decoded with `sharp` (forged headers fail); exact avatar strings
  already validated in this account’s database skip repeated decoding. Every
  image must stay within
  `4,000,000` pixels and `2 MiB` of encoded string, and the decoded bytes of
  all avatars together must stay within `8 MiB`.

Resource bounds:

- Request body: `12 MiB` (`413 payload_too_large` beyond that; the socket is
  drained so the error stays readable).
- A `30 s` body-read deadline, plus the server-wide request timeouts.
- Contact metadata and avatar bytes are never logged; error messages are
  generic and never echo request data.

## Persistence

`CONTACT_SCHEMA_SQL` is applied additively during `openDatabase()` in
`services/api/server.mjs`, so existing databases gain the tables without a
reset. Both tables cascade on `users(id)`.

```sql
contact_libraries(user_id PK, revision, self_contact_id, auto_save, updated_at)
contacts(user_id, id, name, subtitle, avatar, sort_order, PK(user_id, id))
```

## Tests

```bash
node --test tests/contacts.test.mjs
```

Covers the empty default, revision create/increment/conflict, account
isolation, auth/CSRF/identity pinning, default-contact invariants, structural
bounds, avatar decoding (remote/SVG/forged/oversize/pixel/total-byte), server
restart and raw database reopen, and log hygiene. Fixtures are generated
locally with `sharp`.
