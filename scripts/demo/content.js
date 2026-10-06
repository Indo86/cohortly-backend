// The Cohortly demo dataset (npm run seed:demo). Small on purpose: one instructor workspace, three
// students in three different states, two published courses and one draft. Every account uses the
// reserved, non-routable domain cohortly.local, which is also how the seed recognises its own data.
//
// Nothing here is a score, a percentage or a completion flag: the seed creates the underlying records
// (enrollments, lesson completions, quiz attempts) and the application derives everything else.

export const DEMO_DOMAIN = 'cohortly.local'
export const DEMO_PASSWORD = 'CohortlyDemo123!'

export const INSTRUCTOR = { key: 'instructor', name: 'Rina Hartono', email: `demo.instructor@${DEMO_DOMAIN}` }

export const STUDENTS = [
    { key: 'notStarted', name: 'Adi Nugroho', email: `demo.student1@${DEMO_DOMAIN}`, persona: 'enrolled, has not started yet' },
    { key: 'inProgress', name: 'Bunga Lestari', email: `demo.student2@${DEMO_DOMAIN}`, persona: 'part-way through the main course' },
    { key: 'completed', name: 'Citra Wijaya', email: `demo.student3@${DEMO_DOMAIN}`, persona: 'completed both published courses, holds certificates' },
]

export const DEMO_EMAILS = [INSTRUCTOR.email, ...STUDENTS.map((student) => student.email)]

// Categories the demo courses use (upserted by name, never deleted: categories are shared data).
export const DEMO_CATEGORIES = ['Programming Fundamentals', 'Frontend', 'Backend', 'Web Development']

const text = (...paragraphs) => paragraphs.join('')

