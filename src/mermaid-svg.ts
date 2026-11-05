/**
 * Import Mermaid's already-sanitized output as one SVG, never arbitrary HTML.
 * This is an artifact-shape check, not a substitute for Mermaid's DOMPurify pass.
 * Use the HTML parser so legitimate foreignObject labels keep HTML void elements.
 */
export function parseSanitizedMermaidSvg(svg: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, "text/html");
  const root = parsed.body.firstElementChild;
  if (!(root instanceof SVGSVGElement) || parsed.body.childElementCount !== 1) {
    throw new Error("Mermaid did not return a single SVG diagram.");
  }
  return document.importNode(root, true);
}
