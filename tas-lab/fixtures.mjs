const GRAPH_HEADER = [
	"This is a directed graph. Every row lists all outgoing edges of its source node.",
	"Each node has exactly two distinct outgoing neighbors. Row order has no meaning.",
	"Node identifiers must be matched exactly. Edges are not implicitly bidirectional.",
	"GRAPH:",
	"",
].join("\n");

const ROW_CHARS = 34;

function randomGenerator(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), state | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
	};
}

function shuffled(values, random) {
	const result = [...values];
	for (let index = result.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[result[index], result[other]] = [result[other], result[index]];
	}
	return result;
}

function uniqueNodes(count, random) {
	const nodes = new Set();
	while (nodes.size < count) {
		nodes.add(`n${Math.floor(random() * 0x100000000).toString(16).padStart(8, "0")}`);
	}
	return [...nodes];
}

function neighbors(nodes, random, excluded = new Set()) {
	const selected = new Set();
	while (selected.size < 2) {
		const node = nodes[Math.floor(random() * nodes.length)];
		if (!excluded.has(node)) selected.add(node);
	}
	return [...selected];
}

function assertInteger(value, minimum, name) {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new TypeError(`${name} must be an integer >= ${minimum}`);
	}
}

function layerWidths(distance, leafCount) {
	assertInteger(distance, 1, "distance");
	assertInteger(leafCount, 2, "leafCount");
	if (distance > 20 || leafCount > 2 ** distance) {
		throw new RangeError("distance must be <= 20 and leafCount must be <= 2 ** distance");
	}
	return Array.from({ length: distance + 1 }, (_, level) => Math.min(2 ** level, leafCount));
}

/** Generate one deterministic fixture. nodeCount supports small oracle tests. */
export function makeFixture({
	id,
	kind,
	seed,
	targetChars = 120_000,
	nodeCount = Math.ceil((targetChars - GRAPH_HEADER.length) / ROW_CHARS),
	parentCount = 24,
	distance = 5,
	leafCount = 24,
}) {
	if (kind !== "parents" && kind !== "bfs") throw new TypeError("kind must be parents or bfs");
	assertInteger(seed, 0, "seed");
	if (seed > 0xffffffff) throw new RangeError("seed must fit an unsigned 32-bit integer");
	assertInteger(nodeCount, 3, "nodeCount");
	assertInteger(parentCount, 1, "parentCount");
	const widths = kind === "bfs" ? layerWidths(distance, leafCount) : [];
	const requiredNodes = widths.reduce((total, width) => total + width, 0);
	if (kind === "parents" && parentCount >= nodeCount) {
		throw new RangeError("parentCount must be smaller than nodeCount");
	}
	if (nodeCount < requiredNodes) throw new RangeError(`BFS fixture needs at least ${requiredNodes} nodes`);

	const random = randomGenerator(seed);
	const nodes = uniqueNodes(nodeCount, random);
	const order = shuffled(nodes, random);
	const graph = new Map();
	let queryNode;
	let expected;
	let question;

	if (kind === "parents") {
		queryNode = nodes[Math.floor(random() * nodes.length)];
		const candidates = order.filter((node) => node !== queryNode);
		const parents = new Set();
		// One parent per equal-sized interval prevents all relevant rows clustering.
		for (let index = 0; index < parentCount; index++) {
			const start = Math.floor((index * candidates.length) / parentCount);
			const end = Math.floor(((index + 1) * candidates.length) / parentCount);
			parents.add(candidates[start + Math.floor(random() * (end - start))]);
		}
		for (const node of nodes) {
			const outgoing = neighbors(nodes, random, new Set([queryNode]));
			if (parents.has(node)) outgoing[Math.floor(random() * 2)] = queryNode;
			graph.set(node, outgoing);
		}
		expected = [...parents].sort();
		question = `Which nodes have a direct outgoing edge to ${queryNode}? Return every such node, and no others.`;
	} else {
		for (const node of nodes) graph.set(node, neighbors(nodes, random));
		const treeNodes = shuffled(nodes, random).slice(0, requiredNodes);
		const layers = [];
		let cursor = 0;
		for (const width of widths) {
			layers.push(treeNodes.slice(cursor, cursor + width));
			cursor += width;
		}
		// Disjoint layers make shortest distances exact. Every source still has two
		// outgoing edges, so degree and row syntax cannot identify the planted graph.
		for (let level = 0; level < distance; level++) {
			const next = layers[level + 1];
			for (let index = 0; index < layers[level].length; index++) {
				graph.set(layers[level][index], [next[(index * 2) % next.length], next[(index * 2 + 1) % next.length]]);
			}
		}
		queryNode = layers[0][0];
		expected = [...layers.at(-1)].sort();
		question = `Starting from ${queryNode}, which nodes have shortest directed-path distance exactly ${distance} edges? Return every such node, and no others. A node reached sooner does not qualify, even if a longer walk also reaches it.`;
	}

	const context = GRAPH_HEADER + order.map((node) => `${node} -> ${graph.get(node).join(", ")}\n`).join("");
	question += '\nRespond with exactly one line in this format: Final Answer: ["node_id", "node_id"]\nUse a JSON array of unique node identifier strings; array order does not matter. Do not include explanatory text in the final answer.';
	return {
		id: id ?? `${kind}-${seed}`,
		kind,
		seed,
		context,
		question,
		expected,
		metadata: {
			nodeCount,
			edgeCount: nodeCount * 2,
			queryNode,
			distance: kind === "bfs" ? distance : 1,
			expectedCount: expected.length,
			contextChars: context.length,
			estimatedTokens: Math.ceil(context.length / 3),
			conservativeEstimatedTokens: Math.ceil(context.length / 2),
			tokenEstimateMethod: "ASCII characters / 3; conservative planning estimate uses / 2. Neither is a tokenizer guarantee.",
			...(kind === "bfs" ? { layerWidths: widths, relevantSourceRows: requiredNodes - leafCount } : {}),
		},
	};
}

