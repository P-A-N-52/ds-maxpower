import assert from "node:assert/strict";
import test from "node:test";
import { makeCalibrationFixtures, makeFixture, makeFixtures, scoreAnswer } from "./fixtures.mjs";

function parseGraph(context) {
	const lines = context.split("GRAPH:\n")[1].trim().split("\n");
	const graph = new Map();
	for (const line of lines) {
		const match = /^(n[0-9a-f]{8}) -> (n[0-9a-f]{8}), (n[0-9a-f]{8})$/.exec(line);
		assert.ok(match, `Malformed graph row: ${line}`);
		assert.ok(!graph.has(match[1]), "Source identifiers must be unique");
		assert.notEqual(match[2], match[3], "Outgoing edges must be unique");
		graph.set(match[1], [match[2], match[3]]);
	}
	for (const outgoing of graph.values()) {
		for (const node of outgoing) assert.ok(graph.has(node), "Every edge must reference a listed node");
	}
	return graph;
}

function shortestDistances(graph, source) {
	const distances = new Map([[source, 0]]);
	const queue = [source];
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const current = queue[cursor];
		for (const next of graph.get(current)) {
			if (distances.has(next)) continue;
			distances.set(next, distances.get(current) + 1);
			queue.push(next);
		}
	}
	return distances;
}

function oracle(fixture, graph) {
	if (fixture.kind === "parents") {
		return [...graph].filter(([, outgoing]) => outgoing.includes(fixture.metadata.queryNode)).map(([node]) => node).sort();
	}
	return [...shortestDistances(graph, fixture.metadata.queryNode)]
		.filter(([, distance]) => distance === fixture.metadata.distance)
		.map(([node]) => node)
		.sort();
}

test("all real long fixtures have unique graph records and independently verified answers", () => {
	const fixtures = makeFixtures();
	assert.equal(fixtures.length, 4);
	assert.equal(new Set(fixtures.map((fixture) => fixture.id)).size, 4);
	for (const fixture of fixtures) {
		const graph = parseGraph(fixture.context);
		assert.equal(graph.size, fixture.metadata.nodeCount);
		assert.deepEqual(oracle(fixture, graph), fixture.expected);
		assert.equal(fixture.expected.length, fixture.metadata.expectedCount);
		assert.equal(fixture.metadata.contextChars, fixture.context.length);
		assert.equal(fixture.metadata.edgeCount, graph.size * 2);
		assert.ok(fixture.context.length >= (fixture.id.includes("300k") ? 300_000 : 120_000));
		assert.ok(/^[\x00-\x7f]*$/.test(fixture.context), "Graph must be ASCII");
		assert.ok(!fixture.context.includes("Final Answer"));
		assert.ok(!fixture.context.includes("distance exactly"));
	}
	const conservativeInput = fixtures.reduce((total, fixture) => total + fixture.metadata.conservativeEstimatedTokens * 4, 0);
	assert.ok(conservativeInput < 1_700_000, "Leave input budget for questions and shared traces");
});

test("fixed seeds reproduce byte-identical contexts, questions, metadata and answers", () => {
	assert.deepEqual(makeFixtures(), makeFixtures());
	const options = { kind: "parents", seed: 7, nodeCount: 80, parentCount: 12 };
	assert.notEqual(makeFixture(options).context, makeFixture({ ...options, seed: 8 }).context);
});

test("capacity-calibration fixtures have independent correct oracles and fixed separate seeds", () => {
	assert.deepEqual(makeCalibrationFixtures(), makeCalibrationFixtures());
	for (const fixture of makeCalibrationFixtures()) {
		assert.deepEqual(oracle(fixture, parseGraph(fixture.context)), fixture.expected);
		assert.ok(fixture.context.length < 61_000);
	}
});

test("small parent fixtures match a direct incoming-edge scan across seeds", () => {
	for (let seed = 0; seed < 25; seed++) {
		const fixture = makeFixture({ kind: "parents", seed, nodeCount: 31, parentCount: 11 });
		assert.deepEqual(oracle(fixture, parseGraph(fixture.context)), fixture.expected);
	}
});

test("BFS answers use shortest distances despite cycles and alternate walks", () => {
	for (let seed = 0; seed < 25; seed++) {
		const fixture = makeFixture({ kind: "bfs", seed, nodeCount: 31, distance: 3, leafCount: 4 });
		const graph = parseGraph(fixture.context);
		const distances = shortestDistances(graph, fixture.metadata.queryNode);
		assert.deepEqual(oracle(fixture, graph), fixture.expected);
		for (const node of fixture.expected) assert.equal(distances.get(node), 3);
		assert.equal(fixture.metadata.relevantSourceRows, 7);
	}
	// An independent cyclic example distinguishes exact shortest distance from
	// reachability by any walk of that length.
	const graph = new Map([["a", ["b"]], ["b", ["a", "c"]], ["c", ["c"]]]);
	assert.deepEqual([...shortestDistances(graph, "a")], [["a", 0], ["b", 1], ["c", 2]]);
});

test("scoring accepts unique string arrays and ignores array order", () => {
	const score = scoreAnswer('  Final Answer: ["b", "a"]\n', ["a", "b"]);
	assert.equal(score.valid, true);
	assert.equal(score.em, 1);
	assert.equal(score.f1, 1);
	assert.deepEqual(score.predicted, ["a", "b"]);
	const partial = scoreAnswer('Final Answer: ["a", "x"]', ["a", "b"]);
	assert.equal(partial.valid, true);
	assert.equal(partial.em, 0);
	assert.equal(partial.f1, 0.5);
	assert.equal(scoreAnswer("Final Answer: []", ["a"]).f1, 0);
	assert.equal(scoreAnswer("Final Answer: []", []).em, 1);
});

test("malformed, duplicated, ambiguous and explanatory answers get no credit", () => {
	for (const text of [
		undefined,
		'["a"]',
		'Final Answer: ["a"] Final Answer: ["a"]',
		'Final Answer: ["a", "a"]',
		'Final Answer: ["a"] because this is correct',
		'Here is the answer.\nFinal Answer: ["a"]',
		'Final Answer: {"answer":["a"]}',
		'Final Answer: [1]',
		'Final Answer: [""]',
		'Final Answer: ["a",]',
		'Final Answer: ```json\n["a"]\n```',
	]) {
		const score = scoreAnswer(text, ["a"]);
		assert.equal(score.valid, false, `Should reject ${text}`);
		assert.equal(score.em, 0);
		assert.equal(score.f1, 0);
	}
});

test("impossible graph parameters fail before generation", () => {
	assert.throws(() => makeFixture({ kind: "parents", seed: 1, nodeCount: 8, parentCount: 8 }), /parentCount/);
	assert.throws(() => makeFixture({ kind: "bfs", seed: 1, nodeCount: 8, distance: 3, leafCount: 4 }), /at least/);
	assert.throws(() => makeFixture({ kind: "bfs", seed: 1, distance: 2, leafCount: 24 }), /leafCount/);
	assert.throws(() => makeFixture({ kind: "parents", seed: -1 }), /seed/);
});
