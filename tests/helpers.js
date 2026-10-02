// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createStore } from "../src/lib/store.js";

export const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export const json = (name) => JSON.parse(fixture(name));

/**
 * A fetch stand-in. `routes` maps an API path to a response spec, or is a function
 * `(path) => spec | Promise<spec>`; a spec is `{ status, headers, body }`, an Error to
 * reject with, or `{ hang: true }` for a request that never answers (it still rejects
 * when its signal aborts, as real fetch does). Records every request.
 */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const path = url.replace("https://www.faceit.com/api", "");
    calls.push({ url, path, init });
    const route = await (typeof routes === "function" ? routes(path) : routes[path]);
    if (!route) throw new Error(`unexpected request ${path}`);
    if (route instanceof Error) throw route;
    if (route.hang) {
      return new Promise((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const { status = 200, headers = { "content-type": "application/json" }, body } = route;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { impl, calls };
}

/** In-memory StorageArea with the get/set semantics of chrome.storage. */
export function memoryArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : [].concat(keys);
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
  };
}

export function memoryStore(sync = {}, local = {}) {
  const areas = { sync: memoryArea(sync), local: memoryArea(local) };
  return { areas, store: createStore(areas) };
}
