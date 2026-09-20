/*
 * index_ruler_test.js -- tests for web/src/lib/index_ruler.js, the logic behind the sub bar's
 * index-gear ruler (T-0192): which ticks are big, which teeth a facet is cut at under a symmetry
 * and an offset, and which ticks a scrolled ruler draws.
 *
 * HOW TO RUN (from web/): deno test --allow-read --allow-env tests/   (also `deno task test`)
 *
 * The drawing, dragging and snapping are exercised against the built page over CDP instead
 * (see T-0192's log), since they need a browser.
 */

import {
  wrapIndex, bigTickStep, symmetryFits, highlightedIndices, labelledIndices, visibleTicks,
  parseIndexList,
  symmetryFromIndices, enterArbitraryMode, enterSymmetricMode, CANNOT_CONVERT, rulerIndex,
  rulerSymmetry, rulerOffset, indexMode, arbitraryIndices,
} from "../src/lib/index_ruler.js";
import { get } from "svelte/store";

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

Deno.test("the big-tick step is the smallest divisor of the gear greater than 4", () => {
  // Setup: the user's two worked examples, plus gears whose smallest divisor above 4 is not the
  // first one tried, and gears with none short of the count itself.
  // Test: bigTickStep for each.
  // Verifies: 80 -> 5 and 96 -> 6 exactly as the user stated; 64 -> 8 (it skips 5, 6 and 7, none
  // of which divide 64); 72 -> 6; 120 -> 5; a prime gear (97) and a 4-tooth gear fall back to the
  // count itself, so only index 0 is a big tick rather than every tick or none.
  assertEqual(bigTickStep(80), 5, "80 teeth");
  assertEqual(bigTickStep(96), 6, "96 teeth");
  assertEqual(bigTickStep(64), 8, "64 teeth");
  assertEqual(bigTickStep(72), 6, "72 teeth");
  assertEqual(bigTickStep(120), 5, "120 teeth");
  assertEqual(bigTickStep(97), 97, "a prime gear");
  assertEqual(bigTickStep(4), 4, "a 4-tooth gear");
});

Deno.test("indices wrap around the gear in both directions", () => {
  // Setup: a 96-tooth gear. Test: wrapIndex on values past either end and on a whole turn.
  // Verifies: the tooth after 95 is 0, the tooth before 0 is 95, and several turns away land on
  // the same tooth, which is what lets the ruler scroll forever in either direction.
  assertEqual(wrapIndex(96, 96), 0, "one past the last tooth");
  assertEqual(wrapIndex(-1, 96), 95, "one before the first tooth");
  assertEqual(wrapIndex(-193, 96), 95, "two turns and one tooth back");
  assertEqual(wrapIndex(250, 96), 58, "two turns and 58 teeth on");
});

Deno.test("a symmetry fits only when it divides the gear", () => {
  // Setup: a 96-tooth gear. Test: symmetryFits on divisors, non-divisors and nonsense.
  // Verifies: 1, 4, 6 and 96 fit (every copy lands on a whole tooth); 5 and 7 do not (their copies
  // would sit between teeth, which needs the fractional-teeth opt-in); 0, a negative count, a
  // fraction and more copies than teeth are all refused.
  for (const symmetry of [1, 4, 6, 96]) {
    assertEqual(symmetryFits(symmetry, 96), true, `symmetry ${symmetry}`);
  }

  for (const symmetry of [5, 7, 0, -4, 2.5, 192]) {
    assertEqual(symmetryFits(symmetry, 96), false, `symmetry ${symmetry}`);
  }
});

