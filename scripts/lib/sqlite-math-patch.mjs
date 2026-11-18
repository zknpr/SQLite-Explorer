/**
 * Changes to the SQLite amalgamation of the WebAssembly build.
 *
 * SQLite marks its math functions deterministic, so it accepts them in
 * indexes, partial-index WHERE clauses and generated columns. The WebAssembly
 * libm can differ from a native one in the last digit: an index key or a
 * stored column computed here would not be the one the native engine
 * computes, and a row could then be missing from its index.
 *
 * That holds for the functions that compute with the library (exp, pow, the
 * logarithms, the trigonometric and hyperbolic functions). It does not hold
 * for ceil, ceiling, floor, trunc, mod and sqrt, whose result IEEE 754 fixes
 * to the last bit, for radians and degrees, which are one multiplication by
 * a constant, nor for sign and pi: those are left exactly as SQLite has them
 * (tests/unit/wasm_exact_math_parity.test.ts compares them with the native
 * engine bit for bit). A math function SQLite adds later is treated as one
 * that can differ until it is listed here.
 *
 * The functions keep SQLite's own code and stay deterministic, so a database
 * that uses them in its schema opens and every table reads. Two things are
 * refused instead:
 *
 * - An index that depends on a math function is never opened. Its keys were
 *   computed elsewhere: a lookup with a value computed here could miss a row,
 *   and a key written here could differ from the native one. Every statement
 *   that opens an index asks sqlite3KeyInfoOfIndex for it, where SQLite also
 *   refuses an index with an unknown collation, so that function refuses it.
 *   The places that choose an index to read skip it first, so a query scans
 *   the table instead of failing; a place this list misses fails the
 *   statement with that error and cannot return a wrong answer.
 * - A table that stores a generated column depending on a math function is
 *   not modified: sqlite3IsReadOnly, which every INSERT, UPDATE and DELETE
 *   asks, refuses it as it refuses a system table.
 *
 * Every replacement must match exactly once, so a SQLite upgrade that moves
 * this code fails the build instead of dropping a change silently.
 */
