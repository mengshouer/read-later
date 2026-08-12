/**
 * Static rejection of regex sources that can backtrack super-linearly.
 *
 * WHY THIS EXISTS. `utils/filters.ts` compiles author-supplied text into `RegExp` in two places
 * where the source is arbitrary: a `/…/` pattern, and a `/…/` `$removeparam` value. Both are
 * wrapped in `try/catch`, which catches a SYNTAX error and nothing else — a syntactically perfect
 * regex with catastrophic backtracking compiles happily and then hangs at match time. Measured,
 * both of these pass `validateListText`, compile in 1 ms with `active: 1, skipped: 0`, and then
 * fail to return within 15 seconds on an 81-character URL:
 *
 *     $removeparam=/(a+)+z/                     <- 21 characters, and the empty pattern puts it
 *                                                  in `index.always`, so it runs on EVERY save
 *     /(?:a+)+z/$removeparam=fbclid             <- `index.generic`, likewise every save
 *
 * The wildcard sugar had the same problem and is fixed structurally instead (see `PatternMatcher`
 * in `utils/filters.ts`); an author's own regex cannot be, because its source is unconstrained.
 * So the shape is rejected at compile time and REPORTED, which is what this file is.
 *
 * WHY REJECTING IS ACCEPTABLE HERE, given the project's promise that its syntax is a strict
 * subset of uBO's. It is the same KIND of divergence the filter layer already ships and
 * documents: ~56 request-type rules and 21 `$denyallow`-without-`$domain` rules are already
 * declined and surfaced with a reason. A reported decline is idiomatic; a silent neuter is not,
 * which is why the caller files these under `unsupported` — `filters.ts` defines that bucket as
 * "our gap: the line affects the outcome in uBO and we cannot honour it", and this is exactly
 * that. `invalid` would be wrong: it is documented as "malformed", and these rules are not.
 *
 * WHAT THIS IS NOT. It is not a decision procedure, and no hand-written scanner can be — deciding
 * whether a regex has super-linear behaviour is not something to fake. It rejects the high-signal
 * families that are both easy to weaponise and unnecessary for tracking-parameter rules:
 * nested repetition, adjacent variable quantifiers, quantified alternation, and backreferences.
 * There can still be engine-specific slow cases outside those families, and aggregate cost is
 * invisible here: 150,000 individually-harmless rules were measured at 2,387 ms per URL. That is
 * a rule-count problem and needs a different answer.
 *
 * Nesting reached through a lookaround IS caught — `(?=(a+)+z)` is rejected — because a lookaround
 * is walked as an ordinary group once its `(?=` prefix is skipped.
 *
 * FALSE POSITIVES, MEASURED. Against the live AdGuard uBO-flavoured list on 2026-08-12
 * (3,806 lines, 2,509 active rules), the full compiler reported 0 unsupported rules — so this
 * guard rejected nothing in the list. Every regex in
 * `tests/ubo-differential.test.ts` is likewise accepted — `/%20/`, `/=https?:/`, `/^utm_/`,
 * `/utm_/g`, `/utm_/i`, `/^https:\/\/example\.com\/c\d+\/a/`, `/example\.com\/c\d/`.
 */

/**
 * The product of two nested quantifier bounds above which a rule is refused even though both
 * bounds are finite. `(?:a{0,50}){0,50}` is 2,500 steps per starting offset and compiles to
 * something that hangs just as thoroughly as `(a+)+`, so checking only for UNBOUNDED nesting
 * would leave an obvious hole. 1,000 is comfortably above anything a tracking-parameter rule
 * needs and far below where backtracking becomes noticeable.
 */
const MAX_NESTED_PRODUCT = 1000;

const UNBOUNDED = Number.POSITIVE_INFINITY;

interface Bound {
  min: number;
  max: number;
}

/** What a quantifier can attach to. Only a group can carry a quantifier of its own. */
type Atom =
  | { kind: 'simple'; guaranteedConsumes: boolean }
  | {
      kind: 'group';
      innerMax: number;
      hasAlternation: boolean;
      guaranteedConsumes: boolean;
    };

interface GroupFrame {
  innerMax: number;
  hasAlternation: boolean;
  previousVariable: boolean;
  branchConsumes: boolean;
  allBranchesConsume: boolean;
  zeroWidth: boolean;
}

/**
 * Reads a quantifier at `i`, if there is one. Returns its upper bound and the index after it,
 * including a trailing `?` — laziness changes which match is preferred, never the worst-case
 * work, so `(a+?)+?` is treated exactly like `(a+)+`.
 */