Deno.test("symmetry spreads copies equally and an offset adds one beside each", () => {
  // Setup: the user's own example, symmetry 4 on a 96-tooth gear with the facet on index 0,
  // first with no offset and then with offset 2.
  // Test: highlightedIndices.
  // Verifies: symmetry 4 alone cuts 0, 24, 48 and 72 (four copies equally spaced around the
  // stone); offset 2 adds a copy 2 teeth on from each ("a symmetry on index 0 will have another
  // symmetry on index 2"), eight teeth in all, sorted.
  assertEqual(highlightedIndices(0, 96, 4, 0), [0, 24, 48, 72], "symmetry 4, no offset");
  assertEqual(highlightedIndices(0, 96, 4, 2), [0, 2, 24, 26, 48, 50, 72, 74], "symmetry 4, offset 2");
});

Deno.test("copies wrap past the last tooth, and coinciding copies are listed once", () => {
  // Setup: copies that run past tooth 95, a negative offset, and an offset of exactly one
  // symmetry step (which lands each offset copy on the next symmetry copy).
  // Test: highlightedIndices.
  // Verifies: index 90 with symmetry 2 and offset 10 cuts 90, 100 -> 4, 42 and 52 (wrapped, not
  // off the end); a negative offset goes the other way round; an offset of 24 with symmetry 4
  // adds nothing new, so the list has 4 entries, not 8 with repeats.
  assertEqual(highlightedIndices(90, 96, 2, 10), [4, 42, 52, 90], "wrapping");
  assertEqual(highlightedIndices(1, 96, 1, -3), [1, 94], "a negative offset");
  assertEqual(highlightedIndices(0, 96, 4, 24), [0, 24, 48, 72], "an offset of one symmetry step");
});

Deno.test("a scrolled ruler draws every tooth in view, wrapped, with the big ones marked", () => {
  // Setup: a 96-tooth ruler set to index 1, showing 3 teeth either side of the centre.
  // Test: visibleTicks.
  // Verifies: it draws teeth 94, 95, 0, 1, 2, 3, 4 (wrapping back past 0 on the left), each at
  // its offset from the centre in teeth, and only index 0 is big (the step is 6, so 6 is out of
  // view). Then, half a tooth into a drag (position 1.5), the ticks sit at half-tooth offsets,
  // which is what makes the tape move smoothly under the pointer between snaps.
  assertEqual(
    visibleTicks(1, 3, 96).map(t => [t.offset, t.index, t.big]),
    [[-3, 94, false], [-2, 95, false], [-1, 0, true], [0, 1, false], [1, 2, false], [2, 3, false], [3, 4, false]],
    "set to index 1",
  );
  assertEqual(
    visibleTicks(1.5, 1, 96).map(t => [t.offset, t.index]),
    [[-0.5, 1], [0.5, 2]],
    "half a tooth into a drag",
  );
});

Deno.test("only the facet's own tooth and its offset tooth are numbered", () => {
  // Setup: the user's example again, index 5 with symmetry 4 on a 96-tooth gear, with no offset
  // and with offsets of 2, -3 and a whole turn.
  // Test: labelledIndices, against highlightedIndices for the same setting.
  // Verifies: only the facet's own tooth is numbered when there is no offset, and its offset
  // tooth as well when there is one (the user, 2026-09-19: "too many numbers is confusing"),
  // while the symmetry copies stay highlighted -- 5 and 7 are numbered where 8 teeth are lit.
  // A negative offset wraps, and an offset of a whole turn is the tooth itself, numbered once.
  assertEqual(labelledIndices(5, 96, 0), [5], "no offset");
  assertEqual(labelledIndices(5, 96, 2), [5, 7], "offset 2");
  assertEqual(labelledIndices(1, 96, -3), [1, 94], "a negative offset wraps");
  assertEqual(labelledIndices(5, 96, 96), [5], "an offset of a whole turn");
  assertEqual(highlightedIndices(5, 96, 4, 2).length, 8, "the copies are still highlighted");
});

