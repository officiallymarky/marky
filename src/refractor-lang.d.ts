// TypeScript 6 does not surface types through refractor's wildcard
// `"./*": "./lang/*.js"` export (Vite resolves it fine at runtime), so the
// language modules are declared structurally here. `prism: unknown` keeps the
// value assignable to refractor's `Syntax` parameter type.
declare module "refractor/*" {
  const syntax: ((prism: unknown) => undefined | void) & {
    aliases?: string[];
    displayName: string;
  };
  export default syntax;
}
