import test from "node:test";
import assert from "node:assert/strict";
import { allowedSuiteRoute, parseReaderHandoff, prDraftHref } from "../../shared/suite.js";

test("SUITE_ROUTES.pr supports all 11 BELL PR routes and rejects unallowed paths", () => {
  for (const route of [
    "#/",
    "#/home",
    "#/demo",
    "#/repos",
    "#/repos/bell-reader",
    "#/discover",
    "#/team",
    "#/group",
    "#/learning",
    "#/settings",
    "#/runs/run_123",
  ]) {
    assert.equal(allowedSuiteRoute("pr", route), true, route);
  }
  for (const bad of ["#/runs/", "#/runs/..", "#/repos/a/b", "#/discover?draft=x", "#/unknown"]) {
    assert.equal(allowedSuiteRoute("pr", bad), false, bad);
  }
});

test("BELL PR two-way handoffs validate back routes and build #/discover draft links", () => {
  const links = { pr: "http://127.0.0.1:4603" };
  const incoming = parseReaderHandoff("#/read?text=Read+spec&title=Spec&from=pr&back=%23%2Fruns%2Frun_42", links);
  assert.equal(incoming.present, true);
  if (incoming.present && incoming.draft) {
    assert.equal(incoming.draft.from, "pr");
    assert.equal(incoming.draft.text, "Read spec");
    assert.equal(incoming.draft.title, "Spec");
    assert.equal(incoming.draft.backUrl, "http://127.0.0.1:4603/#/runs/run_42");
  }

  const outgoing = prDraftHref(links.pr, {
    draft: "Fix anchor calculation",
    title: "Ink anchor bug",
    back: "#/page/page_7",
  });
  assert.ok(outgoing?.startsWith("http://127.0.0.1:4603/#/discover?"));
  const params = new URLSearchParams(outgoing!.split("?")[1]);
  assert.equal(params.get("draft"), "Fix anchor calculation");
  assert.equal(params.get("title"), "Ink anchor bug");
  assert.equal(params.get("from"), "reader");
  assert.equal(params.get("back"), "#/page/page_7");
  assert.equal(prDraftHref(undefined, { draft: "x" }), undefined);
});
