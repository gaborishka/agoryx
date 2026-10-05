import assert from "node:assert/strict";
import { test } from "node:test";
import { preview, unmark } from "../../ui/src/lib/format.js";

test("unmark takes paired marks out and leaves code characters as written", () => {
  assert.equal(unmark("У `test_calc.py` додав **тести** і ~~старе~~"), "У test_calc.py додав тести і старе");
  assert.equal(unmark("*курсив* і _нахил_, a * b, x > 0, snake_case_name"), "курсив і нахил, a * b, x > 0, snake_case_name");
  assert.equal(unmark("## Заголовок\n> цитата"), "Заголовок\nцитата");
});

test("preview is one line without fences, links' targets or table bars", () => {
  assert.equal(preview("```py\ncode\n```\nпісля [лінк](http://x)"), "після лінк");
  assert.equal(preview("| a | b |\n|---|:-:|\n| 1 | 2 |"), "a b 1 2");
  assert.equal(preview("Оновив `calc_x` і my_var_name у **calc.py**."), "Оновив calc_x і my_var_name у calc.py.");
});