function readQuantifier(source: string, i: number): { bound: Bound; next: number } | null {
  const c = source[i];
  if (c === '*') return { bound: { min: 0, max: UNBOUNDED }, next: skipLazy(source, i + 1) };
  if (c === '+') return { bound: { min: 1, max: UNBOUNDED }, next: skipLazy(source, i + 1) };
  if (c === '?') return { bound: { min: 0, max: 1 }, next: skipLazy(source, i + 1) };
  if (c !== '{') return null;
  const close = source.indexOf('}', i);
  if (close < 0) return null;
  const body = source.slice(i + 1, close);
  // `{` that is not a well-formed quantifier is a literal brace in JS regex syntax.
  const m = /^(\d+)(,(\d*)?)?$/.exec(body);
  if (!m) return null;
  const min = Number.parseInt(m[1] as string, 10);
  let max: number;
  if (m[2] === undefined) max = min;
  else if (m[3] === undefined || m[3] === '') max = UNBOUNDED;
  else max = Number.parseInt(m[3], 10);
  return { bound: { min, max }, next: skipLazy(source, close + 1) };
}

function skipLazy(source: string, i: number): number {
  return source[i] === '?' ? i + 1 : i;
}

/**
 * Walks the source once, tracking group nesting, alternatives, minimum consumption and adjacent
 * quantified atoms, and reports the first high-risk construct.
 *
 * `innerMax` on a group frame is the largest VARIABLE quantifier bound seen anywhere inside it,
 * propagated outward when the group closes — so `((a+))+` is caught through the harmless middle
 * group, while `(?:a+)?` is not mistaken for nested repetition because the wrapper runs at most
 * once. A group records whether every alternative must consume input too: only then can it safely
 * separate two quantified atoms, which is why `a*(?:b)a*` is accepted and `a*(?:)a*` is not.
 */