const replacements = [
  // A function flag bit SQLite leaves unused marks the math functions.
  ['/*                           0x0200 -- available for reuse */\n',
    '#define SQLITE_FUNC_LIBM     0x0200 /* SQLite Explorer: computed by the math library */\n'],
  // MFUNCTION marks every function declared with it; XFUNCTION is SQLite's
  // own MFUNCTION, for the ones whose result cannot differ.
  ['#define MFUNCTION(zName, nArg, xPtr, xFunc) \\\n' +
    '  {nArg, SQLITE_FUNC_BUILTIN|SQLITE_FUNC_CONSTANT|SQLITE_UTF8, \\\n' +
    '   xPtr, 0, xFunc, 0, 0, 0, #zName, {0} }\n',
  '#define MFUNCTION(zName, nArg, xPtr, xFunc) \\\n' +
    '  {nArg, SQLITE_FUNC_BUILTIN|SQLITE_FUNC_CONSTANT|SQLITE_FUNC_LIBM|SQLITE_UTF8, \\\n' +
    '   xPtr, 0, xFunc, 0, 0, 0, #zName, {0} }\n' +
    '#define XFUNCTION(zName, nArg, xPtr, xFunc) \\\n' +
    '  {nArg, SQLITE_FUNC_BUILTIN|SQLITE_FUNC_CONSTANT|SQLITE_UTF8, \\\n' +
    '   xPtr, 0, xFunc, 0, 0, 0, #zName, {0} }\n' +
    '#define LFUNCTION(zName, nArg, iArg, xFunc) \\\n' +
    '  {nArg, SQLITE_FUNC_BUILTIN|SQLITE_FUNC_CONSTANT|SQLITE_FUNC_LIBM|SQLITE_UTF8, \\\n' +
    '   SQLITE_INT_TO_PTR(iArg), 0, xFunc, 0, 0, 0, #zName, {0} }\n'],
  // LFUNCTION is FUNCTION with SQLITE_FUNC_LIBM, as MFUNCTION now is.
  ['    FUNCTION(ln,                 1, 0, 0,      logFunc     ),\n' +
    '    FUNCTION(log,                1, 1, 0,      logFunc     ),\n' +
    '    FUNCTION(log10,              1, 1, 0,      logFunc     ),\n' +
    '    FUNCTION(log2,               1, 2, 0,      logFunc     ),\n' +
    '    FUNCTION(log,                2, 0, 0,      logFunc     ),\n',
  '    LFUNCTION(ln,                1, 0,         logFunc     ),\n' +
    '    LFUNCTION(log,               1, 1,         logFunc     ),\n' +
    '    LFUNCTION(log10,             1, 1,         logFunc     ),\n' +
    '    LFUNCTION(log2,              1, 2,         logFunc     ),\n' +
    '    LFUNCTION(log,               2, 0,         logFunc     ),\n'],
  ...[
    '    MFUNCTION(ceil,              1, xCeil,     ceilingFunc ),\n',
    '    MFUNCTION(ceiling,           1, xCeil,     ceilingFunc ),\n',
    '    MFUNCTION(floor,             1, xFloor,    ceilingFunc ),\n',
    '    MFUNCTION(trunc,             1, trunc,     ceilingFunc ),\n',
    '    MFUNCTION(mod,               2, fmod,      math2Func   ),\n',
    '    MFUNCTION(sqrt,              1, sqrt,      math1Func   ),\n',
    '    MFUNCTION(radians,           1, degToRad,  math1Func   ),\n',
    '    MFUNCTION(degrees,           1, radToDeg,  math1Func   ),\n',
    '    MFUNCTION(pi,                0, 0,         piFunc      ),\n'
  ].map(entry => [entry, entry.replace('MFUNCTION', 'XFUNCTION')]),
  // The test for an index, declared beside the function that refuses one:
  // sqlite3FindInIndex, earlier in the file, uses it too.
  ['SQLITE_PRIVATE KeyInfo *sqlite3KeyInfoOfIndex(Parse*, Index*);\n',
    'SQLITE_PRIVATE KeyInfo *sqlite3KeyInfoOfIndex(Parse*, Index*);\n' +
    'SQLITE_PRIVATE int sqliteExplorerIndexUsesLibm(Parse*, Index*);\n'],
  ['SQLITE_PRIVATE KeyInfo *sqlite3KeyInfoOfIndex(Parse *pParse, Index *pIdx){\n' +
    '  int i;\n  int nCol = pIdx->nColumn;\n  int nKey = pIdx->nKeyCol;\n  KeyInfo *pKey;\n  if( pParse->nErr ) return 0;\n',
  '/*\n' +
    '** SQLite Explorer: Walker callback. Sets bit 1 of eCode and stops at a call\n' +
    '** of a math function; sets bit 2 at a reference to a VIRTUAL column of the\n' +
    '** table in u.pTab.\n' +
    '*/\n' +
    'static int sqliteExplorerLibmExpr(Walker *pWalker, Expr *pExpr){\n' +
    '  if( pExpr->op==TK_FUNCTION && !ExprHasProperty(pExpr, EP_IntValue) ){\n' +
    '    sqlite3 *db = pWalker->pParse->db;\n' +
    '    int nArg = (ExprUseXList(pExpr) && pExpr->x.pList) ? pExpr->x.pList->nExpr : 0;\n' +
    '    FuncDef *pDef = sqlite3FindFunction(db, pExpr->u.zToken, nArg, ENC(db), 0);\n' +
    '    if( pDef && (pDef->funcFlags & SQLITE_FUNC_LIBM)!=0 ){\n' +
    '      pWalker->eCode |= 1;\n' +
    '      return WRC_Abort;\n' +
    '    }\n' +
    '  }else if( pExpr->op==TK_COLUMN ){\n' +
    '    Table *pTab = pWalker->u.pTab;\n' +
    '    if( pExpr->iColumn>=0 && pExpr->iColumn<pTab->nCol\n' +
    '     && (pTab->aCol[pExpr->iColumn].colFlags & COLFLAG_VIRTUAL)!=0 ){\n' +
    '      pWalker->eCode |= 2;\n' +
    '    }\n' +
    '  }\n' +
    '  return WRC_Continue;\n' +
    '}\n\n' +
    '/*\n' +
    '** SQLite Explorer: true if a generated column of pTab calls a math function.\n' +
    '*/\n' +
    'static int sqliteExplorerGeneratedUsesLibm(Parse *pParse, Table *pTab){\n' +
    '  Walker w;\n' +
    '  int i;\n' +
    '  memset(&w, 0, sizeof(w));\n' +
    '  w.pParse = pParse;\n' +
    '  w.xExprCallback = sqliteExplorerLibmExpr;\n' +
    '  w.u.pTab = pTab;\n' +
    '  for(i=0; i<pTab->nCol && (w.eCode & 1)==0; i++){\n' +
    '    if( pTab->aCol[i].colFlags & COLFLAG_GENERATED ){\n' +
    '      Expr *pExpr = sqlite3ColumnExpr(pTab, &pTab->aCol[i]);\n' +
    '      if( pExpr ) sqlite3WalkExpr(&w, pExpr);\n' +
    '    }\n' +
    '  }\n' +
    '  return (w.eCode & 1)!=0;\n' +
    '}\n\n' +
    '/*\n' +
    '** SQLite Explorer: true if the keys of pIdx, or which rows it holds, depend\n' +
    '** on a math function, whose result this build may round differently from\n' +
    '** the build that wrote the index. That is so when an expression of the\n' +
    '** index or its WHERE calls one, or when the index refers to a VIRTUAL\n' +
    '** column of a table that has a generated column calling one. The second\n' +
    '** test does not follow one generated column into another: treating an\n' +
    '** index as dependent when it is not only costs a scan, and no schema can\n' +
    '** make this walk deeper than one expression.\n' +
    '*/\n' +
    'SQLITE_PRIVATE int sqliteExplorerIndexUsesLibm(Parse *pParse, Index *pIdx){\n' +
    '  Walker w;\n' +
    '  Table *pTab = pIdx->pTable;\n' +
    '  int i;\n' +
    '  if( pIdx->aColExpr==0 && pIdx->pPartIdxWhere==0\n' +
    '   && (pTab->tabFlags & TF_HasVirtual)==0 ) return 0;\n' +
    '  memset(&w, 0, sizeof(w));\n' +
    '  w.pParse = pParse;\n' +
    '  w.xExprCallback = sqliteExplorerLibmExpr;\n' +
    '  w.u.pTab = pTab;\n' +
    '  if( pIdx->pPartIdxWhere ) sqlite3WalkExpr(&w, pIdx->pPartIdxWhere);\n' +
    '  if( pIdx->aColExpr ) sqlite3WalkExprList(&w, pIdx->aColExpr);\n' +
    '  for(i=0; i<pIdx->nKeyCol; i++){\n' +
    '    int iCol = pIdx->aiColumn[i];\n' +
    '    if( iCol>=0 && (pTab->aCol[iCol].colFlags & COLFLAG_VIRTUAL)!=0 ) w.eCode |= 2;\n' +
    '  }\n' +
    '  if( w.eCode & 1 ) return 1;\n' +
    '  if( (w.eCode & 2)==0 ) return 0;\n' +
    '  return sqliteExplorerGeneratedUsesLibm(pParse, pTab);\n' +
    '}\n\n' +
    '/*\n' +
    '** SQLite Explorer: true if a row of pTab stores a value that depends on a\n' +
    '** math function: the table has a STORED generated column, and a generated\n' +
    '** column of the table calls one.\n' +
    '*/\n' +
    'static int sqliteExplorerTableStoresLibm(Parse *pParse, Table *pTab){\n' +
    '  if( (pTab->tabFlags & TF_HasStored)==0 ) return 0;\n' +
    '  return sqliteExplorerGeneratedUsesLibm(pParse, pTab);\n' +
    '}\n\n' +
    'SQLITE_PRIVATE KeyInfo *sqlite3KeyInfoOfIndex(Parse *pParse, Index *pIdx){\n' +
    '  int i;\n  int nCol = pIdx->nColumn;\n  int nKey = pIdx->nKeyCol;\n  KeyInfo *pKey;\n  if( pParse->nErr ) return 0;\n' +
    '  /* SQLite Explorer: every statement that opens an index asks for its\n' +
    '  ** KeyInfo here, to read it or to write it. */\n' +
    '  if( sqliteExplorerIndexUsesLibm(pParse, pIdx) ){\n' +
    '    sqlite3ErrorMsg(pParse, "index %s depends on a math function that this "\n' +
    '        "engine can round differently from the one that wrote it, so it "\n' +
    '        "cannot be read or written here", pIdx->zName);\n' +
    '    return 0;\n' +
    '  }\n'],
  ['  if( tabIsReadOnly(pParse, pTab) ){\n    sqlite3ErrorMsg(pParse, "table %s may not be modified", pTab->zName);\n    return 1;\n  }\n',
    '  if( tabIsReadOnly(pParse, pTab) ){\n    sqlite3ErrorMsg(pParse, "table %s may not be modified", pTab->zName);\n    return 1;\n  }\n' +
    '  /* SQLite Explorer */\n' +
    '  if( !IsVirtual(pTab) && sqliteExplorerTableStoresLibm(pParse, pTab) ){\n' +
    '    sqlite3ErrorMsg(pParse, "table %s stores a generated column that depends on "\n' +
    '        "a math function, which this engine can round differently from the one "\n' +
    '        "that wrote it, so it cannot be modified here", pTab->zName);\n' +
    '    return 1;\n' +
    '  }\n'],
  // The places that pick an index to read, so a query scans instead of failing.
  ['    if( pProbe->bNoQuery ) continue;\n',
    '    if( pProbe->bNoQuery || sqliteExplorerIndexUsesLibm(pWInfo->pParse, pProbe) ) continue;\n'],
  ['      if( !IsUniqueIndex(pIdx)\n       || pIdx->pPartIdxWhere!=0\n       || pIdx->nKeyCol>ArraySize(pLoop->aLTermSpace)\n      ) continue;\n',
    '      if( !IsUniqueIndex(pIdx)\n       || pIdx->pPartIdxWhere!=0\n       || pIdx->nKeyCol>ArraySize(pLoop->aLTermSpace)\n' +
    '       || sqliteExplorerIndexUsesLibm(pWInfo->pParse, pIdx)\n      ) continue;\n'],
  ['          if( pIdx->nColumn<nExpr ) continue;\n          if( pIdx->pPartIdxWhere!=0 ) continue;\n',
    '          if( pIdx->nColumn<nExpr ) continue;\n          if( pIdx->pPartIdxWhere!=0 ) continue;\n' +
    '          if( sqliteExplorerIndexUsesLibm(pParse, pIdx) ) continue;\n'],
  ['            if( pIdx->bUnordered==0\n             && pIdx->szIdxRow<pTab->szTabRow\n             && pIdx->pPartIdxWhere==0\n',
    '            if( pIdx->bUnordered==0\n             && pIdx->szIdxRow<pTab->szTabRow\n             && pIdx->pPartIdxWhere==0\n' +
    '             && !sqliteExplorerIndexUsesLibm(pParse, pIdx)\n'],
  // A unique index proves DISTINCT redundant; one written elsewhere proves it
  // for the values the other library computed.
  ['    if( !IsUniqueIndex(pIdx) ) continue;\n    if( pIdx->pPartIdxWhere ) continue;\n',
    '    if( !IsUniqueIndex(pIdx) ) continue;\n    if( pIdx->pPartIdxWhere ) continue;\n' +
    '    if( sqliteExplorerIndexUsesLibm(pParse, pIdx) ) continue;\n']
];

/** The amalgamation with the changes above; throws when one no longer applies. */
export function patchSqliteMath(source) {
  let patched = source;
  for (const [from, to] of replacements) {
    if (patched.split(from).length !== 2) {
      throw new Error(`SQLite amalgamation no longer has exactly one ${JSON.stringify(from.trim().split('\n')[0])}`);
    }
    patched = patched.replace(from, () => to);
  }
  return patched;
}
