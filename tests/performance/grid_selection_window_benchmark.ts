// Time per virtual window move with and without a large selection, in the
// real viewer bundle under headless Chromium.
//
// npx tsx tests/performance/grid_selection_window_benchmark.ts [label=treeRoot ...]
// Each tree root holds core/ and src/: this checkout (the default), or another
// commit's, e.g. `mkdir .tmp/before && git archive <commit> core src | tar -x -C .tmp/before`.
// Every condition gets its own page, brought to the front for each move, and
// moves are interleaved round-robin across all pages so drift hits every
// condition alike. Pages of the same scenario and selection must leave the same
// rows, cells, classes and ARIA positions after every move (domMismatches).
// MOVES (default 40) timed moves follow 5 warm-up moves; ONLY=<text> keeps
// the scenarios naming it and REVERSE=1 opens them in reverse order.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Page } from 'playwright-core';

const worktree = path.resolve(__dirname, '../..');
const browserPath = [
    process.env.SQLITE_EXPLORER_CHROMIUM_PATH,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(candidate => candidate && existsSync(candidate));

const MOVES = Number(process.env.MOVES ?? 40);
const WARMUP = 5;

async function bundle(treeRoot: string) {
    const result = await esbuild.build({
        stdin: {
            contents: `
                import './core/ui/viewer.js';
                import { state } from './core/ui/modules/state.js';
                import { updateVirtualGridWindow, getVirtualWindowBounds, getVirtualColumnBounds } from './core/ui/modules/grid-render.js';
                import { updateSelectionStates } from './core/ui/modules/grid-selection.js';
                window.__bench = { state, updateVirtualGridWindow, getVirtualWindowBounds, getVirtualColumnBounds, updateSelectionStates };
            `,
            resolveDir: treeRoot
        },
        bundle: true,
        format: 'iife',
        platform: 'browser',
        write: false
    });
    return readFileSync(path.join(treeRoot, 'core/ui/viewer.template.html'), 'utf8')
        .replace('<!--HEAD-->', '<meta id="vscode-env" data-sidebar-left="220" data-default-page-size="5000" data-cell-edit-behavior="inline">')
        .replace('<!--STYLES-->', () => readFileSync(path.join(treeRoot, 'core/ui/viewer.css'), 'utf8'))
        .replace('<!--SCRIPTS-->', () => result.outputFiles[0].text);
}

type Selection = 'none' | 'rows-all' | 'cells-all' | 'cells-rect';
type Condition = { tree: string; scenario: string; columnCount: number; selection: Selection; axis: 'rows' | 'columns' };

function install({ columnCount }: { columnCount: number }) {
    const columns = Array.from({ length: columnCount }, (_, index) => ({
        ordinal: index,
        identifier: index === 0 ? 'id' : `c${index}`,
        declaredType: index === 0 ? 'INTEGER' : 'TEXT',
        primaryKeyPosition: index === 0 ? 1 : 0,
        isRowidAlias: index === 0,
        isRequired: false,
        defaultExpression: null
    }));
    const rowCount = 5000;
    Object.assign(window, {
        acquireVsCodeApi: () => ({
            getState: () => ({ selectedTable: 'items', selectedTableType: 'table', rowsPerPage: 5000 }),
            setState() {},
            postMessage(message: any) {
                if (message.channel !== 'rpc' || message.content?.kind !== 'invoke') return;
                const { messageId, targetMethod, payload } = message.content;
                let data: unknown;
                if (targetMethod === 'initialize') data = { connected: true, readOnly: false, connectionGeneration: 1, cellEditBehavior: 'inline' };
                else if (targetMethod === 'ping') data = true;
                else if (targetMethod === 'fetchSchema') data = { tables: [{ identifier: 'items' }], views: [], indexes: [] };
                else if (targetMethod === 'getTableInfo') data = columns;
                else if (targetMethod === 'fetchTableCount') data = { count: rowCount, isExact: true };
                else if (targetMethod === 'fetchTableData') {
                    const options = payload[1];
                    data = {
                        rows: Array.from({ length: Math.min(options.limit, rowCount - options.offset) }, (_, index) => {
                            const id = options.offset + index + 1;
                            return [id, id, ...columns.slice(1).map(column => `${column.identifier}-${id}`)];
                        })
                    };
                } else if (targetMethod === 'saveSidebarState') data = undefined;
                else throw new Error(`Unexpected viewer RPC: ${targetMethod}`);
                queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
                    data: { channel: 'rpc', content: { kind: 'response', messageId, success: true, data } }
                })));
            }
        })
    });
}

