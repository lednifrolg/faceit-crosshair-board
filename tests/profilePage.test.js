// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/* profilePage.js is a classic content script, not a module: run it the way Chrome does,
 * in a fresh global scope, and take the API it publishes on globalThis. Running it in a
 * bare context also proves it needs nothing from the browser or from node. */
const source = readFileSync(new URL("../src/content/profilePage.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "profilePage.js" });
const { PROFILE_PATH, Phase, ERROR_TEXT, profileNickname, findPlayer, errorText, buttonView } =
  context.FcbProfilePage;

test("profileNickname: profile overview, subpages and modal", () => {
  assert.equal(profileNickname("/en/players/donk666"), "donk666");
  assert.equal(profileNickname("/en/players/donk666/"), "donk666");
  assert.equal(profileNickname("/en/players/donk666/cs2/history"), "donk666");
  assert.equal(profileNickname("/en/players/donk666/stats/cs2"), "donk666");
  assert.equal(profileNickname("/de/players-modal/ZywOo"), "ZywOo");
  assert.equal(profileNickname("/players/s1mple"), "s1mple");
});

test("profileNickname: keeps the exact case, decodes escapes", () => {
  assert.equal(profileNickname("/en/players/ScreaM"), "ScreaM");
  assert.equal(profileNickname("/en/players/scream"), "scream");
  assert.equal(profileNickname("/en/players/-%5BS%5D-"), "-[S]-");
});

test("profileNickname: null off a profile", () => {
  for (const path of [
    "/", "/en", "/en/home", "/en/players", "/en/players/", "/en/cs2/room/1-abc",
    "/en/playersX/donk666", "/en/teams/abc", "", null, undefined,
  ]) {
    assert.equal(profileNickname(path), null, String(path));
  }
});

test("profileNickname: a malformed escape is not a profile", () => {
  assert.equal(profileNickname("/en/players/%E0%A4%A"), null);
});

test("PROFILE_PATH agrees with profileNickname", () => {
  assert.equal(PROFILE_PATH.test("/en/players/donk666/cs2/history"), true);
  assert.equal(PROFILE_PATH.test("/en/home"), false);
});

const DONK = { id: "a1", nickname: "donk666" };
const SCREAM_UPPER = { id: "b2", nickname: "ScreaM" };
const PLAYERS = [DONK, SCREAM_UPPER];

test("findPlayer: by id once known, ignoring the nickname", () => {
  assert.equal(findPlayer(PLAYERS, { id: "a1", nickname: "donk666" }), DONK);
  // Renamed on FACEIT, the board still has the old nickname until the daily check.
  assert.equal(findPlayer(PLAYERS, { id: "a1", nickname: "donk_new" }), DONK);
  // Someone else took a freed nickname: same nickname, different id, not on the board.
  assert.equal(findPlayer(PLAYERS, { id: "zz", nickname: "donk666" }), null);
});

test("findPlayer: by exact, case-sensitive nickname while the id is unknown", () => {
  assert.equal(findPlayer(PLAYERS, { nickname: "ScreaM" }), SCREAM_UPPER);
  assert.equal(findPlayer(PLAYERS, { id: null, nickname: "scream" }), null);
  assert.equal(findPlayer(PLAYERS, { nickname: "DONK666" }), null);
});

test("findPlayer: tolerates missing or odd input", () => {
  assert.equal(findPlayer(undefined, { nickname: "donk666" }), null);
  assert.equal(findPlayer([], { id: "a1" }), null);
  assert.equal(findPlayer([null, DONK], { id: "a1" }), DONK);
  assert.equal(findPlayer(PLAYERS, {}), null);
  assert.equal(findPlayer(PLAYERS), null);
});

test("errorText: every add/remove error kind has a short label", () => {
  for (const kind of ["not_found", "challenge", "rate_limited", "network", "invalidated"]) {
    assert.ok(ERROR_TEXT[kind], kind);
    assert.ok(errorText(kind).length <= 20, kind); // fits the corner button
  }
  assert.equal(errorText("not_found"), "PLAYER NOT FOUND");
  assert.equal(errorText("http"), "FAILED, RETRY");
  assert.equal(errorText(undefined), "FAILED, RETRY");
});

test("buttonView: idle states and the remove preview", () => {
  const pick = ({ mark, text, tone }) => ({ mark, text, tone });
  assert.deepEqual(pick(buttonView({ onBoard: false })), { mark: "+", text: "ADD TO BOARD", tone: "add" });
  assert.deepEqual(pick(buttonView({ onBoard: false, hover: true })), { mark: "+", text: "ADD TO BOARD", tone: "add" });
  assert.deepEqual(pick(buttonView({ onBoard: true })), { mark: "✓", text: "ON BOARD", tone: "on" });
  assert.deepEqual(pick(buttonView({ onBoard: true, hover: true })), { mark: "x", text: "REMOVE", tone: "remove" });
  assert.deepEqual(pick(buttonView()), { mark: "+", text: "ADD TO BOARD", tone: "add" });
});

test("buttonView: busy and error states", () => {
  // Spread: objects from the vm context have that context's Object.prototype.
  const view = (opts) => ({ ...buttonView(opts) });
  assert.deepEqual(view({ phase: Phase.ADDING, onBoard: false }), { mark: "_", text: "ADDING", tone: "busy", busy: true });
  assert.deepEqual(view({ phase: Phase.REMOVING, onBoard: true, hover: true }), { mark: "_", text: "REMOVING", tone: "busy", busy: true });
  assert.deepEqual(view({ phase: Phase.ERROR, error: "rate_limited" }), { mark: "!", text: "RATE LIMITED, RETRY", tone: "error", busy: false });
});

// Built from its code point so this file doesn't contain the character it forbids.
const EM_DASH = String.fromCharCode(0x2014);

test("no em dash in the profile button sources", () => {
  const files = ["profilePage.js", "profileButton.js", "profileButton.css"].map((f) => `../src/content/${f}`);
  for (const file of [...files, "./profilePage.test.js"]) {
    assert.equal(readFileSync(new URL(file, import.meta.url), "utf8").includes(EM_DASH), false, file);
  }
});