Deno.test("arbitrary mode reads indexes typed with dashes, commas or spaces", () => {
  // Setup: a 96-tooth gear, and the ways a cutter might type a list: the cutting table's own
  // dashes, commas, spaces, a mixture, stray separators at the ends, and a repeat.
  // Test: parseIndexList with fractional teeth off.
  // Verifies: every form gives the same indexes in the order typed, with no error; an empty box
  // is simply no indexes; a repeated index is kept once.
  const expected = { indices: [4, 12, 20], error: null };
  assertEqual(parseIndexList("4-12-20", 96, false), expected, "dashes");
  assertEqual(parseIndexList("4, 12, 20", 96, false), expected, "commas");
  assertEqual(parseIndexList("4 12 20", 96, false), expected, "spaces");
  assertEqual(parseIndexList(" -4 -12,20, ", 96, false), expected, "mixed, with stray separators");
  assertEqual(parseIndexList("4-12-4-20", 96, false), expected, "a repeat");
  assertEqual(parseIndexList("", 96, false), { indices: [], error: null }, "an empty box");
});

Deno.test("arbitrary mode refuses an index that is not on the gear", () => {
  // Setup: a 96-tooth gear.
  // Test: parseIndexList on a word, an index past the last tooth, and a fraction, the last with
  // fractional teeth off and then on.
  // Verifies: each refusal names the entry and says why (the text the sub bar shows in red);
  // 96 is refused because the last tooth is 95; 12.5 is refused only while fractional teeth are
  // off, and accepted as 12.5 when they are on.
  assertEqual(parseIndexList("4-x-20", 96, false).error, '"x" is not an index.', "a word");
  assertEqual(parseIndexList("4-96", 96, false).error,
    "96 is past the last tooth of the 96-tooth gear (95).", "past the last tooth");
  assertEqual(parseIndexList("12.5", 96, false).error,
    "12.5 is between teeth. Turn on fractional teeth in the gear dialog to allow it.", "a fraction, off");
  assertEqual(parseIndexList("12.5", 96, true), { indices: [12.5], error: null }, "a fraction, on");
});

Deno.test("an arbitrary list reads as symmetric by the user's four rules", () => {
  // Setup: lists on a 96-tooth gear, one for each of the user's rules (2026-09-19), typed out of
  // order to show the smallest index is taken as the starting facet whatever order they came in.
  // Test: symmetryFromIndices.
  // Verifies:
  //   rules 1 and 2 -- a single index is symmetry 1, offset 0, starting on itself;
  //   rule 3 -- 72-0-48-24 has every gap 24, counting 72 round to 0, so it is symmetry 4 from 0;
  //     the same holds for a set that does not start at 0 (10-34-58-82) and for a pair half a
  //     turn apart;
  //   rule 4 -- 0-2-24-26-48-50-72-74 (the user's own symmetry 4, offset 2 example) comes back as
  //     exactly that: the 1st, 3rd, 5th and 7th are 24 apart round the gear and each 2nd, 4th,
  //     6th and 8th is 2 on from the one before; two indexes not half a turn apart are symmetry 1
  //     with their distance as the offset.
  assertEqual(symmetryFromIndices([17], 96), { index: 17, symmetry: 1, offset: 0 }, "one index");
  assertEqual(symmetryFromIndices([72, 0, 48, 24], 96), { index: 0, symmetry: 4, offset: 0 },
    "equal gaps from 0");
  assertEqual(symmetryFromIndices([82, 10, 58, 34], 96), { index: 10, symmetry: 4, offset: 0 },
    "equal gaps from 10");
  assertEqual(symmetryFromIndices([5, 53], 96), { index: 5, symmetry: 2, offset: 0 }, "a pair");
  assertEqual(symmetryFromIndices([74, 0, 2, 24, 26, 48, 50, 72], 96),
    { index: 0, symmetry: 4, offset: 2 }, "symmetry 4, offset 2");
  assertEqual(symmetryFromIndices([4, 12], 96), { index: 4, symmetry: 1, offset: 8 },
    "a pair not half a turn apart");
});

