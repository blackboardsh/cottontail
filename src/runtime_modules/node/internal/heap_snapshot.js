const v8NodeTypes = [
  "hidden",
  "array",
  "string",
  "object",
  "code",
  "closure",
  "regexp",
  "number",
  "native",
  "synthetic",
  "concatenated string",
  "sliced string",
  "symbol",
  "bigint",
];

const v8EdgeTypes = ["context", "element", "property", "internal", "hidden", "shortcut", "weak"];

function v8NodeType(className, flags, id) {
  if (id === 0 || className === "<root>") return 9;
  const name = String(className).toLowerCase();
  if (name.includes("symbol")) return 12;
  if (name.includes("bigint")) return 13;
  if (name.includes("regexp")) return 6;
  if (name.includes("function") || name.includes("closure")) return 5;
  if (name.includes("code") || name.includes("executable")) return 4;
  if (name.includes("string")) return 2;
  if (name.includes("array")) return 1;
  if (name.includes("number") || name.includes("double") || name.includes("int32")) return 7;
  if ((Number(flags) & 1) !== 0) return 0;
  return 3;
}

function v8EdgeType(type) {
  switch (String(type)) {
    case "Variable": return 0;
    case "Index": return 1;
    case "Property": return 2;
    case "Internal": return 3;
    default: return 4;
  }
}

export function jscHeapSnapshotToV8(source) {
  const input = typeof source === "string" ? JSON.parse(source) : source;
  if (!input || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new TypeError("Invalid JavaScriptCore heap snapshot");
  }

  const strings = [""];
  const stringIndexes = new Map([["", 0]]);
  const intern = (value) => {
    const text = String(value ?? "");
    const existing = stringIndexes.get(text);
    if (existing !== undefined) return existing;
    const index = strings.length;
    strings.push(text);
    stringIndexes.set(text, index);
    return index;
  };

  const records = [];
  const recordsById = new Map();
  for (let offset = 0; offset + 3 < input.nodes.length; offset += 4) {
    const id = Number(input.nodes[offset]);
    const className = input.nodeClassNames?.[Number(input.nodes[offset + 2])] ?? "Object";
    const record = {
      id,
      size: Number(input.nodes[offset + 1]) || 0,
      className,
      flags: Number(input.nodes[offset + 3]) || 0,
      edges: [],
    };
    recordsById.set(id, records.length);
    records.push(record);
  }

  for (let offset = 0; offset + 3 < input.edges.length; offset += 4) {
    const fromId = Number(input.edges[offset]);
    const toId = Number(input.edges[offset + 1]);
    const fromIndex = recordsById.get(fromId);
    const toIndex = recordsById.get(toId);
    if (fromIndex === undefined || toIndex === undefined) continue;
    const sourceType = input.edgeTypes?.[Number(input.edges[offset + 2])] ?? "Internal";
    const extra = Number(input.edges[offset + 3]) || 0;
    records[fromIndex].edges.push({ sourceType, extra, toIndex });
  }

  const nodes = [];
  const edges = [];
  const nodeFieldCount = 7;
  for (const record of records) {
    nodes.push(
      v8NodeType(record.className, record.flags, record.id),
      intern(record.className),
      record.id,
      record.size,
      record.edges.length,
      0,
      0,
    );
    for (const edge of record.edges) {
      const type = v8EdgeType(edge.sourceType);
      const nameOrIndex = edge.sourceType === "Index"
        ? edge.extra
        : intern(edge.sourceType === "Internal" ? "" : input.edgeNames?.[edge.extra] ?? "");
      edges.push(type, nameOrIndex, edge.toIndex * nodeFieldCount);
    }
  }

  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"],
        node_types: [v8NodeTypes, "string", "number", "number", "number", "number", "number"],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [v8EdgeTypes, "string_or_number", "node"],
        trace_function_info_fields: ["function_id", "name", "script_name", "script_id", "line", "column"],
        trace_node_fields: ["id", "function_info_index", "count", "size", "children"],
        sample_fields: ["timestamp_us", "last_assigned_id"],
        location_fields: ["object_index", "script_id", "line", "column"],
      },
      node_count: records.length,
      edge_count: edges.length / 3,
      trace_function_count: 0,
    },
    nodes,
    edges,
    trace_function_infos: [],
    trace_tree: [],
    samples: [],
    locations: [],
    strings,
  });
}

export function captureV8HeapSnapshot() {
  if (typeof cottontail.jscHeapSnapshot !== "function") {
    throw new Error("JavaScriptCore heap snapshots are unavailable in this build");
  }
  return jscHeapSnapshotToV8(cottontail.jscHeapSnapshot());
}
