import fs from 'fs';

const content = fs.readFileSync('tests/unit/editorController.test.ts', 'utf8');

const newContent = content.replace(
    /it\('should attempt to register provider \(handling import\.meta\.env crash gracefully\)', \(\) => {([\s\S]*?)mockVscode\.window\.registerCustomEditorProvider = originalRegister;\n        }\);/,
    `it('should attempt to register provider (handling import.meta.env crash gracefully)', () => {
            let registeredViewType = '';

            const originalRegister = mockVscode.window.registerCustomEditorProvider;
            mockVscode.window.registerCustomEditorProvider = (viewType: any, provider: any, options: any) => {
                registeredViewType = viewType as string;
                return { dispose: () => {} };
            };

            // This may throw due to import.meta.env not being transpiled to an object in TSX runner.
            // Using assert.throws lets us check it throws specifically due to the environment issue we know about.
            assert.throws(() => {
               registerEditorProvider('test-view', {} as any, undefined, null, { verified: true, readOnly: false });
            }, (err: any) => err.message.includes('VSCODE_BROWSER_EXT'));

            mockVscode.window.registerCustomEditorProvider = originalRegister;
        });`
).replace(
    /try {[\s\n]*await provider\.resolveCustomEditor[\s\S]*?\} catch \(e: any\) {[\s\n]*\/\/ Ignore the import\.meta\.env crash[\s\S]*?\}/,
    `// The import.meta.env crash happens during \`#generateWebviewHtml\`.
            // We use assert.rejects to explicitly handle and document the expected environment issue.
            await assert.rejects(
                provider.resolveCustomEditor(doc as any, webviewPanel as any, {} as any),
                (err: any) => err.message.includes('VSCODE_BROWSER_EXT')
            );`
);

fs.writeFileSync('tests/unit/editorController.test.ts', newContent);