async function openCondition(context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>, html: string, condition: Condition) {
    const page = await context.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.addInitScript({ content: `globalThis.__name = value => value; (${install.toString()})(${JSON.stringify({ columnCount: condition.columnCount })});` });
    await page.goto('https://sqlite-explorer.test/viewer');
    await page.waitForFunction(() => {
        const bench = (window as any).__bench;
        return !!bench && bench.state.gridData.length > 0 && !bench.state.isGridReloading && !bench.state.isLoadingColumns;
    }, undefined, { timeout: 30000 });
    const info = await page.evaluate((selection: Selection) => {
        const bench = (window as any).__bench;
        const { state } = bench;
        const rows = state.gridData.length;
        const columns = state.tableColumns.length;
        if (selection === 'rows-all') {
            (document.querySelector('.row-select-all-button') as HTMLElement).click();
        } else if (selection === 'cells-all' || selection === 'cells-rect') {
            // Same objects, in the same order, as a Shift-click range builds.
            const lastRow = selection === 'cells-all' ? rows : Math.min(rows, Math.floor(100000 / columns));
            const cells = [];
            for (let rowIdx = 0; rowIdx < lastRow; rowIdx++) {
                const row = state.gridData[rowIdx];
                for (let colIdx = 0; colIdx < columns; colIdx++) {
                    cells.push({ rowIdx, colIdx, rowId: row[0], value: row[colIdx + 1] });
                }
            }
            state.selectedCells = cells;
            state.lastSelectedCell = { rowIdx: 0, colIdx: 0 };
            bench.updateSelectionStates();
        }
        return {
            rows,
            columns,
            selectedCells: state.selectedCells.length,
            selectedRows: state.selectedRowIds.size,
            rowWindow: bench.getVirtualWindowBounds(),
            columnWindow: bench.getVirtualColumnBounds()
        };
    }, condition.selection);
    return { page, info };
}

/** One window move: scroll one step on the condition's axis, then time the synchronous revalidation. */
async function move(page: Page, axis: 'rows' | 'columns', step: number) {
    return page.evaluate(async ({ axis, step }) => {
        const bench = (window as any).__bench;
        const container = document.getElementById('gridContainer')!;
        // Let the previous move's style/layout settle outside the timed region.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        // Ping-pong between the ends, so every move overlaps the last window
        // the way scrolling does (a wrap to 0 would rebuild it whole).
        const w = window as any;
        w.__direction ??= 1;
        const property = axis === 'rows' ? 'scrollTop' : 'scrollLeft';
        const max = axis === 'rows'
            ? container.scrollHeight - container.clientHeight
            : container.scrollWidth - container.clientWidth;
        let next = container[property] + w.__direction * step;
        if (next > max || next < 0) {
            w.__direction = -w.__direction;
            next = container[property] + w.__direction * step;
        }
        container[property] = next;
        // Force layout before timing so both arms pay it outside the measurement.
        void container.getBoundingClientRect().height;
        const start = performance.now();
        const changed = bench.updateVirtualGridWindow();
        const elapsed = performance.now() - start;
        // What selection rendering left in the DOM: every built row and cell
        // with its classes and ARIA position, hashed (FNV-1a) to compare trees.
        let hash = 0x811c9dc5;
        const feed = (text: string) => {
            for (let index = 0; index < text.length; index++) {
                hash ^= text.charCodeAt(index);
                hash = Math.imul(hash, 0x01000193) >>> 0;
            }
        };
        let selectedCells = 0;
        for (const tr of container.querySelectorAll('tbody tr')) {
            feed(`${tr.id}|${tr.className}|${tr.getAttribute('aria-rowindex')};`);
            for (const td of tr.children) {
                if (td.classList.contains('cell-selected')) selectedCells++;
                feed(`${td.id}|${td.className}|${td.getAttribute('aria-colindex')};`);
            }
        }
        return { changed, elapsed, signature: `${hash.toString(16)}:${selectedCells}` };
    }, { axis, step });
}

