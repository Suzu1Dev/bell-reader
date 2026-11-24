import test from "node:test";
import assert from "node:assert/strict";
import { parseSimulationHeightMessage } from "../components/InteractiveBlockCard.js";

test("parseSimulationHeightMessage validates source, origin, blockId, token, and clamps height", () => {
  const inlineWin = { id: "inline" };
  const modalWin = { id: "modal" };
  const targets = {
    inlineWin,
    modalWin,
    blockId: "blk-1",
    inlineToken: "tok-inline",
    modalToken: "tok-modal",
    parentOrigin: "http://127.0.0.1:21104",
  };

  assert.deepEqual(
    parseSimulationHeightMessage(
      {
        source: inlineWin,
        origin: "null",
        data: { type: "bell-reader-sim-height", blockId: "blk-1", frameToken: "tok-inline", height: 312.6 },
      },
      targets,
    ),
    { target: "inline", height: 313 },
  );

  assert.deepEqual(
    parseSimulationHeightMessage(
      {
        source: modalWin,
        origin: "http://127.0.0.1:21104",
        data: { type: "bell-reader-sim-height", blockId: "blk-1", frameToken: "tok-modal", height: 540 },
      },
      targets,
    ),
    { target: "modal", height: 540 },
  );

  // Clamping [160, 720]
  assert.deepEqual(
    parseSimulationHeightMessage(
      {
        source: inlineWin,
        origin: "null",
        data: { type: "bell-reader-sim-height", blockId: "blk-1", frameToken: "tok-inline", height: 42 },
      },
      targets,
    ),
    { target: "inline", height: 160 },
  );
  assert.deepEqual(
    parseSimulationHeightMessage(
      {
        source: modalWin,
        origin: "null",
        data: { type: "bell-reader-sim-height", blockId: "blk-1", frameToken: "tok-modal", height: 9999 },
      },
      targets,
    ),
    { target: "modal", height: 720 },
  );

  // Rejects mismatched source, token, blockId, type, origin, or non-finite numbers
  assert.equal(
    parseSimulationHeightMessage(
      {
        source: { id: "other" },
        origin: "null",
        data: { type: "bell-reader-sim-height", blockId: "blk-1", frameToken: "tok-inline", height: 300 },
      },
      targets,
    ),
    null,
  );
  assert.equal(
    parseSimulationHeightMessage(
      {
        source: inlineWin,
        origin: "null",
        data: { type: "bell-reader-sim-height", blockId: "blk-1", frameToken: "tok-modal", height: 300 },
      },
      targets,
    ),
    null,
  );
  assert.equal(
    parseSimulationHeightMessage(
      {
        source: inlineWin,
        origin: "null",
        data: { type: "bell-reader-sim-height", blockId: "blk-2", frameToken: "tok-inline", height: 300 },
      },
      targets,
    ),
    null,
  );
  assert.equal(
    parseSimulationHeightMessage(
      {
        source: inlineWin,
        origin: "https://evil.example",
        data: { type: "bell-reader-sim-height", blockId: "blk-1", frameToken: "tok-inline", height: 300 },
      },
      targets,
    ),
    null,
  );
  assert.equal(
    parseSimulationHeightMessage(
      {
        source: inlineWin,
        origin: "null",
        data: { type: "other-event", blockId: "blk-1", frameToken: "tok-inline", height: 300 },
      },
      targets,
    ),
    null,
  );
  for (const badHeight of [NaN, Infinity, -Infinity, "300", null]) {
    assert.equal(
      parseSimulationHeightMessage(
        {
          source: inlineWin,
          origin: "null",
          data: { type: "bell-reader-sim-height", blockId: "blk-1", frameToken: "tok-inline", height: badHeight },
        },
        targets,
      ),
      null,
    );
  }
});
