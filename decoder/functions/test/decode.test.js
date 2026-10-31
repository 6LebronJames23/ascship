const test = require("node:test");
const assert = require("node:assert");
const { decode, validateInput, clean, MODELS } = require("../decode");

const SAMPLE = "Guideline 2.1 - Performance - App Completeness. We were unable to sign in with the demo account provided.";

const fakeClient = (handler) => ({ messages: { create: handler } });

test("rejects short and long input", () => {
  assert.throws(() => validateInput("too short"), { code: "too_short" });
  assert.throws(() => validateInput("x".repeat(7000)), { code: "too_long" });
  assert.throws(() => validateInput(42), { code: "bad_input" });
  assert.equal(validateInput(`  ${SAMPLE}  `), SAMPLE);
});

test("clean drops junk and caps sizes", () => {
  const out = clean({
    guidelines: [{ id: "2.1", name: "App Completeness" }, { name: "no id" }, null],
    fix_steps: ["a", "", 5, "b"],
    difficulty: "nonsense",
    plain_english: "x".repeat(5000),
    needs_new_build: "yes",
  });
  assert.deepEqual(out.guidelines, [{ id: "2.1", name: "App Completeness" }]);
  assert.deepEqual(out.fix_steps, ["a", "b"]);
  assert.equal(out.difficulty, "moderate");
  assert.equal(out.plain_english.length, 1200);
  assert.equal(out.needs_new_build, false);
  assert.equal(out.is_rejection, true);
});

test("decode forces the report tool and returns its input", async () => {
  let seen;
  const client = fakeClient(async (req) => {
    seen = req;
    return { content: [{ type: "tool_use", name: "report", input: { is_rejection: true, guidelines: [{ id: "2.1", name: "App Completeness" }], plain_english: "p", likely_cause: "c", fix_steps: ["s"], needs_new_build: false, difficulty: "quick", reply_to_apple: "r" } }], usage: {} };
  });
  const { result, model } = await decode(client, SAMPLE);
  assert.equal(model, MODELS[0]);
  assert.equal(seen.tool_choice.name, "report");
  assert.match(seen.messages[0].content, /<rejection>/);
  assert.equal(result.guidelines[0].id, "2.1");
});

test("falls back to the next model only on 404", async () => {
  const models = [];
  const client = fakeClient(async (req) => {
    models.push(req.model);
    if (req.model === MODELS[0]) throw Object.assign(new Error("not found"), { status: 404 });
    return { content: [{ type: "tool_use", input: { plain_english: "ok" } }] };
  });
  const { model } = await decode(client, SAMPLE);
  assert.deepEqual(models, MODELS);
  assert.equal(model, MODELS[1]);

  const client2 = fakeClient(async () => { throw Object.assign(new Error("overloaded"), { status: 529 }); });
  await assert.rejects(decode(client2, SAMPLE), { status: 529 });
});
