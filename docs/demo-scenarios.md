# Cohortly demo scenarios

Walkthroughs for showing Cohortly to a reviewer, on the data of `npm run seed:demo`. Paths are the routes of the
Vue frontend (`lms-project-frontend-vue`, default `http://localhost:5173`).

## Setup (once)

```bash
# backend (needs a local MongoDB)
cp env.example .env            # DATABASE_URL=mongodb://127.0.0.1:27017/lms, SECRET_KEY_JWT, APP_URL, FRONTEND_URL
npm install
npm run seed:demo              # prints the accounts and the two certificate numbers
npm run dev

# frontend
cp .env.example .env           # VITE_API_URL=http://localhost:3000
npm install
npm run dev
```

Every account uses the password **`CohortlyDemo123!`**. Run `npm run seed:demo` again at any time to reset the
demo workspace (anything changed during a demo is undone; certificate numbers are new on every run).

| Account | Who |
|---|---|
| `demo.instructor@cohortly.local` | Rina Hartono, instructor, active workspace |
| `demo.student1@cohortly.local` | Adi Nugroho, enrolled, not started |
| `demo.student2@cohortly.local` | Bunga Lestari, in progress |
| `demo.student3@cohortly.local` | Citra Wijaya, completed, two certificates |

## Scenario A — Instructor (about 4 minutes)

1. `/instructor/sign-in` as `demo.instructor@cohortly.local`.
2. **Dashboard** (`/instructor`): 3 courses, 2 published, **3 students** (unique students: there are 5 enrollments,
   Bunga and Citra are in two courses each), 1 video lesson and 15 text lessons.
3. **Courses** (`/instructor/courses`): JavaScript Fundamentals and Responsive Web Design are *Published*,
   Node.js API Design is a *Draft* (students do not see it).
4. Open **JavaScript Fundamentals**:
   - **Content**: three sections (Variables and Data Types, Functions, Asynchronous JavaScript), eight lessons in an
     explicit order (Up/Down to reorder, edit a lesson to see the rich-text editor).
   - **Quiz**: a ready, 4-question final quiz with a 70% passing score.
   - **Learners**: the three enrolled students.
   - **Progress**: Adi 0/8, Bunga 4/8 (50%), Citra 8/8 with the quiz *Passed* (2 attempts) and a certificate issued.
5. Optional, to show a business rule: try to publish **Node.js API Design** (works: it has lessons), or delete every
   lesson of a published course (the last one is refused: a published course must keep a lesson). Reset afterwards.

## Scenario B — Student in progress (about 2 minutes)

1. `/student/sign-in` as `demo.student2@cohortly.local`.
2. **Dashboard** (`/student`): *Continue learning* points at **Arrow functions** in JavaScript Fundamentals.
3. **My Courses** (`/student/courses`): JavaScript Fundamentals 50% (4 of 8), Responsive Web Design 20% (1 of 5).
4. Open JavaScript Fundamentals: completed lessons are marked, the next lesson is flagged *Up next*, and the
   **Final quiz** card is *Locked* until every lesson is completed. No certificate yet.
5. Open the next lesson and use **Complete and continue**: the progress moves from the server's answer.

## Scenario C — Completed student (about 2 minutes)

1. `/student/sign-in` as `demo.student3@cohortly.local`.
2. **My Courses**: both courses are completed (*Review course*, *View certificate*).
3. JavaScript Fundamentals → **Final quiz**: the attempt history shows 50% (not passed) then 100% (passed).
4. **Certificates** (`/student/certificates`): two certificates; open one for the printable sheet
   (*Print / Save as PDF*). Responsive Web Design shows that a course without a quiz completes with its lessons.

## Scenario D — Public certificate verification (1 minute)

1. Copy a certificate number (from the seed output or Citra's certificate page), e.g. `COH-2026-XXXXXXXX`.
2. Signed out, open `/certificates/verify/<number>` (or the lookup form at `/certificates/verify`).
3. *Valid certificate* with the printed details only (student, course, instructor, date). A made-up number shows
   *Certificate not found*.

## Also worth showing

- Adi (`demo.student1@cohortly.local`) sees one course at 0% with *Start course*.
- `Profile → Change password` signs the user out everywhere (then reset the demo with `npm run seed:demo`).
- Entitlement: the workspace is ACTIVE for one month from the seed run; re-running the seed renews it.
