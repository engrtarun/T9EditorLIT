import assert from "node:assert/strict";
import { test } from "node:test";

import { errorMessage } from "./ipc.ts";

test("errorMessage passes a plain string through unchanged", () => {
  assert.equal(errorMessage("FFmpeg not found on PATH"), "FFmpeg not found on PATH");
});

test("errorMessage unwraps an Error to its message", () => {
  assert.equal(errorMessage(new Error("probe failed")), "probe failed");
});

test("errorMessage stringifies anything else instead of throwing", () => {
  assert.equal(errorMessage(42), "42");
  assert.equal(errorMessage(undefined), "undefined");
  assert.equal(errorMessage({ code: 7 }), "[object Object]");
});
