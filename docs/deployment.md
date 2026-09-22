# Deploying, and the one error that keeps stopping it

## "One or more integration resources failed to provision for this deployment."

This is not a build error and no commit can fix it. It happens in Vercel's
*provisioning* step, which runs before the repository is even checked out: Vercel
asks each connected integration for the resources it owes the deployment, one of
them refuses, and the deployment is marked failed having never run `next build`.
The integration doing the refusing here is Neon.

The step that fails is named in the deployment log: **`Create database branch for
deployment`**, under Provisioning Integrations. The integration is set to cut a
database branch per deployment, production included, and Neon does not give it
one. Expand that row and follow the ↗ link for Neon's own words; the plausible
reasons, none of which can be told apart from the Vercel side, are:

- the branch limit on the plan has been reached — likely if the failure began
  after a run of deployments, since branches from failed ones are not always
  cleaned up, so the cap stays reached and nothing recovers on its own
- the Neon project is suspended, or out of compute hours on the free tier
- the API credentials the integration holds have been revoked

A long duration on the step before it fails — minutes rather than seconds —
points at the first two rather than the third, which refuses immediately.

What it is *not*: the **Needs Attention** badges on the integration's variables in
Vercel. Those say a variable holds a secret but is stored as a plain Config value
readable by anyone with project access. That is worth fixing (see below), but it
is a storage-type advisory, not an error, and it has no bearing on provisioning.
"Rotate Neon Secrets" does not address this failure.

### The permanent fix: stop letting the integration own the database

The application reads exactly one database variable, `DATABASE_URL`, and nothing
Neon-specific — no `POSTGRES_*`, no `NEON_*`. So the integration is not load
bearing. Taking it out of the loop removes the provisioning step altogether, and
with it the only thing that can fail there.

Order matters. The integration *owns* the `DATABASE_URL` it set, and disconnecting
it takes that variable with it, so copy the value before you remove the thing
holding it:

1. **Neon dashboard → your project → Connection string.** Choose the **Pooled
   connection** (the host ends in `-pooler`) and copy it. Pooled, because a
   serverless deployment opens far more connections than a Postgres instance will
   accept directly.
2. **Vercel → Project → Settings → Integrations** (or Storage) → the Neon entry →
   **Disconnect**. Disconnect it from this Vercel project; do **not** delete the
   Neon project or its branches — that is the actual database.
3. **Vercel → Project → Settings → Environment Variables**, add for Production,
   Preview and Development:
   - `DATABASE_URL` = the pooled string from step 1, marked **Sensitive**

   `DATABASE_SSL` is not needed alongside it, and does nothing. Where a
   connection string carries an `sslmode`, node-postgres takes the string's word
   and discards the `ssl` option passed beside it — `sslmode=disable` with
   `ssl: { rejectUnauthorized: false }` resolves to `ssl: false`, the string
   winning. Every Neon string carries `sslmode=require`, so the `DATABASE_SSL`
   branch in `src/lib/db.ts` never decides anything in this deployment. It is
   there for a bare connection string with no `sslmode` at all, which is not what
   Neon hands out.

   `sslmode=require` is the setting you want regardless: pg 8.x reads it as
   `verify-full`, so the certificate is checked, and Neon's certificates are
   publicly signed. (pg 9 / pg-connection-string 3.0 will reinterpret `require`
   with libpq's weaker semantics, at which point the string wants
   `sslmode=verify-full` written out. Not yet, and not urgently.)
4. **Deployments → the most recent one → Redeploy**, with "Use existing build
   cache" *off*.

Vercel now has no integration to provision, the build runs, and the app connects
to the same database it was connecting to before — the data is untouched by any
of this.