/** Fixed seeds and difficulty: do not select fixtures based on model answers. */
export function makeFixtures() {
	return [
		makeFixture({ id: "parents-120k-chars", kind: "parents", seed: 26090601, targetChars: 120_000, parentCount: 24 }),
		makeFixture({ id: "bfs-120k-chars", kind: "bfs", seed: 26090603, targetChars: 120_000, distance: 5, leafCount: 24 }),
		makeFixture({ id: "parents-300k-chars", kind: "parents", seed: 26090602, targetChars: 300_000, parentCount: 40 }),
		makeFixture({ id: "bfs-300k-chars", kind: "bfs", seed: 26090604, targetChars: 300_000, distance: 7, leafCount: 24 }),
	];
}

/** Separate capacity-calibration batch after the original pilot's output-cap failure. */
export function makeCalibrationFixtures() {
	return [
		makeFixture({ id: "parents-24k-chars-calibration", kind: "parents", seed: 26090611, targetChars: 24_000, parentCount: 12 }),
		makeFixture({ id: "bfs-60k-chars-calibration", kind: "bfs", seed: 26090612, targetChars: 60_000, distance: 5, leafCount: 16 }),
	];
}

/** A malformed/ambiguous final answer is invalid and receives zero credit. */
export function scoreAnswer(text, expected) {
	const invalid = (error) => ({ valid: false, em: 0, f1: 0, precision: 0, recall: 0, predicted: [], error });
	if (typeof text !== "string") return invalid("Response content is not a string");
	const marker = "Final Answer:";
	const first = text.indexOf(marker);
	if (first < 0 || text.indexOf(marker, first + marker.length) >= 0) {
		return invalid("Expected exactly one Final Answer marker");
	}
	if (text.slice(0, first).trim() !== "") return invalid("Unexpected text before Final Answer");
	let answer;
	try {
		answer = JSON.parse(text.slice(first + marker.length).trim());
	} catch {
		return invalid("Final Answer is not a standalone JSON value");
	}
	if (!Array.isArray(answer) || answer.some((node) => typeof node !== "string" || node.length === 0)) {
		return invalid("Final Answer must be an array of nonempty strings");
	}
	const predicted = new Set(answer);
	if (predicted.size !== answer.length) return invalid("Final Answer contains duplicate identifiers");
	const target = new Set(expected);
	const hits = [...predicted].filter((node) => target.has(node)).length;
	const precision = predicted.size === 0 ? Number(target.size === 0) : hits / predicted.size;
	const recall = target.size === 0 ? Number(predicted.size === 0) : hits / target.size;
	return {
		valid: true,
		em: Number(predicted.size === target.size && hits === target.size),
		f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
		precision,
		recall,
		predicted: [...predicted].sort(),
	};
}