// A lesson is { key, title, text } or { key, title, youtubeId }. Rich text uses only the tags the
// backend sanitizer keeps (p, h2-h4, strong, em, ul/ol/li, blockquote, a).
export const COURSES = [
    {
        key: 'javascript',
        name: 'JavaScript Fundamentals',
        category: 'Programming Fundamentals',
        tagline: 'Write modern JavaScript with confidence',
        description: 'A practical introduction to the language that runs the web: values and types, functions and scope, and asynchronous code with promises and async/await.',
        status: 'published',
        sections: [
            {
                title: 'Variables and Data Types',
                lessons: [
                    {
                        key: 'js-let-const',
                        title: 'Understanding let and const',
                        text: text(
                            '<p>Modern JavaScript declares variables with <strong>let</strong> and <strong>const</strong>. Both are block-scoped: they exist only inside the nearest pair of curly braces.</p>',
                            '<ul><li>Use <strong>const</strong> by default, for bindings that are never reassigned.</li><li>Use <strong>let</strong> when the value must change, such as a counter in a loop.</li></ul>',
                            '<p>A <em>const</em> binding cannot be reassigned, but the object it points to can still be changed. Avoid <em>var</em> in new code: it is function-scoped and easy to misuse.</p>'
                        ),
                    },
                    {
                        key: 'js-primitives',
                        title: 'Primitive values',
                        text: text(
                            '<p>JavaScript has seven primitive types: <strong>string</strong>, <strong>number</strong>, <strong>bigint</strong>, <strong>boolean</strong>, <strong>undefined</strong>, <strong>null</strong> and <strong>symbol</strong>.</p>',
                            '<p>Primitives are immutable and compared by value, so <em>"cohort" === "cohort"</em> is true. Use <em>typeof</em> to inspect a value at run time, and remember that <em>typeof null</em> returns "object" for historical reasons.</p>'
                        ),
                    },
                    {
                        key: 'js-objects-arrays',
                        title: 'Objects and arrays',
                        text: text(
                            '<p>Objects group related values under named keys; arrays keep an ordered list. Both are compared by reference, not by content.</p>',
                            '<ol><li>Read a property with dot notation: <em>learner.name</em>.</li><li>Copy shallowly with the spread syntax: <em>{ ...learner }</em> or <em>[...lessons]</em>.</li><li>Transform arrays with <em>map</em>, <em>filter</em> and <em>reduce</em> instead of manual loops.</li></ol>'
                        ),
                    },
                ],
            },
            {
                title: 'Functions',
                lessons: [
                    {
                        key: 'js-declarations',
                        title: 'Function declarations and expressions',
                        text: text(
                            '<p>A function declaration is hoisted, so it can be called before the line where it is written. A function expression is created only when that line runs.</p>',
                            '<p>Give functions a single responsibility and a name that says what they return, such as <em>calculateProgress</em> or <em>isEnrolled</em>.</p>'
                        ),
                    },
                    {
                        key: 'js-arrow-functions',
                        title: 'Arrow functions',
                        text: text(
                            '<p>Arrow functions are a compact syntax for function expressions: <em>(a, b) =&gt; a + b</em>. They are ideal for callbacks such as <em>lessons.map((lesson) =&gt; lesson.title)</em>.</p>',
                            '<p>Unlike regular functions they do not have their own <em>this</em>; they use the <em>this</em> of the surrounding code. That makes them a poor fit for object methods.</p>'
                        ),
                    },
                    {
                        key: 'js-scope',
                        title: 'Scope and closures',
                        text: text(
                            '<p>Scope decides where a variable is visible. Each function and each block creates a new scope, nested inside the scope where it was written.</p>',
                            '<blockquote><p>A closure is a function that remembers the variables of the scope it was created in, even after that scope has finished running.</p></blockquote>',
                            '<p>Closures power private state, event handlers and factory functions.</p>'
                        ),
                    },
                ],
            },
            {
                title: 'Asynchronous JavaScript',
                lessons: [
                    {
                        key: 'js-promises',
                        title: 'Promises',
                        text: text(
                            '<p>A promise represents a value that will be available later, such as the response of a network request. It is <em>pending</em>, then either <em>fulfilled</em> or <em>rejected</em>.</p>',
                            '<p>Chain work with <em>then</em>, handle failures with <em>catch</em>, and run independent requests together with <em>Promise.all</em>.</p>'
                        ),
                    },
                    {
                        key: 'js-async-await',
                        title: 'async and await',
                        text: text(
                            '<p>An <strong>async</strong> function always returns a promise. Inside it, <strong>await</strong> pauses until a promise settles, so asynchronous code reads top to bottom.</p>',
                            '<p>Wrap awaited calls in <em>try / catch</em> to handle errors, and avoid awaiting inside a loop when the requests do not depend on each other.</p>'
                        ),
                    },
                ],
            },
        ],
        quiz: {
            title: 'JavaScript Fundamentals final quiz',
            passingScore: 70,
            questions: [
                {
                    prompt: 'Which keyword declares a block-scoped binding that cannot be reassigned?',
                    options: ['const', 'let', 'var', 'static'],
                    correct: 0,
                },
                {
                    prompt: 'What does typeof null return?',
                    options: ['"null"', '"object"', '"undefined"', '"number"'],
                    correct: 1,
                },
                {
                    prompt: 'How does an arrow function treat this?',
                    options: ['It creates its own this', 'It uses the this of the surrounding code', 'It always refers to the global object', 'It cannot access this at all'],
                    correct: 1,
                },
                {
                    prompt: 'Which statement about an async function is true?',
                    options: ['It blocks the main thread until it finishes', 'It always returns a promise', 'It cannot use try / catch', 'It must be called with new'],
                    correct: 1,
                },
            ],
        },
    },
    {
        key: 'responsive',
        name: 'Responsive Web Design',
        category: 'Frontend',
        tagline: 'Layouts that work on every screen',
        description: 'Build pages that adapt from phones to wide desktops with the box model, Flexbox, media queries and fluid sizing. No final quiz: completing every lesson completes the course.',
        status: 'published',
        sections: [
            {
                title: 'Layout Foundations',
                lessons: [
                    {
                        key: 'rwd-box-model',
                        title: 'The CSS box model',
                        text: text(
                            '<p>Every element is a box made of content, padding, border and margin. With <em>box-sizing: border-box</em>, the width you set includes padding and border, which makes layouts far easier to reason about.</p>'
                        ),
                    },
                    {
                        key: 'rwd-flexbox',
                        title: 'Flexbox essentials',
                        text: text(
                            '<p>Flexbox lays out items along one axis. Use <em>display: flex</em> on the container, then <em>justify-content</em> for the main axis and <em>align-items</em> for the cross axis.</p>',
                            '<ul><li><em>flex-wrap: wrap</em> lets items move to a new line on narrow screens.</li><li><em>gap</em> spaces items without margin hacks.</li></ul>'
                        ),
                    },
                ],
            },
            {
                title: 'Responsive Techniques',
                lessons: [
                    {
                        key: 'rwd-media-queries',
                        title: 'Media queries and breakpoints',
                        text: text(
                            '<p>Start with the small-screen layout and add <em>min-width</em> media queries as space grows (mobile first). Choose breakpoints where the content needs them, not for specific devices.</p>'
                        ),
                    },
                    {
                        key: 'rwd-fluid',
                        title: 'Fluid images and typography',
                        text: text(
                            '<p>Give images <em>max-width: 100%</em> and <em>height: auto</em> so they never overflow their container. Use <em>rem</em> units and <em>clamp()</em> to let text scale smoothly between a minimum and a maximum size.</p>'
                        ),
                    },
                    {
                        key: 'rwd-video-course',
                        title: 'Video: HTML and CSS in practice',
                        // freeCodeCamp's public "HTML & CSS Full Course" on YouTube
                        youtubeId: 'mU6anWqZJcc',
                    },
                ],
            },
        ],
        quiz: null,
    },
    {
        key: 'node',
        name: 'Node.js API Design',
        category: 'Backend',
        tagline: 'Design clear and predictable REST APIs',
        description: 'From resource naming to validation and error responses: the habits that make an API easy to use and hard to misuse. Still being written, so it stays a draft.',
        status: 'draft',
        sections: [
            {
                title: 'Designing REST Resources',
                lessons: [
                    {
                        key: 'node-resources',
                        title: 'Naming resources and routes',
                        text: text(
                            '<p>Name resources with plural nouns (<em>/courses</em>, <em>/courses/:id/sections</em>) and let the HTTP method express the action. Keep nesting shallow: one level is usually enough.</p>'
                        ),
                    },
                    {
                        key: 'node-status-codes',
                        title: 'HTTP methods and status codes',
                        text: text(
                            '<p>Use <em>201</em> for a created resource, <em>400</em> for invalid input, <em>401</em> when the caller is not authenticated, <em>403</em> when they are not allowed and <em>404</em> when the resource does not exist for them.</p>'
                        ),
                    },
                ],
            },
            {
                title: 'Validation and Errors',
                lessons: [
                    {
                        key: 'node-validation',
                        title: 'Validating request bodies',
                        text: text(
                            '<p>Validate every request body at the edge of the API with a schema, return all field errors in one response, and never trust identifiers or roles supplied by the client.</p>'
                        ),
                    },
                ],
            },
        ],
        quiz: null,
    },
]

