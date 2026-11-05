import mermaid from "mermaid";

/** Inspect parsed metadata, not source text: Mermaid accepts YAML quoting and escapes. */
export async function hasRemoteMermaidImages(text: string, baseUrl: string): Promise<boolean> {
  // The public parse result omits vertices. Keep this version-specific DB access
  // here, and fail closed if Mermaid changes the flowchart database interface.
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
  if (!diagram.type.startsWith("flowchart")) return false;
  const db = diagram.db;
  if (!("getVertices" in db) || typeof db.getVertices !== "function") {
    throw new Error("Cannot check this diagram's image policy safely.");
  }
  const vertices: unknown = db.getVertices();
  if (!(vertices instanceof Map)) {
    throw new Error("Cannot check this diagram's image policy safely.");
  }
  const base = new URL(baseUrl);
  let remote = false;
  for (const value of vertices.values()) {
    const vertex: unknown = value;
    if (typeof vertex !== "object" || vertex === null) {
      throw new Error("Cannot check this diagram's image policy safely.");
    }
    if (!("img" in vertex) || !vertex.img) continue;
    if (typeof vertex.img !== "string") {
      throw new Error("Diagram image URLs must be strings.");
    }
    const url = new URL(vertex.img, base);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== base.origin) {
      remote = true;
    }
  }
  return remote;
}