export function findUnsafeRegex(source: string): string | null {
  const stack: GroupFrame[] = [];
  let topInnerMax = 0;
  let topHasAlternation: boolean = false;
  let topBranchConsumes: boolean = false;
  let topAllBranchesConsume: boolean = true;
  let last: Atom | null = null;
  /** Whether the previous atom in this concatenation had a variable quantifier. */
  let previousVariable = false;
  /** Snapshot taken when `last` began, before we know whether `last` is quantified too. */
  let lastFollowsVariable = false;

  const finalizeUnquantifiedAtom = (): void => {
    if (last === null) return;
    // Only an atom that MUST consume input is a separator. Empty groups, lookarounds, anchors and
    // word-boundary assertions must not let `a*(?:)a*` or `a*\ba*` walk around the adjacency guard.
    if (last.guaranteedConsumes) {
      topBranchConsumes = true;
      previousVariable = false;
    }
    last = null;
    lastFollowsVariable = false;
  };

  const beginAtom = (atom: Atom): void => {
    finalizeUnquantifiedAtom();
    lastFollowsVariable = previousVariable;
    last = atom;
  };

  for (let i = 0; i < source.length; ) {
    const c = source[i] as string;

    if (c === '\\') {
      const escaped = source[i + 1];
      // Backreferences make the consumed language depend on a previous capture, which defeats
      // this structural analysis. Refuse them rather than claiming they are one harmless atom.
      if ((escaped !== undefined && escaped >= '1' && escaped <= '9') ||
          (escaped === 'k' && source[i + 2] === '<')) {
        return 'backreference';
      }
      // An escape is one atom, whatever it stands for. Consume the WHOLE escape: treating only
      // `\x` as the atom in `\x61*\x61*` leaves the hex digits looking like mandatory literal
      // separators and lets the exact same `a*a*` ambiguity walk around the adjacency guard.
      let next = i + (i + 1 < source.length ? 2 : 1);
      if (escaped === 'x' && /^[0-9a-f]{2}$/i.test(source.slice(i + 2, i + 4))) {
        next = i + 4;
      } else if (escaped === 'u' && /^[0-9a-f]{4}$/i.test(source.slice(i + 2, i + 6))) {
        next = i + 6;
      } else if (escaped === 'c' && /^[a-z]$/i.test(source[i + 2] ?? '')) {
        next = i + 3;
      } else if (escaped === '0') {
        // No `u` flag is accepted by the filter grammar, so legacy octal escapes still exist.
        while (next < Math.min(source.length, i + 4) && /^[0-7]$/.test(source[next] as string)) next++;
      }
      beginAtom({ kind: 'simple', guaranteedConsumes: escaped !== 'b' && escaped !== 'B' });
      i = next;
      continue;
    }

    if (c === '[') {
      // A character class is one atom and its contents are not syntax we need to look inside.
      let j = i + 1;
      if (source[j] === '^') j++;
      if (source[j] === ']') j++; // a leading `]` is a literal
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      beginAtom({ kind: 'simple', guaranteedConsumes: true });
      i = j < source.length ? j + 1 : j;
      continue;
    }

    if (c === '(') {
      // The group is the next atom in the parent concatenation. Preserve whether it follows a
      // variable quantifier; the decision cannot be made until `)` tells us whether the group is
      // quantified too.
      finalizeUnquantifiedAtom();
      let j = i + 1;
      let zeroWidth = false;
      if (source[j] === '?') {
        j++;
        if (source[j] === ':') j++;
        else if (source[j] === '=' || source[j] === '!') {
          zeroWidth = true;
          j++;
        } else if (source[j] === '<') {
          j++;
          if (source[j] === '=' || source[j] === '!') {
            zeroWidth = true;
            j++;
          } else {
            const close = source.indexOf('>', j);
            j = close < 0 ? source.length : close + 1;
          }
        }
      }
      stack.push({
        innerMax: topInnerMax,
        hasAlternation: topHasAlternation,
        previousVariable,
        branchConsumes: topBranchConsumes,
        allBranchesConsume: topAllBranchesConsume,
        zeroWidth,
      });
      topInnerMax = 0;
      topHasAlternation = false;
      topBranchConsumes = false;
      topAllBranchesConsume = true;
      previousVariable = false;
      last = null;
      lastFollowsVariable = false;
      i = j;
      continue;
    }

    if (c === ')') {
      finalizeUnquantifiedAtom();
      const frame = stack.pop();
      const innerOfClosed: number = topInnerMax;
      const alternationOfClosed: boolean = topHasAlternation;
      const consumesOfClosed: boolean = topAllBranchesConsume && topBranchConsumes;
      // A quantifier inside the group that just closed is also inside its PARENT. Restoring the
      // parent's own count without merging this one lost `((a+))+` — the harmless middle group
      // hid the `+` from the check, and the test caught it.
      topInnerMax = Math.max(frame ? frame.innerMax : 0, innerOfClosed);
      topHasAlternation = (frame?.hasAlternation ?? false) || alternationOfClosed;
      previousVariable = frame?.previousVariable ?? false;
      topBranchConsumes = frame?.branchConsumes ?? false;
      topAllBranchesConsume = frame?.allBranchesConsume ?? true;
      lastFollowsVariable = previousVariable;
      last = {
        kind: 'group',
        innerMax: innerOfClosed,
        hasAlternation: alternationOfClosed,
        guaranteedConsumes: !(frame?.zeroWidth ?? false) && consumesOfClosed,
      };
      i++;
      continue;
    }

    if (c === '|') {
      // A new alternative: nothing before it can be quantified from here.
      finalizeUnquantifiedAtom();
      topHasAlternation = true;
      topAllBranchesConsume = topAllBranchesConsume && topBranchConsumes;
      topBranchConsumes = false;
      previousVariable = false;
      lastFollowsVariable = false;
      i++;
      continue;
    }

    const quant = readQuantifier(source, i);
    if (quant) {
      const variable = quant.bound.min !== quant.bound.max;
      if (last && variable && lastFollowsVariable) {
        return 'adjacent variable quantifiers';
      }
      if (last && last.kind === 'group' && quant.bound.max > 1 && last.hasAlternation) {
        return 'quantified alternation';
      }
      if (last && last.kind === 'group' && quant.bound.max > 1 && last.innerMax > 0) {
        const product = quant.bound.max * last.innerMax;
        if (quant.bound.max === UNBOUNDED && last.innerMax === UNBOUNDED) {
          return 'nested unbounded quantifier';
        }
        if (product > MAX_NESTED_PRODUCT) {
          return `nested quantifier repeats up to ${product === UNBOUNDED ? 'unbounded' : product} times`;
        }
      }
      const guaranteedConsumes = last?.guaranteedConsumes === true && quant.bound.min > 0;
      if (guaranteedConsumes) topBranchConsumes = true;

      // Exact `{1}` is syntax without choice; it cannot make an enclosing repetition ambiguous.
      // Variable `?` still records max=1, so `(a?)+` remains guarded.
      if (variable && quant.bound.max > topInnerMax) topInnerMax = quant.bound.max;
      // A quantifier is not itself an atom; `a**` is a syntax error JS will reject on its own.
      previousVariable = variable ? true : guaranteedConsumes ? false : lastFollowsVariable;
      last = null;
      lastFollowsVariable = false;
      i = quant.next;
      continue;
    }

    beginAtom({ kind: 'simple', guaranteedConsumes: c !== '^' && c !== '$' });
    i++;
  }

  return null;
}
