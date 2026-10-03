import sanitizeHtml from 'sanitize-html'

// Policy for lesson rich text (CKEditor 5: headings, bold/italic, links, lists,
// tables, indent, media embed). Everything else, including scripts, event
// handlers, iframes, inline styles (except indent margins) and javascript: URLs,
// is removed.
const options = {
    allowedTags: [
        'p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li',
        'blockquote', 'figure', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
        'oembed',
    ],
    allowedAttributes: {
        a: ['href', 'target', 'rel'],
        oembed: ['url'],
        figure: ['class'],
        p: ['style'],
        li: ['style'],
        h2: ['style'],
        h3: ['style'],
        h4: ['style'],
        th: ['colspan', 'rowspan'],
        td: ['colspan', 'rowspan'],
    },
    allowedClasses: { figure: ['table', 'media'] },
    allowedStyles: {
        '*': { 'margin-left': [/^\d+(\.\d+)?(em|px)$/] },
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { oembed: ['http', 'https'] },
    transformTags: {
        a: (tagName, attribs) => ({
            tagName,
            attribs: { ...attribs, rel: 'noopener noreferrer' },
        }),
    },
}

export const sanitizeRichText = (html) =>
    typeof html === 'string' ? sanitizeHtml(html, options) : html
