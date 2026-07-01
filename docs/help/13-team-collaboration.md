# Team collaboration

KageOps started as a solo desktop app. As of F-302 V1, projects can have multiple members — each with a clear role, shared chat with Sensei, per-task comments, and live notifications when a teammate acts. This page is the operator's guide to the collaboration features.

## Roles

Every project has exactly one **owner** plus N **reviewers** and **observers**. The role you have on a project decides what you can do.

| Role | Can do | Cannot do |
|---|---|---|
| **Owner** | Everything below + delete the project, set the budget cap, transfer ownership. | — |
| **Reviewer** | Reply to Sensei, start phases, approve gates, claim tasks, comment, archive / restore / reopen, retry failed tasks. | Delete, set budget, transfer ownership. |
| **Observer** | Read everything, post comments, run dry-runs only. | Start live runs, approve gates, claim tasks. |

The role names map directly to the values in the database (`owner` / `reviewer` / `observer`) — no other roles exist.

## Inviting teammates

1. Open **Configuration → Team** (or click the avatar stack on any project header).
2. Click **Invite member**.
3. Enter the email address. Pick a role (defaults to `reviewer`).
4. KageOps sends a Clerk invitation email and pre-creates the membership row so the invitee shows up in the panel as `invited` immediately.

The invitee follows the link in the email, signs in, and the row flips to `active`. From that moment on they can act according to their role.

### Seat caps by plan

| Plan | Org seats | Per-project collaborators | Active projects |
|---|---|---|---|
| Free ($0) | 1 (just you) | 1 | 1 |
| Starter ($19/mo) | 2 (you + 1) | 2 | unlimited |
| Team ($49/mo) | 10 | 10 | unlimited |
| Enterprise ($149/mo) | unlimited | unlimited | unlimited |

If you try to invite someone over the cap, KageOps rejects with a "your *X* plan includes Y seats" message and points at the upgrade.

## Shared Sensei chat

Every project has its own Sensei chat thread. Two members on the same project see the same conversation history — survives Electron restart, survives the original author signing out.

- Each message is attributed: `Alice (reviewer): start phase 3`.
- The role label is captured at the moment the message was sent — even if Alice's role changes later, the historical attribution stays accurate.
- Sensei sees the full multi-author thread in its system prompt and answers accordingly. If a viewer (`observer`) tries to issue a dispatch-style message ("start phase 3"), Sensei refuses and points at the upgrade.
- Clearing the chat for a project deletes the persisted rows. Other members will see the empty thread on next open.

The legacy "non-project" chat (the welcome-screen helper, setup wizard) stays in-memory and per-machine — these aren't meant to be collaboration surfaces.

## Per-task comments

Every task in a project has a comment thread. Use it to:
- Leave a note for the agent ("`forge` — please use the existing `formatDate` util") which gets injected into the next retry context.
- Coordinate with other team members ("`vigil` flagged this — taking another look").

Posting a comment notifies every other project member with a desktop notification. Click the notification to focus the Command Center on the task.

## Claiming tasks

Tasks can be claimed by a member to signal "I'm looking at this." The claim is advisory — agents continue to dispatch independent of human claims — but it lets the team coordinate without stepping on each other.

- Click **Claim** on any task card.
- Other members see "Claimed by Alice" with the timestamp.
- Only Alice can unclaim. To re-assign, the original claimer unclaims, then the new owner claims.
- If two members both click **Claim** at the same instant, the second click gets a "Bob just claimed this" toast — KageOps refuses to silently overwrite.

## Optimistic locking — what the "out of date" toast means

When Alice and Bob both look at a project at the same time and both click **Pause**, KageOps refuses the second click rather than silently overwriting:

> Couldn't pause — out of date
> Another team member updated "Project X" just now. Refreshing the project list.

This applies to every state-changing action: pause / resume / cancel / archive / restore / reopen / claim. The list view refreshes automatically; you can re-attempt with the new state in front of you.

## Activity feed

The team panel's **Activity** tab shows a unified feed of every agent action and human action across the projects you can see. Filter by `humans` / `agents` / `all` at the top.

Events that show up:
- Project created / phase advanced / completed / cancelled / archived / reopened.
- Task started / completed / failed / claimed / commented.
- Member invited / role changed / removed.

## When a member is removed

Removed members keep their attribution on:
- Past chat messages (you'll see "Alice (former member): ...").
- Past comments.
- Past task claims.
- The activity feed.

They lose every active permission immediately. They can't be re-invited under a new email — the original assignment row is soft-deleted (`removed_at`) so re-invitation reuses the slot.

## Owner transfer (Team tier and above)

If you need to hand a project off:
1. Open the project's settings.
2. Click **Transfer ownership**.
3. Pick a member from the current project. Confirm.
4. The new owner gets a notification asking them to **accept** the transfer.
5. Ownership transfers when they accept — until then you remain the owner.

If the new owner declines or the request times out (7 days), nothing changes. Free / Starter plans don't have transfer — the workaround is to invite the new owner, have them create a fresh project, and copy across whatever's worth keeping.

## Two-person mode — what works and what doesn't

**Works well:**
- Two members chatting with Sensei in turn.
- One member running tasks while the other reviews / comments.
- Live activity feed updates so you can see what your teammate just did.
- Conflict toasts when you race a state-change action.

**Doesn't work yet (V2 backlog):**
- Editing the project workspace files concurrently between agent runs — git is the source of truth, coordinate via commits.
- Threaded replies / reactions on chat messages.
- @mentioning a teammate in a comment.
- Per-user notification preferences.

## Troubleshooting

- **"You are not a member of this project"** — your Clerk user isn't on the project. Ask the owner to invite you, or check that you're signed into the right Clerk account.
- **"This action requires one of: owner, reviewer"** — your role is `observer` and the action you tried is restricted. Ask the owner to bump your role.
- **No invite email received** — Clerk's invitation email can take a minute. Also check your spam folder; the sender is `noreply@clerk.com`.
- **Notifications not firing** — desktop notifications need OS-level permission. On macOS: `System Settings → Notifications → KageOps`. On Windows: `Settings → System → Notifications → KageOps`.
- **Presence not updating** — presence requires `SUPABASE_URL` and `SUPABASE_ANON_KEY` env vars. The team panel will run without them, but the green online dots stay grey.