function median(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], p: number) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function main() {
    if (!browserPath) throw new Error('No Chromium');
    const trees = process.argv.slice(2).map(argument => {
        const [label, root] = argument.split('=');
        return { label, root: path.resolve(root) };
    });
    if (trees.length === 0) trees.push({ label: 'worktree', root: worktree });
    const scenarios: Omit<Condition, 'tree'>[] = [
        { scenario: '4 cols, 5,000 rows, vertical', columnCount: 4, selection: 'none', axis: 'rows' },
        { scenario: '4 cols, 5,000 rows, vertical', columnCount: 4, selection: 'rows-all', axis: 'rows' },
        { scenario: '4 cols, 5,000 rows, vertical', columnCount: 4, selection: 'cells-all', axis: 'rows' },
        { scenario: '200 cols, 1,200 rows, vertical', columnCount: 200, selection: 'none', axis: 'rows' },
        { scenario: '200 cols, 1,200 rows, vertical', columnCount: 200, selection: 'cells-rect', axis: 'rows' },
        { scenario: '200 cols, 1,200 rows, horizontal', columnCount: 200, selection: 'none', axis: 'columns' },
        { scenario: '200 cols, 1,200 rows, horizontal', columnCount: 200, selection: 'cells-rect', axis: 'columns' }
    ];
    // ONLY=<text> keeps the scenarios naming it; REVERSE=1 opens them in reverse order.
    const selected = scenarios.filter(scenario => !process.env.ONLY || scenario.scenario.includes(process.env.ONLY));
    if (process.env.REVERSE) selected.reverse();
    scenarios.splice(0, scenarios.length, ...selected);
    const profile = mkdtempSync(path.join(worktree, '.tmp', 'bench-profile-'));
    const context = await chromium.launchPersistentContext(profile, {
        executablePath: browserPath,
        headless: true,
        viewport: { width: 1280, height: 720 }
    });
    try {
        const htmlByTree = new Map<string, string>();
        for (const tree of trees) htmlByTree.set(tree.label, await bundle(tree.root));
        const runs: { condition: Condition; page: Page; info: unknown; samples: number[]; unchanged: number; signatures: string[] }[] = [];
        for (const scenario of scenarios) {
            for (const tree of trees) {
                const condition = { ...scenario, tree: tree.label };
                const { page, info } = await openCondition(context, htmlByTree.get(tree.label)!, condition);
                runs.push({ condition, page, info, samples: [], unchanged: 0, signatures: [] });
            }
        }
        // Rows: 15 rows per step re-centers the 20-row-overscan window every
        // move. Columns: 8 columns (~102 px each) per step re-centers the
        // 10-column-overscan window every move.
        const stepFor = (axis: 'rows' | 'columns') => (axis === 'rows' ? 15 * 26 : 8 * 102);
        for (let round = 0; round < MOVES + WARMUP; round++) {
            for (const run of runs) {
                // Only the front page runs at full speed; every move is measured in front.
                await run.page.bringToFront();
                const { changed, elapsed, signature } = await move(run.page, run.condition.axis, stepFor(run.condition.axis));
                run.signatures.push(signature);
                if (round < WARMUP) continue;
                if (changed) run.samples.push(elapsed);
                else run.unchanged++;
            }
        }
        // Same scenario and selection in every tree must leave the same DOM after every move.
        const mismatches: string[] = [];
        for (const run of runs) {
            const reference = runs.find(other => other.condition.scenario === run.condition.scenario
                && other.condition.selection === run.condition.selection);
            if (reference && reference !== run && reference.signatures.join() !== run.signatures.join()) {
                mismatches.push(`${run.condition.tree} vs ${reference.condition.tree}: ${run.condition.scenario} ${run.condition.selection}`);
            }
        }
        console.log(JSON.stringify({ domMismatches: mismatches, comparedMoves: MOVES + WARMUP }));
        const results = runs.map(run => ({
            tree: run.condition.tree,
            scenario: run.condition.scenario,
            selection: run.condition.selection,
            info: run.info,
            moves: run.samples.length,
            unchanged: run.unchanged,
            medianMs: Number(median(run.samples).toFixed(3)),
            p90Ms: Number(percentile(run.samples, 0.9).toFixed(3)),
            movesShowingSelectedCells: run.signatures.slice(WARMUP).filter(signature => !signature.endsWith(':0')).length
        }));
        console.log(JSON.stringify(results, null, 1));
    } finally {
        await context.close();
        rmSync(profile, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exit(1); });
