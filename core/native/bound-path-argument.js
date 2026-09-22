// Windows' bundled runtime receives argv through the active ANSI code page.
// Encode UTF-8 before spawning; decode only this explicit launch-argument form.
// The decoded path still has to match initializeDatabase's path exactly.
export function decodeBoundPathArgument(argument) {
    return argument.startsWith('--path-utf8=')
        ? decodeURIComponent(argument.slice('--path-utf8='.length))
        : argument;
}