Deno.test("the ruler's own highlights always read back as the same facet set", () => {
  // Setup: every index, symmetry that fits and a spread of offsets on a 96-tooth gear, including
  // offsets past half a symmetry step and negative ones, where the smallest tooth highlighted is
  // an offset copy rather than the index the ruler was set to.
  // Test: highlightedIndices, then symmetryFromIndices on the result, then highlightedIndices on
  // what that found.
  // Verifies: the round trip symmetric -> arbitrary -> symmetric never refuses a list the ruler
  // itself produced, and lands on the very same teeth (the starting index and offset may be named
  // differently: 10 with offset 20 on symmetry 4 is the same set as 6 with offset 4).
  for (const symmetry of [1, 2, 3, 4, 6, 8, 12, 24, 48]) {
    for (const offset of [0, 1, 2, 5, 11, 20, -3]) {
      for (let index = 0; index < 96; index++) {
        const teeth = highlightedIndices(index, 96, symmetry, offset);
        const found = symmetryFromIndices(teeth, 96);
        const label = `index ${index}, symmetry ${symmetry}, offset ${offset}`;

        if (found === null) {
          throw new Error(`${label}: ${teeth.join("-")} refused`);
        }

        assertEqual(highlightedIndices(found.index, 96, found.symmetry, found.offset), teeth, label);
      }
    }
  }
});

Deno.test("an arbitrary list with no symmetric form is refused", () => {
  // Setup: lists on a 96-tooth gear that break each rule.
  // Test: symmetryFromIndices.
  // Verifies: null (the gear dialog's "cannot convert" refusal) for an odd count with unequal
  // gaps (0-10-30), four indexes whose 1st and 3rd are not half a turn apart (0-2-40-42), four
  // whose offsets differ (0-2-48-51), an empty list or the null a refused text box leaves, and a
  // fractional list, which the ruler cannot show since it holds whole teeth.
  assertEqual(symmetryFromIndices([0, 10, 30], 96), null, "an odd count, unequal gaps");
  assertEqual(symmetryFromIndices([0, 2, 40, 42], 96), null, "bases not equally spaced");
  assertEqual(symmetryFromIndices([0, 2, 48, 51], 96), null, "offsets differ");
  assertEqual(symmetryFromIndices([], 96), null, "no indexes");
  assertEqual(symmetryFromIndices(null, 96), null, "a refused text box");
  assertEqual(symmetryFromIndices([0.5, 48.5], 96), null, "between teeth");
});

Deno.test("switching modes carries the facet's indexes across, or refuses and changes nothing", () => {
  // Setup: the ruler at index 3, symmetry 4, offset 2 on a 96-tooth gear, in symmetric mode.
  // Test: enterArbitraryMode, then a symmetric list typed and enterSymmetricMode, then a list with
  // no symmetric form and enterSymmetricMode again.
  // Verifies: arbitrary mode starts from exactly the ruler's highlighted teeth; switching back
  // sets the ruler from the typed list (0-48 -> index 0, symmetry 2, offset 0); a list that
  // cannot convert returns the user's refusal message and leaves the mode and ruler as they were.
  rulerIndex.set(3);
  rulerSymmetry.set(4);
  rulerOffset.set(2);
  indexMode.set("symmetric");

  enterArbitraryMode(96);
  assertEqual(get(indexMode), "arbitrary", "mode after entering arbitrary");
  assertEqual(get(arbitraryIndices), [3, 5, 27, 29, 51, 53, 75, 77], "the ruler's teeth");

  arbitraryIndices.set([48, 0]);
  assertEqual(enterSymmetricMode(96), null, "a symmetric list converts");
  assertEqual([get(indexMode), get(rulerIndex), get(rulerSymmetry), get(rulerOffset)],
    ["symmetric", 0, 2, 0], "the ruler set from the list");

  indexMode.set("arbitrary");
  arbitraryIndices.set([0, 10, 30]);
  assertEqual(enterSymmetricMode(96), CANNOT_CONVERT, "the refusal");
  assertEqual([get(indexMode), get(rulerIndex), get(rulerSymmetry), get(rulerOffset)],
    ["arbitrary", 0, 2, 0], "nothing changed");
});
