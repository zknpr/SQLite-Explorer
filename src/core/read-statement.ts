const isSpace = (code: number): boolean => code === 32 || (code >= 9 && code <= 13 && code !== 11);
const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isWordStart = (code: number): boolean => (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 0x80
);
const isWordPart = (code: number): boolean => isWordStart(code) || isDigit(code) || code === 36;

/**
 * Whether `sql` is exactly one statement that SQLite compiles as a SELECT: it
 * starts with SELECT or VALUES, or with WITH and the statement after the
 * common table expressions does.
 *
 * The engines step such a statement with writes refused. Only a SELECT can
 * start this way, so a write is never reported as a read. Text this cannot
 * place, including several statements in one string, is not a read here.
 */
export function isReadStatement(sql: string): boolean {
    let first: string | undefined;
    let mainVerb: string | undefined;
    // The last token outside every parenthesis. After WITH, the word that
    // follows a closing parenthesis and is not AS starts the statement itself:
    // a column list is followed by AS, a table expression by a comma or by it.
    let previous = '';
    let depth = 0;
    let ended = false;
    const length = sql.length;
    for (let i = 0; i < length;) {
        const code = sql.charCodeAt(i);
        if (isSpace(code)) {
            i++;
            continue;
        }
        if (code === 45 && sql.charCodeAt(i + 1) === 45) {
            const end = sql.indexOf('\n', i + 2);
            i = end < 0 ? length : end + 1;
            continue;
        }
        if (code === 47 && sql.charCodeAt(i + 1) === 42) {
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? length : end + 2;
            continue;
        }
        if (ended) return false;
        if (isWordStart(code)) {
            const start = i++;
            while (i < length && isWordPart(sql.charCodeAt(i))) i++;
            // Keywords are short; a long word is an identifier.
            const word = i - start <= 6 ? sql.slice(start, i).toUpperCase() : 'identifier';
            if (first === undefined) {
                if (word !== 'SELECT' && word !== 'VALUES' && word !== 'WITH') return false;
                first = word;
            } else if (
                first === 'WITH' && mainVerb === undefined && depth === 0 &&
                previous === ')' && word !== 'AS'
            ) {
                if (word !== 'SELECT' && word !== 'VALUES') return false;
                mainVerb = word;
            }
            if (depth === 0) previous = word;
            continue;
        }
        if (first === undefined) return false;
        if (code === 39 || code === 34 || code === 96 || code === 91) {
            // ' " ` double their closing character to include it; [ ] does not.
            const close = code === 91 ? ']' : sql[i];
            let end = sql.indexOf(close, i + 1);
            while (code !== 91 && end >= 0 && sql.charCodeAt(end + 1) === code) {
                end = sql.indexOf(close, end + 2);
            }
            if (end < 0) return false;
            i = end + 1;
            if (depth === 0) previous = 'quoted';
        } else if (isDigit(code)) {
            // One token, so the exponent or hex digits of a number are not a word.
            i++;
            while (i < length && (isWordPart(sql.charCodeAt(i)) || sql.charCodeAt(i) === 46)) i++;
            if (depth === 0) previous = 'number';
        } else {
            if (code === 40) {
                depth++;
            } else if (code === 41) {
                if (--depth < 0) return false;
                if (depth === 0) previous = ')';
            } else if (code === 59) {
                if (depth !== 0) return false;
                ended = true;
            } else if (depth === 0) {
                previous = sql[i];
            }
            i++;
        }
    }
    if (depth !== 0 || first === undefined) return false;
    return first !== 'WITH' || mainVerb !== undefined;
}
