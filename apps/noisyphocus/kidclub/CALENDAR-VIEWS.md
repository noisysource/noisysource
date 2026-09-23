# Calendar views — parent and admin

Two navigation changes, one idea: the thing people come here to do is **mark a day**, and it
used to be four clicks deep on both sides.

## Parent — `/client/calendar`

One grid for the whole family. Every child, both services, one month at a time.

**Before:** dashboard → as minhas crianças → child → subscription detail → scroll to "próximas
4 semanas" → cancel. Four screens, and only ever one subscription in view at a time, so a
parent with three children had no way to see a week.

**Now:** sidebar → Calendário. Click a chip to cancel, click again to restore.

- **Colour per child**, icon per service (📚 estudo / 🚌 transporte). Chips show the time.
- **Filters**: toggle any child, either service, or "só faltas". A parent with three children
  and five subscriptions can narrow to one thing without leaving the page.
- **Month navigation**, plus "Hoje".
- **Optimistic toggling** — the grid is dense, and reloading the month on every click made it
  feel broken. A refusal from the callable reverts the chip and shows the error.
- **One query per month**, `familyId` + date range, not one per subscription. `firestore.rules`
  scopes `reservationEvents` to the owning family, so this is both cheaper and exactly the set
  the parent is allowed to read.

> ⚠️ **This query needs a composite index**: `reservationEvents` on `familyId` ASC + `date` ASC,
> added to `firestore.indexes.json` so CI deploys it to **both** projects. A hand-created index
> in the console covers only the project it was made in and is lost on the next environment
> rebuild — the calendar would then throw `FAILED_PRECONDITION` for every family in the other
> one. The admin day editor's `subscriptionId in [...]` + date query is already covered by the
> existing `subscriptionId` + `date` index.
>
> Firestore builds indexes asynchronously. Until the index reports `READY` the page errors; check
> with:
> ```bash
> gcloud firestore indexes composite list --project kidclub-dev --filter="reservationEvents"
> ```

### It is also a data-correctness tool

This is why the view earns its place beyond convenience. A per-subscription page cannot show
you what is *missing*; a grid can.

- **"Sem ocorrências geradas"** warns when a subscription is active but produced nothing this
  month. Under flat pricing that month still bills in full, so the difference between "no
  school this month" and "generation failed" is money. This is the client-side counterpart of
  flag (a) in `reconcile-report.mjs`.
- A day short a leg, a child with a suspiciously empty week, a boundary month that pro-rated
  the wrong way — all visible at a glance, none of them visible one subscription at a time.

### Reads the new model

It queries `reservationEvents` directly. The older per-child calendar
(`/client/children/:childId/calendar`) still goes through `eventService` and the legacy `Event`
model; it is kept because `ChildDetailPage` links to it, but it is **not** the source of truth
and should eventually fold into this page.

## Admin — Cobranças, inline day editor

The "Dias sem serviço" calendar was a modal. Marking a day cost a click to open, a click to
close and a refresh to see the effect — while the line items it changes sat hidden underneath
the dialog.

**Now** it renders inline in the expanded billing row, so the calendar and the amount it moves
are on screen together. "📅 Dias" expands the row instead of opening a dialog, and an
"Atualizar valores" button appears only once something actually changed.

Each service calendar is **headed by the child's name**. Before, a record with several
subscriptions showed several calendars all labelled "Sala de Estudo" or "Transporte", with no
way to tell whose days you were about to change.

Only a **pending** record gets an editor. An invoiced one backs an issued fiscal document and
is frozen (decision 5).

## Removed

Four files, all genuinely unreachable — verified by reference count, not assumed:

| File | Why |
|---|---|
| `ClientDashboardPage.tsx` | zero references anywhere |
| `FamilyDashboardPage.tsx.example` | a scratch copy checked in by accident |
| `FamilySchedulePage.tsx` | routed at `/client/family/schedule` but **nothing linked to it**, and its own links pointed at routes that do not exist (`/client/children/:id/subscriptions/study/:id`) |
| `ClientSchedulePage.tsx` | routed at `/client/schedule`, nothing linked to it, overlapping subset of the calendar |

Both removed routes now **redirect** to `/client/calendar` rather than 404, so an old bookmark
still lands somewhere useful.

`ClaimSubscriptionsPage` was checked and **kept** — it is not routed, but `ClientLayout` renders
it directly for families with unclaimed subscriptions.

## Still worth doing

- `EventCalendarPage` should fold into `/client/calendar` with a child filter, once the new page
  has been used enough to trust. That removes the last dependency on the legacy `Event` model in
  the client.
- `MySubscriptionsPage` and `FamilyDashboardPage` still overlap: both list children with their
  subscriptions. The dashboard could become a summary that links into the calendar.
- The calendar loads one month at a time. For a family with many subscriptions a prefetch of the
  neighbouring months would make navigation feel instant; not done, not obviously needed yet.