// Who is enrolled where and what they have done. `completed` lists lesson keys; `daysAgo` places the
// activity in the recent past relative to the time the seed runs. Quiz answers list, per question,
// whether the student chose the correct option (scored by the application's own scoring function).
export const ENROLLMENTS = [
    { course: 'javascript', student: 'notStarted', completed: [] },
    {
        course: 'javascript',
        student: 'inProgress',
        completed: [
            { lesson: 'js-let-const', daysAgo: 6 },
            { lesson: 'js-primitives', daysAgo: 5 },
            { lesson: 'js-objects-arrays', daysAgo: 3 },
            { lesson: 'js-declarations', daysAgo: 1 },
        ],
    },
    {
        course: 'javascript',
        student: 'completed',
        completed: [
            { lesson: 'js-let-const', daysAgo: 14 },
            { lesson: 'js-primitives', daysAgo: 13 },
            { lesson: 'js-objects-arrays', daysAgo: 12 },
            { lesson: 'js-declarations', daysAgo: 10 },
            { lesson: 'js-arrow-functions', daysAgo: 9 },
            { lesson: 'js-scope', daysAgo: 8 },
            { lesson: 'js-promises', daysAgo: 6 },
            { lesson: 'js-async-await', daysAgo: 5 },
        ],
        // a first attempt below the passing score, then a pass: the attempt history tells a story
        quizAttempts: [
            { daysAgo: 4, correct: [true, false, true, false] },
            { daysAgo: 3, correct: [true, true, true, true] },
        ],
    },
    {
        course: 'responsive',
        student: 'inProgress',
        completed: [{ lesson: 'rwd-box-model', daysAgo: 2 }],
    },
    {
        course: 'responsive',
        student: 'completed',
        completed: [
            { lesson: 'rwd-box-model', daysAgo: 20 },
            { lesson: 'rwd-flexbox', daysAgo: 19 },
            { lesson: 'rwd-media-queries', daysAgo: 18 },
            { lesson: 'rwd-fluid', daysAgo: 17 },
            { lesson: 'rwd-video-course', daysAgo: 16 },
        ],
    },
]

// What the seed must observe afterwards (checked by the seed itself and by its tests).
export const EXPECTED_STATES = [
    { course: 'javascript', student: 'notStarted', completedLessons: 0, completed: false, certificate: false },
    { course: 'javascript', student: 'inProgress', completedLessons: 4, completed: false, certificate: false },
    { course: 'javascript', student: 'completed', completedLessons: 8, completed: true, certificate: true },
    { course: 'responsive', student: 'inProgress', completedLessons: 1, completed: false, certificate: false },
    { course: 'responsive', student: 'completed', completedLessons: 5, completed: true, certificate: true },
]
