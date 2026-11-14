import { contextValue } from './template.js';
import { compileSafeRegex, SafeRegexError, type SafeRegex } from '../triggers/safe-regex.js';
import { REGEX_FILTER_BUDGET, REGEX_SUBJECT_MAX } from '../triggers/filter.js';

/**
 * Longest expression, and longest pattern a `matches` accepts from the run
 * context: the tokenizer and the regex parser are linear, but a megabyte
 * string handed to them on every edge evaluation is still a cheap DoS.
 */
export const MAX_EXPR_LENGTH = 2000;

/**
 * `matches` never reaches V8's backtracking `RegExp`: a condition runs
 * synchronously on the daemon loop, and `^(a+)+$` on a crafted value would
 * freeze every account. The linear engine of trigger filters runs instead;
 * patterns it refuses (backreferences, lookarounds, named groups) throw, like
 * an invalid pattern always did.
 *
 * One evaluation may spend the work a trigger filter may spend on one call:
 * its subject cap times its program budget. The subject is NOT truncated to
 * that cap: cutting `aaa…b` before the `b` turns `^a+$` true. A small pattern
 * reads a long agent output whole; work beyond the budget throws instead of
 * answering wrong.
 */
const MATCHES_WORK_BUDGET = REGEX_SUBJECT_MAX * (3 * REGEX_FILTER_BUDGET + 1);
const compiled = new Map<string, SafeRegex>();
function regexFor(pattern: string): SafeRegex {
  let re = compiled.get(pattern);
  if (!re) {
    if (pattern.length > MAX_EXPR_LENGTH) throw new SafeRegexError(`pattern longer than ${MAX_EXPR_LENGTH} characters`);
    re = compileSafeRegex(pattern);
    if (compiled.size >= 500) compiled.clear();
    compiled.set(pattern, re);
  }
  return re;
}

/** Shared by evaluation and save-time checks: one meaning for a literal. */
function literal(token: string): string {
  return JSON.parse(token[0] === "'" ? '"' + token.slice(1, -1).replace(/"/g, '\\"') + '"' : token) as string;
}
// Identifiers admit `-` (the builder names nodes `agent-1`): the grammar has no arithmetic, so no valid expression relied on `-` ending one.
// A keyword only matches when no identifier char follows, so a node named `not-1` or `true-x` stays an identifier.
type Token=string; const re=/\s*(>=|<=|==|!=|>|<|\(|\)|(?:contains|matches|exists|and|or|not|true|false|null)(?![\w.-])|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z][\w.-]*)\s*/gy;
function tokens(s:string){if(s.length>MAX_EXPR_LENGTH)throw new Error(`expression longer than ${MAX_EXPR_LENGTH} characters`);const r:Token[]=[];let i=0;while(i<s.length){re.lastIndex=i;const m=re.exec(s);if(!m || !m[1])throw new Error(`invalid expression token at ${i}`);r.push(m[1]);i=re.lastIndex;}return r;}
export function evaluateExpr(source:string,ctx:unknown):boolean { const t=tokens(source);let i=0;let work=MATCHES_WORK_BUDGET;const matches=(a:unknown,b:unknown):boolean=>{const re=regexFor(String(b));const subject=String(a);work-=(subject.length+2)*(3*re.size+1);if(work<0)throw new SafeRegexError(`matches would exceed the work one expression may spend (subject of ${subject.length} characters)`);return re.test(subject);};const atom=():unknown=>{const x=t[i++];if(x===undefined)throw new Error('unexpected end');if(x==='('){const v=or();if(t[i++]!==')')throw new Error('missing )');return v;}if(x==='true')return true;if(x==='false')return false;if(x==='null')return null;if(/^['"]/.test(x))return literal(x);if(/^-?\d/.test(x))return Number(x);return contextValue(ctx,x);};const cmp=():boolean=>{if(t[i]==='exists'){i++;return atom()!==undefined;}const a=atom();const op=t[i];if(!op || !['==','!=','<','<=','>','>=','contains','matches'].includes(op))return Boolean(a);i++;const b=atom();if(op==='==')return a===b;if(op==='!=')return a!==b;if(op==='contains')return Array.isArray(a)?a.includes(b):String(a).includes(String(b));if(op==='matches')return matches(a,b);if(op==='<')return (a as number)<(b as number);if(op==='<=')return (a as number)<=(b as number);if(op==='>')return (a as number)>(b as number);return (a as number)>=(b as number);};const not=():boolean=>t[i]==='not'?(i++,!not()):cmp();const and=():boolean=>{let v=not();while(t[i]==='and'){i++;v=not()&&v;}return v;};const or=():boolean=>{let v=and();while(t[i]==='or'){i++;v=and()||v;}return v;};const out=or();if(i!==t.length)throw new Error('unexpected token');return out; }

/**
 * Save-time check of every literal `matches` pattern of an expression: a
 * refused pattern is reported when the workflow is saved, not when a run
 * reaches it. A pattern read from the run context is only checked at run.
 * Returns the reason of the first refusal, or null.
 */
export function refusedMatchesPattern(source: string): string | null {
  if (source.length > MAX_EXPR_LENGTH) return `expression longer than ${MAX_EXPR_LENGTH} characters`;
  // A malformed expression was always saved and reported at run: unchanged.
  let t: Token[];
  try { t = tokens(source); } catch { return null; }
  for (let k = 0; k < t.length - 1; k++) {
    const next = t[k + 1]!;
    if (t[k] !== 'matches' || !/^['"]/.test(next)) continue;
    try {
      regexFor(literal(next));
    } catch (err) {
      return err instanceof SafeRegexError ? `matches pattern refused: ${err.message}` : 'matches pattern is not a valid string literal';
    }
  }
  return null;
}