It also settles the **Needs Attention** advisory, for the same reason and in the
same move. A variable an integration owns cannot be marked sensitive — the
integration sets it, as a Config value, and resets it whenever it likes. One set
by hand can be, so its value stops being readable by everyone with access to the
project. The integration was publishing eighteen variables, nine of them carrying
the database password in one encoding or another: `DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, `PGPASSWORD`, `POSTGRES_PASSWORD`, `POSTGRES_URL`,
`POSTGRES_PRISMA_URL`, `POSTGRES_URL_NO_SSL`, `POSTGRES_URL_NON_POOLING`,
`NEON_AUTH_BASE_URL`. The application reads one of them. The remaining sixteen —
Prisma, Neon Auth, a Vite variable — are for tools this project does not use, and
they leave with the integration.

Since that password has been sitting in plain view, rotate it at the source
rather than copying the old one across: **Neon → Roles → the role → Reset
password**, then take the new pooled connection string into step 1. Doing it in
this order means the string that ends up stored as a plain Config value is one
that is already retired.

### If you would rather keep the integration

Delete enough Neon branches to get back under the plan's cap — Neon dashboard →
Branches, remove every one whose name matches an old preview deployment, keeping
`main` (or whichever branch is production) — and then redeploy. This works, but it
is a fix with a shelf life: the branches accumulate again with the next batch of
previews.

## Why `vercel.json` disables deployments for the working branch

Each push to the working branch produced a preview deployment, and with
branch-per-deployment switched on, each preview asked Neon for another branch.
That is what fills the cap. The commits on that branch are pushed to `main`
unchanged in the same breath, so the previews were building the same tree twice
and spending a Neon branch to do it.

`vercel.json` therefore turns deployments off for that one branch. `main` deploys
exactly as before — the production branch is unaffected by `deploymentEnabled`,
and nothing else in the file changes the build.

To get previews back, delete the `git` block, or set the branch to `true`.

## Checking it worked

`GET /api/health` on the deployed origin answers without a session and reports:

- `build` — the commit that is actually serving, which is how you tell a
  successful deployment from a stale one still being served
- `env` — which variables are present, `DATABASE_URL` among them
- `endpoint` — the database host, masked, with `-pooler` stripped, so two
  deployments can be compared without exposing credentials
- `database` — `ok`, or the connection error in Postgres's own words
- `migrations.behind` — the migration files this database has not applied yet.
  `[]` means it is current. Anything else is applied from **Admin → Database →
  Apply**, in the app, with no SQL console involved.

## Connecting PandaDoc (e-signature)

Contracts and change orders can be sent for signature through PandaDoc. It is
off until these are done; signing by hand keeps working either way.

1. **Apply the SQL.** Admin → Database → Apply (migrations 004400 and 004500).
2. **API key.** PandaDoc → Settings → Integrations → API → generate a key. In
   Vercel → Settings → Environment Variables add `PANDADOC_API_KEY`, marked
   **Sensitive**, for Production. Redeploy.
3. **Templates.** In PandaDoc make two templates, a solar installation
   agreement and a change order, each with one signer role (default name
   `Client`). Put the fields you want filled in as tokens — the list is under
   Admin → Settings → E-signature → "Fields the templates can use", e.g.
   `[Client.FirstName]`, `[System.SizeKw]`, `[ChangeOrder.Amount]`. Paste each
   template's ID (the last part of its URL in PandaDoc) into Admin → Settings →
   E-signature and save.
4. **Webhook (recommended).** PandaDoc → Settings → Integrations → Webhooks →
   add one with the URL shown in Admin → Settings (it ends in
   `/api/integrations/pandadoc/webhook?signature={signature}`) and the event
   **Document state changed**. Copy its shared key into Vercel as
   `PANDADOC_WEBHOOK_KEY` (Sensitive) and redeploy. Without the webhook,
   **Check status** on the contact or change order picks up a signed document.

When a contract is signed the project is created exactly as if the rep had
pressed **Sign and create project**, as that rep, and the signed PDF is filed on
the project. When a change order is signed its amount is added to the
project's contract value and its PDF is filed. If something stops the outcome
from applying (for example the contact was signed by hand meanwhile), the
record shows the reason with a **Finish** button.

## Connecting Ask SolarFlow (the assistant)

1. **API key.** console.anthropic.com → API keys → create one. In Vercel →
   Settings → Environment Variables add `ANTHROPIC_API_KEY`, marked
   **Sensitive**, for Production. Redeploy. `/api/health` shows
   `ANTHROPIC_API_KEY: true` once it is picked up.
2. **Optional tuning.** `ASSISTANT_MODEL` (default `claude-opus-5`) and
   `ASSISTANT_EFFORT` (`low`, `medium`, `high`, `xhigh`, `max`; default
   `medium`). Higher effort gives more thorough answers to hard questions, but
   they take longer and cost more.
3. **Function time.** A question can take several lookups. The route asks
   Vercel for up to 120 seconds (`maxDuration`), which needs a plan that
   allows it; on a plan capped lower, long questions end with a timeout.

The assistant reads through the same permissions as the screens. A dealer
asking about "all projects" gets their own, and a sales rep is not offered the
dashboard. It cannot change anything. Every question is written to the activity
log (`assistant.asked`) with who asked, what was looked up and the token usage.
The answers themselves are not stored.
